/**
 * Builds the apartment and hands back a small control surface.
 *
 * The big lighting change from the previous version: this scene is lit by an
 * environment map (image-based lighting) as well as by lights. `RoomEnvironment`
 * + `PMREMGenerator` gives every material a pre-convolved view of a bright
 * room to reflect, which is what supplies the soft directionless bounce that
 * real rooms have and that a couple of point lights fundamentally cannot fake.
 * It is also the reason the PBR values in materials.ts are worth setting: a
 * roughness difference between ceramic and fabric is invisible under pure
 * point lighting but obvious under IBL.
 *
 * That, plus ACES tone mapping and the post chain in ../postfx.ts, is the
 * honest answer to "make it ray traced". Real-time path tracing isn't on the
 * table in a browser, but IBL + ambient occlusion + soft shadows + bloom +
 * a filmic curve covers most of what people are actually reacting to when
 * they call a render "ray traced".
 */

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import {
  CEILING_H, CENTRE, FOOTPRINT, PATCHES, ANCHORS, ROOMS,
  roomAt, anchorNear,
  type NavPatch, type Anchor, type RoomId,
} from './floorplan';
import { createMaterials, disposeGeoCache, type MaterialLib } from './materials';
import { buildShell, updateDoors, type DoorLeaf } from './shell';
import { buildFurniture, drawScreen, type Furnishings } from './furniture';

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
  /** Multiplier on every lamp in the flat. */
  lampI: number;
  /** Brightness of the fake daylight panels inside each window. */
  windowI: number;
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
  lampI: number; windowI: number; envI: number; bloom: number; exposure: number;
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
    lampI: s.lampI,
    windowI: s.windowI,
    envI: s.envI,
    bloom: s.bloom,
    exposure: s.exposure,
  };
}

/**
 * Four times of day. Intensities assume physically-correct punctual lights
 * (the modern three default) -- lamp `userData.base` values in furniture.ts
 * are in that same system, so a bedside lamp at base 1.5 with `lampI` 1.0 is
 * a real 1.5-intensity light, not a legacy-falloff number.
 */
const MODES: Record<TimeOfDay, LightState> = {
  dawn: st({
    sky: 0xf0c6b4, bg: 0xe8bfae, fogNear: 14, fogFar: 46,
    hemiSky: 0xffd8c0, hemiGround: 0x6a5a5e, hemiI: 0.55,
    sunColor: 0xffb98a, sunI: 1.5, sunPos: [-13, 5.5, 11],
    lampI: 0.35, windowI: 0.5, envI: 0.55, bloom: 0.5, exposure: 1.0,
  }),
  day: st({
    // Was sunI 3.1 / hemiI 0.95 / envI 1.0 / exposure 1.05 -- roughly 1.7-2x
    // dawn's already-fine numbers on *three* separate light contributions at
    // once, then pushed brighter still by exposure on top. ACES compresses
    // highlights rather than hard-clipping them, but stacking that much
    // radiance still reads as a blown-out white wash once it's through the
    // curve -- which is exactly what the user's screenshot showed, and this
    // is the default mode the scene boots into (see `let live = ...MODES.day`
    // below), so it's the first thing anyone sees. Brought down to keep day
    // the brightest time of day (still above dusk's 1.8/0.48/0.45) without
    // the three components compounding into a wash, and exposure dropped
    // slightly below the 1.0 baseline the other modes use to leave headroom
    // for that compounding. Not verified on a screen in this sandbox --
    // reasoned from the numbers and the ACES curve, not re-screenshotted.
    sky: 0xbfd9ef, bg: 0xc9e0f2, fogNear: 22, fogFar: 70,
    hemiSky: 0xf4f9ff, hemiGround: 0xa89880, hemiI: 0.68,
    sunColor: 0xfff3e0, sunI: 2.0, sunPos: [-10, 14, 9],
    lampI: 0.0, windowI: 1.0, envI: 0.68, bloom: 0.32, exposure: 0.95,
  }),
  dusk: st({
    sky: 0xe9a479, bg: 0xd9906d, fogNear: 12, fogFar: 40,
    hemiSky: 0xffc094, hemiGround: 0x5a4650, hemiI: 0.48,
    sunColor: 0xff9552, sunI: 1.8, sunPos: [-15, 3.2, 6],
    lampI: 0.75, windowI: 0.42, envI: 0.45, bloom: 0.62, exposure: 1.0,
  }),
  night: st({
    sky: 0x1d1a30, bg: 0x141222, fogNear: 8, fogFar: 30,
    hemiSky: 0x3a3a68, hemiGround: 0x14111f, hemiI: 0.22,
    sunColor: 0x9fb4ff, sunI: 0.22, sunPos: [6, 11, -9],
    lampI: 1.35, windowI: 0.1, envI: 0.16, bloom: 0.85, exposure: 1.1,
  }),
};

