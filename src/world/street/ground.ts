// All walkable ground of the playable map + visual-only floors beyond the barriers.
// Floors are raised slabs (colliders from y=-0.5 up to CURB) so the character controller steps
// up the 0.15 m granite curbs; roads are at y=0. Surfaces are merged into one mesh per material
// (flat ground is cheap to vertex-process, so chunking it would only add draw calls).
import * as THREE from 'three';
import type { BuildContext } from '../../core/types';
import {
  CURB, X_MIN, X_MAX, Z, ROAD_X, PLAZA_WEST, PLAZA_EAST, CROSS_STREETS, ALLEYS, LANDMARKS,
  AVENUE_DE_FRANCE, EAST_BACKDROP, LAKE_X,
} from '../../core/layout';
import { Owned, boxCollider, makeRng } from './common';
import type { StreetMaterials } from './materials';

/** Zebra crossings (centre x) on each road, snapped to the gaps between the ficus trees. */
export const CROSSINGS_NORTH = [-195.75, -85.25, 8.25, 118.75, 229.25];
export const CROSSINGS_SOUTH = [-170.25, -51.25, 59.25, 161.25, 220.75];
export const CROSSING_HALF = 2; // half width along X
/** Round islands kept free for the landmarks module (plus ring inlays drawn around them). */
export const ISLANDS = [
  { x: LANDMARKS.ibnKhaldoun.x, z: LANDMARKS.ibnKhaldoun.z, r: 5 },
  { x: LANDMARKS.bourguibaStatue.x, z: LANDMARKS.bourguibaStatue.z, r: 5 },
  { x: LANDMARKS.clockTower.x, z: LANDMARKS.clockTower.z, r: 7 },
];
const CURB_W = 0.3; // granite curb top width
const GUTTER_W = 0.35;
export const QUAY_X = LAKE_X - 2; // stone embankment between the east backdrop and the lake
export const WATER_Y = -1.1;

type V3 = [number, number, number];

