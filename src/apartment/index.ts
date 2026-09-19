/**
 * Builds the apartment and hands back a small control surface.
 *
 * Round 12 replaced the hand-authored procedural room/furniture/materials
 * system with a single prebuilt model,
 * `public/apartment/twokinds_modern_trio_apartment.glb`. Round 13 (this
 * file) is a real-usage bugfix pass on that model, after the user actually
 * ran it and sent back a video and screenshots. See docs/DECISIONS.md's
 * round-13 entry for the full account, including the exact glTF material
 * scalars this round's fixes are based on (pulled directly from the file's
 * own JSON, not guessed) and the MToon shader source that explains why she
 * was going nearly black at night.
 *
 * What round 13 added, on top of round 12's load-a-glb-and-light-it base:
 * - `fixupMaterials()`: a handful of named, evidenced corrections to
 *   specific materials in the model (not a blanket adjustment).
 * - A collision mesh built once from the loaded model via `three-mesh-bvh`,
 *   and `collidesAt()` on the returned handle, so visitor mode and Luna's
 *   own wandering can be blocked by real walls and furniture instead of
 *   only the placeholder footprint rectangle.
 * - A dedicated short-range point light that follows whoever's asked about
 *   (`update()`'s `subject` param) to keep her visible independent of the
 *   room's own mood lighting, since her MToon shader doesn't read
 *   `scene.environment` at all (confirmed from the shader source -- see
 *   DECISIONS.md) and was going nearly black wherever hemi+sun were low.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { computeBoundsTree, disposeBoundsTree, MeshBVH } from 'three-mesh-bvh';
import {
  CEILING_H, CENTRE, FOOTPRINT, PATCHES, ANCHORS, ROOMS,
  roomAt, anchorNear,
  type NavPatch, type Anchor, type RoomId,
} from './floorplan';

// Module-level, same pattern three-mesh-bvh's own docs use: extends
// THREE.BufferGeometry's prototype once so any geometry can build/hold a
// bounds tree. The package's own .d.ts augments THREE's types to match
// (BufferGeometry gains `.boundsTree`/`.computeBoundsTree`/
// `.disposeBoundsTree`), so this is fully typed, not an `any` hack.
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;

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
  /** IBL contribution. Note: this never reaches Luna's MToon materials --
   * see the fill-light comment below -- only the apartment's own PBR
   * furniture. */
  envI: number;
  /** Bloom strength, read by postfx. */
  bloom: number;
  /** Exposure, read by the renderer. */
  exposure: number;
  /** Intensity of Luna's personal fill light (see below). Independent of
   * the room's own mood lighting on purpose. */
  fillI: number;
  /** emissiveIntensity for the model's "light_window" material (a baked
   * warm-glow-at-the-window trick prop, on by default regardless of scene
   * lighting since emissive ignores scene lights) -- driven down at night
   * so windows don't look like daytime after dark. */
  lightWindowI: number;
}

function st(s: {
  sky: number; bg: number; fogNear: number; fogFar: number;
  hemiSky: number; hemiGround: number; hemiI: number;
  sunColor: number; sunI: number; sunPos: [number, number, number];
  envI: number; bloom: number; exposure: number; fillI: number; lightWindowI: number;
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
    fillI: s.fillI,
    lightWindowI: s.lightWindowI,
  };
}

/**
 * Four times of day, revised for round 13 against real feedback (a video +
 * screenshots), not just reasoned in the dark like round 12's first pass.
 * What changed and why, in order of how much it mattered:
 *
 * 1. Luna's visibility is no longer this table's job at all -- `fillI`
 *    drives a dedicated light that follows her (see `buildApartment`
 *    below), decoupled from the room's mood lighting, because her MToon
 *    shader doesn't read `envI`/IBL and was defaulting to near-black
 *    wherever hemi+sun were low. Night's hemi/sun stay deliberately dim
 *    here for the room's own mood -- that's no longer in tension with her
 *    being visible.
 * 2. Overall levels trimmed a little further, on top of round 12's already-
 *    conservative numbers, now that the worst-offending materials
 *    (pure-white-by-default porcelain/couch, near-mirror gold hardware --
 *    see fixupMaterials below) are corrected at the source rather than
 *    fought with lower light alone.
 * 3. `lightWindowI` added -- see the LightState comment above.
 */
