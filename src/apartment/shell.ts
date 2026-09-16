/**
 * Turns the floor plan into building geometry: floors, ceilings, walls with
 * real holes in them, lined door frames, glazed windows, skirting, and the
 * door leaves that actually swing.
 *
 * The wall builder is the interesting part. A wall is a slab with a list of
 * openings along its run; rather than drawing a single box and hoping the
 * furniture hides the join, it emits a pier between each pair of openings, a
 * lintel over each one, and an apron under each window. That means a doorway
 * is a genuine hole you can see and walk through from either side, the
 * reveals have thickness, and the wall reads as built rather than painted on.
 *
 * Every wall also gets its two faces finished separately, so the bedroom can
 * have floral paper on its side of a partition while the hallway has plain
 * plaster on the other -- which is most of what makes a set of rooms feel
 * like different rooms.
 */

import * as THREE from 'three';
import {
  WALLS, ROOMS, FOOTPRINT, CEILING_H, SKIRTING_H, SKIRTING_T,
  type WallDef, type Opening,
} from './floorplan';
import { box, rbox, cyl, sph, put, group, type MaterialLib, PAL } from './materials';

export interface DoorLeaf {
  id: string;
  pivot: THREE.Group;
  closedY: number;
  openY: number;
  /** 0 = shut, 1 = fully open. */
  t: number;
  target: number;
  /** World position of the middle of the doorway, for proximity checks. */
  x: number;
  z: number;
}

export interface ShellResult {
  root: THREE.Group;
  doors: DoorLeaf[];
  /** Window glass, so the lighting modes can tint it per time of day. */
  glazing: THREE.MeshPhysicalMaterial[];
  /** Fake "sunlight through the glass" panels, dimmed at night. */
  daylightPanels: THREE.Mesh[];
}

/** Segments of a wall's run that are solid, given its openings. */
function solidSpans(w: WallDef): Array<[number, number]> {
  const sorted = [...w.openings].sort((a, b) => a.from - b.from);
  const spans: Array<[number, number]> = [];
  let cursor = w.from;
  for (const o of sorted) {
    if (o.from > cursor) spans.push([cursor, o.from]);
    cursor = Math.max(cursor, o.to);
  }
  if (cursor < w.to) spans.push([cursor, w.to]);
  return spans;
}

/**
 * Place a slab on a wall. `a`/`b` are along the run axis, `y0`/`y1` vertical.
 * Handles the axis swap so the callers below stay readable.
 */
function slab(
  w: WallDef, a: number, b: number, y0: number, y1: number, mat: THREE.Material,
): THREE.Mesh | null {
  const len = b - a;
  const h = y1 - y0;
  if (len <= 1e-4 || h <= 1e-4) return null;
  const m = w.axis === 'x'
    ? box(len, h, w.thickness, mat)
    : box(w.thickness, h, len, mat);
  const mid = (a + b) / 2;
  if (w.axis === 'x') m.position.set(mid, (y0 + y1) / 2, w.at);
  else m.position.set(w.at, (y0 + y1) / 2, mid);
  return m;
}

/** A thin finish plane stuck to one face of a wall, so each side can differ. */
function facing(
  w: WallDef, a: number, b: number, y0: number, y1: number, mat: THREE.Material, side: 1 | -1,
): THREE.Mesh | null {
  const len = b - a;
  const h = y1 - y0;
  if (len <= 1e-4 || h <= 1e-4) return null;
  const geo = new THREE.PlaneGeometry(len, h);
  const m = new THREE.Mesh(geo, mat);
  m.receiveShadow = true;
  m.castShadow = false;
  const off = (w.thickness / 2 + 0.001) * side;
  const mid = (a + b) / 2;
  if (w.axis === 'x') {
    m.position.set(mid, (y0 + y1) / 2, w.at + off);
    m.rotation.y = side > 0 ? 0 : Math.PI;
  } else {
    m.position.set(w.at + off, (y0 + y1) / 2, mid);
    m.rotation.y = side > 0 ? Math.PI / 2 : -Math.PI / 2;
  }
  return m;
}

