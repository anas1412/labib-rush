// Procedural facade generator. A building = footprint + facade segments; each segment is laid out
// in bays (~3.5 m) and floors, then assembled from modules: wall pieces around openings with
// reveals, glass (interior-mapped), louvred shutters (closed / half / open), window surrounds,
// pediments, string courses, cornices with modillions, balconies (slab + consoles + ironwork),
// shopfronts (stall riser, glass, door, fascia sign, awning), entrance doors with fanlights,
// AC units, dishes, plants, flags, drain pipes, parapets/balustrades, domes and rooftop clutter.
//
// Everything is emitted into the chunk's GeoBufs (merged per material) — see buildings.ts.
// Shadows: the detailed masonry does not cast. Each building also emits a coarse shadow proxy
// (closed boxes/prisms: the building mass inset 0.35 m behind the facade line, balconies, cornices,
// bands, awnings, AC units, domes, rooftop huts) into B.shadow, drawn only into the shadow map.
import { Color } from 'three';
import { CURB } from '../../core/layout';
import type { Quality } from '../../core/types';
import type { GeoBuf, P2, V3 } from './geo';
import { WIN } from './materials';
import { bayGrid, type BuildingSpec, type Seg, type Shop } from './plan';
import { chance, pick, range, rng, type Rng } from './rng';
import type { SignAtlas } from './signs';
import { CUT_STRIP_METERS, IMPOSTOR_V, L, cutV, miscUV, type CutStrip, type MiscRegion } from './textures';

const PAINT_RECT = miscUV('paint');
const PAINT_UV: [number, number] = [(PAINT_RECT[0] + PAINT_RECT[2]) / 2, (PAINT_RECT[1] + PAINT_RECT[3]) / 2];
const TANK_UV = miscUV('tank');

export interface Bufs {
  mas: GeoBuf; // masonry details (drawn first so walls behind them are depth-rejected)
  back: GeoBuf; // masonry walls, roofs (drawn after the details)
  glass: GeoBuf;
  cut: GeoBuf;
  sign: GeoBuf;
  flag: GeoBuf;
  shadow: GeoBuf; // shadow-caster proxy (written by the primary pass only)
}

export interface ColliderBox {
  cx: number; cy: number; cz: number;
  hx: number; hy: number; hz: number;
  rotY: number;
}

// ---------------------------------------------------------------------------------------------
// Profiles [w, y] (outward, up) from the wall at the bottom to the wall at the top.
const P_BAND: P2[] = [[0, 0], [0.05, 0.02], [0.05, 0.11], [0.09, 0.14], [0.09, 0.2], [0, 0.2]];
const P_BAND_BIG: P2[] = [[0, 0], [0.06, 0.03], [0.06, 0.14], [0.12, 0.2], [0.2, 0.26], [0.22, 0.34], [0, 0.34]];
const P_CORNICE: P2[] = [
  [0, 0], [0.07, 0.03], [0.07, 0.13], [0.14, 0.18], [0.14, 0.34], [0.28, 0.4], [0.44, 0.48], [0.56, 0.56],
  [0.58, 0.7], [0.52, 0.76], [0.5, 0.82], [0, 0.82],
];
const P_CORNICE_DECO: P2[] = [[0, 0], [0.18, 0], [0.18, 0.12], [0.3, 0.12], [0.3, 0.4], [0, 0.4]];
const P_HOOD: P2[] = [[0, 0], [0.06, 0.02], [0.12, 0.07], [0.14, 0.11], [0.14, 0.16], [0, 0.16]];
const P_COPING: P2[] = [[0, 0], [0.05, 0], [0.05, 0.08], [0, 0.1]];
const P_CONSOLE: P2[] = [[0, -0.5], [0.1, -0.4], [0.22, -0.18], [0.52, -0.05], [0.52, 0], [0, 0]];
const P_CORNICE_LOD: P2[] = [[0, 0], [0.14, 0.14], [0.14, 0.34], [0.56, 0.58], [0.56, 0.72], [0, 0.82]];
const P_BAND_LOD: P2[] = [[0, 0], [0.09, 0.06], [0.09, 0.2], [0, 0.2]];
const P_SLAB_MODERN: P2[] = [[0, 0], [0.32, 0], [0.32, 0.28], [0, 0.28]];
/** Moulded edge of the bowed Art Nouveau balcony slab ([w, y] from the slab edge, y from its underside). */
const P_SLAB_EDGE: P2[] = [[0, 0], [0.03, 0.02], [0.035, 0.08], [0.06, 0.12], [0.06, 0.22], [0, 0.23]];

const IRON: V3 = [0.02, 0.022, 0.025];
/** Lowest point of any awning above the pavement (m): Labib's jump apex is ≈ 2.95 m. */
const AWNING_CLEAR = 3.12;
const ZINC: V3 = [0.36, 0.37, 0.38];

const AWNING = [
  [[0.62, 0.05, 0.05], [0.85, 0.83, 0.78]],
  [[0.05, 0.22, 0.12], [0.85, 0.83, 0.78]],
  [[0.08, 0.12, 0.3], [0.85, 0.83, 0.78]],
  [[0.42, 0.06, 0.08], [0.42, 0.06, 0.08]],
  [[0.72, 0.42, 0.08], [0.85, 0.83, 0.78]],
  [[0.06, 0.3, 0.22], [0.06, 0.3, 0.22]],
] as [V3, V3][];

/** Awning colours from a fabric hex: solid or striped with cream. */
function fabricPair(hex: string, R: Rng): [V3, V3] {
  const col = new Color(hex);
  const a: V3 = [col.r, col.g, col.b];
  return chance(R, 0.5) ? [a, [0.85, 0.83, 0.78]] : [a, a];
}

interface Opening {
  u0: number; u1: number; y0: number; y1: number;
  arch: number; // rise of a segmental arch (0 = flat head)
  depth: number;
  floorTop?: number; // top of the storey (for ornaments that must fit below the next floor)
}

interface Cfg {
  bay: number;
  wall: number; // layer
  ground: number; // layer of the ground floor
  winW: number;
  french: boolean;
  arch: number;
  surround: 'ears' | 'simple' | 'none';
  pediment: boolean;
  hoods: boolean;
  keystone: boolean;
  balcony: ('cont' | 'indiv' | 'bal' | 'none')[]; // per upper floor
  railing: CutStrip;
  pilasters: 'edges' | 'bays' | 'none';
  cornice: P2[];
  modillions: boolean;
  parapet: 'balustrade' | 'solid' | 'stepped' | 'gable';
  relief: MiscRegion | null;
  shutters: number; // probability a window has shutters
  grime: number;
}

function config(b: BuildingSpec, R: Rng): Cfg {
  const n = b.floors;
  R(); // the bay width used to be drawn here (now b.bay, from the planner): keeps the RNG sequence
  const bay = b.bay;
  const bal = (f: (i: number) => Cfg['balcony'][number]) => Array.from({ length: n }, (_, i) => f(i));
  switch (b.style) {
    case 'haussmann':
      return {
        bay, wall: chance(R, 0.5) ? L.STUCCO : L.PLASTER, ground: L.STONE, winW: range(R, 1.2, 1.35), french: true, arch: 0,
        surround: 'ears', pediment: chance(R, 0.7), hoods: true, keystone: chance(R, 0.6),
        balcony: bal((i) => (i === 0 || (i === n - 1 && n >= 4) ? 'cont' : 'bal')), railing: 'haussmann', pilasters: 'edges',
        cornice: P_CORNICE, modillions: true, parapet: chance(R, 0.55) ? 'balustrade' : 'solid', relief: chance(R, 0.5) ? 'garland' : null,
        shutters: 0.85, grime: range(R, 0.35, 0.8),
      };
    case 'nouveau':
      return {
        bay, wall: L.STUCCO, ground: chance(R, 0.6) ? L.STONE : L.STUCCO, winW: range(R, 1.25, 1.45), french: true, arch: range(R, 0.22, 0.38),
        surround: 'simple', pediment: false, hoods: false, keystone: true,
        balcony: bal((i) => (i === 0 ? 'cont' : i % 2 === 1 ? 'indiv' : 'bal')), railing: 'nouveau', pilasters: 'edges',
        cornice: P_CORNICE, modillions: chance(R, 0.5), parapet: 'gable', relief: 'floral', shutters: 0.7, grime: range(R, 0.25, 0.6),
      };
    case 'deco':
      return {
        bay, wall: chance(R, 0.5) ? L.PLASTER : L.STUCCO, ground: chance(R, 0.5) ? L.STONE : L.MISC, winW: range(R, 1.45, 1.7), french: chance(R, 0.5), arch: 0,
        surround: 'none', pediment: false, hoods: false, keystone: false,
        balcony: bal((i) => (i === 0 || i === 2 ? 'indiv' : chance(R, 0.3) ? 'bal' : 'none')), railing: 'deco', pilasters: 'bays',
        cornice: P_CORNICE_DECO, modillions: false, parapet: 'stepped', relief: 'deco', shutters: 0.6, grime: range(R, 0.3, 0.7),
      };
    default:
      return {
        bay, wall: L.PLASTER, ground: chance(R, 0.5) ? L.PLASTER : L.STONE, winW: range(R, 1.0, 1.2), french: false, arch: 0,
        surround: chance(R, 0.5) ? 'simple' : 'none', pediment: false, hoods: false, keystone: false,
        balcony: bal(() => (chance(R, 0.25) ? 'bal' : 'none')), railing: 'bars', pilasters: 'none',
        cornice: P_BAND_BIG, modillions: false, parapet: 'solid', relief: null, shutters: 0.9, grime: range(R, 0.5, 0.9),
      };
  }
}

// ---------------------------------------------------------------------------------------------

interface Ctx {
  b: BuildingSpec;
  R: Rng;
  cfg: Cfg;
  q: Quality;
  B: Bufs;
  signs: SignAtlas;
  y0: number; // ground (sidewalk) level
  gTop: number; // top of the ground floor
  top: number; // top of the last floor
  roofY: number;
  parTop: number;
  fine: boolean; // full detail (near LOD, not a backdrop, quality ≥ medium)
  lod: 0 | 1; // 1 = far chunk version (flat shutters, no small props)
  proxy: boolean; // primary pass: emit colliders, shadow proxy and flags (once per building)
  /** Deterministic RNG keyed by element indices, identical in both LOD passes. */
  rr(...k: number[]): Rng;
}

const keyed = (seed: number) => (...k: number[]): Rng => {
  let h = seed | 0;
  for (const v of k) h = Math.imul(h ^ Math.round(v * 97 + 13), 0x9e3779b1) ^ (h >>> 15);
  return rng(h >>> 0);
};

const all = (B: Bufs): GeoBuf[] => [B.mas, B.back, B.glass, B.cut, B.sign, B.flag, B.shadow];

/** Closed box into the shadow proxy (primary pass only), in the current frame. */
function sbox(c: Ctx, u0: number, u1: number, y0: number, y1: number, w0: number, w1: number): void {
  if (c.proxy) c.B.shadow.box(u0, u1, y0, y1, w0, w1);
}

/** Flags need the near detail, except on 'low' where the far version is all there is. */
const flagsOn = (c: Ctx): boolean => c.proxy && c.b.detail === 0 && (c.fine || c.q === 'low');

