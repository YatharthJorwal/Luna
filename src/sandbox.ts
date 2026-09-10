import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";
import { VRMAnimationLoaderPlugin, createVRMAnimationClip, type VRMAnimation } from "@pixiv/three-vrm-animation";
import { setupSandboxHud } from "./sandbox-hud";

// Same character asset the desktop shell uses -- see README.md's "Putting
// your VRoid model in" section. Nothing sandbox-specific about the model
// file itself, only about how it's staged and moved around once loaded.
const MODEL_PATH = "/vrm/luna.vrm";

// Optional walk cycle, entirely absent by default (see
// public/vrm-animations/README.txt) -- gitignored the same way
// public/vrm/luna.vrm is, since it's a personal/sourced asset, not
// something this repo can generate. Loading it is wrapped in a try/catch
// below and its absence is expected, not an error: without it, a
// procedural (code-driven, no-asset-needed) walk cycle takes over instead
// -- see updateProceduralWalk(). Drop a real VRMA export here whenever
// one exists and the mixer path below picks it up automatically, no code
// changes required.
const WALK_CLIP_PATH = "/vrm-animations/walk.vrma";

const WALK_SPEED_MPS = 1.4; // roughly an average adult's walking pace
const TURN_RATE_RAD_S = 10; // how fast she reorients to face her movement direction
const ARRIVE_RADIUS_M = 0.08; // "close enough" to a wander target to call it arrived
const SLOWDOWN_RADIUS_M = 0.6; // starts easing speed down inside this distance from the target

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
  scene.add(floor);

  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(size, size), wallMat);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = ROOM_HEIGHT;
  scene.add(ceiling);

  const wallGeo = new THREE.PlaneGeometry(size, ROOM_HEIGHT);
  const north = new THREE.Mesh(wallGeo, wallMat);
  north.position.set(0, ROOM_HEIGHT / 2, -ROOM_HALF_SIZE);
  scene.add(north);
  const south = new THREE.Mesh(wallGeo, wallMat);
  south.position.set(0, ROOM_HEIGHT / 2, ROOM_HALF_SIZE);
  south.rotation.y = Math.PI;
  scene.add(south);
  const east = new THREE.Mesh(wallGeo, wallMat);
  east.position.set(ROOM_HALF_SIZE, ROOM_HEIGHT / 2, 0);
  east.rotation.y = -Math.PI / 2;
  scene.add(east);
  const west = new THREE.Mesh(wallGeo, wallMat);
  west.position.set(-ROOM_HALF_SIZE, ROOM_HEIGHT / 2, 0);
  west.rotation.y = Math.PI / 2;
  scene.add(west);

  // Faint floor grid, just enough to read depth/scale on an otherwise
  // featureless white floor.
  const grid = new THREE.GridHelper(size, 12, 0xd6d6da, 0xe9e9ec);
  const gridMat = grid.material as THREE.Material;
  gridMat.transparent = true;
  gridMat.opacity = 0.7;
  grid.position.y = 0.002; // avoid z-fighting with the floor plane
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
  // docs/DECISIONS.md.
  const keyLight = new THREE.DirectionalLight(0xffffff, 0.55);
  keyLight.position.set(1.5, ROOM_HEIGHT * 0.9, 2.5);
  scene.add(keyLight);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xf3f3f3, 0.5));
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

function lerpAngle(a: number, b: number, t: number): number {
  let diff = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

// ---------------------------------------------------------------------
// Character controller: steers vrm.scene toward whatever target
// WanderController hands it (or stands idle if there isn't one), and
// drives either the real walk.vrma clip or the procedural fallback.
// No player input reaches this class at all -- see the brief: this is
// Luna's space, not something to joystick around by hand.
// ---------------------------------------------------------------------
class CharacterController {
  private facing = 0;
  private readonly walker: ProceduralWalker;
  private mixer: THREE.AnimationMixer | null = null;
  private walkAction: THREE.AnimationAction | null = null;

  constructor(
    private vrm: VRM,
    walkClip: THREE.AnimationClip | null,
  ) {
    this.walker = new ProceduralWalker(collectWalkBones(vrm));
    if (walkClip) {
      this.mixer = new THREE.AnimationMixer(vrm.scene);
      this.walkAction = this.mixer.clipAction(walkClip);
      this.walkAction.play();
      // No separate idle clip yet -- freezing the walk clip's timeScale
      // at 0 while stopped holds its current pose rather than needing a
      // second authored clip to blend toward. A proper idle<->walk
      // crossfade is a natural next increment once there's an actual
      // clip in hand to test blend timing against.
      this.walkAction.timeScale = 0;
    }
  }

  get usingRealClip(): boolean {
    return this.walkAction !== null;
  }

  update(delta: number, target: THREE.Vector3 | null): void {
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
        const step = Math.min(dist, WALK_SPEED_MPS * delta);
        this.vrm.scene.position.x += dir.x * step;
        this.vrm.scene.position.z += dir.z * step;

        // Eases speed down near the target instead of walking at full
        // pace right up until she snaps to a stop.
        speedFraction = Math.min(1, dist / SLOWDOWN_RADIUS_M);

        const targetFacing = Math.atan2(-dir.x, -dir.z);
        this.facing = lerpAngle(this.facing, targetFacing, Math.min(1, TURN_RATE_RAD_S * delta));
        this.vrm.scene.rotation.y = this.facing;
      }
    }

    if (this.walkAction && this.mixer) {
      this.walkAction.setEffectiveWeight(speedFraction);
      this.walkAction.timeScale = speedFraction;
      this.mixer.update(delta);
    } else {
      this.walker.update(delta, speedFraction);
    }
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

  // Optional walk clip -- absence is the expected default, not an error.
  // See WALK_CLIP_PATH's own comment above.
  let walkClip: THREE.AnimationClip | null = null;
  try {
    const clipGltf = await loader.loadAsync(WALK_CLIP_PATH);
    const vrmAnimations = clipGltf.userData.vrmAnimations as VRMAnimation[] | undefined;
    if (vrmAnimations?.[0]) {
      walkClip = createVRMAnimationClip(vrmAnimations[0], vrm);
      walkClip.name = "walk";
    }
  } catch {
    walkClip = null; // no file dropped in at public/vrm-animations/walk.vrma yet
  }

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

  const character = new CharacterController(vrm, walkClip);
  const wander = new WanderController(ROOM_HALF_SIZE - WANDER_MARGIN_M);
  statusEl.textContent = character.usingRealClip
    ? "Model loaded · playing walk.vrma"
    : "Model loaded · procedural walk (drop a walk.vrma into public/vrm-animations/ to use a real clip)";

  // Full chat/caption/mic HUD -- connects to the same orchestrator
  // main.ts does, identifying itself as "sandbox" so the two windows
  // don't both try to drive a conversation at once. See
  // src/sandbox-hud.ts and ws-client.ts's/app.py's surface_status
  // handling.
  const hud = setupSandboxHud(vrm);

  const clock = new THREE.Clock();
  function animate(): void {
    requestAnimationFrame(animate);
    const delta = clock.getDelta();
    flyCamera.update(delta);
    updateBlink(delta);
    hud.tick(delta);
    const target = wander.getTarget(delta, vrm.scene.position, hud.isTurnActive());
    character.update(delta, target);
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
