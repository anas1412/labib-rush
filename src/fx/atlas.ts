// Procedural sprite atlas for the particles: 4 × 2 cells of 128 px, generated per pixel at startup
// (≈10 ms). RGB is a shading multiplier (white = use the particle colour as is), A is the mask.
// Built as raw pixel data rather than canvas drawing so RGB stays un-premultiplied at soft edges.
import { ClampToEdgeWrapping, DataTexture, LinearFilter, LinearMipmapLinearFilter, RGBAFormat, UnsignedByteType } from 'three';

export const SHAPE = { glow: 0, flare: 1, puff: 2, star: 3, ring: 4, streak: 5, leaf: 6, rect: 7 } as const;
export const ATLAS_COLS = 4;
export const ATLAS_ROWS = 2;
const CELL = 128;
const PAD = 3; // px of empty border per cell so mip levels don't bleed between shapes

type ShapeFn = (x: number, y: number) => [shade: number, alpha: number];

// --- tiny value noise for the smoke puff
const hash = (x: number, y: number) => {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
};
function vnoise(x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const fbm = (x: number, y: number) => 0.5 * vnoise(x, y) + 0.25 * vnoise(x * 2.1, y * 2.1) + 0.125 * vnoise(x * 4.3, y * 4.3) + 0.0625 * vnoise(x * 8.7, y * 8.7);

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a: number, b: number, v: number) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const AA = 2.5 / CELL; // antialiasing width in cell units (−1..1 spans the cell)

/** Inigo Quilez' exact 5-point star SDF (r = outer radius, rf = inner ratio). */
function sdStar5(px: number, py: number, r: number, rf: number): number {
  const k1x = 0.809016994375, k1y = -0.587785252292, k2x = -k1x, k2y = k1y;
  px = Math.abs(px);
  let d = 2 * Math.max(k1x * px + k1y * py, 0); px -= d * k1x; py -= d * k1y;
  d = 2 * Math.max(k2x * px + k2y * py, 0); px -= d * k2x; py -= d * k2y;
  px = Math.abs(px);
  py -= r;
  const bax = rf * -k1y, bay = rf * k1x - 1;
  const h = Math.min(Math.max((px * bax + py * bay) / (bax * bax + bay * bay), 0), r);
  const dx = px - bax * h, dy = py - bay * h;
  return Math.hypot(dx, dy) * Math.sign(py * bax - px * bay);
}

