import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";
import { VRMAnimationLoaderPlugin, createVRMAnimationClip, type VRMAnimation } from "@pixiv/three-vrm-animation";
import { setupSandboxHud } from "./sandbox-hud";

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
const WALL_CLEARANCE_M = 0.3; // hard position clamp, independent of any locomotion timing -- see stepAlong()'s own comment for why this exists as a second, unconditional layer rather than trusting the arrival-phase timing alone
const ARRIVE_RADIUS_M = 0.08; // "close enough" to a wander target for WanderController to call it arrived

// ---------------------------------------------------------------------
// Room -- a real bounded box now (floor + four walls + ceiling), not an
// infinite fog-faded void; see buildStudio()'s own comment. Half-size in
// meters from the room's center to a wall.
// ---------------------------------------------------------------------
const ROOM_HALF_SIZE = 4.5;
const ROOM_HEIGHT = 3.2;
const WANDER_MARGIN_M = 0.5; // keeps her from wandering right up against a wall

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

// ---------------------------------------------------------------------
// Studio environment: a plain white *box*, per the brief -- floor, four
// walls, and a ceiling, all at ROOM_HALF_SIZE/ROOM_HEIGHT, no fog and no
// background gradient standing in for a horizon. Earlier draft of this
// file used scene.fog to fade a much larger floor into the white
// background at a distance, reading as an unbounded void -- replaced
// outright, not just tuned down, since the brief was explicit that it's
// supposed to read as a box, not an infinite plane. Choosing an actual
// *decorated* room / selectable backgrounds is still the *other* half of
// ROADMAP.md's Phase 10 entry, deliberately not this file's job -- see
// docs/DECISIONS.md.
// ---------------------------------------------------------------------
// Objects on this layer (in addition to their default layer 0) are lit
// by roomFillLight below, on top of whatever the default-layer
// keyLight/HemisphereLight already contribute -- room geometry only
// (floor/walls/ceiling/grid), never the character (vrm.scene, added
// separately in boot(), is never given this layer). See roomFillLight's
// own comment for why this exists as a separate light+layer rather than
// just turning the existing lights up.
const ROOM_LIGHT_LAYER = 1;

