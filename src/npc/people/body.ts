// Builds one person's skinned geometry from Traits: body lofts dressed in garment "layers"
// (the outermost layer at a height decides colour, thickness and atlas cell; layer changes become
// hem ledges), a parametric head (./head.ts) with a painted face, conforming hair / hijab / beard
// shells and accessories. Everything is in model space, rest pose (arms down, feet at y = 0,
// facing +Z, character's left = +X). Texture detail lives in the shared atlas (./atlas.ts).
import { Matrix4, Vector3 } from 'three';
import { CELL, FACE_CELLS, HIPS_WAIST, V, cellUV, type CellId } from './atlas';
import { Builder, ellipsoid, ellipsoidRings, loft, ring, shell, sweep, disc, type Bind, type HeadFn, type Paint, type Ring, type UvFn } from './geometry';
import { FACE, faceUV, unitHead } from './head';
import { mix, mul, rgb, rng, type RGB, type Traits } from './traits';

/** Bone indices (order = skeleton order). L = character's left = +X. */
export const BONE = {
  hips: 0, spine: 1, chest: 2, neck: 3, head: 4,
  armL: 5, foreL: 6, handL: 7, armR: 8, foreR: 9, handR: 10,
  thighL: 11, shinL: 12, footL: 13, thighR: 14, shinR: 15, footR: 16,
  cup: 17, trash: 18, bag: 19,
} as const;
export const BONE_COUNT = 20;
export const PARENT: readonly number[] = [-1, 0, 1, 2, 3, 2, 5, 6, 2, 8, 9, 0, 11, 12, 0, 14, 15, 10, 10, 7];

export interface Dims {
  H: number;
  hipY: number; kneeY: number; ankleY: number;
  thigh: number; shin: number; footLen: number;
  /** Head top incl. hair / headwear. */
  top: number;
}

export interface BodyResult {
  builder: Builder;
  /** Rest-pose joint positions (model space) per bone. */
  joints: Vector3[];
  dims: Dims;
  /** Triangles per part (tooling). */
  parts: Record<string, number>;
}

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const smooth = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Linear interpolation over key rows [x, v1, v2, …] sorted by x. */
function keys(rows: readonly (readonly number[])[], x: number): number[] {
  if (x <= rows[0][0]) return rows[0].slice(1);
  for (let i = 1; i < rows.length; i++) {
    if (x <= rows[i][0]) {
      const a = rows[i - 1], b = rows[i], t = (x - a[0]) / (b[0] - a[0]);
      return a.slice(1).map((v, k) => lerp(v, b[k + 1], t));
    }
  }
  return rows[rows.length - 1].slice(1);
}
/** f(|φ − shift|) through [φ, value] pairs — hairlines and shell edges. */
const hl = (rows: readonly (readonly [number, number])[], shift = 0) => (ph: number) => keys(rows, Math.abs(ph - shift))[0];
/** Cheap deterministic value noise from a position (colour jitter). */
const hash3 = (x: number, y: number, z: number) => {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
};
const blend = (a: number, b: number, t: number): Bind => (t <= 0.001 ? a : t >= 0.999 ? b : [a, b, t]);
/** Piecewise-linear remap through [x, y] knots (row densities). */
const knots = (k: readonly (readonly [number, number])[]) => (t: number) => keys(k, t)[0];

// Torso profiles: [y/H, rx, rz front, rz back] (fractions of H), average build, before width/belly/bust.
const TORSO_M = [
  [0.468, 0.02, 0.03, 0.035], [0.488, 0.05, 0.045, 0.058], [0.51, 0.084, 0.054, 0.07], [0.535, 0.098, 0.058, 0.076], [0.565, 0.096, 0.06, 0.07],
  [0.6, 0.09, 0.062, 0.058], [0.65, 0.094, 0.066, 0.058], [0.695, 0.1, 0.072, 0.06], [0.745, 0.105, 0.075, 0.064], [0.78, 0.106, 0.068, 0.064],
  [0.803, 0.098, 0.056, 0.058], [0.818, 0.082, 0.046, 0.05], [0.832, 0.058, 0.04, 0.045], [0.848, 0.036, 0.034, 0.036],
] as const;
const TORSO_F = [
  [0.468, 0.022, 0.03, 0.035], [0.488, 0.055, 0.045, 0.06], [0.51, 0.092, 0.054, 0.074], [0.535, 0.108, 0.058, 0.082], [0.565, 0.102, 0.058, 0.076],
  [0.61, 0.082, 0.056, 0.056], [0.655, 0.085, 0.06, 0.056], [0.7, 0.09, 0.066, 0.057], [0.735, 0.094, 0.069, 0.059], [0.77, 0.095, 0.062, 0.059],
  [0.795, 0.09, 0.051, 0.052], [0.811, 0.076, 0.043, 0.046], [0.826, 0.054, 0.037, 0.041], [0.842, 0.033, 0.031, 0.033],
] as const;
// Leg (skin): [y/H, rx, rz front, rz back]
const LEG = [
  [0.034, 0.018, 0.02, 0.022], [0.07, 0.019, 0.019, 0.023], [0.18, 0.027, 0.025, 0.034],
  [0.28, 0.0275, 0.03, 0.026], [0.33, 0.033, 0.034, 0.031], [0.4, 0.04, 0.042, 0.04], [0.46, 0.046, 0.048, 0.048],
  [0.515, 0.052, 0.056, 0.055], [0.545, 0.05, 0.055, 0.052],
] as const;
// Arm (skin): [y/H, rx, rz]; the last rows round off the deltoid.
const ARM = [
  [0.458, 0.012, 0.0132], [0.52, 0.0168, 0.018], [0.575, 0.0196, 0.0205], [0.618, 0.0192, 0.0198], [0.67, 0.0212, 0.0222],
  [0.72, 0.0235, 0.0245], [0.765, 0.0262, 0.0268], [0.793, 0.0262, 0.026], [0.808, 0.0212, 0.0206], [0.815, 0.0118, 0.0112],
] as const;
/** A garment band on a limb/torso between heights y0..y1 (metres). Outermost (last) wins. */
interface Layer {
  y0: number;
  y1: number;
  off: number; // added thickness, m
  col: Paint<RGB>;
  rough: number;
  uv: UvFn;
  /** Minimum radius (loose trousers / sleeves), m, as a function of height. */
  minR?: (y: number) => number;
  dr?: (az: number, y: number) => number;
  /** Below this height the garment hangs straight (jacket skirts) instead of following the body. */
  hang?: number;
}
interface Shape { rx: number; rzf: number; rzb: number; cx: number; cz: number; sq: number }

/** Rings through a stack of layers: one ring per sample height, two at every layer change (the hem
 *  ledge between them takes the outer garment's colour and atlas cell). */
function layered(ys: number[], layers: Layer[], shape: (y: number) => Shape, bind: (y: number) => Paint<Bind>, ao?: (az: number, p: Vector3, base: RGB) => RGB): Ring[] {
  const win = (y: number) => { for (let i = layers.length - 1; i >= 0; i--) if (y >= layers[i].y0 && y <= layers[i].y1) return layers[i]; return layers[0]; };
  const lo = ys[0], hi = ys[ys.length - 1];
  const all = new Set(ys);
  for (const l of layers) for (const y of [l.y0, l.y1]) if (y > lo && y < hi && win(y - 1e-6) !== win(y + 1e-6)) all.add(y);
  const sorted = [...all].sort((a, b) => a - b);
  const out: Ring[] = [];
  const colOf = (l: Layer, dark = 1): Paint<RGB> => (az, p) => {
    const c = typeof l.col === 'function' ? l.col(az, p) : l.col;
    return mul(ao ? ao(az, p, c) : c, dark);
  };
  const mk = (y: number, l: Layer) => {
    const s = l.hang !== undefined && y < l.hang ? shape(l.hang) : shape(y);
    const m = l.minR ? l.minR(y) : 0;
    const r = ring(y, Math.max(s.rx + l.off, m), Math.max(s.rzf + l.off, m), Math.max(s.rzb + l.off, m), colOf(l), bind(y), l.rough, { cx: s.cx, cz: s.cz, sq: s.sq, uv: l.uv });
    if (l.dr) { const f = l.dr; r.dr = (az) => f(az, y); }
    return r;
  };
  for (const y of sorted) {
    const a = win(y - 1e-6), b = win(y + 1e-6);
    if (y === lo) out.push(mk(y, b));
    else if (y === hi) out.push(mk(y, a));
    else if (a !== b) {
      const ra = mk(y, a), rb = mk(y, b);
      const size = (r: Ring) => r.rx + r.rzf + r.rzb;
      if (Math.abs(size(ra) - size(rb)) < 1e-5) {
        // same surface, new garment: one ring, a second vertex set for the part below
        rb.below = { uv: a.uv, col: ra.col, rough: a.rough, smooth: true };
        out.push(rb);
      } else if (size(rb) > size(ra)) {
        // upper garment is outside (shirt over trousers, sleeve over the arm): its hem edge
        ra.below = { uv: a.uv, col: ra.col, rough: a.rough };
        ra.uv = b.uv; ra.col = colOf(b, 0.72); ra.rough = b.rough;
        out.push(ra, rb);
      } else {
        // lower garment is outside (necklines, cuffs over the hand)
        rb.below = { uv: a.uv, col: colOf(a, 0.72), rough: a.rough };
        out.push(ra, rb);
      }
    } else out.push(mk(y, a));
  }
  return out;
}

