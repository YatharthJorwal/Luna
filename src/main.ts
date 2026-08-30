import * as PIXI from "pixi.js";
import { Live2DModel } from "pixi-live2d5";
import { WsClient, type ConnectionState, type SpeakMessage } from "./ws-client";
import { speakWithLipsync } from "./lipsync";

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

  const setState = (state: ConnectionState) => {
    statusDot.classList.remove("connected", "listening");
    statusDot.title = state;
    if (state !== "offline") statusDot.classList.add(state);
  };

  const client = new WsClient({
    onStateChange: setState,
    onSpeak: (msg: SpeakMessage) => speak(model, msg),
  });
  client.connect();

  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const text = input.value.trim();
    if (!text) return;
    client.sendUserText(text);
    input.value = "";
  });
}

function speak(model: Live2DModel, msg: SpeakMessage): void {
  const blob = base64ToBlob(msg.audio_b64, msg.mime);
  const url = URL.createObjectURL(blob);

  // pixi-live2d5 doesn't include a built-in speak()/lipsync helper (the old
  // library we started with did, but it's incompatible with the Cubism
  // Core version Live2D currently ships -- see vendor/pixi-live2d5/NOTES.md).
  // speakWithLipsync() plays the audio and drives the model's LipSync
  // parameters from it manually.
  const handle = speakWithLipsync(model, url);
  handle.onFinish(() => URL.revokeObjectURL(url));
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
