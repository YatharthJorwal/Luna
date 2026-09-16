/**
 * The apartment, as data.
 *
 * Everything about the building -- where the rooms are, where the walls run,
 * where the doors and windows punch through them, where the floor is safe to
 * walk on, where the interesting places to stand are -- lives in this one
 * file as plain numbers. Nothing here imports three.js or builds geometry.
 * `shell.ts` turns walls into meshes, `furniture.ts` dresses the rooms,
 * `index.ts` wires it together.
 *
 * Why it's built this way: the previous apartment was ~1000 lines of
 * hand-placed `put(box(...), 14.2, 0.95, 0.4)` calls, which meant that
 * moving a wall meant hunting down every object that happened to be near it.
 * With the plan as data, the walls, the door frames, the skirting, the
 * navmesh and the scene-state room lookup are all generated from the same
 * numbers and can't drift apart.
 *
 * UNITS ARE METRES. The old scene was authored in "dollhouse units" about
 * 2.4x life size and scaled down at runtime, which quietly broke anything
 * three.js interprets in world space (shadow frusta, light distances -- see
 * docs/DECISIONS.md round 9). That whole class of bug is gone: a 0.9 here is
 * a 90cm door, and Luna is a 1.6m VRM standing in it.
 *
 * Layout -- an L-ish plan around a central hallway, so there's somewhere to
 * walk *to* rather than one long strip:
 *
 *      x=0            6.6          10.6
 *  z=0  +---------------+------------+
 *       |               |            |
 *       | LIVING/DINING |  KITCHEN   |
 *       |               |            |
 *       |          (open archway)    |
 *  z=5.0+--[open]-------+---[door]---+
 *       |         HALLWAY            |   <- front door on the east wall
 *  z=6.6+----[door]-----+---[door]---+
 *       |               |            |
 *       |    BEDROOM    |  BATHROOM  |
 *       |               |            |
 * z=10.2+---------------+------------+
 *              x=6.0
 */

export const CEILING_H = 2.7;
export const WALL_T_EXTERIOR = 0.22;
export const WALL_T_INTERIOR = 0.12;

export const DOOR_W = 0.9;
export const DOOR_H = 2.05;
/** Cased openings with no door leaf -- living/kitchen and living/hall. */
export const ARCH_H = 2.25;

export const SKIRTING_H = 0.11;
export const SKIRTING_T = 0.02;

export type RoomId = 'living' | 'kitchen' | 'hall' | 'bedroom' | 'bathroom';

export interface RoomDef {
  id: RoomId;
  /** What Luna calls it when she talks about where she is. */
  label: string;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Floor + wall finish keys, looked up in materials.ts. */
  floor: 'oak' | 'tileWarm' | 'tileCool' | 'rug';
  wall: 'living' | 'kitchen' | 'hall' | 'bedroom' | 'bathroom';
  /** Rooms with a wet floor get a slightly reflective finish. */
  wet?: boolean;
}

/** Interior floor extents. Walls sit on these boundaries, not inside them. */
export const ROOMS: RoomDef[] = [
  { id: 'living',   label: 'the living room', minX: 0.0, maxX: 6.6,  minZ: 0.0, maxZ: 5.0,  floor: 'oak',      wall: 'living' },
  { id: 'kitchen',  label: 'the kitchen',     minX: 6.6, maxX: 10.6, minZ: 0.0, maxZ: 5.0,  floor: 'tileWarm', wall: 'kitchen' },
  { id: 'hall',     label: 'the hallway',     minX: 0.0, maxX: 10.6, minZ: 5.0, maxZ: 6.6,  floor: 'oak',      wall: 'hall' },
  { id: 'bedroom',  label: 'her bedroom',     minX: 0.0, maxX: 6.0,  minZ: 6.6, maxZ: 10.2, floor: 'oak',      wall: 'bedroom' },
  { id: 'bathroom', label: 'the bathroom',    minX: 6.0, maxX: 10.6, minZ: 6.6, maxZ: 10.2, floor: 'tileCool', wall: 'bathroom', wet: true },
];

export const FOOTPRINT = {
  minX: 0.0,
  maxX: 10.6,
  minZ: 0.0,
  maxZ: 10.2,
};

// ---------------------------------------------------------------------------
// Walls
//
// A wall is an axis-aligned slab with holes punched in it. `axis: 'x'` means
// the wall runs along x at a fixed z (so it's a north/south divider);
// `axis: 'z'` runs along z at a fixed x. Openings are spans along that same
// run direction. The builder generates the lintel above each opening and the
// pier either side, so a door hole is a real hole you can see through.
// ---------------------------------------------------------------------------

export type OpeningKind = 'door' | 'arch' | 'window' | 'frontDoor';