/** Convex polygon shrunk by d (every edge moved inward). */
function inset(fp: P2[], d: number): P2[] {
  const n = fp.length;
  let area = 0;
  for (let i = 0; i < n; i++) area += fp[i][0] * fp[(i + 1) % n][1] - fp[(i + 1) % n][0] * fp[i][1];
  const k = area > 0 ? d : -d; // inward normal of edge (ux, uz) = sign · (−uz, ux)
  const lines = fp.map((p, i) => {
    const q = fp[(i + 1) % n];
    const l = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    const ux = (q[0] - p[0]) / l, uz = (q[1] - p[1]) / l;
    return { px: p[0] - uz * k, pz: p[1] + ux * k, ux, uz };
  });
  return lines.map((b, i) => {
    const a = lines[(i + n - 1) % n];
    const den = a.ux * b.uz - a.uz * b.ux;
    if (Math.abs(den) < 1e-6) return [b.px, b.pz] as P2;
    const t = ((b.px - a.px) * b.uz - (b.pz - a.pz) * b.ux) / den;
    return [a.px + a.ux * t, a.pz + a.uz * t] as P2;
  });
}
const pushAll = (B: Bufs, u: number, y: number, w: number) => all(B).forEach((g) => g.push(u, y, w));
const popAll = (B: Bufs) => all(B).forEach((g) => g.pop());

const setAll = (B: Bufs, s: Seg) => {
  for (const g of all(B)) g.setFrame(s.ax, 0, s.az, s.nx, s.nz);
};

/** Mitre factor between consecutive segments (0 when not joined). */
function mitre(a: Seg | undefined, b: Seg | undefined): number {
  if (!a || !b) return 0;
  if (Math.hypot(a.bx - b.ax, a.bz - b.az) > 0.01) return 0;
  const d1x = (a.bx - a.ax) / a.len, d1z = (a.bz - a.az) / a.len;
  const d2x = (b.bx - b.ax) / b.len, d2z = (b.bz - b.az) / b.len;
  const th = Math.atan2(-(d2x * a.nx + d2z * a.nz), d2x * d1x + d2z * d1z);
  return Math.tan(th / 2);
}

function mat(g: GeoBuf, layer: number, col: V3, grime = 0): void {
  g.col = col;
  g.ext = [layer, grime, 0, 0];
}

const mulc = (c: V3, k: number): V3 => [c[0] * k, c[1] * k, c[2] * k];

// ---------------------------------------------------------------------------------------------

export function buildBuilding(b: BuildingSpec, B: Bufs, signs: SignAtlas, q: Quality, colliders: ColliderBox[] | null, lod: 0 | 1): void {
  const R = rng(b.seed);
  const cfg = config(b, R);
  const y0 = CURB;
  const gTop = y0 + b.groundH;
  const top = gTop + b.floors * b.floorH;
  const cH = cfg.cornice[cfg.cornice.length - 1][1];
  const roofY = top + cH - 0.05;
  const parH = cfg.parapet === 'balustrade' ? 1.0 : 0.85;
  const podRoof = gTop + b.floorH + 0.3; // hotel podium terrace
  const c: Ctx = {
    b, R, cfg, q, B, signs, y0, gTop, top,
    roofY: b.style === 'tower' ? podRoof : roofY,
    parTop: (b.style === 'tower' ? podRoof : roofY) + parH,
    fine: lod === 0 && b.detail === 0 && q !== 'low', lod, proxy: colliders !== null, rr: keyed(b.seed),
  };
  for (const g of all(B)) g.uvOff = [R() * 10, R() * 10];
  const cols = colliders ?? [];

  if (b.style === 'modern' || b.style === 'tower') modernBuilding(c, cols);
  else
    b.segs.forEach((s, i) => {
      setAll(B, s);
      segment(c, s, i, mitre(b.segs[i - 1], s), mitre(s, b.segs[i + 1]));
      collider(cols, s, c.parTop + 0.5);
    });
  roof(c);
  if (c.proxy) {
    // building mass, inset behind the facade line so recessed shutters, glass and shopfronts
    // stay lit (the proxy's front would otherwise shadow everything behind the facade plane)
    const g = B.shadow;
    g.setFrame(0, 0, 0, 0, 1);
    g.prismY(inset(b.footprint, 0.35), y0 - 0.2, b.style === 'modern' ? top + 1.0 : c.parTop);
  }
}

/** Thin solid slab behind a facade segment (front face 0.12 m in front of the facade line). */
export function collider(out: ColliderBox[], s: Seg, h: number): void {
  const dx = (s.bx - s.ax) / s.len, dz = (s.bz - s.az) / s.len;
  const front = 0.12, back = 0.9; // thin but solid slab from w = −0.9 to +0.12
  const wc = (front - back) / 2;
  out.push({
    cx: (s.ax + s.bx) / 2 + s.nx * wc, cy: h / 2 - 0.5, cz: (s.az + s.bz) / 2 + s.nz * wc,
    hx: s.len / 2 + 0.3, hy: h / 2 + 0.5, hz: (front + back) / 2, rotY: Math.atan2(-dz, dx),
  });
}

// ---------------------------------------------------------------------------------------------
// One facade segment of a classical building.

function segment(c: Ctx, s: Seg, si: number, k0: number, k1: number): void {
  const { b, cfg, B, y0, gTop, top } = c;
  const Lz = s.len;
  const side = s.role === 'side';
  const chamfer = s.role === 'chamfer';
  // same grid as the planner's shops (plan.ts bayGrid), so shop piers line up with the bays above
  const grid = bayGrid(Lz, side ? cfg.bay + 0.6 : cfg.bay);
  const margin = chamfer ? 0.3 : grid.margin;
  const nb = chamfer ? 1 : grid.nb;
  const bw = chamfer ? Lz - 0.6 : grid.bw;
  const mas = B.mas;
  const tint = b.tint;
  const grime = cfg.grime;

  // --- ground floor ----------------------------------------------------------------------------
  const shops = b.shops.filter((p) => p.seg === si);
  const gOpen: (Opening & { type: 'shop' | 'door' | 'win'; shop?: Shop })[] = [];
  const covered = (u: number) => shops.some((p) => u > p.u0 && u < p.u1);
  const freeBays: number[] = [];
  for (let k = 0; k < nb; k++) if (!covered(margin + (k + 0.5) * bw)) freeBays.push(k);
  const doorBay = side ? -1 : freeBays.length ? freeBays[Math.floor(freeBays.length / 2)] : -1;
  const shopTop = y0 + Math.min(3.7, b.groundH - 1.0);
  for (const p of shops) gOpen.push({ u0: p.u0, u1: p.u1, y0: y0 - 0.02, y1: shopTop, arch: 0, depth: 0.32, type: 'shop', shop: p });
  const clear = (a: number, e: number) => gOpen.every((p) => e < p.u0 - 0.35 || a > p.u1 + 0.35);
  for (const k of freeBays) {
    const cu = margin + (k + 0.5) * bw;
    if (!clear(cu - 1.0, cu + 1.0)) continue;
    if (k === doorBay) {
      const dw = Math.min(1.9, bw - 0.9);
      gOpen.push({ u0: cu - dw / 2, u1: cu + dw / 2, y0: y0 - 0.02, y1: y0 + Math.min(3.3, b.groundH - 1.2), arch: dw / 2, depth: 0.45, type: 'door' });
    } else if (chamfer && !side) {
      const dw = Math.min(1.6, bw - 0.4);
      gOpen.push({ u0: cu - dw / 2, u1: cu + dw / 2, y0: y0 - 0.02, y1: shopTop, arch: 0, depth: 0.32, type: 'shop', shop: { seg: si, u0: 0, u1: 0, kind: 'cafe', sign: '', closed: false, awning: 0 } });
    } else if (b.detail === 0 || !side) {
      const ww = Math.min(1.3, bw - 1.0);
      gOpen.push({ u0: cu - ww / 2, u1: cu + ww / 2, y0: y0 + 1.1, y1: y0 + (side ? 2.5 : 3.2), arch: 0, depth: 0.3, type: 'win' });
    }
  }
  gOpen.sort((p, q) => p.u0 - q.u0);
  const groundLayer = cfg.ground === L.MISC ? L.STONE : cfg.ground;
  mat(mas, groundLayer, groundLayer === L.STONE ? b.stone : tint, grime * 0.8);
  wallBand(c, 0, Lz, y0 - 0.3, gTop, gOpen, groundLayer === L.STONE ? b.stone : tint, groundLayer, grime * 0.8);
  if (cfg.ground === L.MISC && !side) {
    // deco: polished marble cladding up to the fascia
    mas.col = [0.5, 0.48, 0.45];
    mas.ext = [L.MISC, 0, 0, 0];
    const uv = miscUV('marble');
    pieceCladding(mas, 0, Lz, y0, y0 + 0.7, gOpen, uv);
  }
  // plinth
  mat(mas, L.STONE, mulc(b.stone, 0.82), grime);
  plinthPieces(mas, 0, Lz, y0 - 0.2, y0 + 0.32, 0.05, gOpen, k0, k1);
  for (const o of gOpen) {
    if (o.type === 'shop') shopfront(c, o, o.shop!);
    else if (o.type === 'door') entrance(c, o);
    else groundWindow(c, o);
  }

  // band between ground floor and first floor
  mat(mas, L.STUCCO, tint, grime * 0.6);
  mas.extrude(P_BAND_BIG, 0, Lz, gTop - 0.34, 0, k0, k1);
  sbox(c, 0, Lz, gTop - 0.34, gTop, -0.4, 0.22);

  // --- upper floors ------------------------------------------------------------------------------
  for (let f = 0; f < b.floors; f++) {
    const fy = gTop + f * b.floorH;
    const last = f === b.floors - 1;
    const winH = Math.min(b.floorH - 0.75, (cfg.french ? 2.5 : 1.7) - (last ? 0.3 : 0) - (f >= 3 ? 0.1 : 0));
    const sill = cfg.french ? 0.1 : 0.85;
    const ww = side ? Math.min(1.1, cfg.winW) : Math.min(cfg.winW, bw - 0.8);
    const opens: Opening[] = [];
    const wins: Rng[] = [];
    for (let k = 0; k < nb; k++) {
      const cu = margin + (k + 0.5) * bw;
      const wr = c.rr(si, f, k);
      if (side && chance(wr, 0.25)) continue; // blind bays on party / alley walls
      wins.push(wr);
      opens.push({ u0: cu - ww / 2, u1: cu + ww / 2, y0: fy + sill, y1: fy + sill + winH, arch: cfg.arch && !last ? cfg.arch : 0, depth: 0.26, floorTop: fy + b.floorH });
    }
    mat(mas, cfg.wall, tint, grime);
    wallBand(c, 0, Lz, fy, fy + b.floorH, opens, tint, cfg.wall, grime);
    const balc = side ? 'none' : cfg.balcony[f];
    opens.forEach((o, i) => {
      windowBay(c, o, f, s, balc === 'bal' || balc === 'none', wins[i]);
      if (!side && c.fine) facadeClutter(c, o, fy, s, balc, wins[i]);
    });
    if (!side) {
      if (balc === 'cont' && !chamfer) balcony(c, margin * 0.6, Lz - margin * 0.6, fy, 0.85, cfg.railing, true, f > 0);
      else if (balc === 'cont' || balc === 'indiv') for (const o of opens) balcony(c, o.u0 - 0.35, o.u1 + 0.35, fy, chamfer ? 0.9 : 0.6, cfg.railing, false, f > 0);
      if (cfg.relief && c.fine && f < b.floors - 1) {
        // relief panels above the windows (Art Nouveau / Haussmann) or in spandrels (Deco)
        mat(mas, L.MISC, tint, 0);
        const uv = miscUV(cfg.relief);
        for (const o of opens) {
          const cu = (o.u0 + o.u1) / 2;
          if (cfg.relief === 'deco') { if (!cfg.french) mas.rectW(cu - 0.5, cu + 0.5, fy + b.floorH + 0.1, fy + b.floorH + 0.72, 0.02, 1, uv); }
          else if (o.y1 + o.arch + 0.72 < fy + b.floorH - 0.05) mas.rectW(cu - 0.4, cu + 0.4, o.y1 + o.arch + 0.14, o.y1 + o.arch + 0.72, 0.03, 1, uv);
        }
      }
    }
    // string course
    if (!last) {
      mat(mas, L.STUCCO, tint, grime * 0.6);
      mas.extrude(c.lod ? P_BAND_LOD : P_BAND, 0, Lz, fy + b.floorH - 0.2, 0, k0, k1);
      sbox(c, 0, Lz, fy + b.floorH - 0.2, fy + b.floorH, -0.4, 0.09);
    }
  }

  // pilasters / quoins
  mat(mas, cfg.wall === L.PLASTER ? L.STUCCO : cfg.wall, mulc(tint, 1.02), grime * 0.7);
  if (cfg.pilasters === 'edges' && !chamfer && Lz > 6) {
    for (const u of [0, Lz - 0.55]) mas.box(u, u + 0.55, gTop, top - 0.05, 0, 0.06, 1 | 4 | 8);
  } else if (cfg.pilasters === 'bays' && !side) {
    for (let k = 0; k <= nb; k++) {
      const u = margin + k * bw;
      const u0 = Math.max(0, u - 0.2), u1 = Math.min(Lz, u + 0.2);
      mas.box(u0, u1, gTop, c.parTop + 0.45, 0, 0.16, 1 | 4 | 8 | 16);
      sbox(c, u0, u1, gTop, c.parTop + 0.45, -0.4, 0.16);
    }
  }

  // cornice (+ modillions) and parapet
  mat(mas, L.STUCCO, tint, grime * 0.5);
  mas.extrude(c.lod && cfg.cornice === P_CORNICE ? P_CORNICE_LOD : cfg.cornice, 0, Lz, top - 0.05, 0, k0, k1);
  sbox(c, 0, Lz, top - 0.05, top - 0.05 + cfg.cornice[cfg.cornice.length - 1][1], -0.4, Math.max(...cfg.cornice.map((p) => p[0])));
  if (cfg.modillions && c.fine && !side) {
    mas.col = mulc(tint, 0.97);
    for (let u = 0.35; u < Lz - 0.3; u += 0.7) mas.box(u, u + 0.14, top + 0.24, top + 0.36, 0.14, 0.44, 1 | 4 | 8 | 32);
  }
  parapet(c, s, Lz, nb, margin, bw, k0, k1);

  // drain pipe at the right end, dome on corners
  if (c.fine && !chamfer && s.role !== 'arm') {
    mat(mas, L.MISC, ZINC, 0);
    const u = Lz - 0.25;
    mas.tube([u, y0, 0.12], [u, top + 0.2, 0.12], 0.055, 5, PAINT_UV);
    mas.box(u - 0.12, u + 0.12, top + 0.1, top + 0.3, 0, 0.2, 1 | 4 | 8 | 16, PAINT_RECT);
  }
  if (chamfer && b.dome) dome(c, Lz);
  if (b.flag && s.role === 'main' && flagsOn(c)) flagPole(c, Lz * (0.35 + c.rr(si, 77)() * 0.3), gTop + 0.5, c.rr(si, 78));
}

