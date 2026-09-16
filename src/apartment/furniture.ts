/**
 * Furniture.
 *
 * The rule throughout: nothing is a bare cube. Every piece gets at least a
 * rounded edge, a separate top/carcass/leg material, and one piece of
 * secondary detail (a handle, a seam, a cushion, a stack of something). That
 * is what the previous pass was missing -- it wasn't polygon count, it was
 * that a sofa was three boxes and read as three boxes.
 *
 * Each builder returns a Group positioned in world space, and registers any
 * lamp it owns into `lamps` so the day/night system can dim them together.
 */

import * as THREE from 'three';
import {
  PAL, rbox, box, cyl, sph, torus, lathe, cushion, put, group,
  type MaterialLib,
} from './materials';

export interface Furnishings {
  root: THREE.Group;
  /** Lamp bulbs, dimmed/brightened by the time-of-day modes. */
  lamps: THREE.PointLight[];
  /** Shades and bulbs that glow with their lamp. */
  lampGlow: THREE.MeshStandardMaterial[];
  /** Live canvas screens (monitor, TV) updated each frame. */
  screens: Array<{ ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture; hue: number }>;
  /** The ceiling fan, if there is one. */
  fans: Array<{ blades: THREE.Group; speed: number }>;
}

// ---------------------------------------------------------------------------
// Shared sub-assemblies
// ---------------------------------------------------------------------------

function screenTexture(out: Furnishings, hue: number, w = 256, h = 160) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('apartment: 2d canvas context unavailable');
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  out.screens.push({ ctx, tex, hue });
  return tex;
}