const MODES: Record<TimeOfDay, LightState> = {
  dawn: st({
    sky: 0xf0c6b4, bg: 0xe8bfae, fogNear: 16, fogFar: 60,
    hemiSky: 0xffd8c0, hemiGround: 0x6a5a5e, hemiI: 0.48,
    sunColor: 0xffb98a, sunI: 1.3, sunPos: [CENTRE.x - 14, 8, CENTRE.z + 10],
    envI: 0.45, bloom: 0.35, exposure: 1.0, fillI: 1.2, lightWindowI: 0.8,
  }),
  day: st({
    sky: 0xbfd9ef, bg: 0xc9e0f2, fogNear: 24, fogFar: 90,
    hemiSky: 0xf4f9ff, hemiGround: 0xa89880, hemiI: 0.55,
    sunColor: 0xfff3e0, sunI: 1.5, sunPos: [CENTRE.x - 12, 15, CENTRE.z + 8],
    envI: 0.5, bloom: 0.24, exposure: 0.92, fillI: 0, lightWindowI: 1.0,
  }),
  dusk: st({
    sky: 0xe9a479, bg: 0xd9906d, fogNear: 14, fogFar: 55,
    hemiSky: 0xffc094, hemiGround: 0x5a4650, hemiI: 0.38,
    sunColor: 0xff9552, sunI: 1.3, sunPos: [CENTRE.x - 16, 5, CENTRE.z + 4],
    envI: 0.34, bloom: 0.4, exposure: 1.0, fillI: 1.6, lightWindowI: 0.6,
  }),
  night: st({
    sky: 0x1d1a30, bg: 0x141222, fogNear: 9, fogFar: 40,
    hemiSky: 0x3a3a68, hemiGround: 0x14111f, hemiI: 0.16,
    sunColor: 0x9fb4ff, sunI: 0.12, sunPos: [CENTRE.x + 8, 10, CENTRE.z - 8],
    envI: 0.1, bloom: 0.5, exposure: 1.0, fillI: 3, lightWindowI: 0.12,
  }),
};

function cloneState(s: LightState): LightState {
  return {
    sky: s.sky.clone(), bg: s.bg.clone(), fogNear: s.fogNear, fogFar: s.fogFar,
    hemiSky: s.hemiSky.clone(), hemiGround: s.hemiGround.clone(), hemiI: s.hemiI,
    sunColor: s.sunColor.clone(), sunI: s.sunI, sunPos: s.sunPos.clone(),
    envI: s.envI, bloom: s.bloom, exposure: s.exposure,
    fillI: s.fillI, lightWindowI: s.lightWindowI,
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
  /** Per-frame tick. `subject` positions the personal fill light -- pass
   * whoever the "camera" currently follows (Luna's own position works for
   * both modes; see sandbox.ts's call site). */
  update(dt: number, elapsed: number, subject: THREE.Vector3 | null): void;
  setTimeOfDay(t: TimeOfDay, instant?: boolean): void
  timeOfDay(): TimeOfDay;
  /** Current bloom strength / exposure for the post chain to follow. */
  bloomStrength(): number;
  exposure(): number;
  /** True if a person-sized obstruction at this floor point would
   * intersect the model's real geometry -- walls, furniture, anything.
   * Backed by a one-time BVH built from the loaded model (see
   * `buildCollisionGeometry`); a few stacked sphere checks rather than a
   * full capsule sweep -- see docs/DECISIONS.md's round-13 entry for why
   * that's a deliberate, documented simplification rather than an
   * oversight. */
  collidesAt(x: number, z: number): boolean;
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

/**
 * A handful of specific, evidenced corrections to named materials in the
 * loaded model -- not a blanket "make everything darker" pass. Every value
 * here traces to an exact PBR scalar read directly out of the file's own
 * glTF JSON (parsed by hand, not guessed -- see docs/DECISIONS.md's
 * round-13 entry for the full dump), in response to the user's report that
 * "sofa, toilet, doorhinge" glow absurdly:
 *
 * - `Porcelain_-_White` (near-certainly the toilet/sink) and `Couch_Beige`/
 *   `Couch_BeigeDark` (near-certainly the sofa) all have NO baseColorFactor
 *   override in the file at all -- meaning they render at glTF's spec
 *   default of pure (1,1,1,1) white, despite names that say "beige" and
 *   "porcelain". That's almost certainly an authoring gap (the artist
 *   never actually set a color, or a legacy diffuse texture didn't survive
 *   export) rather than a deliberate choice, and pure-1.0-albedo surfaces
 *   are the single easiest thing to blow out in any physically-based
 *   renderer -- real porcelain and real beige fabric both sit well under
 *   1.0. Given real, appropriately-toned colors here instead.
 * - `Gold` (the likely doorhinge/hardware material) is fully metallic
 *   (metallicFactor unset -> glTF default 1.0) at roughnessFactor 0.15 --
 *   close enough to a mirror finish to throw a tight, easily-blown-out
 *   highlight under any real light. Roughness raised, not despecularized
 *   -- it should still read as glossy metal, just not a pinpoint hotspot.
 * - `screen` (roughnessFactor 0, emissiveFactor (1,1,1), matches the
 *   living-room TV blown out white in the user's video) gets both its
 *   emissive strength and its mirror-flat roughness pulled back a little.
 *   `Sims_Screen`/`Desktop_Screen` share the identical scalars but read
 *   fine in the same footage (different, less uniformly-bright texture
 *   content), so they're left untouched rather than dimmed on suspicion
 *   alone.
 *
 * Returns the `light_window` material if the model has one, so the caller
 * can drive its emissiveIntensity by time of day (see the LightState
 * comment on `lightWindowI`).
 */
function fixupMaterials(model: THREE.Object3D): THREE.MeshStandardMaterial | null {
  let lightWindow: THREE.MeshStandardMaterial | null = null;
  const seen = new Set<THREE.Material>();
  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (!m || seen.has(m)) continue;
      seen.add(m);
      const std = m as THREE.MeshStandardMaterial;
      switch (m.name) {
        case 'Porcelain_-_White':
          std.color.setRGB(0.86, 0.84, 0.8);
          break;
        case 'Couch_Beige':
          std.color.setRGB(0.75, 0.66, 0.53);
          break;
        case 'Couch_BeigeDark':
          std.color.setRGB(0.46, 0.4, 0.32);
          break;
        case 'Gold':
          std.roughness = Math.max(std.roughness, 0.38);
          break;
        case 'screen':
          std.emissiveIntensity = 0.55;
          std.roughness = Math.max(std.roughness, 0.12);
          break;
        case 'light_window':
          lightWindow = std;
          break;
        default:
          break;
      }
      // General safety net, on top of the named fixes above: "many things
      // are still glowing" came back after the screen-only fix, and the
      // file has several more materials at or near spec-maximum emissive
      // (Sims_Screen/Desktop_Screen/RGB_Material/the *_glow family all sit
      // at (1,1,1)-ish -- see docs/DECISIONS.md's round-13 entry for the
      // full dump) that weren't touched because nothing in the round-13
      // footage specifically showed them blown out. Rather than keep
      // whack-a-moling individual names off partial evidence, cap every
      // material's *effective* emissive brightness (color x intensity)
      // uniformly: harmless for anything already under the cap (most of
      // the fixes above land well under it already), and catches whatever
      // else is still glowing without needing to know its name.
      if (std.emissive) {
        const peak = Math.max(std.emissive.r, std.emissive.g, std.emissive.b) * std.emissiveIntensity;
        const cap = 0.85;
        if (peak > cap) std.emissiveIntensity *= cap / peak;
      }
    }
  });
  return lightWindow;
}

