import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";
import { VRMAnimationLoaderPlugin, createVRMAnimationClip, type VRMAnimation } from "@pixiv/three-vrm-animation";
import { setupSandboxHud } from "./sandbox-hud";
import {
  buildApartment,
  TIMES_OF_DAY,
  ANCHORS,
  CENTRE,
  type TimeOfDay,
  type ApartmentHandle,
  type NavPatch,
  type Anchor,
} from "./apartment/index";
import { createPostFX, QUALITIES, type Quality, type PostFX } from "./postfx";
import { createCameraRig, type CameraRig, type CameraMode } from "./camera-modes";

// Same character asset the desktop shell uses -- see README.md's "Putting
// your VRoid model in" section. Nothing sandbox-specific about the model
// file itself, only about how it's staged and moved around once loaded.
const MODEL_PATH = "/vrm/luna.vrm";

const ANIM_BASE_PATH = "/vrm-animations/";

// ---------------------------------------------------------------------
// Locomotion: real, measured gait data instead of a guessed constant.
// Every number in this block is hand-copied from the "Hanami" VRMA
// pack's own world.json (Overte animations, Apache-2.0 -- see
// public/vrm-animations/NOTICE.md and docs/DECISIONS.md's "go big"
// entry for the full license/engineering writeup), not read from that
// file at runtime -- see the same DECISIONS.md entry for why that's a
// deliberate scope cut this round, not an oversight.
//
// world-walk.vrma is a CYCLE played *in place* (its own translation
// track is zero) -- moving her through the room is code's job, driven
// by the clip's own measured speed rather than a guess. The reference
// rig this was measured on has its hips at 1.0167 m; scaling by this
// model's own hip height is what actually fixes "moonwalking" for
// good, replacing the round-4 patch's untested guess with real data.
const WORLD_WALK_LOOP_FILE = "world-walk.vrma";
const WORLD_WALK_LOOP_DURATION_S = 1.0; // world.json: clips["world-walk"].dureeS
const WORLD_WALK_SPEED_MPS_AT_REFERENCE_HIPS = 1.421; // world.json: clips["world-walk"].deplacement.vitesseMS
const REFERENCE_RIG_HIPS_M = 1.0167; // world.json: rigDeMesure.hanchesAuReposM

// world-walk-start's LAST frame is deliberately identical to
// world-walk's pose at this phase, not at t=0 -- the loop has already
// "started" mid-stride by the time the wind-up ends. Entering the loop
// anywhere else pops by up to 81 cm at the reference rig, per the
// pack's own measurement.
const WORLD_WALK_START_FILE = "world-walk-start.vrma";
const WORLD_WALK_START_DURATION_S = 0.4; // world.json: clips["world-walk-start"].dureeS
const WORLD_WALK_START_ENTRY_PHASE_S = 0.2; // world.json: clips["world-walk-start"].enchaine.phaseEntreeCibleS

// The mirror image on the way out: every stop clip's FIRST frame is
// identical to world-walk's pose at its cycle seam (t=0, same point as
// t=duration) -- leaving the loop anywhere else pops by up to 46 cm.
// All five stops share this same exit contract, given here as a
// tolerance window that wraps across the loop seam -- that's why one
// can be picked at random with no other bookkeeping once she's inside
// the window.
const WORLD_WALK_STOP_EXIT_PHASE_WINDOW_S: readonly [number, number] = [0.967, 0.033];
// Four "long stop" variants (picked at random) for a walk that actually
// covered ground, one "small stop" for a walk that barely moved (a
// wander target that landed almost where she already was) -- same
// long-vs-small distinction the source pack's own player makes, using
// its own threshold (Overte switches on whether she'd picked up
// "momentum", over 2.2 m/s -- our only gait never reaches that, so the
// distinction here is drawn on distance covered instead).
const WORLD_WALK_STOP_FILES: ReadonlyArray<{ file: string; durationS: number }> = [
  { file: "world-walk-stop.vrma", durationS: 1.9 },
  { file: "world-walk-stop-2.vrma", durationS: 1.27 },
  { file: "world-walk-stop-3.vrma", durationS: 1.97 },
  { file: "world-walk-stop-4.vrma", durationS: 2.7 },
];
const WORLD_WALK_STOP_SMALL_FILE = "world-walk-stop-small.vrma";
const WORLD_WALK_STOP_SMALL_DURATION_S = 1.27;
const WALK_BOUT_SMALL_STOP_THRESHOLD_M = 1.0; // below this much ground covered, she gets the small stop instead of a long one

// Last-resort fallback constants, used only when world-walk.vrma itself
// didn't load (ProceduralWalker's crude sine-swing path, unchanged from
// before this round) -- everything above this comment assumes the real
// clip is present.
const FALLBACK_WALK_SPEED_MPS = 1.4; // roughly an average adult's walking pace, a guess
const FALLBACK_SLOWDOWN_RADIUS_M = 0.6; // starts easing speed down inside this distance from the target

// ---------------------------------------------------------------------
// Idle base poses -- what she stands in when there's nothing else going
// on, redrawn periodically (real per-clip looping poses now, not a walk
// clip frozen at timeScale 0 like before this round). Two separate
// pools: the default standing idle, and a version played specifically
// while a reply is being written (hud.isTurnActive()) -- the "during
// dialogues, idles" distinction the user asked for, and a real role the
// source pack defines (idle-talking.vrma), not something invented here.
// idle-5/-6 are missing on purpose in both -- they became
// world-idle-alt1/2 in the source pack (a different standing stance,
// not wired up this round -- see docs/DECISIONS.md).
const IDLE_BASE_FILES = ["idle.vrma", "idle-2.vrma", "idle-3.vrma", "idle-4.vrma", "idle-7.vrma"];
const IDLE_TALKING_FILES = [
  "idle-talking.vrma",
  "idle-talking-4.vrma",
  "idle-talking-5.vrma",
  "idle-talking-6.vrma",
  "idle-talking-7.vrma",
];
// Redrawn on roughly these intervals while she stays in one state long
// enough to matter -- the same cadence the source pack's own player
// uses (idle every 10-30s, talking idle every 7-12s), so a long silence
// or a long reply doesn't visibly loop forever.
const IDLE_VARIETY_MIN_S = 10;
const IDLE_VARIETY_MAX_S = 30;
const IDLE_TALKING_VARIETY_MIN_S = 7;
const IDLE_TALKING_VARIETY_MAX_S = 12;
const IDLE_CROSSFADE_S = 0.4; // matches the source pack's own documented out-fade for its transitions

// ---------------------------------------------------------------------
// Emotion gestures -- swapped this round to the source pack's fitted,
// licensed face-to-face family wherever it has a matching role (each
// one's seam to idle/idle-talking was measured under 10 cm before it
// shipped -- see NOTICE.md); the user's own custom clips from the
// previous two rounds fill the two roles the pack doesn't cover at all
// (it has no "surprised" clip, and no "teasing" role either).
const GESTURE_CLIP_FILES: Record<string, string> = {
  happy: "happy.vrma",
  sad: "sad.vrma",
  angry: "angry.vrma",
  teasing: "relaxed.vrma", // closest the pack has to "teasing"; same reasoning as round 3, new source file
  surprised: "Surprised.vrma", // the user's own -- the pack has none at all, see above
  // Idle-variety extras carried over from round 3/4, unrelated to
  // emotions -- still loaded, played by IdleGestureScheduler below, not
  // by GESTURE_FOR_EMOTION.
  clapping: "Clapping.vrma",
  goodbye: "Goodbye.vrma",
  jump: "Jump.vrma",
  lookAround: "LookAround.vrma",
  sleepy: "Sleepy.vrma",
  thinking: "Thinking.vrma",
};

// Per-gesture hold time after the clip's own animation ends, before it
// fades back to idle (see GESTURE_FADE_S / the hold-then-fade lifecycle
// in CharacterController). The source pack's clips are already measured
// to land close to idle -- see the acceptance-rule note in its
// README.md -- so they don't need the artificial pause the round-4 fix
// gave the user's own, unmeasured custom clips to let a reaction "land"
// before dissolving.
const PACK_GESTURE_NAMES = new Set(["happy", "sad", "angry", "teasing"]);
const PACK_GESTURE_HOLD_S = 0.3;
const CUSTOM_GESTURE_HOLD_S = 1.4;
const GESTURE_FADE_S = 0.4;