// ---------------------------------------------------------------------------------------------
// Wall with rectangular/arched openings between yA and yB, made of columns: piers between
// openings, spandrels below (with a baked drip streak under the sill), lintels above.

function wallBand(c: Ctx, u0: number, u1: number, yA: number, yB: number, opens: Opening[], tint: V3, layer: number, grime: number): void {
  const g = c.B.back;
  mat(g, layer, tint, grime);
  let u = u0;
  const streak = 0.84 + 0.08 * (1 - grime);
  // dirt washed down from the ledge above (string course / balcony / cornice)
  g.setDrip(yB - 1.3, yB, 0, 0.55);
  for (const o of opens) {
    if (o.u0 > u + 1e-4) g.rectW(u, o.u0, yA, yB, 0, 1, undefined, 0.95, 1);
    // spandrel under the opening: drip streaks from the sill
    if (o.y0 > yA + 1e-3) {
      g.setRamp(yA, o.y0, 1, streak);
      g.setDrip(o.y0 - 1.6, o.y0, 0, 1);
      g.rectW(o.u0, o.u1, yA, o.y0, 0, 1);
      g.clearRamp();
      g.setDrip(yB - 1.3, yB, 0, 0.55);
    }
    // lintel / arch fill
    const head = o.y1 + o.arch;
    if (o.arch > 0) archFill(g, o, Math.min(yB, head + 0.4), 0);
    if (yB > head + (o.arch > 0 ? 0.4 : 0) + 1e-3) g.rectW(o.u0, o.u1, o.arch > 0 ? head + 0.4 : o.y1, yB, 0, 1, undefined, 0.95, 1);
    g.clearDrip();
    reveal(g, o, layer === L.STONE ? layer : L.STUCCO, tint);
    mat(g, layer, tint, grime);
    g.setDrip(yB - 1.3, yB, 0, 0.55);
    u = o.u1;
  }
  if (u1 > u + 1e-4) g.rectW(u, u1, yA, yB, 0, 1, undefined, 0.95, 1);
  g.clearDrip();
}

const ARCH_SEG = 8;
function archPts(o: Opening): P2[] {
  // segmental arch from (u0, y1) to (u1, y1) with rise `arch`
  const w = o.u1 - o.u0, h = o.arch;
  const r = (w * w) / (8 * h) + h / 2;
  const cy = o.y1 + h - r, cu = (o.u0 + o.u1) / 2;
  const a0 = Math.asin(Math.min(1, w / 2 / r));
  const pts: P2[] = [];
  for (let i = 0; i <= ARCH_SEG; i++) {
    const a = -a0 + (2 * a0 * i) / ARCH_SEG;
    pts.push([cu + Math.sin(a) * r, cy + Math.cos(a) * r]);
  }
  return pts;
}

/** Wall between an arched head and a horizontal line yTop. */
function archFill(g: GeoBuf, o: Opening, yTop: number, w: number): void {
  const pts = archPts(o);
  const [ou, ov] = g.uvOff;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ua, ya] = pts[i], [ub, yb] = pts[i + 1];
    g.quad([ua, ya, w], [ub, yb, w], [ub, yTop, w], [ua, yTop, w], [ua + ou, ya + ov], [ub + ou, yb + ov], [ub + ou, yTop + ov], [ua + ou, yTop + ov]);
  }
}

function reveal(g: GeoBuf, o: Opening, layer: number, tint: V3): void {
  mat(g, layer, tint, 0.2);
  const d = o.depth;
  g.rectU(o.u0, -d, 0, o.y0, o.y1, 1, undefined, 0.6, 0.92);
  g.rectU(o.u1, -d, 0, o.y0, o.y1, -1, undefined, 0.6, 0.92);
  g.rectY(o.y0, o.u0, o.u1, -d, 0, 1, undefined, 0.75, 1);
  if (o.arch > 0) {
    const pts = archPts(o);
    for (let i = 0; i < pts.length - 1; i++) {
      const [ua, ya] = pts[i], [ub, yb] = pts[i + 1];
      g.quad([ub, yb, 0], [ua, ya, 0], [ua, ya, -d], [ub, yb, -d], [ub, 0], [ua, 0], [ua, d], [ub, d], 0.85, 0.85, 0.55, 0.55);
    }
  } else g.rectY(o.y1, o.u0, o.u1, -d, 0, -1, undefined, 0.5, 0.85);
}

/** Glass pane filling an opening at depth w (arched heads become a polygon). */
function pane(c: Ctx, o: Opening, w: number, kind: number, frame: V3, yTop = o.y1, seed = -1): void {
  const g = c.B.glass;
  const H = yTop - o.y0 + (yTop === o.y1 ? o.arch : 0);
  const W = o.u1 - o.u0;
  g.col = frame;
  g.ext = [seed >= 0 ? seed : c.rr(o.u0, o.y0, w)(), W, H, kind];
  if (o.arch > 0 && yTop === o.y1) {
    const pts = archPts(o);
    const poly: P2[] = [[o.u0, o.y0], [o.u1, o.y0], ...pts.reverse()];
    const idx = poly.map(([u, y]) => g.v(u, y, w, 0, 0, 1, (u - o.u0) / W, (y - o.y0) / H));
    for (let i = 1; i < idx.length - 1; i++) g.tri(idx[0], idx[i], idx[i + 1]);
  } else g.rectW(o.u0, o.u1, o.y0, yTop, w, 1, [0, 0, 1, 1]);
}

// ---------------------------------------------------------------------------------------------

function windowBay(c: Ctx, o: Opening, f: number, s: Seg, railing: boolean, R: Rng): void {
  const { b, cfg, B } = c;
  const mas = B.mas;
  const W = o.u1 - o.u0;
  // closed persiennes hide the pane → skip glass
  const hasSh = chance(R, cfg.shutters);
  const st = R();
  const state = !hasSh ? 'none' : st < 0.3 ? 'closed' : st < 0.47 ? 'half' : 'open';
  pane(c, o, -o.depth + 0.06, cfg.french ? WIN.FRENCH : WIN.SMALL, b.frame, o.y1, R());
  // surround
  const surroundT = cfg.surround === 'none' ? 0 : 0.045;
  if (cfg.surround !== 'none' && s.role !== 'side' && c.lod === 1) {
    mat(mas, L.STUCCO, mulc(b.tint, 1.04), cfg.grime * 0.4);
    const bw = 0.16;
    mas.rectW(o.u0 - bw, o.u0, o.y0, o.y1, surroundT, 1);
    mas.rectW(o.u1, o.u1 + bw, o.y0, o.y1, surroundT, 1);
    mas.rectW(o.u0 - bw, o.u1 + bw, o.y1 + o.arch, o.y1 + o.arch + bw, surroundT, 1);
  } else if (cfg.surround !== 'none' && s.role !== 'side') {
    mat(mas, L.STUCCO, mulc(b.tint, 1.02), cfg.grime * 0.4);
    const bw = 0.16;
    const yTop = o.y1 + o.arch;
    mas.box(o.u0 - bw, o.u0, o.y0 - (cfg.french ? 0 : 0.05), o.y1, 0, surroundT, 1 | 8);
    mas.box(o.u1, o.u1 + bw, o.y0 - (cfg.french ? 0 : 0.05), o.y1, 0, surroundT, 1 | 4);
    if (o.arch > 0) {
      const pts = archPts(o);
      for (let i = 0; i < pts.length - 1; i++) {
        const [ua, ya] = pts[i], [ub, yb] = pts[i + 1];
        const oa = 1 + bw / (o.u1 - o.u0) * 1.4;
        const cu = (o.u0 + o.u1) / 2;
        const pa: P2 = [cu + (ua - cu) * oa, ya + bw], pb: P2 = [cu + (ub - cu) * oa, yb + bw];
        mas.quad([ua, ya, surroundT], [ub, yb, surroundT], [pb[0], pb[1], surroundT], [pa[0], pa[1], surroundT], [ua, ya], [ub, yb], pb, pa);
        mas.quad([pa[0], pa[1], 0], [pa[0], pa[1], surroundT], [pb[0], pb[1], surroundT], [pb[0], pb[1], 0], [0, 0], [0, 1], [1, 1], [1, 0]);
      }
    } else {
      mas.box(o.u0 - bw, o.u1 + bw, o.y1, yTop + bw, 0, surroundT, 1 | 8 | 4 | 16);
      if (cfg.surround === 'ears') {
        mas.box(o.u0 - bw - 0.08, o.u0 - bw, o.y1 - 0.12, o.y1 + bw, 0, surroundT, 1 | 8 | 32);
        mas.box(o.u1 + bw, o.u1 + bw + 0.08, o.y1 - 0.12, o.y1 + bw, 0, surroundT, 1 | 4 | 32);
      }
    }
    if (cfg.keystone) {
      const cu = (o.u0 + o.u1) / 2;
      mas.prism([[cu - 0.1, yTop - 0.02], [cu + 0.1, yTop - 0.02], [cu + 0.14, yTop + 0.3], [cu - 0.14, yTop + 0.3]], 0, surroundT + 0.05);
    }
    const room = (o.floorTop ?? o.y1 + 1) - 0.4 - (yTop + bw + 0.18);
    if (f === 0 && cfg.pediment && c.fine && room > 0.18) {
      const cu = (o.u0 + o.u1) / 2;
      const yb = yTop + bw + 0.02;
      mas.extrude(P_HOOD, o.u0 - 0.3, o.u1 + 0.3, yb, 0);
      mas.prism([[o.u0 - 0.28, yb + 0.16], [o.u1 + 0.28, yb + 0.16], [cu, yb + 0.16 + Math.min(0.5, room)]], 0, 0.1);
    } else if (cfg.hoods && o.arch === 0) mas.extrude(P_HOOD, o.u0 - 0.26, o.u1 + 0.26, yTop + bw, 0);
  }
  if (!cfg.french && c.lod === 0) {
    // stone sill
    mat(mas, L.STUCCO, mulc(b.tint, 0.96), cfg.grime * 0.6);
    mas.box(o.u0 - 0.1, o.u1 + 0.1, o.y0 - 0.07, o.y0, 0, 0.07, 1 | 4 | 8 | 16 | 32);
  }
  if (railing && cfg.french) {
    // garde-corps across the French window
    const [v0, v1] = cutV(s.role === 'side' ? 'bars' : cfg.railing);
    const cut = B.cut;
    cut.col = [1, 1, 1];
    cut.ext = [0, 0.06, 0.06, 0.065]; // distant fallback: blend over dark glass
    const k = 1 / CUT_STRIP_METERS;
    cut.rectW(o.u0, o.u1, o.y0 - 0.05, o.y0 + 0.9, -0.04, 1, [o.u0 * k, v0, o.u1 * k, v1]);
  }
  if (state !== 'none') shutters(c, o, state, surroundT, W, R);
}