/**
 * Builds a one-time collision mesh from the loaded model: every mesh's
 * geometry, stripped down to just positions (collision doesn't need UVs/
 * normals/color, and stripping to one common attribute set is what makes
 * `mergeGeometries` willing to merge 445 differently-authored meshes at
 * all), baked into world space via each mesh's own `matrixWorld`, then
 * merged into one BufferGeometry and handed a bounds tree. One BVH query
 * against one merged mesh, in world space, with no per-mesh transform math
 * at query time -- much simpler than the alternative (one bounds tree per
 * source mesh, transforming every query into 445 different local spaces).
 */
function buildCollisionGeometry(model: THREE.Object3D): THREE.BufferGeometry {
  model.updateWorldMatrix(true, true);
  const parts: THREE.BufferGeometry[] = [];
  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const pos = mesh.geometry.getAttribute('position');
    if (!pos || pos.count === 0) return;
    let g = new THREE.BufferGeometry();
    g.setAttribute('position', pos.clone());
    if (mesh.geometry.index) g.setIndex(mesh.geometry.index.clone());
    g = g.toNonIndexed(); // guarantees every part is indexed the same way (none)
    g.applyMatrix4(mesh.matrixWorld);
    parts.push(g);
  });
  const merged = parts.length > 0 ? mergeGeometries(parts, false) : null;
  for (const g of parts) g.dispose();
  const result = merged ?? new THREE.BufferGeometry();
  result.computeBoundsTree();
  return result;
}