// Which gesture key (above) auto-fires when a given app-facing emotion
// arrives on turn_end -- deliberately a *separate* table from
// GESTURE_CLIP_FILES rather than reusing emotion names as gesture keys
// directly, so a future gesture can be renamed/re-mapped independently
// of the LLM-facing vocabulary in persona.py. "neutral" has no entry on
// purpose: returning to idle already reads as neutral.
const GESTURE_FOR_EMOTION: Partial<Record<string, string>> = {
  happy: "happy",
  sad: "sad",
  angry: "angry",
  teasing: "teasing",
  surprised: "surprised",
};

const TURN_RATE_RAD_S = 4; // how fast she reorients to face her movement direction -- was 10 (a 180° snap in ~0.3s, effectively instant); with only the crude procedural sway to compare it against, that snap wasn't very noticeable, but next to a real authored walk cycle it reads as a jarring robotic pop, per the user's own "kinda awkward" report. 4 rad/s takes ~0.8s for a full about-face -- still brisk, not sluggish, but no longer an instant snap. Untested against real motion, same as everything else in this file -- a reasoned adjustment, not a measurement.
const ARRIVE_RADIUS_M = 0.08; // "close enough" to a wander target for WanderController to call it arrived

// ---------------------------------------------------------------------
// The apartment.
//
// This used to be buildStudio(): a plain white box with a grid floor,
// four walls and a ceiling at ROOM_HALF_SIZE/ROOM_HEIGHT. That box was
// only ever scaffolding to watch locomotion against -- it did its job
// through the whole walk-direction saga in rounds 4-6, and with walking
// confirmed fixed there is no reason to keep staring at a grey cube.
// It is gone; src/apartment.ts builds the real four-room apartment in
// its place and owns the scene's background, fog and lighting.
//
// Two pieces of the old studio deliberately did NOT survive:
//
//   - ROOM_LIGHT_LAYER and roomFillLight. That was a layer-masked
//     hemisphere light whose entire job was to brighten near-white box
//     geometry without also washing out the character's MToon shading.
//     The apartment is textured and has its own four-mode lighting rig,
//     so there is no flat-grey-box problem left to solve, and keeping a
//     second hidden fill light would just fight that rig.
//   - scene.background. apartment.ts drives background and fog from the
//     active lighting mode; setting it here too would race with that.
//
// The character key light DOES survive, for the reason given below.
// ---------------------------------------------------------------------

// Same arm-down rest pose as main.ts's applyIdlePose (VRM's bind pose is
// a T-pose by default, see that function's own comment for the full
// reasoning and how these rotation values were derived) -- duplicated
// rather than imported so this file has zero dependency on main.ts, per
// the brief. Only the swing axis (x) is touched by the procedural walk
// below; z stays at these authored values throughout.
const REST_ARM_Z = 1.35;
const REST_ELBOW_Y = 0.15;

function applyRestPose(vrm: VRM): void {
  const humanoid = vrm.humanoid;
  if (!humanoid) return;
  humanoid.getNormalizedBoneNode("leftUpperArm")?.rotation.set(0, 0, -REST_ARM_Z);
  humanoid.getNormalizedBoneNode("rightUpperArm")?.rotation.set(0, 0, REST_ARM_Z);
  humanoid.getNormalizedBoneNode("leftLowerArm")?.rotation.set(0, -REST_ELBOW_Y, 0);
  humanoid.getNormalizedBoneNode("rightLowerArm")?.rotation.set(0, REST_ELBOW_Y, 0);
}


// A soft circular shadow decal that tracks the character's feet -- cheap
// grounding cue instead of real shadow-mapping (which MToon's toon
// shading doesn't play well with anyway). Purely cosmetic; safe to ignore
// if it ever needs to go.
function buildContactShadow(): THREE.Mesh {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, "rgba(20,20,24,0.28)");
  gradient.addColorStop(1, "rgba(20,20,24,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  const mesh = new THREE.Mesh(
    new THREE.CircleGeometry(0.38, 32),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true, depthWrite: false }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.003;
  return mesh;
}

// ---------------------------------------------------------------------
// Procedural walk cycle: used whenever WALK_CLIP_PATH isn't present
// (the default, until a real animation is dropped in). Pure sine-wave
// leg/arm swing driven by how fast the character is currently moving --
// zero external assets needed.
// ---------------------------------------------------------------------
const LEG_SWING_RAD = 0.5;
const KNEE_BEND_RAD = 0.75;
const ARM_SWING_RAD = 0.35;
const HIP_BOB_M = 0.02;
const WALK_CYCLE_RATE = 6.5; // radians/sec of phase advance at full speed -- tuned by eye for a natural-looking cadence, not measured against a real gait

interface WalkBones {
  leftUpperLeg: THREE.Object3D | null;
  rightUpperLeg: THREE.Object3D | null;
  leftLowerLeg: THREE.Object3D | null;
  rightLowerLeg: THREE.Object3D | null;
  leftUpperArm: THREE.Object3D | null;
  rightUpperArm: THREE.Object3D | null;
  hips: THREE.Object3D | null;
}

function collectWalkBones(vrm: VRM): WalkBones {
  const h = vrm.humanoid;
  return {
    leftUpperLeg: h?.getNormalizedBoneNode("leftUpperLeg") ?? null,
    rightUpperLeg: h?.getNormalizedBoneNode("rightUpperLeg") ?? null,
    leftLowerLeg: h?.getNormalizedBoneNode("leftLowerLeg") ?? null,
    rightLowerLeg: h?.getNormalizedBoneNode("rightLowerLeg") ?? null,
    leftUpperArm: h?.getNormalizedBoneNode("leftUpperArm") ?? null,
    rightUpperArm: h?.getNormalizedBoneNode("rightUpperArm") ?? null,
    hips: h?.getNormalizedBoneNode("hips") ?? null,
  };
}

class ProceduralWalker {
  private phase = 0;
  private amplitude = 0; // eases toward speedFraction so start/stop blends instead of snapping
  private restHipsY: number;

  constructor(private bones: WalkBones) {
    this.restHipsY = bones.hips?.position.y ?? 0;
  }

  update(delta: number, speedFraction: number): void {
    if (!this.bones.leftUpperLeg) return; // model has no legs mapped -- nothing to animate, no-op
    if (speedFraction > 0.01) this.phase += delta * WALK_CYCLE_RATE;
    this.amplitude += (speedFraction - this.amplitude) * Math.min(1, delta * 6);

    const swing = Math.sin(this.phase) * this.amplitude;

    this.bones.leftUpperLeg!.rotation.x = swing * LEG_SWING_RAD;
    if (this.bones.rightUpperLeg) this.bones.rightUpperLeg.rotation.x = -swing * LEG_SWING_RAD;
    if (this.bones.leftLowerLeg) this.bones.leftLowerLeg.rotation.x = -Math.max(0, -swing) * KNEE_BEND_RAD;
    if (this.bones.rightLowerLeg) this.bones.rightLowerLeg.rotation.x = -Math.max(0, swing) * KNEE_BEND_RAD;

    // Arms counter-swing opposite their same-side leg, only on the swing
    // axis -- applyRestPose's own z/elbow-bend values are left alone.
    if (this.bones.leftUpperArm) this.bones.leftUpperArm.rotation.x = -swing * ARM_SWING_RAD;
    if (this.bones.rightUpperArm) this.bones.rightUpperArm.rotation.x = swing * ARM_SWING_RAD;

    if (this.bones.hips) {
      this.bones.hips.position.y = this.restHipsY + Math.abs(Math.sin(this.phase * 2)) * HIP_BOB_M * this.amplitude;
    }
  }
}