/** Reveal lining around an opening -- the bit you see edge-on in a doorway. */
function reveal(w: WallDef, o: Opening, mat: THREE.Material, root: THREE.Group): void {
  const t = w.thickness;
  const jamb = 0.018;
  const mk = (a: number, b: number, y0: number, y1: number) => {
    const s = slab(w, a, b, y0, y1, mat);
    if (s) {
      s.castShadow = false;
      root.add(s);
    }
  };
  // side jambs
  mk(o.from - jamb, o.from, o.sill, o.head);
  mk(o.to, o.to + jamb, o.sill, o.head);
  // head
  mk(o.from - jamb, o.to + jamb, o.head, o.head + jamb);
  if (o.sill > 0.02) mk(o.from - jamb, o.to + jamb, o.sill - jamb, o.sill);
  void t;
}

/** Architrave: the moulding framing a door on both faces of the wall. */
function architrave(w: WallDef, o: Opening, mat: THREE.Material, root: THREE.Group): void {
  const width = 0.07;
  const depth = 0.022;
  for (const side of [1, -1] as const) {
    const off = (w.thickness / 2 + depth / 2) * side;
    const mk = (a: number, b: number, y0: number, y1: number) => {
      const len = b - a;
      const h = y1 - y0;
      if (len <= 1e-4 || h <= 1e-4) return;
      const m = w.axis === 'x' ? box(len, h, depth, mat) : box(depth, h, len, mat);
      const mid = (a + b) / 2;
      if (w.axis === 'x') m.position.set(mid, (y0 + y1) / 2, w.at + off);
      else m.position.set(w.at + off, (y0 + y1) / 2, mid);
      m.castShadow = false;
      root.add(m);
    };
    mk(o.from - width, o.from, o.sill, o.head + width);
    mk(o.to, o.to + width, o.sill, o.head + width);
    mk(o.from - width, o.to + width, o.head, o.head + width);
  }
}

/** Glazed window: frame, mullions, pane, sill board, and a daylight panel. */
function window_(
  w: WallDef, o: Opening, lib: MaterialLib, root: THREE.Group, out: ShellResult,
): void {
  const frameMat = lib.trim;
  const f = 0.055;
  const width = o.to - o.from;
  const height = o.head - o.sill;

  const mk = (a: number, b: number, y0: number, y1: number, depth: number, mat: THREE.Material) => {
    const len = b - a;
    const h = y1 - y0;
    if (len <= 1e-4 || h <= 1e-4) return null;
    const m = w.axis === 'x' ? box(len, h, depth, mat) : box(depth, h, len, mat);
    const mid = (a + b) / 2;
    if (w.axis === 'x') m.position.set(mid, (y0 + y1) / 2, w.at);
    else m.position.set(w.at, (y0 + y1) / 2, mid);
    m.castShadow = false;
    root.add(m);
    return m;
  };

  const d = w.thickness * 0.55;
  mk(o.from, o.from + f, o.sill, o.head, d, frameMat);
  mk(o.to - f, o.to, o.sill, o.head, d, frameMat);
  mk(o.from, o.to, o.head - f, o.head, d, frameMat);
  mk(o.from, o.to, o.sill, o.sill + f, d, frameMat);
  // Mullions: one vertical if it's wide, one horizontal if it's tall.
  if (width > 1.2) mk((o.from + o.to) / 2 - f / 2, (o.from + o.to) / 2 + f / 2, o.sill, o.head, d * 0.8, frameMat);
  if (height > 1.1) mk(o.from, o.to, (o.sill + o.head) / 2 - f / 2, (o.sill + o.head) / 2 + f / 2, d * 0.8, frameMat);

  // Pane. Cloned so each window can be tinted independently by the lighting.
  const glassMat = (o.frosted ? lib.frosted : lib.glass).clone();
  out.glazing.push(glassMat);
  const pane = mk(o.from + f, o.to - f, o.sill + f, o.head - f, 0.012, glassMat);
  if (pane) pane.receiveShadow = false;

  // Interior sill board, slightly proud of the wall.
  const sillD = w.thickness + 0.08;
  const sb = w.axis === 'x'
    ? box(width + 0.12, 0.035, sillD, frameMat)
    : box(sillD, 0.035, width + 0.12, frameMat);
  const mid = (o.from + o.to) / 2;
  if (w.axis === 'x') sb.position.set(mid, o.sill - 0.015, w.at);
  else sb.position.set(w.at, o.sill - 0.015, mid);
  root.add(sb);

  // A dim emissive plane just inside the glass. Real sun through a window is
  // far brighter than any light we can afford to place outside, so this fakes
  // the "glowing rectangle" read that sells daylight, and gets dimmed to
  // nothing at night by the lighting modes.
  const panelGeo = new THREE.PlaneGeometry(Math.max(0.1, width - f * 2), Math.max(0.1, height - f * 2));
  const panelMat = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false,
  });
  const panel = new THREE.Mesh(panelGeo, panelMat);
  const inward = w.exterior ? interiorSide(w) : 1;
  if (w.axis === 'x') {
    panel.position.set(mid, (o.sill + o.head) / 2, w.at + 0.02 * inward);
  } else {
    panel.position.set(w.at + 0.02 * inward, (o.sill + o.head) / 2, mid);
    panel.rotation.y = Math.PI / 2;
  }
  root.add(panel);
  out.daylightPanels.push(panel);
}

