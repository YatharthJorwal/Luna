import type { VRM } from "@pixiv/three-vrm";
import { WsClient, type SpeakMessage, type TranscriptMessage, type SurfaceRole } from "./ws-client";
import { speakWithLipsync, getMouthOpenValue, getSpeechProgress } from "./lipsync";
import { MicInput, blobToBase64 } from "./mic";

// Same app-facing emotion tags main.ts's emotion system uses (see that
// file's own comment and orchestrator/persona.py's VALID_EMOTIONS) --
// duplicated, not imported, same isolation reasoning as sandbox.ts's
// applyRestPose/blink loop. Split into EMOTION_NAMES (app-facing tags,
// what the orchestrator actually sends) vs. VRM_PRESET_NAMES (the
// model's own expression preset names) because "teasing" isn't a 1:1
// handoff to a same-named preset -- see EMOTION_BLENDS below, ported
// verbatim from main.ts's own.
const EMOTION_NAMES = ["happy", "angry", "sad", "teasing", "surprised", "neutral"] as const;
type EmotionName = (typeof EMOTION_NAMES)[number];

const VRM_PRESET_NAMES = ["happy", "angry", "sad", "relaxed", "surprised", "neutral"] as const;
type VrmPresetName = (typeof VRM_PRESET_NAMES)[number];

// How each app-facing emotion actually gets rendered on the model --
// identical weights to main.ts's own EMOTION_BLENDS (see that file's own
// comment for the full reasoning behind "teasing"'s composite blend and
// "happy"'s 0.8 cap; not repeated here since it's the same model, same
// known VRoid quirk, not something specific to this sandbox).
const EMOTION_BLENDS: Record<EmotionName, Partial<Record<VrmPresetName, number>>> = {
  happy: { happy: 0.8 },
  angry: { angry: 1 },
  sad: { sad: 1 },
  teasing: { relaxed: 1, angry: 0.3 },
  surprised: { surprised: 1 },
  neutral: { neutral: 1 },
};

const EMOTION_BLEND_SPEED = 4; // per-second blend rate, same as main.ts's

export interface SandboxHud {
  /** Called once a frame from sandbox.ts's shared render loop -- advances
   * caption reveal, the emotion blend, and the "aa" mouth-openness value,
   * same division of labor as main.ts's hud.tick() + its own inline
   * expressionManager.setValue("aa", ...) call. */
  tick(delta: number): void;
  /** True only while an actual conversation turn is generating/being
   * spoken -- NOT true just because this window is currently an
   * "observer" (see ws-client.ts's surface_status). sandbox.ts uses this
   * to pause her wandering while she's mid-reply; observer status is a
   * separate, often much longer-lived thing (the whole time the other
   * window happens to be open) that shouldn't freeze her in place for
   * that entire span. */
  isTurnActive(): boolean;
}

export interface SandboxHudOptions {
  /** Fired once per whole turn when the orchestrator's turn_end message
   * carries an emotion tag (same event setTargetEmotion below reacts to
   * for the facial blend) -- lets sandbox.ts's boot() trigger a matching
   * one-shot body gesture (see CharacterController.playGesture there)
   * without this file needing to know anything about gestures, mixers,
   * or vrma clips itself. Not fired for the "neutral" resets below (turn
   * end with no tag, stop button, audio-idle) -- those are UI resets,
   * not a reaction worth a body gesture. */
  onEmotion?: (emotion?: string) => void;
}