function shutters(c: Ctx, o: Opening, state: 'closed' | 'half' | 'open', hingeW: number, W: number, R: Rng): void {
  const { b, B } = c;
  const g = B.mas;
  const col = chance(R, 0.06) ? mulc(b.shutter, range(R, 0.7, 1.2)) : b.shutter;
  mat(g, L.MISC, col, 0);
  const uv = miscUV('shutter');
  const lw = W / 2;
  const h0 = o.y0 + 0.02, h1 = o.y1 - 0.02;
  const t = 0.035;
  for (const sideK of [-1, 1] as const) {
    let ang = 0;
    if (state === 'open') ang = Math.PI - range(R, 0, 0.05);
    else if (state === 'half') ang = range(R, 1.2, 2.3);
    else ang = range(R, 0, 0.04);
    if (state === 'half' && chance(R, 0.3)) ang = Math.PI - 0.03; // one leaf open, one ajar
    const hu = sideK === -1 ? o.u0 : o.u1;
    if (c.lod === 1) {
      // far LOD: flat leaves (closed in the opening, otherwise folded against the wall)
      if (state === 'closed') g.rectW(sideK === -1 ? o.u0 : o.u1 - lw, sideK === -1 ? o.u0 + lw : o.u1, h0, h1, -0.03, 1, uv);
      else g.rectW(sideK === -1 ? o.u0 - lw : o.u1, sideK === -1 ? o.u0 : o.u1 + lw, h0, h1, hingeW + 0.02, 1, uv);
      continue;
    }
    const hw = state === 'closed' ? -0.02 : hingeW + 0.005;
    g.push(hu, 0, hw, sideK === -1 ? -ang : ang);
    const a = sideK === -1 ? 0 : -lw, bb = sideK === -1 ? lw : 0;
    g.box(a, bb, h0, h1, -t, 0, 1 | 2 | (sideK === -1 ? 4 : 8), uv);
    g.pop();
  }
}

// ---------------------------------------------------------------------------------------------

function balcony(c: Ctx, u0: number, u1: number, fy: number, depth: number, rail: CutStrip, cont: boolean, consoles: boolean): void {
  const { b, cfg, B } = c;
  const g = B.mas;
  mat(g, L.STUCCO, mulc(b.tint, 0.98), cfg.grime * 0.8);
  const t = 0.16;
  if (b.style === 'nouveau' && !cont) {
    // bowed slab
    const pts: P2[] = [[u0, 0]];
    const n = c.lod ? 4 : 8;
    const hw = (u1 - u0) / 2, mid = (u0 + u1) / 2;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI;
      pts.push([mid - Math.cos(a) * hw, Math.sin(a) * depth + 0.05]);
    }
    pts.push([u1, 0]);
    g.prismY(pts, fy - t, fy, true, true, true);
    const arc = pts.slice(1, -1);
    if (c.fine) {
      // moulded edge along the bow and three consoles under it, as on the straight balconies
      g.extrudePath(P_SLAB_EDGE, arc, fy - t - 0.04);
      if (consoles)
        for (const cu of [u0 + 0.3, mid, u1 - 0.3]) {
          const ca = Math.min(1, Math.abs(mid - cu) / hw);
          const dl = Math.sqrt(1 - ca * ca) * depth + 0.05; // bow depth at cu
          g.extrude(P_CONSOLE.map(([w, y]) => [w * (dl / 0.55) * 0.9, y] as P2), cu - 0.06, cu + 0.06, fy - t, 0);
        }
    }
    if (c.proxy) c.B.shadow.prismY([[u0, -0.4], ...arc, [u1, -0.4]], fy - t, fy);
    const path = arc.map(([u, w]) => [u, w - 0.03] as P2);
    railingStrip(c, path, fy, rail);
    handrail(c, path, fy + 0.95);
  } else {
    if (c.lod) g.box(u0, u1, fy - t, fy, 0, depth, 1 | 16 | 32);
    else g.prismY([[u0, 0], [u1, 0], [u1, depth], [u0, depth]], fy - t, fy, true, true, true);
    sbox(c, u0, u1, fy - t, fy, -0.4, depth);
    // consoles
    if (c.fine && consoles) {
      const n = Math.max(2, Math.round((u1 - u0) / 2.2));
      for (let i = 0; i <= n; i++) {
        const u = u0 + 0.12 + ((u1 - u0 - 0.36) * i) / n;
        g.extrude(P_CONSOLE.map(([w, y]) => [w * (depth / 0.55) * 0.95, y] as P2), u, u + 0.12, fy - t, 0);
      }
    }
    const path: P2[] = [[u0 + 0.03, 0], [u0 + 0.03, depth - 0.03], [u1 - 0.03, depth - 0.03], [u1 - 0.03, 0]];
    railingStrip(c, path, fy, rail);
    handrail(c, path, fy + 0.95);
  }
  // plants / hanging bougainvillea
  const R = c.rr(u0, fy, 5);
  if (c.fine && chance(R, cont ? 0.5 : 0.18)) {
    // plants: cards aligned to the 0.5 m clump slots of the atlas strip (no straight cut edges)
    const cut = B.cut;
    cut.col = [1, 1, 1];
    cut.ext = [1, 0, 0, 0]; // sways; foliage is always alpha-tested (no background proxy)
    const n = Math.max(1, Math.min(Math.floor((u1 - u0 - 0.3) / 0.5), 2 + Math.floor(R() * 3)));
    const pu = u0 + 0.15 + R() * Math.max(0, u1 - u0 - 0.3 - n * 0.5);
    const slot = Math.floor(R() * 4) * 0.25;
    if (chance(R, 0.5)) {
      const [v0, v1] = cutV('pots');
      cut.rectW(pu, pu + n * 0.5, fy, fy + 0.95, depth * 0.45, 1, [slot, v0, slot + n * 0.25, v1]);
    } else {
      const [v0, v1] = cutV('foliage');
      const drop = consoles ? range(R, 0.9, 1.9) : range(R, 0.7, 1.0); // first-floor balconies sit over shop signs
      cut.rectW(pu - 0.1, pu + n * 0.5 + 0.1, fy + 1.05 - drop, fy + 1.1, depth + 0.03, 1, [slot, v0, slot + n * 0.25, v1]);
    }
  }
}

function railingStrip(c: Ctx, path: P2[], fy: number, rail: CutStrip): void {
  const cut = c.B.cut;
  cut.col = [1, 1, 1];
  cut.ext = [0, ...mulc(c.b.tint, 0.14)]; // distant fallback: windows and wall behind, in the balcony's shade
  cut.strip(path, fy, fy + 0.97, cutV(rail), 1 / CUT_STRIP_METERS);
}

function handrail(c: Ctx, path: P2[], y: number): void {
  if (!c.fine) return;
  const g = c.B.mas;
  mat(g, L.MISC, IRON, 0);
  for (let i = 0; i < path.length - 1; i++) {
    const [ua, wa] = path[i], [ub, wb] = path[i + 1];
    g.tube([ua, y, wa], [ub, y, wb], 0.025, 4, PAINT_UV);
  }
}

// ---------------------------------------------------------------------------------------------

function parapet(c: Ctx, s: Seg, Lz: number, nb: number, margin: number, bw: number, k0: number, k1: number): void {
  const { b, cfg, B, roofY, parTop } = c;
  const g = B.mas;
  const tint = b.tint;
  mat(g, L.STUCCO, tint, cfg.grime * 0.6);
  const side = s.role === 'side';
  if (cfg.parapet === 'balustrade' && !side) {
    // pedestals at the bay boundaries + balustrade cards between them
    const [v0, v1] = cutV('balustrade');
    const cut = B.cut;
    cut.col = mulc(tint, 1.0);
    cut.ext = [0, ...mulc(tint, 0.6)];
    for (let k = 0; k <= nb; k += 1) {
      const u = k === 0 ? 0 : k === nb ? Lz - 0.5 : margin + k * bw - 0.25;
      g.box(u, u + 0.5, roofY, parTop, -0.3, 0.02, 1 | 4 | 8 | 16 | 2);
      if (k < nb) {
        const ua = u + 0.5, ub = k + 1 === nb ? Lz - 0.5 : margin + (k + 1) * bw - 0.25;
        cut.rectW(ua, ub, roofY, parTop - 0.08, -0.1, 1, [ua / CUT_STRIP_METERS, v0, ub / CUT_STRIP_METERS, v1]);
      }
    }
    g.extrude(P_COPING, 0, Lz, parTop - 0.02, -0.28, k0, k1);
    g.box(0, Lz, parTop - 0.02, parTop + 0.06, -0.3, 0.0, 16 | 2);
  } else {
    g.box(0, Lz, roofY, parTop, -0.25, 0, 1 | 2 | 16);
    g.extrude(P_COPING, 0, Lz, parTop, 0, k0, k1);
  }
  if (side || s.role === 'chamfer' || !c.fine) return;
  if (cfg.parapet === 'stepped') {
    // Art Deco: stepped attic in the middle third
    const mid = Lz / 2, w1 = Math.min(Lz * 0.45, 9), w2 = w1 * 0.55;
    g.box(mid - w1 / 2, mid + w1 / 2, parTop, parTop + 1.0, -0.3, 0.06, 1 | 2 | 4 | 8 | 16);
    g.box(mid - w2 / 2, mid + w2 / 2, parTop + 1.0, parTop + 1.9, -0.3, 0.06, 1 | 2 | 4 | 8 | 16);
    sbox(c, mid - w1 / 2, mid + w1 / 2, parTop - 0.1, parTop + 1.0, -0.6, 0.06);
    sbox(c, mid - w2 / 2, mid + w2 / 2, parTop + 1.0, parTop + 1.9, -0.6, 0.06);
    g.extrude(P_COPING, mid - w2 / 2, mid + w2 / 2, parTop + 1.9, 0.06);
    mat(g, L.MISC, tint, 0);
    g.rectW(mid - 0.7, mid + 0.7, parTop + 0.15, parTop + 1.75, 0.065, 1, miscUV('deco'));
  } else if (cfg.parapet === 'gable') {
    // Art Nouveau: curved gable with a floral relief
    const mid = Lz / 2, hw = Math.min(Lz * 0.22, 3.4), h = 2.2;
    const pts: P2[] = [[mid - hw, parTop]];
    for (let i = 0; i <= 12; i++) {
      const a = (i / 12) * Math.PI;
      const e = Math.sin(a);
      pts.push([mid - Math.cos(a) * hw, parTop + 0.3 + e * (h - 0.3) + (i === 0 || i === 12 ? -0.3 : 0)]);
    }
    pts.push([mid + hw, parTop]);
    g.prism(pts, -0.3, 0.05, true, true);
    if (c.proxy) c.B.shadow.prism(pts, -0.6, 0.05, true, true);
    g.col = mulc(tint, 1.02);
    g.ext = [L.MISC, 0, 0, 0];
    g.rectW(mid - 0.9, mid + 0.9, parTop + 0.2, parTop + 1.55, 0.06, 1, miscUV('floral'));
  }
}