/** Which way is "into the flat" for an exterior wall: +1 or -1. */
function interiorSide(w: WallDef): 1 | -1 {
  if (w.axis === 'x') return w.at <= FOOTPRINT.minZ + 0.01 ? 1 : -1;
  return w.at <= FOOTPRINT.minX + 0.01 ? 1 : -1;
}

/** A panelled door leaf on a pivot, plus handle and hinges. */
function doorLeaf(
  w: WallDef, o: Opening, lib: MaterialLib, root: THREE.Group, out: ShellResult,
): void {
  const width = o.to - o.from;
  const height = o.head - 0.01;
  const thick = 0.042;
  const isFront = o.kind === 'frontDoor';
  const leafMat = lib.paint(isFront ? PAL.walnut : PAL.paper, isFront ? 0.5 : 0.38);

  const leaf = group(`door-${o.id}`);

  // Slab plus two recessed panels -- a flat rectangle is the single most
  // obviously fake thing in a room, and two insets fix it almost entirely.
  const slabMesh = box(width, height, thick, leafMat);
  slabMesh.position.set(width / 2, height / 2, 0);
  leaf.add(slabMesh);

  const inset = lib.paint(isFront ? 0x6a462e : 0xf2ece1, 0.42);
  const pw = width - 0.16;
  for (const [py, ph] of [[height * 0.30, height * 0.38], [height * 0.735, height * 0.30]] as const) {
    for (const s of [1, -1] as const) {
      const p = box(pw, ph, 0.006, inset);
      p.position.set(width / 2, py, s * (thick / 2 + 0.002));
      p.castShadow = false;
      leaf.add(p);
    }
    for (const s of [1, -1] as const) {
      const bead = box(pw + 0.03, ph + 0.03, 0.004, leafMat);
      bead.position.set(width / 2, py, s * (thick / 2 + 0.0005));
      bead.castShadow = false;
      leaf.add(bead);
    }
  }

  // Handle on both faces + a small backplate.
  const brass = lib.metal(PAL.brass, 0.25);
  for (const s of [1, -1] as const) {
    const rose = cyl(0.026, 0.026, 0.012, brass, 20);
    rose.rotation.x = Math.PI / 2;
    rose.position.set(width - 0.085, 1.02, s * (thick / 2 + 0.006));
    leaf.add(rose);
    const lever = rbox(0.022, 0.022, 0.115, brass, 0.009);
    lever.position.set(width - 0.085, 1.02, s * (thick / 2 + 0.062));
    leaf.add(lever);
  }
  for (const hy of [0.28, height - 0.28]) {
    const hinge = cyl(0.014, 0.014, 0.075, brass, 12);
    hinge.position.set(0.004, hy, 0);
    leaf.add(hinge);
  }

  // Pivot at the hinge edge. `swing` sign picks which edge and which way.
  const pivot = group(`pivot-${o.id}`);
  const hingeAtFrom = (o.swing ?? 1) > 0;
  const mid = (o.from + o.to) / 2;

  if (hingeAtFrom) {
    pivot.add(leaf);
  } else {
    // Mirror so the leaf extends the other way from its pivot.
    leaf.scale.x = -1;
    pivot.add(leaf);
  }

  const hx = hingeAtFrom ? o.from : o.to;
  if (w.axis === 'x') {
    pivot.position.set(hx, o.sill, w.at);
  } else {
    pivot.position.set(w.at, o.sill, hx);
    pivot.rotation.y = -Math.PI / 2;
  }
  root.add(pivot);

  out.doors.push({
    id: o.id ?? `${w.id}-${o.from}`,
    pivot,
    closedY: pivot.rotation.y,
    openY: pivot.rotation.y + (o.swing ?? 1),
    t: 0,
    target: 0,
    x: w.axis === 'x' ? mid : w.at,
    z: w.axis === 'x' ? w.at : mid,
  });
}

