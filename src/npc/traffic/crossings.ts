// Pedestrian crossings shared by the crowd (walkers) and traffic (taxis): the zebra crossings on
// both roads plus the four cross-street mouths the sidewalks run across. Each frame the crowd
// counts walkers standing inside each rect (`busy`) and traffic flags crossings a taxi is about to
// drive over (`near`). Taxis stop for a busy crossing; walkers wait at the curb while one is near.
// Module state on purpose: crowd and traffic are created independently by main.ts.
import { CROSS_STREETS, Z } from '../../core/layout';
import { CROSSINGS_NORTH, CROSSINGS_SOUTH, CROSSING_HALF } from '../../world/street/ground';

export interface CrossingRect { x0: number; x1: number; z0: number; z1: number }

export const CROSSINGS: CrossingRect[] = [
  ...CROSSINGS_NORTH.map((x) => ({ x0: x - CROSSING_HALF, x1: x + CROSSING_HALF, z0: Z.northRoadOuter, z1: Z.northRoadInner })),
  ...CROSSINGS_SOUTH.map((x) => ({ x0: x - CROSSING_HALF, x1: x + CROSSING_HALF, z0: Z.southRoadInner, z1: Z.southRoadOuter })),
  // cross-street mouths: the avenue sidewalks cross the arm roads (x ±4) just off the avenue
  ...CROSS_STREETS.flatMap((c) => [
    { x0: c.x - 4, x1: c.x + 4, z0: Z.northRoadOuter - 4.5, z1: Z.northRoadOuter },
    { x0: c.x - 4, x1: c.x + 4, z0: Z.southRoadOuter, z1: Z.southRoadOuter + 4.5 },
  ]),
];

/** Walkers inside each crossing (recounted by the crowd every frame). */
export const crossingBusy = new Uint8Array(CROSSINGS.length);
/** 1 = a taxi will drive over this crossing within a few seconds (rewritten by traffic every frame). */
export const crossingNear = new Uint8Array(CROSSINGS.length);

export function crossingAt(x: number, z: number, margin = 0): number {
  for (let i = 0; i < CROSSINGS.length; i++) {
    const c = CROSSINGS[i];
    if (x > c.x0 - margin && x < c.x1 + margin && z > c.z0 - margin && z < c.z1 + margin) return i;
  }
  return -1;
}