export interface Opening {
  kind: OpeningKind;
  /** Start/end along the wall's run axis. */
  from: number;
  to: number;
  /** Floor for windows; 0 for doors and arches. */
  sill: number;
  /** Top of the hole. */
  head: number;
  /** Stable id so doors.ts can find its leaf again. */
  id?: string;
  /** Which way the leaf swings open, in radians. Sign picks the side. */
  swing?: number;
  /** Frosted glass, for the bathroom. */
  frosted?: boolean;
}

export interface WallDef {
  id: string;
  axis: 'x' | 'z';
  /** The fixed coordinate: z for axis 'x', x for axis 'z'. */
  at: number;
  from: number;
  to: number;
  thickness: number;
  exterior: boolean;
  openings: Opening[];
  /** Wall finish key per side. `front` is the +axis side. */
  frontWall: RoomDef['wall'];
  backWall: RoomDef['wall'];
}

const W_EXT = WALL_T_EXTERIOR;
const W_INT = WALL_T_INTERIOR;

export const WALLS: WallDef[] = [
  // --- exterior shell ------------------------------------------------------
  {
    id: 'ext-north', axis: 'x', at: 0.0, from: -W_EXT, to: 10.6 + W_EXT,
    thickness: W_EXT, exterior: true, frontWall: 'living', backWall: 'living',
    openings: [
      { kind: 'window', from: 1.1, to: 2.9, sill: 0.95, head: 2.35 },
      { kind: 'window', from: 3.7, to: 5.5, sill: 0.95, head: 2.35 },
      { kind: 'window', from: 7.7, to: 9.3, sill: 1.15, head: 2.25 },
    ],
  },
  {
    id: 'ext-south', axis: 'x', at: 10.2, from: -W_EXT, to: 10.6 + W_EXT,
    thickness: W_EXT, exterior: true, frontWall: 'bedroom', backWall: 'bedroom',
    openings: [
      { kind: 'window', from: 1.9, to: 4.1, sill: 0.85, head: 2.35 },
      { kind: 'window', from: 8.0, to: 8.9, sill: 1.45, head: 2.35, frosted: true },
    ],
  },
  {
    id: 'ext-west', axis: 'z', at: 0.0, from: 0.0, to: 10.2,
    thickness: W_EXT, exterior: true, frontWall: 'living', backWall: 'living',
    openings: [
      // Balcony doors: floor-length, the main light source in the living room.
      { kind: 'window', from: 1.6, to: 3.8, sill: 0.06, head: 2.35 },
      { kind: 'window', from: 7.4, to: 9.2, sill: 0.85, head: 2.35 },
    ],
  },
  {
    id: 'ext-east', axis: 'z', at: 10.6, from: 0.0, to: 10.2,
    thickness: W_EXT, exterior: true, frontWall: 'kitchen', backWall: 'kitchen',
    openings: [
      { kind: 'frontDoor', id: 'front', from: 5.35, to: 6.25, sill: 0, head: DOOR_H, swing: -1.6 },
    ],
  },

  // --- interior partitions -------------------------------------------------
  {
    // living | kitchen, with a wide cased archway rather than a door
    id: 'int-living-kitchen', axis: 'z', at: 6.6, from: 0.0, to: 5.0,
    thickness: W_INT, exterior: false, frontWall: 'kitchen', backWall: 'living',
    openings: [{ kind: 'arch', from: 1.4, to: 3.9, sill: 0, head: ARCH_H }],
  },
  {
    // living + kitchen | hallway
    id: 'int-hall-north', axis: 'x', at: 5.0, from: 0.0, to: 10.6,
    thickness: W_INT, exterior: false, frontWall: 'hall', backWall: 'living',
    openings: [
      { kind: 'arch', from: 1.3, to: 3.1, sill: 0, head: ARCH_H },
      { kind: 'door', id: 'kitchen', from: 7.5, to: 8.4, sill: 0, head: DOOR_H, swing: 1.55 },
    ],
  },
  {
    // hallway | bedroom + bathroom
    id: 'int-hall-south', axis: 'x', at: 6.6, from: 0.0, to: 10.6,
    thickness: W_INT, exterior: false, frontWall: 'bedroom', backWall: 'hall',
    openings: [
      { kind: 'door', id: 'bedroom', from: 2.1, to: 3.0, sill: 0, head: DOOR_H, swing: -1.55 },
      { kind: 'door', id: 'bathroom', from: 7.5, to: 8.4, sill: 0, head: DOOR_H, swing: -1.55 },
    ],
  },
  {
    // bedroom | bathroom
    id: 'int-bed-bath', axis: 'z', at: 6.0, from: 6.6, to: 10.2,
    thickness: W_INT, exterior: false, frontWall: 'bathroom', backWall: 'bedroom',
    openings: [],
  },
];