// ---------------------------------------------------------------------------------------------
// Ground floor modules

function shopfront(c: Ctx, o: Opening, shop: Shop): void {
  const { b, B, signs, y0 } = c;
  const R = c.rr(o.u0, 11);
  const g = B.mas;
  const d = o.depth;
  const W = o.u1 - o.u0;
  const cafe = shop.kind === 'cafe';
  // stall riser
  const riser = y0 + 0.45;
  const rk: MiscRegion = cafe || shop.kind === 'patisserie' ? 'zellige' : shop.kind === 'banque' || shop.kind === 'bijouterie' ? 'marble' : 'paint';
  g.col = rk === 'paint' ? mulc(b.door, 1.2) : rk === 'marble' ? [0.35, 0.36, 0.34] : [1, 1, 1];
  g.ext = [L.MISC, 0, 0, 0];
  const doorW = Math.min(1.1, W * 0.35);
  const doorLeft = chance(R, 0.5);
  const du0 = doorLeft ? o.u0 + 0.08 : o.u1 - 0.08 - doorW, du1 = du0 + doorW;
  const uvR = miscUV(rk);
  const riserSpans: [number, number][] = doorLeft ? [[du1, o.u1]] : [[o.u0, du0]];
  for (const [a, bb] of riserSpans) {
    const rw = rk === 'zellige' ? Math.max(1, Math.round((bb - a) / 0.9)) : 1;
    for (let i = 0; i < rw; i++) {
      const ua = a + ((bb - a) * i) / rw, ub = a + ((bb - a) * (i + 1)) / rw;
      g.rectW(ua, ub, y0 - 0.02, riser, -d + 0.04, 1, rk === 'zellige' ? [uvR[0], uvR[1], uvR[2], uvR[1] + (uvR[3] - uvR[1]) * 0.5] : uvR);
    }
  }
  // wooden/metal shopfront frame
  mat(g, L.MISC, b.door, 0);
  const fu = miscUV('paint');
  g.box(o.u0, o.u1, o.y1 - 0.12, o.y1, -d, -d + 0.1, 1 | 32, fu);
  g.box(doorLeft ? du1 : du0 - 0.08, doorLeft ? du1 + 0.08 : du0, y0, o.y1, -d, -d + 0.1, 1 | 4 | 8, fu);
  g.box(o.u0, o.u1, riser - 0.04, riser + 0.02, -d, -d + 0.12, 1 | 16, fu);
  const kind = cafe ? WIN.CAFE : WIN.SHOP;
  const gl: Opening = { ...o, y0: riser + 0.02, y1: o.y1 - 0.12, u0: doorLeft ? du1 + 0.08 : o.u0, u1: doorLeft ? o.u1 : du0 - 0.08 };
  if (shop.closed) {
    // rolling shutter down
    g.col = [0.75, 0.75, 0.74];
    g.ext = [L.MISC, 0.2, 0, 0];
    g.rectW(o.u0, o.u1, y0, o.y1, -0.1, 1, miscUV('roll'));
  } else {
    pane(c, gl, -d + 0.05, kind, b.door);
    pane(c, { ...o, u0: du0, u1: du1, y0: y0, y1: o.y1 - 0.12 }, -d + 0.03, kind, b.door);
  }
  // roller-shutter box
  g.col = [0.6, 0.6, 0.58];
  g.ext = [L.MISC, 0.3, 0, 0];
  g.box(o.u0, o.u1, o.y1 - 0.02, o.y1 + 0.02, -0.12, 0, 32, miscUV('paint'));

  // fascia sign (far chunks skip it, except on 'low' where the far version is all there is)
  if (shop.sign && (c.lod === 0 || c.q === 'low')) {
    const signW = Math.min(W - 0.3, 6.4);
    const signH = signW / 8;
    const nSigns = W > 13 ? 2 : 1;
    for (let i = 0; i < nSigns; i++) {
      const cu = o.u0 + (W * (i + 0.5)) / nSigns;
      const sy = o.y1 + 0.18;
      mat(g, L.MISC, mulc(b.door, 0.7), 0);
      g.box(cu - signW / 2 - 0.06, cu + signW / 2 + 0.06, sy - 0.06, sy + signH + 0.06, 0, 0.08, 1 | 4 | 8 | 16 | 32, miscUV('paint'));
      const sg = B.sign;
      sg.col = [1, 1, 1];
      sg.ext = [0, 0, 0, 0];
      sg.rectW(cu - signW / 2, cu + signW / 2, sy, sy + signH, 0.095, 1, signs.uv(shop.sign)); // 1.5 cm off the board: no z-fighting
    }
    if (shop.kind === 'pharmacie') {
      // projecting green cross, double-sided
      const u = o.u1 + 0.2;
      const yc = o.y1 + 1.25;
      mat(g, L.MISC, IRON, 0);
      g.tube([u, yc, 0], [u, yc, 0.9], 0.03, 4, PAINT_UV);
      const sg = B.sign;
      const uv = signs.uv('cross');
      sg.push(u, 0, 0.25, -Math.PI / 2);
      sg.rectW(0, 0.7, yc - 0.35, yc + 0.35, 0.02, 1, uv);
      sg.rectW(0, 0.7, yc - 0.35, yc + 0.35, -0.02, -1, [uv[2], uv[1], uv[0], uv[3]]);
      sg.pop();
    }
  }
  // awning
  const fabric = shop.sign ? signs.fabric(shop.sign) : undefined;
  if (shop.awning) awning(c, o.u0 - 0.1, o.u1 + 0.1, o.y1 + 0.05, shop.awning === 2 ? 2.7 : 1.3, shop.awning === 2, R, fabric);
}

function awning(c: Ctx, u0: number, u1: number, yTop: number, depth: number, cafe: boolean, R: Rng, fabric?: string): void {
  const { B } = c;
  const g = B.mas;
  const [ca, cb] = fabric ? fabricPair(fabric, R) : pick(R, AWNING);
  // the valance stays above AWNING_CLEAR (a jumping Labib's ears), the slope flattens if needed
  const val = cafe ? 0.24 : 0.2;
  const drop = Math.max(0.12, Math.min(depth * (cafe ? 0.25 : 0.55), yTop - val - AWNING_CLEAR));
  const stripe = c.lod ? 0.64 : 0.32;
  const n = Math.max(1, Math.round((u1 - u0) / stripe));
  const uv = miscUV('fabric');
  for (let i = 0; i < n; i++) {
    const a = u0 + ((u1 - u0) * i) / n, bb = u0 + ((u1 - u0) * (i + 1)) / n;
    const col = i % 2 ? cb : ca;
    g.col = col;
    g.ext = [L.MISC, 0.25, 0, 0];
    // sloped canopy (top and underside)
    g.quad([a, yTop - drop, depth], [bb, yTop - drop, depth], [bb, yTop, 0], [a, yTop, 0], [uv[0], uv[1]], [uv[2], uv[1]], [uv[2], uv[3]], [uv[0], uv[3]]);
    g.col = mulc(col, 0.7);
    g.quad([bb, yTop - drop, depth], [a, yTop - drop, depth], [a, yTop, 0], [bb, yTop, 0], [uv[0], uv[1]], [uv[2], uv[1]], [uv[2], uv[3]], [uv[0], uv[3]]);
    // valance
    g.col = col;
    g.rectW(a, bb, yTop - drop - val, yTop - drop, depth, 1, uv);
    g.col = mulc(col, 0.6);
    g.rectW(a, bb, yTop - drop - val, yTop - drop, depth - 0.01, -1, uv);
  }
  // cheeks
  g.col = ca;
  for (const u of [u0, u1]) {
    // triangular cheek, both sides
    const a = g.v(u, yTop, 0, 1, 0, 0, uv[0], uv[3]);
    const p = g.v(u, yTop - drop, depth, 1, 0, 0, uv[2], uv[3]);
    const q = g.v(u, yTop - drop - val, depth, 1, 0, 0, uv[2], uv[1]);
    const a2 = g.v(u, yTop, 0, -1, 0, 0, uv[0], uv[3]);
    const p2 = g.v(u, yTop - drop, depth, -1, 0, 0, uv[2], uv[3]);
    const q2 = g.v(u, yTop - drop - val, depth, -1, 0, 0, uv[2], uv[1]);
    g.tri(a, q, p);
    g.tri(a2, p2, q2);
  }
  // support arms
  if (c.fine) {
    mat(g, L.MISC, IRON, 0);
    for (let u = u0 + 0.3; u < u1; u += cafe ? 3.2 : Math.max(1, u1 - u0 - 0.6)) g.tube([u, yTop - 0.6, 0], [u, yTop - drop - 0.02, depth - 0.05], 0.02, 3, PAINT_UV);
  }
  if (c.proxy) c.B.shadow.extrude([[0, 0], [depth, -drop], [depth, -drop - val], [depth - 0.05, -drop - val], [depth - 0.05, -drop - 0.05], [0, -0.1]], u0, u1, yTop, 0);
}

function entrance(c: Ctx, o: Opening): void {
  const { b, B, y0, cfg } = c;
  const g = B.mas;
  // leaves + transom + fanlight
  const doorTop = o.y1 - 0.15;
  mat(g, L.MISC, b.door, 0);
  g.rectW(o.u0, o.u1, y0, doorTop, -o.depth + 0.06, 1, miscUV('door'));
  g.box(o.u0, o.u1, doorTop, doorTop + 0.1, -o.depth + 0.04, -o.depth + 0.14, 1 | 16 | 32, miscUV('paint'));
  pane(c, { ...o, y0: doorTop + 0.1 }, -o.depth + 0.07, WIN.FANLIGHT, IRON);
  // step
  mat(g, L.STONE, mulc(b.stone, 0.9), 0.4);
  g.box(o.u0, o.u1, y0 - 0.02, y0 + 0.12, -o.depth, 0, 1 | 16);
  // rusticated surround
  if (cfg.ground === L.STONE) {
    mat(g, L.STONE, mulc(b.stone, 1.03), cfg.grime * 0.6);
    const cu = (o.u0 + o.u1) / 2, top = o.y1 + o.arch;
    g.box(o.u0 - 0.35, o.u0, y0, o.y1, 0, 0.06, 1 | 8 | 4 | 16);
    g.box(o.u1, o.u1 + 0.35, y0, o.y1, 0, 0.06, 1 | 8 | 4 | 16);
    g.prism([[cu - 0.18, top - 0.05], [cu + 0.18, top - 0.05], [cu + 0.25, top + 0.4], [cu - 0.25, top + 0.4]], 0, 0.1);
  }
}

function groundWindow(c: Ctx, o: Opening): void {
  const { B } = c;
  pane(c, o, -o.depth + 0.06, WIN.SMALL, c.b.frame);
  const [v0, v1] = cutV('grille');
  const cut = B.cut;
  cut.col = [1, 1, 1];
  cut.ext = [0, 0.05, 0.05, 0.055];
  cut.rectW(o.u0, o.u1, o.y0, o.y1, -0.06, 1, [0, v0, (o.u1 - o.u0) / CUT_STRIP_METERS, v1]);
  const g = B.mas;
  mat(g, L.STUCCO, mulc(c.b.stone, 0.95), 0.5);
  g.box(o.u0 - 0.08, o.u1 + 0.08, o.y0 - 0.08, o.y0, 0, 0.08, 1 | 4 | 8 | 16 | 32);
}

