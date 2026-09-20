/**
 * The apartment, as data -- round 12 rewrite.
 *
 * Round 11 and earlier authored this file by hand: real walls, real doors,
 * a nine-room navmesh, named anchors checked against furniture placement.
 * That's gone. The user dropped in a whole prebuilt apartment model
 * (`public/apartment/twokinds_modern_trio_apartment.glb`, a Sketchfab
 * download -- see index.ts) to replace the hand-authored geometry entirely,
 * because the procedural furniture/materials system was producing visibly
 * broken results (a UV-checker bathtub texture, a floating towel, a toilet
 * missing its bowl -- see the user's round-11 screenshots) that couldn't be
 * fixed by someone with no way to see the render.
 *
 * The real model has no per-room or per-anchor data in it worth reading:
 * `gltf-transform inspect` shows generic `Object_0`, `Object_1`, ... mesh
 * names, not `Kitchen_Counter` or `Bedroom_Door` -- so there is no reliable
 * way to derive real room boundaries, door positions, or "where the couch
 * is" from the file itself. What follows is a deliberately honest
 * placeholder: one big walkable rectangle sized to the model's actual
 * measured bounding box (from that same `gltf-transform inspect` run:
 * bboxMin (-9.895, -0.079, -3.743), bboxMax (9.231, 2.777, 7.152), rounded
 * inward slightly for margin), with a handful of generic anchors scattered
 * across it rather than real named furniture positions.
 *
 * This means: no room-level lookup ("she's in the kitchen"), no doors, no
 * per-furniture navmesh gaps -- wandering and visitor-mode collision only
 * know about the outer footprint, not interior walls. Getting real room
 * boundaries and anchor points back requires someone who can actually see
 * the loaded model point out where the walls and furniture are -- that's
 * follow-up work, not something to guess at here.
 */

export const CEILING_H = 2.6;

export type RoomId = 'apartment';

export interface RoomDef {
  id: RoomId;
  /** What Luna calls it when she talks about where she is. */
  label: string;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** Measured from the real model's bounding box, rounded inward ~0.1m for
 * margin. Not room-accurate -- there's only one "room": the whole flat. */
export const FOOTPRINT = {
  minX: -9.8,
  maxX: 9.15,
  minZ: -3.65,
  maxZ: 7.05,
};

export const ROOMS: RoomDef[] = [
  { id: 'apartment', label: 'the apartment', ...FOOTPRINT },
];

export interface NavPatch {
  name: string;
  room: RoomId;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Doorway patches are narrow; the wander targeting uses a smaller margin.
   * Always false here -- no real doorways are known yet. */
  doorway?: boolean;
}

/** One patch covering the whole footprint. Not room-accurate: walking
 * through an interior wall isn't currently prevented, because where the
 * interior walls actually are isn't known. */
export const PATCHES: NavPatch[] = [
  { name: 'whole-flat', room: 'apartment', ...FOOTPRINT },
];

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

/** Centre of the apartment, used to frame the initial camera and as the
 * anchor grid's origin. */
export const CENTRE = {
  x: (FOOTPRINT.minX + FOOTPRINT.maxX) / 2,
  z: (FOOTPRINT.minZ + FOOTPRINT.maxZ) / 2,
};

// Generic points spread across the footprint, not real furniture positions
// -- there are at least two so WanderController's "don't repeat the last
// anchor" filter never empties the list. `facing` is arbitrary; nobody has
// seen the actual room to know which way she'd plausibly be looking.
export const ANCHORS: Anchor[] = [
  { id: 'centre', room: 'apartment', x: CENTRE.x,     z: CENTRE.z,     facing: 0,             description: 'in the middle of the apartment', dwell: [10, 22] },
  { id: 'east',   room: 'apartment', x: CENTRE.x + 6, z: CENTRE.z,     facing: -Math.PI / 2,  description: 'toward one end of the apartment', dwell: [10, 20] },
  { id: 'west',   room: 'apartment', x: CENTRE.x - 6, z: CENTRE.z,     facing: Math.PI / 2,   description: 'toward the other end of the apartment', dwell: [10, 20] },
  { id: 'north',  room: 'apartment', x: CENTRE.x,     z: CENTRE.z - 3, facing: Math.PI,       description: 'near one of the walls', dwell: [8, 16] },
];

/** Which room a world point is in, or null if it's outside the apartment.
 * Always either the one room or null now -- kept as a function, not a
 * constant, so callers don't need to change when real rooms come back. */
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

export interface DoorDef {
  id: string;
  /** Exact node names of this door's mesh(es) in the loaded model. The
   * file has no useful names to go on (generic Object_N), so these were
   * found geometrically instead: scanning every mesh's real world-space
   * bounding box for the shape of a door panel (roughly 0.6-1.2m wide,
   * 1.7-2.3m tall, thin the other way, bottom near the floor). Some doors
   * matched two nearby meshes (frame + panel, most likely) -- both are
   * included and toggled together, since there's no way to tell which is
   * which from geometry alone. See docs/DECISIONS.md's round-15 entry for
   * the exact search and its numbers.
   *
   * What this buys: a door "opens" by disappearing (and stops blocking
   * movement) when someone's close enough, and reappears (blocking again)
   * once they're not -- not a hinge swing. Real geometry doesn't say which
   * vertical edge is the hinge or which way it should swing, and guessing
   * wrong would look worse than not animating it at all.
   */
  meshNames: string[];
  x: number;
  z: number;
  /** Half-extents of the door's footprint, for the closed-door collision
   * box (separate from and excluded out of the main collision BVH -- see
   * buildCollisionGeometry). */
  halfW: number;
  halfD: number;
}

export const DOORS: DoorDef[] = [
  { id: 'door-1', meshNames: ['Object_291'], x: -0.79, z: 6.55, halfW: 0.5, halfD: 0.12 },
  { id: 'door-2', meshNames: ['Object_302'], x: 1.08, z: 1.2, halfW: 0.12, halfD: 0.52 },
  { id: 'door-3', meshNames: ['Object_309', 'Object_311'], x: 1.47, z: 3.29, halfW: 0.5, halfD: 0.12 },
  { id: 'door-4', meshNames: ['Object_320'], x: 5.99, z: 1.57, halfW: 0.48, halfD: 0.12 },
  { id: 'door-5', meshNames: ['Object_339', 'Object_341'], x: -3.22, z: 5.63, halfW: 0.12, halfD: 0.42 },
];

