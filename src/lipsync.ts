// VRM lipsync -- architecturally different from the Live2D version this
// replaces, and deliberately so, not just a mechanical port. The Live2D
// version had to hook into Cubism5InternalModel's "beforeModelUpdate"
// event because Cubism restores parameters from a snapshot at the start
// of every frame, wiping anything set from an independent rAF loop before
// it could ever visibly land (see docs/DECISIONS.md's STT/lipsync entries
// for that whole saga). VRM's VRMExpressionManager has no such
// snapshot/restore cycle -- confirmed by actually reading
// @pixiv/three-vrm-core's bundled source (not assumed just because it
// seemed architecturally different): `setValue()` just sets
// `expression.weight` directly, and `update()` reads whatever that
// current weight is and applies it -- so a plain independent
// requestAnimationFrame loop calling setValue() each frame, right before
// vrm.update(delta), works correctly here. That loop lives in main.ts
// (there's one shared scene-wide rAF loop, not one per audio clip), which
// is why this file doesn't drive anything itself -- it only tracks
// *which* mouth-openness value that shared loop should read this frame.

let currentMouthDriver: (() => number) | null = null;

/** Called from main.ts's single shared animation loop, every frame,
 * before vrm.update(delta). Returns 0 (mouth closed) whenever nothing is
 * currently speaking -- not an error case, just the resting state. */
export function getMouthOpenValue(): number {
  return currentMouthDriver ? currentMouthDriver() : 0;
}

// Same one-clip-at-a-time invariant as currentMouthDriver above (there's
// only ever one Audio element actually playing), tracked separately
// rather than reusing that driver's closure because captions need the
// raw elapsed/duration numbers, not a derived mouth-openness value.
// This is what lets main.ts approximate per-word caption timing against
// GPT-SoVITS's *actual* clip length instead of guessing a fixed
// words-per-second rate -- GPT-SoVITS's API returns finished WAV bytes
// with no per-word timestamps (confirmed against orchestrator/tts.py),
// so real phoneme-level sync isn't available; this is the best signal
// there is to sync against.
let currentSpeechEl: HTMLAudioElement | null = null;

/** Returns the elapsed/total seconds of whatever clip is currently
 * playing, or null if nothing is playing or its duration isn't known yet
 * (metadata hasn't loaded -- normal for the first frame or two after
 * play() is called). Callers should treat null as "don't move the
 * caption forward yet," not as an error. */
export function getSpeechProgress(): { elapsed: number; duration: number } | null {
  if (!currentSpeechEl || currentSpeechEl.paused || currentSpeechEl.ended) return null;
  const duration = currentSpeechEl.duration;
  if (!isFinite(duration) || duration <= 0) return null;
  return { elapsed: currentSpeechEl.currentTime, duration };
}

export interface SpeakHandle {
  onFinish(cb: () => void): void;
  /**
   * Stops playback immediately (the "stop response" button) and releases
   * the AnalyserNode/MediaElementSource -- but deliberately does NOT fire
   * the onFinish callback the way the natural "ended" event does.
   * SpeakQueue's stopAll() clears its whole pending queue itself and
   * resets its own state directly; if stop() also fired onFinish, that
   * callback's own playNext() call would fire a redundant, confusing
   * extra step on an already-cleared queue. Two separate paths (natural
   * end vs. manual stop) are simpler to reason about than one shared path
   * with a "but not this time" flag threaded through it.
   */
  stop(): void;
}

let sharedAudioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!sharedAudioCtx) {
    sharedAudioCtx = new AudioContext();
  }
  return sharedAudioCtx;
}

/**
 * Plays `audioUrl` through the browser's audio output and, for as long as
 * it's playing, makes getMouthOpenValue() return a live 0..1 mouth-openness
 * reading (RMS of the waveform, gained up since raw speech RMS reads
 * quiet) instead of the resting 0. main.ts's shared render loop is what
 * actually applies that value to the VRM's "aa" expression each frame --
 * this function only owns the audio element and the analyser reading it,
 * not anything about the 3D scene.
 */
export function speakWithLipsync(audioUrl: string): SpeakHandle {
  const audioEl = new Audio(audioUrl);
  audioEl.crossOrigin = "anonymous";

  const ctx = getAudioContext();
  const source = ctx.createMediaElementSource(audioEl);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);
  analyser.connect(ctx.destination);

  const timeDomain = new Uint8Array(analyser.frequencyBinCount);
  let finishCallback: (() => void) | undefined;
  let cleaned = false;

  function getMouthOpen(): number {
    if (audioEl.paused || audioEl.ended) return 0;

    analyser.getByteTimeDomainData(timeDomain);
    // RMS of the waveform, 0..1, then a little gain since raw RMS from
    // speech reads quiet -- tune MOUTH_GAIN to taste once you hear/see it.
    let sumSquares = 0;
    for (let i = 0; i < timeDomain.length; i++) {
      const centered = (timeDomain[i]! - 128) / 128;
      sumSquares += centered * centered;
    }
    const rms = Math.sqrt(sumSquares / timeDomain.length);
    const MOUTH_GAIN = 4;
    return Math.min(1, rms * MOUTH_GAIN);
  }

  function cleanup(): void {
    if (cleaned) return;
    cleaned = true;
    // Only clear the shared driver if it's still ours -- if something
    // else already started speaking (and became the current driver)
    // between this clip finishing and this cleanup running, clearing it
    // unconditionally would wipe the wrong one out.
    if (currentMouthDriver === getMouthOpen) currentMouthDriver = null;
    if (currentSpeechEl === audioEl) currentSpeechEl = null;
    source.disconnect();
    analyser.disconnect();
  }

  function onEnded(): void {
    cleanup();
    finishCallback?.();
  }

  currentMouthDriver = getMouthOpen;
  currentSpeechEl = audioEl;
  audioEl.addEventListener("ended", onEnded);
  audioEl.play().catch((err) => console.error("[luna] audio playback failed", err));

  return {
    onFinish(cb) {
      finishCallback = cb;
    },
    stop() {
      // No-op if it already finished naturally (onEnded already ran
      // cleanup) or was already stopped -- avoids pausing/cleaning up
      // twice for no reason.
      if (audioEl.paused || audioEl.ended) return;
      audioEl.pause();
      cleanup();
    },
  };
}
