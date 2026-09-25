// City planner: turns src/core/layout.ts into a list of building specs (footprint, facade segments,
// style, storeys, colours, shops). Pure data, deterministic. Geometry is made in facade.ts.
//
// Facade segments are always oriented "left → right as seen from the street" (u = up × n), so a
// building's facade polyline turns away from the street at convex corners (chamfers, alley sides).
import { Color } from 'three';
import {
  ALLEYS, AVENUE_DE_FRANCE, CAFE_TERRACES, CROSS_STREETS, CURB, EAST_BACKDROP, LANDMARKS, X_MAX, X_MIN, Z,
} from '../../core/layout';
import { rng, pick, range, chance, type Rng } from './rng';
import type { P2, V3 } from './geo';
import { SIGNS, type ShopKind } from './signs';

export type Style = 'haussmann' | 'nouveau' | 'deco' | 'modern' | 'tower' | 'plain';
export type SegRole = 'main' | 'chamfer' | 'arm' | 'side';

export interface Seg {
  ax: number; az: number; bx: number; bz: number;
  nx: number; nz: number; // outward normal
  len: number;
  role: SegRole;
}

export interface Shop {
  seg: number; // index into segs
  u0: number; u1: number;
  kind: ShopKind;
  sign: string;
  closed: boolean; // rolling shutter down
  awning: 0 | 1 | 2; // none / small / café canopy
}

export interface BuildingSpec {
  seed: number;
  style: Style;
  detail: 0 | 1; // 1 = backdrop (lower detail)
  segs: Seg[];
  footprint: P2[]; // world xz polygon
  floors: number; // upper floors (ground floor excluded)
  groundH: number;
  floorH: number;
  tint: V3; // plaster
  stone: V3;
  shutter: V3;
  frame: V3;
  door: V3;
  shops: Shop[];
  flag: boolean;
  dome: boolean;
  /** Target window-bay width (m); shops and the upper-floor windows share this grid. */
  bay: number;
  cx: number; cz: number;
}

const lin = (hex: number): V3 => {
  const c = new Color(hex);
  return [c.r, c.g, c.b];
};

const PLASTER = [0xf4ecdc, 0xf6f3ec, 0xeedcb8, 0xf2e6cf, 0xe9e4da, 0xf0dfc4, 0xf1e5da, 0xf7efe0].map(lin);
const STONE = [0xf1ead8, 0xe8e0cc, 0xede4d2].map(lin);
const SHUTTER = [0x6f8270, 0x6b4a32, 0xe6e1d3, 0x6d7f8c, 0x34688f, 0x2f4a3a, 0x7d8a70, 0x8a6a4a].map(lin);
const FRAME = [0xf0eee8, 0xe4e0d4, 0x5a3e28, 0x2f4a3a].map(lin);
const DOOR = [0x4a2e1a, 0x2b4535, 0x243a5c, 0x2a2622, 0x5c3a22].map(lin);

const SIDE_DEPTH = 18; // standard building depth behind the avenue facade line
const CHAMFER = 3; // pan coupé at cross-street corners
const MIN_W = 8; // narrowest building along a street wall (narrower leftovers widen a neighbour)
/** Length of the side street a cross-street arm turns into (east, behind the east corner building). */
export const BEND = 14;

/** Bay layout of a facade segment of length `len`: end margins, bay count and bay width. Shared by
 *  the planner (shops) and the facade generator (windows), so shop piers line up with the bays. */
export function bayGrid(len: number, bay: number): { margin: number; nb: number; bw: number } {
  const margin = Math.min(0.75, len * 0.08);
  const nb = Math.max(1, Math.round((len - 2 * margin) / bay));
  return { margin, nb, bw: (len - 2 * margin) / nb };
}

const BAY: Record<Style, [number, number]> = {
  haussmann: [3.3, 3.8], nouveau: [3.4, 3.9], deco: [3.2, 3.6], plain: [3.0, 3.6], modern: [3.4, 3.4], tower: [3.8, 3.8],
};
/** Bay width from the building's own seed (does not advance the planner's RNG). */
const bayFor = (style: Style, seed: number): number => range(rng(seed ^ 0x2c1b3c6d), ...BAY[style]);

// ---------------------------------------------------------------------------------------------