// ---------------------------------------------------------------------
// Wander controller: a placeholder for real AI-driven navigation. This
// is Her space, not the person watching's -- per the brief, nobody
// drives her model directly here. Until the orchestrator can actually
// send movement/animation decisions over the same WebSocket connection
// sandbox-hud.ts already opens (a `walk_to` / `play_animation` message
// type, say), this picks a random point inside the room and walks her
// there, pausing at each stop for a random beat, purely so the sandbox
// has *something* alive happening rather than a frozen mannequin -- not
// a real behavior model, and not trying to look like one. Swapping this
// out later for orchestrator-driven decisions only means replacing
// *this one class*: CharacterController below only ever asks it for
// "where should she be walking to, if anywhere right now" and doesn't
// care how that answer was decided.
// ---------------------------------------------------------------------
// ---------------------------------------------------------------------
// Walkable area + wandering.
//
// The navmesh is still a union of convex rectangles (the round-9
// design, and the property it rests on is unchanged: a straight line
// between two points inside one rectangle stays inside it, so a walk
// leg that never leaves its rectangle can never cut through a wall).
// What changed with the new apartment is scale and intent. There are
// now nine rooms' worth of patches plus five doorways, and the flat is
// big enough that picking uniformly random points would have her
// drifting aimlessly around a 108 sq m space forever.
//
// So wandering is now anchor-driven: floorplan.ts names the places
// worth standing -- the sofa, the kitchen counter, her desk, the
// basin -- and she picks one of those as a destination, routes to it
// through whatever doorways lie between, stands there for the dwell
// time that anchor declares, and then picks another. Random points
// within a room are still used, but only as filler between anchors,
// which is what stops it looking like a patrol route.
//
// Routing is breadth-first over the patch-overlap graph. It's a small
// graph (14 nodes) recomputed only when she picks a new destination,
// so there's no reason to do anything cleverer.
// ---------------------------------------------------------------------
class WalkableArea {
  constructor(private readonly rects: NavPatch[]) {}

  private static closestPointOn(r: NavPatch, x: number, z: number): { x: number; z: number; d2: number } {
    const cx = Math.min(r.maxX, Math.max(r.minX, x));
    const cz = Math.min(r.maxZ, Math.max(r.minZ, z));
    const dx = cx - x;
    const dz = cz - z;
    return { x: cx, z: cz, d2: dx * dx + dz * dz };
  }

  contains(x: number, z: number): boolean {
    for (const r of this.rects) {
      if (x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ) return true;
    }
    return false;
  }

  /** Nearest legal standing position to (x, z). Returns the input
   * unchanged when it's already on walkable floor. */
  clamp(x: number, z: number): { x: number; z: number } {
    let best = { x, z, d2: Infinity };
    for (const r of this.rects) {
      const c = WalkableArea.closestPointOn(r, x, z);
      if (c.d2 === 0) return { x, z };
      if (c.d2 < best.d2) best = c;
    }
    return { x: best.x, z: best.z };
  }
}

const IDLE_MIN_S = 2.5;
const IDLE_MAX_S = 6;
/** Odds a new destination is a named anchor rather than a random spot. */
const ANCHOR_CHANCE = 0.72;
const WANDER_MARGIN_M = 0.28;
const DOORWAY_MARGIN_M = 0.1;

interface Leg {
  point: THREE.Vector3;
  /** Set when this leg ends at a named anchor. */
  anchor: Anchor | null;
}

class WanderController {
  private queue: Leg[] = [];
  private active: Leg | null = null;
  private idleUntil = 0;
  private elapsed = 0;
  private here = 0;
  private readonly patches: NavPatch[];
  private readonly adj: number[][];

  constructor(patches: NavPatch[], startAt: THREE.Vector3) {
    if (patches.length === 0) throw new Error("WanderController: no walkable patches");
    this.patches = patches;
    this.adj = patches.map((_, i) =>
      patches.map((__, j) => j).filter((j) => j !== i && WanderController.overlap(patches[i], patches[j]) !== null),
    );
    this.here = this.patchContaining(startAt.x, startAt.z) ?? 0;
  }

  /** Where she should be walking, or null to stand still. */
  getTarget(delta: number, currentPos: THREE.Vector3, paused: boolean): THREE.Vector3 | null {
    if (this.active) {
      if (flatDistance(currentPos, this.active.point) < ARRIVE_RADIUS_M) {
        const reached = this.active;
        this.active = null;
        const next = this.queue.shift();
        if (next) {
          this.active = next;
          return next.point;
        }
        const dwell = reached.anchor
          ? reached.anchor.dwell[0] + Math.random() * (reached.anchor.dwell[1] - reached.anchor.dwell[0])
          : IDLE_MIN_S + Math.random() * (IDLE_MAX_S - IDLE_MIN_S);
        this.idleUntil = this.elapsed + dwell;
        this.lastAnchor = reached.anchor;
      } else {
        return this.active.point;
      }
    }
    if (paused) return null;
    this.elapsed += delta;
    if (this.elapsed >= this.idleUntil) {
      this.plan(currentPos);
      this.active = this.queue.shift() ?? null;
      return this.active?.point ?? null;
    }
    return null;
  }

  /** The anchor she most recently arrived at, for the scene-state text. */
  lastAnchor: Anchor | null = null;

  /** Facing she should settle into on arrival, if the anchor asks for one. */
  restingFacing(): number | null {
    return this.active === null && this.lastAnchor ? this.lastAnchor.facing : null;
  }

  private patchContaining(x: number, z: number): number | null {
    for (let i = 0; i < this.patches.length; i++) {
      const r = this.patches[i];
      if (x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ) return i;
    }
    return null;
  }

  private static overlap(a: NavPatch, b: NavPatch): NavPatch | null {
    const minX = Math.max(a.minX, b.minX);
    const maxX = Math.min(a.maxX, b.maxX);
    const minZ = Math.max(a.minZ, b.minZ);
    const maxZ = Math.min(a.maxZ, b.maxZ);
    if (minX >= maxX || minZ >= maxZ) return null;
    return { name: `${a.name}|${b.name}`, room: b.room, minX, maxX, minZ, maxZ };
  }

  private static pointIn(r: NavPatch, margin: number): THREE.Vector3 {
    const cx = (r.minX + r.maxX) / 2;
    const cz = (r.minZ + r.maxZ) / 2;
    const halfX = Math.max(0, (r.maxX - r.minX) / 2 - margin);
    const halfZ = Math.max(0, (r.maxZ - r.minZ) / 2 - margin);
    return new THREE.Vector3(
      cx + (Math.random() * 2 - 1) * halfX,
      0,
      cz + (Math.random() * 2 - 1) * halfZ,
    );
  }

  /** Breadth-first path between patches, as a list of patch indices. */
  private route(from: number, to: number): number[] | null {
    if (from === to) return [to];
    const prev = new Map<number, number>();
    const seen = new Set([from]);
    const q = [from];
    while (q.length) {
      const cur = q.shift() as number;
      for (const n of this.adj[cur]) {
        if (seen.has(n)) continue;
        seen.add(n);
        prev.set(n, cur);
        if (n === to) {
          const path = [to];
          let c = to;
          while (c !== from) {
            c = prev.get(c) as number;
            path.unshift(c);
          }
          return path;
        }
        q.push(n);
      }
    }
    return null;
  }

  /** Fill the leg queue with a route to a freshly chosen destination. */
  private plan(currentPos: THREE.Vector3): void {
    this.here = this.patchContaining(currentPos.x, currentPos.z) ?? this.here;
    this.queue = [];

    let destPatch: number;
    let destPoint: THREE.Vector3;
    let destAnchor: Anchor | null = null;

    if (Math.random() < ANCHOR_CHANCE) {
      const options = ANCHORS.filter((a) => a.id !== this.lastAnchor?.id);
      const a = options[Math.floor(Math.random() * options.length)];
      const pi = this.patchContaining(a.x, a.z);
      if (pi === null) {
        // Anchor isn't on the navmesh -- fall back rather than get stuck.
        destPatch = Math.floor(Math.random() * this.patches.length);
        destPoint = WanderController.pointIn(this.patches[destPatch], WANDER_MARGIN_M);
      } else {
        destPatch = pi;
        destPoint = new THREE.Vector3(a.x, 0, a.z);
        destAnchor = a;
      }
    } else {
      const roomPatches = this.patches
        .map((p, i) => ({ p, i }))
        .filter(({ p }) => !p.doorway);
      const pick = roomPatches[Math.floor(Math.random() * roomPatches.length)];
      destPatch = pick.i;
      destPoint = WanderController.pointIn(pick.p, WANDER_MARGIN_M);
    }

    const path = this.route(this.here, destPatch);
    if (!path) {
      // Unreachable (shouldn't happen -- the harness checks connectivity) --
      // just wander within the current patch rather than freezing.
      this.queue.push({ point: WanderController.pointIn(this.patches[this.here], WANDER_MARGIN_M), anchor: null });
      return;
    }
    // One waypoint per doorway crossed: aim at the overlap between each
    // consecutive pair, which is inside both, so no leg leaves its patch.
    for (let k = 0; k < path.length - 1; k++) {
      const via = WanderController.overlap(this.patches[path[k]], this.patches[path[k + 1]]);
      if (via) this.queue.push({ point: WanderController.pointIn(via, DOORWAY_MARGIN_M), anchor: null });
    }
    this.queue.push({ point: destPoint, anchor: destAnchor });
    this.here = destPatch;
  }
}

