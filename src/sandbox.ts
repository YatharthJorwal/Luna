import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";
import { VRMAnimationLoaderPlugin, createVRMAnimationClip, type VRMAnimation } from "@pixiv/three-vrm-animation";

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
const FLOOR_HALF_SIZE = 4.5; // invisible walk boundary in meters from center; matches the floor/grid built below

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
// Studio environment: a plain white room, per the brief ("a plain white
// space/box for now"). A background color + matching fog reads as an
// unbounded white void rather than needing real walls/ceiling geometry;
// the floor plane + faint grid exist only to give a visible ground plane
// so a walking figure doesn't look like it's floating. Choosing an actual
// bounded room / selectable backgrounds is the *other* half of
// ROADMAP.md's Phase 10 entry, deliberately not this file's job -- see
// docs/DECISIONS.md.
// ---------------------------------------------------------------------
function buildStudio(scene: THREE.Scene): void {
  scene.background = new THREE.Color(0xffffff);
  scene.fog = new THREE.Fog(0xffffff, 10, 26);

  const floorSize = FLOOR_HALF_SIZE * 2 * 4;
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(floorSize, floorSize),
    new THREE.MeshStandardMaterial({ color: 0xf2f2f5, roughness: 0.95, metalness: 0 }),
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  const grid = new THREE.GridHelper(FLOOR_HALF_SIZE * 2, 12, 0xd6d6da, 0xe9e9ec);
  const gridMat = grid.material as THREE.Material;
  gridMat.transparent = true;
  gridMat.opacity = 0.7;
  grid.position.y = 0.002; // avoid z-fighting with the floor plane
  scene.add(grid);

  // Same lighting recipe main.ts settled on for MToon materials (flat,
  // near-front key light + a hemisphere fill instead of one strong
  // off-axis light) -- see that file's own comment and
  // docs/DECISIONS.md's "jacket artifact" entry for why. Duplicated, not
  // imported, same reasoning as applyRestPose above.
  const keyLight = new THREE.DirectionalLight(0xffffff, 0.9);
  keyLight.position.set(0, 3, 4);
  scene.add(keyLight);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xd8d8e0, 1.15));
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
  gradient.addColorStop(0, "rgba(20,20,24,0.32)");
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
// zero external assets needed, which is what makes the sandbox usable to
// test locomotion/camera/room work today rather than only once a real
// mocap/authored clip exists.
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
// Character controller: reads WASD/arrow input, moves vrm.scene relative
// to the camera's own facing (standard third-person convention), turns
// the model to face its movement direction, and clamps her to the floor.
// ---------------------------------------------------------------------
function lerpAngle(a: number, b: number, t: number): number {
  let diff = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

class CharacterController {
  private facing = 0;
  readonly walker: ProceduralWalker;
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
      // No separate idle clip yet (see WALK_CLIP_PATH's own comment) --
      // freezing the walk clip's timeScale at 0 while stopped holds its
      // current pose rather than needing a second authored clip to blend
      // toward. Good enough for a first real walk cycle; a proper
      // idle<->walk crossfade is a natural next increment once there's an
      // actual clip in hand to test it against.
      this.walkAction.timeScale = 0;
    }
  }

  get usingRealClip(): boolean {
    return this.walkAction !== null;
  }

  update(delta: number, input: { x: number; z: number }, camera: THREE.Camera): void {
    const camForward = new THREE.Vector3();
    camera.getWorldDirection(camForward);
    camForward.y = 0;
    camForward.normalize();
    const camRight = new THREE.Vector3().crossVectors(camForward, camera.up).normalize();

    const move = new THREE.Vector3()
      .addScaledVector(camForward, -input.z)
      .addScaledVector(camRight, input.x);
    const speedFraction = Math.min(1, move.length());
    if (speedFraction > 0.001) move.normalize();

    const displacement = move.clone().multiplyScalar(WALK_SPEED_MPS * speedFraction * delta);
    const next = this.vrm.scene.position.clone().add(displacement);
    next.x = THREE.MathUtils.clamp(next.x, -FLOOR_HALF_SIZE, FLOOR_HALF_SIZE);
    next.z = THREE.MathUtils.clamp(next.z, -FLOOR_HALF_SIZE, FLOOR_HALF_SIZE);
    this.vrm.scene.position.copy(next);

    if (speedFraction > 0.01) {
      const targetFacing = Math.atan2(-move.x, -move.z);
      this.facing = lerpAngle(this.facing, targetFacing, Math.min(1, TURN_RATE_RAD_S * delta));
      this.vrm.scene.rotation.y = this.facing;
    }

    if (this.walkAction && this.mixer) {
      // Weight ramps with speed so starting/stopping blends rather than
      // snapping the clip on/off; timeScale is what actually pauses the
      // clip's own internal motion when standing still.
      this.walkAction.setEffectiveWeight(speedFraction);
      this.walkAction.timeScale = speedFraction;
      this.mixer.update(delta);
    } else {
      this.walker.update(delta, speedFraction);
    }
  }
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

  const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.1, 60);

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

  // Frame the camera against the model's own measured height (bounding
  // box computed after adding + posing it) rather than a fixed guess, so
  // full-body framing adapts to whatever proportions the loaded model
  // actually has -- same reasoning main.ts uses for its head-relative
  // bust framing, just against the whole body's box instead of one bone.
  const box = new THREE.Box3().setFromObject(vrm.scene);
  const height = Math.max(0.5, box.max.y - box.min.y);
  const focusHeight = box.min.y + height * 0.55;
  camera.position.set(0, focusHeight + height * 0.12, height * 2.15);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = height * 0.8;
  controls.maxDistance = height * 4;
  controls.maxPolarAngle = Math.PI / 2 - 0.03; // keep the camera from diving under the floor
  controls.target.set(0, focusHeight, 0);
  controls.update();

  function layout(): void {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  }
  layout();
  window.addEventListener("resize", layout);

  // Blink loop -- same minimal treatment as main.ts's, duplicated for the
  // same isolation reason as applyRestPose above. Full expression/emotion
  // wiring isn't this sandbox's job; it's already covered for the bust
  // view in main.ts (Phase 8).
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
  statusEl.textContent = character.usingRealClip
    ? "Model loaded · playing walk.vrma"
    : "Model loaded · procedural walk (drop a walk.vrma into public/vrm-animations/ to use a real clip)";

  const keys = new Set<string>();
  window.addEventListener("keydown", (e) => keys.add(e.key.toLowerCase()));
  window.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
  function readInput(): { x: number; z: number } {
    let x = 0;
    let z = 0;
    if (keys.has("w") || keys.has("arrowup")) z -= 1;
    if (keys.has("s") || keys.has("arrowdown")) z += 1;
    if (keys.has("a") || keys.has("arrowleft")) x -= 1;
    if (keys.has("d") || keys.has("arrowright")) x += 1;
    return { x, z };
  }

  const clock = new THREE.Clock();
  function animate(): void {
    requestAnimationFrame(animate);
    const delta = clock.getDelta();
    updateBlink(delta);
    character.update(delta, readInput(), camera);
    controls.target.set(vrm.scene.position.x, focusHeight, vrm.scene.position.z);
    controls.update();
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