interface Line {
  // facade line: point at u = 0 and direction of +u, outward normal
  ox: number; oz: number; dx: number; dz: number; nx: number; nz: number;
}

const lineN = (z: number, xFrom: number): Line => ({ ox: xFrom, oz: z, dx: 1, dz: 0, nx: 0, nz: 1 });
const lineS = (z: number, xFrom: number): Line => ({ ox: xFrom, oz: z, dx: -1, dz: 0, nx: 0, nz: -1 });

const at = (l: Line, u: number, back = 0): P2 => [l.ox + l.dx * u - l.nx * back, l.oz + l.dz * u - l.nz * back];

function seg(a: P2, b: P2, role: SegRole): Seg {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const len = Math.hypot(dx, dz);
  // facade direction d = up × n = (nz, −nx)  ⇔  n = (−dz, dx)
  return { ax: a[0], az: a[1], bx: b[0], bz: b[1], nx: -dz / len, nz: dx / len, len, role };
}

type EndKind = 'none' | 'side' | 'land' | 'cross';

interface RunSpec {
  line: Line;
  u0: number; u1: number; // extent along the line
  left: EndKind; right: EndKind;
  armDepth: number; // for 'cross' ends: arm facade length (to the corner building's back)
  detail: 0 | 1;
  cuts: number[]; // forced building boundaries (u)
  cafes: [number, number, number][]; // café ranges (u) + CAFE_TERRACES index
  specials: { u0: number; u1: number; style: Style }[];
  /** End whose corner building also gets a facade on its back (the bend of a cross-street arm). */
  bendEnd?: 'left' | 'right';
}

export interface CityPlan {
  buildings: BuildingSpec[];
  /** Rectangles (xMin, zMin, xMax, zMax) that hinterland blocks must avoid. */
  reserved: [number, number, number, number][];
  /** Extra collider walls not tied to a building facade (normal = the public side). */
  walls: Seg[];
}

// ---------------------------------------------------------------------------------------------

