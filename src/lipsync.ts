// pixi-live2d5 (see vendor/pixi-live2d5/NOTES.md for why we're on this fork)
// doesn't drive lipsync automatically -- its internal hook for it is written
// but commented out in Cubism5InternalModel.ts. So we drive it ourselves:
// play the audio through a Web Audio AnalyserNode, read the amplitude each
// frame, and push it into whichever Cubism parameters the model's own
// model3.json declares under its "LipSync" group (ParamMouthOpenY for
// Hiyori, but this doesn't hardcode that -- it asks the model).

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
}

/**
 * Plays `audioUrl` through the browser's audio output and, for as long as
 * it's playing, feeds a mouth-openness value (0..1) into the model's
 * LipSync-group parameters every animation frame.
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
  const lipSyncIds: string[] = model.internalModel.motionManager.lipSyncIds ?? [];

  let finishCallback: (() => void) | undefined;
  let running = true;

  function tick(): void {
    if (!running) return;

    if (!audioEl.paused && !audioEl.ended) {
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

      const coreModel = model.internalModel.coreModel as {
        addParameterValueById(id: string, value: number, weight?: number): void;
      };
      for (const id of lipSyncIds) {
        coreModel.addParameterValueById(id, mouthOpen, 0.8);
      }
    }

    requestAnimationFrame(tick);
  }

  audioEl.addEventListener("ended", () => {
    running = false;
    source.disconnect();
    analyser.disconnect();
    finishCallback?.();
  });

  audioEl.play().catch((err) => console.error("[luna] audio playback failed", err));
  requestAnimationFrame(tick);

  return {
    onFinish(cb) {
      finishCallback = cb;
    },
  };
}
