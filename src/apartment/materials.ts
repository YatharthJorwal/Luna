/**
 * Materials, procedural textures, and the geometry primitives everything
 * else is built from.
 *
 * The single biggest reason the old apartment read as "low poly" wasn't
 * triangle count -- it was that every object was a hard-edged `BoxGeometry`
 * with one flat colour and a default roughness. Nothing caught a highlight
 * along an edge, so nothing looked like an object rather than a block.
 *
 * Two changes fix most of that, and they're both in here:
 *
 *   1. `rbox()` -- a rounded box. Even a 6mm radius gives every edge a
 *      specular highlight, which is what actually sells "this is a real
 *      piece of furniture" far more than extra polygons in the silhouette.
 *      Used for essentially all furniture; plain `box()` is kept for things
 *      genuinely sharp (glass panes, thin panels).
 *   2. Real PBR values per material family. Painted wood, raw oak, ceramic,
 *      brushed steel, fabric and glass all have quite different
 *      roughness/metalness, and with image-based lighting on (see
 *      lighting.ts) that difference is finally visible.
 *
 * Textures are generated on a canvas as before, but at 512-1024px instead of
 * 256 and with actual grain/grout/weave rather than flat fills, plus matching
 * roughness maps where it matters, so surfaces vary under a moving light
 * instead of reading as vinyl.
 */

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

export const PAL = {
  // warm neutrals
  cream: 0xf4ece0,
  offwhite: 0xeae3d8,
  paper: 0xfbf6ee,
  linen: 0xe8dfd0,
  // woods
  oak: 0xc89a6b,
  oakDk: 0x9a6f47,
  walnut: 0x6f4a31,
  birch: 0xdcc3a0,
  // pastels, the MiSide-ish register
  blush: 0xf0bfc6,
  blushDk: 0xd08e99,
  peach: 0xf7cba6,
  peachDk: 0xe0a071,
  mint: 0xbfe0cd,
  mintDk: 0x8ab8a0,
  sky: 0xc2dced,
  skyDk: 0x8fb4cd,
  lav: 0xd4c7e8,
  lavDk: 0xa896c8,
  rose: 0xdb98a4,
  sage: 0xaec2a6,
  // structural
  gold: 0xc9a572,
  brass: 0xb08d57,
  steel: 0xb9bdc2,
  charcoal: 0x3b3742,
  ink: 0x24212b,
  plum: 0x4a3f5c,
} as const;

// ---------------------------------------------------------------------------
// Canvas texture helpers
// ---------------------------------------------------------------------------

function canvas(size: number): { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('apartment: 2d canvas context unavailable');
  return { c, ctx };
}