export function planCity(): CityPlan {
  const R = rng(20260925);
  const out: BuildingSpec[] = [];
  const reserved: [number, number, number, number][] = [];
  const walls: Seg[] = [];
  for (const l of Object.values(LANDMARKS)) if ('xMin' in l) reserved.push([l.xMin - 1, l.zMin - 1, l.xMax + 1, l.zMax + 1]);

  // --- avenue facade lines ----------------------------------------------------------------------
  const blockers = (side: -1 | 1) => {
    const b: [number, number, 'side' | 'land' | 'cross'][] = [];
    for (const l of Object.values(LANDMARKS)) {
      if (!('xMin' in l)) continue;
      if (side === -1 && l.zMax === Z.northFacade) b.push([l.xMin, l.xMax, 'land']);
      if (side === 1 && l.zMin === Z.southFacade) b.push([l.xMin, l.xMax, 'land']);
    }
    for (const c of CROSS_STREETS) b.push([c.x - c.width / 2, c.x + c.width / 2, 'cross']);
    for (const a of ALLEYS) if (a.side === side) b.push([a.x - a.width / 2, a.x + a.width / 2, 'side']);
    return b.sort((p, q) => p[0] - q[0]);
  };

  for (const side of [-1, 1] as const) {
    const zf = side === -1 ? Z.northFacade : Z.southFacade;
    const bl = blockers(side);
    // x-intervals of the continuous street wall from X_MIN to the east backdrop end
    const iv: { a: number; b: number; ea: EndKind; eb: EndKind }[] = [];
    let x = X_MIN, ek: EndKind = 'none';
    for (const [b0, b1, kind] of bl) {
      if (b0 > x) iv.push({ a: x, b: b0, ea: ek, eb: kind });
      x = b1;
      ek = kind;
    }
    iv.push({ a: x, b: EAST_BACKDROP.xMax, ea: ek, eb: 'side' });

    for (const r of iv) {
      const cafes = CAFE_TERRACES.map((c, i) => [c, i] as const)
        .filter(([c]) => c.side === side && c.xMin >= r.a && c.xMax <= r.b)
        .map(([c, i]) => [c.xMin, c.xMax, i] as [number, number, number]);
      const specials: RunSpec['specials'] = [];
      if (side === 1 && r.a <= 196 && r.b >= 232) specials.push({ u0: 196, u1: 230, style: 'tower' });
      if (side === -1 && r.a <= 34 && r.b >= 58) specials.push({ u0: 34, u1: 57, style: 'modern' });
      const cuts = r.a < X_MAX && r.b > X_MAX ? [X_MAX] : [];
      // north: u runs west → east from x = a; south: u runs east → west from x = b
      // a run starting just east of a cross street: its corner building lines the arm's bend
      const bend = r.ea === 'cross';
      if (side === -1) {
        runs(R, out, {
          line: lineN(zf, 0), u0: r.a, u1: r.b, left: r.ea, right: r.eb, armDepth: SIDE_DEPTH, detail: 0,
          cuts, cafes, specials, bendEnd: bend ? 'left' : undefined,
        });
      } else {
        const L = lineS(zf, 0); // u = −x
        runs(R, out, {
          line: L, u0: -r.b, u1: -r.a, left: r.eb, right: r.ea, armDepth: SIDE_DEPTH, detail: 0,
          cuts: cuts.map((c) => -c), cafes: cafes.map(([p, q, i]) => [-q, -p, i]), specials: specials.map((s) => ({ ...s, u0: -s.u1, u1: -s.u0 })),
          bendEnd: bend ? 'right' : undefined,
        });
      }
    }
  }

  // --- cross-street arms ------------------------------------------------------------------------
  // West side: a plain building beyond the corner building. East side: open from the corner
  // building's back (d0) to the arm end, where the street turns east out of view: the closing
  // building runs across the arm and the bend, a plain building closes the bend BEND m further on.
  for (const c of CROSS_STREETS) {
    for (const side of [-1, 1] as const) {
      const zf = side === -1 ? Z.northFacade : Z.southFacade;
      const zEnd = zf + side * c.depth; // −56 / +56
      const xw = c.x - c.width / 2, xe = c.x + c.width / 2, xb = xe + BEND;
      const d0 = zf + side * SIDE_DEPTH; // where the corner buildings stop (−48 / +48)
      const deep = zEnd + side * 18;
      const orient = (p: P2[], nx: number) => (seg(p[0], p[1], 'main').nx * nx > 0 ? p : [p[1], p[0]]);
      const w = orient([[xw, d0], [xw, zEnd]], 1); // west arm wall faces +X
      out.push(simple(R, [seg(w[0], w[1], 'main')], rectFrom(w, clearDepth(xw, -1, Math.min(d0, zEnd), Math.max(d0, zEnd), 14)), 'plain', 0, 3 + Math.floor(R() * 2)));
      // closing building: facade faces back toward the avenue, across the arm and the bend
      const cl: P2[] = side === -1 ? [[xw, zEnd], [xb, zEnd]] : [[xb, zEnd], [xw, zEnd]];
      out.push(simple(R, [seg(cl[0], cl[1], 'main')], [[xw, zEnd], [xb, zEnd], [xb, deep], [xw, deep]], pick(R, ['haussmann', 'deco'] as const), 0, 4 + Math.floor(R() * 2)));
      // end of the bend, facing back along it (−X)
      const e = orient([[xb, d0], [xb, zEnd]], -1);
      out.push(simple(R, [seg(e[0], e[1], 'main')], rectFrom(e, 10), 'plain', 0, 3 + Math.floor(R() * 2)));
      // inner side of the bend: the corner building's back facade (see runs) + a wall in case it is narrower
      walls.push(side === -1 ? seg([xb, d0], [xe, d0], 'side') : seg([xe, d0], [xb, d0], 'side'));
      reserved.push([xw - 16, Math.min(zf, deep), xb + 12, Math.max(zf, deep)]);
    }
  }

  // --- alley back walls -------------------------------------------------------------------------
  for (const a of ALLEYS) {
    const zf = a.side === -1 ? Z.northFacade : Z.southFacade;
    const zb = zf + a.side * a.depth;
    const x0 = a.x - a.width / 2, x1 = a.x + a.width / 2;
    const pts: P2[] = a.side === -1 ? [[x0, zb], [x1, zb]] : [[x1, zb], [x0, zb]];
    const deep = zb + a.side * 16;
    out.push(simple(R, [seg(pts[0], pts[1], 'main')], [[x0, zb], [x1, zb], [x1, deep], [x0, deep]], 'plain', 0, 2 + Math.floor(R() * 2)));
    reserved.push([x0 - 1, Math.min(zf, deep), x1 + 1, Math.max(zf, deep)]);
  }

  // --- west plaza edge + Avenue de France (visual) -------------------------------------------------
  const adf = AVENUE_DE_FRANCE;
  runs(R, out, {
    line: lineN(adf.zMin, 0), u0: adf.xMin, u1: X_MIN, left: 'side', right: 'cross', armDepth: Math.abs(Z.northFacade - adf.zMin),
    detail: 1, cuts: [], cafes: [], specials: [],
  });
  runs(R, out, {
    line: lineS(adf.zMax, 0), u0: -X_MIN, u1: -adf.xMin, left: 'cross', right: 'side', armDepth: Math.abs(Z.southFacade - adf.zMax),
    detail: 1, cuts: [], cafes: [], specials: [],
  });

  for (const b of out) {
    const xs = b.footprint.map((p) => p[0]), zs = b.footprint.map((p) => p[1]);
    reserved.push([Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)]);
  }
  return { buildings: out, reserved, walls };
}