/** Accumulates quads into one indexed geometry. Winding is fixed from the wanted normal. */
class Quads {
  private p: number[] = [];
  private n: number[] = [];
  private uv: number[] = [];
  private idx: number[] = [];
  quad(a: V3, b: V3, c: V3, d: V3, nrm: V3, uvs: [number, number][]): void {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cr = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    const flip = cr[0] * nrm[0] + cr[1] * nrm[1] + cr[2] * nrm[2] < 0;
    const base = this.p.length / 3;
    for (const [i, v] of [a, b, c, d].entries()) {
      this.p.push(...v);
      this.n.push(...nrm);
      this.uv.push(...uvs[i]);
    }
    if (flip) this.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    else this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  /** Horizontal rect at height y, metric planar UV (tile metres per UV unit). */
  flat(x0: number, z0: number, x1: number, z1: number, y: number, tile: number, swap = false): void {
    const uv = (x: number, z: number): [number, number] => (swap ? [z / tile, x / tile] : [x / tile, -z / tile]);
    this.quad([x0, y, z0], [x0, y, z1], [x1, y, z1], [x1, y, z0], [0, 1, 0], [uv(x0, z0), uv(x0, z1), uv(x1, z1), uv(x1, z0)]);
  }
  /** Flat annulus (ring inlay) around a centre. */
  ring(cx: number, cz: number, r0: number, r1: number, y: number, tile: number, seg = 64): void {
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const P = (r: number, a: number): V3 => [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r];
      const pts = [P(r0, a0), P(r1, a0), P(r1, a1), P(r0, a1)];
      this.quad(pts[0], pts[1], pts[2], pts[3], [0, 1, 0], pts.map((v) => [v[0] / tile, -v[2] / tile] as [number, number]));
    }
  }
  /** Flat quad from 4 xz points with planar UV. */
  flatPoly(pts: [number, number][], y: number, tile: number): void {
    const v = pts.map(([x, z]) => [x, y, z] as V3);
    this.quad(v[0], v[1], v[2], v[3], [0, 1, 0], pts.map(([x, z]) => [x / tile, -z / tile] as [number, number]));
  }
  get empty(): boolean {
    return this.idx.length === 0;
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** A curb along an axis-aligned line; `out` points from the raised side toward the road. */
interface CurbLine {
  axis: 'x' | 'z'; // the line runs along this axis
  at: number; // coordinate of the edge on the other axis
  from: number;
  to: number;
  out: 1 | -1; // road lies on +out side of `at`
  anchors?: boolean; // emit gutter anchors (playable roads only)
}

export interface GroundResult {
  meshes: THREE.Mesh[];
  roadEdges: THREE.Vector3[];
}

export function buildGround(ctx: BuildContext, o: Owned, M: StreetMaterials): GroundResult {
  const T = M.tile;
  const q = {
    asphalt: new Quads(), promenade: new Quads(), sidewalk: new Quads(), plaza: new Quads(),
    inlay: new Quads(), granite: new Quads(), paint: new Quads(), covers: new Quads(),
  };
  const rng = makeRng(4242);
  const roadEdges: THREE.Vector3[] = [];

  // --- Road surfaces (y = 0) -----------------------------------------------------------------
  const roads: [number, number, number, number][] = [
    [ROAD_X.min, ROAD_X.max, Z.northRoadOuter, Z.northRoadInner],
    [ROAD_X.min, ROAD_X.max, Z.southRoadInner, Z.southRoadOuter],
  ];
  const arms: { x0: number; x1: number; z0: number; z1: number }[] = [];
  for (const cs of CROSS_STREETS) {
    const r0 = cs.x - cs.width / 2 + 2, r1 = cs.x + cs.width / 2 - 2; // 2 m sidewalks each side
    arms.push({ x0: r0, x1: r1, z0: Z.northFacade - cs.depth, z1: Z.northRoadOuter });
    arms.push({ x0: r0, x1: r1, z0: Z.southRoadOuter, z1: Z.southFacade + cs.depth });
    roads.push([r0, r1, Z.northFacade - cs.depth, Z.northRoadOuter], [r0, r1, Z.southRoadOuter, Z.southFacade + cs.depth]);
  }
  // visual-only roads
  roads.push([AVENUE_DE_FRANCE.xMin, AVENUE_DE_FRANCE.xMax, -5, 5]);
  roads.push([EAST_BACKDROP.xMin, QUAY_X - 3, Z.northRoadOuter, Z.northRoadInner], [EAST_BACKDROP.xMin, QUAY_X - 3, Z.southRoadInner, Z.southRoadOuter]);
  for (const [x0, x1, z0, z1] of roads) q.asphalt.flat(x0, z0, x1, z1, 0, T.asphalt);
  // wide base under everything (gaps between other modules' buildings never show the void), with
  // the areas our own floors cover cut out: a full-screen layer of hidden PBR overdraw otherwise
  {
    const bx0 = AVENUE_DE_FRANCE.xMin - 40, bx1 = QUAY_X - 3, adf = AVENUE_DE_FRANCE; // the quay strip covers bx1..QUAY_X
    for (const [x0, x1, z0, z1] of [
      [bx0, bx1, -260, Z.northFacade], [bx0, bx1, Z.southFacade, 260], // beyond the facade lines
      [bx0, adf.xMin, Z.northFacade, Z.southFacade], // west of Avenue de France
      [adf.xMin, X_MIN, Z.northFacade, adf.zMin], [adf.xMin, X_MIN, adf.zMax, Z.southFacade], // under its buildings
    ] as const) q.asphalt.flat(x0, z0, x1, z1, -0.04, T.asphalt);
  }

  // --- Raised pedestrian surfaces (y = CURB) ------------------------------------------------
  const raised = (mat: Quads, x0: number, x1: number, z0: number, z1: number, tile: number, collide = true, swap = false) => {
    mat.flat(x0, z0, x1, z1, CURB, tile, swap);
    if (collide) boxCollider(o, ctx, x0, x1, -0.5, CURB, z0, z1);
  };
  raised(q.promenade, ROAD_X.min, ROAD_X.max, Z.northRoadInner, Z.southRoadInner, T.promenade);
  raised(q.plaza, PLAZA_WEST.xMin, PLAZA_WEST.xMax, Z.northFacade, Z.southFacade, T.plaza);
  raised(q.plaza, PLAZA_EAST.xMin, PLAZA_EAST.xMax, Z.northFacade, Z.southFacade, T.plaza);
  // avenue sidewalks, interrupted by the cross-street roads
  const armGapsX = CROSS_STREETS.map((cs) => [cs.x - cs.width / 2 + 2, cs.x + cs.width / 2 - 2] as const);
  const sideSegs: [number, number][] = [];
  let sx: number = ROAD_X.min;
  for (const [g0, g1] of armGapsX) {
    if (g0 > sx) sideSegs.push([sx, g0]);
    sx = g1;
  }
  sideSegs.push([sx, ROAD_X.max]);
  for (const [x0, x1] of sideSegs) {
    raised(q.sidewalk, x0, x1, Z.northFacade, Z.northRoadOuter, T.sidewalk);
    raised(q.sidewalk, x0, x1, Z.southRoadOuter, Z.southFacade, T.sidewalk);
  }
  // cross-street sidewalks (2 m each side)
  for (const cs of CROSS_STREETS) {
    for (const [x0, x1] of [[cs.x - cs.width / 2, cs.x - cs.width / 2 + 2], [cs.x + cs.width / 2 - 2, cs.x + cs.width / 2]]) {
      raised(q.sidewalk, x0, x1, Z.northFacade - cs.depth, Z.northFacade, T.sidewalk, true, true);
      raised(q.sidewalk, x0, x1, Z.southFacade, Z.southFacade + cs.depth, T.sidewalk, true, true);
    }
  }
  // alleys (pedestrian dead ends into the blocks)
  for (const a of ALLEYS) {
    const z0 = a.side < 0 ? Z.northFacade - a.depth : Z.southFacade;
    raised(q.sidewalk, a.x - a.width / 2, a.x + a.width / 2, z0, z0 + a.depth, T.sidewalk, true, true);
  }
  // visual-only: Avenue de France sidewalks, east backdrop cross-section, quay
  raised(q.sidewalk, AVENUE_DE_FRANCE.xMin, AVENUE_DE_FRANCE.xMax, AVENUE_DE_FRANCE.zMin, -5, T.sidewalk, false);
  raised(q.sidewalk, AVENUE_DE_FRANCE.xMin, AVENUE_DE_FRANCE.xMax, 5, AVENUE_DE_FRANCE.zMax, T.sidewalk, false);
  raised(q.promenade, EAST_BACKDROP.xMin, QUAY_X - 3, Z.northRoadInner, Z.southRoadInner, T.promenade, false);
  raised(q.sidewalk, EAST_BACKDROP.xMin, QUAY_X - 3, Z.northFacade, Z.northRoadOuter, T.sidewalk, false);
  raised(q.sidewalk, EAST_BACKDROP.xMin, QUAY_X - 3, Z.southRoadOuter, Z.southFacade, T.sidewalk, false);
  raised(q.plaza, QUAY_X - 3, QUAY_X, -260, 260, T.plaza, false);

  // catch-all road-level floor under the whole playable map (arms, under buildings, litter)
  boxCollider(o, ctx, X_MIN - 10, X_MAX + 10, -0.5, 0, Z.northFacade - 40, Z.southFacade + 40);

  // --- Curbs ----------------------------------------------------------------------------------
  const curbs: CurbLine[] = [];
  const avenueCurbs = (x0: number, x1: number, anchors: boolean) => {
    curbs.push({ axis: 'x', at: Z.northRoadInner, from: x0, to: x1, out: -1, anchors });
    curbs.push({ axis: 'x', at: Z.southRoadInner, from: x0, to: x1, out: 1, anchors });
  };
  avenueCurbs(ROAD_X.min, ROAD_X.max, true);
  avenueCurbs(EAST_BACKDROP.xMin, QUAY_X - 3, false);
  for (const [x0, x1] of sideSegs) {
    curbs.push({ axis: 'x', at: Z.northRoadOuter, from: x0, to: x1, out: 1, anchors: true });
    curbs.push({ axis: 'x', at: Z.southRoadOuter, from: x0, to: x1, out: -1, anchors: true });
  }
  curbs.push({ axis: 'x', at: Z.northRoadOuter, from: EAST_BACKDROP.xMin, to: QUAY_X - 3, out: 1 });
  curbs.push({ axis: 'x', at: Z.southRoadOuter, from: EAST_BACKDROP.xMin, to: QUAY_X - 3, out: -1 });
  for (const z of [[Z.northRoadOuter, Z.northRoadInner], [Z.southRoadInner, Z.southRoadOuter]]) {
    curbs.push({ axis: 'z', at: ROAD_X.min, from: z[0], to: z[1], out: 1 }); // road ends against the plazas
    curbs.push({ axis: 'z', at: ROAD_X.max, from: z[0], to: z[1], out: -1 });
    curbs.push({ axis: 'z', at: EAST_BACKDROP.xMin, from: z[0], to: z[1], out: 1 });
    curbs.push({ axis: 'z', at: QUAY_X - 3, from: z[0], to: z[1], out: -1 });
  }
  for (const a of arms) {
    curbs.push({ axis: 'z', at: a.x0, from: a.z0, to: a.z1, out: 1 });
    curbs.push({ axis: 'z', at: a.x1, from: a.z0, to: a.z1, out: -1 });
  }
  curbs.push({ axis: 'x', at: -5, from: AVENUE_DE_FRANCE.xMin, to: AVENUE_DE_FRANCE.xMax, out: 1 });
  curbs.push({ axis: 'x', at: 5, from: AVENUE_DE_FRANCE.xMin, to: AVENUE_DE_FRANCE.xMax, out: -1 });
  curbs.push({ axis: 'z', at: X_MIN, from: -5, to: 5, out: -1 });

  const B = 0.025; // bevel
  const crossingAt = (z: number, x: number) => {
    const list = z < 0 ? CROSSINGS_NORTH : CROSSINGS_SOUTH;
    return list.some((c) => Math.abs(c - x) < CROSSING_HALF + 0.6);
  };
  for (const c of curbs) {
    // point on the line: s = along-axis coordinate, d = signed offset toward the road
    const P = (s: number, d: number, y: number): V3 => (c.axis === 'x' ? [s, y, c.at + d * c.out] : [c.at + d * c.out, y, s]);
    const nOut: V3 = c.axis === 'x' ? [0, 0, c.out] : [c.out, 0, 0];
    const s0 = c.from, s1 = c.to;
    const planar = (v: V3): [number, number] => [v[0] / T.granite, -v[2] / T.granite];
    const side = (v: V3): [number, number] => [(c.axis === 'x' ? v[0] : v[2]) / T.granite, v[1] / T.granite];
    let pts: V3[] = [P(s0, -CURB_W, CURB), P(s1, -CURB_W, CURB), P(s1, -B, CURB), P(s0, -B, CURB)];
    q.inlay.quad(pts[0], pts[1], pts[2], pts[3], [0, 1, 0], pts.map(planar));
    const bn: V3 = [nOut[0] * 0.7071, 0.7071, nOut[2] * 0.7071];
    pts = [P(s0, -B, CURB), P(s1, -B, CURB), P(s1, 0, CURB - B), P(s0, 0, CURB - B)];
    q.granite.quad(pts[0], pts[1], pts[2], pts[3], bn, pts.map(side));
    pts = [P(s0, 0, CURB - B), P(s1, 0, CURB - B), P(s1, 0, 0), P(s0, 0, 0)];
    q.granite.quad(pts[0], pts[1], pts[2], pts[3], nOut, pts.map(side));
    // gutter of small setts on the road side
    pts = [P(s0, 0, 0), P(s1, 0, 0), P(s1, GUTTER_W, 0), P(s0, GUTTER_W, 0)];
    q.inlay.quad(pts[0], pts[1], pts[2], pts[3], [0, 1, 0], pts.map((v) => [v[0] / 0.6, -v[2] / 0.6] as [number, number]));
    // drains every ~28 m + gutter anchors every ~7 m (not on crossings)
    const len = s1 - s0;
    if (len > 12) {
      for (let s = s0 + 9 + rng() * 6; s < s1 - 4; s += 26 + rng() * 6) {
        if (c.axis === 'x' && crossingAt(c.at, s)) continue;
        const a = P(s - 0.4, 0.02, 0.001), b = P(s + 0.4, 0.02, 0.001), cc = P(s + 0.4, 0.37, 0.001), d = P(s - 0.4, 0.37, 0.001);
        q.covers.quad(a, b, cc, d, [0, 1, 0], [[0.52, 0.02], [0.98, 0.02], [0.98, 0.98], [0.52, 0.98]]);
      }
    }
    if (c.anchors) {
      for (let s = s0 + 3; s < s1 - 2; s += 7) {
        if (c.axis === 'x' && crossingAt(c.at, s)) continue;
        const v = P(s, 0.22, 0);
        roadEdges.push(new THREE.Vector3(v[0], 0, v[2]));
      }
    }
  }

  // --- Inlaid granite bands (promenade + plazas), clipped around the landmark islands --------
  const ringOuter = (i: { r: number }) => i.r + (i.r >= 7 ? 4.6 : 2.6);
  /** Axis-aligned band from (ax,az) to (bx,bz), `w` wide, split where it crosses an island. */
  const bandSeg = (ax: number, az: number, bx: number, bz: number, w: number) => {
    const vertical = ax === bx;
    let pieces: [number, number][] = [[vertical ? az : ax, vertical ? bz : bx]];
    for (const isl of ISLANDS) {
      const R = ringOuter(isl) + w;
      const off = vertical ? ax - isl.x : az - isl.z;
      if (Math.abs(off) >= R) continue;
      const h = Math.sqrt(R * R - off * off), c = vertical ? isl.z : isl.x;
      pieces = pieces.flatMap(([p0, p1]) =>
        p1 <= c - h || p0 >= c + h ? [[p0, p1] as [number, number]] : ([[p0, c - h], [c + h, p1]] as [number, number][]).filter(([a, b]) => b - a > 0.1));
    }
    for (const [p0, p1] of pieces) {
      if (vertical) q.inlay.flat(ax - w / 2, p0, ax + w / 2, p1, CURB, T.granite);
      else q.inlay.flat(p0, az - w / 2, p1, az + w / 2, CURB, T.granite);
    }
  };
  // promenade: borders along the curbs, lines framing the central walk, cross bands every 17 m
  for (const s of [-1, 1]) {
    bandSeg(ROAD_X.min, s * 12.78, ROAD_X.max, s * 12.78, 0.45);
    bandSeg(ROAD_X.min, s * 7.05, ROAD_X.max, s * 7.05, 0.3);
  }
  for (let x = -234 + 4.25; x < ROAD_X.max; x += 17) bandSeg(x, -12.55, x, 12.55, 0.4);
  // plazas: 10 m grid, and a double ring with spokes at each island
  for (const pz of [PLAZA_WEST, PLAZA_EAST]) {
    for (let x = Math.ceil((pz.xMin + 1) / 10) * 10; x < pz.xMax - 1; x += 10) bandSeg(x, Z.northFacade, x, Z.southFacade, 0.4);
    for (let z = -20; z <= 20; z += 10) bandSeg(pz.xMin, z, pz.xMax, z, 0.4);
  }
  for (const isl of ISLANDS) {
    const R1 = ringOuter(isl);
    q.inlay.ring(isl.x, isl.z, isl.r + 0.25, isl.r + 0.85, CURB, T.granite, 72);
    q.inlay.ring(isl.x, isl.z, R1 - 0.6, R1, CURB, T.granite, 96);
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2, w = 0.16;
      const r0 = isl.r + 0.85, r1 = R1 - 0.6;
      const ca = Math.cos(a), sa = Math.sin(a), px = -sa * w, pz = ca * w;
      q.inlay.flatPoly([
        [isl.x + ca * r0 - px, isl.z + sa * r0 - pz], [isl.x + ca * r1 - px, isl.z + sa * r1 - pz],
        [isl.x + ca * r1 + px, isl.z + sa * r1 + pz], [isl.x + ca * r0 + px, isl.z + sa * r0 + pz],
      ], CURB, T.granite);
    }
  }

  // --- Road paint ----------------------------------------------------------------------------
  const W = 0.13; // line width
  const P4 = 4; // wear texture tiles every 4 m
  const inCrossing = (list: number[], x: number, pad: number) => list.some((c) => Math.abs(c - x) < CROSSING_HALF + pad);
  const roadPaint = (zOuter: number, zInner: number, crossings: number[], x0: number, x1: number) => {
    const s = Math.sign(zInner - zOuter); // from outer curb toward inner
    const mid = (zOuter + zInner) / 2;
    const eO = zOuter + s * 0.55, eI = zInner - s * 0.55;
    // edge lines, broken at crossings
    for (const e of [eO, eI]) {
      let a = x0 + 0.8;
      const stops = [...crossings.filter((c) => c > x0 && c < x1).sort((u, v) => u - v), Infinity];
      for (const c of stops) {
        const b = Math.min(c - CROSSING_HALF - 0.4, x1 - 0.8);
        if (b > a) q.paint.flat(a, e - W / 2, b, e + W / 2, 0.002, P4);
        a = c + CROSSING_HALF + 0.4;
        if (a > x1) break;
      }
    }
    // dashed lane divider: 3 m dash, 5 m gap
    for (let x = x0 + 4; x < x1 - 4; x += 8) {
      if (inCrossing(crossings, x, 1.5) || inCrossing(crossings, x + 3, 1.5)) continue;
      q.paint.flat(x, mid - W / 2, x + 3, mid + W / 2, 0.002, P4);
    }
    // zebra crossings: bars parallel to traffic, 0.5 m wide, 0.5 m apart, plus stop lines
    for (const c of crossings) {
      const zs = Math.min(eO, eI), ze = Math.max(eO, eI);
      for (let z = zs + 0.1; z + 0.5 <= ze + 0.05; z += 1.0) q.paint.flat(c - CROSSING_HALF, z, c + CROSSING_HALF, z + 0.5, 0.002, P4);
      // give-way line before each approach (traffic direction depends on the road)
      const dir = zOuter < 0 ? -1 : 1;
      const xl = c - dir * (CROSSING_HALF + 1.6);
      q.paint.flat(xl - 0.15, zs, xl + 0.15, ze, 0.002, P4);
    }
  };
  roadPaint(Z.northRoadOuter, Z.northRoadInner, CROSSINGS_NORTH, ROAD_X.min, ROAD_X.max);
  roadPaint(Z.southRoadOuter, Z.southRoadInner, CROSSINGS_SOUTH, ROAD_X.min, ROAD_X.max);
  roadPaint(Z.northRoadOuter, Z.northRoadInner, [], EAST_BACKDROP.xMin, QUAY_X - 3);
  roadPaint(Z.southRoadOuter, Z.southRoadInner, [], EAST_BACKDROP.xMin, QUAY_X - 3);
  // Avenue de France: double centre line + lane dashes
  for (const z of [-0.12, 0.12]) q.paint.flat(AVENUE_DE_FRANCE.xMin, z - 0.06, AVENUE_DE_FRANCE.xMax - 1, z + 0.06, 0.002, P4);
  for (let x = AVENUE_DE_FRANCE.xMin + 2; x < AVENUE_DE_FRANCE.xMax - 4; x += 8) {
    for (const z of [-2.5, 2.5]) q.paint.flat(x, z - W / 2, x + 3, z + W / 2, 0.002, P4);
  }
  // cross-street arms: dashed centre line
  for (const a of arms) {
    const cx = (a.x0 + a.x1) / 2;
    for (let z = a.z0 + 2; z < a.z1 - 3; z += 6) q.paint.flat(cx - W / 2, z, cx + W / 2, z + 3, 0.002, P4);
  }

  // --- Manhole covers in the lanes and on the promenade ----------------------------------------
  const disc = (x: number, z: number, r: number, y: number) =>
    q.covers.quad([x - r, y, z - r], [x - r, y, z + r], [x + r, y, z + r], [x + r, y, z - r], [0, 1, 0], [[0, 1], [0, 0], [0.5, 0], [0.5, 1]]);
  for (let x = ROAD_X.min + 20; x < ROAD_X.max - 10; x += 38 + rng() * 20) {
    const lane = [-19.2, -16.8, 16.8, 19.2][Math.floor(rng() * 4)];
    if (inCrossing(lane < 0 ? CROSSINGS_NORTH : CROSSINGS_SOUTH, x, 1)) continue;
    disc(x, lane, 0.36, 0.003);
  }

  // --- Quay (visual): granite coping and wall down to the lake -------------------------------
  const qx = QUAY_X;
  q.inlay.flat(qx - 0.6, -260, qx, 260, CURB, T.granite);
  {
    const a: V3 = [qx, CURB, -260], b: V3 = [qx, CURB, 260], c: V3 = [qx, WATER_Y - 0.5, 260], d: V3 = [qx, WATER_Y - 0.5, -260];
    q.granite.quad(a, b, c, d, [1, 0, 0], [a, b, c, d].map((v) => [v[2] / T.granite, v[1] / T.granite] as [number, number]));
  }

  // --- Meshes --------------------------------------------------------------------------------
  const meshes: THREE.Mesh[] = [];
  const add = (quads: Quads, mat: THREE.Material, name: string) => {
    if (quads.empty) return;
    const m = new THREE.Mesh(o.add(quads.build()), mat);
    m.name = `street-${name}`;
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    meshes.push(m);
  };
  add(q.asphalt, M.asphalt, 'asphalt');
  add(q.promenade, M.promenade, 'promenade');
  add(q.sidewalk, M.sidewalk, 'sidewalk');
  add(q.plaza, M.plaza, 'plaza');
  add(q.granite, M.granite, 'curb');
  add(q.inlay, M.graniteInlay, 'inlay');
  add(q.paint, M.paint, 'paint');
  add(q.covers, M.covers, 'covers');
  // Opaque ground is drawn after every other opaque street mesh: trunks, props and kiosks then
  // hide the paving behind them through early-z instead of being shaded on top of it. Inlays and
  // covers (polygon offset, coplanar) go before the paving they cover, for the same reason. Paint
  // lies under everything else that is transparent (café glass, kiosk glass): drawn first.
  meshes.forEach((m) => (m.renderOrder = m.material === M.paint ? -1 : m.material === M.graniteInlay || m.material === M.covers ? 1.5 : 2));
  return { meshes, roadEdges };
}

