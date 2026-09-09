import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";
import { listen } from "@tauri-apps/api/event";
import { WsClient, type ConnectionState, type SpeakMessage, type TranscriptMessage } from "./ws-client";
import { speakWithLipsync, getMouthOpenValue } from "./lipsync";
import { MicInput, blobToBase64 } from "./mic";

// Phase 7: VRM avatar migration -- see docs/DECISIONS.md for the full
// reasoning. Replaces pixi.js + pixi-live2d5 (a 2D Cubism rig) with
// three.js + @pixiv/three-vrm (a WebGL 3D VRM renderer), so a VRoid
// Studio export can be used instead of a Live2D model. Drop your
// exported .vrm file at MODEL_PATH below -- see README.md for the full
// walkthrough.
const MODEL_PATH = "/vrm/luna.vrm";

// Hand-tuned starting point for a bust-up framing at roughly a real VRM
// humanoid's actual scale (VRM models are authored in real-world meters,
// unlike Live2D's arbitrary internal units). Distance/height are offsets
// from the model's own head bone position (computed after load, see
// boot() below) rather than fixed world coordinates -- this way framing
// adapts to whatever height/proportions the actual loaded model turns
// out to have, instead of a blind guess at absolute numbers that only
// happens to work for one specific model.
const CAMERA_FOV_DEGREES = 32;
const CAMERA_DISTANCE_FROM_HEAD = 0.9;
// Camera sits slightly below head height and looks slightly up at it --
// reads more natural than a flat, dead-level stare into the middle of
// the face.
const CAMERA_HEIGHT_OFFSET_FROM_HEAD = -0.15;

// VRM's bind/rest pose is a T-pose by default (arms straight out to the
// sides) -- that's normal for a skeleton's rest pose, not something wrong
// with an export, but nothing poses it into anything more natural unless
// code explicitly does so; there's no idle animation clip involved here.
// Rotation values below were derived empirically, not guessed -- see
// docs/DECISIONS.md: loaded a real sample VRM in a Node script and
// computed actual hand-bone world positions via forward kinematics for
// several candidate rotations, picking the one that visibly brought the
// hand down to a natural at-the-side height. VRM's "normalized" humanoid
// bone space is specifically designed to use a consistent convention
// across every VRM model regardless of the source rig, so these values
// should transfer correctly to any other model, not just the one they
// were derived against -- unlike the camera framing above, which
// necessarily depends on each model's own actual proportions.
function applyIdlePose(vrm: VRM): void {
  const humanoid = vrm.humanoid;
  if (!humanoid) return;

  const leftUpperArm = humanoid.getNormalizedBoneNode("leftUpperArm");
  const rightUpperArm = humanoid.getNormalizedBoneNode("rightUpperArm");
  const leftLowerArm = humanoid.getNormalizedBoneNode("leftLowerArm");
  const rightLowerArm = humanoid.getNormalizedBoneNode("rightLowerArm");

  // Mirror-symmetric by construction (confirmed, not assumed) -- left and
  // right take opposite-sign rotations around the same axis.
  leftUpperArm?.rotation.set(0, 0, -1.35);
  rightUpperArm?.rotation.set(0, 0, 1.35);
  // A small bend at the elbow so the arms don't look ramrod-straight
  // glued to her sides -- purely aesthetic, safe to omit if a given
  // model doesn't have separate lower-arm bones for some reason (the
  // optional chaining above already no-ops in that case).
  leftLowerArm?.rotation.set(0, -0.15, 0);
  rightLowerArm?.rotation.set(0, 0.15, 0);
}

