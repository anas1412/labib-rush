// Accumulates vertices for one skinned material group (fur / cloth / gloss) and turns them into a
// BufferGeometry. Every vertex carries: colour (linear), up to 4 bone weights, a fur descriptor and a
// fur "comb" direction (used by the fur shell shader), plus a UV into the group's texture atlas.
import { BufferAttribute, BufferGeometry, Color, Vector3 } from 'three';
import type { RawMesh } from './sdf';
import { NB } from './rig';

/** Per-vertex output written by attribute callbacks. Reused, never reallocated. */
export class VAttr {
  r = 1; g = 1; b = 1;
  u = 0.25; v = 0.25;
  /** fur length (m), ear glow mask, tip whitening 0..1 */
  furLen = 0; ear = 0; tipWhite = 0;
  comb = new Vector3();
  /** bone weight accumulator (unnormalised) */
  readonly w = new Float32Array(NB);
  reset(): void {
    this.r = this.g = this.b = 1;
    this.u = this.v = 0.25;
    this.furLen = this.ear = this.tipWhite = 0;
    this.comb.set(0, 0, 0);
    this.w.fill(0);
  }
  color(c: Color): this {
    this.r = c.r; this.g = c.g; this.b = c.b;
    return this;
  }
  /** Mixes the current colour toward c by t. */
  mix(c: Color, t: number): this {
    if (t <= 0) return this;
    if (t > 1) t = 1;
    this.r += (c.r - this.r) * t; this.g += (c.g - this.g) * t; this.b += (c.b - this.b) * t;
    return this;
  }
  scale(s: number): this {
    this.r *= s; this.g *= s; this.b *= s;
    return this;
  }
}

/**
 * Soft skinning by nearest primitive: each candidate (distance, bone) gets exp(-(d - dmin)/k).
 * Adjacent primitives blend smoothly at joints, far ones contribute nothing.
 */
export class SoftLabel {
  private n = 0;
  private readonly d = new Float32Array(24);
  private readonly b = new Int32Array(24);
  private readonly k = new Float32Array(24);
  clear(): this { this.n = 0; return this; }
  add(dist: number, bone: number, k = 0.012): this {
    this.d[this.n] = dist; this.b[this.n] = bone; this.k[this.n] = k; this.n++;
    return this;
  }
  resolve(w: Float32Array, scale = 1): void {
    let dmin = Infinity;
    for (let i = 0; i < this.n; i++) dmin = Math.min(dmin, this.d[i]);
    let sum = 0;
    for (let i = 0; i < this.n; i++) sum += Math.exp(-(this.d[i] - dmin) / this.k[i]);
    for (let i = 0; i < this.n; i++) w[this.b[i]] += (scale * Math.exp(-(this.d[i] - dmin) / this.k[i])) / sum;
  }
}

/** One material group as plain typed arrays (worker → main thread). */
export interface GroupData {
  position: Float32Array; normal: Float32Array; color: Float32Array; uv: Float32Array;
  aFur: Float32Array; aComb: Float32Array; skinIndex: Uint16Array; skinWeight: Float32Array;
  index: Uint16Array | Uint32Array;
}

const ITEM: Record<Exclude<keyof GroupData, 'index'>, number> = { position: 3, normal: 3, color: 3, uv: 2, aFur: 3, aComb: 3, skinIndex: 4, skinWeight: 4 };

export function toGeometry(d: GroupData): BufferGeometry {
  const g = new BufferGeometry();
  for (const k of Object.keys(ITEM) as (keyof typeof ITEM)[]) g.setAttribute(k, new BufferAttribute(d[k], ITEM[k]));
  g.setIndex(new BufferAttribute(d.index, 1));
  return g;
}

/** Transferable buffers of a group (for postMessage). */
export function buffersOf(d: GroupData): ArrayBuffer[] {
  return Object.values(d).map((a: Float32Array | Uint16Array | Uint32Array) => a.buffer as ArrayBuffer);
}

export type AttribFn = (x: number, y: number, z: number, nx: number, ny: number, nz: number, o: VAttr) => void;

export class GroupBuilder {
  private pos: number[] = [];
  private nrm: number[] = [];
  private col: number[] = [];
  private uv: number[] = [];
  private fur: number[] = [];
  private comb: number[] = [];
  private si: number[] = [];
  private sw: number[] = [];
  private idx: number[] = [];
  private readonly a = new VAttr();

  get vertexCount(): number { return this.pos.length / 3; }

