// Pedestrian walk network: lines along both sidewalks and three promenade walks, zebra crossings
// between them, links across the promenade through the tree gaps, a lattice over each plaza and
// dead-end "sinks" (alleys, cross-street sidewalks) where people come from and go to. Every node
// and edge is validated against the NavGrid: an edge survives only if each point along it has a
// free lateral offset within its half-width, so walkers can always steer around what is there.
import { ALLEYS, CROSS_STREETS, LANDMARKS, ROAD_X, TREE_X } from '../../core/layout';
import { CROSSINGS_NORTH, CROSSINGS_SOUTH } from '../../world/street/ground';
import { crossingAt } from '../traffic/crossings';
import type { NavGrid } from './navgrid';

export const WALK_R = 0.36; // clearance a walker wants around its centre

export interface Edge {
  a: number;
  b: number;
  len: number;
  /** Lateral room either side of the edge line (m). */
  half: number;
  /** CROSSINGS index this edge runs over, or -1. */
  crossing: number;
}

export interface WalkGraph {
  nx: Float32Array;
  nz: Float32Array;
  sink: Uint8Array;
  edges: Edge[];
  /** Edge indices per node. */
  adj: number[][];
}

const SW = 23.8; // sidewalk walk line |z|
const PO = 11.7; // outer promenade walks |z| (between the ficus rows and the curb lamps)