/** Skirting board along the inside face of every wall run. */
function skirting(w: WallDef, lib: MaterialLib, root: THREE.Group): void {
  for (const [a, b] of solidSpans(w)) {
    for (const side of [1, -1] as const) {
      const len = b - a;
      if (len <= 0.02) continue;
      const m = w.axis === 'x'
        ? box(len, SKIRTING_H, SKIRTING_T, lib.trim)
        : box(SKIRTING_T, SKIRTING_H, len, lib.trim);
      const off = (w.thickness / 2 + SKIRTING_T / 2) * side;
      const mid = (a + b) / 2;
      if (w.axis === 'x') m.position.set(mid, SKIRTING_H / 2, w.at + off);
      else m.position.set(w.at + off, SKIRTING_H / 2, mid);
      m.castShadow = false;
      root.add(m);
    }
  }
}

export function buildShell(lib: MaterialLib): ShellResult {
  const root = group('shell');
  const out: ShellResult = { root, doors: [], glazing: [], daylightPanels: [] };

  // --- floors + ceilings, one slab per room so finishes differ -------------
  for (const r of ROOMS) {
    const w = r.maxX - r.minX;
    const d = r.maxZ - r.minZ;
    const cx = (r.minX + r.maxX) / 2;
    const cz = (r.minZ + r.maxZ) / 2;

    const floorMat = lib.floor[r.floor];
    const f = new THREE.Mesh(new THREE.PlaneGeometry(w, d), floorMat);
    f.rotation.x = -Math.PI / 2;
    f.position.set(cx, 0, cz);
    f.receiveShadow = true;
    root.add(f);

    // A thin slab under it so the floor has edge thickness when seen from
    // outside the open front, rather than being an infinitely thin plane.
    const sub = box(w, 0.12, d, lib.paint(0xcfc7ba, 0.9));
    sub.position.set(cx, -0.061, cz);
    sub.castShadow = false;
    root.add(sub);

    const c = new THREE.Mesh(new THREE.PlaneGeometry(w, d), lib.ceiling);
    c.rotation.x = Math.PI / 2;
    c.position.set(cx, CEILING_H, cz);
    c.receiveShadow = true;
    root.add(c);

    // Crown moulding where ceiling meets wall.
    const crown = lib.trim;
    for (const [px, py, pz, cw, cd] of [
      [cx, CEILING_H - 0.035, r.minZ + 0.03, w, 0.06],
      [cx, CEILING_H - 0.035, r.maxZ - 0.03, w, 0.06],
      [r.minX + 0.03, CEILING_H - 0.035, cz, 0.06, d],
      [r.maxX - 0.03, CEILING_H - 0.035, cz, 0.06, d],
    ] as const) {
      const m = box(cw, 0.07, cd, crown);
      m.position.set(px, py, pz);
      m.castShadow = false;
      root.add(m);
    }
  }

  // --- walls ---------------------------------------------------------------
  for (const w of WALLS) {
    const core = lib.paint(0xded7cc, 0.95);
    const frontMat = lib.wall[w.frontWall];
    const backMat = lib.wall[w.backWall];

    // Solid piers between openings, full height.
    for (const [a, b] of solidSpans(w)) {
      const s = slab(w, a, b, 0, CEILING_H, core);
      if (s) {
        s.castShadow = true;
        s.receiveShadow = true;
        root.add(s);
      }
      const f1 = facing(w, a, b, 0, CEILING_H, frontMat, 1);
      if (f1) root.add(f1);
      const f2 = facing(w, a, b, 0, CEILING_H, backMat, -1);
      if (f2) root.add(f2);
    }

    // Lintels over, and aprons under, each opening.
    for (const o of w.openings) {
      const lintel = slab(w, o.from, o.to, o.head, CEILING_H, core);
      if (lintel) {
        lintel.castShadow = true;
        lintel.receiveShadow = true;
        root.add(lintel);
      }
      const lf1 = facing(w, o.from, o.to, o.head, CEILING_H, frontMat, 1);
      if (lf1) root.add(lf1);
      const lf2 = facing(w, o.from, o.to, o.head, CEILING_H, backMat, -1);
      if (lf2) root.add(lf2);

      if (o.sill > 0.02) {
        const apron = slab(w, o.from, o.to, 0, o.sill, core);
        if (apron) {
          apron.castShadow = true;
          apron.receiveShadow = true;
          root.add(apron);
        }
        const af1 = facing(w, o.from, o.to, 0, o.sill, frontMat, 1);
        if (af1) root.add(af1);
        const af2 = facing(w, o.from, o.to, 0, o.sill, backMat, -1);
        if (af2) root.add(af2);
      }

      reveal(w, o, lib.trim, root);

      if (o.kind === 'window') {
        window_(w, o, lib, root, out);
      } else {
        architrave(w, o, lib.trim, root);
        if (o.kind === 'door' || o.kind === 'frontDoor') doorLeaf(w, o, lib, root, out);
      }
    }

    skirting(w, lib, root);
  }

  // --- a hint of world outside the windows --------------------------------
  // Without this the windows look onto the void and read as black holes at
  // night. A large soft-coloured shell is cheap and gives the glass something
  // to actually show.
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(90, 24, 16),
    new THREE.MeshBasicMaterial({ color: 0xbcd4e8, side: THREE.BackSide, fog: false }),
  );
  sky.name = 'outside-shell';
  sky.position.set(FOOTPRINT.maxX / 2, 0, FOOTPRINT.maxZ / 2);
  root.add(sky);

  // Ground plane outside, so a downward glance out of the balcony door isn't
  // an abyss.
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200),
    new THREE.MeshStandardMaterial({ color: 0x8fa08a, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(FOOTPRINT.maxX / 2, -6, FOOTPRINT.maxZ / 2);
  ground.receiveShadow = false;
  root.add(ground);

  // A balcony slab + railing off the living room's floor-length west window,
  // so that opening leads somewhere instead of dropping off the edge.
  const balcony = group('balcony');
  const slabM = box(1.7, 0.1, 2.6, lib.paint(0xcdc5b8, 0.9));
  slabM.position.set(-0.85, -0.05, 2.7);
  balcony.add(slabM);
  const rail = lib.metal(0x8d8f93, 0.4);
  for (const [rx, rz, rw, rd] of [
    [-1.68, 2.7, 0.05, 2.6],
    [-0.85, 1.42, 1.7, 0.05],
    [-0.85, 3.98, 1.7, 0.05],
  ] as const) {
    const top = box(rw, 0.05, rd, rail);
    top.position.set(rx, 0.98, rz);
    balcony.add(top);
    const n = Math.max(3, Math.round((rw > rd ? rw : rd) / 0.13));
    for (let i = 0; i <= n; i++) {
      const f = i / n - 0.5;
      const b = cyl(0.012, 0.012, 0.95, rail, 8);
      b.position.set(rx + (rw > rd ? f * rw : 0), 0.5, rz + (rd > rw ? f * rd : 0));
      balcony.add(b);
    }
  }
  const planter = rbox(0.4, 0.3, 0.4, lib.ceramic(PAL.peachDk), 0.03);
  planter.position.set(-1.35, 0.15, 2.0);
  balcony.add(planter);
  for (let i = 0; i < 9; i++) {
    const leaf = sph(0.07 + Math.random() * 0.05, lib.foliage(0x6f9a63), 10);
    leaf.scale.set(1, 0.6, 1);
    leaf.position.set(-1.35 + (Math.random() - 0.5) * 0.28, 0.34 + Math.random() * 0.13, 2.0 + (Math.random() - 0.5) * 0.28);
    balcony.add(leaf);
  }
  root.add(balcony);

  put(group(), 0, 0, 0);
  return out;
}

/** Advance every door toward its target. Call once per frame. */
export function updateDoors(doors: DoorLeaf[], dt: number): void {
  const RATE = 2.4; // ~0.4s to swing
  for (const d of doors) {
    if (Math.abs(d.t - d.target) < 0.001) {
      d.t = d.target;
      continue;
    }
    const dir = Math.sign(d.target - d.t);
    d.t = THREE.MathUtils.clamp(d.t + dir * RATE * dt, 0, 1);
    // Ease so it doesn't stop dead at either end.
    const e = d.t * d.t * (3 - 2 * d.t);
    d.pivot.rotation.y = THREE.MathUtils.lerp(d.closedY, d.openY, e);
  }
}
