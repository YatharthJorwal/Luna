import * as PIXI from "pixi.js";
import { Live2DModel } from "pixi-live2d5";
import { listen } from "@tauri-apps/api/event";
import { WsClient, type ConnectionState, type SpeakMessage, type TranscriptMessage } from "./ws-client";
import { speakWithLipsync } from "./lipsync";
import { MicInput, blobToBase64 } from "./mic";

// Required so pixi-live2d5 can reach window.PIXI.Ticker to auto-update models.
(window as unknown as { PIXI: typeof PIXI }).PIXI = PIXI;

const MODEL_PATH = "/live2d/Hiyori/Hiyori.model3.json";
// How much of the window's height Luna should occupy. Cubism models are
// authored at an arbitrary internal size unrelated to window pixels, so
// this is a hand-tuned constant rather than derived from model bounds --
// bump it up/down until she looks right at your window size, then leave it.
const SCALE = 0.12;

async function boot(): Promise<void> {
  const canvas = document.getElementById("live2d-canvas") as HTMLCanvasElement;

  // PixiJS 8 uses an async init() instead of passing options to the
  // constructor (that was the v7 pattern our first attempt used).
  const app = new PIXI.Application();
  await app.init({
    canvas,
    resizeTo: window,
    backgroundAlpha: 0,
    antialias: true,
    resolution: window.devicePixelRatio || 1,
  });

  const model = await Live2DModel.from(MODEL_PATH);
  app.stage.addChild(model);
  model.anchor.set(0.5, 1);

  function layout(): void {
    model.scale.set(SCALE);
    model.position.set(app.renderer.width / 2, app.renderer.height - 4);
  }
  layout();
  // Not window.addEventListener("resize", layout) on purpose: PIXI's own
  // resizeTo:window plugin also listens for window resize and updates
  // app.renderer.width/height independently, with no guaranteed ordering
  // against our own listener -- that race is what let a maximize/restore
  // reposition her using stale dimensions and send her off-window. Running
  // layout() every tick costs nothing measurable and can't race.
  app.ticker.add(layout);

  // The model idles on its own: Hiyori's model3.json defines an "Idle"
  // motion group, and the motion manager loops whichever group is named
  // "Idle" whenever nothing higher-priority is playing.

  setupHud(model);
}

function setupHud(model: Live2DModel): void {
  const input = document.getElementById("input-box") as HTMLInputElement;
  const statusDot = document.getElementById("status-dot") as HTMLDivElement;
  const micButton = document.getElementById("mic-button") as HTMLButtonElement;
  const actionButton = document.getElementById("action-button") as HTMLButtonElement;

  const STOP_ICON =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>';
  const SEND_ICON =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.4 20.6 21 12 3.4 3.4 3 10l12 2-12 2z" /></svg>';

  const setState = (state: ConnectionState) => {
    statusDot.classList.remove("connected", "listening");
    statusDot.title = state;
    if (state !== "offline") statusDot.classList.add(state);
  };

  // Toggled true right when a turn starts (sendUserText/sendUserAudio),
  // false on turn_end -- independent of ConnectionState, which flips back
  // to "connected" as soon as the *first* speak chunk arrives even though
  // more chunks (and audio playback) can still be in flight for several
  // more seconds after that. This is specifically "is there a reply
  // actively being generated or spoken right now", which is the actual
  // question the action button and input-disabling need answered.
  let turnActive = false;

  // One button, not two sitting side by side -- it morphs between stop
  // and send (same element, same click handler, icon/label/behavior
  // swapped based on state) rather than showing/hiding two separate
  // buttons that happen to alternate. Hidden entirely with nothing typed
  // and no reply in flight, since there's nothing for it to do in that
  // state -- the mic button covers that case instead. Called on every
  // turnActive change and every keystroke in the input box.
  function updateInputButtons(): void {
    const hasText = input.value.trim().length > 0;
    if (turnActive) {
      actionButton.hidden = false;
      actionButton.classList.add("stop-mode");
      actionButton.innerHTML = STOP_ICON;
      actionButton.title = "Stop response";
      actionButton.setAttribute("aria-label", "Stop response");
      micButton.hidden = true;
    } else if (hasText) {
      actionButton.hidden = false;
      actionButton.classList.remove("stop-mode");
      actionButton.innerHTML = SEND_ICON;
      actionButton.title = "Send message";
      actionButton.setAttribute("aria-label", "Send message");
      micButton.hidden = true;
    } else {
      actionButton.hidden = true;
      micButton.hidden = false;
    }
  }

  function setTurnActive(active: boolean): void {
    turnActive = active;
    input.disabled = active;
    updateInputButtons();
  }

  function submitText(): void {
    const text = input.value.trim();
    if (!text) return;
    client.sendUserText(text);
    input.value = "";
    setTurnActive(true);
  }

  // Matches the HTML's own default `hidden` attribute on action-button
  // (mic visible at rest) but called explicitly rather than relying on
  // that alone -- keeps this the single source of truth for the initial
  // state instead of two places that have to agree by accident.
  updateInputButtons();

  const queue = new SpeakQueue(model);
  const client = new WsClient({
    onStateChange: setState,
    onSpeak: (msg: SpeakMessage) => queue.push(msg),
    onTranscript: (msg: TranscriptMessage) => showTranscript(msg.text),
    onTurnEnd: () => setTurnActive(false),
  });
  client.connect();

  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    submitText();
  });
  input.addEventListener("input", updateInputButtons);

  actionButton.addEventListener("click", () => {
    if (turnActive) {
      // Both fire immediately, independently -- queue.stopAll() kills
      // client-side audio/lipsync right now without waiting on a round
      // trip; sendStop() separately tells the orchestrator to cancel
      // generation server-side (saves compute, and records a truthful
      // partial reply in history instead of a full one nobody heard the
      // end of). setTurnActive(false) doesn't wait for the server's own
      // turn_end either -- the button disappearing should feel instant,
      // same as the audio actually stopping.
      queue.stopAll();
      client.sendStop();
      setTurnActive(false);
    } else {
      submitText();
    }
  });

  // Briefly shows what the orchestrator heard in the input box's own
  // placeholder rather than its value -- the transcript has already been
  // sent and is on its way to the LLM by the time this arrives (see
  // ws-client.ts), so putting it in `value` would look like something
  // still waiting to be submitted. Reverts to the normal placeholder after
  // a few seconds either way.
  const defaultPlaceholder = input.placeholder;
  let transcriptTimer: number | undefined;
  function showTranscript(text: string): void {
    window.clearTimeout(transcriptTimer);
    input.placeholder = text ? `Heard: "${text}"` : "Didn't catch that -- try again?";
    transcriptTimer = window.setTimeout(() => {
      input.placeholder = defaultPlaceholder;
    }, 4000);
  }

  const mic = new MicInput({
    onRecordingChange: (recording) => {
      micButton.classList.toggle("recording", recording);
      micButton.setAttribute("aria-pressed", String(recording));
    },
    onClip: async (blob) => {
      const audioB64 = await blobToBase64(blob);
      client.sendUserAudio(audioB64);
      setTurnActive(true);
    },
    onError: (err) => {
      // Most likely mic permission denied, or no input device -- nothing
      // client-side to recover from beyond logging; the user can grant
      // permission (or plug in a mic) and click again.
      console.error("[luna] mic capture failed -- check mic permission", err);
    },
  });
  micButton.addEventListener("click", () => {
    mic.toggle();
  });

  // F9 push-to-talk, works even when Luna's window isn't focused -- the
  // actual global shortcut registration lives in src-tauri/src/lib.rs
  // (Rust), which just emits this event; all the recording logic stays
  // here in one place, same start()/stop() the mic button itself uses.
  // Guarded against turnActive here specifically because it's a global
  // hotkey, not a click on the (now-hidden) mic button -- hiding the
  // button doesn't stop F9 from still firing while a reply's in flight.
  listen<string>("hotkey-talk", (event) => {
    if (turnActive) return;
    if (event.payload === "pressed") {
      mic.start();
    } else if (event.payload === "released") {
      mic.stop();
    }
  }).catch((err) => {
    console.error("[luna] couldn't attach F9 push-to-talk listener", err);
  });
}