export function buildWalkGraph(grid: NavGrid): WalkGraph {
  const nx: number[] = [], nz: number[] = [], sink: number[] = [];
  const key = new Map<string, number>();
  const node = (x: number, z: number, isSink = false): number => {
    const k = `${x.toFixed(2)},${z.toFixed(2)}`;
    let i = key.get(k);
    if (i === undefined) {
      i = nx.length;
      key.set(k, i);
      nx.push(x); nz.push(z); sink.push(isSink ? 1 : 0);
    }
    return i;
  };
  const raw: [number, number, number][] = []; // a, b, half
  const link = (a: number, b: number, half: number) => { if (a !== b) raw.push([a, b, half]); };
  /** A straight line of nodes at the given coordinates (sorted), consecutive ones linked. */
  const lineX = (z: number, xs: number[], half: number): Map<number, number> => {
    const m = new Map<number, number>();
    const sorted = [...new Set(xs)].sort((p, q) => p - q);
    let prev = -1;
    for (const x of sorted) {
      const n = node(x, z);
      m.set(x, n);
      if (prev >= 0) link(prev, n, half);
      prev = n;
    }
    return m;
  };

  const gaps: number[] = []; // tree-gap centres along the promenade
  for (let x = TREE_X.min + TREE_X.spacing / 2; x < TREE_X.max; x += TREE_X.spacing) gaps.push(x);
  const promLinks = gaps.filter((_, i) => i % 4 === 1);
  const nAlleys = ALLEYS.filter((a) => a.side < 0).map((a) => a.x), sAlleys = ALLEYS.filter((a) => a.side > 0).map((a) => a.x);
  const [west, east] = CROSS_STREETS;
  const wx = ROAD_X.min - 7, ex = ROAD_X.max + 6; // plaza columns next to the road ends

  for (const s of [-1, 1] as const) {
    const crossings = s < 0 ? CROSSINGS_NORTH : CROSSINGS_SOUTH;
    const alleys = s < 0 ? nAlleys : sAlleys;
    // sidewalk: main stretch between the two cross streets, stubs from the arms to the plazas
    const side = lineX(s * SW, [west.x + 5, east.x - 5, ...crossings, ...alleys], 3);
    const wIn = node(west.x - 5, s * SW), eIn = node(east.x + 5, s * SW);
    link(wIn, side.get(west.x + 5)!, 1.2); // across the cross-street mouths
    link(side.get(east.x - 5)!, eIn, 1.2);
    link(wIn, node(wx, s * SW), 2);
    link(eIn, node(ex, s * SW), 2);
    // cross-street sidewalks up to the arm ends, both sides of both arms
    for (const [x, at] of [[west.x - 5, wIn], [west.x + 5, side.get(west.x + 5)!], [east.x - 5, side.get(east.x - 5)!], [east.x + 5, eIn]] as const) {
      const m = node(x, s * 31);
      link(at, m, 0.8);
      link(m, node(x, s * 50, true), 0.8);
    }
    // alleys: dead ends into the blocks
    for (const x of alleys) {
      const m = node(x, s * 31.5);
      link(side.get(x)!, m, 2.5);
      link(m, node(x, s * 40.5, true), 2.5);
    }
    // outer promenade walk + the zebra crossings onto it
    const outer = lineX(s * PO, [ROAD_X.min + 1, ROAD_X.max - 1, ...crossings, ...promLinks], 1.3);
    link(node(wx, s * PO), outer.get(ROAD_X.min + 1)!, 1.3);
    link(outer.get(ROAD_X.max - 1)!, node(ex, s * PO), 1.3);
    for (const x of crossings) link(side.get(x)!, outer.get(x)!, 1.3);
  }
  // central walk, linked to both outer walks through the tree gaps (benches stand in them; the
  // lateral search walks around)
  const cxs = [ROAD_X.min + 1, ROAD_X.max - 1, ...CROSSINGS_NORTH, ...CROSSINGS_SOUTH, ...promLinks];
  const centre = lineX(0, cxs, 4);
  link(node(wx, 0), centre.get(ROAD_X.min + 1)!, 3);
  link(centre.get(ROAD_X.max - 1)!, node(ex, 0), 3);
  for (const x of [...CROSSINGS_NORTH, ...promLinks]) link(node(x, -PO), centre.get(x)!, 3.5);
  for (const x of [...CROSSINGS_SOUTH, ...promLinks]) link(centre.get(x)!, node(x, PO), 3.5);

  // plazas: a lattice (plus a ring around the statue / clock tower) — invalid nodes drop out
  const plaza = (cols: number[], cx: number, ringR: number) => {
    const rows = [-SW, -PO, 0, PO, SW];
    const ids: number[][] = cols.map((x) => rows.map((z) => node(x, z)));
    for (let i = 0; i < cols.length; i++) for (let j = 0; j < rows.length; j++) {
      if (i + 1 < cols.length) link(ids[i][j], ids[i + 1][j], 2);
      if (j + 1 < rows.length) link(ids[i][j], ids[i][j + 1], 2);
    }
    const ring: number[] = [];
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      ring.push(node(cx + Math.cos(a) * ringR, Math.sin(a) * ringR));
    }
    for (let k = 0; k < 8; k++) link(ring[k], ring[(k + 1) % 8], 1.2);
    // spokes from the ring to the nearest lattice node
    for (const r of ring) {
      let best = -1, bd = 1e9;
      for (const col of ids) for (const n of col) {
        const d = (nx[n] - nx[r]) ** 2 + (nz[n] - nz[r]) ** 2;
        if (d < bd) { bd = d; best = n; }
      }
      link(r, best, 1.5);
    }
  };
  plaza([wx, -262, -284, -300], LANDMARKS.ibnKhaldoun.x, 8.6);
  plaza([ex, 276, 294, 304], LANDMARKS.clockTower.x, 9.6);

  // --- validation ------------------------------------------------------------------------------
  const N = nx.length;
  const ok = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    // nudge a blocked node to the nearest free spot within 2 m
    if (grid.free(nx[i], nz[i], WALK_R + 0.05)) { ok[i] = 1; continue; }
    let found = false;
    for (let r = 0.25; r <= 2 && !found; r += 0.25) {
      for (let k = 0; k < 16; k++) {
        const x = nx[i] + Math.cos((k / 16) * Math.PI * 2) * r, z = nz[i] + Math.sin((k / 16) * Math.PI * 2) * r;
        if (grid.free(x, z, WALK_R + 0.05)) { nx[i] = x; nz[i] = z; found = true; break; }
      }
    }
    ok[i] = found ? 1 : 0;
  }
  const edgeOk = (a: number, b: number, half: number): boolean => {
    const dx = nx[b] - nx[a], dz = nz[b] - nz[a], len = Math.hypot(dx, dz);
    const ux = dx / len, uz = dz / len;
    for (let s = 0; s <= len; s += 0.5) {
      const px = nx[a] + ux * s, pz = nz[a] + uz * s;
      let free = false;
      for (let d = 0; d <= half && !free; d += 0.25) {
        if (grid.free(px - uz * d, pz + ux * d, WALK_R) || grid.free(px + uz * d, pz - ux * d, WALK_R)) free = true;
      }
      if (!free) return false;
    }
    return true;
  };
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const [a, b, half] of raw) {
    const k = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (seen.has(k) || !ok[a] || !ok[b] || !edgeOk(a, b, half)) continue;
    seen.add(k);
    const mx = (nx[a] + nx[b]) / 2, mz = (nz[a] + nz[b]) / 2;
    edges.push({ a, b, len: Math.hypot(nx[b] - nx[a], nz[b] - nz[a]), half, crossing: crossingAt(mx, mz) });
  }
  const adj: number[][] = Array.from({ length: N }, () => []);
  edges.forEach((e, i) => { adj[e.a].push(i); adj[e.b].push(i); });
  return { nx: Float32Array.from(nx), nz: Float32Array.from(nz), sink: Uint8Array.from(sink), edges, adj };
}
