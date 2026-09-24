// Map layout of the (compressed) Avenue Habib Bourguiba. Single source of truth for coordinates.
// Axes: X along the avenue (west −X → east +X), Y up, Z across (north −Z, south +Z). Meters.
// Heights: road surface y = 0; sidewalks, promenade and plazas y = CURB (raised by the curb).
//
//   z = -30  ── north facade line ─────────────────────────────────────────
//   z -30..-22  north sidewalk (café terraces against the facades)
//   z -22..-14  north road: 2 lanes WESTBOUND (Tunisia drives on the right)
//   z -14..+14  central promenade: 2 rows of ficus, benches, lamps, kiosks, bins
//   z +14..+22  south road: 2 lanes EASTBOUND
//   z +22..+30  south sidewalk (café terraces)
//   z = +30  ── south facade line ─────────────────────────────────────────
//
// West end: Place de l'Indépendance (pedestrian plaza, x -310..-240): cathedral (north) faces the
// French Embassy (south), Ibn Khaldoun statue in the middle. Avenue de France continues west
// (visual only, beyond a barrier) to Porte de France / Bab el Bhar.
// East end: Place du 14 Janvier 2011 (plaza, x 260..310) with the Clock Tower. Beyond a barrier the
// avenue continues (visual only) toward the Lake of Tunis.
import { Vector3 } from 'three';

export const CURB = 0.15;

/** Playable extents along X (plazas included). Beyond are barriers + visual-only backdrops. */
export const X_MIN = -310;
export const X_MAX = 310;

export const Z = {
  northFacade: -30,
  northRoadOuter: -22, // curb between north sidewalk and north road
  northRoadInner: -14, // curb between north road and promenade
  southRoadInner: 14,
  southRoadOuter: 22,
  southFacade: 30,
} as const;

/** Roads (y = 0) only exist between the two plazas. */
export const ROAD_X = { min: -240, max: 260 } as const;

export const PLAZA_WEST = { xMin: X_MIN, xMax: ROAD_X.min } as const; // Place de l'Indépendance
export const PLAZA_EAST = { xMin: ROAD_X.max, xMax: X_MAX } as const; // Place du 14 Janvier 2011

/** Driving lanes: centre z and travel direction along X. */
export const LANES = [
  { z: -20, dir: -1 },
  { z: -16, dir: -1 },
  { z: 16, dir: 1 },
  { z: 20, dir: 1 },
] as const;

/**
 * Cross streets at both road ends, on both sides (north arm z < -30, south arm z > 30).
 * Each arm is `depth` long and closed at its end by a building (the street "turns" out of view),
 * which is where taxis spawn/despawn unseen. Road surface y = 0 with 2 m sidewalks each side.
 * The road ends of the avenue connect into these arms (taxis turn in/out).
 */
export const CROSS_STREETS = [
  { x: -234, width: 12, depth: 26 },
  { x: 254, width: 12, depth: 26 },
] as const;

/** Taxi routes: spawn around the corner at the end of one cross-street arm, despawn at another. */
export const TAXI_ROUTES = [
  // westbound on the north road: east cross street (north arm) → west cross street (north arm)
  { spawn: new Vector3(254, 0, -54), laneZ: [-20, -16], dir: -1, exit: new Vector3(-234, 0, -54) },
  // eastbound on the south road: west cross street (south arm) → east cross street (south arm)
  { spawn: new Vector3(-234, 0, 54), laneZ: [16, 20], dir: 1, exit: new Vector3(254, 0, 54) },
] as const;

/** Short pedestrian dead-end alleys into the facade blocks, closed by barriers / a parked van. */
export const ALLEYS = [
  { x: -140, side: -1, width: 8, depth: 14 },
  { x: -60, side: -1, width: 8, depth: 14 },
  { x: 70, side: -1, width: 8, depth: 14 },
  { x: 170, side: -1, width: 8, depth: 14 },
  { x: -110, side: 1, width: 8, depth: 14 },
  { x: 25, side: 1, width: 8, depth: 14 },
  { x: 110, side: 1, width: 8, depth: 14 },
  { x: 190, side: 1, width: 8, depth: 14 },
] as const; // side: -1 = north, +1 = south