/** Draw one frame of the abstract "something is playing" screen content. */
export function drawScreen(ctx: CanvasRenderingContext2D, t: number, hue: number): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, `hsl(${(hue + t * 7) % 360}, 62%, 58%)`);
  g.addColorStop(0.55, `hsl(${(hue + 45 + t * 7) % 360}, 66%, 50%)`);
  g.addColorStop(1, `hsl(${(hue + 95 + t * 7) % 360}, 58%, 42%)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 4; i++) {
    const p = t * 0.35 + i * 0.7;
    ctx.fillStyle = `rgba(255,255,255,${0.05 + 0.05 * Math.sin(p)})`;
    ctx.beginPath();
    ctx.arc(w * (0.2 + 0.3 * Math.sin(p * 0.6 + i)), h * (0.4 + 0.3 * Math.cos(p * 0.5 + i)),
      h * (0.16 + 0.08 * Math.sin(p)), 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Table/desk lamp: turned base, fabric shade, real point light. */
function tableLamp(
  lib: MaterialLib, out: Furnishings, shade: number, base: number, scale = 1,
): THREE.Group {
  const g = group();
  const baseM = lib.ceramic(base);
  g.add(put(lathe([
    [0.0, 0], [0.085, 0], [0.09, 0.012], [0.055, 0.04],
    [0.03, 0.09], [0.026, 0.22], [0.03, 0.26], [0.0, 0.26],
  ], baseM), 0, 0, 0));

  const glow = lib.emissive(shade, 0.0).clone();
  out.lampGlow.push(glow);
  const shadeMesh = cyl(0.105, 0.145, 0.15, glow, 30, true);
  shadeMesh.material = glow;
  g.add(put(shadeMesh, 0, 0.33, 0));
  // Trim rings top and bottom stop the shade reading as a paper cone.
  g.add(put(torus(0.105, 0.006, lib.metal(PAL.brass), 26), 0, 0.405, 0)).rotateX(0);
  const r1 = torus(0.145, 0.006, lib.metal(PAL.brass), 26);
  r1.rotation.x = Math.PI / 2;
  g.add(put(r1, 0, 0.255, 0));
  const r2 = torus(0.105, 0.006, lib.metal(PAL.brass), 26);
  r2.rotation.x = Math.PI / 2;
  g.add(put(r2, 0, 0.405, 0));

  const bulb = new THREE.PointLight(0xffd9a8, 0, 4.2, 2);
  bulb.position.set(0, 0.33, 0);
  bulb.userData.base = 1.5;
  out.lamps.push(bulb);
  g.add(bulb);

  g.scale.setScalar(scale);
  return g;
}

/** Pendant lamp hanging from the ceiling. */
function pendant(
  lib: MaterialLib, out: Furnishings, ceilingY: number, y: number, shade: number, r = 0.19,
): THREE.Group {
  const g = group();
  const cordLen = ceilingY - y;
  g.add(put(cyl(0.006, 0.006, cordLen, lib.metal(0x4a4a4e, 0.6), 8), 0, y + cordLen / 2, 0));
  g.add(put(cyl(0.035, 0.045, 0.03, lib.metal(0x4a4a4e, 0.5), 14), 0, ceilingY - 0.015, 0));

  const glow = lib.emissive(shade, 0.0).clone();
  out.lampGlow.push(glow);
  const domeGeo = new THREE.SphereGeometry(r, 30, 16, 0, Math.PI * 2, 0, Math.PI * 0.52);
  const dome = new THREE.Mesh(domeGeo, glow);
  dome.castShadow = true;
  g.add(put(dome, 0, y, 0));
  const rim = torus(r * 0.995, 0.008, lib.metal(PAL.brass), 30);
  rim.rotation.x = Math.PI / 2;
  g.add(put(rim, 0, y - 0.002, 0));

  const inner = sph(0.05, lib.emissive(0xfff0d4, 1.4), 14);
  g.add(put(inner, 0, y - 0.04, 0));

  const bulb = new THREE.PointLight(0xffe2ba, 0, 6.5, 2);
  bulb.position.set(0, y - 0.05, 0);
  bulb.userData.base = 2.6;
  bulb.castShadow = false;
  out.lamps.push(bulb);
  g.add(bulb);
  return g;
}

/** Potted plant with layered leaves rather than a green blob. */
function plant(lib: MaterialLib, scale = 1, potColor: number = PAL.peachDk): THREE.Group {
  const g = group();
  g.add(put(lathe([
    [0, 0], [0.11, 0], [0.125, 0.02], [0.115, 0.17], [0.13, 0.2], [0.125, 0.215], [0, 0.215],
  ], lib.ceramic(potColor)), 0, 0, 0));
  const soil = cyl(0.115, 0.115, 0.02, lib.paint(0x3f3228, 0.98), 20);
  g.add(put(soil, 0, 0.205, 0));

  const greens = [0x5f8c52, 0x6f9e5e, 0x84ae6b, 0x547d4a];
  for (let i = 0; i < 22; i++) {
    const a = (i / 22) * Math.PI * 2 + Math.random();
    const len = 0.18 + Math.random() * 0.22;
    const lean = 0.35 + Math.random() * 0.75;
    const leafGeo = new THREE.SphereGeometry(len * 0.5, 10, 7);
    const leaf = new THREE.Mesh(leafGeo, lib.foliage(greens[i % greens.length]));
    leaf.scale.set(0.26, 1, 0.85);
    leaf.castShadow = true;
    leaf.position.set(Math.cos(a) * len * 0.42, 0.24 + len * 0.52, Math.sin(a) * len * 0.42);
    leaf.rotation.set(Math.cos(a) * lean * 0.5, -a, Math.sin(a) * lean * 0.5);
    g.add(leaf);
  }
  g.scale.setScalar(scale);
  return g;
}

/** A leaning stack of books. */
function books(lib: MaterialLib, n: number, w = 0.14): THREE.Group {
  const g = group();
  const cols = [PAL.blush, PAL.mint, PAL.sky, PAL.lav, PAL.peach, PAL.rose, PAL.sage];
  let y = 0;
  for (let i = 0; i < n; i++) {
    const h = 0.022 + Math.random() * 0.016;
    const b = rbox(w + Math.random() * 0.03, h, 0.2 + Math.random() * 0.04,
      lib.paint(cols[Math.floor(Math.random() * cols.length)], 0.72), 0.004);
    b.position.set((Math.random() - 0.5) * 0.02, y + h / 2, (Math.random() - 0.5) * 0.02);
    b.rotation.y = (Math.random() - 0.5) * 0.2;
    g.add(b);
    y += h;
  }
  return g;
}

/** Books standing on a shelf. */
function shelfBooks(lib: MaterialLib, x0: number, x1: number, y: number, z: number, g: THREE.Group, lib2 = lib): void {
  const cols = [PAL.blush, PAL.mint, PAL.sky, PAL.lav, PAL.peach, PAL.rose, PAL.blushDk, PAL.sage];
  let x = x0 + 0.02;
  while (x < x1 - 0.05) {
    const w = 0.022 + Math.random() * 0.026;
    const h = 0.17 + Math.random() * 0.07;
    const b = rbox(w, h, 0.15, lib2.paint(cols[Math.floor(Math.random() * cols.length)], 0.75), 0.003);
    b.position.set(x + w / 2, y + h / 2, z);
    b.rotation.z = Math.random() < 0.12 ? 0.12 : 0;
    g.add(b);
    x += w + 0.004;
  }
}

/** Generic cabinet run: carcass, plinth, doors with a reveal gap, handles. */
function cabinetRun(
  lib: MaterialLib, w: number, h: number, d: number,
  carcass: number, front: number, doors: number, handleMat: THREE.Material,
  drawersTop = false,
): THREE.Group {
  const g = group();
  g.add(put(rbox(w, h - 0.09, d, lib.paint(carcass, 0.55), 0.008), 0, 0.09 + (h - 0.09) / 2, 0));
  // Recessed plinth so the run looks like it sits on the floor properly.
  g.add(put(box(w - 0.06, 0.09, d - 0.07, lib.paint(0x8e867c, 0.8)), 0, 0.045, 0));

  const dw = w / doors;
  for (let i = 0; i < doors; i++) {
    const cx = -w / 2 + dw * (i + 0.5);
    if (drawersTop) {
      const dh = (h - 0.12) / 3;
      for (let k = 0; k < 3; k++) {
        const y = 0.1 + dh * (k + 0.5);
        g.add(put(rbox(dw - 0.012, dh - 0.01, 0.02, lib.paint(front, 0.4), 0.006), cx, y, d / 2 + 0.008));
        const hd = rbox(dw * 0.4, 0.014, 0.018, handleMat, 0.006);
        g.add(put(hd, cx, y, d / 2 + 0.024));
      }
    } else {
      g.add(put(rbox(dw - 0.012, h - 0.13, 0.02, lib.paint(front, 0.4), 0.006), cx, 0.1 + (h - 0.13) / 2, d / 2 + 0.008));
      const hd = rbox(0.016, 0.1, 0.018, handleMat, 0.007);
      g.add(put(hd, cx + dw * 0.36, h * 0.6, d / 2 + 0.024));
    }
  }
  return g;
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

function buildLiving(lib: MaterialLib, out: Furnishings, ceilingY: number): void {
  const g = group('living');
  out.root.add(g);

  // --- rug -----------------------------------------------------------------
  const rug = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 2.4), lib.floor.rug);
  rug.rotation.x = -Math.PI / 2;
  rug.position.set(3.0, 0.004, 3.0);
  rug.receiveShadow = true;
  g.add(rug);
  const rugEdge = box(3.28, 0.012, 2.48, lib.fabric(0xb9a0bd));
  rugEdge.position.set(3.0, 0.006, 3.0);
  rugEdge.castShadow = false;
  g.add(rugEdge);

  // --- sofa, against the west wall ----------------------------------------
  const sofa = group();
  const fab = lib.fabric(PAL.peach);
  const fabDk = lib.fabric(PAL.peachDk);
  sofa.add(put(rbox(0.95, 0.30, 2.30, fab, 0.05), 0, 0.30, 0));
  sofa.add(put(rbox(0.26, 0.62, 2.30, fab, 0.07), -0.34, 0.62, 0));   // back
  for (const zz of [-1.02, 1.02]) {                                    // arms
    sofa.add(put(rbox(0.92, 0.28, 0.26, fab, 0.09), 0.02, 0.58, zz));
  }
  for (const zz of [-0.57, 0.57]) {                                    // seat cushions
    sofa.add(put(cushion(0.82, 0.17, 1.02, fab, 0.22), 0.04, 0.52, zz));
    sofa.add(put(cushion(0.2, 0.52, 0.98, fabDk, 0.12), -0.31, 0.78, zz));
  }
  for (const [zz, c] of [[-0.78, PAL.blush], [0.2, PAL.mint], [0.85, PAL.lav]] as const) {
    const p = cushion(0.16, 0.34, 0.34, lib.fabric(c), 0.25);
    p.rotation.x = 0.35;
    sofa.add(put(p, -0.18, 0.78, zz));
  }
  for (const [xx, zz] of [[-0.38, -1.06], [0.38, -1.06], [-0.38, 1.06], [0.38, 1.06]] as const) {
    sofa.add(put(cyl(0.028, 0.022, 0.15, lib.wood(PAL.walnut, 0.5), 12), xx, 0.075, zz));
  }
  g.add(put(sofa, 1.35, 0, 3.0, 0));

  // --- coffee table --------------------------------------------------------
  const ct = group();
  ct.add(put(rbox(1.15, 0.05, 0.62, lib.wood(PAL.oak, 0.45), 0.012), 0, 0.42, 0));
  ct.add(put(rbox(1.0, 0.03, 0.5, lib.wood(PAL.oakDk, 0.6), 0.008), 0, 0.18, 0)); // lower shelf
  for (const [xx, zz] of [[-0.5, -0.25], [0.5, -0.25], [-0.5, 0.25], [0.5, 0.25]] as const) {
    const leg = cyl(0.022, 0.017, 0.4, lib.wood(PAL.walnut, 0.45), 14);
    leg.rotation.z = xx > 0 ? -0.04 : 0.04;
    ct.add(put(leg, xx, 0.2, zz));
  }
  ct.add(put(books(lib, 3, 0.16), 0.24, 0.445, 0.02));
  const mug = lathe([[0, 0], [0.036, 0], [0.038, 0.01], [0.034, 0.075], [0.031, 0.08], [0, 0.08]], lib.ceramic(PAL.mint));
  ct.add(put(mug, -0.28, 0.445, -0.06));
  const handle = torus(0.024, 0.006, lib.ceramic(PAL.mint), 16);
  handle.rotation.y = Math.PI / 2;
  ct.add(put(handle, -0.245, 0.485, -0.06));
  g.add(put(ct, 3.0, 0, 3.0));

  // --- media unit ----------------------------------------------------------
  // Sits in the solid pier of the living/kitchen partition wall (the
  // archway opening is z 1.4-3.9; this pier is the untouched z 0-1.4
  // segment nearer the front windows). Deliberately not centred on the
  // sofa's sightline -- the console has to actually fit against a real
  // wall, and the partition's other pier (z 3.9-5.0) is only 1.1m long,
  // too narrow for a TV stand at any reasonable width. A shrunk 1.2m unit
  // fits this pier with clearance either side; a full-width console does
  // not fit anywhere on this wall without either blocking the archway or
  // the balcony doors on the opposite wall. Trade-off flagged in
  // docs/DECISIONS.md: this prioritises "actually against a wall, not in
  // the doorway" over an ideal sofa-facing sightline, which is worth a
  // second pass once this is visible on screen.
  const media = group();
  media.add(cabinetRun(lib, 1.2, 0.48, 0.42, PAL.cream, PAL.sage, 2, lib.metal(PAL.brass)));
  media.add(put(rbox(1.3, 0.04, 0.46, lib.wood(PAL.oak, 0.42), 0.01), 0, 0.5, 0));
  // TV
  const tv = group();
  tv.add(put(rbox(0.86, 0.5, 0.035, lib.paint(PAL.ink, 0.3), 0.008), 0, 0, 0));
  const tvTex = screenTexture(out, 190, 320, 190);
  const tvScreen = new THREE.Mesh(
    new THREE.PlaneGeometry(0.78, 0.44),
    new THREE.MeshBasicMaterial({ map: tvTex, toneMapped: false }),
  );
  tv.add(put(tvScreen, 0, 0, 0.021));
  tv.add(put(rbox(0.22, 0.022, 0.14, lib.paint(PAL.charcoal, 0.4), 0.006), 0, -0.27, 0.0));
  media.add(put(tv, 0, 0.8, 0.02));
  media.add(put(plant(lib, 0.55, PAL.mint), 0.48, 0.52, 0.0));
  g.add(put(media, 6.32, 0, 0.7, -Math.PI / 2));

  // --- dining, north-east corner ------------------------------------------
  const dine = group();
  const topM = lib.wood(PAL.oak, 0.4);
  dine.add(put(rbox(1.5, 0.045, 0.92, topM, 0.012), 0, 0.745, 0));
  dine.add(put(box(1.3, 0.05, 0.1, lib.wood(PAL.oakDk, 0.55)), 0, 0.66, 0)); // apron
  for (const [xx, zz] of [[-0.64, -0.36], [0.64, -0.36], [-0.64, 0.36], [0.64, 0.36]] as const) {
    dine.add(put(cyl(0.032, 0.024, 0.72, lib.wood(PAL.walnut, 0.45), 14), xx, 0.36, zz));
  }
  const chair = (cx: number, cz: number, ry: number, col: number) => {
    const c = group();
    c.add(put(cushion(0.42, 0.06, 0.42, lib.fabric(col), 0.2), 0, 0.45, 0));
    c.add(put(rbox(0.44, 0.03, 0.44, lib.wood(PAL.birch, 0.5), 0.008), 0, 0.42, 0));
    const back = rbox(0.42, 0.46, 0.035, lib.wood(PAL.birch, 0.5), 0.016);
    back.rotation.x = -0.09;
    c.add(put(back, 0, 0.68, -0.2));
    for (const [lx, lz] of [[-0.18, -0.18], [0.18, -0.18], [-0.18, 0.18], [0.18, 0.18]] as const) {
      const l = cyl(0.018, 0.014, 0.42, lib.wood(PAL.walnut, 0.45), 10);
      l.rotation.set(lz > 0 ? -0.05 : 0.05, 0, lx > 0 ? -0.05 : 0.05);
      c.add(put(l, lx, 0.21, lz));
    }
    return put(c, cx, 0, cz, ry);
  };
  dine.add(chair(0, -0.72, 0, PAL.blush));
  dine.add(chair(0, 0.72, Math.PI, PAL.mint));
  dine.add(chair(-0.95, 0, Math.PI / 2, PAL.sky));
  dine.add(chair(0.95, 0, -Math.PI / 2, PAL.lav));
  // centrepiece
  const vase = lathe([[0, 0], [0.07, 0], [0.085, 0.06], [0.05, 0.15], [0.055, 0.19], [0.048, 0.2], [0, 0.2]], lib.ceramic(PAL.sky));
  dine.add(put(vase, 0, 0.768, 0));
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    const stem = cyl(0.004, 0.004, 0.26, lib.foliage(0x6d9a5e), 6);
    stem.rotation.set(Math.cos(a) * 0.2, 0, Math.sin(a) * 0.2);
    dine.add(put(stem, Math.cos(a) * 0.03, 1.03, Math.sin(a) * 0.03));
    const bloom = sph(0.035, lib.paint([PAL.blush, PAL.peach, PAL.paper][i % 3], 0.85), 12);
    dine.add(put(bloom, Math.cos(a) * 0.06, 1.16, Math.sin(a) * 0.06));
  }
  g.add(put(dine, 4.85, 0, 1.75));
  g.add(pendant(lib, out, ceilingY, 1.62, PAL.cream, 0.21).translateX(4.85).translateZ(1.75));

  // --- shelving on the north wall -----------------------------------------
  const shelf = group();
  const sideM = lib.wood(PAL.birch, 0.52);
  for (const sx of [-0.45, 0.45]) shelf.add(put(rbox(0.03, 1.8, 0.26, sideM, 0.006), sx, 0.9, 0));
  for (let i = 0; i <= 4; i++) {
    const y = 0.05 + i * 0.43;
    shelf.add(put(rbox(0.93, 0.025, 0.26, sideM, 0.005), 0, y, 0));
    if (i < 4) shelfBooks(lib, -0.42, 0.42, y + 0.013, 0, shelf);
  }
  shelf.add(put(plant(lib, 0.5, PAL.blush), 0.24, 1.79, 0));
  g.add(put(shelf, 0.72, 0, 0.42));

  // --- floor lamp by the sofa ---------------------------------------------
  const fl = group();
  fl.add(put(lathe([[0, 0], [0.16, 0], [0.17, 0.015], [0.03, 0.05], [0.022, 1.42]], lib.metal(0x9a8f84, 0.45)), 0, 0, 0));
  const flGlow = lib.emissive(PAL.cream, 0).clone();
  out.lampGlow.push(flGlow);
  fl.add(put(cyl(0.15, 0.2, 0.24, flGlow, 30, true), 0, 1.54, 0));
  const flBulb = new THREE.PointLight(0xffd7a6, 0, 5, 2);
  flBulb.position.set(0, 1.5, 0);
  flBulb.userData.base = 2.0;
  out.lamps.push(flBulb);
  fl.add(flBulb);
  g.add(put(fl, 0.55, 0, 3.9));

  g.add(put(plant(lib, 1.25, PAL.lav), 5.9, 0, 4.5));

  // --- wall art ------------------------------------------------------------
  const art = (x: number, y: number, z: number, w: number, h: number, c: number, ry: number) => {
    const f = group();
    f.add(put(rbox(w, h, 0.03, lib.wood(PAL.walnut, 0.4), 0.006), 0, 0, 0));
    f.add(put(box(w - 0.07, h - 0.07, 0.008, lib.paint(c, 0.85)), 0, 0, 0.018));
    g.add(put(f, x, y, z, ry));
  };
  art(2.6, 1.85, 0.07, 0.52, 0.66, PAL.sky, 0);
  art(3.3, 1.72, 0.07, 0.4, 0.5, PAL.blush, 0);
  art(0.07, 1.75, 3.0, 0.62, 0.46, PAL.mint, Math.PI / 2);
}

function buildKitchen(lib: MaterialLib, out: Furnishings, ceilingY: number): void {
  const g = group('kitchen');
  out.root.add(g);

  const steel = lib.metal(PAL.steel, 0.3);
  const worktop = lib.paint(0xe8e2d6, 0.24);

  // --- north wall run ------------------------------------------------------
  const run = cabinetRun(lib, 3.2, 0.88, 0.62, PAL.cream, PAL.mintDk, 4, steel);
  g.add(put(run, 8.7, 0, 0.35));
  g.add(put(rbox(3.3, 0.045, 0.66, worktop, 0.01), 8.7, 0.9, 0.35));

  // sink cut into the worktop
  const sink = group();
  sink.add(put(rbox(0.5, 0.16, 0.38, steel, 0.02), 0, -0.07, 0));
  sink.add(put(box(0.44, 0.02, 0.32, lib.metal(0x9fa4a8, 0.35)), 0, -0.14, 0));
  sink.add(put(cyl(0.016, 0.016, 0.28, steel, 14), 0, 0.14, -0.14));
  const spout = cyl(0.014, 0.014, 0.18, steel, 14);
  spout.rotation.x = Math.PI / 2;
  sink.add(put(spout, 0, 0.27, -0.06));
  g.add(put(sink, 7.7, 0.93, 0.35));

  // hob + oven
  const hob = box(0.58, 0.012, 0.5, lib.paint(0x2b2830, 0.18));
  g.add(put(hob, 9.7, 0.925, 0.35));
  for (const [bx, bz] of [[-0.14, -0.11], [0.14, -0.11], [-0.14, 0.11], [0.14, 0.11]] as const) {
    const ring = torus(0.055, 0.008, lib.metal(0x6e6a72, 0.5), 20);
    ring.rotation.x = Math.PI / 2;
    g.add(put(ring, 9.7 + bx, 0.934, 0.35 + bz));
  }
  g.add(put(rbox(0.58, 0.5, 0.03, lib.paint(0x35313c, 0.25), 0.008), 9.7, 0.46, 0.67));
  g.add(put(rbox(0.5, 0.02, 0.025, steel, 0.008), 9.7, 0.68, 0.7));

  // splashback + upper cabinets
  const splash = new THREE.Mesh(new THREE.PlaneGeometry(3.3, 0.55), lib.splashback);
  splash.position.set(8.7, 1.22, 0.035);
  splash.receiveShadow = true;
  g.add(splash);
  const upper = cabinetRun(lib, 1.5, 0.64, 0.34, PAL.cream, PAL.mintDk, 2, steel);
  g.add(put(upper, 9.55, 1.44, 0.2));
  // open shelves next to them
  for (let i = 0; i < 2; i++) {
    const y = 1.55 + i * 0.36;
    g.add(put(rbox(1.0, 0.026, 0.24, lib.wood(PAL.oak, 0.5), 0.005), 7.7, y, 0.15));
    for (let k = 0; k < 4; k++) {
      const plate = cyl(0.085, 0.085, 0.012, lib.ceramic([PAL.paper, PAL.blush, PAL.sky][k % 3]), 20);
      g.add(put(plate, 7.35 + k * 0.012, y + 0.02 + k * 0.014, 0.15));
    }
    const jar = lathe([[0, 0], [0.045, 0], [0.05, 0.02], [0.048, 0.1], [0.035, 0.12], [0.036, 0.135], [0, 0.135]], lib.ceramic(PAL.peach));
    g.add(put(jar, 7.95, y + 0.013, 0.15));
  }

  // --- tall units: fridge + pantry on the east wall ------------------------
  const fridge = group();
  fridge.add(put(rbox(0.72, 1.85, 0.68, lib.paint(PAL.blush, 0.32), 0.022), 0, 0.93, 0));
  fridge.add(put(box(0.7, 0.012, 0.02, lib.paint(0xd8a3ad, 0.4)), 0, 1.12, 0.345));
  for (const [hy, hh] of [[1.5, 0.34], [0.72, 0.42]] as const) {
    fridge.add(put(rbox(0.022, hh, 0.03, steel, 0.009), 0.28, hy, 0.36));
  }
  g.add(put(fridge, 10.2, 0, 1.45, -Math.PI / 2));

  const pantry = cabinetRun(lib, 0.9, 2.05, 0.6, PAL.cream, PAL.cream, 2, steel);
  g.add(put(pantry, 10.28, 0, 2.6, -Math.PI / 2));

  // --- island --------------------------------------------------------------
  const island = group();
  island.add(cabinetRun(lib, 1.6, 0.86, 0.75, PAL.cream, PAL.sky, 3, steel));
  island.add(put(rbox(1.78, 0.05, 0.9, worktop, 0.012), 0, 0.885, 0));
  // stools tucked under the overhang
  for (const sz of [-0.42, 0.42]) {
    const st = group();
    st.add(put(lathe([[0, 0], [0.17, 0], [0.175, 0.012], [0.035, 0.03], [0.028, 0.6]], lib.metal(0x8f8a84, 0.4)), 0, 0, 0));
    st.add(put(cushion(0.3, 0.07, 0.3, lib.fabric(PAL.rose), 0.2), 0, 0.63, 0));
    const ring = torus(0.13, 0.009, lib.metal(0x8f8a84, 0.4), 20);
    ring.rotation.x = Math.PI / 2;
    st.add(put(ring, 0, 0.2, 0));
    island.add(put(st, 0, 0, sz + 0.82));
  }
  island.add(put(books(lib, 2, 0.15), -0.5, 0.91, 0.1));
  const bowl = lathe([[0, 0], [0.1, 0.005], [0.13, 0.05], [0.135, 0.07], [0.12, 0.072], [0.09, 0.02], [0, 0.015]], lib.ceramic(PAL.paper));
  island.add(put(bowl, 0.42, 0.91, 0));
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const fruit = sph(0.038, lib.paint([0xd9694f, 0xe2a23c, 0x8bb04f][i % 3], 0.6), 14);
    island.add(put(fruit, 0.42 + Math.cos(a) * 0.05, 0.965, Math.sin(a) * 0.05));
  }
  g.add(put(island, 8.4, 0, 2.7));

  g.add(pendant(lib, out, ceilingY, 1.72, PAL.mint, 0.17).translateX(8.0).translateZ(2.7));
  g.add(pendant(lib, out, ceilingY, 1.72, PAL.mint, 0.17).translateX(8.8).translateZ(2.7));

  g.add(put(plant(lib, 0.85, PAL.mint), 6.95, 0, 4.55));
}

function buildHall(lib: MaterialLib, out: Furnishings, ceilingY: number): void {
  const g = group('hall');
  out.root.add(g);

  // console table + mirror by the front door
  const con = group();
  con.add(put(rbox(1.0, 0.04, 0.32, lib.wood(PAL.oak, 0.42), 0.01), 0, 0.78, 0));
  con.add(put(rbox(0.9, 0.025, 0.28, lib.wood(PAL.oakDk, 0.55), 0.006), 0, 0.28, 0));
  for (const [xx, zz] of [[-0.44, -0.12], [0.44, -0.12], [-0.44, 0.12], [0.44, 0.12]] as const) {
    con.add(put(cyl(0.02, 0.015, 0.76, lib.wood(PAL.walnut, 0.45), 12), xx, 0.38, zz));
  }
  const tray = rbox(0.24, 0.02, 0.16, lib.ceramic(PAL.sky), 0.008);
  con.add(put(tray, -0.22, 0.81, 0));
  con.add(put(books(lib, 2, 0.14), 0.28, 0.8, 0));
  g.add(put(con, 9.2, 0, 5.35, Math.PI));

  const mirror = group();
  mirror.add(put(rbox(0.66, 0.9, 0.04, lib.wood(PAL.walnut, 0.4), 0.012), 0, 0, 0));
  mirror.add(put(box(0.56, 0.8, 0.01, lib.mirror), 0, 0, 0.026));
  g.add(put(mirror, 9.2, 1.5, 5.08, 0));

  // coat hooks
  const rail = rbox(0.9, 0.06, 0.03, lib.wood(PAL.walnut, 0.45), 0.008);
  g.add(put(rail, 7.0, 1.62, 5.07));
  for (let i = 0; i < 4; i++) {
    const hook = cyl(0.012, 0.012, 0.09, lib.metal(PAL.brass), 10);
    hook.rotation.x = Math.PI / 2.4;
    g.add(put(hook, 6.68 + i * 0.22, 1.58, 5.11));
  }
  // a coat on one of them
  const coat = cushion(0.34, 0.85, 0.16, lib.fabric(PAL.plum), 0.1);
  g.add(put(coat, 7.34, 1.14, 5.14));

  // runner rug
  const runner = new THREE.Mesh(new THREE.PlaneGeometry(5.4, 0.95), lib.floor.rug);
  runner.rotation.x = -Math.PI / 2;
  runner.position.set(4.6, 0.004, 5.8);
  runner.receiveShadow = true;
  g.add(runner);

  g.add(pendant(lib, out, ceilingY, 2.18, PAL.cream, 0.14).translateX(5.2).translateZ(5.8));
  g.add(put(plant(lib, 1.0, PAL.sage), 0.55, 0, 5.85));
}

function buildBedroom(lib: MaterialLib, out: Furnishings, ceilingY: number): void {
  const g = group('bedroom');
  out.root.add(g);

  // --- bed against the west wall ------------------------------------------
  const bed = group();
  const frameM = lib.wood(PAL.birch, 0.5);
  bed.add(put(rbox(1.5, 0.28, 2.05, frameM, 0.018), 0, 0.2, 0));
  for (const [lx, lz] of [[-0.68, -0.94], [0.68, -0.94], [-0.68, 0.94], [0.68, 0.94]] as const) {
    bed.add(put(rbox(0.09, 0.14, 0.09, lib.wood(PAL.walnut, 0.45), 0.012), lx, 0.07, lz));
  }
  // headboard, padded
  const hb = group();
  hb.add(put(rbox(1.6, 0.9, 0.08, frameM, 0.02), 0, 0.45, 0));
  for (let i = 0; i < 3; i++) {
    hb.add(put(cushion(0.48, 0.66, 0.09, lib.fabric(PAL.blush), 0.16), -0.52 + i * 0.52, 0.52, 0.06));
  }
  bed.add(put(hb, 0, 0.34, -1.06));
  // mattress, duvet with a turned-back fold, pillows
  bed.add(put(cushion(1.42, 0.24, 1.96, lib.fabric(PAL.paper), 0.1), 0, 0.46, 0));
  const duvet = cushion(1.46, 0.16, 1.4, lib.fabric(PAL.blush), 0.14);
  bed.add(put(duvet, 0, 0.63, 0.3));
  bed.add(put(cushion(1.46, 0.1, 0.3, lib.fabric(PAL.blushDk), 0.1), 0, 0.68, -0.42));
  for (const px of [-0.35, 0.35]) {
    const p = cushion(0.62, 0.16, 0.38, lib.fabric(PAL.paper), 0.3);
    p.rotation.x = -0.22;
    bed.add(put(p, px, 0.66, -0.76));
  }
  const throwP = cushion(0.36, 0.12, 0.36, lib.fabric(PAL.lav), 0.25);
  throwP.rotation.set(-0.5, 0.3, 0);
  bed.add(put(throwP, 0.3, 0.78, -0.5));
  g.add(put(bed, 1.15, 0, 8.0));

  // nightstands
  for (const [nx, nz, col] of [[1.15, 6.85, PAL.mint], [1.15, 9.15, PAL.sky]] as const) {
    const ns = group();
    ns.add(cabinetRun(lib, 0.46, 0.55, 0.4, PAL.cream, col, 1, lib.metal(PAL.brass), true));
    ns.add(put(rbox(0.5, 0.03, 0.44, lib.wood(PAL.oak, 0.45), 0.008), 0, 0.565, 0));
    g.add(put(ns, nx, 0, nz));
  }
  g.add(put(tableLamp(lib, out, PAL.peach, PAL.paper, 0.95), 1.15, 0.58, 6.85));
  g.add(put(books(lib, 2, 0.13), 1.15, 0.58, 9.15));

  // --- desk under the south window ----------------------------------------
  const desk = group();
  const deskTop = lib.wood(PAL.oak, 0.38);
  desk.add(put(rbox(1.7, 0.045, 0.68, deskTop, 0.012), 0, 0.745, 0));
  desk.add(put(box(1.5, 0.06, 0.06, lib.wood(PAL.oakDk, 0.55)), 0, 0.69, -0.28));
  // drawer pedestal on one side
  desk.add(put(cabinetRun(lib, 0.44, 0.7, 0.6, PAL.cream, PAL.lav, 1, lib.metal(PAL.brass), true), 0.58, 0, 0));
  for (const xx of [-0.78, -0.78]) {
    const l = cyl(0.026, 0.02, 0.72, lib.metal(0x8f8a84, 0.4), 12);
    desk.add(put(l, xx, 0.36, -0.26));
    desk.add(put(cyl(0.026, 0.02, 0.72, lib.metal(0x8f8a84, 0.4), 12), xx, 0.36, 0.26));
  }
  desk.add(put(box(0.05, 0.03, 0.56, lib.metal(0x8f8a84, 0.4)), -0.78, 0.7, 0));

  // monitor on an arm
  const mon = group();
  mon.add(put(rbox(0.6, 0.36, 0.022, lib.paint(PAL.ink, 0.28), 0.007), 0, 0, 0));
  const monTex = screenTexture(out, 205, 320, 200);
  const monScreen = new THREE.Mesh(
    new THREE.PlaneGeometry(0.56, 0.32),
    new THREE.MeshBasicMaterial({ map: monTex, toneMapped: false }),
  );
  mon.add(put(monScreen, 0, 0, 0.014));
  mon.add(put(cyl(0.02, 0.02, 0.16, lib.metal(0x6d6a72, 0.4), 12), 0, -0.26, 0));
  mon.add(put(lathe([[0, 0], [0.1, 0], [0.105, 0.012], [0.02, 0.02]], lib.metal(0x6d6a72, 0.4)), 0, -0.345, 0));
  desk.add(put(mon, -0.28, 1.1, -0.2));

  // keyboard, mouse, pen cup, the small stuff that sells a desk
  desk.add(put(rbox(0.42, 0.018, 0.14, lib.paint(0xf0ece4, 0.4), 0.004), -0.26, 0.777, 0.08));
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 14; c++) {
      const key = box(0.021, 0.004, 0.021, lib.paint(0xd9d4ca, 0.5));
      desk.add(put(key, -0.455 + c * 0.028, 0.788, 0.035 + r * 0.028));
    }
  }
  const mouse = sph(0.032, lib.paint(0xf0ece4, 0.35), 16);
  mouse.scale.set(0.7, 0.45, 1.05);
  desk.add(put(mouse, 0.06, 0.772, 0.08));
  const cup = lathe([[0, 0], [0.04, 0], [0.042, 0.012], [0.04, 0.1], [0, 0.1]], lib.ceramic(PAL.mint));
  desk.add(put(cup, -0.72, 0.767, -0.12));
  for (let i = 0; i < 4; i++) {
    const pen = cyl(0.004, 0.004, 0.17, lib.paint([PAL.rose, PAL.sky, PAL.gold, PAL.charcoal][i], 0.5), 8);
    pen.rotation.set((Math.random() - 0.5) * 0.25, 0, (Math.random() - 0.5) * 0.25);
    desk.add(put(pen, -0.72 + (Math.random() - 0.5) * 0.03, 0.87, -0.12 + (Math.random() - 0.5) * 0.03));
  }
  desk.add(put(books(lib, 3, 0.15), 0.42, 0.767, -0.12));
  g.add(put(desk, 3.3, 0, 9.78, Math.PI));
  g.add(put(tableLamp(lib, out, PAL.lav, PAL.paper, 0.82), 4.02, 0.767, 9.62));

  // desk chair
  const ch = group();
  ch.add(put(cushion(0.44, 0.09, 0.44, lib.fabric(PAL.lav), 0.2), 0, 0.46, 0));
  const back = cushion(0.42, 0.5, 0.1, lib.fabric(PAL.lav), 0.15);
  back.rotation.x = -0.14;
  ch.add(put(back, 0, 0.74, -0.2));
  ch.add(put(cyl(0.03, 0.035, 0.36, lib.metal(0x55525a, 0.4), 14), 0, 0.24, 0));
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const spoke = rbox(0.045, 0.025, 0.22, lib.paint(PAL.charcoal, 0.4), 0.01);
    spoke.rotation.y = -a;
    ch.add(put(spoke, Math.sin(a) * 0.11, 0.05, Math.cos(a) * 0.11));
    ch.add(put(cyl(0.026, 0.026, 0.02, lib.paint(PAL.ink, 0.35), 10), Math.sin(a) * 0.21, 0.028, Math.cos(a) * 0.21));
  }
  g.add(put(ch, 3.3, 0, 9.18, 0));

  // --- wardrobe on the east wall ------------------------------------------
  const wd = group();
  wd.add(put(rbox(1.5, 2.1, 0.6, lib.paint(PAL.cream, 0.4), 0.018), 0, 1.05, 0));
  for (const dx of [-0.37, 0.37]) {
    wd.add(put(rbox(0.71, 1.96, 0.025, lib.paint(PAL.paper, 0.35), 0.008), dx, 1.06, 0.31));
    wd.add(put(box(0.6, 1.02, 0.006, lib.paint(PAL.linen, 0.45)), dx, 1.36, 0.325));
    wd.add(put(rbox(0.018, 0.14, 0.02, lib.metal(PAL.brass), 0.008), dx + (dx > 0 ? -0.3 : 0.3), 1.06, 0.33));
  }
  wd.add(put(rbox(1.56, 0.06, 0.66, lib.paint(PAL.paper, 0.4), 0.012), 0, 2.13, 0));
  g.add(put(wd, 5.15, 0, 8.1, -Math.PI / 2));

  // --- rug, art, fairy lights ---------------------------------------------
  const rug = new THREE.Mesh(new THREE.CircleGeometry(1.15, 40), lib.floor.rug);
  rug.rotation.x = -Math.PI / 2;
  rug.position.set(3.2, 0.004, 8.1);
  rug.receiveShadow = true;
  g.add(rug);

  const art = group();
  art.add(put(rbox(0.5, 0.62, 0.03, lib.wood(PAL.birch, 0.4), 0.006), 0, 0, 0));
  art.add(put(box(0.44, 0.56, 0.008, lib.paint(PAL.peach, 0.85)), 0, 0, 0.018));
  g.add(put(art, 5.9, 1.65, 6.75, Math.PI));

  // fairy-light garland over the bed -- it's the one thing from the old scene
  // worth keeping, but strung along a wire instead of floating free.
  const fairy = group();
  const glow = lib.emissive(0xffe6b8, 0).clone();
  out.lampGlow.push(glow);
  const N = 26;
  for (let i = 0; i <= N; i++) {
    const f = i / N;
    const x = 0.25 + f * 2.2;
    const y = 2.3 - Math.sin(f * Math.PI) * 0.28;
    if (i % 2 === 0) {
      const bead = sph(0.022, glow, 10);
      fairy.add(put(bead, x, y, 6.72));
    }
    if (i < N) {
      const f2 = (i + 1) / N;
      const x2 = 0.25 + f2 * 2.2;
      const y2 = 2.3 - Math.sin(f2 * Math.PI) * 0.28;
      const seg = cyl(0.0022, 0.0022, Math.hypot(x2 - x, y2 - y), lib.paint(0x5d5a52, 0.8), 5);
      seg.rotation.z = Math.atan2(x2 - x, y2 - y) * -1;
      fairy.add(put(seg, (x + x2) / 2, (y + y2) / 2, 6.72));
    }
  }
  g.add(fairy);

  g.add(pendant(lib, out, ceilingY, 2.2, PAL.blush, 0.19).translateX(3.2).translateZ(8.1));
  g.add(put(plant(lib, 0.95, PAL.blush), 5.55, 0, 9.75));
}

function buildBathroom(lib: MaterialLib, out: Furnishings, ceilingY: number): void {
  const g = group('bathroom');
  out.root.add(g);

  const chrome = lib.metal(0xd2d6d9, 0.12);
  const porcelain = lib.ceramic(0xfbfaf8);

  // --- vanity + basin ------------------------------------------------------
  const van = group();
  van.add(cabinetRun(lib, 1.0, 0.78, 0.5, PAL.cream, PAL.sky, 2, lib.metal(PAL.brass)));
  van.add(put(rbox(1.08, 0.04, 0.54, lib.paint(0xe6e2da, 0.22), 0.01), 0, 0.8, 0));
  const basin = lathe([
    [0, 0], [0.19, 0], [0.205, 0.02], [0.2, 0.09], [0.185, 0.1],
    [0.17, 0.035], [0.02, 0.028], [0, 0.03],
  ], porcelain, 34);
  van.add(put(basin, 0, 0.815, 0));
  van.add(put(cyl(0.017, 0.017, 0.2, chrome, 16), 0, 0.92, -0.18));
  const spout = cyl(0.015, 0.015, 0.14, chrome, 16);
  spout.rotation.x = Math.PI / 2.2;
  van.add(put(spout, 0, 1.01, -0.13));
  g.add(put(van, 7.0, 0, 7.05, Math.PI));

  // mirror cabinet
  const mc = group();
  mc.add(put(rbox(0.9, 0.78, 0.13, lib.paint(PAL.paper, 0.35), 0.012), 0, 0, 0));
  mc.add(put(box(0.82, 0.7, 0.01, lib.mirror), 0, 0, 0.068));
  const strip = lib.emissive(0xfff4e2, 0).clone();
  out.lampGlow.push(strip);
  mc.add(put(rbox(0.7, 0.035, 0.035, strip, 0.014), 0, 0.46, 0.04));
  const stripLight = new THREE.PointLight(0xfff0dc, 0, 3.2, 2);
  stripLight.position.set(0, 0.42, 0.1);
  stripLight.userData.base = 1.4;
  out.lamps.push(stripLight);
  mc.add(stripLight);
  g.add(put(mc, 7.0, 1.52, 6.78, 0));

  // --- bath tub ------------------------------------------------------------
  const tub = group();
  tub.add(put(rbox(1.62, 0.56, 0.78, lib.paint(PAL.mint, 0.3), 0.05), 0, 0.28, 0));
  // Inner well: a slightly smaller inverted box sunk into the top.
  tub.add(put(rbox(1.44, 0.4, 0.62, porcelain, 0.07), 0, 0.38, 0));
  tub.add(put(rbox(1.5, 0.05, 0.68, lib.paint(PAL.mintDk, 0.3), 0.022), 0, 0.555, 0));
  tub.add(put(cyl(0.015, 0.015, 0.22, chrome, 16), -0.68, 0.66, 0));
  const tspout = cyl(0.014, 0.014, 0.13, chrome, 16);
  tspout.rotation.z = Math.PI / 2;
  tub.add(put(tspout, -0.61, 0.76, 0));
  for (const fx of [-0.66, 0.66]) {
    for (const fz of [-0.3, 0.3]) {
      tub.add(put(lathe([[0, 0], [0.05, 0], [0.045, 0.02], [0.03, 0.06]], chrome, 14), fx, 0, fz));
    }
  }
  g.add(put(tub, 9.5, 0, 7.4, Math.PI / 2));

  // --- shower screen + rail ------------------------------------------------
  // Screen height/position anchored to the tub rim (top surface at y~0.58,
  // see the rbox at 0,0.555,0 above) up to a 2.0m head height, rather than
  // an independent guess -- a mismatch here was a real floating-glass bug
  // an audit caught: the previous numbers left a 0.57m gap under the panel.
  const screenTop = 2.0;
  const screenBottom = 0.58;
  const screenH = screenTop - screenBottom;
  const screen = box(0.012, screenH, 0.76, lib.glass);
  screen.castShadow = false;
  g.add(put(screen, 8.68, screenBottom + screenH / 2, 7.4));
  g.add(put(cyl(0.012, 0.012, 0.8, chrome, 12), 8.68, 2.1, 7.4).rotateX(Math.PI / 2));
  const head = cyl(0.06, 0.055, 0.03, chrome, 20);
  head.rotation.x = 0.4;
  g.add(put(head, 10.2, 1.95, 7.4));
  g.add(put(cyl(0.012, 0.012, 0.3, chrome, 10), 10.36, 2.05, 7.4).rotateZ(Math.PI / 2.6));

  // --- toilet --------------------------------------------------------------
  const wc = group();
  wc.add(put(lathe([
    [0, 0], [0.17, 0], [0.15, 0.06], [0.13, 0.2], [0.165, 0.32], [0.2, 0.38], [0.19, 0.4], [0, 0.4],
  ], porcelain, 28), 0, 0, 0));
  const seat = torus(0.17, 0.035, porcelain, 26);
  seat.rotation.x = Math.PI / 2;
  seat.scale.set(1, 1.18, 1);
  wc.add(put(seat, 0, 0.415, 0.02));
  wc.add(put(rbox(0.36, 0.5, 0.18, porcelain, 0.03), 0, 0.68, -0.22));
  wc.add(put(rbox(0.38, 0.03, 0.2, porcelain, 0.012), 0, 0.945, -0.22));
  wc.add(put(cyl(0.022, 0.022, 0.02, lib.metal(PAL.brass), 14), 0.12, 0.95, -0.22));
  g.add(put(wc, 6.72, 0, 9.35, -Math.PI / 2));

  // --- towels, mat, shelf --------------------------------------------------
  const rail = cyl(0.014, 0.014, 0.62, chrome, 14);
  rail.rotation.z = Math.PI / 2;
  g.add(put(rail, 8.0, 1.25, 10.1));
  for (const [tx, col] of [[7.82, PAL.blush], [8.16, PAL.sky]] as const) {
    const towel = cushion(0.3, 0.5, 0.06, lib.fabric(col), 0.12);
    g.add(put(towel, tx, 1.0, 10.08));
  }
  const mat = new THREE.Mesh(new THREE.PlaneGeometry(0.85, 0.55), lib.floor.rug);
  mat.rotation.x = -Math.PI / 2;
  mat.position.set(7.6, 0.005, 7.9);
  mat.receiveShadow = true;
  g.add(mat);

  g.add(put(rbox(0.62, 0.03, 0.18, lib.wood(PAL.oak, 0.5), 0.006), 6.55, 1.5, 9.9, Math.PI / 2));
  g.add(put(plant(lib, 0.5, PAL.mint), 6.55, 1.53, 9.72));
  const bottle = lathe([[0, 0], [0.032, 0], [0.034, 0.08], [0.015, 0.1], [0.014, 0.13], [0, 0.13]], lib.ceramic(PAL.lav));
  g.add(put(bottle, 6.55, 1.53, 10.05));

  g.add(pendant(lib, out, ceilingY, 2.24, PAL.sky, 0.14).translateX(8.2).translateZ(8.4));
}

// ---------------------------------------------------------------------------

export function buildFurniture(lib: MaterialLib, ceilingY: number): Furnishings {
  const out: Furnishings = {
    root: group('furniture'),
    lamps: [],
    lampGlow: [],
    screens: [],
    fans: [],
  };
  buildLiving(lib, out, ceilingY);
  buildKitchen(lib, out, ceilingY);
  buildHall(lib, out, ceilingY);
  buildBedroom(lib, out, ceilingY);
  buildBathroom(lib, out, ceilingY);
  return out;
}