// Phase 2's orchestrator sends one reply as several `speak` messages --
// one per sentence, streamed as the LLM produces them (see
// orchestrator/app.py / chunking.py) -- instead of Phase 1's one message
// per reply. Without a queue, a second chunk arriving while the first is
// still playing would call speakWithLipsync() again on the same model,
// starting a second Audio element/AnalyserNode racing the first one.
// This plays each queued chunk to completion before starting the next.
class SpeakQueue {
  private model: Live2DModel;
  private pending: SpeakMessage[] = [];
  private playing = false;
  private currentHandle: ReturnType<typeof speakWithLipsync> | null = null;

  // A short pause between chunks, not zero. Two back-to-back HTMLAudioElements
  // chained on "ended" can have a few ms of overlap at the boundary (the next
  // element's play() has its own startup latency, and audio already queued in
  // the previous element's Web Audio routing can trail slightly past "ended")
  // -- this masks that, and as a side effect makes the sentence-by-sentence
  // delivery sound like natural pauses between sentences rather than abrupt
  // bursts.
  private static readonly GAP_MS = 150;

  constructor(model: Live2DModel) {
    this.model = model;
  }

  push(msg: SpeakMessage): void {
    this.pending.push(msg);
    if (!this.playing) this.playNext();
  }

  /** The "stop response" button: drops everything still queued and stops
   * whatever's currently playing immediately -- not a graceful fade,
   * since the point is for it to feel instant. Doesn't wait on the
   * orchestrator at all; ws-client.ts's sendStop() is fired alongside
   * this, separately, for the backend-side cancellation. */
  stopAll(): void {
    this.pending = [];
    this.currentHandle?.stop();
    this.currentHandle = null;
    this.playing = false;
  }

  private playNext(): void {
    const msg = this.pending.shift();
    if (!msg) {
      this.playing = false;
      this.currentHandle = null;
      return;
    }
    this.playing = true;

    const blob = base64ToBlob(msg.audio_b64, msg.mime);
    const url = URL.createObjectURL(blob);

    // pixi-live2d5 doesn't include a built-in speak()/lipsync helper (the
    // old library we started with did, but it's incompatible with the
    // Cubism Core version Live2D currently ships -- see
    // vendor/pixi-live2d5/NOTES.md). speakWithLipsync() plays the audio
    // and drives the model's LipSync parameters from it manually.
    const handle = speakWithLipsync(this.model, url);
    this.currentHandle = handle;
    handle.onFinish(() => {
      URL.revokeObjectURL(url);
      this.currentHandle = null;
      window.setTimeout(() => this.playNext(), SpeakQueue.GAP_MS);
    });
  }
}

function base64ToBlob(base64: string, mime: string): Blob {
  const bytes = atob(base64);
  const buffer = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) buffer[i] = bytes.charCodeAt(i);
  return new Blob([buffer], { type: mime });
}

boot().catch((err) => {
  console.error("[luna] failed to boot", err);
});
