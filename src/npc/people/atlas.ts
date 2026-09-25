// Shared procedural detail atlas for the whole crowd, painted once at load on 2D canvases (no
// downloaded assets). 8 × 4 cells: painted faces, hair strands, skin, and garment construction
// (seams, stitching, pockets, buttons, folds) for every clothing kind. Two textures come out:
//  - decal (sRGB RGBA): colour + coverage of painted features that REPLACE the vertex colour
//    (eyes, brows, lash lines, lips, drawstrings, topstitching, zips…)
//  - detail (linear RGBA): tangent-space normal from a painted height field (RGB) and an albedo
//    shade multiplier (A, 0.5 = ×1) applied to the per-person vertex colours.
// Tubes (torso, limbs) wrap around their cell horizontally: u = 0.5 is the front, 0 / 1 the back.
import { DataTexture, LinearFilter, LinearMipmapLinearFilter, NoColorSpace, RGBAFormat, SRGBColorSpace, UnsignedByteType, type WebGLRenderer } from 'three';
import type { Quality } from '../../core/types';
import { setNeutralUv } from './geometry';
import { FACE, FACE_K, HEAD_ASPECT, faceXY } from './head';
import { rng, type Rng } from './traits';

export const COLS = 8, ROWS = 4;
/** Gutter around each cell's content, as a fraction of the cell (mip / filtering safety). */
const GUT = 8 / 256;

export const CELL = {
  faceM: 0, faceF: 1, faceOldM: 2, faceOldF: 3, faceM2: 4, faceF2: 5, hair: 6, hairCurly: 7,
  skin: 8, hand: 9, tee: 10, shirt: 11, polo: 12, knit: 13, hoodie: 14, blouse: 15,
  suit: 16, leather: 17, bomber: 18, denimJk: 19, cardigan: 20, robe: 21, skirt: 22, hijab: 23,
  jeansLeg: 24, trouserLeg: 25, jeansHips: 26, trouserHips: 27, sleeve: 28, sneaker: 29, shoe: 30, bag: 31,
} as const;
export type CellId = (typeof CELL)[keyof typeof CELL];

/** Vertical ranges (fractions of body height H) that garment cells are painted for. */
export const V = {
  torso: [0.4, 0.86],
  leg: [0, 0.56],
  skirt: [0, 0.62],
  sleeve: [0.44, 0.83],
  /** Hips cells: the waist line (top of the trousers' waistband) sits at v = HIPS_WAIST; one unit of v = 0.18 H. */
  hipsSpan: 0.18,
} as const;
export const HIPS_WAIST = 0.8;

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
/** Atlas texture coordinates of (u, v) inside a cell's content area. */
export function cellUV(cell: number, u: number, v: number): [number, number] {
  const cx = cell % COLS, cy = Math.floor(cell / COLS); // cy counts rows from the top of the atlas
  const uu = GUT + clamp01(u) * (1 - 2 * GUT), vv = GUT + clamp01(v) * (1 - 2 * GUT);
  return [(cx + uu) / COLS, 1 - (cy + 1 - vv) / ROWS];
}
// untextured bits (cups, lenses, handles) sample the near-neutral skin cell
setNeutralUv(cellUV(CELL.skin, 0.5, 0.5));

// ---------------------------------------------------------------------------------------------
// canvas helpers (all coordinates in cell UV units, v up)
type G2 = CanvasRenderingContext2D;
type Pt = readonly [number, number];
interface Pen { dec: G2; sh: G2; ht: G2; r: Rng }
const TAU = Math.PI * 2;
const K = '#000', W = '#fff';

function pathOf(g: G2, pts: readonly Pt[], close = false): void {
  g.beginPath();
  g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
  if (close) g.closePath();
}
function stroke(g: G2, pts: readonly Pt[], w: number, style: string, a = 1, dash?: number[]): void {
  g.globalAlpha = a;
  g.strokeStyle = style;
  g.lineWidth = w;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  if (dash) g.setLineDash(dash);
  pathOf(g, pts);
  g.stroke();
  if (dash) g.setLineDash([]);
  g.globalAlpha = 1;
}
/** Soft brush: overlapping strokes, strongest in the middle. */
function soft(g: G2, pts: readonly Pt[], w: number, style: string, a: number, n = 6): void {
  for (let i = n; i >= 1; i--) stroke(g, pts, (w * i) / n, style, a / n);
}
function fill(g: G2, pts: readonly Pt[], style: string | CanvasGradient, a = 1): void {
  g.globalAlpha = a;
  g.fillStyle = style;
  pathOf(g, pts, true);
  g.fill();
  g.globalAlpha = 1;
}
function ell(g: G2, x: number, y: number, rx: number, ry: number, style: string | CanvasGradient, a = 1): void {
  g.globalAlpha = a;
  g.fillStyle = style;
  g.beginPath();
  g.ellipse(x, y, rx, ry, 0, 0, TAU);
  g.fill();
  g.globalAlpha = 1;
}
/** Radial soft spot (colour → transparent). */
function spot(g: G2, x: number, y: number, r: number, rgb: string, a: number, sy = 1): void {
  g.save();
  g.translate(x, y);
  g.scale(1, sy);
  const gr = g.createRadialGradient(0, 0, 0, 0, 0, r);
  gr.addColorStop(0, `rgba(${rgb},${a})`);
  gr.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = gr;
  g.fillRect(-r, -r, 2 * r, 2 * r);
  g.restore();
}
/** Smooth polyline through control points (Catmull-Rom), n samples per span. */
function smoothPts(c: readonly Pt[], n = 6): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < c.length - 1; i++) {
    const p0 = c[Math.max(0, i - 1)], p1 = c[i], p2 = c[i + 1], p3 = c[Math.min(c.length - 1, i + 2)];
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      const f = (a: number, b: number, cc: number, d: number) => 0.5 * (2 * b + (-a + cc) * t + (2 * a - 5 * b + 4 * cc - d) * t2 + (-a + 3 * b - 3 * cc + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(c[c.length - 1]);
  return out;
}
const hline = (v: number, u0 = 0, u1 = 1): Pt[] => [[u0, v], [u1, v]];
const vline = (u: number, v0 = -0.05, v1 = 1.05): Pt[] => [[u, v0], [u, v1]];
const wavy = (r: Rng, v: number, amp: number, u0 = 0, u1 = 1, n = 8): Pt[] => {
  const ph = r() * TAU, f = 1 + Math.floor(r() * 3);
  return Array.from({ length: n + 1 }, (_, i) => { const u = u0 + ((u1 - u0) * i) / n; return [u, v + amp * Math.sin(u * TAU * f + ph)] as Pt; });
};

// construction details
const seam = (p: Pen, pts: readonly Pt[], d = 0.5, w = 0.005) => { stroke(p.ht, pts, w, K, d); stroke(p.sh, pts, w * 0.8, K, d * 0.32); };
const ridge = (p: Pen, pts: readonly Pt[], d = 0.4, w = 0.006) => { stroke(p.ht, pts, w, W, d); stroke(p.sh, pts, w * 0.6, W, d * 0.18); };
const fold = (p: Pen, pts: readonly Pt[], w: number, d = 0.3) => { soft(p.ht, pts, w, K, d); soft(p.sh, pts, w * 0.7, K, d * 0.4); };
const puff = (p: Pen, pts: readonly Pt[], w: number, d = 0.3) => { soft(p.ht, pts, w, W, d); soft(p.sh, pts, w * 0.7, W, d * 0.28); };
const DASH = [0.008, 0.0065];
function stitch(p: Pen, pts: readonly Pt[], col?: string, a = 0.75, w = 0.0032): void {
  if (col) stroke(p.dec, pts, w, col, a, DASH);
  else stroke(p.sh, pts, w, K, 0.28, DASH);
  stroke(p.ht, pts, w, K, 0.3, DASH);
}
function button(p: Pen, x: number, y: number, r: number, col?: string): void {
  if (col) { ell(p.dec, x, y, r, r, col, 0.95); ell(p.dec, x - r * 0.25, y + r * 0.3, r * 0.35, r * 0.35, W, 0.25); }
  else { ell(p.sh, x, y, r, r, W, 0.14); ell(p.sh, x, y, r * 0.3, r * 0.3, K, 0.25); }
  ell(p.ht, x, y, r * 1.15, r * 1.15, K, 0.35);
  ell(p.ht, x, y, r, r, W, 0.55);
}
function zip(p: Pen, pts: readonly Pt[], col = '#8e8e90'): void {
  stroke(p.dec, pts, 0.009, '#2a2a2c', 0.85);
  stroke(p.dec, pts, 0.005, col, 0.9, [0.003, 0.003]);
  seam(p, pts, 0.5, 0.012);
}
const rect = (u0: number, v0: number, u1: number, v1: number): Pt[] => [[u0, v0], [u1, v0], [u1, v1], [u0, v1], [u0, v0]];
const mirror = (pts: readonly Pt[]): Pt[] => pts.map(([u, v]) => [1 - u, v] as Pt);
/** Sleeve-side seams / drag folds shared by torso garments. */
function torsoBase(p: Pen, folds = 1): void {
  for (const u of [0.25, 0.75]) seam(p, vline(u), 0.35, 0.005);
  // drag folds from the armpits toward the chest and back
  for (const [a, b] of [[[0.29, 0.83], [0.39, 0.72]], [[0.21, 0.83], [0.11, 0.72]]] as [Pt, Pt][]) {
    fold(p, [a, b], 0.05, 0.22 * folds);
    fold(p, mirror([a, b]), 0.05, 0.22 * folds);
  }
  // waist wrinkles
  for (let i = 0; i < 4; i++) fold(p, wavy(p.r, 0.24 + i * 0.05 + p.r() * 0.02, 0.012), 0.04, 0.13 * folds);
}

// ---------------------------------------------------------------------------------------------
// faces (painted in head-radius units: x right = the character's left, y up; see head.ts)
interface FaceStyle {
  female: boolean;
  old: boolean;
  iris: [string, string, string]; // pupil ring, body, limbal rim
  brow: string;
  browW: number; // thickness multiplier
  browArch: number;
  browA: number;
  eyeW: number;
  eyeH: number;
  lash: number;
  liner: number; // kohl 0..1
  lip: string;
  lipA: number;
  lipFull: number;
  blush: number;
}

const FACES: Record<number, FaceStyle> = {
  [CELL.faceM]: { female: false, old: false, iris: ['#7a5632', '#3e2716', '#1a0f08'], brow: '#231810', browW: 1.3, browArch: 0.012, browA: 0.92, eyeW: 1.16, eyeH: 1.0, lash: 0.028, liner: 0, lip: '#9a544c', lipA: 0.28, lipFull: 0.9, blush: 0.04 },
  [CELL.faceM2]: { female: false, old: false, iris: ['#94743e', '#5c4422', '#2a1c0e'], brow: '#2a1d13', browW: 1.45, browArch: 0.025, browA: 0.92, eyeW: 1.12, eyeH: 0.9, lash: 0.028, liner: 0, lip: '#94504a', lipA: 0.3, lipFull: 1, blush: 0.05 },
  [CELL.faceF]: { female: true, old: false, iris: ['#86603a', '#48301c', '#1c1009'], brow: '#281a12', browW: 0.9, browArch: 0.045, browA: 0.9, eyeW: 1.22, eyeH: 1.12, lash: 0.038, liner: 0.2, lip: '#b04a55', lipA: 0.5, lipFull: 1.1, blush: 0.14 },
  [CELL.faceF2]: { female: true, old: false, iris: ['#644028', '#301c10', '#140a05'], brow: '#1c130d', browW: 1.0, browArch: 0.05, browA: 0.92, eyeW: 1.2, eyeH: 1.06, lash: 0.04, liner: 0.85, lip: '#8c3844', lipA: 0.55, lipFull: 1.05, blush: 0.09 },
  [CELL.faceOldM]: { female: false, old: true, iris: ['#6e5c48', '#403226', '#1c1610'], brow: '#9c958c', browW: 1.5, browArch: 0.0, browA: 0.9, eyeW: 1.1, eyeH: 0.86, lash: 0.024, liner: 0, lip: '#90605a', lipA: 0.2, lipFull: 0.72, blush: 0.03 },
  [CELL.faceOldF]: { female: true, old: true, iris: ['#6e4c32', '#3c2818', '#1a100a'], brow: '#4c3e35', browW: 0.9, browArch: 0.03, browA: 0.88, eyeW: 1.14, eyeH: 0.92, lash: 0.03, liner: 0.35, lip: '#984a52', lipA: 0.34, lipFull: 0.84, blush: 0.07 },
};

function bez(g: G2, a: Pt, c1: Pt, c2: Pt, b: Pt, start = true): void {
  if (start) g.moveTo(a[0], a[1]);
  g.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], b[0], b[1]);
}
/** Samples a cubic Bézier (for strokes that need tapering / sampling). */
function bezPts(a: Pt, c1: Pt, c2: Pt, b: Pt, n = 12): Pt[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n, s = 1 - t;
    return [s * s * s * a[0] + 3 * s * s * t * c1[0] + 3 * s * t * t * c2[0] + t * t * t * b[0], s * s * s * a[1] + 3 * s * s * t * c1[1] + 3 * s * t * t * c2[1] + t * t * t * b[1]] as Pt;
  });
}