/** Cladding (marble) on the wall between openings, from yA to yB. */
function pieceCladding(g: GeoBuf, u0: number, u1: number, yA: number, yB: number, opens: Opening[], uv: readonly number[]): void {
  let u = u0;
  for (const o of opens) {
    if (o.u0 > u + 0.05) g.box(u, o.u0, yA, yB, 0, 0.03, 1 | 16, uv);
    u = o.u1;
  }
  if (u1 > u + 0.05) g.box(u, u1, yA, yB, 0, 0.03, 1 | 16, uv);
}

function plinthPieces(g: GeoBuf, u0: number, u1: number, yA: number, yB: number, t: number, opens: Opening[], k0: number, k1: number): void {
  let u = u0;
  const seg = (a: number, bb: number, first: boolean, last: boolean) => {
    const prof: P2[] = [[0, 0], [t, 0], [t, yB - yA - 0.04], [0, yB - yA]];
    g.extrude(prof, a, bb, yA, 0, first ? k0 : 0, last ? k1 : 0);
  };
  const low = opens.filter((o) => o.y0 < yB);
  low.forEach((o, i) => {
    if (o.u0 > u + 0.02) seg(u, o.u0, i === 0 && u === u0, false);
    u = o.u1;
  });
  if (u1 > u + 0.02) seg(u, u1, u === u0, true);
}

// ---------------------------------------------------------------------------------------------
// Facade clutter: AC units, dishes (south-facing only), cable runs.

function facadeClutter(c: Ctx, o: Opening, fy: number, s: Seg, balc: string, R: Rng): void {
  const { B, q } = c;
  const g = B.mas;
  if (chance(R, q === 'medium' ? 0.1 : 0.16)) {
    // beside the window, never over the drain pipe at the right end of the facade
    const right = chance(R, 0.5) && o.u1 + 1.1 < s.len - 0.5;
    const u = right ? o.u1 + 0.28 : o.u0 - 0.28 - 0.82;
    const y = balc !== 'none' ? fy + 0.05 : fy + range(R, 0.1, 0.5);
    const w = balc !== 'none' ? 0.35 : 0.08;
    acUnit(g, u, y, w);
    sbox(c, u, u + 0.82, y, y + 0.56, w, w + 0.3);
    if (balc === 'none') {
      mat(g, L.MISC, IRON, 0);
      g.box(u + 0.08, u + 0.12, y - 0.04, y, 0, w + 0.32, 1 | 16 | 4 | 8, PAINT_RECT);
      g.box(u + 0.7, u + 0.74, y - 0.04, y, 0, w + 0.32, 1 | 16 | 4 | 8, PAINT_RECT);
    }
  }
  // dish on balconies of facades that look south
  if (s.nz > 0.5 && balc !== 'none' && balc !== 'bal' && chance(R, 0.08)) dish(g, o.u1 + 0.5, fy + 0.2, 0.35, range(R, 0.35, 0.45), [0, 0.7, 0.7]);
}

function acUnit(g: GeoBuf, u: number, y: number, w: number): void {
  mat(g, L.MISC, [0.86, 0.86, 0.84], 0);
  const uv = miscUV('ac');
  const paint = miscUV('paint');
  g.box(u, u + 0.82, y, y + 0.56, w, w + 0.3, 2 | 4 | 8 | 16 | 32, paint);
  g.rectW(u, u + 0.82, y, y + 0.56, w + 0.3, 1, uv);
  mat(g, L.MISC, [0.9, 0.9, 0.88], 0);
  g.tube([u + 0.78, y + 0.1, w + 0.1], [u + 0.78, y + 0.1, 0], 0.02, 3, PAINT_UV);
}

/** Satellite dish: paraboloid facing `aim` (local dir) on a mast; `lite` = hinterland version. */
function dish(g: GeoBuf, u: number, y: number, w: number, r: number, aim: V3, lite = false): void {
  mat(g, L.MISC, [0.82, 0.82, 0.8], 0);
  const l = Math.hypot(aim[0], aim[1], aim[2]);
  const A: V3 = [aim[0] / l, aim[1] / l, aim[2] / l];
  // basis perpendicular to A
  let P: V3 = [A[2], 0, -A[0]];
  let pl = Math.hypot(P[0], P[2]);
  if (pl < 1e-3) { P = [1, 0, 0]; pl = 1; }
  P = [P[0] / pl, 0, P[2] / pl];
  const Q: V3 = [A[1] * P[2] - A[2] * P[1], A[2] * P[0] - A[0] * P[2], A[0] * P[1] - A[1] * P[0]];
  const C: V3 = [u, y + r, w];
  const seg = lite ? 6 : 8, rings = lite ? 1 : 2;
  const [pu, pv] = PAINT_UV;
  const idx: number[][] = [];
  for (let i = 0; i <= rings; i++) {
    const rr = (i / rings) * r;
    const depth = (rr * rr) / (4 * r * 0.6);
    const row: number[] = [];
    for (let k = 0; k <= seg; k++) {
      const a = (k / seg) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const px = C[0] + A[0] * depth + (P[0] * ca + Q[0] * sa) * rr;
      const py = C[1] + A[1] * depth + (P[1] * ca + Q[1] * sa) * rr;
      const pz = C[2] + A[2] * depth + (P[2] * ca + Q[2] * sa) * rr;
      const nr = -rr / (2 * r * 0.6);
      const nx = A[0] + (P[0] * ca + Q[0] * sa) * nr, ny = A[1] + (P[1] * ca + Q[1] * sa) * nr, nz = A[2] + (P[2] * ca + Q[2] * sa) * nr;
      row.push(g.v(px, py, pz, nx, ny, nz, pu, pv));
    }
    idx.push(row);
  }
  for (let i = 0; i < rings; i++)
    for (let k = 0; k < seg; k++) {
      g.quadIdx(idx[i][k], idx[i + 1][k], idx[i + 1][k + 1], idx[i][k + 1]);
      g.quadIdx(idx[i][k + 1], idx[i + 1][k + 1], idx[i + 1][k], idx[i][k]); // back side
    }
  const tip: V3 = [C[0] + A[0] * r * 0.9, C[1] + A[1] * r * 0.9, C[2] + A[2] * r * 0.9];
  if (!lite) g.tube([C[0] - Q[0] * r * 0.9, C[1] - Q[1] * r * 0.9, C[2] - Q[2] * r * 0.9], tip, 0.012, 3, PAINT_UV);
  mat(g, L.MISC, ZINC, 0);
  g.tube([C[0] - A[0] * 0.05, C[1], C[2] - A[2] * 0.05], [C[0] - A[0] * 0.05, y - 0.05, C[2] - A[2] * 0.05], 0.025, 4, PAINT_UV);
}

function flagPole(c: Ctx, u: number, y: number, R: Rng): void {
  const { B } = c;
  const g = B.mas;
  mat(g, L.MISC, [0.75, 0.75, 0.72], 0);
  const len = 2.6, el = 0.7; // pole elevation
  const tip: V3 = [u, y + Math.sin(el) * len, Math.cos(el) * len];
  g.tube([u, y, 0], tip, 0.03, 5, PAINT_UV);
  g.box(u - 0.08, u + 0.08, y - 0.1, y + 0.1, 0, 0.06, 63, PAINT_RECT);
  // flag hangs from the upper half of the pole, flying along ±u
  const fl = B.flag;
  const fw = 1.5, fh = 1.0;
  const dirU = chance(R, 0.5) ? 1 : -1;
  const nx = 6, ny = 3;
  const phase = R() * 6;
  const [ax, az] = fl.axisU();
  const rows: number[][] = [];
  for (let j = 0; j <= ny; j++) {
    const row: number[] = [];
    for (let i = 0; i <= nx; i++) {
      const s = i / nx, t = j / ny;
      const bu = tip[0] + dirU * s * fw, by = tip[1] - 0.05 - t * fh, bw = tip[2] - 0.1;
      fl.ext = [s, phase, ax * dirU, az * dirU];
      row.push(fl.v(bu, by, bw, 0, 0, 1, dirU > 0 ? s : 1 - s, 1 - t));
    }
    rows.push(row);
  }
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) fl.quadIdx(rows[j + 1][i], rows[j + 1][i + 1], rows[j][i + 1], rows[j][i]);
}

function dome(c: Ctx, Lz: number): void {
  const { b, B, parTop, roofY } = c;
  const g = B.mas;
  const cu = Lz / 2;
  const r = 2.1;
  const cw = -r - 0.2;
  mat(g, L.STUCCO, b.tint, 0.3);
  if (c.proxy) {
    const oct = (rr: number): P2[] => Array.from({ length: 8 }, (_, i) => [cu + Math.cos((i / 8) * Math.PI * 2) * rr, cw + Math.sin((i / 8) * Math.PI * 2) * rr] as P2);
    B.shadow.prismY(oct(r), roofY - 0.2, parTop + 1.85);
    B.shadow.prismY(oct(r * 0.75), parTop + 1.85, parTop + 1.85 + r);
  }
  // drum
  const sg = c.lod ? 12 : 20;
  g.lathe([[r, roofY - 0.2], [r, parTop + 1.6]], cu, 0, cw, sg);
  g.lathe([[r + 0.15, parTop + 1.6], [r + 0.15, parTop + 1.8], [r, parTop + 1.85]], cu, 0, cw, sg);
  // cupola (slate-grey zinc or white)
  const zinc = chance(c.rr(55), 0.5);
  mat(g, zinc ? L.MISC : L.STUCCO, zinc ? [0.33, 0.36, 0.38] : b.tint, 0.2);
  const prof: P2[] = [];
  for (let i = 0; i <= 8; i++) {
    const a = (i / 8) * (Math.PI / 2);
    prof.push([Math.cos(a) * r * 0.98, parTop + 1.85 + Math.sin(a) * r * 1.1]);
  }
  g.lathe(prof, cu, 0, cw, sg, false, zinc ? PAINT_RECT : undefined);
  // lantern
  mat(g, L.STUCCO, b.tint, 0.2);
  g.lathe([[0.35, parTop + 1.85 + r * 1.08], [0.35, parTop + 2.7 + r], [0.45, parTop + 2.75 + r], [0.05, parTop + 3.3 + r]], cu, 0, cw, 10);
  // drum windows (glass, small)
  const gl = B.glass;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    gl.push(cu + Math.cos(a) * (r + 0.01), 0, cw + Math.sin(a) * (r + 0.01), -a - Math.PI / 2);
    gl.col = [0.9, 0.9, 0.88];
    gl.ext = [c.rr(56, i)(), 0.6, 1.0, WIN.SMALL];
    gl.rectW(-0.3, 0.3, parTop + 0.3, parTop + 1.3, 0, 1, [0, 0, 1, 1]);
    gl.pop();
  }
}

// ---------------------------------------------------------------------------------------------
// Roof, parapets on non-facade edges, side/back walls, rooftop clutter.