  /** Adds a mesh; `mirror` reflects it across x = 0 (the attribute callback sees the ORIGINAL side). */
  add(mesh: RawMesh, attrib: AttribFn, opts: { mirror?: boolean; remap?: (bone: number) => number } = {}): void {
    const base = this.vertexCount;
    const { positions: p, normals: n } = mesh;
    const a = this.a;
    const m = opts.mirror ? -1 : 1;
    for (let i = 0; i < p.length; i += 3) {
      a.reset();
      attrib(p[i], p[i + 1], p[i + 2], n[i], n[i + 1], n[i + 2], a);
      this.pos.push(p[i] * m, p[i + 1], p[i + 2]);
      this.nrm.push(n[i] * m, n[i + 1], n[i + 2]);
      this.col.push(a.r, a.g, a.b);
      this.uv.push(a.u, a.v);
      this.fur.push(a.furLen, a.ear, a.tipWhite);
      this.comb.push(a.comb.x * m, a.comb.y, a.comb.z);
      this.pushWeights(a.w, opts.remap);
    }
    const ix = mesh.indices;
    for (let i = 0; i < ix.length; i += 3) {
      if (opts.mirror) this.idx.push(base + ix[i], base + ix[i + 2], base + ix[i + 1]);
      else this.idx.push(base + ix[i], base + ix[i + 1], base + ix[i + 2]);
    }
  }

  private pushWeights(w: Float32Array, remap?: (bone: number) => number): void {
    // top 4 bones
    const bi = [0, 0, 0, 0];
    const bw = [0, 0, 0, 0];
    for (let b = 0; b < w.length; b++) {
      const v = w[b];
      if (v <= bw[3]) continue;
      let j = 3;
      while (j > 0 && v > bw[j - 1]) { bw[j] = bw[j - 1]; bi[j] = bi[j - 1]; j--; }
      bw[j] = v; bi[j] = b;
    }
    const s = bw[0] + bw[1] + bw[2] + bw[3] || 1;
    for (let j = 0; j < 4; j++) this.si.push(remap ? remap(bi[j]) : bi[j]);
    for (let j = 0; j < 4; j++) this.sw.push(bw[j] / s);
  }

  /** Packs the group into transferable typed arrays (see `toGeometry`). */
  pack(index?: number[]): GroupData {
    const idx = index ?? this.idx;
    return {
      position: new Float32Array(this.pos),
      normal: new Float32Array(this.nrm),
      color: new Float32Array(this.col),
      uv: new Float32Array(this.uv),
      aFur: new Float32Array(this.fur),
      aComb: new Float32Array(this.comb),
      skinIndex: new Uint16Array(this.si),
      skinWeight: new Float32Array(this.sw),
      index: this.vertexCount > 65535 ? new Uint32Array(idx) : new Uint16Array(idx),
    };
  }

  /** Triangles that carry fur (any vertex with furLen > 0) — the fur shell index. */
  furIndex(): number[] {
    const out: number[] = [];
    const f = this.fur;
    for (let i = 0; i < this.idx.length; i += 3) {
      const a = this.idx[i], b = this.idx[i + 1], c = this.idx[i + 2];
      if (f[a * 3] > 0 || f[b * 3] > 0 || f[c * 3] > 0) out.push(a, b, c);
    }
    return out;
  }
}

/** Builds a RawMesh from a (rows × cols) parametric grid; cols wrap around when `wrap` is set. */
export function gridMesh(rows: number, cols: number, wrap: boolean, fn: (r: number, c: number, out: Vector3) => void, flip = false): RawMesh {
  const cc = wrap ? cols : cols + 1;
  const positions = new Float32Array((rows + 1) * cc * 3);
  const v = new Vector3();
  for (let r = 0; r <= rows; r++)
    for (let c = 0; c < cc; c++) {
      fn(r, c, v);
      positions.set([v.x, v.y, v.z], (r * cc + c) * 3);
    }
  const idx: number[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const c1 = wrap ? (c + 1) % cols : c + 1;
      const a = r * cc + c, b = r * cc + c1, d = (r + 1) * cc + c, e = (r + 1) * cc + c1;
      if (flip) idx.push(a, b, d, b, e, d);
      else idx.push(a, d, b, b, d, e);
    }
  const indices = new Uint32Array(idx);
  return { positions, normals: computeNormals(positions, indices), indices };
}

/** Area-weighted smooth vertex normals. */
export function computeNormals(p: Float32Array, idx: Uint32Array): Float32Array {
  const n = new Float32Array(p.length);
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    for (const k of [a, b, c]) { n[k] += fx; n[k + 1] += fy; n[k + 2] += fz; }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
  }
  return n;
}

/** Hex sRGB → linear Color. */
export const col = (hex: number): Color => new Color(hex);
