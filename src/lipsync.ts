// pixi-live2d5 (see vendor/pixi-live2d5/NOTES.md for why we're on this fork)
// doesn't drive lipsync automatically -- its internal hook for it is written
// but commented out in Cubism5InternalModel.ts. So we drive it ourselves:
// play the audio through a Web Audio AnalyserNode, read the amplitude each
// frame, and push it into whichever Cubism parameters the model's own
// model3.json declares under its "LipSync" group (ParamMouthOpenY for
// Hiyori, but this doesn't hardcode that -- it asks the model).
//
// IMPORTANT: this has to run from the model's own "beforeModelUpdate" event,
// not an independent requestAnimationFrame loop -- see the comment on
// speakWithLipsync() below for why an rAF loop silently never moves the
// mouth at all, confirmed by reading Cubism5InternalModel.ts's update()
// directly (see docs/DECISIONS.md).

// Minimal shape of what we touch on Live2DModel -- see src/types/pixi-live2d5.d.ts
// for why this isn't the library's real (unbuildable-here) type declarations.
import type { Live2DModel } from "pixi-live2d5";

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioCtx) {
    audioCtx = new AudioContext();
  }
  return audioCtx;
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

/**
 * Plays `audioUrl` through the browser's audio output and, for as long as
 * it's playing, feeds a mouth-openness value (0..1) into the model's
 * LipSync-group parameters every animation frame.
 *
 * Why this hooks internalModel's "beforeModelUpdate" event instead of just
 * running its own requestAnimationFrame loop (which is what this used to
 * do): Cubism5InternalModel#update() -- see that class in the vendored
 * library's source -- calls `model.loadParameters()` at the *start* of
 * every frame to restore parameters to the snapshot taken right after the
 * motion system last ran (`model.saveParameters()`), then does its actual
 * deformation/render-prep in `model.update()` at the very *end* of that
 * same synchronous call. Anything that adds to a parameter from *outside*
 * that function -- like a separate rAF loop -- either gets wiped by the
 * next frame's loadParameters() restore (if it ran before the model's own
 * update that frame) or modifies parameters *after* that frame's
 * deformation was already computed from the old values (if it ran after) --
 * there's no timing where an external call lands inside the window that
 * actually affects a render. It's not a rare race, it's structurally
 * guaranteed to never visibly move anything, which is exactly what showed
 * up on first real-hardware test: audio played, mouth never moved.
 *
 * "beforeModelUpdate" is emitted from inside that exact window (after
 * motion/physics/pose, right before `model.update()`), which is the same
 * spot the library's own now-commented-out lipsync code used to sit. That's
 * why we hook the event instead of re-adding an independent loop.
 */
export function speakWithLipsync(model: Live2DModel, audioUrl: string): SpeakHandle {
  const audioEl = new Audio(audioUrl);
  audioEl.crossOrigin = "anonymous";

  const ctx = getAudioContext();
  const source = ctx.createMediaElementSource(audioEl);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);
  analyser.connect(ctx.destination);

  const timeDomain = new Uint8Array(analyser.frequencyBinCount);
  const internalModel = model.internalModel;
  const lipSyncIds: string[] = internalModel.motionManager.lipSyncIds ?? [];

  let finishCallback: (() => void) | undefined;
  let cleaned = false;

  function onBeforeModelUpdate(): void {
    if (audioEl.paused || audioEl.ended) return;

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
    const mouthOpen = Math.min(1, rms * MOUTH_GAIN);

    for (const id of lipSyncIds) {
      internalModel.coreModel.addParameterValueById(id, mouthOpen, 0.8);
    }
  }

  function cleanup(): void {
    if (cleaned) return;
    cleaned = true;
    internalModel.off("beforeModelUpdate", onBeforeModelUpdate);
    source.disconnect();
    analyser.disconnect();
  }

  function onEnded(): void {
    cleanup();
    finishCallback?.();
  }

  internalModel.on("beforeModelUpdate", onBeforeModelUpdate);
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