const R = { skin: 0.52, hair: 0.42, cotton: 0.88, denim: 0.84, wool: 0.8, leather: 0.36, silk: 0.6, felt: 0.92, plastic: 0.38, porcelain: 0.18 } as const;

/** `lean` trims tube segments for the rare outfit combination that would exceed the budget. */
export function buildBody(t: Traits, lean = false): BodyResult {
  const H = t.H, W = t.width, f = t.female;
  const h = (x: number) => x * H;
  const bd = new Builder();
  const r = rng(t.seed ^ 0x5eed);
  const parts: Record<string, number> = {};
  let mark = 0;
  const part = (name: string) => { parts[name] = (parts[name] ?? 0) + bd.triangleCount - mark; mark = bd.triangleCount; };

  // ------------------------------------------------------------------ atlas mappings
  const span = (a: number, b: number, y: number) => (y / H - a) / (b - a);
  const uvSkin: UvFn = (u, p) => cellUV(CELL.skin, u, (p.y / H) % 1);
  const uvTorso = (cell: CellId): UvFn => (u, p) => cellUV(cell, u, span(V.torso[0], V.torso[1], p.y));
  const uvLeg = (cell: CellId): UvFn => (u, p) => cellUV(cell, u, span(V.leg[0], V.leg[1], p.y));
  const uvSkirt: UvFn = (u, p) => cellUV(CELL.skirt, u, span(V.skirt[0], V.skirt[1], p.y));
  const uvSleeve: UvFn = (u, p) => cellUV(CELL.sleeve, u, span(V.sleeve[0], V.sleeve[1], p.y));

  // ------------------------------------------------------------------ proportions & joints
  const torsoKeys = f ? TORSO_F : TORSO_M;
  const torso = (y: number): Shape => {
    const k = keys(torsoKeys, y / H);
    const yy = y / H;
    const belly = t.belly * Math.exp(-(((yy - 0.61) / 0.05) ** 2));
    const bust = t.bust * Math.exp(-(((yy - 0.715) / 0.028) ** 2));
    const wz = 0.55 + 0.45 * W;
    return {
      rx: h(k[0] * W + 0.012 * belly), rzf: h(k[1] * wz + 0.036 * belly + 0.02 * bust), rzb: h(k[2] * wz + 0.004 * belly),
      cx: 0, cz: h(0.004 * belly), sq: 2 + 0.12 * smooth(0.62, 0.74, yy) + 0.35 * (1 - smooth(0.53, 0.58, yy)), // flatter across the groin
    };
  };
  const hipY = h(0.515), kneeY = h(0.28), ankleY = h(0.046);
  const hipX = h(0.051 * (f ? 1.1 : 1)) * Math.pow(W, 0.8);
  const kneeX = hipX * 0.8, ankleX = hipX * 0.78;
  const shoulderY = h(0.797), shoulderX = torso(h(0.78)).rx - h(0.014);
  const elbowY = h(0.618), wristY = h(0.463);
  const thighOuter = hipX + h(0.046) * W;
  const wristX = Math.max(shoulderX + h(0.02), Math.max(torso(h(0.5)).rx, thighOuter) + h(0.02));
  const elbowX = lerp(shoulderX, wristX, 0.52);
  const neckY = h(0.815), headPivotY = h(0.868);
  const hs = f ? 1.04 : 1.07;
  const hr = { x: h(0.058 * hs), y: h(0.072 * hs), zf: h(0.066 * hs), zb: h(0.065 * hs) };
  const headC = new Vector3(0, H - hr.y, h(0.006));
  const footLen = h(0.152);
  const shoeK = 1.08; // stylised: slightly chunkier shoes read better at a distance
  const neckR = h(f ? 0.031 : 0.036) * (0.85 + 0.15 * W);
  const neckZ = -h(0.008);
  const grip = (s: number) => new Vector3(s * (wristX - h(0.004)), wristY - h(0.052), h(0.006));

  const J: Vector3[] = [];
  J[BONE.hips] = new Vector3(0, hipY, 0);
  J[BONE.spine] = new Vector3(0, h(0.6), 0);
  J[BONE.chest] = new Vector3(0, h(0.7), -h(0.004));
  J[BONE.neck] = new Vector3(0, neckY, -h(0.006));
  J[BONE.head] = new Vector3(0, headPivotY, -h(0.004));
  for (const [s, a, fo, ha] of [[1, BONE.armL, BONE.foreL, BONE.handL], [-1, BONE.armR, BONE.foreR, BONE.handR]] as const) {
    J[a] = new Vector3(s * shoulderX, shoulderY, -h(0.004));
    J[fo] = new Vector3(s * elbowX, elbowY, -h(0.006));
    J[ha] = new Vector3(s * wristX, wristY, 0);
  }
  for (const [s, th, sh, ft] of [[1, BONE.thighL, BONE.shinL, BONE.footL], [-1, BONE.thighR, BONE.shinR, BONE.footR]] as const) {
    J[th] = new Vector3(s * hipX, hipY, 0);
    J[sh] = new Vector3(s * kneeX, kneeY, h(0.003));
    J[ft] = new Vector3(s * ankleX, ankleY, -h(0.004));
  }
  J[BONE.cup] = grip(-1);
  J[BONE.trash] = grip(-1);
  J[BONE.bag] = grip(1);

  // ------------------------------------------------------------------ colours & helpers
  const skin = t.skin;
  const jitter = (c: RGB, p: Vector3, amt: number): RGB => mul(c, 1 + (hash3(p.x * 40, p.y * 40, p.z * 40) - 0.5) * amt);
  /** Baked ambient occlusion + slight dye irregularity for body lofts. */
  const ao = (amt: number) => (az: number, p: Vector3, c: RGB): RGB => {
    const ground = 0.8 + 0.2 * smooth(0, h(0.35), p.y); // bounce-light falloff toward the feet
    return mul(jitter(c, p, amt), ground * (1 - 0.03 * Math.max(0, -Math.cos(az))));
  };
  const ao3 = ao(0.03);

  const top = t.top, jk = t.jacket, bot = t.bottom;
  const topColor = top.color;
  const trousers = bot.kind === 'jeans' || bot.kind === 'chinos' || bot.kind === 'suit';
  const skirted = bot.kind === 'skirt' || bot.kind === 'dress' || bot.kind === 'longskirt' || bot.kind === 'robe';
  const robe = top.kind === 'robe';
  const covered = t.headwear === 'hijab' || t.headwear === 'safsari';
  const botRough = bot.kind === 'jeans' ? R.denim : bot.kind === 'suit' ? R.wool : R.cotton;
  const topRough = top.kind === 'blouse' || top.kind === 'dress' ? 0.7 : top.kind === 'sweater' ? 0.95 : R.cotton;
  const jkRough = !jk ? 0 : jk.kind === 'leather' ? R.leather : jk.kind === 'suit' || jk.kind === 'blazer' ? R.wool : jk.kind === 'bomber' ? 0.62 : R.cotton;
  const waistY = h(f ? 0.6 : 0.585);
  const topHem = top.tucked ? waistY : top.kind === 'tunic' ? h(0.43) : robe || top.kind === 'dress' ? h(0.44) : h(top.kind === 'hoodie' || top.kind === 'sweater' ? 0.515 : 0.525);
  const pencil = bot.kind === 'skirt' && jk?.kind === 'blazer';
  const jkHem = !jk ? 0 : jk.kind === 'suit' || (jk.kind === 'blazer' && !skirted) ? h(0.475) : jk.kind === 'cardigan' ? h(0.5) : h(0.535);
  const topCell: CellId = top.kind === 'shirt' ? CELL.shirt : top.kind === 'polo' ? CELL.polo : top.kind === 'sweater' ? CELL.knit : top.kind === 'hoodie' ? CELL.hoodie
    : top.kind === 'blouse' || top.kind === 'dress' || top.kind === 'tunic' ? CELL.blouse : robe ? CELL.robe : CELL.tee;
  const jkCell: CellId = !jk ? CELL.suit : jk.kind === 'suit' || jk.kind === 'blazer' ? CELL.suit : jk.kind === 'leather' ? CELL.leather : jk.kind === 'bomber' ? CELL.bomber : jk.kind === 'denim' ? CELL.denimJk : CELL.cardigan;
  const legCell: CellId = bot.kind === 'jeans' ? CELL.jeansLeg : CELL.trouserLeg;
  const hipsCell: CellId = bot.kind === 'jeans' ? CELL.jeansHips : CELL.trouserHips;
  const uvHips: UvFn = (u, p) => cellUV(hipsCell, u, HIPS_WAIST + (p.y - waistY - h(0.01)) / (V.hipsSpan * H));

  // necklines: the top garment ends at a ring (a crisp ledge); the jebba adds a small front V
  // (painted skin, framed by the braid)
  const neckTop = covered ? 9 : h(f ? (top.kind === 'blouse' || top.kind === 'dress' ? 0.814 : 0.826) : 0.832);
  const vDepth = robe && !covered ? h(0.045) : 0;
  const openAt = (az: number, p: Vector3, grow: number): boolean => {
    if (vDepth === 0 || p.y < h(0.74)) return false;
    const yb = h(0.815) - vDepth - grow * 1.5;
    return p.y > yb && Math.abs(az) < 0.5 * smooth(yb, h(0.835), p.y) + grow * 8;
  };
  // (the jebba's braid is painted in the robe cell; vertex colours only open the V)
  const topPaint = (az: number, p: Vector3): RGB => (openAt(az, p, 0) ? skin : topColor);

  // ------------------------------------------------------------------ torso
  const torsoLayers: Layer[] = [{ y0: -1, y1: 9, off: 0, col: skin, rough: R.skin, uv: uvSkin }];
  if (trousers) torsoLayers.push({ y0: -1, y1: waistY + h(0.01), off: h(0.004), col: bot.color, rough: botRough, uv: uvHips });
  if (t.belt && trousers) torsoLayers.push({ y0: waistY - h(0.016), y1: waistY + h(0.004), off: h(0.0065), col: t.belt, rough: R.leather, uv: uvSkin });
  const shirtOff = h(top.tucked ? 0.005 : 0.0075);
  torsoLayers.push({ y0: topHem, y1: neckTop, off: shirtOff, col: topPaint, rough: topRough, uv: uvTorso(topCell) });
  let jacketEdge: ((y: number) => number) | null = null;
  let jacketButton = 0;
  if (jk) {
    const jkOff = h(jk.kind === 'leather' || jk.kind === 'bomber' ? 0.016 : 0.013);
    // open-front V: from the jacket's top button up to the collar the inner layer shows
    const button = h(jk.kind === 'suit' ? (jk.open ? 0.5 : 0.63) : jk.kind === 'blazer' ? 0.6 : 0.47);
    const tailored = jk.kind === 'suit' || jk.kind === 'blazer';
    const vHalf = (y: number) => (y < button ? (jk.open ? 0.16 : 0.06 * smooth(h(0.52), h(0.47), y)) : lerp(jk.open ? 0.16 : 0.05, tailored ? 0.42 : 0.36, smooth(button, h(0.81), y)));
    const inside = (az: number, y: number) => Math.abs(az) < vHalf(y);
    jacketEdge = vHalf;
    jacketButton = button;
    const hemBand = jk.kind === 'bomber' ? h(0.02) : 0;
    torsoLayers.push({
      y0: jkHem, y1: Math.min(h(0.826), neckTop), off: jkOff, rough: jkRough, hang: h(0.53), uv: uvTorso(jkCell),
      col: (az, p) => {
        if (inside(az, p.y)) return topPaint(az, p);
        if (p.y < jkHem + hemBand) return mul(jk.color, 0.85);
        return jk.color;
      },
      dr: (az, y) => (inside(az, y) ? shirtOff - jkOff : 0),
    });
  }
  const skirtTop = !skirted ? 0 : robe || bot.kind === 'dress' ? h(0.56) : top.tucked ? waistY : Math.min(waistY, topHem + h(0.015));
  // under a skirt the lower torso is never seen: start the torso loft just below the skirt top
  const torsoYs = torsoKeys.map((k) => h(k[0])).filter((y, i, a) => !skirted || y >= skirtTop - h(0.04) || (a[i + 1] ?? 9) >= skirtTop - h(0.04));
  const torsoBind = (y: number): Bind => {
    const yy = y / H;
    if (yy < 0.56) return BONE.hips;
    if (yy < 0.62) return blend(BONE.hips, BONE.spine, smooth(0.56, 0.62, yy));
    if (yy < 0.66) return BONE.spine;
    if (yy < 0.73) return blend(BONE.spine, BONE.chest, smooth(0.66, 0.73, yy));
    return BONE.chest;
  };
  const torsoAo = (az: number, p: Vector3, c: RGB): RGB => {
    const side = Math.abs(Math.sin(az));
    const pit = Math.exp(-(((p.y / H - 0.775) / 0.03) ** 2)) * side * side; // armpits
    const underBust = f ? Math.exp(-(((p.y / H - 0.685) / 0.02) ** 2)) * Math.max(0, Math.cos(az)) * t.bust : 0;
    return mul(ao3(az, p, c), 1 - 0.28 * pit - 0.12 * underBust);
  };
  // slightly front-dense azimuths: lapels, V-necks and ties need resolution at the front
  const azFront = (u: number) => { const k = u * 2 - 1; return Math.PI * k * (0.72 + 0.28 * Math.abs(k)); };
  loft(bd, layered(torsoYs, torsoLayers, torso, torsoBind, torsoAo), lean ? 16 : 18, { azMap: azFront });
  part('torso');
  /** Outer torso surface point (incl. clothing) for straps and ties. */
  const torsoSurf = (y: number, az: number, extra: number, underJacket = false): Vector3 => {
    const s = torso(y);
    let off = 0;
    for (const l of torsoLayers) if (y >= l.y0 && y <= l.y1 && !(underJacket && l.hang !== undefined)) off = l.off + (l.dr ? l.dr(az, y) : 0);
    const sn = Math.sin(az), cs = Math.cos(az);
    const se = (v: number) => Math.sign(v) * Math.pow(Math.abs(v), 2 / s.sq);
    return new Vector3((s.rx + off + extra) * se(sn), y, s.cz + ((cs >= 0 ? s.rzf : s.rzb) + off + extra) * se(cs));
  };

  // jacket front edges / lapels: ribbons along the opening give it a crisp, slightly raised edge
  if (jk && jacketEdge) {
    const vhalf = jacketEdge;
    const tailored = jk.kind === 'suit' || jk.kind === 'blazer';
    const y0 = jk.open ? jkHem + h(0.004) : jacketButton, y1 = h(0.81);
    for (const s of [1, -1] as const) {
      const pts: Vector3[] = [], ups: Vector3[] = [];
      const n = 5;
      for (let i = 0; i <= n; i++) {
        const y = lerp(y0, y1, i / n);
        const az = s * (vhalf(y) + 0.02);
        pts.push(torsoSurf(y, az, h(0.0015)));
        ups.push(new Vector3(Math.sin(az), 0.15, Math.cos(az)).normalize());
      }
      const w = (i: number) => h(tailored ? lerp(0.006, 0.017, smooth(0.2, 1, i / n) * (lerp(y0, y1, i / n) > jacketButton ? 1 : 0.3)) : 0.005);
      sweep(bd, pts, (i) => ups[i], w, h(0.0022), (i) => mul(jk.color, i === n ? 0.85 : 0.95), BONE.chest, jkRough);
    }
    part('lapels');
  }

  // ------------------------------------------------------------------ skirt / dress / robe / tunic
  /** Flared tube from y0 down to the hem. Upper vertices follow the hips + both thighs, lower ones
   *  the shins, so legs never poke through and a seated robe drapes from the knees. */
  const skirt = (y0: number, hem: number, color: RGB, flare: number, baseOff: number, rough: number, folds: number) => {
    const len = y0 - hem;
    const n = Math.max(2, Math.round(len / h(0.1)) + 1);
    const rings: Ring[] = [];
    const ph = t.seed * 0.7;
    const fold = (az: number) => Math.sin(az * 4 + ph) * 0.6 + Math.sin(az * 7 + ph * 2) * 0.4;
    for (let i = 0; i <= n; i++) {
      const u = i / n; // 0 at the hem → 1 at the top
      const y = lerp(hem, y0, u);
      const s = torso(Math.max(y, h(0.5)));
      const d = Math.pow(1 - u, 1.3);
      const legSpan = hipX + h(0.05) * W;
      const rx = Math.max(s.rx + baseOff, legSpan) + flare * d;
      const rzf = Math.max(s.rzf, h(0.068)) + baseOff + flare * 0.75 * d;
      const rzb = Math.max(s.rzb, h(0.068)) + baseOff + flare * 0.75 * d;
      const col: Paint<RGB> = (az, p) => mul(jitter(color, p, 0.03), (0.86 + 0.14 * u) * (1 - 0.14 * d * (0.5 - 0.5 * fold(az))));
      const bindF = (_az: number, p: Vector3): Bind => {
        const depth = clamp((y0 - p.y) / Math.max(h(0.06), y0 - kneeY), 0, 1) * 0.95;
        const sL = smooth(-rx * 0.45, rx * 0.45, p.x), sR = 1 - sL;
        const below = clamp((kneeY - p.y) / (kneeY - ankleY), 0, 1) * 0.75;
        if (below > 0) return { b: [BONE.thighL, BONE.thighR, BONE.shinL, BONE.shinR], w: [sL * (1 - below), sR * (1 - below), sL * below, sR * below] };
        return { b: [BONE.hips, BONE.thighL, BONE.thighR], w: [1 - depth, depth * sL, depth * sR] };
      };
      const rr = ring(y, rx, rzf, rzb, col, bindF, rough, { sq: 2.1, uv: uvSkirt });
      if (folds > 0) rr.dr = (az) => folds * d * fold(az);
      rings.push(rr);
    }
    // turned hem: an inner lip so the edge has visible thickness from below
    const h0 = rings[0];
    const lip = ring(h0.y + h(0.006), h0.rx - h(0.007), h0.rzf - h(0.007), h0.rzb - h(0.007), mul(color, 0.45), h0.bind, rough, { sq: 2.1, uv: uvSkirt });
    lip.dr = h0.dr;
    loft(bd, [lip, ...rings], 18);
  };
  if (skirted) {
    const hem = h(bot.hem);
    const flare = robe ? h(0.065) : bot.kind === 'longskirt' ? h(0.05) : pencil ? h(0.008) : h(0.022) + (skirtTop - hem) * 0.08;
    skirt(skirtTop, hem, bot.color, flare, robe || bot.kind === 'dress' ? h(0.0095) : h(0.004), robe ? R.wool : R.cotton, pencil ? 0 : h(robe ? 0.011 : 0.009));
  }
  if (top.kind === 'tunic') skirt(h(0.56), topHem, topColor, h(0.02), h(0.0095) + (skirted ? h(0.012) : 0), topRough, h(0.005));
  part('skirt');

  // ------------------------------------------------------------------ legs
  const sock = trousers ? mix(bot.color, [0.02, 0.02, 0.02], 0.7) : t.legs;
  for (const s of [1, -1] as const) {
    const th = s > 0 ? BONE.thighL : BONE.thighR, sh = s > 0 ? BONE.shinL : BONE.shinR;
    const cxAt = (y: number) => s * (y < kneeY ? lerp(ankleX, kneeX, (y - ankleY) / (kneeY - ankleY)) : lerp(kneeX, hipX, (y - kneeY) / (hipY - kneeY)));
    const shape = (y: number): Shape => {
      const k = keys(LEG, y / H);
      const wl = 0.6 + 0.4 * W;
      // thigh tops lean in until both meet at the midline and cover the groin (no crotch panel)
      return { rx: h(k[0]) * wl, rzf: h(k[1]) * wl, rzb: h(k[2]) * wl, cx: cxAt(y) * (1 - 0.28 * smooth(h(0.44), h(0.53), y)), cz: 0, sq: 2 };
    };
    const bare = skirted && !robe;
    const layers: Layer[] = [{ y0: -1, y1: 9, off: 0, col: bare ? t.legs : skin, rough: bare && t.legs !== skin ? 0.6 : R.skin, uv: uvSkin }];
    if (trousers) {
      const open = h(bot.kind === 'jeans' ? (f ? 0.028 : 0.032) : bot.kind === 'suit' ? 0.036 : 0.034) * (0.8 + 0.2 * W);
      layers[0] = { y0: -1, y1: 9, off: 0, col: sock, rough: R.cotton, uv: uvSkin };
      layers.push({
        y0: h(bot.hem), y1: 9, off: h(0.0045), rough: botRough, col: bot.color, uv: uvLeg(legCell),
        minR: (y) => open * (1 - 0.25 * smooth(kneeY - h(0.04), kneeY + h(0.1), y)),
      });
    } else if (robe) {
      layers.push({ y0: h(0.05), y1: 9, off: h(0.006), col: mul(bot.color, 0.92), rough: R.cotton, uv: uvLeg(CELL.trouserLeg) }); // sarouel under the jebba
    }
    // under skirts only the part below the hem (plus knee + hip joint rings) is ever visible
    let ys = LEG.map((k) => h(k[0]));
    if (skirted) ys = ys.filter((y) => y <= h(bot.hem) + h(0.06) || Math.abs(y - kneeY) < 1e-6 || y >= hipY - 1e-6);
    if (trousers) ys.push(h(bot.hem) + h(0.018)); // ankle break
    ys.sort((a, b) => a - b);
    const bind = (y: number): Bind => {
      if (y < kneeY - h(0.03)) return sh;
      if (y < kneeY + h(0.03)) return blend(sh, th, smooth(kneeY - h(0.03), kneeY + h(0.03), y));
      if (y > hipY) return blend(th, BONE.hips, 0.4 * smooth(hipY, h(0.545), y));
      return th;
    };
    loft(bd, layered(ys, layers, shape, bind, ao3), lean ? 9 : 10);
  }
  part('legs');

  // ------------------------------------------------------------------ feet / shoes
  const sh = t.shoes;
  const shoeCell: CellId = sh.kind === 'sneaker' ? CELL.sneaker : sh.kind === 'leather' ? CELL.shoe : CELL.skin;
  for (const s of [1, -1] as const) {
    const fb = s > 0 ? BONE.footL : BONE.footR;
    const ax = s * ankleX, az0 = -h(0.004);
    const L = footLen * 1.06;
    const low = sh.kind === 'flat' || sh.kind === 'slipper';
    // [along/L, cy, up, down, rx] (heights in H)
    const rows: [number, number, number, number, number][] = [
      [-0.27, 0.026, low ? 0.012 : 0.02, 0.026, 0.02], [-0.2, 0.029, low ? 0.018 : 0.03, 0.029, 0.026], [0, 0.031, low ? 0.024 : 0.034, 0.031, 0.029],
      [0.25, 0.027, low ? 0.02 : 0.027, 0.027, 0.031], [0.52, 0.021, low ? 0.014 : 0.018, 0.021, 0.032], [0.73, 0.015, 0.007, 0.012, 0.02],
    ];
    const soleH = h(sh.kind === 'sneaker' ? 0.016 : 0.008);
    const shoeCol = (_az: number, p: Vector3): RGB => (p.y < soleH ? sh.sole : sh.kind === 'sneaker' && p.y < soleH + h(0.004) ? mul(sh.sole, 0.9) : sh.color);
    const rough = sh.kind === 'leather' ? R.leather : sh.kind === 'sneaker' ? 0.62 : 0.5;
    const z0 = az0 + rows[0][0] * L, z1 = az0 + rows[rows.length - 1][0] * L;
    const uv: UvFn = (u, p) => cellUV(shoeCell, u, (p.z - z0) / (z1 - z0));
    const rings = rows.map(([a, cy, up, dn, rx]) => ring(az0 + a * L, h(rx) * shoeK, h(up) * shoeK, h(dn), shoeCol, fb, rough, { cx: ax + s * h(0.002) * a, cz: h(cy), sq: 2.6, uv }));
    loft(bd, rings, 8, { axis: 'z', capStart: true, capEnd: true });
  }
  part('shoes');

  // ------------------------------------------------------------------ arms & hands
  const longTop = top.longSleeves;
  for (const s of [1, -1] as const) {
    const a = s > 0 ? BONE.armL : BONE.armR, fo = s > 0 ? BONE.foreL : BONE.foreR, ha = s > 0 ? BONE.handL : BONE.handR;
    const cxAt = (y: number) => s * (y < elbowY ? lerp(wristX, elbowX, (y - wristY) / (elbowY - wristY)) : y < shoulderY ? lerp(elbowX, shoulderX, (y - elbowY) / (shoulderY - elbowY)) : shoulderX - h(0.012) * smooth(shoulderY, h(0.815), y));
    const wa = (f ? 0.9 : 1) * (0.62 + 0.38 * W);
    const shape = (y: number): Shape => { const k = keys(ARM, y / H); return { rx: h(k[0]) * wa, rzf: h(k[1]) * wa, rzb: h(k[1]) * wa, cx: cxAt(y), cz: -h(0.004), sq: 2 }; };
    const layers: Layer[] = [{ y0: -1, y1: 9, off: 0, col: skin, rough: R.skin, uv: uvSkin }];
    const sleeveEnd = robe ? h(0.47) : longTop ? h(0.472) : h(top.kind === 'dress' || top.kind === 'blouse' ? 0.72 : 0.705);
    const cuff = (y0: number, r0: number) => (y: number) => r0 * (1 - smooth(y0 + h(0.04), y0 + h(0.09), y));
    layers.push({ y0: sleeveEnd, y1: 9, off: h(0.004), col: robe ? [0.86, 0.85, 0.82] : topColor, rough: topRough, uv: uvSleeve, minR: longTop ? cuff(sleeveEnd, h(0.015)) : cuff(sleeveEnd, h(0.026)) });
    if (robe) layers.push({ y0: h(0.775), y1: 9, off: h(0.007), col: topColor, rough: R.wool, uv: uvSleeve }); // sleeveless jebba over the shirt
    if (jk) layers.push({ y0: h(0.478), y1: 9, off: h(jk.kind === 'leather' || jk.kind === 'bomber' ? 0.0085 : 0.0065), col: (_az, p) => (jk.kind === 'bomber' && p.y < h(0.5) ? mul(jk.color, 0.8) : jk.color), rough: jkRough, uv: uvSleeve, minR: cuff(h(0.478), h(0.017)) });
    const ys = ARM.map((k) => h(k[0]));
    const bind = (y: number): Bind => {
      if (y < elbowY - h(0.025)) return fo;
      if (y < elbowY + h(0.025)) return blend(fo, a, smooth(elbowY - h(0.025), elbowY + h(0.025), y));
      if (y > shoulderY + h(0.006)) return blend(a, BONE.chest, 0.4 * smooth(shoulderY + h(0.006), h(0.815), y));
      return a;
    };
    const armAo = (az: number, p: Vector3, c: RGB): RGB => mul(ao3(az, p, c), 1 - 0.18 * Math.max(0, -s * Math.sin(az)) * smooth(h(0.62), h(0.78), p.y));
    loft(bd, layered(ys, layers, shape, bind, armAo), lean ? 7 : 8, { capEnd: true });

    // hand: a relaxed mitten, palm facing the thigh (inward = −s·X), fingers stacked front → back
    // (painted separations in the hand cell), thumb forward
    const inward = -s;
    const hx = s * wristX;
    const hsz = (f ? 0.95 : 1.05) * (0.85 + 0.15 * W);
    // [dy (H), thickness rx, front rz, back rz, shift toward palm, forward shift]
    const HAND = [[0.008, 0.0095, 0.0115, 0.0115, 0, 0], [-0.014, 0.0112, 0.0195, 0.0172, 0, 0.001], [-0.042, 0.0122, 0.021, 0.019, 0.001, 0.001],
      [-0.058, 0.011, 0.0198, 0.0172, 0.003, 0], [-0.075, 0.0088, 0.0168, 0.0138, 0.007, -0.001], [-0.092, 0.0048, 0.0098, 0.0078, 0.012, -0.002]] as const;
    const yTip = wristY + h(HAND[HAND.length - 1][0]) * hsz, yWr = wristY + h(HAND[0][0]) * hsz;
    const handCol = (_az: number, p: Vector3): RGB => mul(skin, 0.97 - 0.08 * smooth(wristY - h(0.05), wristY - h(0.095), p.y));
    const huv: UvFn = (u, p) => cellUV(CELL.hand, u, (p.y - yTip) / (yWr - yTip));
    const hrings = HAND.map(([dy, rx, rzf, rzb, sp, fw]) => ring(wristY + h(dy) * hsz, h(rx) * hsz, h(rzf) * hsz, h(rzb) * hsz, handCol, ha, R.skin, { cx: hx + inward * h(sp) * hsz, cz: h(fw) * hsz, uv: huv }));
    loft(bd, hrings.reverse(), 7, { capStart: true });
    const m = new Matrix4().makeTranslation(hx + inward * h(0.006) * hsz, wristY - h(0.03) * hsz, h(0.018) * hsz)
      .multiply(new Matrix4().makeRotationZ(-0.3 * s)).multiply(new Matrix4().makeRotationX(-0.55));
    ellipsoid(bd, new Vector3(0, -h(0.012) * hsz, 0), h(0.0074) * hsz, h(0.021) * hsz, h(0.008) * hsz, 5, 3, skin, ha, R.skin, m, 2, uvSkin);
  }
  part('arms');

  // ------------------------------------------------------------------ neck (hidden under hijab drapes)
  if (!covered) {
    const nb = (y: number): Bind => (y < neckY ? blend(BONE.chest, BONE.neck, 0.5) : y < headPivotY ? blend(BONE.neck, BONE.head, smooth(neckY, headPivotY, y) * 0.6) : BONE.head);
    const ys = [h(0.8), neckY, lerp(neckY, headPivotY, 0.5), headPivotY, headC.y - h(0.025)];
    loft(bd, ys.map((y, i) => ring(y, neckR * (i === 0 ? 1.3 : 1), neckR * (i === 0 ? 1.1 : 0.95), neckR * (i === 0 ? 1.2 : 1.08),
      (az, p) => mul(skin, 1 - 0.28 * Math.max(0, Math.cos(az)) * smooth(headPivotY - h(0.02), headC.y - h(0.035), p.y)), nb(y), R.skin, { cz: neckZ, uv: uvSkin })), 10);
    part('neck');
  }

  // ------------------------------------------------------------------ head
  const jaw = f ? 0.1 + 0.2 * r() : 0.65 + 0.35 * r();
  const _u = new Vector3();
  const headFn: HeadFn = (th, ph, off, out) => {
    unitHead(th, ph, jaw, _u);
    const rz = Math.cos(ph) >= 0 ? hr.zf : hr.zb;
    return out.set(headC.x + _u.x * (hr.x + off), headC.y + _u.y * (hr.y + off), headC.z + _u.z * (rz + off));
  };
  const faceCell: CellId = t.age === 'senior' ? (f ? FACE_CELLS.oldFemale : FACE_CELLS.oldMale) : (f ? FACE_CELLS.female : FACE_CELLS.male)[(t.seed >>> 3) & 1];
  const uvFace = (p: Vector3) => { const [u, v] = faceUV((p.x - headC.x) / hr.x, (p.y - headC.y) / hr.y); return cellUV(faceCell, u, v); };
  // hairline (θ where the hair shell ends, per azimuth); also tints the scalp just inside it
  const hs2 = t.hairStyle;
  const longish = hs2 === 'long' || hs2 === 'bob' || hs2 === 'ponytail' || hs2 === 'bun' || (f && hs2 === 'curly');
  let th1 = hl([[0, 0.8], [0.45, 0.86], [0.9, 1.22], [1.12, 1.62], [1.3, 1.78], [1.52, 1.42], [1.85, 1.58], [2.35, 2.08], [Math.PI, 2.28]]);
  if (hs2 === 'receding' || t.headwear === 'chechia' || t.headwear === 'cap') th1 = hl([[0, 0.45], [0.35, 0.65], [0.8, 0.98], [1.12, 1.55], [1.3, 1.7], [1.52, 1.42], [1.85, 1.55], [2.35, 2.05], [Math.PI, 2.25]]);
  if (longish) th1 = hl([[0, hs2 === 'bun' || hs2 === 'ponytail' ? 0.8 : 0.92], [0.5, 0.95], [0.95, 1.42], [1.2, 1.85], [1.5, hs2 === 'ponytail' || hs2 === 'bun' ? 1.68 : 2.05], [2.2, 2.3], [Math.PI, hs2 === 'bob' ? 2.5 : 2.35]]);
  const hasHair = (hs2 !== 'covered' && hs2 !== 'bald') || t.headwear === 'chechia' || t.headwear === 'cap';
  const scalpTint = (th: number, ph: number) => (hasHair && hs2 !== 'buzz' ? 0.35 * (1 - smooth(th1(ph) - 0.02, th1(ph) + 0.14, th)) : hs2 === 'buzz' ? 0.5 * (1 - smooth(th1(ph), th1(ph) + 0.05, th)) : 0);
  const beardZone = (th: number, ph: number) => smooth(1.95, 2.25, th) * (1 - smooth(1.25, 1.55, Math.abs(ph)));
  const stubble = t.beard === 'short' ? 0.45 : t.beard !== 'none' ? 0.24 : 0;
  const beardCol = mix(t.hair, skin, 0.22);
  const headCol = (_t: number, ph: number, th: number): RGB => {
    const cheek = Math.exp(-(((th - 1.95) / 0.25) ** 2)) * Math.exp(-(((Math.abs(ph) - 0.6) / 0.3) ** 2));
    let c: RGB = [skin[0] * (1 + 0.06 * cheek), skin[1] * (1 - 0.02 * cheek), skin[2] * (1 - 0.025 * cheek)];
    c = mul(c, 1 - 0.1 * smooth(2.5, 2.9, th) * Math.max(0, Math.cos(ph)));
    if (stubble) c = mix(c, mul(beardCol, 0.85), stubble * beardZone(th, ph));
    const tint = scalpTint(th, ph);
    if (tint > 0) c = mix(c, mul(t.hair, 0.9), tint);
    return c;
  };
  // two shells: the front half carries the painted face, the back half plain skin; the seams at
  // the ears are twinned so the head shades as one surface
  const TH_END = Math.PI * 0.94;
  const rowMap = knots([[0, 0], [2 / 12, 1.0 / TH_END], [10 / 12, 2.6 / TH_END], [1, 1]]);
  const front = shell(bd, headFn, {
    rows: 12, segs: lean ? 10 : 12, phi0: -Math.PI / 2, phi1: Math.PI / 2, th0: () => 0, th1: () => TH_END, rowMap, off: () => 0,
    bind: BONE.head, rough: R.skin, col: headCol, uv: (_t, _ju, _ph, _th, p) => uvFace(p),
  });
  if (!covered) { // under a headscarf the back of the head is never seen
    const back = shell(bd, headFn, {
      rows: 12, segs: lean ? 6 : 7, phi0: Math.PI / 2, phi1: Math.PI * 1.5, th0: () => 0, th1: () => TH_END, rowMap, off: () => 0,
      bind: BONE.head, rough: R.skin, col: headCol, uv: (tt, ju) => cellUV(CELL.skin, ju, tt),
    });
    front.first.forEach((v, i) => bd.twin(v, back.last[i]));
    front.last.forEach((v, i) => bd.twin(v, back.first[i]));
    bd.twin(front.pole, back.pole);
  }
  part('head');

  // nose: rings from under the tip up to the bridge, placed relative to the face surface; it takes
  // the face cell by the same projection, so the painted side shading lands on it
  const hp = (th: number, ph: number, off: number) => headFn(th, ph, off, new Vector3());
  {
    // [θ, half width, protrusion, depth behind the face surface] — alae at the base, round tip, low bridge
    const rows = [[1.945, 0.0108, 0.0028, 0.006], [1.91, 0.0112, 0.0072, 0.0072], [1.865, 0.0094, 0.0084, 0.007], [1.79, 0.0066, 0.0064, 0.006], [1.69, 0.005, 0.0036, 0.005], [1.59, 0.0045, 0.0011, 0.005]] as const;
    const nw = (f ? 0.88 : 1) * (0.9 + 0.2 * r());
    const low = hp(1.915, 0, 0).y;
    const nrings = rows.map(([th, rx, prot, back]) => {
      const sp = hp(th, 0, 0);
      const tip = th > 1.84 && th < 1.92;
      const rr = ring(sp.y, h(rx) * nw, h(back + prot) * nw, h(0.003), (az, p) => mul(skin, p.y < low ? 0.72 + 0.2 * Math.max(0, Math.cos(az)) : tip ? 1.02 + 0.05 * Math.max(0, Math.cos(az)) : 1.01), BONE.head, R.skin, { cz: sp.z - h(back), sq: 2 });
      rr.uv = (_u, p) => uvFace(p);
      return rr;
    });
    loft(bd, nrings, 6, { capStart: true, capEnd: true });
  }
  // ears
  if (!covered) {
    for (const s of [1, -1] as const) {
      const ec = hp(1.72, s * 1.6, -h(0.004));
      const em = new Matrix4().makeTranslation(ec.x, ec.y, ec.z).multiply(new Matrix4().makeRotationY(s * 0.25)).multiply(new Matrix4().makeRotationX(-0.12));
      ellipsoid(bd, new Vector3(), h(0.0055), h(0.023), h(0.014), 7, 3, (_az, p) => mul([skin[0] * 1.02, skin[1] * 0.9, skin[2] * 0.88], (p.x - ec.x) * s > h(0.002) ? 1 : 0.75), BONE.head, R.skin, em, 2, uvSkin);
    }
  }
  part('face');

  // ------------------------------------------------------------------ hair
  let topY = H;
  const hairCell: CellId = hs2 === 'curly' || hs2 === 'buzz' ? CELL.hairCurly : CELL.hair;
  const hairUv = (tt: number, ju: number) => cellUV(hairCell, ju, 1 - tt);
  const hairCol = (base: RGB) => (tt: number, ph: number, th: number, p: Vector3): RGB => {
    const shine = 1 + 0.12 * Math.exp(-(((th - 0.75) / 0.35) ** 2)) * Math.max(0, Math.cos(ph - 0.4));
    return mul(jitter(base, p, 0.1), (0.7 + 0.3 * smooth(1, 0.45, tt)) * shine);
  };
  if (hasHair) {
    const thick = h(t.headwear === 'chechia' || t.headwear === 'cap' ? 0.004 : hs2 === 'buzz' ? 0.004 : hs2 === 'curly' ? 0.022 : longish ? 0.016 : hs2 === 'receding' ? 0.008 : 0.013);
    const bumpA = hs2 === 'curly' ? h(0.006) : h(0.0015);
    // bangs keep a visible edge at the front; elsewhere the hair thins into the scalp
    const hatted = t.headwear === 'chechia' || t.headwear === 'cap'; // only the fringe below the hat
    shell(bd, headFn, {
      rows: hatted ? 4 : 6, segs: lean ? 14 : 16, th0: () => (hatted ? 0.95 : 0), th1,
      off: (tt, ph, th) => {
        const fr = Math.max(0, Math.cos(ph));
        const taper = longish ? lerp(1, 0.3, fr) : 1; // edge meets the scalp (except bangs)
        return thick * (1 - smooth(0.7, 1, tt) * taper) + bumpA * (Math.sin(ph * 9 + th * 7 + t.seed) * 0.5 + 0.5) + (hs2 === 'bob' ? h(0.012) * smooth(0.5, 1, tt) * (1 - fr) : 0) + (!hatted && (hs2 === 'short' || hs2 === 'curly') ? h(0.004) * (1 - tt) : 0);
      },
      col: hairCol(t.hair), bind: BONE.head, rough: R.hair, uv: (tt, ju) => hairUv(hatted ? 0.6 + 0.4 * tt : tt, ju),
    });
    topY = headC.y + hr.y + thick;
    if (hs2 === 'long') {
      // curtain of hair down the back, lying on the upper back; strands in the hair cell
      const yTop = headC.y - h(0.005), yBot = h(0.72);
      const rings: Ring[] = [];
      for (let i = 0; i <= 5; i++) {
        const u = i / 5, y = lerp(yBot, yTop, u);
        const rx = lerp(hr.x * 0.7, hr.x * 1.04, Math.pow(u, 0.6));
        const rz = lerp(h(0.011), hr.zb * 0.42, u);
        const back = y < h(0.84) ? torso(y).rzb + h(0.012) + (jk ? h(0.014) : 0) : 0;
        const cz = Math.min(headC.z - hr.zb * 0.5, -back - rz * 0.6);
        const rr = ring(y, rx, rz, rz, (_az, p) => mul(jitter(t.hair, p, 0.1), 0.62 + 0.38 * u), blend(BONE.head, BONE.chest, 0.8 * (1 - smooth(0.25, 1, u))), R.hair, { cz, uv: (uu) => cellUV(hairCell, uu, 0.15 + 0.85 * u) });
        rr.dr = (az) => h(0.002) * Math.sin(az * 9 + t.seed) * (1 - u);
        rings.push(rr);
      }
      loft(bd, rings, 12, { capStart: true });
    }
    if (hs2 === 'ponytail') {
      const a = hp(1.75, Math.PI, h(0.006));
      const rings: Ring[] = [];
      for (let i = 0; i <= 4; i++) {
        const u = i / 4;
        const rr = h(0.017) * (1 - 0.55 * u) + h(0.003);
        rings.push(ring(a.y - h(0.19) * u, rr, rr, rr, mul(t.hair, 0.82 + 0.1 * u), blend(BONE.head, BONE.neck, u * 0.6), R.hair, { cz: a.z - h(0.012) - h(0.022) * u, uv: (uu) => cellUV(hairCell, uu, 1 - u) }));
      }
      loft(bd, rings.reverse(), 8, { capStart: true, capEnd: true });
    }
    if (hs2 === 'bun') {
      const a = hp(1.05, Math.PI, h(0.022));
      ellipsoid(bd, a, h(0.03), h(0.026), h(0.026), 8, 4, (_az, p) => jitter(t.hair, p, 0.1), BONE.head, R.hair, undefined, 2, (uu, p) => cellUV(CELL.hairCurly, uu, (p.y - a.y) / h(0.06) + 0.5));
      topY = Math.max(topY, a.y + h(0.02));
    }
  }
  if (hs2 === 'bald' && t.headwear === 'none') {
    // horseshoe fringe around the back
    shell(bd, headFn, {
      rows: 3, segs: 10, phi0: 1.05, phi1: Math.PI * 2 - 1.05, th0: () => 1.25, th1: hl([[1.05, 1.6], [1.52, 1.42], [1.85, 1.6], [2.35, 2.05], [Math.PI, 2.2]]),
      off: (tt) => h(0.004) * (1 - tt * 0.6), col: hairCol(t.hair), bind: BONE.head, rough: R.hair, uv: (tt, ju) => hairUv(tt, ju),
    });
  }
  // beard / moustache
  if (t.beard === 'short') {
    shell(bd, headFn, {
      rows: 4, segs: 12, phi0: -1.5, phi1: 1.5,
      th0: hl([[0, 2.36], [0.35, 2.3], [0.55, 2.05], [1.1, 1.95], [1.5, 2.0]]), th1: hl([[0, 2.95], [0.8, 2.75], [1.5, 2.2]]),
      off: (tt, ph) => h(0.0045) * (1 - 0.6 * smooth(1.2, 1.5, Math.abs(ph))) * (0.6 + 0.4 * Math.sin(tt * Math.PI)),
      col: (tt, ph, _th, p) => mix(mul(jitter(beardCol, p, 0.1), 0.9), skin, 0.35 * smooth(1.1, 1.5, Math.abs(ph)) + 0.25 * (1 - smooth(0, 0.3, tt))), bind: BONE.head, rough: R.hair, uv: (tt, ju) => cellUV(CELL.hairCurly, ju, tt),
    });
  }
  if (t.beard === 'short' || t.beard === 'moustache') {
    shell(bd, headFn, {
      rows: 2, segs: 6, phi0: -0.46, phi1: 0.46, th0: () => 2.1, th1: hl([[0, 2.18], [0.46, 2.3]]),
      off: (_tt, ph) => h(0.0045) * (1 - 0.5 * Math.abs(ph)), col: (_tt, _ph, _th, p) => mul(jitter(beardCol, p, 0.1), 0.85), bind: BONE.head, rough: R.hair, uv: (tt, ju) => cellUV(CELL.hair, ju, 1 - tt),
    });
  }
  part('hair');

  // ------------------------------------------------------------------ headwear
  if (covered) {
    const hc = t.headwearColor;
    const saf = t.headwear === 'safsari';
    const fabric = (_tt: number, ph: number, th: number, p: Vector3): RGB => mul(jitter(hc, p, 0.03), 0.94 + 0.06 * Math.sin(ph * 5 + th * 3) - 0.1 * smooth(2.4, 2.95, th));
    shell(bd, headFn, {
      rows: 9, segs: 20, th0: () => 0,
      th1: hl([[0, saf ? 1.02 : 1.1], [0.45, saf ? 1.1 : 1.18], [0.75, 1.5], [0.92, 2.2], [1.08, 2.8], [1.25, 2.95], [Math.PI, 2.95]]),
      off: (tt, ph) => h(0.011) + h(0.003) * Math.sin(ph * 5) * tt + h(0.003) * smooth(0.8, 1, tt) * Math.max(0, Math.cos(ph)),
      col: fabric, bind: BONE.head, rough: R.silk, uv: (tt, ju) => cellUV(CELL.hijab, ju, 1 - tt),
    });
    topY = headC.y + hr.y + h(0.012);
    // drape: from the throat over the shoulders; longer at the front, soft folds
    const drop = h(saf ? 0.1 : 0.055);
    const yBot = h(saf ? 0.73 : 0.772);
    const sBot = torso(yBot), s81 = torso(h(0.81));
    const jx = jk ? h(jk.kind === 'leather' || jk.kind === 'bomber' ? 0.02 : 0.017) : 0; // clear the jacket
    const shoulderCover = shoulderX + h(0.03) + jx;
    const yTopD = headC.y - hr.y * 0.9;
    const duv: UvFn = (u, p) => cellUV(CELL.hijab, u, 1 - 0.7 * clamp((p.y - yBot) / (yTopD - yBot), 0, 1));
    const specs: [number, number, number, number, number, Bind, number][] = [
      [yBot, Math.max(sBot.rx + h(0.012) + jx, shoulderCover * 0.92), sBot.rzf + h(0.014) + jx, sBot.rzb + h(0.011) + jx, 0, BONE.chest, 1],
      [h(0.81), Math.max(s81.rx + h(0.014) + jx, shoulderCover), s81.rzf + h(0.018) + jx, s81.rzb + h(0.014) + jx, 0, BONE.chest, 0.7],
      [h(0.838), neckR + h(0.024), neckR + h(0.028), neckR + h(0.02), neckZ, blend(BONE.neck, BONE.head, 0.4), 0.3],
      [yTopD, hr.x * 0.82, hr.zf * 0.58, hr.zb * 0.72, headC.z + h(0.004), BONE.head, 0],
    ];
    const ringsD = specs.map(([y, rx, rzf, rzb, cz, b, k]) => {
      const rr = ring(y, rx, rzf, rzb, (az, p) => mul(jitter(hc, p, 0.03), (k === 1 ? 0.9 : 0.97) - 0.1 * Math.max(0, Math.sin(az * 6 + 1)) * k), b, R.silk, { cz, sq: k > 0.5 ? 2.25 : 2.1, uv: duv });
      if (k > 0.5) {
        const dy = (az: number) => -drop * Math.pow(Math.max(0, Math.cos(az)), 1.5) * k - h(0.012) * k;
        rr.dy = dy;
        // the front hangs lower, over the bust: grow the radius by how much the body widens there
        rr.dr = (az) => {
          const c = Math.max(0, Math.cos(az));
          return h(0.007) * Math.sin(az * 6 + 1) * k + Math.max(0, torso(y + dy(az)).rzf - torso(y).rzf) * c;
        };
      }
      return rr;
    });
    const b0 = ringsD[0];
    const lipD = ring(b0.y + h(0.006), b0.rx - h(0.006), b0.rzf - h(0.006), b0.rzb - h(0.006), mul(hc, 0.55), BONE.chest, R.silk, { sq: 2.2, uv: duv });
    lipD.dy = b0.dy; lipD.dr = b0.dr;
    loft(bd, [lipD, ...ringsD], 16);
  }
  if (t.headwear === 'chechia') {
    const y0 = headC.y + hr.y * 0.42, y1 = headC.y + hr.y + h(0.012);
    const rx0 = hr.x * 0.93 + h(0.004), rz0 = (hr.zf + hr.zb) * 0.45 + h(0.004);
    const cc = t.headwearColor;
    const rows = [[y0 - h(0.004), 0.97, 0.7], [y0, 1, 0.85], [lerp(y0, y1, 0.5), 1.0, 0.95], [y1 - h(0.008), 0.97, 1], [y1 - h(0.002), 0.9, 0.97], [y1, 0.72, 0.95]] as const;
    loft(bd, rows.map(([y, k, shd]) => ring(y, rx0 * k, rz0 * k, rz0 * k, (_az, p) => mul(jitter(cc, p, 0.04), shd), BONE.head, R.felt, { cz: headC.z - h(0.004), uv: (u, p) => cellUV(CELL.knit, u, (p.y - y0) / (y1 - y0) * 0.3 + 0.35) })), 16, { capEnd: true });
    topY = y1;
  }
  if (t.headwear === 'cap') {
    // flat cap (casquette): a soft crown that slopes down to the front and overhangs a short brim
    const cc = t.headwearColor;
    const cuv: UvFn = (u, p) => cellUV(CELL.hijab, u, 0.4 + 0.5 * clamp((p.y - headC.y) / hr.y, 0, 1));
    const e = h(0.005);
    // [y, front drop, x scale, front, back, forward shift] in head radii
    const rows = [[0.36, 0.16, 1.0, 1.0, 1.0, 0], [0.62, 0.3, 1.0, 1.12, 0.92, 0.08], [0.86, 0.42, 0.93, 1.2, 0.74, 0.16], [1.07, 0.44, 0.7, 0.95, 0.48, 0.18], [1.11, 0.44, 0.34, 0.45, 0.22, 0.18]] as const;
    loft(bd, rows.map(([y, drop, kx, kf, kb, fz]) => {
      const rr = ring(headC.y + y * hr.y, hr.x * kx + e, hr.zf * kf + e, hr.zb * kb + e, (_az, p) => mul(jitter(cc, p, 0.04), 0.82 + 0.18 * smooth(headC.y, headC.y + hr.y, p.y)), BONE.head, R.felt, { cz: headC.z + fz * hr.zf, uv: cuv });
      rr.dy = (az) => -drop * hr.y * Math.max(0, Math.cos(az));
      return rr;
    }), 12, { capEnd: true });
    ellipsoid(bd, new Vector3(0, headC.y + 0.2 * hr.y, headC.z + hr.zf * 0.98), hr.x * 0.76, h(0.0038), hr.zf * 0.42, 10, 3, mul(cc, 0.72), BONE.head, R.felt, undefined, 2, cuv);
    topY = headC.y + hr.y * 1.11;
  }
  part('headwear');

  // ------------------------------------------------------------------ collars, tie, hood
  const collarUp = (p: Vector3) => new Vector3(p.x, 0.35 * neckR, p.z - neckZ).normalize();
  const jacketCollar = !!jk && (jk.kind === 'leather' || jk.kind === 'bomber' || jk.kind === 'denim') && !covered;
  if (top.collar && !covered && !jacketCollar) {
    const pts: Vector3[] = [];
    for (let i = 0; i <= 8; i++) {
      const az = lerp(0.32, Math.PI * 2 - 0.32, i / 8);
      const fr = Math.max(0, Math.cos(az));
      const rr = neckR + h(0.006);
      pts.push(new Vector3(Math.sin(az) * rr * (1 + 0.25 * fr), h(0.828) - h(0.022) * Math.pow(fr, 3), neckZ + Math.cos(az) * rr * (1 + 0.35 * fr)));
    }
    sweep(bd, pts, (i) => collarUp(pts[i]), h(0.0105), h(0.0014), mul(topColor, 0.97), BONE.chest, topRough);
  }
  if (jk && jacketCollar) {
    const pts: Vector3[] = [];
    for (let i = 0; i <= 8; i++) {
      const az = lerp(0.5, Math.PI * 2 - 0.5, i / 8);
      const rr = neckR + h(0.018);
      pts.push(new Vector3(Math.sin(az) * rr * 1.15, h(0.82), neckZ - h(0.004) + Math.cos(az) * rr * 1.2));
    }
    sweep(bd, pts, (i) => collarUp(pts[i]), h(jk.kind === 'bomber' ? 0.008 : 0.012), h(0.0025), mul(jk.color, 0.9), BONE.chest, jkRough);
  }
  if (t.tie) {
    const tie = t.tie;
    const ys = [0.812, 0.8, 0.76, 0.68, 0.612];
    const pts = ys.map((y) => torsoSurf(h(y), 0, h(0.0035), true));
    pts[0].z += h(0.004);
    sweep(bd, pts, () => new Vector3(0, 0, 1), (i) => h(i === 0 ? 0.008 : i === 1 ? 0.0065 : lerp(0.008, 0.015, (i - 1) / 3)), h(0.002), (i) => mul(tie, i === 0 ? 0.85 : 1), BONE.chest, 0.5);
  }
  if (top.kind === 'hoodie' && !covered && !t.backpack) {
    const c = new Vector3(0, h(0.805), -torso(h(0.8)).rzb - h(0.012));
    ellipsoid(bd, c, h(0.07), h(0.028), h(0.03), 12, 4, mul(topColor, 0.85), BONE.chest, topRough, undefined, 2, (u, p) => cellUV(CELL.hoodie, u, 0.95 + (p.y - c.y) / h(0.5)));
  }
  part('collar');

  // ------------------------------------------------------------------ backpack
  if (t.backpack) {
    const bc = t.backpack;
    const back = torso(h(0.7)).rzb + (jk ? h(0.015) : h(0.008));
    const depth = h(0.034), bw = h(0.078) * (0.9 + 0.1 * W);
    const cz = -back - depth;
    const rows = [[0.582, 0.8, 0.7], [0.592, 1, 1], [0.68, 1, 1.02], [0.76, 1, 1], [0.785, 0.85, 0.8], [0.795, 0.55, 0.5]] as const;
    const buv: UvFn = (u, p) => cellUV(CELL.bag, u, span(0.585, 0.795, p.y));
    loft(bd, rows.map(([y, k, kd]) => ring(h(y), bw * k, depth * kd * 1.05, depth * kd, (_az, p) => mul(jitter(bc, p, 0.03), p.y < h(0.6) ? 0.78 : 1), blend(BONE.spine, BONE.chest, smooth(0.6, 0.7, y)), 0.66, { cz, sq: 4, uv: buv })), 8, { capStart: true, capEnd: true });
    for (const s of [1, -1] as const) {
      const x = s * (neckR + h(0.028));
      const pts: Vector3[] = [];
      for (const y of [0.64, 0.7, 0.75, 0.785]) { const az = s * lerp(1.15, 0.62, smooth(0.64, 0.785, y)); pts.push(torsoSurf(h(y), az, h(0.004))); }
      pts.push(new Vector3(x, h(0.828), -h(0.005)));
      pts.push(torsoSurf(h(0.79), s * (Math.PI - 0.55), h(0.004)));
      pts.push(new Vector3(x * 0.9, h(0.775), cz + depth * 0.4));
      sweep(bd, pts, (i) => (i === 4 ? new Vector3(0, 1, 0) : new Vector3(pts[i].x * 0.3, 0, pts[i].z).normalize()), h(0.011), h(0.0022), mul(bc, 0.8), BONE.chest, 0.66);
    }
    part('backpack');
  }

  // ------------------------------------------------------------------ carried bag (left hand)
  if (t.carry) {
    const g = J[BONE.bag];
    const c = t.carry.color;
    const k = t.carry.kind;
    const [bw, bh, bdp, handle] = k === 'briefcase' ? [0.4, 0.3, 0.085, 0.03] : k === 'handbag' ? [0.27, 0.2, 0.1, 0.09] : k === 'paper' ? [0.28, 0.32, 0.14, 0.07] : [0.3, 0.36, 0.1, 0.08];
    const yTop = g.y - handle - 0.01, yBot = yTop - bh;
    const cx = g.x + 0.012 + bdp * 0.5;
    const rough = k === 'briefcase' || k === 'handbag' ? R.leather : k === 'paper' ? 0.9 : R.plastic;
    const col: Paint<RGB> = (_az, p) => mul(jitter(c, p, k === 'paper' ? 0.08 : 0.04), 0.82 + 0.18 * smooth(yBot, yTop, p.y) + (k === 'paper' && p.y > yTop - 0.04 ? 0.06 : 0));
    // bag body: wide along Z (walking direction), thin along X
    const rows = [[yBot, 0.92], [yBot + 0.01, 1], [yTop - 0.012, 1], [yTop, 0.94]] as const;
    loft(bd, rows.map(([y, kk]) => ring(y, bdp * 0.5 * kk * (k === 'shopping' && y > yTop - 0.05 ? 0.6 : 1), bw * 0.5 * kk, bw * 0.5 * kk, col, BONE.bag, rough, { cx, cz: g.z, sq: k === 'briefcase' ? 6 : 4 })), 8, { capStart: true, capEnd: true });
    // handles: arches from the bag top up into the fist
    const arches = k === 'briefcase' ? [0] : [-0.004, 0.004];
    for (const dx of arches) {
      const pts: Vector3[] = [];
      const half = k === 'briefcase' ? 0.06 : bw * 0.28;
      for (let i = 0; i <= 3; i++) {
        const a = (i / 3) * Math.PI;
        pts.push(new Vector3(cx + dx + (g.x - cx) * Math.sin(a), yTop + (g.y - yTop) * Math.sin(a), g.z - half * Math.cos(a)));
      }
      sweep(bd, pts, () => new Vector3(1, 0, 0), 0.006, 0.002, k === 'shopping' ? mul(c, 0.95) : mul(c, 0.7), BONE.bag, rough);
    }
    part('bag');
  }

  // ------------------------------------------------------------------ glasses
  if (t.glasses !== 'none') {
    const frame: RGB = t.glasses === 'sun' ? [0.02, 0.02, 0.02] : r() < 0.5 ? [0.03, 0.025, 0.02] : [0.25, 0.14, 0.06];
    const bridge: Vector3[] = [];
    for (const s of [1, -1] as const) {
      const c = hp(FACE.eye.th, s * FACE.eye.ph, h(0.007));
      const loop: Vector3[] = [];
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + Math.PI / 2;
        loop.push(new Vector3(c.x + Math.cos(a) * h(0.0165), c.y + Math.sin(a) * h(0.0115), c.z - Math.max(0, s * Math.cos(a)) * h(0.004)));
      }
      sweep(bd, loop, () => new Vector3(0, 0, 1), h(0.0012), h(0.0012), frame, BONE.head, 0.3, true);
      if (t.glasses === 'sun') disc(bd, c.clone().add(new Vector3(0, 0, h(0.001))), new Vector3(0, 0, 1), h(0.016), h(0.0112), 8, [0.012, 0.014, 0.016], [0.02, 0.022, 0.025], BONE.head, 0.05);
      const outer = new Vector3(c.x + s * h(0.0165), c.y + h(0.003), c.z - h(0.004));
      const ear = hp(1.64, s * 1.45, h(0.004));
      sweep(bd, [outer, ear], () => new Vector3(s, 0, 0), h(0.0012), h(0.001), frame, BONE.head, 0.3);
      bridge.push(new Vector3(c.x - s * h(0.0165), c.y + h(0.004), c.z + h(0.001)));
    }
    sweep(bd, bridge, () => new Vector3(0, 0, 1), h(0.0012), h(0.001), frame, BONE.head, 0.3);
    part('glasses');
  }

  // ------------------------------------------------------------------ hand props (hidden by bone scale until used)
  {
    const g = J[BONE.cup];
    const cz = g.z + h(0.02);
    // espresso cup beside the fist; its bone is kept upright by the animator
    const rows = [[-0.032, 0.022], [-0.026, 0.028], [0.022, 0.034], [0.017, 0.03]] as const;
    loft(bd, rows.map(([dy, rr], i) => ring(g.y + dy, rr, rr, rr, i === 3 ? [0.09, 0.05, 0.025] : [0.86, 0.85, 0.82], BONE.cup, R.porcelain, { cx: g.x, cz })), 6, { capStart: true, capEnd: true });
    // crumpled wrapper for litterbugs
    const tg = J[BONE.trash];
    const tc: RGB = r() < 0.5 ? rgb(0xd83a2a) : r() < 0.5 ? rgb(0xe8c23a) : [0.85, 0.85, 0.82];
    const tr = ellipsoidRings(tg.clone().add(new Vector3(0, 0, h(0.01))), 0.03, 0.026, 0.028, 3, (az, p) => mul(tc, 0.75 + 0.35 * hash3(p.x * 90, p.y * 90, az)), BONE.trash, 0.55);
    tr.forEach((rr, i) => { rr.rx *= 1 + 0.25 * Math.sin(i * 2.1); rr.rzf *= 1 - 0.2 * Math.cos(i * 1.7); });
    loft(bd, tr, 4, { capStart: true, capEnd: true });
    part('props');
  }

  const dims: Dims = { H, hipY, kneeY, ankleY, thigh: hipY - kneeY, shin: kneeY - ankleY, footLen, top: topY };
  return { builder: bd, joints: J, dims, parts };
}
