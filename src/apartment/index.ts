/**
 * Builds the apartment and hands back a small control surface.
 *
 * Round 12 rewrite: this no longer builds the room procedurally. The user
 * dropped in a whole prebuilt apartment model --
 * `public/apartment/twokinds_modern_trio_apartment.glb`, a Sketchfab
 * download -- to replace the hand-authored shell/furniture/materials system
 * from rounds 9-11, because that system was producing visibly broken
 * results (a UV-checker bathtub texture, a floating disconnected towel, a
 * toilet missing its bowl, a blown-out mirror) that nobody building it
 * could actually see. See docs/DECISIONS.md's round-12 entry for the full
 * account, including what `gltf-transform inspect` showed about the file
 * before any of this was written.
 *
 * What's unchanged from round 10/11: image-based lighting via
 * `RoomEnvironment` + `PMREMGenerator` (real PBR materials -- and this
 * model has plenty, per the inspect report: 82 materials, several with
 * metallic-roughness + normal maps -- need an environment to reflect or
 * they read as flat/black), ACES tone mapping, the four-time-of-day state
 * machine, and the dust-mote particle system.
 *
 * What's gone: `floorplan.ts`'s real rooms/walls/doors/anchors, and with
 * them the shell/furniture/materials modules that built and dressed them.
 * The new model has no per-room data in it worth reading (generic
 * `Object_0`, `Object_1`, ... mesh names, not `Kitchen_Counter`), so
 * `floorplan.ts` now describes one big placeholder room sized to the
 * model's real bounding box instead of nine real ones. Doors, the ceiling
 * show/hide toggle, and room-level scene-state description are gone with
 * it -- there's no reliable way to identify a door or a ceiling plane by
 * name in this file, and no per-room boundaries to report a room from.
 * Getting any of that back is follow-up work that needs someone who can
 * actually see the loaded model to point out where the walls and doors
 * are -- not something to guess at blind, same lesson as every lighting
 * decision in this project's history.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import {
  CEILING_H, CENTRE, FOOTPRINT, PATCHES, ANCHORS, ROOMS,
  roomAt, anchorNear,
  type NavPatch, type Anchor, type RoomId,
} from './floorplan';

/** Where the user dropped the prebuilt apartment -- gitignored, same
 * pattern as public/vrm/*.vrm. See public/apartment/README.txt. */
const MODEL_PATH = '/apartment/twokinds_modern_trio_apartment.glb';

export type TimeOfDay = 'dawn' | 'day' | 'dusk' | 'night';
export const TIMES_OF_DAY: TimeOfDay[] = ['dawn', 'day', 'dusk', 'night'];

export {
  PATCHES, ANCHORS, ROOMS, CENTRE, FOOTPRINT, CEILING_H,
  roomAt, anchorNear,
};
export type { NavPatch, Anchor, RoomId };

interface LightState {
  sky: THREE.Color;
  bg: THREE.Color;
  fogNear: number;
  fogFar: number;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiI: number;
  sunColor: THREE.Color;
  sunI: number;
  sunPos: THREE.Vector3;
  /** IBL contribution. */
  envI: number;
  /** Bloom strength, read by postfx. */
  bloom: number;
  /** Exposure, read by the renderer. */
  exposure: number;
}

function st(s: {
  sky: number; bg: number; fogNear: number; fogFar: number;
  hemiSky: number; hemiGround: number; hemiI: number;
  sunColor: number; sunI: number; sunPos: [number, number, number];
  envI: number; bloom: number; exposure: number;
}): LightState {
  return {
    sky: new THREE.Color(s.sky),
    bg: new THREE.Color(s.bg),
    fogNear: s.fogNear,
    fogFar: s.fogFar,
    hemiSky: new THREE.Color(s.hemiSky),
    hemiGround: new THREE.Color(s.hemiGround),
    hemiI: s.hemiI,
    sunColor: new THREE.Color(s.sunColor),
    sunI: s.sunI,
    sunPos: new THREE.Vector3(...s.sunPos),
    envI: s.envI,
    bloom: s.bloom,
    exposure: s.exposure,
  };
}