export function setupSandboxHud(vrm: VRM, opts: SandboxHudOptions = {}): SandboxHud {
  const input = document.getElementById("input-box") as HTMLInputElement;
  const statusDot = document.getElementById("status-dot") as HTMLDivElement;
  const micButton = document.getElementById("mic-button") as HTMLButtonElement;
  const actionButton = document.getElementById("action-button") as HTMLButtonElement;
  const caption = document.getElementById("caption") as HTMLDivElement;

  const STOP_ICON =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>';
  const SEND_ICON =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.4 20.6 21 12 3.4 3.4 3 10l12 2-12 2z" /></svg>';

  const setState = (state: "offline" | "connected" | "listening") => {
    statusDot.classList.remove("connected", "listening");
    statusDot.title = state;
    if (state !== "offline") statusDot.classList.add(state);
  };

  // Same orchestratorDone/audioIdle/turnActive split as main.ts's, plus
  // observerLocked for the driver/observer round -- see ws-client.ts's
  // top-of-file comment and app.py's ws_endpoint.
  let orchestratorDone = true;
  let audioIdle = true;
  let turnActive = false;
  let observerLocked = false;

  function recomputeTurnActive(): void {
    setTurnActive(!orchestratorDone || !audioIdle);
  }

  function updateInputButtons(): void {
    if (observerLocked) {
      actionButton.hidden = true;
      micButton.hidden = true;
      return;
    }
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
    input.disabled = active || observerLocked;
    updateInputButtons();
  }

  function submitText(): void {
    const text = input.value.trim();
    if (!text) return;
    client.sendUserText(text);
    input.value = "";
    orchestratorDone = false;
    recomputeTurnActive();
  }

  updateInputButtons();

  // ---- Captions: identical approach to main.ts's (word-by-word reveal
  // timed against the currently-playing clip's real duration) -- see that
  // file's own comment for the full reasoning. ----
  let captionWordEls: HTMLSpanElement[] = [];
  let captionWordStarts: number[] = [];
  let captionActiveIndex = -1;
  // How many already-spoken words stay fully visible right behind the
  // highlight before they start individually collapsing/fading out --
  // same value as main.ts's own, so the two feel consistent.
  const CAPTION_TRAIL_WORDS = 4;

  function startCaptionLine(text: string): void {
    const words = text.trim().split(/\s+/).filter(Boolean);
    caption.innerHTML = "";
    captionWordEls = words.map((word) => {
      const span = document.createElement("span");
      span.className = "caption-word";
      span.textContent = word;
      caption.appendChild(span);
      return span;
    });
    const totalChars = words.reduce((sum, w) => sum + w.length, 0) || 1;
    let seenChars = 0;
    captionWordStarts = words.map((w) => {
      const start = seenChars / totalChars;
      seenChars += w.length;
      return start;
    });
    captionActiveIndex = -1;
    caption.classList.add("visible");
    applyCaptionProgress(0);
  }

  function tickCaptionProgress(): void {
    if (captionWordEls.length === 0) return;
    const progress = getSpeechProgress();
    if (!progress) return;
    const frac = Math.min(1, progress.elapsed / progress.duration);
    let idx = 0;
    for (let i = 0; i < captionWordStarts.length; i++) {
      if (captionWordStarts[i]! <= frac) idx = i;
      else break;
    }
    applyCaptionProgress(idx);
  }

  // Every word's class is recomputed fresh from its distance to
  // activeIndex each call, not tracked as separate one-shot transitions
  // -- same approach as main.ts's own, see that file's comment.
  function applyCaptionProgress(activeIndex: number): void {
    if (activeIndex === captionActiveIndex) return;
    captionActiveIndex = activeIndex;
    captionWordEls.forEach((el, i) => {
      if (i === activeIndex) {
        const alreadyShown = el.classList.contains("shown");
        el.classList.add("shown", "active");
        el.classList.remove("spoken", "fading");
        if (!alreadyShown) {
          el.classList.remove("pop");
          void el.offsetWidth;
          el.classList.add("pop");
        }
      } else if (i < activeIndex) {
        el.classList.add("shown");
        el.classList.remove("active", "pop");
        if (activeIndex - i > CAPTION_TRAIL_WORDS) {
          el.classList.add("fading");
          el.classList.remove("spoken");
        } else {
          el.classList.add("spoken");
          el.classList.remove("fading");
        }
      } else {
        el.classList.remove("shown", "active", "spoken", "fading", "pop");
      }
    });
  }

  function endCaptionLine(): void {
    caption.classList.remove("visible");
  }

  const defaultPlaceholder = input.placeholder;
  let placeholderTimer: number | undefined;
  function flashPlaceholder(text: string): void {
    window.clearTimeout(placeholderTimer);
    input.placeholder = text;
    placeholderTimer = window.setTimeout(() => {
      input.placeholder = defaultPlaceholder;
    }, 4000);
  }

  function showTranscript(text: string): void {
    flashPlaceholder(text ? `Heard: "${text}"` : "Didn't catch that -- try again?");
  }

  // ---- Emotion blend (Phase 8, ported): one named target at a time,
  // every underlying VRM preset weight eases toward its target in
  // EMOTION_BLENDS[targetEmotion] (or 0, if not part of the current
  // blend) each frame rather than snapping -- tracked per VRM preset
  // (not per app-facing emotion), same reasoning as main.ts's own: a
  // composite like "teasing" needs two presets eased independently at
  // once. ----
  let targetEmotion: EmotionName = "neutral";
  const currentPresetWeights: Record<VrmPresetName, number> = {
    happy: 0,
    angry: 0,
    sad: 0,
    relaxed: 0,
    surprised: 0,
    neutral: 1,
  };

  function setTargetEmotion(emotion?: string): void {
    if (!emotion) return;
    if (!(EMOTION_NAMES as readonly string[]).includes(emotion)) return;
    targetEmotion = emotion as EmotionName;
  }

  function updateEmotion(delta: number): void {
    if (!vrm.expressionManager) return;
    const step = Math.min(1, EMOTION_BLEND_SPEED * delta);
    const activeBlend = EMOTION_BLENDS[targetEmotion];
    for (const preset of VRM_PRESET_NAMES) {
      const target = activeBlend[preset] ?? 0;
      const next = currentPresetWeights[preset] + (target - currentPresetWeights[preset]) * step;
      currentPresetWeights[preset] = next;
      vrm.expressionManager.setValue(preset, next);
    }
  }

  // ---- SpeakQueue: identical logic to main.ts's own class. ----
  interface SpeakQueueOptions {
    onCaptionStart: (text: string) => void;
    onCaptionEnd: () => void;
    onActive: () => void;
    onIdle: () => void;
  }

  class SpeakQueue {
    private pending: SpeakMessage[] = [];
    private playing = false;
    private currentHandle: ReturnType<typeof speakWithLipsync> | null = null;
    private static readonly GAP_MS = 150;

    constructor(private opts: SpeakQueueOptions) {}

    push(msg: SpeakMessage): void {
      const wasIdle = !this.playing && this.pending.length === 0;
      this.pending.push(msg);
      if (wasIdle) this.opts.onActive();
      if (!this.playing) this.playNext();
    }

    stopAll(): void {
      this.pending = [];
      this.currentHandle?.stop();
      this.currentHandle = null;
      this.playing = false;
      this.opts.onCaptionEnd();
    }

    private playNext(): void {
      const msg = this.pending.shift();
      if (!msg) {
        this.playing = false;
        this.currentHandle = null;
        this.opts.onIdle();
        return;
      }
      this.playing = true;
      this.opts.onCaptionStart(msg.text);

      const blob = base64ToBlob(msg.audio_b64, msg.mime);
      const url = URL.createObjectURL(blob);

      const handle = speakWithLipsync(url);
      this.currentHandle = handle;
      handle.onFinish(() => {
        URL.revokeObjectURL(url);
        this.currentHandle = null;
        this.opts.onCaptionEnd();
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

  const queue = new SpeakQueue({
    onCaptionStart: (text) => startCaptionLine(text),
    onCaptionEnd: () => endCaptionLine(),
    onActive: () => {
      audioIdle = false;
      recomputeTurnActive();
    },
    onIdle: () => {
      audioIdle = true;
      recomputeTurnActive();
      setTargetEmotion("neutral");
    },
  });

  const client = new WsClient({
    surface: "sandbox",
    onStateChange: setState,
    onSpeak: (msg: SpeakMessage) => queue.push(msg),
    onTranscript: (msg: TranscriptMessage) => showTranscript(msg.text),
    onTurnEnd: (emotion) => {
      orchestratorDone = true;
      recomputeTurnActive();
      setTargetEmotion(emotion);
      opts.onEmotion?.(emotion);
    },
    // Shell connected first -- she's already talking there. See
    // ws-client.ts's top-of-file comment and app.py's ws_endpoint.
    onSurfaceStatus: (role: SurfaceRole) => {
      observerLocked = role === "observer";
      input.disabled = observerLocked || turnActive;
      updateInputButtons();
      flashPlaceholder(observerLocked ? "Luna's active in the desktop shell right now…" : defaultPlaceholder);
    },
  });
  client.connect();

  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    submitText();
  });
  input.addEventListener("input", updateInputButtons);

  // Same "/" focus shortcut as main.ts's -- see that file's own comment
  // for why it's ignored with a modifier held or while already focused.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "/") return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (document.activeElement === input) return;
    event.preventDefault();
    input.focus();
  });

  actionButton.addEventListener("click", () => {
    if (turnActive) {
      queue.stopAll();
      client.sendStop();
      orchestratorDone = true;
      audioIdle = true;
      recomputeTurnActive();
      setTargetEmotion("neutral");
    } else {
      submitText();
    }
  });

  // Mic: same click-to-toggle MediaRecorder flow as main.ts's -- no F9
  // push-to-talk here, since that's wired through a Tauri global-shortcut
  // event (src-tauri/src/lib.rs) that only exists inside the Tauri
  // webview, not a plain browser tab (this page). Functionally identical
  // to the shell's mic for now; per the brief, this is a placeholder --
  // whatever "something more" the sandbox's mic ends up meaning later
  // (the user flagged this explicitly) slots in here without touching
  // ws-client.ts/app.py's protocol, which already just wants a WAV clip
  // regardless of why it was captured.
  const mic = new MicInput({
    onRecordingChange: (recording) => {
      micButton.classList.toggle("recording", recording);
      micButton.setAttribute("aria-pressed", String(recording));
    },
    onClip: async (blob) => {
      const audioB64 = await blobToBase64(blob);
      client.sendUserAudio(audioB64);
      orchestratorDone = false;
      recomputeTurnActive();
    },
    onError: (err) => {
      console.error("[luna-sandbox] mic capture failed -- check mic permission", err);
    },
  });
  micButton.addEventListener("click", () => {
    mic.toggle();
  });

  return {
    tick(delta: number): void {
      tickCaptionProgress();
      updateEmotion(delta);
      if (vrm.expressionManager) {
        vrm.expressionManager.setValue("aa", getMouthOpenValue());
      }
    },
    isTurnActive(): boolean {
      return turnActive;
    },
  };
}