// ---------------------------------------------------------------------------------------------

/** Rectangle behind a straight facade p0 → p1 (depth measured against the outward normal). */
function rectFrom(p: P2[], depth: number): P2[] {
  const s = seg(p[0], p[1], 'main');
  const bx = -s.nx * depth, bz = -s.nz * depth;
  return [p[0], p[1], [p[1][0] + bx, p[1][1] + bz], [p[0][0] + bx, p[0][1] + bz]];
}

/** Depth (≤ want) a building extending from x0 toward dir (±1 in X) can have without entering a landmark. */
function clearDepth(x0: number, dir: -1 | 1, z0: number, z1: number, want: number): number {
  let d = want;
  for (const l of Object.values(LANDMARKS)) {
    if (!('xMin' in l) || l.zMax <= z0 || l.zMin >= z1) continue;
    const gap = dir < 0 ? x0 - l.xMax : l.xMin - x0;
    if (gap >= 0) d = Math.min(d, gap);
  }
  return Math.max(4, d);
}

function palette(R: Rng, style: Style): Pick<BuildingSpec, 'tint' | 'stone' | 'shutter' | 'frame' | 'door'> {
  const tint = style === 'modern' || style === 'tower' ? lin(pick(R, [0xe9e6de, 0xf1efe8, 0xe6e0d2])) : pick(R, PLASTER);
  return { tint, stone: pick(R, STONE), shutter: pick(R, SHUTTER), frame: pick(R, FRAME), door: pick(R, DOOR) };
}

function centroid(fp: P2[]): [number, number] {
  let x = 0, z = 0;
  for (const p of fp) { x += p[0]; z += p[1]; }
  return [x / fp.length, z / fp.length];
}

function simple(R: Rng, segs: Seg[], fp: P2[], style: Style, detail: 0 | 1, floors: number): BuildingSpec {
  const [cx, cz] = centroid(fp);
  const seed = Math.floor(R() * 1e9);
  return {
    seed, style, detail, segs, footprint: fp, floors,
    groundH: range(R, 4.3, 4.9), floorH: range(R, 3.2, 3.45), ...palette(R, style),
    shops: [], flag: false, dome: false, bay: bayFor(style, seed), cx, cz,
  };
}

const STYLE_WEIGHTS: [Style, number][] = [['haussmann', 0.44], ['nouveau', 0.22], ['deco', 0.28], ['plain', 0.06]];

function pickStyle(R: Rng, prev: Style[]): Style {
  for (;;) {
    let t = R();
    let s: Style = 'haussmann';
    for (const [k, w] of STYLE_WEIGHTS) { if ((t -= w) <= 0) { s = k; break; } }
    if (!(prev.length >= 2 && prev[prev.length - 1] === s && prev[prev.length - 2] === s)) return s;
  }
}

const SHOP_POOL: ShopKind[] = [
  'patisserie', 'pharmacie', 'librairie', 'boutique', 'banque', 'voyage', 'optique', 'bijouterie', 'parfumerie',
  'restaurant', 'chaussures', 'journaux', 'assurance', 'photo', 'glacier', 'taxiphone', 'boutique', 'patisserie', 'librairie',
];