/** Café terraces on the sidewalks, in front of café storefronts (buildings put cafés here). */
export const CAFE_TERRACES = [
  { xMin: -120, xMax: -95, side: -1 },
  { xMin: 0, xMax: 30, side: -1 },
  { xMin: 100, xMax: 130, side: -1 },
  { xMin: -85, xMax: -60, side: 1 },
  { xMin: 40, xMax: 70, side: 1 },
  { xMin: 145, xMax: 175, side: 1 },
] as const;

/** Kiosks on the promenade (footprint ~3 x 2.4 m, roof ≈ 2.3 m above the promenade). Each gets a
 *  stack of crates (~1 m) beside it so Labib can hop onto the roof. */
export const KIOSKS = [
  { x: -205, z: 4, kind: 'newspaper' },
  { x: -125, z: -4, kind: 'flowers' },
  { x: -25, z: 4, kind: 'newspaper' },
  { x: 55, z: -4, kind: 'flowers' },
  { x: 135, z: 4, kind: 'newspaper' },
  { x: 172, z: -4, kind: 'snack' },
] as const;

/** Ficus rows along the promenade. Trees every TREE_SPACING between x min..max. */
export const TREE_ROWS_Z = [-9.5, 9.5] as const;
export const TREE_X = { min: -234, max: 252, spacing: 8.5 } as const;

/** Recycling bins (gameplay places them; world must keep ~1.5 m clear around each). */
export const BINS: { x: number; z: number }[] = [
  // promenade
  { x: -215, z: -2 }, { x: -160, z: 2 }, { x: -95, z: -2 }, { x: -40, z: 2 },
  { x: 20, z: -2 }, { x: 85, z: 2 }, { x: 150, z: -2 }, { x: 188, z: 2 },
  // sidewalks
  { x: -150, z: -24.5 }, { x: -30, z: 24.5 }, { x: 80, z: -24.5 }, { x: 215, z: 24.5 },
  // plazas
  { x: -255, z: 10 }, { x: 270, z: -10 },
];

/** Landmark slots. Facades face the avenue. Footprints are x/z ranges the buildings module must
 *  leave empty; the landmarks module builds inside them. */
export const LANDMARKS = {
  cathedral: { xMin: -290, xMax: -254, zMin: -80, zMax: -30 }, // St Vincent de Paul, facade faces +Z
  embassy: { xMin: -296, xMax: -248, zMin: 30, zMax: 62 }, // French Embassy, faces −Z, fence at z=30
  ibnKhaldoun: { x: -272, z: 0 }, // statue on a plinth, looking east (+X) down the avenue
  theatre: { xMin: -192, xMax: -158, zMin: -62, zMax: -30 }, // Théâtre Municipal, faces +Z
  colisee: { xMin: -50, xMax: -10, zMin: 30, zMax: 60 }, // Le Colisée, faces −Z
  bourguibaStatue: { x: 205, z: 0 }, // equestrian statue on the promenade, facing west (−X)
  clockTower: { x: 285, z: 0 }, // Place du 14 Janvier 2011, 38 m
  porteDeFrance: { x: -430, z: 0 }, // backdrop, facing east, at the end of Avenue de France
} as const;

/** Avenue de France (visual only, west of the barrier): narrower street to Porte de France. */
export const AVENUE_DE_FRANCE = { xMin: -440, xMax: X_MIN, zMin: -12, zMax: 12 } as const;
/** East backdrop (visual only): avenue continues toward the lake; water starts at LAKE_X. */
export const EAST_BACKDROP = { xMin: X_MAX, xMax: 390 } as const;
export const LAKE_X = 400;

export const PLAYER_SPAWN = new Vector3(-236, CURB, 0);
export const PLAYER_SPAWN_YAW = Math.PI / 2; // facing +X (east), down the avenue

/** Where gameplay may scatter free-floor litter (y = CURB unless road). */
export const LITTER_ZONES = [
  { xMin: ROAD_X.min, xMax: ROAD_X.max, zMin: -13.5, zMax: 13.5, y: CURB }, // promenade
  { xMin: ROAD_X.min, xMax: ROAD_X.max, zMin: -29.5, zMax: -22.5, y: CURB }, // north sidewalk
  { xMin: ROAD_X.min, xMax: ROAD_X.max, zMin: 22.5, zMax: 29.5, y: CURB }, // south sidewalk
  { xMin: X_MIN + 4, xMax: PLAZA_WEST.xMax, zMin: -26, zMax: 26, y: CURB }, // west plaza
  { xMin: PLAZA_EAST.xMin, xMax: X_MAX - 4, zMin: -26, zMax: 26, y: CURB }, // east plaza
] as const;
