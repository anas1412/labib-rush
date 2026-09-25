// Planting for the landmark grounds as alpha-tested cards in the shared sign atlas (no extra
// draw call): date-palm fronds, leafy shrub clumps and flower clumps. Cards are two-sided (each
// triangle duplicated with reversed winding) because the atlas material is single-sided.
import { BufferAttribute, BufferGeometry, Vector3 } from 'three';
import { remapUV, type Region, type SignAtlas } from './env';

type Paint = (c: CanvasRenderingContext2D, p: CanvasRenderingContext2D, w: number, h: number) => void;

/** Deterministic 0..1 generator. */
function rng(seed: number): () => number {
  let s = (seed * 16807 + 11) % 2147483647 || 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

const LEAF_ROUGH = 'rgb(0,225,0)'; // roughness ≈ 0.88, non-metal: no glossy sheen on edge-on cards

/** Date-palm frond along x (base → tip), leaflets angled toward the tip on both sides. */
export const paintFrond: Paint = (c, p, W, H) => {
  const r = rng(7), mid = H / 2;
  const greens = ['#4d6a2b', '#5b7a34', '#3f5a24', '#66843b', '#55722f'];
  for (let x = 10; x < W - 6; x += 5.5) {
    const t = x / W, len = mid * 0.96 * Math.sin(Math.PI * Math.min(1, t * 1.05 + 0.06));
    for (const s of [-1, 1]) {
      const l = len * (0.85 + 0.15 * r());
      c.strokeStyle = t > 0.85 && r() < 0.5 ? '#8a8a45' : greens[Math.floor(r() * greens.length)];
      c.lineWidth = 3.2 - 1.6 * t;
      c.beginPath();
      c.moveTo(x, mid);
      c.quadraticCurveTo(x + l * 0.25, mid + s * l * 0.55, x + l * 0.62, mid + s * l);
      c.stroke();
    }
  }
  c.strokeStyle = '#7d7444'; c.lineWidth = 5; c.beginPath(); c.moveTo(0, mid); c.lineTo(W, mid); c.stroke(); // rachis
  p.fillStyle = LEAF_ROUGH; p.fillRect(0, 0, W, H);
};

/** Leafy shrub clump: a dome of overlapping small leaves, darker inside, ragged edge. */
export const paintShrub: Paint = (c, p, W, H) => {
  const r = rng(3);
  for (let i = 0; i < 900; i++) {
    const a = Math.PI * r(), rad = Math.sqrt(r());
    const x = W / 2 + Math.cos(a) * rad * W * 0.48, y = H - Math.sin(a) * rad * H * 0.95;
    const depth = 1 - rad; // centre of the clump is shaded
    const g = 70 + r() * 60 - depth * 40;
    c.fillStyle = `rgb(${(g * 0.55) | 0},${g | 0},${(g * 0.35) | 0})`;
    c.beginPath(); c.ellipse(x, y, 5 + r() * 4, 3 + r() * 2.5, r() * Math.PI, 0, Math.PI * 2); c.fill();
  }
  p.fillStyle = LEAF_ROUGH; p.fillRect(0, 0, W, H);
};

/** Flower clump: leafy base with blossoms on top in the given colours. */
export function paintFlowers(colors: string[], seed: number): Paint {
  return (c, p, W, H) => {
    const r = rng(seed);
    for (let i = 0; i < 260; i++) { // foliage
      const x = W * (0.05 + 0.9 * r()), y = H * (0.45 + 0.55 * Math.pow(r(), 0.7));
      const g = 60 + r() * 55;
      c.fillStyle = `rgb(${(g * 0.5) | 0},${g | 0},${(g * 0.3) | 0})`;
      c.beginPath(); c.ellipse(x, y, 5 + r() * 4, 2.5 + r() * 2, r() * Math.PI, 0, Math.PI * 2); c.fill();
    }
    for (let i = 0; i < 26; i++) { // blossoms: petals round a darker eye
      const x = W * (0.1 + 0.8 * r()), y = H * (0.15 + 0.45 * r()), R = 6 + r() * 5;
      c.fillStyle = colors[Math.floor(r() * colors.length)];
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * Math.PI * 2 + r();
        c.beginPath(); c.ellipse(x + Math.cos(a) * R * 0.55, y + Math.sin(a) * R * 0.45, R * 0.55, R * 0.38, a, 0, Math.PI * 2); c.fill();
      }
      c.fillStyle = '#5a3a14'; c.beginPath(); c.arc(x, y, R * 0.22, 0, Math.PI * 2); c.fill();
    }
    p.fillStyle = LEAF_ROUGH; p.fillRect(0, 0, W, H);
  };
}