function cloneState(s: LightState): LightState {
  return {
    sky: s.sky.clone(), bg: s.bg.clone(), fogNear: s.fogNear, fogFar: s.fogFar,
    hemiSky: s.hemiSky.clone(), hemiGround: s.hemiGround.clone(), hemiI: s.hemiI,
    sunColor: s.sunColor.clone(), sunI: s.sunI, sunPos: s.sunPos.clone(),
    lampI: s.lampI, windowI: s.windowI, envI: s.envI, bloom: s.bloom, exposure: s.exposure,
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
  doors: DoorLeaf[];
  /** Per-frame tick. `subject` is Luna's position, used for auto-doors. */
  update(dt: number, elapsed: number, subject: THREE.Vector3 | null): void;
  setTimeOfDay(t: TimeOfDay, instant?: boolean): void
  timeOfDay(): TimeOfDay;
  /** Current bloom strength / exposure for the post chain to follow. */
  bloomStrength(): number;
  exposure(): number;
  /** Ask a door to open or shut; used by the character and by the visitor. */
  requestDoor(id: string, open: boolean): void;
  /** Show/hide every room's ceiling plane -- lets spectator mode fly a clear
   * overhead view instead of relying on the backface-culling accident that
   * otherwise hides them from directly above. */
  setCeilingsVisible(v: boolean): void;
  ceilingsVisible(): boolean;
  /** Human-readable state, for the persona channel. */
  describe(lunaPos: THREE.Vector3, visitorPos: THREE.Vector3 | null, visitorEmbodied: boolean): SceneState;
  dispose(): void;
}

export function buildApartment(scene: THREE.Scene, renderer: THREE.WebGLRenderer): ApartmentHandle {
  const root = new THREE.Group();
  root.name = 'apartment';

  const lib: MaterialLib = createMaterials();
  const shell = buildShell(lib);
  const furn: Furnishings = buildFurniture(lib, CEILING_H);
  root.add(shell.root);
  root.add(furn.root);
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
  // Frustum sized to the flat's footprint, in metres, with headroom.
  const cam = sun.shadow.camera;
  cam.left = -12;
  cam.right = 12;
  cam.top = 12;
  cam.bottom = -12;
  cam.near = 0.5;
  cam.far = 46;
  sun.shadow.bias = -0.0009;
  sun.shadow.normalBias = 0.022;
  sun.shadow.radius = 3;
  const sunTarget = new THREE.Object3D();
  sunTarget.position.set(CENTRE.x, 1.0, CENTRE.z);
  scene.add(sunTarget);
  sun.target = sunTarget;
  scene.add(sun);

  // A soft interior bounce light. Without it the side of the room facing away
  // from the windows goes flat -- the "many dark spaces" complaint about the
  // previous build was mostly this plus the missing IBL.
  const bounce = new THREE.DirectionalLight(0xffe9d2, 0.35);
  bounce.position.set(CENTRE.x + 7, 3.2, CENTRE.z - 6);
  bounce.castShadow = false;
  scene.add(bounce);

  // --- ambient motes, fixed --------------------------------------------------
  // The old version put these in a Points object whose origin was the world
  // origin while the geometry sat 10+ units away, then span it -- so they
  // swept out a huge arc and left the flat entirely, which is the "particles
  // shifted out of map" bug. Here the geometry is generated centred on the
  // apartment and the object sits at the apartment's centre, so the same slow
  // spin keeps them inside the rooms. They also drift vertically instead of
  // only rotating, which reads better anyway.
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

    for (const l of furn.lamps) l.intensity = (l.userData.base as number) * live.lampI;
    for (const m of furn.lampGlow) m.emissiveIntensity = 0.05 + live.lampI * 1.6;
    for (const p of shell.daylightPanels) {
      const mat = p.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.45 * live.windowI;
      p.visible = live.windowI > 0.02;
    }
    for (const gmat of shell.glazing) {
      gmat.color.copy(live.sky).lerp(new THREE.Color(0xffffff), 0.35);
    }
    moteMat.opacity = 0.05 + (1 - live.envI) * 0.35;
    const outside = shell.root.getObjectByName('outside-shell') as THREE.Mesh | undefined;
    if (outside) (outside.material as THREE.MeshBasicMaterial).color.copy(live.sky);
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
    live.lampI = lerp(from.lampI, to.lampI, e);
    live.windowI = lerp(from.windowI, to.windowI, e);
    live.envI = lerp(from.envI, to.envI, e);
    live.bloom = lerp(from.bloom, to.bloom, e);
    live.exposure = lerp(from.exposure, to.exposure, e);
    apply();
  }

  // --- doors ---------------------------------------------------------------
  const doorById = new Map(shell.doors.map((d) => [d.id, d]));
  /** Doors opened because someone walked up to them, so they can shut again. */
  const autoHeld = new Set<string>();

  function requestDoor(id: string, open: boolean): void {
    const d = doorById.get(id);
    if (d) d.target = open ? 1 : 0;
  }

  /** Open any door the subject is close to; shut it once they've moved on. */
  function proximityDoors(subject: THREE.Vector3 | null): void {
    for (const d of shell.doors) {
      if (!subject) {
        if (autoHeld.has(d.id)) {
          d.target = 0;
          autoHeld.delete(d.id);
        }
        continue;
      }
      const dist = Math.hypot(subject.x - d.x, subject.z - d.z);
      if (dist < 1.5) {
        d.target = 1;
        autoHeld.add(d.id);
      } else if (dist > 2.3 && autoHeld.has(d.id)) {
        d.target = 0;
        autoHeld.delete(d.id);
      }
    }
  }

  // --- ceilings --------------------------------------------------------------
  let ceilingsOn = true;
  function setCeilingsVisible(v: boolean): void {
    ceilingsOn = v;
    for (const c of shell.ceilings) c.visible = v;
  }

  setTimeOfDay('day', true);

  return {
    root,
    patches: PATCHES,
    anchors: ANCHORS,
    doors: shell.doors,
    setTimeOfDay,
    timeOfDay: () => current,
    bloomStrength: () => live.bloom,
    exposure: () => live.exposure,
    requestDoor,
    setCeilingsVisible,
    ceilingsVisible: () => ceilingsOn,

    update(dt, elapsed, subject) {
      stepTransition(dt);
      proximityDoors(subject);
      updateDoors(shell.doors, dt);

      // motes: slow spin plus a gentle vertical bob
      motes.rotation.y += dt * 0.012;
      const arr = moteGeo.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < MOTES; i++) {
        const y = 0.25 + ((motePos[i * 3 + 1] - 0.25 + elapsed * 0.045 + motePhase[i] * 0.3)
          % (CEILING_H - 0.5));
        arr.setY(i, y);
      }
      arr.needsUpdate = true;

      // screens
      for (const s of furn.screens) {
        drawScreen(s.ctx, elapsed, s.hue);
        s.tex.needsUpdate = true;
      }
      for (const f of furn.fans) f.blades.rotation.y += dt * f.speed;
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
      lib.dispose();
      disposeGeoCache();
    },
  };
}