function tex(
  draw: (ctx: CanvasRenderingContext2D, s: number) => void,
  size = 512,
  srgb = true,
): THREE.CanvasTexture {
  const { c, ctx } = canvas(size);
  draw(ctx, size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  // Colour maps are sRGB; data maps (roughness, normal-ish) must stay linear
  // or the renderer will gamma-decode values that aren't colours.
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Deterministic noise so textures don't reshuffle between reloads. */
let seed = 1337;
function rnd(): number {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
}

function grain(ctx: CanvasRenderingContext2D, s: number, amount: number, alpha: number): void {
  for (let i = 0; i < amount; i++) {
    const g = Math.floor(rnd() * 90) + 80;
    ctx.fillStyle = `rgba(${g},${g},${g},${alpha})`;
    ctx.fillRect(rnd() * s, rnd() * s, 1 + rnd() * 2, 1 + rnd() * 2);
  }
}

// --- floors ---------------------------------------------------------------

/** Oak plank flooring: staggered boards, per-board tint variation, grain. */
function oakPlanks(): THREE.CanvasTexture {
  return tex((ctx, s) => {
    const rows = 6;
    const h = s / rows;
    ctx.fillStyle = '#c08f5f';
    ctx.fillRect(0, 0, s, s);
    for (let r = 0; r < rows; r++) {
      const y = r * h;
      const offset = (r % 2) * (s / 3) + (r % 3) * (s / 9);
      for (let bx = -s; bx < s * 2; bx += s / 2.2) {
        const x = bx + offset;
        const w = s / 2.2;
        // Board base tint -- the variation between boards is what reads as wood.
        const l = 46 + rnd() * 16;
        ctx.fillStyle = `hsl(${26 + rnd() * 8}, ${32 + rnd() * 12}%, ${l}%)`;
        ctx.fillRect(x, y, w - 2, h - 2);
        // Grain lines along the board.
        ctx.strokeStyle = `rgba(88,58,32,${0.06 + rnd() * 0.08})`;
        ctx.lineWidth = 1;
        for (let g = 0; g < 9; g++) {
          const gy = y + 3 + rnd() * (h - 6);
          ctx.beginPath();
          ctx.moveTo(x, gy);
          ctx.bezierCurveTo(x + w * 0.3, gy + (rnd() - 0.5) * 4, x + w * 0.7, gy + (rnd() - 0.5) * 4, x + w, gy);
          ctx.stroke();
        }
        // Bevel between boards: dark on two sides, light on the others.
        ctx.strokeStyle = 'rgba(60,38,20,0.5)';
        ctx.strokeRect(x + 0.5, y + 0.5, w - 2, h - 2);
      }
    }
    grain(ctx, s, 5000, 0.035);
  }, 1024);
}

/** Square tile with grout -- `cool` swaps the warm cream for a pale blue. */
function tiles(cool: boolean, n: number): THREE.CanvasTexture {
  return tex((ctx, s) => {
    const cell = s / n;
    ctx.fillStyle = cool ? '#b9c6cc' : '#c9b9a4';
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const alt = (i + j) % 2 === 0;
        const hue = cool ? 196 : 32;
        const sat = cool ? 26 : 30;
        const lig = (alt ? 92 : 86) + (rnd() - 0.5) * 3;
        ctx.fillStyle = `hsl(${hue}, ${sat}%, ${lig}%)`;
        const g = cell * 0.035;
        ctx.fillRect(i * cell + g, j * cell + g, cell - g * 2, cell - g * 2);
        // Soft sheen toward one corner so tiles aren't perfectly flat.
        const grd = ctx.createLinearGradient(i * cell, j * cell, (i + 1) * cell, (j + 1) * cell);
        grd.addColorStop(0, 'rgba(255,255,255,0.10)');
        grd.addColorStop(1, 'rgba(0,0,0,0.05)');
        ctx.fillStyle = grd;
        ctx.fillRect(i * cell + g, j * cell + g, cell - g * 2, cell - g * 2);
      }
    }
    grain(ctx, s, 2200, 0.03);
  }, 1024);
}

/** Roughness companion for tiles: grout lines are rough, tile faces glossy. */
function tileRough(n: number): THREE.CanvasTexture {
  return tex((ctx, s) => {
    const cell = s / n;
    ctx.fillStyle = '#d8d8d8'; // grout: rough
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const g = cell * 0.035;
        const v = 40 + rnd() * 18; // tile face: fairly smooth
        ctx.fillStyle = `rgb(${v},${v},${v})`;
        ctx.fillRect(i * cell + g, j * cell + g, cell - g * 2, cell - g * 2);
      }
    }
  }, 512, false);
}

// --- walls ----------------------------------------------------------------