/** Splits a run into buildings and emits their specs (corner buildings at cross-street ends). */
function runs(R: Rng, out: BuildingSpec[], r: RunSpec): void {
  const L = r.line;
  // 1. building boundaries along u
  const fixed: { a: number; b: number; style?: Style; cafe?: [number, number, number] }[] = [];
  for (const [p, q, i] of r.cafes) fixed.push({ a: Math.max(r.u0, p - 1.6), b: Math.min(r.u1, q + 1.6), cafe: [p, q, i] });
  for (const s of r.specials) fixed.push({ a: s.u0, b: s.u1, style: s.style });
  fixed.sort((p, q) => p.a - q.a);
  const parts: { a: number; b: number; style?: Style; cafe?: [number, number, number] }[] = [];
  const fill = (a: number, b: number) => {
    const cuts = [a, ...r.cuts.filter((c) => c > a + MIN_W && c < b - MIN_W), b];
    for (let i = 0; i < cuts.length - 1; i++) {
      const w = cuts[i + 1] - cuts[i];
      const n = Math.max(1, Math.round(w / range(R, 15, 21)));
      const ws = Array.from({ length: n }, () => range(R, 0.75, 1.25));
      const sum = ws.reduce((s, v) => s + v, 0);
      let u = cuts[i];
      for (const k of ws) {
        const bw = (k / sum) * w;
        parts.push({ a: u, b: u + bw });
        u += bw;
      }
    }
  };
  // gaps narrower than MIN_W would become sliver buildings: widen the neighbour instead
  let u = r.u0;
  for (const f of fixed) {
    if (f.a - u >= MIN_W) fill(u, f.a);
    else if (f.a > u) {
      if (parts.length) parts[parts.length - 1].b = f.a;
      else f.a = u;
    }
    parts.push(f);
    u = f.b;
  }
  if (r.u1 - u >= MIN_W || !parts.length) fill(u, r.u1);
  else parts[parts.length - 1].b = r.u1;

  // 2. specs
  const prev: Style[] = [];
  parts.forEach((p, i) => {
    const first = i === 0, last = i === parts.length - 1;
    const endL: EndKind = first ? r.left : 'none';
    const endR: EndKind = last ? r.right : 'none';
    let style = p.style ?? pickStyle(R, prev);
    const isCorner = endL === 'cross' || endR === 'cross';
    if (isCorner && (style === 'plain')) style = 'haussmann';
    prev.push(style);
    const detail: 0 | 1 = r.detail === 1 || at(L, (p.a + p.b) / 2)[0] > X_MAX + 2 ? 1 : 0;
    const D = isCorner ? r.armDepth : style === 'tower' ? 26 : SIDE_DEPTH;
    const segs: Seg[] = [];
    const fp: P2[] = [];
    if (endL === 'cross') {
      fp.push(at(L, p.a, D), at(L, p.a, CHAMFER), at(L, p.a + CHAMFER));
      segs.push(seg(fp[0], fp[1], 'arm'), seg(fp[1], fp[2], 'chamfer'));
    } else {
      if (endL === 'side' || endL === 'land') segs.push(seg(at(L, p.a, D), at(L, p.a), endL === 'land' ? 'arm' : 'side'));
      fp.push(at(L, p.a));
    }
    const ma = endL === 'cross' ? p.a + CHAMFER : p.a;
    const mb = endR === 'cross' ? p.b - CHAMFER : p.b;
    segs.push(seg(at(L, ma), at(L, mb), 'main'));
    const mainIdx = segs.length - 1;
    if (endR === 'cross') {
      const q0 = at(L, p.b - CHAMFER), q1 = at(L, p.b, CHAMFER), q2 = at(L, p.b, D);
      fp.push(q0, q1, q2);
      segs.push(seg(q0, q1, 'chamfer'), seg(q1, q2, 'arm'));
    } else {
      fp.push(at(L, p.b), at(L, p.b, D));
      if (endR === 'side' || endR === 'land') segs.push(seg(at(L, p.b), at(L, p.b, D), endR === 'land' ? 'arm' : 'side'));
    }
    if (endL !== 'cross') fp.push(at(L, p.a, D));
    // corner building east of a cross street: its back lines the bend of the arm
    if ((r.bendEnd === 'left' && endL === 'cross') || (r.bendEnd === 'right' && endR === 'cross')) segs.push(seg(at(L, p.b, D), at(L, p.a, D), 'side'));

    const floorsBase = style === 'tower' ? 17 : style === 'modern' ? 6 : isCorner ? 5 + Math.floor(R() * 2) : 3 + Math.floor(R() * 4);
    const [cx, cz] = centroid(fp);
    const seed = Math.floor(R() * 1e9);
    const gH = style === 'tower' ? 5.2 : range(R, 4.5, 5.2);
    const spec: BuildingSpec = {
      seed, style, detail, segs, footprint: fp,
      floors: detail === 1 ? Math.min(floorsBase, 5) : floorsBase,
      // cafés: tall ground floor so the canopy's valance clears a jumping Labib (≥ 3.1 m)
      groundH: p.cafe ? Math.max(4.9, gH) : gH, floorH: style === 'tower' ? 3.05 : range(R, 3.25, 3.55),
      ...palette(R, style), shops: [], flag: false, dome: isCorner && style !== 'deco' && chance(R, 0.6), bay: bayFor(style, seed), cx, cz,
    };
    // 3. shops along the main segment, on the same bay grid as the windows above
    const main = segs[mainIdx];
    const { margin, nb: bays, bw } = bayGrid(main.len, spec.bay);
    const cafeU = p.cafe ? [p.cafe[0] - ma, p.cafe[1] - ma] : null;
    let k = 0;
    const doorBay = bays >= 3 ? 1 + Math.floor(R() * (bays - 2)) : -1;
    while (k < bays) {
      const ua = margin + k * bw;
      if (k === doorBay && !cafeU) { k++; continue; }
      if (cafeU && ua + bw * 0.5 > cafeU[0] && ua + bw * 0.5 < cafeU[1]) {
        // café covers every bay whose centre lies inside the terrace
        let n = 1;
        while (k + n < bays && margin + (k + n + 0.5) * bw < cafeU[1]) n++;
        spec.shops.push({ seg: mainIdx, u0: ua + 0.12, u1: ua + n * bw - 0.12, kind: 'cafe', sign: `cafe${p.cafe![2] + 1}`, closed: false, awning: 2 });
        k += n;
        continue;
      }
      if (style === 'tower' || (detail === 0 && chance(R, 0.12))) { k++; continue; } // plain wall bay / window
      const n = Math.min(bays - k, 1 + Math.floor(R() * 2.2));
      const prevKind = spec.shops.length ? spec.shops[spec.shops.length - 1].kind : null;
      let kind = pick(R, SHOP_POOL);
      while (kind === prevKind) kind = pick(R, SHOP_POOL); // no twin shops side by side
      spec.shops.push({
        seg: mainIdx, u0: ua + 0.12, u1: ua + n * bw - 0.12, kind, sign: '', closed: chance(R, 0.12),
        awning: chance(R, 0.35) ? 1 : 0,
      });
      k += n;
    }
    if (style === 'tower') {
      spec.shops.push({ seg: mainIdx, u0: margin + bw * 0.1, u1: margin + bw * Math.min(bays, 3) - 0.2, kind: 'hotel', sign: 'hot1', closed: false, awning: 0 });
    }
    // flags: the hotel (several), most banks, some corner / domed buildings, the odd other one
    const bank = spec.shops.some((s) => s.kind === 'banque');
    spec.flag = style === 'tower' || (detail === 0 && chance(R, bank ? 0.7 : isCorner || spec.dome ? 0.3 : 0.1));
    out.push(spec);
  });
}

/** Assigns sign ids so that neighbouring shops of the same kind don't repeat the same name. */
export function assignSigns(plan: CityPlan): void {
  const used = new Map<ShopKind, number>();
  for (const b of plan.buildings)
    for (const s of b.shops) {
      if (s.sign || s.kind === 'cafe') continue; // cafés are named after their terrace
      const list = SIGNS.filter((d) => d.kind === s.kind);
      const i = used.get(s.kind) ?? 0;
      used.set(s.kind, i + 1);
      s.sign = list[i % list.length].id;
    }
}

export { CURB };