// Three height samples along a standing person (ankle/waist/head) rather
// than a full capsule-vs-triangle sweep. A real capsule solve (the
// technique three-mesh-bvh's own examples use) resolves penetration
// smoothly and handles grazing contact better; this is the cheaper
// "would a sphere here hit anything" check at a few heights, run through
// the existing axis-decomposed sliding movement camera-modes.ts already
// had for the placeholder rectangle. It should catch the reported problems
// (walking through walls, ending up inside furniture) -- what it won't
// perfectly handle is a very thin obstruction between two sample heights,
// or fully smooth sliding along a curved surface. Untested against the
// real running app (no browser in this sandbox) -- flagged as the piece
// most likely to need a follow-up pass once someone's actually walked
// around with it.
//
// The lowest sample deliberately starts well above the floor, not at
// ankle height: a first attempt at 0.15 with this same radius put the
// sphere's bottom at -0.15, comfortably inside the floor slab itself
// (real bbox min y is -0.08) -- caught the floor as an "obstruction"
// everywhere, not just real furniture/walls. Verified with the actual
// harness below: that version blocked 90% of the whole footprint, which
// is obviously the floor, not real coverage. 0.45 keeps the sphere's
// bottom at 0.15, clear of any floor slab, while still catching
// low furniture (a coffee table, a low shelf).
const COLLIDE_RADIUS = 0.3;
const COLLIDE_HEIGHTS = [0.45, 0.95, 1.45];

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

  const lightWindowMat = fixupMaterials(model);
  const collisionGeometry = buildCollisionGeometry(model);
  const collisionBVH = collisionGeometry.boundsTree as MeshBVH | undefined;
  const _collideSphere = new THREE.Sphere();
  function collidesAt(x: number, z: number): boolean {
    if (!collisionBVH) return false;
    for (const y of COLLIDE_HEIGHTS) {
      _collideSphere.center.set(x, y, z);
      _collideSphere.radius = COLLIDE_RADIUS;
      if (collisionBVH.intersectsSphere(_collideSphere)) return true;
    }
    return false;
  }

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

  // --- personal fill light ---------------------------------------------------
  // Her MToon materials don't read scene.environment at all (no
  // envmap_fragment include in @pixiv/three-vrm-materials-mtoon's shader --
  // confirmed straight from the source, not assumed), and blend toward a
  // shadeColor that defaults to pure black wherever direct+hemisphere light
  // is too low. Keeping the room's own hemi/sun low at night for mood was
  // therefore also making HER nearly invisible, independent of anything
  // wrong with the room. A point light that follows her, decoupled from
  // room mood lighting entirely, fixes that without fighting the room's
  // own look -- same idea as a key/fill light on an actor being separate
  // from set lighting.
  //
  // Round 13 positioned this at subject.y + 1.4 (chest height) and 0.35m
  // in front -- close enough to her own body surface, at intensity 11,
  // that PointLight's physically-correct falloff (intensity / distance^
  // decay) blew her out into a solid white ghost (confirmed from a real
  // screenshot, not reasoned): at roughly 0.2-0.3m from light to skin and
  // decay 1.8, the falloff factor alone is a 8-25x amplification on top of
  // the nominal intensity. Moved well above her head instead (2.3m, versus
  // her own ~1.6m height) so the minimum light-to-body distance is closer
  // to 2m regardless of exact pose, `distance` extended to reach her from
  // there, and `decay` softened (1.8 -> 1.4) so it's less punishing if the
  // exact distance ends up a bit off again. Intensities cut hard
  // (night 11 -> 4) on top of that repositioning, not instead of it --
  // exact numbers are still a guess, just a much better-grounded one.
  const lunaFill = new THREE.PointLight(0xfff2e0, 0, 5.5, 1.4);
  lunaFill.castShadow = false;
  scene.add(lunaFill);

  // --- ambient motes, fixed --------------------------------------------------
  // Bigger, more numerous, and a higher opacity floor than round 12 -- the
  // user asked for a more noticeably "dreamy" effect; round 12's motes were
  // technically present but too sparse/small to read as intentional.
  const MOTES = 320;
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
    size: 0.055, map: moteTex, transparent: true, opacity: 0.0,
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
    lunaFill.intensity = live.fillI;
    if (lightWindowMat) lightWindowMat.emissiveIntensity = live.lightWindowI;
    scene.environmentIntensity = live.envI;
    moteMat.opacity = 0.18 + (1 - live.envI) * 0.35;
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
    live.fillI = lerp(from.fillI, to.fillI, e);
    live.lightWindowI = lerp(from.lightWindowI, to.lightWindowI, e);
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
    collidesAt,

    update(dt, elapsed, subject) {
      stepTransition(dt);

      if (subject) {
        lunaFill.position.set(subject.x, subject.y + 2.3, subject.z);
      }

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
      collisionGeometry.disposeBoundsTree();
      collisionGeometry.dispose();
      disposeModel(model);
    },
  };
}