// ---------------------------------------------------------------------------
// Navmesh
//
// Same rectangle-union scheme as round 9 (see docs/DECISIONS.md): every patch
// is convex, so a straight line between two points inside one patch stays
// inside it, and a room change is a walk to a point inside the *overlap* of
// two patches.
//
// This table was rewritten once already, after an audit script (checked into
// docs/DECISIONS.md's verification notes, not part of the shipped app) cross-
// referenced every rectangle below against the *actual* placement coordinates
// in furniture.ts, rather than against a mental picture of the room. It found
// two real bugs: the TV console was sitting inside the open kitchen archway
// (fixed in furniture.ts, not here), and a rectangle here overlapped half a
// metre of the wardrobe. Fixing the wardrobe overlap also required widening
// the bed/desk gap in furniture.ts -- the original 0.25m gap wasn't wide
// enough to route a rectangle through at all.
//
// A handful of rectangles below sit within 5-10cm of a furniture edge by
// design; those numbers are arithmetic on the furniture's real placed
// coordinates, not guesses, but -- same caveat as everywhere in this project
// -- unconfirmed against an actual render, since there's no GPU/browser in
// the sandbox this was built in.
// ---------------------------------------------------------------------------

export interface NavPatch {
  name: string;
  room: RoomId;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Doorway patches are narrow; the wander targeting uses a smaller margin. */
  doorway?: boolean;
}

export const PATCHES: NavPatch[] = [
  // --- living room -----------------------------------------------------
  // South band along the hallway wall: clear the full width once past the
  // sofa (ends z 4.15).
  { name: 'living-south', room: 'living', minX: 0.3, maxX: 6.3, minZ: 4.2, maxZ: 4.9 },
  // Beside the north windows, between the bookshelf and the dining set.
  { name: 'living-window', room: 'living', minX: 1.3, maxX: 3.5, minZ: 0.6, maxZ: 1.7 },
  // The one gap that runs the full depth of the room without hitting
  // anything: between the sofa's east edge (1.83) and the coffee table's
  // west edge (2.42). This connects the window area to the south band --
  // there is no other unobstructed north-south path in this room.
  { name: 'living-gap', room: 'living', minX: 1.85, maxX: 2.4, minZ: 0.6, maxZ: 4.9 },
  // Corridor east of the dining chairs (end x 6.02), south of the media
  // unit (ends z 1.35 -- see furniture.ts for why it isn't in the archway
  // any more), leading to the kitchen archway.
  { name: 'living-arch', room: 'living', minX: 6.1, maxX: 6.5, minZ: 1.5, maxZ: 3.8 },
  { name: 'living-bridge', room: 'living', minX: 6.05, maxX: 6.3, minZ: 3.75, maxZ: 4.9 },

  // --- kitchen -----------------------------------------------------------
  // In front of the north counter run (ends z 0.66), west of the fridge
  // (starts x 9.86).
  { name: 'kitchen-aisle', room: 'kitchen', minX: 6.7, maxX: 9.7, minZ: 0.7, maxZ: 1.6 },
  // South of the island (ends z 3.7), west of the pantry (starts x 9.98).
  { name: 'kitchen-south', room: 'kitchen', minX: 6.7, maxX: 9.9, minZ: 3.75, maxZ: 4.85 },

  // --- hallway -------------------------------------------------------------
  // West of the console table (starts x 8.7).
  { name: 'hall-main', room: 'hall', minX: 0.5, maxX: 8.6, minZ: 4.55, maxZ: 6.45 },
  // East of the console, toward the front door.
  { name: 'hall-east', room: 'hall', minX: 8.5, maxX: 10.3, minZ: 5.55, maxZ: 6.45 },

  // --- bedroom -------------------------------------------------------------
  // Open floor between the bed and the wardrobe/desk cluster.
  { name: 'bedroom-mid', room: 'bedroom', minX: 2.0, maxX: 4.5, minZ: 6.65, maxZ: 8.85 },
  // The gap between the bed's east edge (1.9) and the desk's west edge
  // (2.45) -- the only route to the south-west corner that doesn't cross
  // the bed or the desk/chair.
  { name: 'bedroom-corridor', room: 'bedroom', minX: 1.95, maxX: 2.35, minZ: 6.65, maxZ: 9.9 },
  { name: 'bedroom-south-west', room: 'bedroom', minX: 0.6, maxX: 2.3, minZ: 9.15, maxZ: 9.9 },
  // Beside the desk chair, where she'd actually stand to be "at the desk".
  { name: 'bedroom-desk-side', room: 'bedroom', minX: 2.4, maxX: 3.0, minZ: 8.6, maxZ: 9.4 },

  // --- bathroom ------------------------------------------------------------
  // Between the vanity/toilet (end x ~7.5) and the tub (starts x 9.11).
  { name: 'bathroom-centre', room: 'bathroom', minX: 7.6, maxX: 9.05, minZ: 6.65, maxZ: 9.9 },
  { name: 'bathroom-vanity', room: 'bathroom', minX: 6.65, maxX: 7.65, minZ: 7.35, maxZ: 7.8 },

  // --- doorways (aligned to the actual door-leaf openings in WALLS) --------
  { name: 'door-living-hall', room: 'hall', minX: 1.45, maxX: 2.95, minZ: 4.6, maxZ: 5.4, doorway: true },
  { name: 'door-kitchen-hall', room: 'hall', minX: 7.6, maxX: 8.3, minZ: 4.6, maxZ: 5.4, doorway: true },
  { name: 'door-hall-bedroom', room: 'bedroom', minX: 2.2, maxX: 2.9, minZ: 6.2, maxZ: 7.2, doorway: true },
  { name: 'door-hall-bathroom', room: 'bathroom', minX: 7.6, maxX: 8.3, minZ: 6.2, maxZ: 7.2, doorway: true },
  // The living/kitchen archway has no door leaf, just a wide opening.
  { name: 'arch-living-kitchen', room: 'kitchen', minX: 6.3, maxX: 6.9, minZ: 1.5, maxZ: 3.8, doorway: true },
];