/** Non-indexed two-sided geometry from triangles (positions + 0..1 UVs), UVs mapped into `r`. */
function twoSided(pos: number[], uv: number[], r: Region): BufferGeometry {
  const n = pos.length / 9;
  const P = new Float32Array(pos.length * 2), U = new Float32Array(uv.length * 2);
  P.set(pos); U.set(uv);
  for (let t = 0; t < n; t++) {
    for (const [k, src] of [[0, 0], [1, 2], [2, 1]]) { // reversed winding
      P.set(pos.slice((t * 3 + src) * 3, (t * 3 + src) * 3 + 3), pos.length + (t * 3 + k) * 3);
      U.set(uv.slice((t * 3 + src) * 2, (t * 3 + src) * 2 + 2), uv.length + (t * 3 + k) * 2);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(P, 3));
  g.setAttribute('uv', new BufferAttribute(U, 2));
  remapUV(g, r);
  g.computeVertexNormals();
  return g;
}

/** Quad strip helper: rows of [left, centre, right] points with v = 0, 0.5, 1 across. */
function strip(rows: Vector3[][], pos: number[], uv: number[]): void {
  for (let i = 0; i < rows.length - 1; i++) {
    const u0 = i / (rows.length - 1), u1 = (i + 1) / (rows.length - 1);
    for (let j = 0; j < 2; j++) {
      const a = rows[i][j], b = rows[i + 1][j], c = rows[i + 1][j + 1], d = rows[i][j + 1];
      const v0 = j / 2, v1 = (j + 1) / 2;
      pos.push(...a.toArray(), ...b.toArray(), ...c.toArray(), ...a.toArray(), ...c.toArray(), ...d.toArray());
      uv.push(u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1);
    }
  }
}

/**
 * Crown of `n` arching fronds (length ~L, width w) round the origin: each a V-folded ribbon
 * (leaflets rise to both sides of the rachis) curving out and down under its own weight.
 */
export function palmCrown(r: Region, n: number, L: number, w: number): BufferGeometry {
  const pos: number[] = [], uv: number[] = [];
  for (let f = 0; f < n; f++) {
    const az = (f / n) * Math.PI * 2 + (f % 2) * 0.2;
    const up = 0.75 - (f % 3) * 0.45; // some rise, some droop
    const len = L * (0.85 + 0.1 * (f % 4));
    const dir = new Vector3(Math.cos(az), 0, Math.sin(az)), side = new Vector3(-Math.sin(az), 0, Math.cos(az));
    const rows: Vector3[][] = [];
    for (let i = 0; i <= 10; i++) {
      const t = i / 10, d = t * len;
      const c = dir.clone().multiplyScalar(d * Math.cos(up)).setY(Math.sin(up) * d - 0.45 * d * d / len);
      const hw = (w / 2) * (0.35 + 0.65 * Math.sin(Math.PI * Math.min(1, t * 1.05 + 0.06)));
      const lift = hw * 0.35; // V fold
      rows.push([c.clone().addScaledVector(side, -hw).setY(c.y + lift), c, c.clone().addScaledVector(side, hw).setY(c.y + lift)]);
    }
    strip(rows, pos, uv);
  }
  return twoSided(pos, uv, r);
}

/** `n` vertical cards crossed at equal angles through the origin (w wide, h tall, base at y 0). */
export function crossCards(r: Region, w: number, h: number, n = 3, rot = 0): BufferGeometry {
  const pos: number[] = [], uv: number[] = [];
  for (let k = 0; k < n; k++) {
    const a = rot + (k / n) * Math.PI, dx = Math.cos(a) * w / 2, dz = Math.sin(a) * w / 2;
    const rows = [0, 1].map((t) => {
      const y = t * h;
      return [new Vector3(-dx, y, -dz), new Vector3(0, y, 0), new Vector3(dx, y, dz)];
    });
    strip(rows, pos, uv);
  }
  // strip() runs u up the card and v across it; the atlas cell wants u across, v up: swap
  for (let i = 0; i < uv.length; i += 2) { const u = uv[i]; uv[i] = uv[i + 1]; uv[i + 1] = u; }
  return twoSided(pos, uv, r);
}

/** Reserves the atlas cells used by the landmark planting (call once, share the regions). */
export function plantCells(signs: SignAtlas) {
  return {
    frond: signs.draw(512, 160, paintFrond),
    shrub: signs.draw(256, 160, paintShrub),
    flowers: [
      signs.draw(160, 128, paintFlowers(['#c8102e', '#e03a52', '#a0132a'], 5)),
      signs.draw(160, 128, paintFlowers(['#f2f2ea', '#f06ca0', '#ffffff'], 9)),
      signs.draw(160, 128, paintFlowers(['#d9a21b', '#e8c22a', '#c8102e'], 13)),
    ],
  };
}
export type PlantCells = ReturnType<typeof plantCells>;