/**
 * Four times of day, rewritten from scratch for round 12 -- the old MODES
 * table was tuned (twice, badly the first time -- see round 11) against
 * this project's *own* hand-authored materials.ts. This is a real,
 * unfamiliar PBR model with its own baseColor/metallicRoughness/normal/
 * emissive textures and no history of anyone tuning against it. These
 * numbers are a deliberately conservative starting guess -- kept every
 * light contribution modest rather than stacking several near their max
 * at once, precisely because of what happened last time -- not a verified
 * result. There is currently zero visual reference for how this specific
 * model's textures respond to any of this. Expect these to need real
 * adjustment once someone can actually see it.
 *
 * Also worth noting from the inspect report: several materials here
 * (`Glowy_Green`, `RGB_Material`, `Magic_Glow`, `red_glow`/`orange_glow`/
 * `purple_glow`/`blue_glow`/`white_glow`, the various screens) carry their
 * own emissive textures -- self-lit regardless of scene lighting. That's
 * presumably load-bearing for the room's look (a "gamer den" aesthetic
 * leans on practical/neon lighting, not just ambient fill), so night mode
 * here is deliberately dim on the *scene* lights, leaning on those
 * emissive materials to carry the room's visual interest instead of
 * fighting them with a bright ambient.
 */
const MODES: Record<TimeOfDay, LightState> = {
  dawn: st({
    sky: 0xf0c6b4, bg: 0xe8bfae, fogNear: 16, fogFar: 60,
    hemiSky: 0xffd8c0, hemiGround: 0x6a5a5e, hemiI: 0.5,
    sunColor: 0xffb98a, sunI: 1.4, sunPos: [CENTRE.x - 14, 8, CENTRE.z + 10],
    envI: 0.5, bloom: 0.42, exposure: 1.0,
  }),
  day: st({
    sky: 0xbfd9ef, bg: 0xc9e0f2, fogNear: 24, fogFar: 90,
    hemiSky: 0xf4f9ff, hemiGround: 0xa89880, hemiI: 0.6,
    sunColor: 0xfff3e0, sunI: 1.7, sunPos: [CENTRE.x - 12, 15, CENTRE.z + 8],
    envI: 0.58, bloom: 0.28, exposure: 0.95,
  }),
  dusk: st({
    sky: 0xe9a479, bg: 0xd9906d, fogNear: 14, fogFar: 55,
    hemiSky: 0xffc094, hemiGround: 0x5a4650, hemiI: 0.4,
    sunColor: 0xff9552, sunI: 1.5, sunPos: [CENTRE.x - 16, 5, CENTRE.z + 4],
    envI: 0.38, bloom: 0.5, exposure: 1.0,
  }),
  night: st({
    sky: 0x1d1a30, bg: 0x141222, fogNear: 9, fogFar: 40,
    hemiSky: 0x3a3a68, hemiGround: 0x14111f, hemiI: 0.16,
    sunColor: 0x9fb4ff, sunI: 0.12, sunPos: [CENTRE.x + 8, 10, CENTRE.z - 8],
    envI: 0.12, bloom: 0.65, exposure: 1.0,
  }),
};

function cloneState(s: LightState): LightState {
  return {
    sky: s.sky.clone(), bg: s.bg.clone(), fogNear: s.fogNear, fogFar: s.fogFar,
    hemiSky: s.hemiSky.clone(), hemiGround: s.hemiGround.clone(), hemiI: s.hemiI,
    sunColor: s.sunColor.clone(), sunI: s.sunI, sunPos: s.sunPos.clone(),
    envI: s.envI, bloom: s.bloom, exposure: s.exposure,
  };
}

const lerp = THREE.MathUtils.lerp;

export interface SceneState {
  room: RoomId | null;
  roomLabel: string;
  /** Anchor she's standing at, if any. */
  at: string | null;
  timeOfDay: TimeOfDay;
  /** True when the spectator is walking around in first person nearby. */
  visitorPresent: boolean;
  visitorRoom: RoomId | null;
}

export interface ApartmentHandle {
  root: THREE.Group;
  patches: NavPatch[];
  anchors: Anchor[];
  /** Per-frame tick. */
  update(dt: number, elapsed: number, subject: THREE.Vector3 | null): void;
  setTimeOfDay(t: TimeOfDay, instant?: boolean): void
  timeOfDay(): TimeOfDay;
  /** Current bloom strength / exposure for the post chain to follow. */
  bloomStrength(): number;
  exposure(): number;
  /** Human-readable state, for the persona channel. */
  describe(lunaPos: THREE.Vector3, visitorPos: THREE.Vector3 | null, visitorEmbodied: boolean): SceneState;
  dispose(): void;
}