function roof(c: Ctx): void {
  const { b, B, roofY, parTop, cfg } = c;
  const g = B.back;
  const fp = b.footprint;
  const tallTop = roofY;
  // world frame: (u, y, w) = (x, y, z); flat roofs are mostly whitewashed, some bare concrete
  for (const q of all(B)) q.setFrame(0, 0, 0, 0, 1);
  const rw = c.rr(99)();
  mat(g, L.ROOF, rw < 0.65 ? [1.2, 1.18, 1.12] : [1.0, 0.98, 0.94], 0.5);
  g.prismY(fp, tallTop - 0.3, tallTop, true, false, false);

  // edges that are not facade segments → side/back walls + plain parapet
  const isFacade = (a: P2, bb: P2) =>
    b.segs.some((s) => (Math.hypot(s.ax - a[0], s.az - a[1]) < 0.05 && Math.hypot(s.bx - bb[0], s.bz - bb[1]) < 0.05) || (Math.hypot(s.bx - a[0], s.bz - a[1]) < 0.05 && Math.hypot(s.ax - bb[0], s.az - bb[1]) < 0.05));
  // polygon orientation: make edges run so that the outward normal is (−dz, dx) like facade segs
  let area = 0;
  for (let i = 0; i < fp.length; i++) {
    const p = fp[i], n = fp[(i + 1) % fp.length];
    area += p[0] * n[1] - n[0] * p[1];
  }
  const flip = area > 0; // n = (−dz, dx) points outward when the shoelace area is negative
  const main = b.segs.find((s) => s.role === 'main') ?? b.segs[0];
  for (let i = 0; i < fp.length; i++) {
    let a = fp[i], bb = fp[(i + 1) % fp.length];
    if (isFacade(a, bb)) continue;
    if (flip) [a, bb] = [bb, a];
    const dx = bb[0] - a[0], dz = bb[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 0.3) continue;
    const nx = -dz / len, nz = dx / len;
    for (const q of all(B)) q.setFrame(a[0], 0, a[1], nx, nz);
    const back = nx * main.nx + nz * main.nz < -0.7;
    if (back && b.style !== 'tower') {
      // rear facade: impostor windows above a blind ground floor
      mat(g, L.PLASTER, mulc(b.tint, 0.92), cfg.grime);
      g.rectW(0, len, -0.2, c.gTop, 0, 1);
      impostorWall(g, 0, len, c.gTop, c.top, b.floorH, mulc(b.tint, 0.95), 3.5);
      mat(g, L.PLASTER, mulc(b.tint, 0.92), cfg.grime);
      g.rectW(0, len, c.top, parTop, 0, 1);
    } else {
      mat(g, L.PLASTER, mulc(b.tint, 0.9), Math.min(1, cfg.grime + 0.2));
      g.rectW(0, len, -0.2, parTop, 0, 1);
    }
    mat(g, L.PLASTER, mulc(b.tint, 0.9), 0.6);
    g.box(0, len, tallTop, tallTop + 0.7, -0.22, 0, 2 | 16);
  }
  for (const q of all(B)) q.setFrame(0, 0, 0, 0, 1);
  if (b.detail === 1 && c.q === 'low') return;
  rooftop(c, fp, tallTop, c.rr(4242), c.lod ? 2 : 0);
}