function buildStudio(scene: THREE.Scene): void {
  scene.background = new THREE.Color(0xffffff);

  const size = ROOM_HALF_SIZE * 2;
  const wallMat = new THREE.MeshStandardMaterial({
    color: 0xf5f5f7,
    roughness: 0.95,
    metalness: 0,
    side: THREE.DoubleSide, // visible from outside the box too, since the free-fly camera isn't confined to its interior
  });
  const floorMat = new THREE.MeshStandardMaterial({ color: 0xefeff2, roughness: 0.95, metalness: 0, side: THREE.DoubleSide });

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(size, size), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.layers.enable(ROOM_LIGHT_LAYER);
  scene.add(floor);

  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(size, size), wallMat);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = ROOM_HEIGHT;
  ceiling.layers.enable(ROOM_LIGHT_LAYER);
  scene.add(ceiling);

  const wallGeo = new THREE.PlaneGeometry(size, ROOM_HEIGHT);
  const north = new THREE.Mesh(wallGeo, wallMat);
  north.position.set(0, ROOM_HEIGHT / 2, -ROOM_HALF_SIZE);
  north.layers.enable(ROOM_LIGHT_LAYER);
  scene.add(north);
  const south = new THREE.Mesh(wallGeo, wallMat);
  south.position.set(0, ROOM_HEIGHT / 2, ROOM_HALF_SIZE);
  south.rotation.y = Math.PI;
  south.layers.enable(ROOM_LIGHT_LAYER);
  scene.add(south);
  const east = new THREE.Mesh(wallGeo, wallMat);
  east.position.set(ROOM_HALF_SIZE, ROOM_HEIGHT / 2, 0);
  east.rotation.y = -Math.PI / 2;
  east.layers.enable(ROOM_LIGHT_LAYER);
  scene.add(east);
  const west = new THREE.Mesh(wallGeo, wallMat);
  west.position.set(-ROOM_HALF_SIZE, ROOM_HEIGHT / 2, 0);
  west.rotation.y = Math.PI / 2;
  west.layers.enable(ROOM_LIGHT_LAYER);
  scene.add(west);

  // Faint floor grid, just enough to read depth/scale on an otherwise
  // featureless white floor.
  const grid = new THREE.GridHelper(size, 12, 0xd6d6da, 0xe9e9ec);
  const gridMat = grid.material as THREE.Material;
  gridMat.transparent = true;
  gridMat.opacity = 0.7;
  grid.position.y = 0.002; // avoid z-fighting with the floor plane
  grid.layers.enable(ROOM_LIGHT_LAYER);
  scene.add(grid);

  // Lighting: fixed in world space (a small overhead-front rig, like a
  // real photography softbox), not tied to the camera -- the camera is
  // now a free-flying spectator that can end up anywhere, so a
  // camera-relative light (the previous draft's approach) would swing
  // wildly as it moved. A DirectionalLight has no falloff/position
  // dependence for what it lights (only its angle matters), so it stays
  // correct as she wanders around the room too.
  //
  // Intensities and the hemisphere's colors were both turned down/
  // neutralized from the previous draft to fix a flat gray sheen washing
  // out the jacket -- MToon's toon shading reads its own lit/shadow bands
  // from the light direction, and too much ambient/hemisphere fill (plus
  // the previous draft's slightly blue-gray hemisphere ground color)
  // flattens those bands into a uniform gray wash instead of a clean
  // highlight/shadow split. Same underlying cause as the "jacket
  // artifact" DECISIONS.md entry from Phase 7, same style of fix (reduce
  // fill, don't fight MToon's own shading model) -- not independently
  // re-verified against a real render here either, for the same reason
  // Phase 7's wasn't: no GPU/browser in this sandbox. See
  // docs/DECISIONS.md. These two stay on the default layer (0), so they
  // keep lighting the character exactly as before -- untouched by the
  // brightening below.
  const keyLight = new THREE.DirectionalLight(0xffffff, 0.55);
  keyLight.position.set(1.5, ROOM_HEIGHT * 0.9, 2.5);
  scene.add(keyLight);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xf3f3f3, 0.5));

  // Room-only brightening ("light the box up" -- the walls/floor above
  // are specified near-white, 0xf5f5f7/0xefeff2, but at the intensities
  // above (tuned down specifically to protect the character's MToon
  // shading, see the comment just above) they were reading as flat
  // medium gray in every screenshot so far rather than actually
  // near-white. Simply turning the existing lights up would brighten the
  // room but risks reintroducing exactly the "flat gray wash" character
  // artifact those intensities were deliberately lowered to fix. Layers
  // sidestep that tradeoff instead of trying to balance it: this light
  // only affects objects explicitly enabled on ROOM_LIGHT_LAYER above
  // (floor/walls/ceiling/grid) -- the character, added on the default
  // layer only in boot(), is entirely unaffected by it. Untested
  // visually, same as the rest of this function -- no GPU/browser in
  // this sandbox -- but logically it can only brighten room geometry,
  // never the character, regardless of how the intensity below is tuned.
  const roomFillLight = new THREE.HemisphereLight(0xffffff, 0xe4e4e8, 0.9);
  roomFillLight.layers.set(ROOM_LIGHT_LAYER);
  scene.add(roomFillLight);
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
const IDLE_MIN_S = 3;
const IDLE_MAX_S = 8;

class WanderController {
  private target: THREE.Vector3 | null = null;
  private idleUntil = 0;
  private elapsed = 0;
  private readonly bound: number;

  constructor(bound: number) {
    this.bound = bound;
  }