// ---------------------------------------------------------------------------
// Anchors
//
// Named places worth standing. Round 7's plan calls for these to carry
// sit/cook/read poses eventually; right now they do two useful jobs already:
// they give the wander controller somewhere deliberate to go instead of only
// picking uniformly random points, and they give the scene-state channel
// something concrete to tell Luna she's near ("standing at the kitchen
// counter" reads better than "in the kitchen").
// ---------------------------------------------------------------------------

export interface Anchor {
  id: string;
  room: RoomId;
  x: number;
  z: number;
  /** Which way she faces when she gets there, radians. */
  facing: number;
  /** What the scene-state channel calls it. */
  description: string;
  /** Roughly how long she lingers, seconds. */
  dwell: [number, number];
}

// Every position below was checked by the same audit script that rebuilt
// PATCHES above: each one falls inside a real NavPatch, clear of the
// furniture piece it's named after (not on top of it) -- five of these
// nine moved from their round-9-era coordinates for exactly that reason.
// `facing` values are a reasoned guess at which way she'd face standing
// there, not something that could be checked without a render.
export const ANCHORS: Anchor[] = [
  { id: 'sofa',      room: 'living',   x: 2.1,  z: 3.0,  facing: -Math.PI / 2, description: 'by the sofa', dwell: [14, 30] },
  { id: 'window',    room: 'living',   x: 2.6,  z: 1.25, facing: Math.PI,      description: 'looking out the living room window', dwell: [10, 22] },
  { id: 'dining',    room: 'living',   x: 6.3,  z: 1.75, facing: -Math.PI / 2, description: 'at the dining table', dwell: [10, 20] },
  { id: 'counter',   room: 'kitchen',  x: 7.5,  z: 1.4,  facing: Math.PI,      description: 'at the kitchen counter', dwell: [12, 26] },
  { id: 'fridge',    room: 'kitchen',  x: 9.5,  z: 1.2,  facing: Math.PI / 2,  description: 'by the fridge', dwell: [6, 12] },
  { id: 'desk',      room: 'bedroom',  x: 2.7,  z: 8.9,  facing: Math.PI,      description: 'at her desk', dwell: [18, 40] },
  { id: 'bedside',   room: 'bedroom',  x: 2.2,  z: 7.6,  facing: -Math.PI / 2, description: 'by her bed', dwell: [10, 20] },
  { id: 'basin',     room: 'bathroom', x: 7.0,  z: 7.5,  facing: Math.PI,      description: 'at the bathroom basin', dwell: [8, 16] },
  { id: 'frontdoor', room: 'hall',     x: 9.6,  z: 5.8,  facing: -Math.PI / 2, description: 'by the front door', dwell: [5, 10] },
];

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

/** Which room a world point is in, or null if it's outside the apartment. */
export function roomAt(x: number, z: number): RoomDef | null {
  for (const r of ROOMS) {
    if (x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ) return r;
  }
  return null;
}

/** Nearest anchor to a point within `maxDist`, for scene-state descriptions. */
export function anchorNear(x: number, z: number, maxDist = 1.2): Anchor | null {
  let best: Anchor | null = null;
  let bestD2 = maxDist * maxDist;
  for (const a of ANCHORS) {
    const d2 = (a.x - x) ** 2 + (a.z - z) ** 2;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = a;
    }
  }
  return best;
}

/** Centre of the apartment, used to frame the initial camera. */
export const CENTRE = {
  x: (FOOTPRINT.minX + FOOTPRINT.maxX) / 2,
  z: (FOOTPRINT.minZ + FOOTPRINT.maxZ) / 2,
};