function flatDistance(a: THREE.Vector3, b: THREE.Vector3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

// ---------------------------------------------------------------------
// Idle-variety scheduler: occasionally plays a small, non-reactive
// gesture while she's just standing there with nothing else going on --
// the user's own "we gotta add occasional idles too" ask. Deliberately
// separate from WanderController (which only ever decides *where to
// walk*, on its own 3-8s idle timer) rather than folded into it, so the
// two don't have to agree on a shared timer or either one's tuning
// affects the other. Only three of the loaded gesture files are used
// here (lookAround/sleepy/thinking) -- Clapping/Goodbye/Jump read as
// reactive/contextual rather than ambient idle flavor, so they're left
// for a real trigger later rather than firing at random.
const IDLE_GESTURE_NAMES = ["lookAround", "sleepy", "thinking"];
const IDLE_GESTURE_MIN_S = 8;
const IDLE_GESTURE_MAX_S = 20;

class IdleGestureScheduler {
  private elapsed = 0;
  private nextAt = IdleGestureScheduler.rollInterval();

  private static rollInterval(): number {
    return IDLE_GESTURE_MIN_S + Math.random() * (IDLE_GESTURE_MAX_S - IDLE_GESTURE_MIN_S);
  }

  /** Call once a frame. `eligible` should be true only while she's
   * standing still with nothing else claiming her body -- not walking
   * (no wander target), not mid-turn, and not already gesturing --
   * otherwise the countdown just freezes rather than firing the moment
   * she becomes free (so a long walk/turn doesn't "bank" an idle
   * gesture to fire the instant it ends). */
  update(delta: number, eligible: boolean, playGesture: (name: string) => void): void {
    if (!eligible) return;
    this.elapsed += delta;
    if (this.elapsed < this.nextAt) return;
    const name = IDLE_GESTURE_NAMES[Math.floor(Math.random() * IDLE_GESTURE_NAMES.length)]!;
    playGesture(name);
    this.elapsed = 0;
    this.nextAt = IdleGestureScheduler.rollInterval();
  }
}

function lerpAngle(a: number, b: number, t: number): number {
  let diff = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

// Converts a world-space (x,z) direction into the yaw angle applied to
// vrm.scene.rotation.y so she visually faces that direction. This model's
// real forward axis turned out to be the opposite of the usual
// three.js/VRM1 "-Z is forward" convention every earlier round assumed
// (confirmed on the user's own machine, after three straight rounds of
// diagnostics that all came back "internally consistent" without
// catching it -- see docs/DECISIONS.md's round-6 entries for the full
// trail, including why those diagnostics had a structural blind spot
// they couldn't see past). `Math.atan2(x, z)`, no negation -- every
// direction-to-angle conversion in CharacterController goes through this
// one function.
function directionToFacingAngle(x: number, z: number): number {
  return Math.atan2(x, z);
}

/** Best-effort single-clip loader shared by every animation load in
 * boot() below (walk loop/start/stop, idle base/talking, gestures) --
 * a missing file just resolves to null rather than throwing, same
 * tolerance-of-absence philosophy this file has had since walk.vrma was
 * the only optional clip. */
async function loadClip(loader: GLTFLoader, vrm: VRM, filename: string): Promise<THREE.AnimationClip | null> {
  try {
    const clipGltf = await loader.loadAsync(`${ANIM_BASE_PATH}${filename}`);
    const vrmAnimations = clipGltf.userData.vrmAnimations as VRMAnimation[] | undefined;
    if (!vrmAnimations?.[0]) return null;
    const clip = createVRMAnimationClip(vrmAnimations[0], vrm);
    clip.name = filename;
    return clip;
  } catch {
    return null; // not present -- expected default for anything not dropped into public/vrm-animations/ under that exact filename
  }
}

// ---------------------------------------------------------------------
// Character controller: steers vrm.scene toward whatever target
// WanderController hands it (or stands idle if there isn't one), drives
// a real phase-locked walk cycle when the source pack's clips loaded
// (falling back to the old procedural sway if they didn't), plays a
// randomly-varied idle/idle-talking loop the rest of the time, and
// layers one-shot gestures on top of all of it. No player input reaches
// this class at all -- see the brief: this is Luna's space, not
// something to joystick around by hand.
// ---------------------------------------------------------------------
class CharacterController {
  private facing = 0;
  /** Set once in boot() -- see setWalkableArea(). */
  private walkable: WalkableArea | null = null;
  private readonly walker: ProceduralWalker;
  private readonly mixer: THREE.AnimationMixer;

  // --- one-shot emotion/idle-variety gestures (rounds 3-4; the
  // hold-then-fade lifecycle below is unchanged, only which clip backs
  // which name and how long it holds are new this round) ---
  private readonly gestureActions = new Map<string, THREE.AnimationAction>();
  private readonly gestureHoldSeconds = new Map<THREE.AnimationAction, number>();
  private activeGesture: THREE.AnimationAction | null = null;
  private gesturePhase: "hold" | "fade" | null = null;
  private gestureTimer = 0;

  // --- idle base loops (new this round) ---
  private readonly idleBaseActions: THREE.AnimationAction[] = [];
  private readonly idleTalkingActions: THREE.AnimationAction[] = [];
  private currentIdleAction: THREE.AnimationAction | null = null;
  private currentIdleIsTalking = false;
  private idleVarietyElapsed = 0;
  private idleVarietyNextAt = 0;

  // --- real walk cycle (new this round -- phase-locked start/loop/stop
  // replacing round 4's flat-speed translation). null fields mean that
  // particular clip never loaded; walkLoopAction null specifically means
  // "fall back to ProceduralWalker entirely", checked once in update(). ---
  private readonly walkLoopAction: THREE.AnimationAction | null;
  private readonly walkStartAction: THREE.AnimationAction | null;
  private readonly walkStopActions: THREE.AnimationAction[] = [];
  private readonly walkStopSmallAction: THREE.AnimationAction | null;
  private readonly walkStopDurations = new Map<THREE.AnimationAction, number>();
  private readonly walkSpeedMps: number;
  // In real-walk mode this cycles through all five states below; in
  // fallback mode (no walkLoopAction) updateFallbackLocomotion only ever
  // sets it to "none" or "looping", skipping start/arriving/stopping --
  // there's no start/stop clip to sequence without the real pack, but
  // reusing the same field keeps isWalking/updateIdleBase uniform across
  // both modes rather than needing a second parallel flag.
  private walkPhase: "none" | "starting" | "looping" | "arriving" | "stopping" = "none";
  private walkPhaseTimer = 0;
  private readonly walkDir = new THREE.Vector3(0, 0, -1);
  private walkBoutDistanceM = 0;
  private currentStopAction: THREE.AnimationAction | null = null;

  constructor(
    private vrm: VRM,
    clips: {
      walkLoop: THREE.AnimationClip | null;
      walkStart: THREE.AnimationClip | null;
      walkStops: Array<{ clip: THREE.AnimationClip; durationS: number }>;
      walkStopSmall: { clip: THREE.AnimationClip; durationS: number } | null;
    },
  ) {
    this.walker = new ProceduralWalker(collectWalkBones(vrm));
    this.mixer = new THREE.AnimationMixer(vrm.scene);

    // Real per-model speed, not a guess -- see the WORLD_WALK_* comments
    // above. normalizedRestPose is exactly the API the pack's own
    // world.json cites for this scaling.
    const hipsY = vrm.humanoid.normalizedRestPose.hips?.position?.[1] ?? REFERENCE_RIG_HIPS_M;
    this.walkSpeedMps = WORLD_WALK_SPEED_MPS_AT_REFERENCE_HIPS * (hipsY / REFERENCE_RIG_HIPS_M);

    this.walkLoopAction = clips.walkLoop ? this.mixer.clipAction(clips.walkLoop) : null;
    // Not played here -- enterWalkLoop() below explicitly sets its phase
    // every time she starts walking, so it must stay unplayed (and thus
    // uncontrolled-drift-free) until then rather than free-running from
    // boot.
    this.walkStartAction = clips.walkStart ? this.mixer.clipAction(clips.walkStart) : null;
    if (this.walkStartAction) {
      this.walkStartAction.setLoop(THREE.LoopOnce, 1);
      this.walkStartAction.clampWhenFinished = true;
    }
    for (const { clip, durationS } of clips.walkStops) {
      const action = this.mixer.clipAction(clip);
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
      this.walkStopActions.push(action);
      this.walkStopDurations.set(action, durationS);
    }
    if (clips.walkStopSmall) {
      const action = this.mixer.clipAction(clips.walkStopSmall.clip);
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
      this.walkStopSmallAction = action;
      this.walkStopDurations.set(action, clips.walkStopSmall.durationS);
    } else {
      this.walkStopSmallAction = null;
    }

    // Fires once when a gesture's own clip reaches its end (LoopOnce) --
    // NOT when playGesture() interrupts one early (that path fades the
    // old action out directly, so this event either never fires for it
    // or fires after `activeGesture` has already moved on, in which case
    // the `!==` check below correctly ignores it).
    this.mixer.addEventListener("finished", (event) => {
      if (event.action !== this.activeGesture) return;
      this.gesturePhase = "hold";
      this.gestureTimer = this.gestureHoldSeconds.get(event.action) ?? CUSTOM_GESTURE_HOLD_S;
    });
  }

  get usingRealWalk(): boolean {
    return this.walkLoopAction !== null;
  }

  get gestureCount(): number {
    return this.gestureActions.size;
  }

  get idleBaseCount(): number {
    return this.idleBaseActions.length + this.idleTalkingActions.length;
  }

  /** True while a gesture is playing, held, or fading back -- lets
   * boot()'s idle-variety scheduler avoid firing a random idle gesture
   * on top of one already in progress. */
  get isGesturing(): boolean {
    return this.activeGesture !== null;
  }

  /** True through the whole walk lifecycle (starting/looping/arriving/
   * stopping, or just "looping" in fallback mode) -- lets boot()'s
   * idle-variety scheduler avoid firing a random idle gesture mid-walk. */
  get isWalking(): boolean {
    return this.walkPhase !== "none";
  }

  /** Registers a loaded gesture clip under `name` (one of
   * GESTURE_CLIP_FILES's keys) so playGesture(name) can trigger it
   * later. Call once per clip after boot()'s best-effort load loop. */
  registerGesture(name: string, clip: THREE.AnimationClip): void {
    const action = this.mixer.clipAction(clip);
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true; // holds the clip's last pose during its hold phase instead of popping back to bind pose the instant it ends
    this.gestureActions.set(name, action);
    this.gestureHoldSeconds.set(action, PACK_GESTURE_NAMES.has(name) ? PACK_GESTURE_HOLD_S : CUSTOM_GESTURE_HOLD_S);
  }

  /** Registers a looping idle clip into the base ("standing around") or
   * talking ("a reply is being written") pool. Call once per clip after
   * boot()'s best-effort load loop. */
  registerIdleBase(clip: THREE.AnimationClip, talking: boolean): void {
    const action = this.mixer.clipAction(clip);
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.setEffectiveWeight(0);
    (talking ? this.idleTalkingActions : this.idleBaseActions).push(action);
  }

  /** Plays a registered one-shot gesture immediately, if one exists
   * under that name -- silently does nothing for an unregistered name
   * (e.g. a gesture file that never got dropped into
   * public/vrm-animations/, or an emotion with no GESTURE_FOR_EMOTION
   * entry) rather than throwing, same tolerance-of-absence philosophy as
   * everything else here. Interrupts and resets whatever walk/idle state
   * she was in -- known simplification, same as round 3/4: a gesture
   * mid-walk resets her to standing once it ends rather than resuming
   * the walk in progress. */
  playGesture(name: string): void {
    const next = this.gestureActions.get(name);
    if (!next) return;
    if (this.activeGesture && this.activeGesture !== next) {
      this.activeGesture.fadeOut(0.3);
    }
    this.suppressLocomotionAndIdle();
    next.reset().fadeIn(0.3).play();
    this.activeGesture = next;
    // Fresh play -- clear any hold/fade state left over from whatever
    // was previously active so this one gets its own full lifecycle.
    this.gesturePhase = null;
    this.gestureTimer = 0;
  }

  private suppressLocomotionAndIdle(): void {
    this.fadeOutIdleBase();
    if (this.walkLoopAction?.isRunning()) this.walkLoopAction.fadeOut(0.3);
    if (this.walkStartAction?.isRunning()) this.walkStartAction.fadeOut(0.3);
    if (this.currentStopAction?.isRunning()) this.currentStopAction.fadeOut(0.3);
    this.currentStopAction = null;
    this.walkPhase = "none";
    this.walkBoutDistanceM = 0;
  }

  private updateGestureLifecycle(delta: number): void {
    if (!this.activeGesture || !this.gesturePhase) return;
    this.gestureTimer -= delta;
    if (this.gestureTimer > 0) return;
    if (this.gesturePhase === "hold") {
      this.activeGesture.fadeOut(GESTURE_FADE_S);
      this.gesturePhase = "fade";
      this.gestureTimer = GESTURE_FADE_S;
    } else {
      // Fade's finished -- actually stop it (fadeOut alone eases weight
      // to 0 but leaves the action technically still "running" at zero
      // weight; stop() is what fully releases it) and hand control back.
      this.activeGesture.stop();
      this.activeGesture = null;
      this.gesturePhase = null;
    }
  }

  update(delta: number, target: THREE.Vector3 | null, isTalking: boolean): void {
    this.updateGestureLifecycle(delta);
    if (this.activeGesture) {
      // A gesture in flight takes over the whole body for its duration
      // -- skip locomotion/idle entirely rather than layering a walk or
      // idle loop underneath an authored full-body clip (both would be
      // fighting for the same bones).
      this.mixer.update(delta);
      return;
    }

    if (this.walkLoopAction) {
      this.updateRealLocomotion(delta, target);
    } else {
      this.updateFallbackLocomotion(delta, target);
    }
    this.updateIdleBase(delta, isTalking);
    this.mixer.update(delta);
  }

  // --- real walk cycle -------------------------------------------------

  private updateRealLocomotion(delta: number, target: THREE.Vector3 | null): void {
    switch (this.walkPhase) {
      case "none":
        if (target) this.beginWalkStart();
        break;
      case "starting":
        // Turn toward the target during the wind-up too, not just once
        // the loop starts -- found from a real screenshot report ("kinda
        // awkward"): facing previously only updated in stepAlong(), never
        // called during "starting", so if a new target landed in a very
        // different direction from wherever she last faced, she'd play
        // the whole wind-up still facing the old way and then visibly
        // snap to the new facing right as the loop began. This only
        // turns in place -- no translation during the wind-up, matching
        // world-walk-start's own authored motion (see the WORLD_WALK_*
        // comments above: no deplacement field for this clip, unlike the
        // gaits, so zero net translation is the documented assumption).
        if (target) this.updateFacing(this.directionTo(target), delta);
        this.walkPhaseTimer -= delta;
        if (this.walkPhaseTimer <= 0) this.enterWalkLoop();
        break;
      case "looping":
        if (target) {
          this.stepToward(target, delta);
        } else {
          // WanderController just declared arrival (dist < ARRIVE_RADIUS_M
          // -- see WanderController.getTarget). Don't cut the stride
          // short: keep walking in the same direction until the loop
          // reaches the seam the stop clips are anchored to.
          this.walkPhase = "arriving";
        }
        break;
      case "arriving":
        this.stepAlong(this.walkDir, delta);
        if (this.atStopExitPhase()) this.beginWalkStop();
        break;
      case "stopping":
        this.walkPhaseTimer -= delta;
        if (this.walkPhaseTimer <= 0) this.endWalk();
        break;
    }
  }

  /** Direction from her current position to `target`, flattened to the
   * XZ plane -- (0,0,-1) (whatever she's already facing has no bearing
   * here) if she's already on top of it. Shared by stepToward() and the
   * turn-in-place call during "starting" above so both compute the
   * direction the exact same way. */
  private directionTo(target: THREE.Vector3): THREE.Vector3 {
    const toTarget = new THREE.Vector3(
      target.x - this.vrm.scene.position.x,
      0,
      target.z - this.vrm.scene.position.z,
    );
    return toTarget.lengthSq() > 0.000001 ? toTarget.normalize() : this.walkDir.clone();
  }

  private stepToward(target: THREE.Vector3, delta: number): void {
    const dir = this.directionTo(target);
    this.walkDir.copy(dir);
    this.stepAlong(dir, delta);
  }

  private updateFacing(dir: THREE.Vector3, delta: number): void {
    const targetFacing = directionToFacingAngle(dir.x, dir.z);
    this.facing = lerpAngle(this.facing, targetFacing, Math.min(1, TURN_RATE_RAD_S * delta));
    this.vrm.scene.rotation.y = this.facing;
  }

  private stepAlong(dir: THREE.Vector3, delta: number): void {
    const step = this.walkSpeedMps * delta;
    // Real bug, found by re-reading the logic against the user's own
    // "collides into walls" report, not guessed: the "arriving" phase
    // above deliberately keeps walking for up to a full gait cycle past
    // WanderController's own arrival point so the stop clip can start on
    // the loop's seam (see WORLD_WALK_STOP_EXIT_PHASE_WINDOW_S) -- but a
    // wander target can legally sit as close as WANDER_MARGIN_M (0.5m)
    // from a wall, and that extra grace stride can cover up to roughly
    // walkSpeedMps * WORLD_WALK_LOOP_DURATION_S (~1.4m) in the worst
    // case. Nothing was stopping that extra distance from carrying her
    // straight through a wall. This clamp is a second, unconditional
    // layer -- independent of any phase-timing subtlety, present or
    // future -- rather than trying to make the phase logic itself aware
    // of room bounds (WanderController's own target-picking already
    // stays clear of the walls; this only guards the *extra* distance
    // the animation-phase system adds on top of that).
    this.moveClamped(dir, step);
    this.walkBoutDistanceM += step;
    this.updateFacing(dir, delta);
  }

  /** Where she's allowed to stand. Injected rather than constructed
   * here because the rect table is the apartment's, and the apartment
   * is built in boot(). Null means "unconstrained", which is what the
   * old code did before any room existed. */
  setWalkableArea(area: WalkableArea): void {
    this.walkable = area;
  }

  /** Advance her position along `dir` by `step`, then pull her back onto
   * walkable floor if that took her off it. */
  private moveClamped(dir: THREE.Vector3, step: number): void {
    const pos = this.vrm.scene.position;
    const nx = pos.x + dir.x * step;
    const nz = pos.z + dir.z * step;
    if (!this.walkable) {
      pos.x = nx;
      pos.z = nz;
      return;
    }
    const safe = this.walkable.clamp(nx, nz);
    pos.x = safe.x;
    pos.z = safe.z;
  }

  private beginWalkStart(): void {
    this.fadeOutIdleBase();
    this.walkBoutDistanceM = 0;
    if (this.walkStartAction) {
      this.walkStartAction.reset().fadeIn(IDLE_CROSSFADE_S).play();
      this.walkPhase = "starting";
      this.walkPhaseTimer = WORLD_WALK_START_DURATION_S;
    } else {
      // No start clip loaded -- skip straight into the loop at its
      // documented entry phase; still phase-correct, just without the
      // wind-up beat.
      this.enterWalkLoop();
    }
  }

  private enterWalkLoop(): void {
    if (this.walkStartAction) this.walkStartAction.fadeOut(IDLE_CROSSFADE_S);
    if (this.walkLoopAction) {
      this.walkLoopAction.reset().play();
      this.walkLoopAction.time = WORLD_WALK_START_ENTRY_PHASE_S;
      this.walkLoopAction.setEffectiveWeight(1);
    }
    this.walkPhase = "looping";
  }

  private atStopExitPhase(): boolean {
    if (!this.walkLoopAction) return true;
    const t = this.walkLoopAction.time % WORLD_WALK_LOOP_DURATION_S;
    const [lo, hi] = WORLD_WALK_STOP_EXIT_PHASE_WINDOW_S;
    return t >= lo || t <= hi;
  }

  private pickStopAction(): THREE.AnimationAction | null {
    if (this.walkBoutDistanceM < WALK_BOUT_SMALL_STOP_THRESHOLD_M && this.walkStopSmallAction) {
      return this.walkStopSmallAction;
    }
    if (this.walkStopActions.length > 0) {
      return this.walkStopActions[Math.floor(Math.random() * this.walkStopActions.length)]!;
    }
    return this.walkStopSmallAction;
  }

  private beginWalkStop(): void {
    const stopAction = this.pickStopAction();
    if (!stopAction) {
      this.endWalk();
      return;
    }
    stopAction.reset().fadeIn(IDLE_CROSSFADE_S).play();
    this.currentStopAction = stopAction;
    if (this.walkLoopAction) this.walkLoopAction.fadeOut(IDLE_CROSSFADE_S);
    this.walkPhase = "stopping";
    this.walkPhaseTimer = this.walkStopDurations.get(stopAction) ?? 1.5;
  }

  private endWalk(): void {
    if (this.currentStopAction) this.currentStopAction.fadeOut(IDLE_CROSSFADE_S);
    this.currentStopAction = null;
    this.walkPhase = "none";
    this.walkBoutDistanceM = 0;
    // currentIdleAction is already null (fadeOutIdleBase ran back in
    // beginWalkStart) -- updateIdleBase picks a fresh one the very next
    // frame since walkPhase is "none" again, no extra bookkeeping needed.
  }

  // --- fallback (no walk pack loaded) -----------------------------------

  private updateFallbackLocomotion(delta: number, target: THREE.Vector3 | null): void {
    let speedFraction = 0;
    if (target) {
      const toTarget = new THREE.Vector3(
        target.x - this.vrm.scene.position.x,
        0,
        target.z - this.vrm.scene.position.z,
      );
      const dist = toTarget.length();
      if (dist > 0.001) {
        const dir = toTarget.clone().normalize();
        speedFraction = Math.min(1, dist / FALLBACK_SLOWDOWN_RADIUS_M);
        const step = Math.min(dist, FALLBACK_WALK_SPEED_MPS * speedFraction * delta);
        // Same defensive clamp as stepAlong() above -- this path eases to a
        // stop on its own and doesn't have the "arriving" phase's overshoot
        // risk, but there's no reason to leave it unguarded either.
        this.moveClamped(dir, step);
        this.updateFacing(dir, delta);
      }
    }
    this.walker.update(delta, speedFraction);
    // No start/stop clips to sequence without the real pack -- this is
    // just a binary flag here, unlike the five-state machine above.
    if (target && this.walkPhase === "none") this.fadeOutIdleBase();
    this.walkPhase = target ? "looping" : "none";
  }

  // --- idle base variety -------------------------------------------------

  private fadeOutIdleBase(): void {
    if (this.currentIdleAction) {
      this.currentIdleAction.fadeOut(IDLE_CROSSFADE_S);
      this.currentIdleAction = null;
    }
  }

  private updateIdleBase(delta: number, isTalking: boolean): void {
    if (this.walkPhase !== "none") return; // walking (any sub-phase) owns the body
    const pool = isTalking ? this.idleTalkingActions : this.idleBaseActions;
    if (pool.length === 0) return; // nothing loaded for this pool -- leaves whatever pose she's already in, same as before this round
    const poolChanged = this.currentIdleIsTalking !== isTalking;
    this.idleVarietyElapsed += delta;
    if (!this.currentIdleAction || poolChanged || this.idleVarietyElapsed >= this.idleVarietyNextAt) {
      this.pickNewIdle(pool, isTalking);
    }
  }

  private pickNewIdle(pool: THREE.AnimationAction[], isTalking: boolean): void {
    const next = pool[Math.floor(Math.random() * pool.length)]!;
    const [min, max] = isTalking
      ? [IDLE_TALKING_VARIETY_MIN_S, IDLE_TALKING_VARIETY_MAX_S]
      : [IDLE_VARIETY_MIN_S, IDLE_VARIETY_MAX_S];
    if (next === this.currentIdleAction) {
      // Redrawn the same clip by chance -- just re-roll the timer rather
      // than restarting a loop that's already playing (a reset() here
      // would pop back to frame 0 for no visible reason).
      this.idleVarietyElapsed = 0;
      this.idleVarietyNextAt = min + Math.random() * (max - min);
      return;
    }
    if (this.currentIdleAction) this.currentIdleAction.fadeOut(IDLE_CROSSFADE_S);
    next.reset().fadeIn(IDLE_CROSSFADE_S).play();
    this.currentIdleAction = next;
    this.currentIdleIsTalking = isTalking;
    this.idleVarietyElapsed = 0;
    this.idleVarietyNextAt = min + Math.random() * (max - min);
  }
}


/** Scratch vectors for the per-frame look-at maths, so the hot loop
 * doesn't allocate. */
const TMP_HEAD = new THREE.Vector3();
const TMP_TO_CAM = new THREE.Vector3();
const TMP_FLAT = new THREE.Vector3();
const TMP_AHEAD = new THREE.Vector3();
const LOOK_BLEND = { value: 0 };

const ROOM_LABELS: Record<string, string> = {
  living: "the living room",
  kitchen: "the kitchen",
  hall: "the hallway",
  bedroom: "her bedroom",
  bathroom: "the bathroom",
};

function isTypingTarget(el: Element | null): boolean {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}

/**
 * Build the scene controls in the info panel: time of day, camera mode, and
 * render quality. All three are generated from the lists their owning module
 * exports, so adding a time of day or a quality tier needs no change here.
 */
interface SceneControls {
  syncCamera(): void;
}

function setupSceneControls(
  apartment: ApartmentHandle,
  postfx: PostFX,
  rig: CameraRig,
): SceneControls {
  const host = document.getElementById("sandbox-modes");
  const noop: SceneControls = { syncCamera: () => {} };
  if (!host) return noop;

  const row = (label: string): HTMLDivElement => {
    const d = document.createElement("div");
    d.className = "sandbox-ctl-row";
    const l = document.createElement("span");
    l.className = "sandbox-ctl-label";
    l.textContent = label;
    d.appendChild(l);
    host.appendChild(d);
    return d;
  };

  // --- time of day ---------------------------------------------------------
  const todRow = row("time");
  const todBtns = new Map<TimeOfDay, HTMLButtonElement>();
  const refreshTod = (): void => {
    for (const [m, b] of todBtns) b.classList.toggle("active", m === apartment.timeOfDay());
  };
  for (const m of TIMES_OF_DAY) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = m;
    b.addEventListener("click", () => {
      apartment.setTimeOfDay(m);
      refreshTod();
    });
    todBtns.set(m, b);
    todRow.appendChild(b);
  }
  refreshTod();

  // --- camera mode ---------------------------------------------------------
  const camRow = row("view");
  const camBtns = new Map<CameraMode, HTMLButtonElement>();
  const refreshCam = (): void => {
    for (const [m, b] of camBtns) b.classList.toggle("active", m === rig.mode());
  };
  for (const [m, text] of [["spectator", "spectate"], ["visitor", "walk in"]] as const) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.addEventListener("click", () => {
      rig.setMode(m);
      refreshCam();
    });
    camBtns.set(m, b);
    camRow.appendChild(b);
  }
  refreshCam();

  // --- quality -------------------------------------------------------------
  const qRow = row("render");
  const qBtns = new Map<Quality, HTMLButtonElement>();
  const refreshQ = (): void => {
    for (const [q, b] of qBtns) b.classList.toggle("active", q === postfx.quality());
  };
  for (const q of QUALITIES) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = q;
    b.addEventListener("click", () => {
      postfx.setQuality(q);
      refreshQ();
    });
    qBtns.set(q, b);
    qRow.appendChild(b);
  }
  refreshQ();

  // Tab toggles the camera mode without reaching for the panel, since that's
  // the control you actually want while you're walking around.
  window.addEventListener("keydown", (e) => {
    if (e.code !== "Tab" || isTypingTarget(document.activeElement)) return;
    e.preventDefault();
    rig.setMode(rig.mode() === "spectator" ? "visitor" : "spectator");
    refreshCam();
  });

  return { syncCamera: refreshCam };
}

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------
async function boot(): Promise<void> {
  const canvas = document.getElementById("sandbox-canvas") as HTMLCanvasElement;
  const statusEl = document.getElementById("sandbox-status") as HTMLDivElement;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  // VSM gives genuinely soft shadow edges rather than PCF's fixed 3x3 tap,
  // which matters a lot indoors where every shadow is a soft one cast by a
  // window or a lampshade. It needs the higher normalBias set on the sun in
  // apartment/index.ts to avoid light leaking through thin geometry.
  renderer.shadowMap.type = THREE.VSMShadowMap;
  // Filmic response curve. Without this the bright window panels clip to
  // flat white and the night lamps read as grey, because the default
  // (linear) mapping has no highlight rolloff at all.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  // Fog has to exist up front for the lighting modes to drive it; its
  // colour and distances are overwritten immediately by the initial mode.
  scene.fog = new THREE.Fog(0xc9e0f2, 22, 70);

  const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.05, 160);
  const apartment = buildApartment(scene, renderer);

  const postfx = createPostFX(renderer, scene, camera, "high");

  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  loader.register((parser) => new VRMAnimationLoaderPlugin(parser));

  const gltf = await loader.loadAsync(MODEL_PATH);
  const vrm: VRM = gltf.userData.vrm;
  VRMUtils.rotateVRM0(vrm);
  VRMUtils.combineSkeletons(vrm.scene);
  VRMUtils.combineMorphs(vrm);
  applyRestPose(vrm);
  // Spawn at a named anchor rather than a bare coordinate, so re-laying out
  // the apartment moves her with it instead of stranding her in a wall.
  const sofaAnchor = ANCHORS.find((a) => a.id === "sofa") ?? ANCHORS[0];
  vrm.scene.position.set(sofaAnchor.x, 0, sofaAnchor.z);
  vrm.scene.rotation.y = sofaAnchor.facing;
  scene.add(vrm.scene);
  // She casts real shadows now that the room has real lights.
  vrm.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.castShadow = true;
      m.receiveShadow = false; // MToon + received shadow maps reads muddy
    }
  });
  const contactShadow = buildContactShadow();
  scene.add(contactShadow);

  // --- she looks at you ----------------------------------------------------
  // VRM ships a lookAt rig; pointing it at a target object makes her track
  // it with eyes and (via the humanoid) a little head turn. This is the
  // single cheapest thing in the whole build for making her feel present
  // rather than animated, so it's wired straight to the camera: whichever
  // mode you're in, if you're close enough and roughly in front of her, she
  // notices you. `autoUpdate` off so we only apply it when we want it.
  const lookTarget = new THREE.Object3D();
  scene.add(lookTarget);
  if (vrm.lookAt) {
    vrm.lookAt.target = lookTarget;
    vrm.lookAt.autoUpdate = true;
  }

  function layout(): void {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    postfx.setSize(window.innerWidth, window.innerHeight);
  }
  layout();
  window.addEventListener("resize", layout);

  // Blink loop -- same minimal treatment as main.ts's, duplicated for the
  // same isolation reason as applyRestPose above. The rest of her
  // expressions (the six emotion presets, driven by whatever she says)
  // are wired up in sandbox-hud.ts instead, alongside the chat/caption
  // UI -- see setupSandboxHud().
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
    vrm.expressionManager.setValue("blink", t < 0.5 ? t * 2 : (1 - t) * 2);
  }

  // Best-effort load throughout this section -- see loadClip's own
  // comment above. A missing file just means that one clip/gesture/idle
  // pose never registers, not a boot failure.
  const walkLoopClip = await loadClip(loader, vrm, WORLD_WALK_LOOP_FILE);
  const walkStartClip = await loadClip(loader, vrm, WORLD_WALK_START_FILE);
  const walkStopClips: Array<{ clip: THREE.AnimationClip; durationS: number }> = [];
  for (const { file, durationS } of WORLD_WALK_STOP_FILES) {
    const clip = await loadClip(loader, vrm, file);
    if (clip) walkStopClips.push({ clip, durationS });
  }
  const walkStopSmallClip = await loadClip(loader, vrm, WORLD_WALK_STOP_SMALL_FILE);

  const character = new CharacterController(vrm, {
    walkLoop: walkLoopClip,
    walkStart: walkStartClip,
    walkStops: walkStopClips,
    walkStopSmall: walkStopSmallClip
      ? { clip: walkStopSmallClip, durationS: WORLD_WALK_STOP_SMALL_DURATION_S }
      : null,
  });

  for (const [name, filename] of Object.entries(GESTURE_CLIP_FILES)) {
    const clip = await loadClip(loader, vrm, filename);
    if (clip) character.registerGesture(name, clip);
  }
  for (const filename of IDLE_BASE_FILES) {
    const clip = await loadClip(loader, vrm, filename);
    if (clip) character.registerIdleBase(clip, false);
  }
  for (const filename of IDLE_TALKING_FILES) {
    const clip = await loadClip(loader, vrm, filename);
    if (clip) character.registerIdleBase(clip, true);
  }

  const walkable = new WalkableArea(apartment.patches);
  const wander = new WanderController(apartment.patches, vrm.scene.position);
  character.setWalkableArea(walkable);

  // Spectator starts just inside the hallway looking down the flat, which
  // shows off the sightline through to the living room. Visitor mode drops
  // you at the front door -- you arrive like a guest.
  camera.position.set(CENTRE.x + 0.4, 1.65, CENTRE.z + 3.4);
  const rig = createCameraRig(camera, renderer.domElement, walkable, {
    x: 9.4, z: 5.85, yaw: Math.PI / 2,
  });
  const idleGestures = new IdleGestureScheduler();
  const hudControls = setupSceneControls(apartment, postfx, rig);
  statusEl.textContent = character.usingRealWalk
    ? `Model loaded · real walk cycle · ${character.idleBaseCount} idle pose(s) · ${character.gestureCount} gesture(s) loaded`
    : `Model loaded · procedural walk (world-walk.vrma not found in public/vrm-animations/) · ${character.idleBaseCount} idle pose(s) · ${character.gestureCount} gesture(s) loaded`;

  // Full chat/caption/mic HUD -- connects to the same orchestrator
  // main.ts does, identifying itself as "sandbox" so the two windows
  // don't both try to drive a conversation at once. See
  // src/sandbox-hud.ts and ws-client.ts's/app.py's surface_status
  // handling. onEmotion fires once per whole turn (same turn_end signal
  // the facial blend already reacts to, see setupSandboxHud's own
  // comment) and triggers the matching one-shot body gesture, if
  // GESTURE_FOR_EMOTION has an entry for it and that gesture actually
  // loaded above -- both silently no-op otherwise.
  const hud = setupSandboxHud(vrm, {
    onEmotion: (emotion) => {
      if (!emotion) return;
      const gestureName = GESTURE_FOR_EMOTION[emotion];
      if (gestureName) character.playGesture(gestureName);
    },
  });

  // --- scene awareness -----------------------------------------------------
  // Round 7's plan point 4, finally wired: tell the orchestrator where she
  // is and what's around her in plain text, so anything she says about the
  // flat comes from the app knowing, not the model guessing. Only pushed on
  // change and at most every couple of seconds -- this is context, not
  // telemetry, and a message per frame would be useless and expensive.
  let lastStateKey = "";
  let stateTimer = 0;
  function pushSceneState(dt: number): void {
    stateTimer += dt;
    if (stateTimer < 2) return;
    stateTimer = 0;
    const s = apartment.describe(vrm.scene.position, rig.visitorPosition(), rig.mode() === "visitor");
    const key = `${s.room}|${s.at}|${s.timeOfDay}|${s.visitorRoom}|${s.visitorPresent}`;
    if (key === lastStateKey) return;
    lastStateKey = key;
    const parts = [`Luna is in ${s.roomLabel}`];
    if (s.at) parts.push(`(${s.at})`);
    parts.push(`It is ${s.timeOfDay}.`);
    if (s.visitorPresent) {
      const sameRoom = s.visitorRoom === s.room;
      parts.push(sameRoom
        ? "You are in the room with her."
        : `You are in ${ROOM_LABELS[s.visitorRoom ?? "hall"]}.`);
    }
    hud.sendSceneState(parts.join(" "));
  }

  const clock = new THREE.Clock();
  function animate(): void {
    requestAnimationFrame(animate);
    const delta = clock.getDelta();
    rig.update(delta);
    updateBlink(delta);
    hud.tick(delta);
    const target = wander.getTarget(delta, vrm.scene.position, hud.isTurnActive());
    character.update(delta, target, hud.isTurnActive());
    // Eligible only once everything else has had first say this frame:
    // not walking anywhere (target is null AND she's not still finishing
    // a stride/start/stop -- see CharacterController.isWalking), not
    // mid-turn, and not already gesturing (character.update() just above
    // may have moved an emotion-triggered gesture through hold/fade, so
    // this reads its post-update state).
    idleGestures.update(
      delta,
      target === null && !character.isWalking && !hud.isTurnActive() && !character.isGesturing,
      (name) => character.playGesture(name),
    );
    // Doors open for whoever is closest to them -- her while she's walking a
    // route, or you when you're the one in the flat.
    const doorSubject = rig.mode() === "visitor"
      ? (rig.visitorPosition() ?? vrm.scene.position)
      : vrm.scene.position;
    apartment.update(delta, clock.elapsedTime, doorSubject);

    // --- she notices you ---------------------------------------------------
    // Track the camera when it's near her and roughly in front; otherwise
    // let her look where she's going. The dot-product gate matters: without
    // it she cranes round to stare at a camera behind her head, which reads
    // as creepy rather than attentive.
    const head = vrm.humanoid?.getNormalizedBoneNode("head");
    if (head) {
      head.getWorldPosition(TMP_HEAD);
      TMP_TO_CAM.copy(camera.position).sub(TMP_HEAD);
      const dist = TMP_TO_CAM.length();
      const facing = new THREE.Vector3(Math.sin(vrm.scene.rotation.y), 0, Math.cos(vrm.scene.rotation.y));
      TMP_FLAT.set(TMP_TO_CAM.x, 0, TMP_TO_CAM.z).normalize();
      const inFront = facing.dot(TMP_FLAT);
      const wantsToLook = dist < 5.5 && inFront > -0.15 && !character.isWalking;
      LOOK_BLEND.value = THREE.MathUtils.lerp(LOOK_BLEND.value, wantsToLook ? 1 : 0, Math.min(1, 2.6 * delta));
      // Blend between "looking at you" and a neutral point ahead of her.
      TMP_AHEAD.copy(TMP_HEAD).addScaledVector(facing, 2.2);
      lookTarget.position.lerpVectors(TMP_AHEAD, camera.position, LOOK_BLEND.value);
    }

    contactShadow.position.x = vrm.scene.position.x;
    contactShadow.position.z = vrm.scene.position.z;
    vrm.update(delta);

    postfx.setBloom(apartment.bloomStrength());
    renderer.toneMappingExposure = apartment.exposure();
    pushSceneState(delta);
    postfx.render(delta);
  }
  hudControls.syncCamera();
  animate();
}

boot().catch((err) => {
  console.error("[luna-sandbox] failed to boot", err);
  const statusEl = document.getElementById("sandbox-status");
  if (statusEl) statusEl.textContent = `Failed to load: ${(err as Error).message ?? err}`;
});