const SHAPES: ShapeFn[] = [
  // glow: hot core inside a gaussian halo
  (x, y) => { const r2 = x * x + y * y; return [1, clamp01(0.62 * Math.exp(-r2 * 5.5) + 0.38 * Math.exp(-r2 * 38))]; },
  // flare: 4-point sparkle — bright core, long thin cross rays, short diagonal rays
  (x, y) => {
    const r2 = x * x + y * y, ax = Math.abs(x), ay = Math.abs(y);
    const ray = (a: number, b: number, len: number) => Math.exp(-b * 48) * Math.max(0, 1 - a / len) ** 2.2;
    const u = Math.abs(x + y) * 0.7071, v = Math.abs(x - y) * 0.7071;
    const a = Math.exp(-r2 * 34) + ray(ax, ay, 1) + ray(ay, ax, 1) + 0.45 * (ray(u, v, 0.55) + ray(v, u, 0.55)) + 0.28 * Math.exp(-r2 * 7);
    return [1, clamp01(a)];
  },
  // puff: billowy smoke/dust blob with darker creases
  (x, y) => {
    const n = fbm(x * 2.6 + 3.1, y * 2.6 + 7.7);
    const r = Math.hypot(x, y) + (n - 0.5) * 0.55;
    const a = smooth(0.95, 0.15, r) * (0.55 + 0.45 * n);
    return [0.72 + 0.28 * fbm(x * 4 + 11, y * 4 + 5), clamp01(a)];
  },
  // star: chunky cartoon 5-point star with rounded tips, thin soft glow
  (x, y) => {
    const d = sdStar5(x, y + 0.07, 0.82, 0.48) - 0.07; // tip up, optically centred
    const body = smooth(AA, -AA, d);
    // darker rim so an alpha-blended gold star keeps its silhouette on sunlit sand
    return [0.58 + 0.42 * smooth(0.02, -0.28, d), clamp01(body + 0.35 * Math.exp(-Math.max(d, 0) * 16) * (1 - body))];
  },
  // ring: thin bright band with a soft outer bloom
  (x, y) => {
    const r = Math.hypot(x, y);
    return [1, clamp01(Math.exp(-(((r - 0.8) / 0.055) ** 2)) + 0.28 * Math.exp(-(((r - 0.78) / 0.2) ** 2)))];
  },
  // streak: long soft line along y (velocity-aligned speed lines / sparks)
  (x, y) => [1, clamp01(Math.exp(-((x / 0.22) ** 2)) * (1 - Math.abs(y)) ** 1.4 * (0.75 + 0.25 * Math.exp(-((x / 0.06) ** 2))))],
  // leaf: glossy ficus leaf — ovate with a drawn-out tip, midrib, faint veins, petiole
  (x, y) => {
    const s = (y + 0.92) / 1.84; // 0 base … 1 tip
    const w = s <= 0 || s >= 1 ? 0 : 0.43 * Math.sin(Math.PI * s ** 0.72) ** 0.85 * (1 - 0.55 * smooth(0.55, 1, s));
    const ax = Math.abs(x);
    let a = smooth(AA, -AA, ax - w);
    const petiole = s > -0.07 && s < 0.03 && ax < 0.028 ? 1 : 0;
    a = Math.max(a, petiole);
    const rib = Math.exp(-((x / 0.022) ** 2));
    const veins = 0.94 + 0.06 * Math.sin((s * 1.2 - ax * 1.6) * 38);
    const edge = 0.72 + 0.28 * smooth(0, 0.12, w - ax);
    return [clamp01((0.86 + 0.22 * rib) * veins * edge), a];
  },
  // rect: paper / foil / plastic scrap with faint crumple shading
  (x, y) => {
    const qx = Math.abs(x) - 0.3, qy = Math.abs(y) - 0.52, r = 0.06;
    const d = Math.hypot(Math.max(qx + r, 0), Math.max(qy + r, 0)) + Math.min(Math.max(qx + r, qy + r), 0) - r;
    return [0.88 + 0.12 * fbm(x * 5 + 2, y * 5 + 9), smooth(AA, -AA, d)];
  },
];

export function createAtlas(): DataTexture {
  const W = CELL * ATLAS_COLS, H = CELL * ATLAS_ROWS;
  const data = new Uint8Array(W * H * 4);
  const inner = CELL - 2 * PAD;
  SHAPES.forEach((fn, i) => {
    const cx = (i % ATLAS_COLS) * CELL, cy = Math.floor(i / ATLAS_COLS) * CELL;
    for (let py = 0; py < CELL; py++) {
      for (let px = 0; px < CELL; px++) {
        // DataTexture row 0 is v = 0 (bottom), so +y is up, matching the quad's uv
        const x = ((px - PAD + 0.5) / inner) * 2 - 1, y = ((py - PAD + 0.5) / inner) * 2 - 1;
        const inside = px >= PAD && py >= PAD && px < CELL - PAD && py < CELL - PAD;
        const [shade, alpha] = inside ? fn(x, y) : [1, 0];
        const o = ((cy + py) * W + cx + px) * 4;
        const s = Math.round(clamp01(shade) * 255);
        data[o] = s; data[o + 1] = s; data[o + 2] = s;
        data[o + 3] = Math.round(clamp01(alpha) * 255);
      }
    }
  });
  const tex = new DataTexture(data, W, H, RGBAFormat, UnsignedByteType);
  tex.wrapS = tex.wrapT = ClampToEdgeWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}
