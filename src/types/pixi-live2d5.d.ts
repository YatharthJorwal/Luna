// pixi-live2d5's real type declarations are generated from its source PLUS
// Live2D's proprietary Cubism Core .d.ts, which we don't have and can't
// redistribute (see vendor/pixi-live2d5/NOTES.md). This is a hand-written
// shim covering only what src/main.ts and src/lipsync.ts actually touch --
// not a full type-check of the library itself. If you add usage of
// something not declared here, TypeScript will tell you exactly what's
// missing.
declare module "pixi-live2d5" {
  import type { Container, ObservablePoint, Bounds } from "pixi.js";

  interface CoreModel {
    addParameterValueById(id: string, value: number, weight?: number): void;
    setParameterValueById(id: string, value: number, weight?: number): void;
  }

  interface MotionManager {
    lipSyncIds: string[];
  }

  interface InternalModel {
    coreModel: CoreModel;
    motionManager: MotionManager;
    width: number;
    height: number;
  }

  export class Live2DModel extends Container {
    static from(source: string, options?: Record<string, unknown>): Promise<Live2DModel>;

    anchor: ObservablePoint;
    internalModel: InternalModel;

    motion(group: string, index?: number, priority?: number): Promise<boolean>;
    getLocalBounds(): Bounds;
  }
}