async function boot(): Promise<void> {
  const canvas = document.getElementById("avatar-canvas") as HTMLCanvasElement;

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.setSize(window.innerWidth, window.innerHeight);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(CAMERA_FOV_DEGREES, window.innerWidth / window.innerHeight, 0.1, 20);

  // VRoid's toon (MToon) materials still need at least one real light in
  // the scene to shade correctly, unlike an unlit 2D sprite -- but a
  // single strong, off-axis directional light (the original (1,1,1)
  // setup) is a likely cause of the pale/bright patch the user reported
  // on the jacket (see docs/DECISIONS.md): MToon's toon shading uses a
  // fairly hard transition between lit and shadowed bands, and a strong
  // light coming from a steep side angle can turn that transition into
  // an unnaturally sharp, oddly-placed bright patch rather than a smooth
  // gradient. This is a genuine guess, not a confirmed fix -- there's no
  // renderer in this sandbox to actually see the result -- but flatter,
  // more front-on, lower-intensity lighting is the standard fix for
  // exactly this kind of toon-shading artifact, and is also just a
  // better match for the flat, even VTuber look the user wants generally.
  const keyLight = new THREE.DirectionalLight(0xffffff, 0.9);
  // Positioned roughly where the camera itself sits (see CAMERA_* below)
  // rather than off to one side -- light coming from close to the
  // viewer's own direction minimizes the self-shadowing/harsh side
  // lighting a toon material is most likely to render badly.
  keyLight.position.set(0, 1.6, 2.2);
  scene.add(keyLight);
  // A hemisphere light (soft light from "above"/"below" blended by each
  // surface's own normal direction) fills in shadows more evenly than a
  // flat ambient light would, which matters more for toon materials --
  // an evenly-lit flat ambient can still leave the *key* light's harsh
  // transition band visible, where a hemisphere light softens it.
  scene.add(new THREE.HemisphereLight(0xffffff, 0xd8d8e0, 1.1));

  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));

  const gltf = await loader.loadAsync(MODEL_PATH);
  const vrm: VRM = gltf.userData.vrm;

  // rotateVRM0 is a no-op for VRM1 exports -- only legacy VRM0.x models
  // (older VRoid Studio versions default to this) face the wrong way for
  // three.js's -Z-forward convention and need the 180-degree turn.
  VRMUtils.rotateVRM0(vrm);
  // Standard best-practice cleanup from every official three-vrm example:
  // merges skinned meshes/morph targets where safe to cut down draw calls
  // and keep facial-expression blending consistent across submeshes --
  // both are no-ops if there's nothing to combine, safe to always call.
  VRMUtils.combineSkeletons(vrm.scene);
  VRMUtils.combineMorphs(vrm);

  applyIdlePose(vrm);

  scene.add(vrm.scene);

  // Frame the camera relative to the model's own actual head position,
  // computed only now (after adding to the scene and posing it) so world
  // matrices are up to date -- see this constant's own comment above on
  // why this isn't a fixed world-space coordinate.
  const headNode = vrm.humanoid?.getNormalizedBoneNode("head");
  const headWorldPosition = new THREE.Vector3();
  if (headNode) {
    vrm.scene.updateMatrixWorld(true);
    headNode.getWorldPosition(headWorldPosition);
  } else {
    // Extremely unlikely for any real VRM export (a head bone is
    // required by the spec), but fall back to a reasonable guess rather
    // than crash boot() over a malformed file.
    headWorldPosition.set(0, 1.4, 0);
    console.warn("[luna] VRM has no head bone in its humanoid map -- using a fallback camera position");
  }
  camera.position.set(
    headWorldPosition.x,
    headWorldPosition.y + CAMERA_HEIGHT_OFFSET_FROM_HEAD,
    headWorldPosition.z + CAMERA_DISTANCE_FROM_HEAD,
  );
  camera.lookAt(headWorldPosition);

  function layout(): void {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  }
  layout();
  window.addEventListener("resize", layout);

  // A simple blink loop -- VRM doesn't idle-animate on its own the way
  // Hiyori's Live2D rig did with its authored "Idle" motion group; this
  // is the minimum to not look like a frozen mannequin. Randomized
  // interval, not a fixed metronome, so it doesn't read as mechanical.
  let blinkTimer = 0;
  let nextBlinkAt = 2 + Math.random() * 3;
  let blinking = false;
  let blinkElapsed = 0;
  const BLINK_DURATION_S = 0.18;

  function updateBlink(delta: number): void {
    if (!vrm.expressionManager) return;
    if (!blinking) {
      blinkTimer += delta;
      if (blinkTimer >= nextBlinkAt) {
        blinking = true;
        blinkElapsed = 0;
        blinkTimer = 0;
        nextBlinkAt = 2 + Math.random() * 4;
      }
      return;
    }
    blinkElapsed += delta;
    const t = blinkElapsed / BLINK_DURATION_S;
    if (t >= 1) {
      vrm.expressionManager.setValue("blink", 0);
      blinking = false;
      return;
    }
    // Triangular envelope: closes over the first half, opens over the
    // second -- cheap and reads fine for something this quick and this
    // subtle, no need for actual easing curves.
    vrm.expressionManager.setValue("blink", t < 0.5 ? t * 2 : (1 - t) * 2);
  }

  // Phase 8: gradual expression blending, not a per-line snap (matching
  // docs/ROADMAP.md's own original scoping note for this phase). One
  // named emotion is "current" at a time; every frame, each of the six
  // expression weights eases toward 1 (if it's the current target) or 0
  // (otherwise) rather than jumping there instantly -- reads as a
  // gradual mood shift over a fraction of a second instead of a jarring
  // instant switch. EMOTION_NAMES matches orchestrator/persona.py's
  // VALID_EMOTIONS exactly -- the real standard VRM expression presets,
  // not the more colorful "bored"/"embarrassed" language ROADMAP.md
  // originally sketched this with (see persona.py's own comment on why).
  const EMOTION_NAMES = ["happy", "angry", "sad", "relaxed", "surprised", "neutral"] as const;
  type EmotionName = (typeof EMOTION_NAMES)[number];
  let targetEmotion: EmotionName = "neutral";
  const currentEmotionWeights: Record<EmotionName, number> = {
    happy: 0,
    angry: 0,
    sad: 0,
    relaxed: 0,
    surprised: 0,
    neutral: 1,
  };
  // Per-second blend rate -- at this rate a full swing between two
  // expressions takes well under a second, reading as a smooth but
  // prompt mood shift rather than a slow fade or an instant snap.
  const EMOTION_BLEND_SPEED = 4;

  function setTargetEmotion(emotion?: string): void {
    // Absent or unrecognized -- see ws-client.ts's protocol comment on
    // why this is common and expected, not an error: leave the current
    // expression alone rather than guessing or snapping to "neutral"
    // just because this particular turn didn't produce a usable tag.
    if (!emotion) return;
    if (!(EMOTION_NAMES as readonly string[]).includes(emotion)) return;
    targetEmotion = emotion as EmotionName;
  }

  function updateEmotion(delta: number): void {
    if (!vrm.expressionManager) return;
    const step = Math.min(1, EMOTION_BLEND_SPEED * delta);
    for (const name of EMOTION_NAMES) {
      const target = name === targetEmotion ? 1 : 0;
      const next = currentEmotionWeights[name] + (target - currentEmotionWeights[name]) * step;
      currentEmotionWeights[name] = next;
      vrm.expressionManager.setValue(name, next);
    }
  }

  const clock = new THREE.Clock();
  function animate(): void {
    requestAnimationFrame(animate);
    const delta = clock.getDelta();
    updateBlink(delta);
    updateEmotion(delta);
    if (vrm.expressionManager) {
      vrm.expressionManager.setValue("aa", getMouthOpenValue());
    }
    vrm.update(delta);
    renderer.render(scene, camera);
  }
  animate();

  setupHud(setTargetEmotion);
}

function setupHud(setTargetEmotion: (emotion?: string) => void): void {
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

  const queue = new SpeakQueue();
  const client = new WsClient({
    onStateChange: setState,
    onSpeak: (msg: SpeakMessage) => queue.push(msg),
    onTranscript: (msg: TranscriptMessage) => showTranscript(msg.text),
    onTurnEnd: (emotion) => {
      setTurnActive(false);
      setTargetEmotion(emotion);
    },
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
// still playing would call speakWithLipsync() again, starting a second
// Audio element/AnalyserNode racing the first one. This plays each queued
// chunk to completion before starting the next. No `model`/`vrm`
// reference needed here as of Phase 7 -- lipsync.ts's mouth-openness
// value is read by main.ts's own single shared render loop, not pushed
// into the model directly from here the way the old Live2D version did.
class SpeakQueue {
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

    const handle = speakWithLipsync(url);
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