/** Frees every geometry/material/texture under a loaded glTF scene. Needed
 * because this model didn't come from our own materials.ts (which had its
 * own disposeGeoCache()) -- it's 35 textures and 82 materials we didn't
 * create, so nothing else will clean them up. */
function disposeModel(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (!m) continue;
      for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap'] as const) {
        (m as unknown as Record<string, THREE.Texture | undefined>)[key]?.dispose();
      }
      m.dispose();
    }
  });
}

export async function buildApartment(scene: THREE.Scene, renderer: THREE.WebGLRenderer): Promise<ApartmentHandle> {
  const root = new THREE.Group();
  root.name = 'apartment';

  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(MODEL_PATH);
  const model = gltf.scene;
  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
  });
  root.add(model);
  scene.add(root);

  // --- image-based lighting ------------------------------------------------
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const envScene = new RoomEnvironment();
  const envRT = pmrem.fromScene(envScene, 0.04);
  scene.environment = envRT.texture;
  envScene.dispose?.();

  // --- lights --------------------------------------------------------------
  const hemi = new THREE.HemisphereLight(0xffffff, 0x8a7f70, 1);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  // Frustum sized to the model's real footprint (19.1m x 10.9m -- see
  // floorplan.ts's FOOTPRINT comment for where those numbers come from),
  // roughly 2x round 11's old-apartment-sized ±12, with margin for the
  // sun's oblique angle.
  const cam = sun.shadow.camera;
  cam.left = -16;
  cam.right = 16;
  cam.top = 16;
  cam.bottom = -16;
  cam.near = 0.5;
  cam.far = 50;
  sun.shadow.bias = -0.0009;
  sun.shadow.normalBias = 0.022;
  sun.shadow.radius = 3;
  const sunTarget = new THREE.Object3D();
  sunTarget.position.set(CENTRE.x, 1.0, CENTRE.z);
  scene.add(sunTarget);
  sun.target = sunTarget;
  scene.add(sun);

  // A soft interior bounce light, same role as round 10/11: keeps the side
  // of the room facing away from the sun from going flat black.
  const bounce = new THREE.DirectionalLight(0xffe9d2, 0.3);
  bounce.position.set(CENTRE.x + 7, 3.2, CENTRE.z - 6);
  bounce.castShadow = false;
  scene.add(bounce);

  // --- ambient motes, fixed --------------------------------------------------
  // Unchanged from round 10/11 -- geometry generated centred on the
  // apartment's real footprint, object positioned at the apartment's
  // centre, so the slow spin + vertical drift stays inside the building
  // instead of sweeping out of it.
  const MOTES = 220;
  const halfX = (FOOTPRINT.maxX - FOOTPRINT.minX) / 2;
  const halfZ = (FOOTPRINT.maxZ - FOOTPRINT.minZ) / 2;
  const motePos = new Float32Array(MOTES * 3);
  const motePhase = new Float32Array(MOTES);
  for (let i = 0; i < MOTES; i++) {
    motePos[i * 3] = (Math.random() * 2 - 1) * halfX * 0.92;
    motePos[i * 3 + 1] = 0.25 + Math.random() * (CEILING_H - 0.5);
    motePos[i * 3 + 2] = (Math.random() * 2 - 1) * halfZ * 0.92;
    motePhase[i] = Math.random() * Math.PI * 2;
  }
  const moteGeo = new THREE.BufferGeometry();
  moteGeo.setAttribute('position', new THREE.BufferAttribute(motePos, 3));
  const moteCanvas = document.createElement('canvas');
  moteCanvas.width = moteCanvas.height = 64;
  const mctx = moteCanvas.getContext('2d');
  if (mctx) {
    const grd = mctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,248,232,1)');
    grd.addColorStop(0.35, 'rgba(255,240,210,0.5)');
    grd.addColorStop(1, 'rgba(255,240,210,0)');
    mctx.fillStyle = grd;
    mctx.fillRect(0, 0, 64, 64);
  }
  const moteTex = new THREE.CanvasTexture(moteCanvas);
  const moteMat = new THREE.PointsMaterial({
    size: 0.035, map: moteTex, transparent: true, opacity: 0.0,
    depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
  });
  const motes = new THREE.Points(moteGeo, moteMat);
  motes.position.set(CENTRE.x, 0, CENTRE.z);
  motes.frustumCulled = false;
  root.add(motes);

  // --- mode state ----------------------------------------------------------
  let live = cloneState(MODES.day);
  let from = cloneState(MODES.day);
  let to = cloneState(MODES.day);
  let transT = 1;
  const TRANS_S = 1.6;
  let current: TimeOfDay = 'day';

  function apply(): void {
    scene.background = live.bg;
    const fog = scene.fog;
    if (fog instanceof THREE.Fog) {
      fog.color.copy(live.bg);
      fog.near = live.fogNear;
      fog.far = live.fogFar;
    }
    hemi.color.copy(live.hemiSky);
    hemi.groundColor.copy(live.hemiGround);
    hemi.intensity = live.hemiI;
    sun.color.copy(live.sunColor);
    sun.intensity = live.sunI;
    sun.position.copy(live.sunPos);
    bounce.intensity = live.hemiI * 0.35;
    scene.environmentIntensity = live.envI;
    moteMat.opacity = 0.05 + (1 - live.envI) * 0.35;
  }

  function setTimeOfDay(t: TimeOfDay, instant = false): void {
    if (!MODES[t]) return;
    current = t;
    if (instant) {
      live = cloneState(MODES[t]);
      from = cloneState(MODES[t]);
      to = cloneState(MODES[t]);
      transT = 1;
    } else {
      from = cloneState(live);
      to = cloneState(MODES[t]);
      transT = 0;
    }
    apply();
  }

  function stepTransition(dt: number): void {
    if (transT >= 1) return;
    transT = Math.min(1, transT + dt / TRANS_S);
    const e = transT < 0.5 ? 2 * transT * transT : 1 - (-2 * transT + 2) ** 2 / 2;
    live.bg.copy(from.bg).lerp(to.bg, e);
    live.sky.copy(from.sky).lerp(to.sky, e);
    live.fogNear = lerp(from.fogNear, to.fogNear, e);
    live.fogFar = lerp(from.fogFar, to.fogFar, e);
    live.hemiSky.copy(from.hemiSky).lerp(to.hemiSky, e);
    live.hemiGround.copy(from.hemiGround).lerp(to.hemiGround, e);
    live.hemiI = lerp(from.hemiI, to.hemiI, e);
    live.sunColor.copy(from.sunColor).lerp(to.sunColor, e);
    live.sunI = lerp(from.sunI, to.sunI, e);
    live.sunPos.copy(from.sunPos).lerp(to.sunPos, e);
    live.envI = lerp(from.envI, to.envI, e);
    live.bloom = lerp(from.bloom, to.bloom, e);
    live.exposure = lerp(from.exposure, to.exposure, e);
    apply();
  }

  setTimeOfDay('day', true);

  return {
    root,
    patches: PATCHES,
    anchors: ANCHORS,
    setTimeOfDay,
    timeOfDay: () => current,
    bloomStrength: () => live.bloom,
    exposure: () => live.exposure,

    update(dt, elapsed, _subject) {
      stepTransition(dt);

      // motes: slow spin plus a gentle vertical bob
      motes.rotation.y += dt * 0.012;
      const arr = moteGeo.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < MOTES; i++) {
        const y = 0.25 + ((motePos[i * 3 + 1] - 0.25 + elapsed * 0.045 + motePhase[i] * 0.3)
          % (CEILING_H - 0.5));
        arr.setY(i, y);
      }
      arr.needsUpdate = true;
    },

    describe(lunaPos, visitorPos, visitorEmbodied) {
      const r = roomAt(lunaPos.x, lunaPos.z);
      const a = anchorNear(lunaPos.x, lunaPos.z, 1.1);
      const vr = visitorPos ? roomAt(visitorPos.x, visitorPos.z) : null;
      return {
        room: r?.id ?? null,
        roomLabel: r?.label ?? 'somewhere in the flat',
        at: a?.description ?? null,
        timeOfDay: current,
        visitorPresent: visitorEmbodied && vr !== null,
        visitorRoom: vr?.id ?? null,
      };
    },

    dispose() {
      envRT.dispose();
      pmrem.dispose();
      moteTex.dispose();
      moteGeo.dispose();
      moteMat.dispose();
      disposeModel(model);
    },
  };
}