function paintFace(p: Pen, st: FaceStyle): void {
  const [ex, ey] = faceXY(FACE.eye.th, FACE.eye.ph);
  const [, ny] = faceXY(FACE.noseTip.th, 0);
  const [, my] = faceXY(FACE.mouth.th, 0);
  for (const g of [p.dec, p.sh, p.ht]) g.transform(1 / (2 * FACE_K), 0, 0, HEAD_ASPECT / (2 * FACE_K), 0.5, 0.5);
  const { dec, sh, ht } = p;

  for (const s of [1, -1] as const) {
    const P = (lx: number, ly: number): Pt => [s * (ex + lx), ey + ly];
    const w = st.eyeW, hgt = st.eyeH;
    const I = P(-0.15 * w, -0.004), O = P(0.165 * w, 0.016);
    const U1 = P(-0.085 * w, 0.09 * hgt), U2 = P(0.085 * w, 0.1 * hgt);
    const L1 = P(0.09 * w, -0.058 * hgt), L2 = P(-0.075 * w, -0.066 * hgt);
    const eyePath = (g: G2) => { g.beginPath(); bez(g, I, U1, U2, O); bez(g, O, L1, L2, I, false); g.closePath(); };
    const upper = bezPts(I, U1, U2, O), lower = bezPts(O, L1, L2, I);

    // socket, crease and lid relief
    spot(sh, s * ex, ey + 0.02, 0.32, '0,0,0', 0.2, 0.75);
    const crease = smoothPts([P(-0.13 * w, 0.075), P(0, 0.16 * hgt + 0.005), P(0.15 * w, 0.085)]);
    soft(sh, crease, 0.035, K, st.old ? 0.26 : 0.16);
    soft(ht, crease, 0.03, K, 0.45);
    soft(ht, smoothPts([P(-0.12 * w, 0.06), P(0, 0.12 * hgt), P(0.14 * w, 0.065)]), 0.05, W, 0.35);
    soft(ht, lower.map(([x, y]) => [x, y - 0.02] as Pt), 0.03, W, 0.25);

    // sclera
    eyePath(dec);
    dec.fillStyle = '#ebe4dc';
    dec.fill();
    dec.save();
    eyePath(dec);
    dec.clip();
    // iris + pupil
    const ic = P(0, 0.008);
    const ir = 0.07 * (0.55 + 0.45 * w);
    const gr = dec.createRadialGradient(ic[0], ic[1], 0, ic[0], ic[1], ir);
    gr.addColorStop(0, st.iris[0]);
    gr.addColorStop(0.45, st.iris[0]);
    gr.addColorStop(0.62, st.iris[1]);
    gr.addColorStop(0.86, st.iris[1]);
    gr.addColorStop(1, st.iris[2]);
    ell(dec, ic[0], ic[1], ir, ir, gr);
    for (let k = 0; k < 18; k++) {
      const a = (k / 18) * TAU + p.r() * 0.2;
      stroke(dec, [[ic[0] + Math.cos(a) * ir * 0.42, ic[1] + Math.sin(a) * ir * 0.42], [ic[0] + Math.cos(a) * ir * 0.85, ic[1] + Math.sin(a) * ir * 0.85]], 0.006, st.iris[0], 0.35);
    }
    ell(dec, ic[0], ic[1], 0.03 * (0.55 + 0.45 * w), 0.03 * (0.55 + 0.45 * w), '#070504');
    // corner shading + caruncle
    spot(dec, I[0] + s * 0.012, I[1], 0.05, '150,100,95', 0.55);
    spot(dec, O[0] - s * 0.01, O[1], 0.06, '120,90,80', 0.4);
    // shadow of the upper lid on the eyeball
    const lg = dec.createLinearGradient(0, ey + 0.1 * hgt, 0, ey - 0.005);
    lg.addColorStop(0, 'rgba(45,28,22,0.6)');
    lg.addColorStop(1, 'rgba(45,28,22,0)');
    dec.fillStyle = lg;
    dec.fillRect(s * ex - 0.25, ey - 0.1, 0.5, 0.25);
    // catchlights (same light direction for both eyes)
    ell(dec, ic[0] - 0.022, ic[1] + 0.026, 0.014, 0.014, W, 0.95);
    ell(dec, ic[0] + 0.02, ic[1] - 0.022, 0.006, 0.006, W, 0.45);
    dec.restore();

    // lash lines
    stroke(dec, upper, st.lash, '#15100d', 0.95);
    if (st.liner > 0) stroke(dec, upper, st.lash * 1.5, '#0d0907', 0.75 * st.liner);
    if (st.female) fill(dec, [O, P(0.2 * w, 0.05), P(0.16 * w, 0.03)], '#15100d', 0.9);
    stroke(dec, lower, 0.009 + 0.008 * st.liner, st.liner > 0.5 ? '#120c09' : '#3b2a22', 0.45 + 0.4 * st.liner);
    soft(sh, lower.map(([x, y]) => [x, y - 0.018] as Pt), 0.02, W, 0.1);
    // under-eye
    const bag = smoothPts([P(-0.12, -0.1), P(0.03, -0.13), P(0.16, -0.09)]);
    soft(sh, bag, 0.05, K, st.old ? 0.2 : 0.07);
    if (st.old) {
      soft(ht, bag, 0.04, K, 0.4);
      soft(ht, bag.map(([x, y]) => [x, y + 0.03] as Pt), 0.04, W, 0.35);
      for (const a of [-0.45, -0.1, 0.25]) {
        const o = P(0.2, 0.005);
        const pts: Pt[] = [o, [o[0] + s * Math.cos(a) * 0.11, o[1] + Math.sin(a) * 0.11]];
        stroke(sh, pts, 0.01, K, 0.16);
        stroke(ht, pts, 0.01, K, 0.35);
      }
    }

    // brow: tapered body + hair strokes
    const bw = 0.055 * st.browW;
    const b0 = P(-0.17, 0.19), bm = P(0.05, 0.24 + st.browArch), b1 = P(0.25, 0.19 + st.browArch * 0.3);
    const top = smoothPts([b0, bm, b1], 5);
    const bot = smoothPts([P(-0.165, 0.19 - bw), P(0.05, 0.24 + st.browArch - bw * 0.62), P(0.24, 0.187 + st.browArch * 0.3 - bw * 0.15)], 5).reverse();
    fill(dec, [...top, ...bot], st.brow, st.browA * 0.75);
    for (let k = 0; k < 46; k++) {
      const t = p.r();
      const i = Math.min(top.length - 1, Math.floor(t * top.length));
      const [tx, ty] = top[i];
      const [bx, by] = bot[bot.length - 1 - i];
      const f = p.r();
      const x = bx + (tx - bx) * f, y = by + (ty - by) * f;
      const ang = 0.35 + (1 - t) * 0.9; // inner hairs point up, outer ones sweep outward
      stroke(dec, [[x, y], [x + s * Math.cos(ang) * 0.035, y + Math.sin(ang) * 0.03]], 0.006, st.brow, 0.55);
    }
    soft(ht, top, 0.05, W, 0.2);
    // cheek blush + nasolabial fold
    spot(dec, s * 0.46, ey - 0.36, 0.26, '205,95,90', st.blush);
    const nl = smoothPts([[s * 0.16, ny - 0.02], [s * 0.24, (ny + my) / 2 - 0.02], [s * 0.27, my - 0.02]]);
    soft(sh, nl, 0.05, K, st.old ? 0.24 : 0.05);
    soft(ht, nl, 0.04, K, st.old ? 0.5 : 0.25);
    if (st.old) {
      const mar = [[s * 0.26, my - 0.03], [s * 0.3, my - 0.2]] as Pt[];
      soft(sh, mar, 0.04, K, 0.16);
      soft(ht, mar, 0.03, K, 0.35);
    }
    // nose sides + alar crease
    soft(sh, [[s * 0.09, ey + 0.02], [s * 0.1, ny + 0.06]], 0.06, K, 0.08);
    soft(sh, smoothPts([[s * 0.1, ny + 0.03], [s * 0.14, ny - 0.02], [s * 0.11, ny - 0.06]]), 0.03, K, 0.2);
  }

  // soft contouring: cheek hollows, jaw sides and temples a touch darker; forehead, cheekbones and
  // chin catch light (reads as bounce light / subsurface on the simple head)
  for (const s of [1, -1]) {
    soft(sh, smoothPts([[s * 0.82, ey + 0.35], [s * 0.9, ey - 0.2], [s * 0.72, my - 0.25], [s * 0.35, my - 0.5]]), 0.3, K, 0.1);
    spot(sh, s * 0.55, ey - 0.5, 0.18, '0,0,0', 0.06);
    spot(sh, s * 0.5, ey - 0.2, 0.16, '255,255,255', 0.07);
  }
  spot(sh, 0, ey + 0.55, 0.35, '255,255,255', 0.06, 0.6);
  spot(sh, 0, my - 0.32, 0.14, '255,255,255', 0.06);
  // under-nose shadow + philtrum
  spot(sh, 0, ny - 0.07, 0.15, '0,0,0', 0.28, 0.35);
  for (const s of [1, -1]) soft(sh, [[s * 0.035, ny - 0.1], [s * 0.04, my + 0.07]], 0.02, K, 0.07);
  soft(ht, [[0, ny - 0.1], [0, my + 0.07]], 0.05, K, 0.25);

  // lips
  const mw = st.female ? 0.215 : 0.235;
  const f = st.lipFull;
  const L: Pt = [-mw, my + 0.012], R: Pt = [mw, my + 0.012];
  const upperLip = (g: G2) => {
    g.beginPath();
    g.moveTo(L[0], L[1]);
    g.quadraticCurveTo(-0.13, my + 0.05 * f, -0.07, my + 0.074 * f);
    g.quadraticCurveTo(-0.03, my + 0.075 * f, 0, my + 0.058 * f);
    g.quadraticCurveTo(0.03, my + 0.075 * f, 0.07, my + 0.074 * f);
    g.quadraticCurveTo(0.13, my + 0.05 * f, R[0], R[1]);
    g.quadraticCurveTo(0, my - 0.012, L[0], L[1]);
    g.closePath();
  };
  const lowerLip = (g: G2) => {
    g.beginPath();
    g.moveTo(L[0], L[1]);
    g.quadraticCurveTo(0, my - 0.012, R[0], R[1]);
    g.bezierCurveTo(mw * 0.6, my - 0.07 * f, -mw * 0.6, my - 0.07 * f, L[0], L[1]);
    g.closePath();
  };
  dec.globalAlpha = st.lipA;
  dec.fillStyle = st.lip;
  upperLip(dec); dec.fill();
  dec.globalAlpha = st.lipA * 0.85;
  lowerLip(dec); dec.fill();
  dec.globalAlpha = 1;
  sh.globalAlpha = 0.14; sh.fillStyle = K; upperLip(sh); sh.fill(); sh.globalAlpha = 1;
  spot(sh, 0.02, my - 0.035 * f, 0.08, '255,255,255', 0.2, 0.4);
  ht.globalAlpha = 0.3; ht.fillStyle = W; upperLip(ht); ht.fill(); lowerLip(ht); ht.fill(); ht.globalAlpha = 1;
  const parting = smoothPts([L, [-mw * 0.5, my - 0.004], [0, my - 0.008], [mw * 0.5, my - 0.004], R], 4);
  stroke(dec, parting, 0.02, '#35140f', 0.85);
  for (const c of [L, R]) ell(dec, c[0], c[1], 0.012, 0.012, '#3a1814', 0.35);
  stroke(ht, parting, 0.02, K, 0.5);
  soft(sh, smoothPts([[-0.13, my - 0.1 * f], [0, my - 0.115 * f], [0.13, my - 0.1 * f]]), 0.05, K, 0.15);

  if (st.old) {
    // forehead lines
    for (const [dy, a] of [[0.52, 0.16], [0.64, 0.14], [0.76, 0.1]] as const) {
      const pts = wavy(p.r, ey + dy, 0.015, -0.46, 0.46, 10);
      stroke(sh, pts, 0.012, K, a);
      stroke(ht, pts, 0.014, K, 0.4);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// hair, skin, hands
function paintHair(p: Pen): void {
  fill(p.sh, rect(0, -0.1, 1, 1.1), K, 0.12);
  for (let i = 0; i < 70; i++) {
    const x = p.r(), ph = p.r() * TAU;
    const pts: Pt[] = [];
    for (let v = 1.06; v >= -0.07; v -= 0.1) pts.push([x + 0.012 * Math.sin(v * 6 + ph), v]);
    soft(p.ht, pts, 0.016, K, 0.3, 3);
    soft(p.sh, pts, 0.012, K, 0.2, 3);
  }
  for (let i = 0; i < 520; i++) {
    const x = p.r(), ph = p.r() * TAU, v0 = -0.07 + p.r() * 0.5;
    const pts: Pt[] = [];
    for (let v = 1.06; v >= v0; v -= 0.12) pts.push([x + 0.01 * Math.sin(v * 5 + ph), v]);
    const light = p.r() < 0.55;
    const w = 0.002 + p.r() * 0.004, a = 0.08 + p.r() * 0.26;
    stroke(p.sh, pts, w, light ? W : K, a);
    stroke(p.ht, pts, w, light ? W : K, a * 0.7);
  }
  // thinner, darker toward the hairline edge (v = 0) so it melts into the scalp tint
  const lg = p.sh.createLinearGradient(0, 0, 0, 0.12);
  lg.addColorStop(0, 'rgba(0,0,0,0.25)');
  lg.addColorStop(1, 'rgba(0,0,0,0)');
  p.sh.fillStyle = lg;
  p.sh.fillRect(0, -0.1, 1, 0.22);
}

function paintCurly(p: Pen): void {
  fill(p.sh, rect(0, -0.1, 1, 1.1), K, 0.15);
  for (let i = 0; i < 1100; i++) {
    const x = p.r(), y = p.r() * 1.16 - 0.08, rad = 0.007 + p.r() * 0.011;
    const a0 = p.r() * TAU;
    const light = p.r() < 0.5;
    for (const g of [p.sh, p.ht]) {
      g.globalAlpha = g === p.sh ? 0.22 : 0.35;
      g.strokeStyle = light || g === p.ht ? W : K;
      g.lineWidth = 0.0035;
      g.beginPath();
      g.arc(x, y, rad, a0, a0 + 3.8);
      g.stroke();
    }
  }
  for (let i = 0; i < 350; i++) {
    const x = p.r(), y = p.r() * 1.16 - 0.08;
    ell(p.sh, x, y, 0.009, 0.009, K, 0.18);
    ell(p.ht, x, y, 0.009, 0.009, K, 0.3);
  }
  p.dec.globalAlpha = 1;
}

function paintSkin(p: Pen): void {
  for (let i = 0; i < 40; i++) spot(p.sh, p.r(), p.r() * 1.1 - 0.05, 0.03 + p.r() * 0.06, p.r() < 0.5 ? '0,0,0' : '255,255,255', 0.035);
}

function paintHand(p: Pen): void {
  paintSkin(p);
  // finger separations (fingers stacked front→back; see body.ts hands) on both hand faces
  for (const u of [0.167, 0.25, 0.333, 0.667, 0.75, 0.833]) {
    const pts: Pt[] = [[u, -0.05], [u, 0.44]];
    stroke(p.ht, pts, 0.014, K, 0.55);
    stroke(p.sh, pts, 0.01, K, 0.3);
    soft(p.ht, [[u, 0.44], [u, 0.5]], 0.012, K, 0.25);
  }
  for (const c of [0.25, 0.75]) {
    for (const v of [0.18, 0.31, 0.47]) {
      for (const du of [-0.06, 0, 0.06]) {
        const pts: Pt[] = [[c + du - 0.02, v], [c + du + 0.02, v + 0.005]];
        stroke(p.sh, pts, 0.008, K, 0.2);
        stroke(p.ht, pts, 0.008, K, 0.35);
      }
    }
    for (const du of [-0.125, -0.042, 0.042, 0.125]) {
      ell(p.dec, c + du, 0.07, 0.022, 0.045, '#e8c8bc', 0.25);
      ell(p.ht, c + du, 0.07, 0.022, 0.045, W, 0.3);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// torso garments (v over V.torso)
const vt = (yH: number) => (yH - V.torso[0]) / (V.torso[1] - V.torso[0]);

function paintTee(p: Pen): void {
  torsoBase(p);
  // collar ribbing just under the neckline
  const v0 = vt(0.814), v1 = vt(0.832);
  for (let u = 0; u < 1; u += 0.006) stroke(p.ht, [[u, v0 - 0.02], [u, v1 + 0.03]], 0.0025, K, 0.25);
  seam(p, hline(v0 - 0.02), 0.4, 0.005);
  stitch(p, hline(v0 - 0.028));
}

function paintShirt(p: Pen): void {
  torsoBase(p, 0.9);
  // placket + buttons
  for (const du of [-0.014, 0.014]) seam(p, vline(0.5 + du, -0.05, vt(0.83)), 0.4, 0.004);
  stitch(p, vline(0.5 + 0.009, -0.05, vt(0.83)));
  for (let yH = 0.47; yH < 0.81; yH += 0.052) button(p, 0.5, vt(yH), 0.0065);
  // chest pocket on the wearer's left (+X → u > 0.5)
  const pk = [[0.56, vt(0.765)], [0.56, vt(0.695)], [0.595, vt(0.685)], [0.63, vt(0.695)], [0.63, vt(0.765)]] as Pt[];
  seam(p, pk, 0.55, 0.005);
  stitch(p, pk.map(([u, v]) => [u + (u < 0.595 ? 0.004 : u > 0.595 ? -0.004 : 0), v + 0.006] as Pt));
  seam(p, [[0.56, vt(0.755)], [0.63, vt(0.755)]], 0.3, 0.004);
  fill(p.sh, pk, K, 0.04);
  // back yoke
  for (const s of [[-0.02, 0.22], [0.78, 1.02]] as const) { seam(p, hline(vt(0.8), s[0], s[1]), 0.45); stitch(p, hline(vt(0.795), s[0], s[1])); }
  for (let i = 0; i < 3; i++) fold(p, wavy(p.r, vt(0.49 + i * 0.025), 0.01), 0.02, 0.12);
}

function paintPolo(p: Pen): void {
  paintTee(p);
  const pk = rect(0.488, vt(0.75), 0.512, vt(0.83));
  seam(p, pk, 0.5, 0.004);
  stitch(p, rect(0.491, vt(0.753), 0.509, vt(0.83)));
  for (const yH of [0.775, 0.805]) button(p, 0.5, vt(yH), 0.0055);
}

function ribs(p: Pen, v0: number, v1: number, step = 0.008, a = 0.35): void {
  for (let u = 0; u < 1; u += step) stroke(p.ht, [[u, v0], [u, v1]], step * 0.45, K, a);
  seam(p, hline(v1), 0.35, 0.004);
}

function paintKnit(p: Pen): void {
  torsoBase(p, 0.7);
  ribs(p, vt(0.505), vt(0.54));
  ribs(p, vt(0.8), vt(0.835));
}

function paintHoodie(p: Pen): void {
  torsoBase(p, 0.8);
  ribs(p, vt(0.505), vt(0.53), 0.007, 0.3);
  // kangaroo pocket with hand openings
  const top = vt(0.605), bot = vt(0.535);
  const outline: Pt[] = [[0.36, bot], [0.64, bot], [0.64, vt(0.565)], [0.605, top], [0.395, top], [0.36, vt(0.565)], [0.36, bot]];
  seam(p, outline, 0.55, 0.006);
  stitch(p, outline.map(([u, v]) => [0.5 + (u - 0.5) * 0.97, v + (v < 0.5 * (top + bot) ? 0.006 : -0.006)] as Pt));
  for (const pts of [[[0.36, vt(0.565)], [0.395, top]], [[0.64, vt(0.565)], [0.605, top]]] as Pt[][]) { soft(p.sh, pts, 0.012, K, 0.35); stroke(p.ht, pts, 0.008, K, 0.6); }
  fill(p.ht, outline, W, 0.12);
  // drawstrings from the hood opening
  for (const [u0, u1] of [[0.47, 0.465], [0.53, 0.536]]) {
    const pts = smoothPts([[u0, vt(0.83)], [u0 + (u1 - u0) * 0.5, vt(0.79)], [u1, vt(0.74)]]);
    stroke(p.dec, pts, 0.008, '#ebe7e0', 0.95);
    stroke(p.ht, pts, 0.01, W, 0.4);
    stroke(p.dec, [pts[pts.length - 1], [u1, vt(0.73)]], 0.009, '#9a9690', 0.95);
  }
}

function paintBlouse(p: Pen): void {
  torsoBase(p, 0.6);
  for (let i = 0; i < 10; i++) {
    const u = 0.38 + (i / 9) * 0.24;
    fold(p, [[u, vt(0.81)], [0.5 + (u - 0.5) * 1.5, vt(0.62)]], 0.02, 0.1);
  }
  for (const s of [1, -1]) fold(p, [[0.5 + s * 0.085, vt(0.62)], [0.5 + s * 0.075, vt(0.69)]], 0.012, 0.25);
  for (let yH = 0.62; yH < 0.8; yH += 0.045) button(p, 0.5, vt(yH), 0.0045);
  seam(p, vline(0.5, -0.05, vt(0.81)), 0.25, 0.004);
}

function paintSuit(p: Pen): void {
  torsoBase(p, 0.6);
  seam(p, vline(0, -0.05, vt(0.8)), 0.5); // centre back (the wrap passes repeat it at u = 1)
  soft(p.sh, [[0, -0.05], [0, vt(0.52)]], 0.012, K, 0.5); // back vent
  for (const s of [1, -1]) fold(p, [[0.5 + s * 0.1, vt(0.5)], [0.5 + s * 0.11, vt(0.68)]], 0.012, 0.3); // front darts
  // flap pockets at the hips
  for (const [u0, u1] of [[0.34, 0.44], [0.56, 0.66]]) {
    const v0 = vt(0.513), v1 = vt(0.532);
    seam(p, [[u0, v1], [u1, v1]], 0.6, 0.006);
    seam(p, [[u0, v1], [u0, v0], [u1, v0], [u1, v1]], 0.4, 0.004);
    soft(p.sh, [[u0, v0 - 0.006], [u1, v0 - 0.006]], 0.014, K, 0.3);
  }
  // breast welt on the wearer's left
  seam(p, [[0.6, vt(0.735)], [0.66, vt(0.74)]], 0.6, 0.006);
  for (const yH of [0.555, 0.61]) button(p, 0.535, vt(yH), 0.0085, '#1a1714');
  fold(p, wavy(p.r, vt(0.6), 0.01), 0.02, 0.1);
}

function paintLeather(p: Pen): void {
  torsoBase(p, 0.5);
  // creases: leather wrinkles in clusters
  for (let i = 0; i < 70; i++) {
    const u = p.r(), v = p.r() * 1.05;
    const len = 0.02 + p.r() * 0.05, a = (p.r() - 0.5) * 0.8;
    const pts: Pt[] = [[u, v], [u + Math.cos(a) * len, v + Math.sin(a) * len]];
    stroke(p.ht, pts, 0.005, K, 0.25);
    stroke(p.sh, pts, 0.004, K, 0.07);
  }
  for (const u of [0.4, 0.6, 0.1, 0.9]) { seam(p, vline(u, vt(0.53), vt(0.79)), 0.5); stitch(p, vline(u + 0.008, vt(0.53), vt(0.79))); }
  seam(p, hline(vt(0.79)), 0.5); stitch(p, hline(vt(0.785)));
  ribs(p, vt(0.535), vt(0.555), 0.03, 0.2);
  stitch(p, hline(vt(0.545)));
  zip(p, vline(0.528, -0.05, vt(0.83)));
  for (const s of [1, -1]) zip(p, [[0.5 + s * 0.14, vt(0.58)], [0.5 + s * 0.09, vt(0.67)]]);
}

function paintBomber(p: Pen): void {
  torsoBase(p, 0.4);
  for (let i = 0; i < 9; i++) puff(p, wavy(p.r, vt(0.57 + i * 0.03), 0.008), 0.03, 0.2);
  ribs(p, vt(0.535), vt(0.565), 0.006, 0.4);
  ribs(p, vt(0.815), vt(0.835), 0.006, 0.4);
  zip(p, vline(0.5, -0.05, vt(0.83)));
  for (const s of [1, -1]) seam(p, [[0.5 + s * 0.15, vt(0.58)], [0.5 + s * 0.12, vt(0.66)]], 0.65, 0.008);
}

function paintDenimJacket(p: Pen): void {
  torsoBase(p, 0.6);
  const gold = '#c0934e';
  for (const s of [1, -1]) {
    const c = 0.5 + s * 0.09;
    const flap: Pt[] = [[c - 0.04, vt(0.75)], [c + 0.04, vt(0.75)], [c + 0.04, vt(0.725)], [c, vt(0.715)], [c - 0.04, vt(0.725)], [c - 0.04, vt(0.75)]];
    seam(p, flap, 0.6, 0.005);
    stitch(p, flap.map(([u, v]) => [c + (u - c) * 0.85, v + (v > vt(0.74) ? -0.006 : 0.004)] as Pt), gold);
    button(p, c, vt(0.722), 0.007, '#7a4e28');
    seam(p, rect(c - 0.04, vt(0.67), c + 0.04, vt(0.75)), 0.3, 0.004);
    seam(p, vline(c, -0.05, vt(0.715)), 0.4);
    stitch(p, vline(c + 0.008, -0.05, vt(0.715)), gold);
    stitch(p, vline(c - 0.008, -0.05, vt(0.715)), gold);
  }
  seam(p, hline(vt(0.775)), 0.55);
  stitch(p, hline(vt(0.768)), gold);
  ribs(p, vt(0.535), vt(0.56), 0.05, 0.15);
  stitch(p, hline(vt(0.558)), gold);
  stitch(p, hline(vt(0.54)), gold);
  for (let yH = 0.55; yH < 0.8; yH += 0.055) button(p, 0.532, vt(yH), 0.007, '#7a4e28');
}

function paintCardigan(p: Pen): void {
  torsoBase(p, 0.6);
  ribs(p, vt(0.5), vt(0.53), 0.007, 0.35);
  seam(p, vline(0.522, -0.05, vt(0.82)), 0.4);
  for (let yH = 0.52; yH < 0.78; yH += 0.05) button(p, 0.532, vt(yH), 0.0065);
}

function paintRobe(p: Pen): void {
  // jebba: fine vertical drape + passementerie braid down the front and around the V neckline
  for (let i = 0; i < 14; i++) fold(p, [[i / 14 + p.r() * 0.02, -0.05], [i / 14 + p.r() * 0.02, 1.05]], 0.025, 0.1);
  // passementerie: a silk cord band (tone-on-tone gold) with a twisted pattern and edge cords
  const braid = (pts: readonly Pt[]) => {
    stroke(p.dec, pts, 0.024, '#cdb582', 0.7);
    stroke(p.dec, pts, 0.012, '#a88c58', 0.8, [0.005, 0.005]);
    for (const d of [-0.012, 0.012]) stroke(p.dec, pts.map(([u, v]) => [u + d, v] as Pt), 0.003, '#8e7444', 0.9);
    stroke(p.ht, pts, 0.026, W, 0.4);
    stroke(p.ht, pts, 0.012, K, 0.3, [0.005, 0.005]);
    for (const d of [-0.012, 0.012]) stroke(p.ht, pts.map(([u, v]) => [u + d, v] as Pt), 0.004, K, 0.5);
  };
  braid(vline(0.5, -0.05, vt(0.775)));
  const vb = vt(0.77), vtop = vt(0.84);
  braid([[0.415, vtop], [0.5, vb], [0.585, vtop]]);
  for (let yH = 0.62; yH < 0.77; yH += 0.03) button(p, 0.5, vt(yH), 0.005, '#d7c79f');
}

// ---------------------------------------------------------------------------------------------
// skirts / dresses, headscarf
function paintSkirt(p: Pen): void {
  const n = 16;
  for (let i = 0; i < n; i++) {
    const u = (i + 0.3 * p.r()) / n;
    const lean = (p.r() - 0.5) * 0.02;
    const pts: Pt[] = [[u + lean, -0.05], [u + lean * 0.5, 0.4], [u, 0.95]];
    const w = 0.05 + 0.03 * p.r();
    fold(p, pts, w, 0.28);
    puff(p, pts.map(([x, y]) => [x + 0.5 / n, y] as Pt), w * 0.8, 0.2);
  }
}

function paintHijab(p: Pen): void {
  // folds that follow the face opening (v ≈ 0) and fall away toward the back / down the drape
  for (let i = 0; i < 7; i++) fold(p, wavy(p.r, 0.05 + i * 0.05 + p.r() * 0.02, 0.015), 0.05, 0.18);
  for (let i = 0; i < 14; i++) {
    const u = p.r();
    fold(p, [[u, 0.3], [u + (p.r() - 0.5) * 0.12, 1.05]], 0.05, 0.14);
  }
  seam(p, hline(0.012), 0.35, 0.006);
}

// ---------------------------------------------------------------------------------------------
// trousers (legs: v over V.leg; hips: waist at HIPS_WAIST)
const vl = (yH: number) => (yH - V.leg[0]) / (V.leg[1] - V.leg[0]);
const vh = (dyH: number) => HIPS_WAIST + dyH / V.hipsSpan; // dyH = height above the waist line, in H

function paintJeansLeg(p: Pen): void {
  const gold = '#c4955a';
  for (const u of [0.25, 0.75]) {
    seam(p, vline(u), 0.55, 0.007);
    for (const d of [-0.012, 0.012]) stitch(p, vline(u + d), gold, 0.6);
  }
  // faded front of the thighs and knees, darker at the seams
  for (let i = 0; i < 3; i++) soft(p.sh, [[0.5, vl(0.3)], [0.5, vl(0.5)]], 0.3 - i * 0.07, W, 0.05);
  soft(p.sh, [[0.5, vl(0.24)], [0.5, vl(0.3)]], 0.22, W, 0.06);
  for (const u of [0.25, 0.75]) soft(p.sh, vline(u), 0.08, K, 0.12);
  // knee whiskers (front) and honeycombs (back)
  for (let i = 0; i < 4; i++) {
    const v = vl(0.265 + i * 0.014 + p.r() * 0.005), u = 0.5 + (p.r() - 0.5) * 0.04;
    const pts = smoothPts([[u - 0.07, v - 0.004], [u, v + 0.006], [u + 0.07, v - 0.004]]);
    puff(p, pts, 0.02, 0.2);
    soft(p.ht, pts.map(([x, y]) => [x, y - 0.01] as Pt), 0.014, K, 0.25);
  }
  for (let i = 0; i < 4; i++) fold(p, wavy(p.r, vl(0.27 + i * 0.012), 0.004, -0.08, 0.08, 4), 0.012, 0.35);
  // stacking at the ankle
  for (let i = 0; i < 4; i++) fold(p, wavy(p.r, vl(0.045 + i * 0.022), 0.012), 0.02, 0.3);
}

function paintTrouserLeg(p: Pen): void {
  for (const u of [0.25, 0.75]) seam(p, vline(u), 0.4, 0.005);
  for (const u of [0.5, 0]) ridge(p, vline(u), 0.3, 0.008); // pressed creases front and back
  for (let i = 0; i < 3; i++) fold(p, wavy(p.r, vl(0.05 + i * 0.03), 0.01), 0.025, 0.22);
  for (let i = 0; i < 3; i++) fold(p, wavy(p.r, vl(0.27 + i * 0.015), 0.005, 0.35, 0.65, 4), 0.012, 0.15);
}

function hipsCommon(p: Pen, jeans: boolean): void {
  const gold = jeans ? '#c4955a' : undefined;
  const wb0 = vh(-0.022), wb1 = vh(0.0);
  seam(p, hline(wb0), 0.55, 0.006);
  if (jeans) { stitch(p, hline(wb0 + 0.012), gold); stitch(p, hline(wb1 - 0.012), gold); }
  for (const u of [0.07, 0.3, 0.7, 0.93, 0]) { // belt loops
    const pts: Pt[] = [[u, wb0 - 0.02], [u, wb1 + 0.01]];
    ridge(p, pts, 0.5, 0.012);
    soft(p.sh, pts.map(([x, y]) => [x + 0.008, y] as Pt), 0.01, K, 0.2);
  }
  // fly
  const fly = smoothPts([[0.53, wb0], [0.53, vh(-0.085)], [0.515, vh(-0.1)], [0.5, vh(-0.105)]], 4);
  seam(p, [[0.5, wb0], [0.5, vh(-0.105)]], 0.45, 0.005);
  stitch(p, fly, gold);
  soft(p.sh, [[0.5, vh(-0.06)], [0.5, vh(-0.14)]], 0.02, K, 0.25);
  // crotch whiskers
  if (jeans) {
    for (const s of [1, -1]) {
      for (let i = 0; i < 4; i++) {
        const pts: Pt[] = [[0.5 + s * 0.02, vh(-0.105 - i * 0.012)], [0.5 + s * (0.1 + i * 0.015), vh(-0.07 - i * 0.02)]];
        puff(p, pts, 0.012, 0.12);
      }
    }
  }
}

function paintJeansHips(p: Pen): void {
  const gold = '#c4955a';
  hipsCommon(p, true);
  for (const s of [1, -1]) {
    const pocket = smoothPts([[0.5 + s * 0.085, vh(-0.022)], [0.5 + s * 0.1, vh(-0.05)], [0.5 + s * 0.14, vh(-0.07)], [0.5 + s * 0.18, vh(-0.075)]], 5);
    seam(p, pocket, 0.6, 0.007);
    stitch(p, pocket.map(([u, v]) => [u + s * 0.008, v - 0.01] as Pt), gold);
    ell(p.dec, 0.5 + s * 0.18, vh(-0.074), 0.006, 0.012, '#9a6a38', 0.9); // rivet
    // back pockets (around u = 0 / 1)
    const c = s > 0 ? 0.87 : 0.13;
    const bp: Pt[] = [[c - 0.06, vh(-0.045)], [c + 0.06, vh(-0.045)], [c + 0.055, vh(-0.13)], [c, vh(-0.15)], [c - 0.055, vh(-0.13)], [c - 0.06, vh(-0.045)]];
    seam(p, bp, 0.55, 0.006);
    stitch(p, bp.map(([u, v]) => [c + (u - c) * 0.9, v - 0.006] as Pt), gold);
    stitch(p, smoothPts([[c - 0.04, vh(-0.1)], [c, vh(-0.08)], [c + 0.04, vh(-0.1)]]), gold);
    fill(p.ht, bp, W, 0.1);
  }
  // back yoke
  const yoke: Pt[] = [[0.2, vh(-0.03)], [0, vh(-0.055)]];
  for (const pts of [yoke, mirror(yoke)]) { seam(p, pts, 0.5); stitch(p, pts.map(([u, v]) => [u, v - 0.01] as Pt), gold); }
}

function paintTrouserHips(p: Pen): void {
  hipsCommon(p, false);
  for (const s of [1, -1]) {
    seam(p, [[0.5 + s * 0.14, vh(-0.022)], [0.5 + s * 0.2, vh(-0.12)]], 0.6, 0.007);
    fold(p, [[0.5 + s * 0.06, vh(-0.022)], [0.5 + s * 0.065, vh(-0.09)]], 0.012, 0.25); // pleat
    const c = s > 0 ? 0.87 : 0.13;
    seam(p, [[c - 0.05, vh(-0.06)], [c + 0.05, vh(-0.06)]], 0.65, 0.006);
    button(p, c, vh(-0.048), 0.006);
  }
}

// ---------------------------------------------------------------------------------------------
// sleeves, shoes, bags
const vs = (yH: number) => (yH - V.sleeve[0]) / (V.sleeve[1] - V.sleeve[0]);

function paintSleeve(p: Pen): void {
  for (const u of [0.25, 0.75]) seam(p, vline(u), 0.3, 0.005);
  seam(p, hline(vs(0.8)), 0.4, 0.006);
  // inner-elbow folds (front, u = 0.5) and bunching behind the elbow
  for (let i = 0; i < 5; i++) {
    const v = vs(0.6 + (i - 2) * 0.012), w = 0.1 - Math.abs(i - 2) * 0.02;
    fold(p, smoothPts([[0.5 - w, v + 0.01], [0.5, v - 0.012], [0.5 + w, v + 0.01]]), 0.018, 0.3);
  }
  for (let i = 0; i < 3; i++) fold(p, wavy(p.r, vs(0.61 + (i - 1) * 0.02), 0.01, -0.12, 0.12, 4), 0.015, 0.2);
  for (let i = 0; i < 4; i++) fold(p, [[0.35 + p.r() * 0.3, vs(0.7)], [0.35 + p.r() * 0.3, vs(0.78)]], 0.02, 0.1);
  // cuff
  seam(p, hline(vs(0.5)), 0.4, 0.006);
  stitch(p, hline(vs(0.497)));
  for (let i = 0; i < 3; i++) fold(p, wavy(p.r, vs(0.52 + i * 0.015), 0.01), 0.015, 0.18);
}

function lacing(p: Pen, v0: number, v1: number, half: number, pairs: number, laceCol: string | null): void {
  const eye: Pt[][] = [[], []];
  for (let i = 0; i < pairs; i++) {
    const v = v0 + ((v1 - v0) * i) / (pairs - 1);
    const hw = half * (1 - 0.25 * (i / (pairs - 1)));
    eye[0].push([0.5 - hw, v]);
    eye[1].push([0.5 + hw, v]);
  }
  const edge = (s: 0 | 1) => [...eye[s].map(([u, v]) => [u + (s ? 0.012 : -0.012), v] as Pt)];
  for (const s of [0, 1] as const) { seam(p, edge(s), 0.55, 0.006); stitch(p, edge(s).map(([u, v]) => [u + (s ? 0.01 : -0.01), v] as Pt)); }
  fill(p.sh, [...edge(0), ...edge(1).reverse()], K, 0.1);
  for (let i = 0; i < pairs; i++) {
    for (const s of [0, 1]) { ell(p.dec, eye[s][i][0], eye[s][i][1], 0.007, 0.007, '#1c1a18', 0.8); ell(p.ht, eye[s][i][0], eye[s][i][1], 0.008, 0.008, K, 0.6); }
    if (i < pairs - 1) {
      for (const [a, b] of [[eye[0][i], eye[1][i + 1]], [eye[1][i], eye[0][i + 1]]] as [Pt, Pt][]) {
        if (laceCol) stroke(p.dec, [a, b], 0.011, laceCol, 0.95);
        else stroke(p.sh, [a, b], 0.011, K, 0.35);
        stroke(p.ht, [a, b], 0.012, W, 0.6);
      }
    }
  }
}

function paintSneaker(p: Pen): void {
  lacing(p, 0.38, 0.7, 0.07, 5, '#eeebe5');
  const toe = smoothPts([[0.3, 0.72], [0.4, 0.8], [0.5, 0.82], [0.6, 0.8], [0.7, 0.72]]);
  seam(p, toe, 0.5, 0.006); stitch(p, toe.map(([u, v]) => [u, v - 0.012] as Pt));
  for (const s of [1, -1]) {
    const side = smoothPts([[0.5 + s * 0.32, 0.12], [0.5 + s * 0.24, 0.35], [0.5 + s * 0.12, 0.62]]);
    seam(p, side, 0.45, 0.006); stitch(p, side.map(([u, v]) => [u + s * 0.012, v] as Pt));
    for (let i = 0; i < 5; i++) ell(p.ht, 0.5 + s * (0.18 + i * 0.018), 0.84 + (i % 2) * 0.02, 0.005, 0.005, K, 0.4); // toe-box perforations
  }
  seam(p, hline(0.18, 0.28, 0.72), 0.45); stitch(p, hline(0.17, 0.28, 0.72));
  fill(p.ht, rect(0.47, -0.05, 0.53, 0.06), W, 0.3);
  for (const u of [0.1, 0.9]) seam(p, vline(u), 0.3, 0.008); // sole join
}

function paintShoe(p: Pen): void {
  lacing(p, 0.44, 0.64, 0.045, 4, null);
  const cap = smoothPts([[0.34, 0.74], [0.42, 0.79], [0.5, 0.8], [0.58, 0.79], [0.66, 0.74]]);
  seam(p, cap, 0.55, 0.006);
  for (let i = 0; i < cap.length; i += 2) ell(p.sh, cap[i][0], cap[i][1] - 0.014, 0.004, 0.004, K, 0.4); // broguing
  for (const u of [0.12, 0.88]) { seam(p, vline(u), 0.3); stitch(p, vline(u + (u < 0.5 ? 0.015 : -0.015))); }
  seam(p, [[0.5, -0.05], [0.5, 0.1]], 0.4);
  spot(p.sh, 0.5, 0.88, 0.1, '255,255,255', 0.14);
  spot(p.sh, 0.5, 0.08, 0.08, '255,255,255', 0.1);
}

function paintBag(p: Pen): void {
  // backpack: its visible outer face is u ≈ 0 / 1 (the loft's front faces the wearer's back)
  zip(p, hline(0.84), '#6c6c70');
  // front pocket centred on the seam (the wrap passes complete it on the other edge)
  const pk = rect(-0.13, 0.12, 0.13, 0.5);
  seam(p, pk, 0.55, 0.007);
  stitch(p, rect(-0.12, 0.13, 0.12, 0.49));
  zip(p, [[-0.11, 0.46], [0.11, 0.46]], '#6c6c70');
  fill(p.ht, pk, W, 0.15);
  for (const u of [0.25, 0.75]) { seam(p, vline(u), 0.5, 0.008); stitch(p, vline(u + 0.012)); }
}

// ---------------------------------------------------------------------------------------------
type MicroKind = 'none' | 'skin' | 'cotton' | 'twill' | 'denim' | 'knit' | 'wool' | 'leather' | 'nylon';
interface CellSpec { paint: (p: Pen) => void; wrap: boolean; decal?: boolean; micro: MicroKind; bump: number }
const face = (id: number): CellSpec => ({ paint: (p) => paintFace(p, FACES[id]), wrap: false, decal: true, micro: 'skin', bump: 0.7 });
const SPECS: Record<CellId, CellSpec> = {
  [CELL.faceM]: face(CELL.faceM), [CELL.faceF]: face(CELL.faceF), [CELL.faceOldM]: face(CELL.faceOldM),
  [CELL.faceOldF]: face(CELL.faceOldF), [CELL.faceM2]: face(CELL.faceM2), [CELL.faceF2]: face(CELL.faceF2),
  [CELL.hair]: { paint: paintHair, wrap: true, micro: 'none', bump: 1.1 },
  [CELL.hairCurly]: { paint: paintCurly, wrap: true, micro: 'none', bump: 1.2 },
  [CELL.skin]: { paint: paintSkin, wrap: true, micro: 'skin', bump: 0.5 },
  [CELL.hand]: { paint: paintHand, wrap: true, decal: true, micro: 'skin', bump: 0.8 },
  [CELL.tee]: { paint: paintTee, wrap: true, micro: 'cotton', bump: 1 },
  [CELL.shirt]: { paint: paintShirt, wrap: true, micro: 'cotton', bump: 1 },
  [CELL.polo]: { paint: paintPolo, wrap: true, micro: 'knit', bump: 1 },
  [CELL.knit]: { paint: paintKnit, wrap: true, micro: 'knit', bump: 1.2 },
  [CELL.hoodie]: { paint: paintHoodie, wrap: true, decal: true, micro: 'cotton', bump: 1 },
  [CELL.blouse]: { paint: paintBlouse, wrap: true, micro: 'cotton', bump: 0.8 },
  [CELL.suit]: { paint: paintSuit, wrap: true, decal: true, micro: 'wool', bump: 0.9 },
  [CELL.leather]: { paint: paintLeather, wrap: true, decal: true, micro: 'leather', bump: 1 },
  [CELL.bomber]: { paint: paintBomber, wrap: true, decal: true, micro: 'nylon', bump: 1 },
  [CELL.denimJk]: { paint: paintDenimJacket, wrap: true, decal: true, micro: 'denim', bump: 1 },
  [CELL.cardigan]: { paint: paintCardigan, wrap: true, micro: 'knit', bump: 1.1 },
  [CELL.robe]: { paint: paintRobe, wrap: true, decal: true, micro: 'wool', bump: 0.9 },
  [CELL.skirt]: { paint: paintSkirt, wrap: true, micro: 'cotton', bump: 1 },
  [CELL.hijab]: { paint: paintHijab, wrap: true, micro: 'cotton', bump: 0.9 },
  [CELL.jeansLeg]: { paint: paintJeansLeg, wrap: true, decal: true, micro: 'denim', bump: 1 },
  [CELL.trouserLeg]: { paint: paintTrouserLeg, wrap: true, micro: 'wool', bump: 1 },
  [CELL.jeansHips]: { paint: paintJeansHips, wrap: true, decal: true, micro: 'denim', bump: 1 },
  [CELL.trouserHips]: { paint: paintTrouserHips, wrap: true, micro: 'wool', bump: 1 },
  [CELL.sleeve]: { paint: paintSleeve, wrap: true, micro: 'cotton', bump: 1 },
  [CELL.sneaker]: { paint: paintSneaker, wrap: false, decal: true, micro: 'cotton', bump: 1 },
  [CELL.shoe]: { paint: paintShoe, wrap: false, decal: true, micro: 'leather', bump: 0.9 },
  [CELL.bag]: { paint: paintBag, wrap: true, decal: true, micro: 'nylon', bump: 1 },
};

/** Integer-hash value noise on a unit lattice (smooth between lattice points), −0.5..0.5. */
function ihash(x: number, y: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = ihash(ix, iy), b = ihash(ix + 1, iy), c = ihash(ix, iy + 1), d = ihash(ix + 1, iy + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy - 0.5;
}
/** One cell-sized tile of value noise at a lattice period (px); sampled per atlas pixel. Tiles
 *  repeat per cell, which is invisible because every cell dresses a different garment. */
function noiseTile(cs: number, period: number, ox: number): Float32Array {
  const t = new Float32Array(cs * cs);
  for (let y = 0; y < cs; y++) for (let x = 0; x < cs; x++) t[y * cs + x] = vnoise(x / period + ox, y / period + ox * 0.7);
  return t;
}

/** Micro relief (height delta ≈ −1..1) from precomputed noise: fine grain, mid-scale lumps. */
function micro(kind: MicroKind, u: number, v: number, fine: number, mid: number, f: number): number {
  switch (kind) {
    case 'none': return 0;
    case 'skin': return fine * 0.35 + mid * 0.3;
    case 'cotton': return fine * 0.45 + mid * 0.35;
    case 'twill': return Math.sin(TAU * (u + v) * Math.round(70 * f)) * 0.3 + fine * 0.3;
    case 'denim': return Math.sin(TAU * (u + v * 0.6) * Math.round(90 * f)) * 0.4 + fine * 0.5 + mid * 0.3;
    case 'knit': return Math.sin(TAU * u * Math.round(110 * f)) * 0.4 + fine * 0.3;
    case 'wool': return Math.sin(TAU * (u - v) * Math.round(80 * f)) * 0.12 + fine * 0.35 + mid * 0.25;
    case 'leather': return fine * 0.25 + mid * 1.1;
    case 'nylon': return mid * 0.3;
  }
}
/** Low-frequency dye / wear mottling of the albedo shade, per material kind. */
const MOTTLE: Record<MicroKind, number> = { none: 0.05, skin: 0.05, cotton: 0.06, twill: 0.06, denim: 0.14, knit: 0.06, wool: 0.05, leather: 0.12, nylon: 0.05 };

export interface PeopleAtlas {
  /** sRGB decal colour + coverage (material.map). */
  decal: DataTexture;
  /** Linear normal (RGB) + shade multiplier (A) (material.normalMap). */
  detail: DataTexture;
  dispose(): void;
}

/** Faces are chosen per person from these. */
export const FACE_CELLS = { male: [CELL.faceM, CELL.faceM2], female: [CELL.faceF, CELL.faceF2], oldMale: CELL.faceOldM, oldFemale: CELL.faceOldF } as const;

export function createAtlas(quality: Quality, renderer: WebGLRenderer): PeopleAtlas {
  const cs = quality === 'low' || quality === 'medium' ? 128 : 256;
  const AW = cs * COLS, AH = cs * ROWS;
  const gp = Math.round(GUT * cs), cw = cs - 2 * gp;
  const mk = (): G2 => {
    const c = document.createElement('canvas');
    c.width = AW;
    c.height = AH;
    const g = c.getContext('2d', { willReadFrequently: true });
    if (!g) throw new Error('people atlas: 2D canvas unavailable');
    return g;
  };
  const dec = mk(), sh = mk(), ht = mk();
  for (const g of [sh, ht]) { g.fillStyle = 'rgb(128,128,128)'; g.fillRect(0, 0, AW, AH); }

  for (const [key, spec] of Object.entries(SPECS)) {
    const cell = Number(key);
    const ox = (cell % COLS) * cs, oy = Math.floor(cell / COLS) * cs;
    for (const du of spec.wrap ? [-1, 0, 1] : [0]) {
      for (const g of [dec, sh, ht]) {
        g.save();
        g.beginPath();
        g.rect(ox, oy, cs, cs);
        g.clip();
        g.setTransform(cw, 0, 0, -cw, ox + gp, oy + gp + cw); // UV space, v up
        g.translate(du, 0);
      }
      spec.paint({ dec, sh, ht, r: rng(cell * 7919 + 17) }); // same seed per pass → seamless wrap
      for (const g of [dec, sh, ht]) g.restore();
    }
  }

  const dImg = dec.getImageData(0, 0, AW, AH).data;
  const sImg = sh.getImageData(0, 0, AW, AH).data;
  const hImg = ht.getImageData(0, 0, AW, AH).data;
  const f = cs / 256;
  const nFine = noiseTile(cs, 1.6 * f, 0), nMid = noiseTile(cs, 7 * f, 31), nLow = noiseTile(cs, 22 * f, 5), nVeryLow = noiseTile(cs, 64 * f, 11);
  // height (with micro relief) and shade, both in texture order (row 0 = v 0 = canvas bottom)
  const hgt = new Float32Array(AW * AH), shade = new Float32Array(AW * AH);
  for (let y = 0; y < AH; y++) {
    const ty = (AH - 1 - y) * AW, row = Math.floor(y / cs) * COLS, ny = (y % cs) * cs;
    const v = 1 - ((y % cs) - gp) / cw;
    for (let x = 0; x < AW; x++) {
      const spec = SPECS[(row + Math.floor(x / cs)) as CellId];
      const ci = (y * AW + x) * 4, ni = ny + (x % cs);
      const u = ((x % cs) - gp) / cw;
      hgt[ty + x] = hImg[ci] / 255 + micro(spec.micro, u, v, nFine[ni], nMid[ni], f) * 0.035;
      shade[ty + x] = sImg[ci] * (1 + MOTTLE[spec.micro] * (nLow[ni] + 0.5 * nVeryLow[ni]));
    }
  }
  // light blur so painted strokes read as soft seams and folds rather than scratches
  const tmp = new Float32Array(AW * AH);
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < AH; y++) {
      const r0 = y * AW;
      tmp[r0] = hgt[r0]; tmp[r0 + AW - 1] = hgt[r0 + AW - 1];
      for (let x = 1; x < AW - 1; x++) tmp[r0 + x] = (hgt[r0 + x - 1] + 2 * hgt[r0 + x] + hgt[r0 + x + 1]) * 0.25;
    }
    for (let y = 1; y < AH - 1; y++) {
      const r0 = y * AW;
      for (let x = 0; x < AW; x++) hgt[r0 + x] = (tmp[r0 + x - AW] + 2 * tmp[r0 + x] + tmp[r0 + x + AW]) * 0.25;
    }
  }
  const decal = new Uint8Array(AW * AH * 4);
  const detail = new Uint8Array(AW * AH * 4);
  const bump = new Float32Array(COLS * ROWS);
  for (const [key, spec] of Object.entries(SPECS)) bump[Number(key)] = 6 * f * spec.bump;
  for (let y = 0; y < AH; y++) {
    const cy = AH - 1 - y; // canvas row
    const yd = y > 0 ? y - 1 : y, yu = y < AH - 1 ? y + 1 : y, row = Math.floor(cy / cs) * COLS;
    for (let x = 0; x < AW; x++) {
      const i = y * AW + x, ci = (cy * AW + x) * 4, o = i * 4; // i: texture order, ci: canvas order
      decal[o] = dImg[ci]; decal[o + 1] = dImg[ci + 1]; decal[o + 2] = dImg[ci + 2]; decal[o + 3] = dImg[ci + 3];
      const k = bump[row + Math.floor(x / cs)];
      const dx = (hgt[i + (x < AW - 1 ? 1 : 0)] - hgt[i - (x > 0 ? 1 : 0)]) * k, dy = (hgt[yu * AW + x] - hgt[yd * AW + x]) * k;
      const l = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      detail[o] = (-dx * l * 127.5 + 128) | 0;
      detail[o + 1] = (-dy * l * 127.5 + 128) | 0;
      detail[o + 2] = (l * 127.5 + 128) | 0;
      const sv = shade[i] + 0.5;
      detail[o + 3] = sv < 0 ? 0 : sv > 255 ? 255 : sv | 0;
    }
  }
  // bleed decal colours into transparent texels (no dark fringes under filtering / mips)
  const nb = [-4, 4, -AW * 4, AW * 4];
  for (const [key, spec] of Object.entries(SPECS)) {
    if (!spec.decal) continue;
    const cell = Number(key);
    const x0 = (cell % COLS) * cs, y0 = (ROWS - 1 - Math.floor(cell / COLS)) * cs;
    for (let pass = 0; pass < 3; pass++) {
      for (let y = y0 + 1; y < y0 + cs - 1; y++) {
        for (let x = x0 + 1; x < x0 + cs - 1; x++) {
          const o = (y * AW + x) * 4;
          if (decal[o + 3] > 8) continue;
          let r = 0, g = 0, b = 0, n = 0;
          for (let k = 0; k < 4; k++) {
            const q = o + nb[k];
            if (decal[q + 3] > 8 || (decal[q] | decal[q + 1] | decal[q + 2]) > 0) { r += decal[q]; g += decal[q + 1]; b += decal[q + 2]; n++; }
          }
          if (n) { decal[o] = r / n; decal[o + 1] = g / n; decal[o + 2] = b / n; }
        }
      }
    }
  }

  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const tex = (data: Uint8Array, srgb: boolean) => {
    const t = new DataTexture(data, AW, AH, RGBAFormat, UnsignedByteType);
    t.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
    t.generateMipmaps = true;
    t.minFilter = LinearMipmapLinearFilter;
    t.magFilter = LinearFilter;
    t.anisotropy = aniso;
    t.needsUpdate = true;
    return t;
  };
  const decalTex = tex(decal, true), detailTex = tex(detail, false);
  decalTex.name = 'people-decal';
  detailTex.name = 'people-detail';
  return { decal: decalTex, detail: detailTex, dispose: () => { decalTex.dispose(); detailTex.dispose(); } };
}