function pointIn(fp: P2[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = fp.length - 1; i < fp.length; j = i++) {
    const [xi, zi] = fp[i], [xj, zj] = fp[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** level 0 = full clutter, 1 = hinterland (moderate), 2 = far LOD (boxes only). */
function rooftop(c: Ctx, fp: P2[], y: number, R: Rng, level: 0 | 1 | 2): void {
  const g = c.B.mas;
  const xs = fp.map((p) => p[0]), zs = fp.map((p) => p[1]);
  const x0 = Math.min(...xs) + 1.5, x1 = Math.max(...xs) - 1.5, z0 = Math.min(...zs) + 1.5, z1 = Math.max(...zs) - 1.5;
  if (x1 <= x0 || z1 <= z0) return;
  const area = (x1 - x0) * (z1 - z0);
  const spots = (n: number, fn: (x: number, z: number) => void) => {
    for (let i = 0, tries = 0; i < n && tries < n * 6; tries++) {
      const x = range(R, x0, x1), z = range(R, z0, z1);
      if (!pointIn(fp, x, z)) continue;
      fn(x, z);
      i++;
    }
  };
  const lowQ = c.q === 'low' || level === 2;
  const k = level === 1 ? 0.4 : 1;
  // stair / lift access box
  spots(level === 1 && R() < 0.5 ? 0 : 1, (x, z) => {
    mat(g, L.PLASTER, mulc(c.b.tint, 0.95), 0.7);
    g.box(x - 1.3, x + 1.3, y, y + 2.5, z - 1.2, z + 1.2, 1 | 2 | 4 | 8);
    sbox(c, x - 1.4, x + 1.4, y - 0.3, y + 2.65, z - 1.3, z + 1.3);
    mat(g, L.ROOF, [0.9, 0.9, 0.88], 0.4);
    g.box(x - 1.4, x + 1.4, y + 2.5, y + 2.65, z - 1.3, z + 1.3);
    mat(g, L.MISC, c.b.door, 0);
    g.rectW(x - 0.45, x + 0.45, y, y + 2.0, z + 1.21, 1, miscUV('door'));
  });
  // water tanks (black plastic, some white / blue)
  spots(Math.min(level === 0 ? 5 : 2, 1 + Math.floor(area / 90)), (x, z) => {
    const col: V3 = pick(R, [[0.05, 0.05, 0.055], [0.05, 0.05, 0.055], [0.8, 0.8, 0.78], [0.12, 0.25, 0.5]] as V3[]);
    mat(g, L.MISC, col, 0);
    sbox(c, x - 0.55, x + 0.55, y - 0.3, y + 1.6, z - 0.55, z + 0.55);
    if (level > 0) g.box(x - 0.55, x + 0.55, y + 0.3, y + 1.6, z - 0.55, z + 0.55, 1 | 2 | 4 | 8 | 16, TANK_UV);
    else g.lathe([[0.56, 0.0], [0.58, 1.1], [0.46, 1.24], [0.16, 1.3]], x, y + 0.35, z, 8, true, TANK_UV);
    if (level === 0) {
      mat(g, L.MISC, ZINC, 0);
      g.box(x - 0.5, x + 0.5, y, y + 0.35, z - 0.5, z + 0.5, 1 | 2 | 4 | 8 | 16, PAINT_RECT);
    }
  });
  // dishes: mostly pointing south (+Z), elevation ~45°
  if (!lowQ)
    spots(level === 1 ? (R() < 0.6 ? 1 : 0) : Math.min(6, 1 + Math.floor(area / 60)), (x, z) => {
      const a = range(R, -0.5, 0.5);
      dish(g, x, y + 0.2, z, range(R, 0.3, 0.5), [Math.sin(a), 0.75, Math.cos(a)], level === 1);
    });
  // solar water heaters facing south
  if (!lowQ)
    spots(Math.floor((area / 140) * k), (x, z) => {
      mat(g, L.MISC, [1, 1, 1], 0);
      const uv = miscUV('solar');
      const w = 1.0, h = 2.0, el = 0.75;
      const zb = z + 0.6, zt = z + 0.6 - Math.cos(el) * h, yt = y + 0.3 + Math.sin(el) * h;
      g.quad([x - w, y + 0.3, zb], [x + w, y + 0.3, zb], [x + w, yt, zt], [x - w, yt, zt], [uv[0], uv[1]], [uv[2], uv[1]], [uv[2], uv[3]], [uv[0], uv[3]]);
      mat(g, L.MISC, [0.7, 0.7, 0.68], 0);
      if (level === 0) g.tube([x - w - 0.1, yt + 0.28, zt - 0.1], [x + w + 0.1, yt + 0.28, zt - 0.1], 0.28, 8, PAINT_UV);
      else g.box(x - w - 0.1, x + w + 0.1, yt, yt + 0.5, zt - 0.35, zt + 0.15, 1 | 2 | 4 | 8 | 16, PAINT_RECT);
      mat(g, L.MISC, ZINC, 0);
      if (level === 0) {
        g.tube([x - w, y, zt], [x - w, yt, zt], 0.03, 3, PAINT_UV);
        g.tube([x + w, y, zt], [x + w, yt, zt], 0.03, 3, PAINT_UV);
      }
    });
  // old TV antennas
  if (!lowQ && level === 0 && c.b.detail === 0)
    spots(1 + Math.floor(R() * 2), (x, z) => {
      mat(g, L.MISC, ZINC, 0);
      const h = range(R, 2.0, 3.5);
      g.tube([x, y, z], [x, y + h, z], 0.02, 3, PAINT_UV);
      for (let k2 = 0; k2 < 3; k2++) {
        const yy = y + h - 0.25 - k2 * 0.3, l = 0.5 - k2 * 0.1;
        g.tube([x - l, yy, z], [x + l, yy, z], 0.008, 3, PAINT_UV);
      }
    });
}

/** Wall of impostor windows (far LOD / rear facades), tiled 4 bays × 3 floors per texture. */
export function impostorWall(g: GeoBuf, u0: number, u1: number, yA: number, yB: number, floorH: number, tint: V3, bayW: number): void {
  const [fv0, fv1] = IMPOSTOR_V.floors;
  g.col = tint;
  g.ext = [L.IMPOSTOR, 0.5, 0, 0];
  const band = floorH * 3;
  const su0 = u0 / (4 * bayW), su1 = u1 / (4 * bayW);
  for (let y = yA; y < yB - 0.05; y += band) {
    const y2 = Math.min(yB, y + band);
    const t1 = fv0 + ((y2 - y) / band) * (fv1 - fv0);
    g.rectW(u0, u1, y, y2, 0, 1, [su0, fv0, su1, t1]);
  }
}

export function impostorGround(g: GeoBuf, u0: number, u1: number, yA: number, yB: number, tint: V3, bayW: number): void {
  const [v0, v1] = IMPOSTOR_V.ground;
  g.col = tint;
  g.ext = [L.IMPOSTOR, 0.5, 0, 0];
  g.rectW(u0, u1, yA, yB, 0, 1, [u0 / (4 * bayW), v0, u1 / (4 * bayW), v1]);
}

// ---------------------------------------------------------------------------------------------
// 1960s–70s modernist block and the hotel tower.

function modernBuilding(c: Ctx, colliders: ColliderBox[]): void {
  const { b, B, y0, gTop } = c;
  const tower = b.style === 'tower';
  const s = b.segs.find((q) => q.role === 'main')!;
  setAll(B, s);
  const g = B.mas;
  const Lz = s.len;
  const tint = b.tint;
  // podium: glass + concrete piers
  const nb = Math.max(1, Math.round(Lz / 4.2));
  const bw = Lz / nb;
  const opens: Opening[] = [];
  for (let k = 0; k < nb; k++) opens.push({ u0: k * bw + 0.3, u1: (k + 1) * bw - 0.3, y0: y0 - 0.02, y1: gTop - 0.9, arch: 0, depth: 0.5 });
  mat(g, L.CONCRETE, tint, 0.6);
  wallBand(c, 0, Lz, y0 - 0.3, gTop, opens, tint, L.CONCRETE, 0.6);
  const shops = b.shops.filter((p) => p.seg === b.segs.indexOf(s));
  for (const o of opens) {
    const cu = (o.u0 + o.u1) / 2;
    const shop = shops.find((p) => cu > p.u0 && cu < p.u1);
    if (shop) shopfront(c, o, { ...shop, awning: 0, sign: Math.abs(cu - (shop.u0 + shop.u1) / 2) < bw / 2 ? shop.sign : '' });
    else pane(c, o, -o.depth + 0.05, WIN.SHOP, [0.25, 0.25, 0.26]);
  }
  if (tower) {
    // podium 1st floor ribbon window, parapet and entrance canopy
    const o2: Opening = { u0: 0.4, u1: Lz - 0.4, y0: gTop + 0.9, y1: gTop + b.floorH - 0.3, arch: 0, depth: 0.2 };
    mat(g, L.CONCRETE, tint, 0.5);
    wallBand(c, 0, Lz, gTop, gTop + b.floorH + 0.3, [o2], tint, L.CONCRETE, 0.5);
    pane(c, o2, -0.15, WIN.MODERN, [0.3, 0.3, 0.32]);
    mat(g, L.CONCRETE, mulc(tint, 0.95), 0.3);
    g.box(Lz * 0.3, Lz * 0.7, gTop - 0.5, gTop - 0.25, 0, 3.2);
    g.box(0, Lz, c.roofY, c.parTop, -0.25, 0.05, 1 | 2 | 16);
    sbox(c, Lz * 0.3, Lz * 0.7, gTop - 0.5, gTop - 0.25, -0.4, 3.2);
    // three flags on the podium, over the entrance canopy
    if (flagsOn(c)) for (const k of [0.38, 0.5, 0.62]) flagPole(c, Lz * k, gTop + 0.35, c.rr(79, k));
  }
  // slab (tower sets back 4 m)
  const set = tower ? 4 : 0;
  const u0 = tower ? 2 : 0, u1 = tower ? Lz - 2 : Lz;
  const baseY = tower ? gTop + b.floorH + 0.3 : gTop;
  const nf = tower ? b.floors - 1 : b.floors;
  const topY = baseY + nf * b.floorH;
  pushAll(B, 0, 0, -set);
  const nbay = Math.max(2, Math.round((u1 - u0) / (tower ? 3.8 : 3.4)));
  const bb = (u1 - u0) / nbay;
  for (let f = 0; f < nf; f++) {
    const fy = baseY + f * b.floorH;
    const op: Opening[] = [];
    for (let k = 0; k < nbay; k++) op.push({ u0: u0 + k * bb + 0.25, u1: u0 + (k + 1) * bb - 0.25, y0: fy + 0.9, y1: fy + b.floorH - 0.35, arch: 0, depth: 0.22 });
    mat(g, L.CONCRETE, tint, 0.55);
    wallBand(c, u0, u1, fy, fy + b.floorH, op, tint, L.CONCRETE, 0.55);
    for (const o of op) {
      const R = c.rr(f, o.u0, 3);
      const closedBlind = chance(R, 0.25);
      pane(c, o, -0.17, WIN.MODERN, [0.62, 0.63, 0.64]);
      if (closedBlind) {
        // roller blind half down
        mat(g, L.MISC, [0.75, 0.7, 0.6], 0);
        g.rectW(o.u0, o.u1, o.y1 - (o.y1 - o.y0) * range(R, 0.3, 0.9), o.y1, -0.12, 1, miscUV('roll'));
      }
      if (c.fine && chance(R, 0.14)) acUnit(g, o.u1 - 0.9, fy + 0.1, 0.02);
    }
    // spandrel tiles (70s blue ceramic) or concrete
    if (!tower && c.fine) {
      g.col = [0.9, 0.9, 0.9];
      g.ext = [L.MISC, 0, 0, 0];
      for (const o of op) g.rectW(o.u0, o.u1, fy + 0.1, o.y0 - 0.05, 0.01, 1, miscUV('tiles'));
    }
    // floor slab edge / hotel balconies
    mat(g, L.CONCRETE, mulc(tint, 1.03), 0.4);
    if (tower) {
      // hotel loggia balconies: slab, solid white parapet, party fins between rooms
      g.box(u0, u1, fy - 0.2, fy, 0, 1.3, 1 | 4 | 8 | 16 | 32);
      mat(g, L.CONCRETE, mulc(tint, 1.06), 0.35);
      g.box(u0, u1, fy, fy + 0.95, 1.18, 1.3, 1 | 2 | 4 | 8 | 16);
      mat(g, L.CONCRETE, mulc(tint, 1.03), 0.4);
      for (let k = 0; k <= nbay; k++) g.box(u0 + k * bb - 0.08, u0 + k * bb + 0.08, fy, fy + b.floorH - 0.2, 0, 1.3, 1 | 4 | 8);
      sbox(c, u0, u1, fy - 0.2, fy, -0.4, 1.3);
      sbox(c, u0, u1, fy, fy + 0.95, 1.18, 1.3);
      for (let k = 0; k <= nbay; k++) sbox(c, u0 + k * bb - 0.08, u0 + k * bb + 0.08, fy, fy + b.floorH - 0.2, -0.4, 1.3);
    } else {
      g.extrude(P_SLAB_MODERN, u0, u1, fy - 0.28, 0);
      sbox(c, u0, u1, fy - 0.28, fy, -0.4, 0.32);
    }
  }
  if (!tower) {
    // vertical brise-soleil fins
    mat(g, L.CONCRETE, mulc(tint, 1.02), 0.5);
    for (let k = 0; k <= nbay; k++) g.box(u0 + k * bb - 0.07, u0 + k * bb + 0.07, gTop, topY, 0, 0.55, 1 | 4 | 8 | 16);
    for (let k = 0; k <= nbay; k++) sbox(c, u0 + k * bb - 0.07, u0 + k * bb + 0.07, gTop, topY, -0.4, 0.55);
  }
  // crown
  mat(g, L.CONCRETE, tint, 0.5);
  g.extrude(P_SLAB_MODERN, u0, u1, topY - 0.05, 0);
  g.box(u0, u1, topY, topY + 1.0, -0.25, 0.05, 1 | 2 | 16);
  if (tower) {
    // rooftop sign
    mat(g, L.MISC, IRON, 0);
    const sw = 12, cu = (u0 + u1) / 2;
    g.box(cu - sw / 2, cu + sw / 2, topY + 1.0, topY + 2.8, -1.6, -1.3, 63, PAINT_RECT);
    B.sign.col = [1, 1, 1];
    B.sign.ext = [0, 0, 0, 0];
    B.sign.rectW(cu - sw / 2, cu + sw / 2, topY + 1.2, topY + 1.2 + sw / 8, -1.29, 1, c.signs.uv('roof'));
  }
  popAll(B);
  // tower side walls + back: concrete with impostor-like window grid
  if (tower) {
    const fpSlab: P2[] = [];
    const L0 = [s.ax, s.az], dir = [(s.bx - s.ax) / Lz, (s.bz - s.az) / Lz];
    const P = (u: number, w: number): P2 => [L0[0] + dir[0] * u + s.nx * w, L0[1] + dir[1] * u + s.nz * w];
    fpSlab.push(P(u0, -set), P(u1, -set), P(u1, -set - 14), P(u0, -set - 14));
    // sides & back of the slab: real window grid (cheap) instead of the classical impostor
    const edges: [P2, P2][] = [[fpSlab[1], fpSlab[2]], [fpSlab[2], fpSlab[3]], [fpSlab[3], fpSlab[0]]];
    for (const [a, e] of edges) {
      const dx = e[0] - a[0], dz = e[1] - a[1], len = Math.hypot(dx, dz);
      for (const q of all(B)) q.setFrame(a[0], 0, a[1], -dz / len, dx / len);
      const n = Math.max(2, Math.round(len / 3.8)), w = len / n;
      for (let f = 0; f < nf; f++) {
        const fy = baseY + f * b.floorH;
        const op: Opening[] = [];
        for (let k = 0; k < n; k++) op.push({ u0: k * w + 0.5, u1: (k + 1) * w - 0.5, y0: fy + 0.9, y1: fy + b.floorH - 0.4, arch: 0, depth: 0.15 });
        mat(g, L.CONCRETE, mulc(tint, 0.97), 0.55);
        wallBand(c, 0, len, fy, fy + b.floorH, op, mulc(tint, 0.97), L.CONCRETE, 0.55);
        for (const o of op) pane(c, o, -0.1, WIN.MODERN, [0.62, 0.63, 0.64]);
      }
      mat(g, L.CONCRETE, tint, 0.5);
      g.rectW(0, len, topY, topY + 1.0, 0, 1);
    }
    for (const q of all(B)) q.setFrame(0, 0, 0, 0, 1);
    mat(g, L.ROOF, [0.9, 0.9, 0.88], 0.5);
    g.prismY(fpSlab, topY - 0.2, topY + 0.05, true, false, false);
    if (c.proxy) B.shadow.prismY(inset(fpSlab, 0.35), baseY - 0.5, topY + 1.0);
    rooftop(c, fpSlab, topY + 0.05, c.rr(4243), c.lod ? 2 : 0);
    setAll(B, s);
  }
  // other facade segments (e.g. a side on an alley): concrete wall with a window grid
  const sideTop = tower ? c.parTop : topY + 1.0;
  for (const q of b.segs) {
    if (q === s) continue;
    setAll(B, q);
    mat(g, L.CONCRETE, mulc(tint, 0.95), 0.6);
    g.rectW(0, q.len, y0 - 0.3, gTop, 0, 1);
    const n = Math.max(1, Math.round(q.len / 3.8)), w = q.len / n;
    const nf2 = Math.max(0, Math.floor((sideTop - 0.8 - gTop) / b.floorH));
    for (let f = 0; f < nf2; f++) {
      const fy = gTop + f * b.floorH;
      const op: Opening[] = [];
      for (let k = 0; k < n; k++) op.push({ u0: k * w + 0.6, u1: (k + 1) * w - 0.6, y0: fy + 0.9, y1: fy + b.floorH - 0.4, arch: 0, depth: 0.15 });
      wallBand(c, 0, q.len, fy, fy + b.floorH, op, mulc(tint, 0.95), L.CONCRETE, 0.6);
      for (const o of op) pane(c, o, -0.1, WIN.MODERN, [0.62, 0.63, 0.64]);
    }
    mat(g, L.CONCRETE, mulc(tint, 0.95), 0.6);
    g.rectW(0, q.len, gTop + nf2 * b.floorH, sideTop, 0, 1);
    collider(colliders, q, sideTop + 0.5);
  }
  collider(colliders, s, tower ? gTop + 2 * b.floorH : topY + 1.5);
}

// ---------------------------------------------------------------------------------------------
// Hinterland: low-detail blocks behind the street walls so high cameras see a continuous city.

export function hinterBlock(x0: number, z0: number, x1: number, z1: number, floors: number, R: Rng, B: Bufs, signs: SignAtlas, q: Quality): void {
  const floorH = range(R, 3.1, 3.4);
  const gTop = CURB + 4.2;
  const top = gTop + floors * floorH;
  const b: BuildingSpec = {
    seed: 0, style: 'plain', detail: 1, segs: [], footprint: [[x0, z0], [x1, z0], [x1, z1], [x0, z1]], floors, groundH: 4.2, floorH,
    tint: mulc(pick(R, [[0.93, 0.88, 0.8], [0.9, 0.88, 0.84], [0.88, 0.8, 0.66], [0.92, 0.9, 0.86]] as V3[]), 1), stone: [0.8, 0.78, 0.72],
    shutter: [0.3, 0.35, 0.3], frame: [0.8, 0.8, 0.8], door: [0.3, 0.2, 0.12], shops: [], flag: false, dome: false, bay: 3.3, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2,
  };
  const c: Ctx = {
    b, R, cfg: config(b, R), q, B, signs, y0: CURB, gTop, top, roofY: top + 0.1, parTop: top + 0.8, fine: false,
    lod: 1, proxy: false, rr: keyed(Math.floor(R() * 1e9)),
  };
  const g = B.back;
  const fp = b.footprint;
  for (let i = 0; i < 4; i++) {
    // footprint is CW in (x, z) → reverse edge order for outward normals (−dz, dx)
    const a = fp[(i + 1) % 4], e = fp[i];
    const dx = e[0] - a[0], dz = e[1] - a[1], len = Math.hypot(dx, dz);
    g.setFrame(a[0], 0, a[1], -dz / len, dx / len);
    g.uvOff = [R() * 4, 0];
    impostorGround(g, 0, len, -0.2, gTop, mulc(b.tint, 0.95), 3.5);
    impostorWall(g, 0, len, gTop, top, floorH, b.tint, 3.5);
    mat(g, L.PLASTER, mulc(b.tint, 0.92), 0.6);
    g.rectW(0, len, top, top + 0.8, 0, 1);
  }
  g.setFrame(0, 0, 0, 0, 1);
  mat(g, L.ROOF, R() < 0.6 ? [1.18, 1.16, 1.1] : [0.98, 0.96, 0.92], 0.5);
  g.prismY(fp, top - 0.2, top + 0.1, true, false, false);
  if (q !== 'low') rooftop(c, fp, top + 0.1, R, 1);
}