/** Painted plaster: a flat colour plus very low-frequency mottling. */
function plaster(hex: string, mottle = 0.04): THREE.CanvasTexture {
  return tex((ctx, s) => {
    ctx.fillStyle = hex;
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 90; i++) {
      const r = s * (0.08 + rnd() * 0.22);
      const g = ctx.createRadialGradient(rnd() * s, rnd() * s, 0, rnd() * s, rnd() * s, r);
      const a = mottle * (0.4 + rnd() * 0.6);
      g.addColorStop(0, `rgba(255,255,255,${a})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, s, s);
    }
    grain(ctx, s, 3000, 0.022);
  }, 512);
}

/** Vertical-stripe wallpaper, for the living room. */
function stripePaper(base: string, stripe: string): THREE.CanvasTexture {
  return tex((ctx, s) => {
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, s, s);
    ctx.fillStyle = stripe;
    for (let x = 0; x < s; x += s / 8) {
      ctx.fillRect(x, 0, s / 46, s);
      ctx.fillRect(x + s / 22, 0, s / 120, s);
    }
    grain(ctx, s, 2600, 0.02);
  }, 512);
}

/** Small repeating floral/diamond print, for the bedroom. */
function bedroomPaper(): THREE.CanvasTexture {
  return tex((ctx, s) => {
    ctx.fillStyle = '#efd7de';
    ctx.fillRect(0, 0, s, s);
    const n = 6;
    const cell = s / n;
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1.5;
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n; j++) {
        const cx = i * cell;
        const cy = j * cell;
        // little four-petal motif
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        for (let p = 0; p < 4; p++) {
          const a = (p / 4) * Math.PI * 2;
          ctx.beginPath();
          ctx.ellipse(cx + Math.cos(a) * cell * 0.11, cy + Math.sin(a) * cell * 0.11,
            cell * 0.075, cell * 0.042, a, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = 'rgba(214,150,166,0.5)';
        ctx.beginPath();
        ctx.arc(cx, cy, cell * 0.035, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    grain(ctx, s, 2200, 0.02);
  }, 512);
}

/** Glossy subway tile, kitchen splashback and bathroom walls. */
function subway(hex: string): THREE.CanvasTexture {
  return tex((ctx, s) => {
    const rows = 8;
    const h = s / rows;
    ctx.fillStyle = '#cfcfcb';
    ctx.fillRect(0, 0, s, s);
    for (let r = 0; r < rows; r++) {
      const y = r * h;
      const off = (r % 2) * (s / 8);
      for (let x = -s / 4; x < s; x += s / 4) {
        ctx.fillStyle = hex;
        ctx.fillRect(x + off + 1.5, y + 1.5, s / 4 - 3, h - 3);
        const g = ctx.createLinearGradient(x + off, y, x + off, y + h);
        g.addColorStop(0, 'rgba(255,255,255,0.22)');
        g.addColorStop(0.5, 'rgba(255,255,255,0.02)');
        g.addColorStop(1, 'rgba(0,0,0,0.07)');
        ctx.fillStyle = g;
        ctx.fillRect(x + off + 1.5, y + 1.5, s / 4 - 3, h - 3);
      }
    }
  }, 512);
}

/** Woven fabric weave, for upholstery and rugs. */
function weave(hex: string, dark: string): THREE.CanvasTexture {
  return tex((ctx, s) => {
    ctx.fillStyle = hex;
    ctx.fillRect(0, 0, s, s);
    const step = 5;
    for (let y = 0; y < s; y += step) {
      for (let x = 0; x < s; x += step) {
        const on = ((x / step) + (y / step)) % 2 === 0;
        ctx.fillStyle = on ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.10)';
        ctx.fillRect(x, y, step, step);
      }
    }
    ctx.strokeStyle = dark;
    ctx.globalAlpha = 0.12;
    for (let i = 0; i < 260; i++) {
      const y = rnd() * s;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(s, y + (rnd() - 0.5) * 3);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    grain(ctx, s, 4000, 0.05);
  }, 512);
}

// ---------------------------------------------------------------------------
// Texture + material registries (built lazily so importing this module is
// free until an apartment is actually constructed)
// ---------------------------------------------------------------------------

export interface MaterialLib {
  floor: Record<'oak' | 'tileWarm' | 'tileCool' | 'rug', THREE.MeshStandardMaterial>;
  wall: Record<'living' | 'kitchen' | 'hall' | 'bedroom' | 'bathroom', THREE.MeshStandardMaterial>;
  ceiling: THREE.MeshStandardMaterial;
  trim: THREE.MeshStandardMaterial;
  splashback: THREE.MeshStandardMaterial;
  glass: THREE.MeshPhysicalMaterial;
  frosted: THREE.MeshPhysicalMaterial;
  mirror: THREE.MeshStandardMaterial;
  /** Painted MDF / lacquered furniture. */
  paint(color: number, rough?: number): THREE.MeshStandardMaterial;
  /** Raw or oiled timber. */
  wood(color: number, rough?: number): THREE.MeshStandardMaterial;
  /** Upholstery and soft furnishings. */
  fabric(color: number): THREE.MeshStandardMaterial;
  /** Chrome, brass, steel. */
  metal(color: number, rough?: number): THREE.MeshStandardMaterial;
  /** Glazed ceramic: sinks, mugs, tiles. */
  ceramic(color: number): THREE.MeshStandardMaterial;
  /** Self-lit surfaces -- lamp shades, screens, LEDs. */
  emissive(color: number, strength: number): THREE.MeshStandardMaterial;
  /** Leaves and stems. */
  foliage(color: number): THREE.MeshStandardMaterial;
  dispose(): void;
}

export function createMaterials(): MaterialLib {
  seed = 1337; // reset so textures are identical run to run
  const owned: Array<{ dispose(): void }> = [];
  const keep = <T extends { dispose(): void }>(x: T): T => {
    owned.push(x);
    return x;
  };

  const oakTex = keep(oakPlanks());
  oakTex.repeat.set(3.2, 3.2);
  const warmTex = keep(tiles(false, 8));
  warmTex.repeat.set(2.4, 2.4);
  const coolTex = keep(tiles(true, 10));
  coolTex.repeat.set(2.0, 2.0);
  const coolRough = keep(tileRough(10));
  coolRough.repeat.set(2.0, 2.0);
  const warmRough = keep(tileRough(8));
  warmRough.repeat.set(2.4, 2.4);
  const rugTex = keep(weave('#d8c4d6', '#8f7a92'));
  rugTex.repeat.set(2, 2);

  const floor = {
    oak: new THREE.MeshStandardMaterial({ map: oakTex, roughness: 0.55, metalness: 0.0 }),
    tileWarm: new THREE.MeshStandardMaterial({ map: warmTex, roughnessMap: warmRough, roughness: 0.75, metalness: 0.02 }),
    tileCool: new THREE.MeshStandardMaterial({ map: coolTex, roughnessMap: coolRough, roughness: 0.55, metalness: 0.03 }),
    rug: new THREE.MeshStandardMaterial({ map: rugTex, roughness: 0.94, metalness: 0 }),
  };

  const livingTex = keep(stripePaper('#e9ddc9', 'rgba(198,168,126,0.34)'));
  livingTex.repeat.set(3.5, 1.4);
  const kitchenTex = keep(plaster('#dfe6dc', 0.05));
  kitchenTex.repeat.set(2.5, 1.2);
  const hallTex = keep(plaster('#e6ddd0', 0.05));
  hallTex.repeat.set(4, 1.2);
  const bedTex = keep(bedroomPaper());
  bedTex.repeat.set(2.6, 1.3);
  const bathTex = keep(subway('#d8e6e6'));
  bathTex.repeat.set(2.4, 1.3);

  const wall = {
    living: new THREE.MeshStandardMaterial({ map: livingTex, roughness: 0.92, metalness: 0 }),
    kitchen: new THREE.MeshStandardMaterial({ map: kitchenTex, roughness: 0.88, metalness: 0 }),
    hall: new THREE.MeshStandardMaterial({ map: hallTex, roughness: 0.9, metalness: 0 }),
    bedroom: new THREE.MeshStandardMaterial({ map: bedTex, roughness: 0.93, metalness: 0 }),
    bathroom: new THREE.MeshStandardMaterial({ map: bathTex, roughness: 0.35, metalness: 0.04 }),
  };

  const splashTex = keep(subway('#cfe3dd'));
  splashTex.repeat.set(3, 1.2);

  const cache = new Map<string, THREE.MeshStandardMaterial>();
  const shared = (key: string, make: () => THREE.MeshStandardMaterial) => {
    let m = cache.get(key);
    if (!m) {
      m = keep(make());
      cache.set(key, m);
    }
    return m;
  };

  return {
    floor,
    wall,
    ceiling: new THREE.MeshStandardMaterial({ color: 0xf6f2ec, roughness: 0.96, metalness: 0 }),
    trim: new THREE.MeshStandardMaterial({ color: 0xf7f4ee, roughness: 0.42, metalness: 0.02 }),
    splashback: new THREE.MeshStandardMaterial({ map: splashTex, roughness: 0.25, metalness: 0.05 }),
    glass: new THREE.MeshPhysicalMaterial({
      color: 0xdfeaf2, roughness: 0.02, metalness: 0, transmission: 0.92,
      thickness: 0.01, transparent: true, opacity: 0.32, side: THREE.DoubleSide,
    }),
    frosted: new THREE.MeshPhysicalMaterial({
      color: 0xdfe9ea, roughness: 0.62, metalness: 0, transmission: 0.72,
      thickness: 0.02, transparent: true, opacity: 0.55, side: THREE.DoubleSide,
    }),
    mirror: new THREE.MeshStandardMaterial({ color: 0xd9e2e6, roughness: 0.04, metalness: 1.0 }),

    paint: (c, r = 0.45) => shared(`p${c}${r}`, () =>
      new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: 0.02 })),
    wood: (c, r = 0.62) => shared(`w${c}${r}`, () =>
      new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: 0.0 })),
    fabric: (c) => shared(`f${c}`, () =>
      new THREE.MeshStandardMaterial({ color: c, roughness: 0.95, metalness: 0.0 })),
    metal: (c, r = 0.22) => shared(`m${c}${r}`, () =>
      new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: 0.92 })),
    ceramic: (c) => shared(`c${c}`, () =>
      new THREE.MeshStandardMaterial({ color: c, roughness: 0.12, metalness: 0.02 })),
    emissive: (c, s) => shared(`e${c}${s}`, () =>
      new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: s, roughness: 0.6 })),
    foliage: (c) => shared(`v${c}`, () =>
      new THREE.MeshStandardMaterial({ color: c, roughness: 0.78, metalness: 0, side: THREE.DoubleSide })),

    dispose(): void {
      for (const o of owned) o.dispose();
      for (const m of Object.values(floor)) m.dispose();
      for (const m of Object.values(wall)) m.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Geometry primitives
// ---------------------------------------------------------------------------

/** Geometry cache -- a flat has a lot of identical drawer fronts and legs. */
const geoCache = new Map<string, THREE.BufferGeometry>();
function cachedGeo(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = geoCache.get(key);
  if (!g) {
    g = make();
    geoCache.set(key, g);
  }
  return g;
}

export function disposeGeoCache(): void {
  for (const g of geoCache.values()) g.dispose();
  geoCache.clear();
}

/**
 * Rounded box -- the workhorse. `r` is the corner radius in metres and is
 * clamped so it can never exceed half the smallest dimension (RoundedBoxGeometry
 * produces inside-out geometry if it does, which shows up as a black object).
 */
export function rboxGeo(w: number, h: number, d: number, r = 0.012, seg = 2): THREE.BufferGeometry {
  const rr = Math.max(0.0005, Math.min(r, Math.min(w, h, d) / 2 - 0.0005));
  return cachedGeo(`rb${w}|${h}|${d}|${rr}|${seg}`, () => new RoundedBoxGeometry(w, h, d, seg, rr));
}

export function rbox(
  w: number, h: number, d: number, mat: THREE.Material, r = 0.012, seg = 2,
): THREE.Mesh {
  const m = new THREE.Mesh(rboxGeo(w, h, d, r, seg), mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** Sharp box -- for panes, thin panels, and anything genuinely square-edged. */
export function box(w: number, h: number, d: number, mat: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(cachedGeo(`b${w}|${h}|${d}`, () => new THREE.BoxGeometry(w, h, d)), mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

export function cyl(
  rt: number, rb: number, h: number, mat: THREE.Material, seg = 24, open = false,
): THREE.Mesh {
  const m = new THREE.Mesh(
    cachedGeo(`c${rt}|${rb}|${h}|${seg}|${open}`, () => new THREE.CylinderGeometry(rt, rb, h, seg, 1, open)),
    mat,
  );
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

export function sph(r: number, mat: THREE.Material, seg = 24): THREE.Mesh {
  const m = new THREE.Mesh(
    cachedGeo(`s${r}|${seg}`, () => new THREE.SphereGeometry(r, seg, Math.max(8, Math.round(seg * 0.6)))),
    mat,
  );
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

export function torus(r: number, tube: number, mat: THREE.Material, seg = 20): THREE.Mesh {
  const m = new THREE.Mesh(
    cachedGeo(`t${r}|${tube}|${seg}`, () => new THREE.TorusGeometry(r, tube, 14, seg)),
    mat,
  );
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

export function cone(r: number, h: number, mat: THREE.Material, seg = 28, open = false): THREE.Mesh {
  const m = new THREE.Mesh(
    cachedGeo(`k${r}|${h}|${seg}|${open}`, () => new THREE.ConeGeometry(r, h, seg, 1, open)),
    mat,
  );
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** Lathed profile, for turned legs, vases, basins. `pts` are [radius, y]. */
export function lathe(pts: Array<[number, number]>, mat: THREE.Material, seg = 28): THREE.Mesh {
  const key = `l${seg}|${pts.map((p) => p.join(',')).join(';')}`;
  const m = new THREE.Mesh(
    cachedGeo(key, () => new THREE.LatheGeometry(pts.map((p) => new THREE.Vector2(p[0], p[1])), seg)),
    mat,
  );
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/**
 * A soft cushion: a rounded box squashed slightly and given a dip in the
 * middle, so seating doesn't read as a stack of blocks.
 */
export function cushion(w: number, h: number, d: number, mat: THREE.Material, sag = 0.18): THREE.Mesh {
  const geo = new RoundedBoxGeometry(w, h, d, 5, Math.min(h * 0.45, 0.07));
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    if (y > 0) {
      // Dip the top face toward the centre.
      const nx = (x / (w / 2)) ** 2;
      const nz = (z / (d / 2)) ** 2;
      pos.setY(i, y - h * sag * Math.max(0, 1 - nx) * Math.max(0, 1 - nz));
    }
  }
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** Place and orient in one call. Returns the object for chaining. */
export function put<T extends THREE.Object3D>(o: T, x: number, y: number, z: number, ry = 0): T {
  o.position.set(x, y, z);
  o.rotation.y = ry;
  return o;
}

export function group(name?: string): THREE.Group {
  const g = new THREE.Group();
  if (name) g.name = name;
  return g;
}