  /** Returns where she should currently be walking toward, or null if
   * she should just stand where she is. `paused` (true while a
   * conversation turn is in flight -- see sandbox.ts's boot()) freezes
   * the decision clock rather than picking a new destination while
   * she's meant to be standing and talking; an already-in-progress walk
   * is allowed to finish reaching its target rather than snapping to a
   * halt mid-stride. */
  getTarget(delta: number, currentPos: THREE.Vector3, paused: boolean): THREE.Vector3 | null {
    if (this.target) {
      const dist = flatDistance(currentPos, this.target);
      if (dist < ARRIVE_RADIUS_M) {
        this.target = null;
        this.idleUntil = this.elapsed + IDLE_MIN_S + Math.random() * (IDLE_MAX_S - IDLE_MIN_S);
      } else {
        return this.target;
      }
    }
    if (paused) return null;
    this.elapsed += delta;
    if (this.elapsed >= this.idleUntil) {
      this.target = this.pickPoint();
      return this.target;
    }
    return null;
  }

  private pickPoint(): THREE.Vector3 {
    const r = this.bound;
    return new THREE.Vector3((Math.random() * 2 - 1) * r, 0, (Math.random() * 2 - 1) * r);
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

// EXPERIMENTAL FLIP (round 6, second attempt): the facing/travel
// diagnostic above proved facing and travel direction always agreed
// with each other -- but that only proves self-consistency, not that
// the underlying "-Z is forward" assumption it (and updateFacing()) was
// built on is actually correct. If that assumption is backward for this
// model, both sides of the comparison shift together and still match,
// while she visually faces opposite her travel direction the entire
// time -- a blind spot the diagnostic can't see past, since it checks
// this formula against itself, not against the rendered result. The
// user asked to just try flipping it and confirm by eye, since it's a
// one-line, trivially-revertible change (`git restore` back to the
// unflipped version if this makes it worse instead of better -- see
// docs/DECISIONS.md for exactly which commit that is). Was
// `Math.atan2(-x, -z)`; every direction-to-angle conversion in
// CharacterController now goes through this one function so there's
// only one sign to flip back if this guess is wrong.
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

  // TEMPORARY diagnostic fields -- see debugFootTraceText's own comment
  // below for what these are for.
  private readonly leftFootBone: THREE.Object3D | null;
  private readonly rightFootBone: THREE.Object3D | null;
  private footTraceTimer = 0;
  private footTraceMinL = Infinity;
  private footTraceMaxL = -Infinity;
  private footTraceMinR = Infinity;
  private footTraceMaxR = -Infinity;
  private footTraceText: string | null = null;

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
    this.leftFootBone = vrm.humanoid.getRawBoneNode("leftFoot");
    this.rightFootBone = vrm.humanoid.getRawBoneNode("rightFoot");

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

  private debugPrevPos: THREE.Vector3 | null = null;

  /** TEMPORARY diagnostic, not a permanent feature -- added specifically
   * to chase the user's repeated "walks backward" report after the
   * facing formula (see updateFacing()) was re-derived and checked twice
   * with no error found. Compares `facing` (what updateFacing() computed
   * and applied to vrm.scene.rotation.y) against the direction she
   * *actually* moved this frame, independently computed straight from
   * the raw position delta -- ground truth, untainted by any of this
   * class's own bookkeeping (walkDir etc.), using the exact same
   * atan2(-x,-z) convention updateFacing() uses, so a correctly-behaving
   * frame reports two matching numbers. Null whenever she's not actually
   * translating (nothing useful to compare yet).
   *
   * ROUND 6 RESULT (from the user's own screenshot): facing 417°
   * (= 57° mod 360) vs travel 58° -- a 1° difference, i.e. these already
   * match. This rules out a facing/direction inversion entirely --
   * flipping the formula would introduce a real bug where there
   * currently isn't one. The "moonwalk" look must be a different kind of
   * problem (foot-plant/gait quality, not direction) -- see
   * debugFootTraceText below, added specifically because of this result.
   *
   * Remove this getter and its boot()-side readout once the actual bug
   * is found -- see docs/DECISIONS.md.
   */
  get debugFacingTravelText(): string | null {
    if (this.walkPhase !== "looping" && this.walkPhase !== "arriving") {
      this.debugPrevPos = null;
      return null;
    }
    const pos = this.vrm.scene.position;
    if (!this.debugPrevPos) {
      this.debugPrevPos = pos.clone();
      return null;
    }
    const movedX = pos.x - this.debugPrevPos.x;
    const movedZ = pos.z - this.debugPrevPos.z;
    this.debugPrevPos.set(pos.x, pos.y, pos.z);
    if (movedX * movedX + movedZ * movedZ < 1e-10) return null;
    const facingDeg = ((this.facing * 180) / Math.PI).toFixed(0);
    const travelDeg = ((directionToFacingAngle(movedX, movedZ) * 180) / Math.PI).toFixed(0);
    return `[debug] facing ${facingDeg}° · travel ${travelDeg}° (should match; ~180° apart = inverted; anything else = a different axis mixup)`;
  }

  /** TEMPORARY diagnostic, round 6 addition -- direction is confirmed
   * correct (see debugFacingTravelText's own result above), so "moonwalk"
   * must be a foot-plant/gait problem instead: something that would make
   * a foot look like it's sliding along the ground rather than lifting
   * and resetting between steps, independent of which way she's actually
   * heading. Samples each foot bone's real world-space height (not
   * anything retargeted or computed -- the actual bone the mixer is
   * driving) once a frame, and reports the min/max range it swept over
   * roughly every 1.5s. A healthy walk cycle should show both feet
   * regularly sweeping through a real range (one foot planted near its
   * low point while the other arcs up mid-swing, alternating); a foot
   * stuck at a near-zero range for a stretch means it's dragging instead
   * of lifting -- direct, numeric evidence instead of eyeballing a still
   * image, which can't show a fundamentally time-based artifact like
   * sliding at all. Remove alongside debugFacingTravelText once resolved. */
  get debugFootTraceText(): string | null {
    return this.footTraceText;
  }

  private updateFootTrace(delta: number): void {
    if (!this.leftFootBone || !this.rightFootBone) return;
    if (this.walkPhase !== "looping" && this.walkPhase !== "arriving") {
      this.footTraceText = null;
      return;
    }
    const lp = new THREE.Vector3();
    this.leftFootBone.getWorldPosition(lp);
    const rp = new THREE.Vector3();
    this.rightFootBone.getWorldPosition(rp);
    this.footTraceMinL = Math.min(this.footTraceMinL, lp.y);
    this.footTraceMaxL = Math.max(this.footTraceMaxL, lp.y);
    this.footTraceMinR = Math.min(this.footTraceMinR, rp.y);
    this.footTraceMaxR = Math.max(this.footTraceMaxR, rp.y);
    this.footTraceTimer += delta;
    if (this.footTraceTimer < 1.5) return;
    const lRange = this.footTraceMaxL - this.footTraceMinL;
    const rRange = this.footTraceMaxR - this.footTraceMinR;
    this.footTraceText = `[debug] L foot y-range ${lRange.toFixed(3)}m (${this.footTraceMinL.toFixed(3)}-${this.footTraceMaxL.toFixed(3)}) · R foot y-range ${rRange.toFixed(3)}m (${this.footTraceMinR.toFixed(3)}-${this.footTraceMaxR.toFixed(3)}) -- a healthy stride should show both well above ~0.02m; a foot stuck near its minimum is dragging`;
    this.footTraceTimer = 0;
    this.footTraceMinL = Infinity;
    this.footTraceMaxL = -Infinity;
    this.footTraceMinR = Infinity;
    this.footTraceMaxR = -Infinity;
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
    // Sampled after mixer.update() so the foot bones reflect this frame's
    // actual applied pose, not last frame's.
    this.updateFootTrace(delta);
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
    const clamp = ROOM_HALF_SIZE - WALL_CLEARANCE_M;
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
    this.vrm.scene.position.x = Math.min(clamp, Math.max(-clamp, this.vrm.scene.position.x + dir.x * step));
    this.vrm.scene.position.z = Math.min(clamp, Math.max(-clamp, this.vrm.scene.position.z + dir.z * step));
    this.walkBoutDistanceM += step;
    this.updateFacing(dir, delta);
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
        const clamp = ROOM_HALF_SIZE - WALL_CLEARANCE_M; // same defensive clamp as stepAlong() above -- this path eases to a stop on its own and doesn't have the "arriving" phase's overshoot risk, but there's no reason to leave it unguarded either
        this.vrm.scene.position.x = Math.min(clamp, Math.max(-clamp, this.vrm.scene.position.x + dir.x * step));
        this.vrm.scene.position.z = Math.min(clamp, Math.max(-clamp, this.vrm.scene.position.z + dir.z * step));
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

// ---------------------------------------------------------------------
// Fly camera: a free spectator camera, not tied to the character at all
// -- per the brief, the person watching is a spectator here, not a
// controller of anything. WASD flies (full 3D, relative to wherever the
// camera is currently looking), Space/Shift move purely vertically,
// right-drag looks around in place, middle-drag pans, scroll adjusts fly
// speed. Deliberately not three/examples/jsm/controls/OrbitControls.js
// (the previous draft's choice) -- OrbitControls always orbits *around a
// target point*, which is the wrong shape entirely for "fly anywhere and
// look around freely."
// ---------------------------------------------------------------------
const LOOK_SENSITIVITY = 0.0028;
const PAN_SENSITIVITY = 0.0022;
const PITCH_LIMIT = Math.PI / 2 - 0.01;
const BASE_FLY_SPEED = 2.2; // m/s
const MIN_FLY_SPEED = 0.4;
const MAX_FLY_SPEED = 12;

class FlyCamera {
  private yaw: number;
  private pitch: number;
  private speed = BASE_FLY_SPEED;
  private rotating = false;
  private panning = false;
  private readonly keys = new Set<string>();

  constructor(
    private camera: THREE.PerspectiveCamera,
    private dom: HTMLElement,
    initialYaw: number,
    initialPitch: number,
  ) {
    this.yaw = initialYaw;
    this.pitch = initialPitch;
    this.camera.rotation.order = "YXZ";

    // Right-click is "look around," not the browser's context menu.
    this.dom.addEventListener("contextmenu", (e) => e.preventDefault());
    this.dom.addEventListener("mousedown", this.onMouseDown);
    window.addEventListener("mousemove", this.onMouseMove);
    window.addEventListener("mouseup", this.onMouseUp);
    this.dom.addEventListener("wheel", this.onWheel, { passive: false });
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
  }

  private onMouseDown = (e: MouseEvent): void => {
    if (e.button === 2) this.rotating = true;
    else if (e.button === 1) {
      this.panning = true;
      e.preventDefault(); // stops the browser's middle-click autoscroll cursor from appearing
    }
  };

  private onMouseUp = (e: MouseEvent): void => {
    if (e.button === 2) this.rotating = false;
    if (e.button === 1) this.panning = false;
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (this.rotating) {
      this.yaw -= e.movementX * LOOK_SENSITIVITY;
      this.pitch -= e.movementY * LOOK_SENSITIVITY;
      this.pitch = THREE.MathUtils.clamp(this.pitch, -PITCH_LIMIT, PITCH_LIMIT);
    } else if (this.panning) {
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
      this.camera.position.addScaledVector(right, -e.movementX * PAN_SENSITIVITY);
      this.camera.position.addScaledVector(up, e.movementY * PAN_SENSITIVITY);
    }
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.speed = THREE.MathUtils.clamp(this.speed * (e.deltaY < 0 ? 1.12 : 0.89), MIN_FLY_SPEED, MAX_FLY_SPEED);
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    // While the chat input (or anything else) is focused, WASD/space
    // should type/scroll normally, not fly the camera.
    if (isTypingTarget(document.activeElement)) return;
    this.keys.add(e.key.toLowerCase());
    if (e.key === " ") e.preventDefault(); // stop the page from scrolling / re-clicking a focused button
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.key.toLowerCase());
  };

  update(delta: number): void {
    this.camera.rotation.set(this.pitch, this.yaw, 0, "YXZ");

    if (!isTypingTarget(document.activeElement)) {
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
      const move = new THREE.Vector3();
      if (this.keys.has("w") || this.keys.has("arrowup")) move.add(forward);
      if (this.keys.has("s") || this.keys.has("arrowdown")) move.sub(forward);
      if (this.keys.has("a") || this.keys.has("arrowleft")) move.sub(right);
      if (this.keys.has("d") || this.keys.has("arrowright")) move.add(right);
      if (move.lengthSq() > 0) move.normalize().multiplyScalar(this.speed * delta);
      this.camera.position.add(move);

      if (this.keys.has(" ")) this.camera.position.y += this.speed * delta;
      if (this.keys.has("shift")) this.camera.position.y -= this.speed * delta;
    }
  }
}

function isTypingTarget(el: Element | null): boolean {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------
async function boot(): Promise<void> {
  const canvas = document.getElementById("sandbox-canvas") as HTMLCanvasElement;
  const statusEl = document.getElementById("sandbox-status") as HTMLDivElement;

  // TEMPORARY diagnostic elements -- see CharacterController's
  // debugFacingTravelText / debugFootTraceText getters for what these
  // show and why. Remove all three once the "walks backward" report is
  // actually resolved.
  const debugEl = document.createElement("div");
  debugEl.style.cssText =
    "position:fixed;left:8px;bottom:8px;font:11px monospace;color:#0f0;background:rgba(0,0,0,0.6);padding:4px 8px;border-radius:4px;z-index:1000;";
  document.body.appendChild(debugEl);
  const footTraceEl = document.createElement("div");
  footTraceEl.style.cssText =
    "position:fixed;left:8px;bottom:34px;font:11px monospace;color:#0f0;background:rgba(0,0,0,0.6);padding:4px 8px;border-radius:4px;z-index:1000;";
  document.body.appendChild(footTraceEl);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.setSize(window.innerWidth, window.innerHeight);

  const scene = new THREE.Scene();
  buildStudio(scene);

  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.05, 60);
  camera.position.set(0, 1.5, 3.2);
  const flyCamera = new FlyCamera(camera, renderer.domElement, Math.PI, -0.08);

  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  loader.register((parser) => new VRMAnimationLoaderPlugin(parser));

  const gltf = await loader.loadAsync(MODEL_PATH);
  const vrm: VRM = gltf.userData.vrm;
  VRMUtils.rotateVRM0(vrm);
  VRMUtils.combineSkeletons(vrm.scene);
  VRMUtils.combineMorphs(vrm);
  applyRestPose(vrm);
  scene.add(vrm.scene);
  scene.add(buildContactShadow());

  function layout(): void {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
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

  const wander = new WanderController(ROOM_HALF_SIZE - WANDER_MARGIN_M);
  const idleGestures = new IdleGestureScheduler();
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

  const clock = new THREE.Clock();
  function animate(): void {
    requestAnimationFrame(animate);
    const delta = clock.getDelta();
    flyCamera.update(delta);
    updateBlink(delta);
    hud.tick(delta);
    const target = wander.getTarget(delta, vrm.scene.position, hud.isTurnActive());
    character.update(delta, target, hud.isTurnActive());
    const debugText = character.debugFacingTravelText;
    debugEl.style.display = debugText ? "block" : "none";
    if (debugText) debugEl.textContent = debugText;
    const footTraceText = character.debugFootTraceText;
    footTraceEl.style.display = footTraceText ? "block" : "none";
    if (footTraceText) footTraceEl.textContent = footTraceText;
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
    vrm.update(delta);
    renderer.render(scene, camera);
  }
  animate();
}

boot().catch((err) => {
  console.error("[luna-sandbox] failed to boot", err);
  const statusEl = document.getElementById("sandbox-status");
  if (statusEl) statusEl.textContent = `Failed to load: ${(err as Error).message ?? err}`;
});
