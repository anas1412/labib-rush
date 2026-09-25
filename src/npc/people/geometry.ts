// Tiny procedural modelling kit for the crowd: every person is assembled from lofts (stacked
// superellipse rings), head-conforming shells and swept strips into ONE skinned geometry with
// vertex colours, a per-vertex roughness, atlas UVs (./atlas.ts) and ≤ 4 bone influences.
// UV seams (the back of every tube, cell changes at hems) duplicate vertices; "twins" get their
// normals averaged after computeVertexNormals so seams never show in the shading.
import { BufferGeometry, Float32BufferAttribute, Uint16BufferAttribute, Uint32BufferAttribute, Uint8BufferAttribute, Vector3, type Matrix4 } from 'three';
import type { RGB } from './traits';

/** Skin binding: one bone, [boneA, boneB, t] meaning (1 − t)·A + t·B, or up to 4 explicit influences. */
export type Bind = number | readonly [number, number, number] | { readonly b: readonly number[]; readonly w: readonly number[] };
export type Paint<T> = T | ((az: number, p: Vector3) => T);
/** Atlas coordinates for a surface point: u = fraction around the tube (0 = back, 0.5 = front). */
export type UvFn = (u: number, p: Vector3) => readonly [number, number];

export class Builder {
  private pos: number[] = [];
  private col: number[] = [];
  private rough: number[] = [];
  private uvs: number[] = [];
  private si: number[] = [];
  private sw: number[] = [];
  private idx: number[] = [];
  private twins: number[] = [];

  get vertexCount(): number { return this.pos.length / 3; }
  get triangleCount(): number { return this.idx.length / 3; }

  v(p: Vector3, c: RGB, b: Bind, r: number, uv: readonly [number, number] = NEUTRAL_UV): number {
    this.pos.push(p.x, p.y, p.z);
    this.col.push(c[0], c[1], c[2]);
    this.rough.push(r);
    this.uvs.push(uv[0], uv[1]);
    if (typeof b === 'number') { this.si.push(b, 0, 0, 0); this.sw.push(1, 0, 0, 0); }
    else if ('b' in b) {
      let sum = 0;
      for (let i = 0; i < 4; i++) sum += b.w[i] ?? 0;
      for (let i = 0; i < 4; i++) { this.si.push(b.b[i] ?? 0); this.sw.push((b.w[i] ?? 0) / sum); }
    } else { this.si.push(b[0], b[1], 0, 0); this.sw.push(1 - b[2], b[2], 0, 0); }
    return this.vertexCount - 1;
  }

  tri(a: number, b: number, c: number): void { this.idx.push(a, b, c); }

  /** Two vertices at the same spot that should shade as one (UV seam). */
  twin(a: number, b: number): void { this.twins.push(a, b); }

  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new Float32BufferAttribute(this.col, 3));
    g.setAttribute('uv', new Float32BufferAttribute(this.uvs, 2));
    g.setAttribute('aRough', new Uint8BufferAttribute(this.rough.map((r) => Math.round(r * 255)), 1, true));
    g.setAttribute('skinIndex', new Uint8BufferAttribute(this.si, 4));
    g.setAttribute('skinWeight', new Float32BufferAttribute(this.sw, 4));
    g.setIndex(this.vertexCount > 65535 ? new Uint32BufferAttribute(this.idx, 1) : new Uint16BufferAttribute(this.idx, 1));
    g.computeVertexNormals();
    const n = g.getAttribute('normal').array as Float32Array;
    for (let k = 0; k < this.twins.length; k += 2) {
      const a = this.twins[k] * 3, b = this.twins[k + 1] * 3;
      const x = n[a] + n[b], y = n[a + 1] + n[b + 1], z = n[a + 2] + n[b + 2];
      const l = Math.hypot(x, y, z) || 1;
      n[a] = n[b] = x / l; n[a + 1] = n[b + 1] = y / l; n[a + 2] = n[b + 2] = z / l;
    }
    return g;
  }
}

/** Where untextured parts point (atlas neutral cell centre; set by atlas.ts at import). */
export let NEUTRAL_UV: readonly [number, number] = [0, 0];
export const setNeutralUv = (uv: readonly [number, number]): void => { NEUTRAL_UV = uv; };

const eval_ = <T>(p: Paint<T>, az: number, v: Vector3): T => (typeof p === 'function' ? (p as (az: number, p: Vector3) => T)(az, v) : p);
const se = (v: number, e: number) => (e === 2 ? v : Math.sign(v) * Math.pow(Math.abs(v), 2 / e));

/** Overrides for the copy of a ring's vertices that connects DOWN to the previous ring (hem ledges). */
export interface RingBelow { uv: UvFn; col?: Paint<RGB>; rough?: number; smooth?: boolean }

/** One cross-section of a loft. Along = y for vertical lofts, z for 'z' lofts (feet). */
export interface Ring {
  y: number;
  cx: number;
  cz: number;
  rx: number;
  /** Radius toward az = 0 (front +Z; for 'z' lofts: up) and toward az = π (back; 'z': down). */
  rzf: number;
  rzb: number;
  sq: number; // superellipse exponent: 2 = ellipse, higher = boxier
  col: Paint<RGB>;
  bind: Paint<Bind>;
  rough: number;
  uv?: UvFn;
  below?: RingBelow;
  /** Optional per-vertex extra radius (lapels, folds) and height offset (curved hems). */
  dr?: (az: number) => number;
  dy?: (az: number) => number;
}

export const ring = (y: number, rx: number, rzf: number, rzb: number, col: Paint<RGB>, bind: Paint<Bind>, rough: number, o: Partial<Pick<Ring, 'cx' | 'cz' | 'sq' | 'uv'>> = {}): Ring =>
  ({ y, rx, rzf, rzb, col, bind, rough, cx: o.cx ?? 0, cz: o.cz ?? 0, sq: o.sq ?? 2, uv: o.uv });

export interface LoftOpts {
  capStart?: boolean;
  capEnd?: boolean;
  axis?: 'y' | 'z';
  /** Maps u ∈ [0,1] (0 = back, 0.5 = front) to an azimuth; default uniform. */
  azMap?: (u: number) => number;
  m?: Matrix4; // extra transform (rotation / translation / positive scale only)
}

const _p = new Vector3();

/** Point on a ring at azimuth az (0 = front / up, +π/2 = +X). */
export function ringPoint(r: Ring, az: number, axis: 'y' | 'z', out: Vector3, off = 0): Vector3 {
  const s = Math.sin(az), c = Math.cos(az);
  const a = r.cx + (r.rx + off) * se(s, r.sq);
  const b = r.cz + ((c >= 0 ? r.rzf : r.rzb) + off) * se(c, r.sq);
  return axis === 'y' ? out.set(a, r.y, b) : out.set(a, b, r.y);
}

const uniformAz = (u: number) => (u - 0.5) * Math.PI * 2;

/** Tube through rings (ordered along +axis). Walls face outward; caps optional. */
export function loft(bd: Builder, rings: readonly Ring[], segs: number, o: LoftOpts = {}): void {
  const axis = o.axis ?? 'y';
  const flip = axis === 'z';
  const azOf = o.azMap ?? uniformAz;
  const cols = segs + 1; // last column duplicates the first (u = 1 vs 0 at the back seam)
  const up: number[] = [], down: number[] = []; // first vertex index of each ring's up / down set
  const emit = (r: Ring, uv: UvFn | undefined, col: Paint<RGB>, rough: number): number => {
    const first = bd.vertexCount;
    for (let j = 0; j < cols; j++) {
      const u = j / segs;
      const az = azOf(u);
      ringPoint(r, az, axis, _p, r.dr ? r.dr(az) : 0);
      if (r.dy) _p.y += r.dy(az);
      if (o.m) _p.applyMatrix4(o.m);
      bd.v(_p, eval_(col, az, _p), eval_(r.bind, az, _p), rough, uv ? uv(u, _p) : NEUTRAL_UV);
    }
    bd.twin(first, first + segs);
    return first;
  };
  for (const r of rings) {
    const main = emit(r, r.uv, r.col, r.rough);
    up.push(main);
    if (r.below) {
      const b = emit(r, r.below.uv, r.below.col ?? r.col, r.below.rough ?? r.rough);
      down.push(b);
      if (r.below.smooth) for (let j = 0; j < cols; j++) bd.twin(main + j, b + j);
    } else down.push(main);
  }
  const t = (a: number, b: number, c: number) => (flip ? bd.tri(a, c, b) : bd.tri(a, b, c));
  for (let i = 0; i < rings.length - 1; i++) {
    const lo = up[i], hi = down[i + 1];
    for (let j = 0; j < segs; j++) {
      const a = lo + j, b = lo + j + 1, c = hi + j, d = hi + j + 1;
      t(a, b, c);
      t(b, d, c);
    }
  }
  const cap = (i: number, end: boolean) => {
    const r = rings[i];
    const base = end ? down[i] : up[i];
    _p.set(r.cx, r.y, r.cz);
    if (axis === 'z') _p.set(r.cx, r.cz, r.y);
    if (o.m) _p.applyMatrix4(o.m);
    const uv = end ? (r.below?.uv ?? r.uv) : r.uv;
    const cIdx = bd.v(_p, eval_(r.col, 0, _p), eval_(r.bind, 0, _p), r.rough, uv ? uv(0.5, _p) : NEUTRAL_UV);
    for (let j = 0; j < segs; j++) {
      if (end) t(cIdx, base + j, base + j + 1);
      else t(cIdx, base + j + 1, base + j);
    }
  };
  if (o.capStart) cap(0, false);
  if (o.capEnd) cap(rings.length - 1, true);
}

/** Rings approximating an ellipsoid (centre, radii) — for loft(). n ≥ 2 rings; caps close the poles. */
export function ellipsoidRings(c: Vector3, rx: number, ry: number, rz: number, n: number, col: Paint<RGB>, bind: Paint<Bind>, rough: number, sq = 2, uv?: UvFn): Ring[] {
  const out: Ring[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n; // avoid exact poles; loft caps close the ends
    const th = Math.PI * (1 - t); // bottom → top
    const s = Math.sin(th);
    out.push(ring(c.y + ry * Math.cos(th), rx * s, rz * s, rz * s, col, bind, rough, { cx: c.x, cz: c.z, sq, uv }));
  }
  return out;
}

/** Closed ellipsoid convenience. */
export function ellipsoid(bd: Builder, c: Vector3, rx: number, ry: number, rz: number, segs: number, n: number, col: Paint<RGB>, bind: Paint<Bind>, rough: number, m?: Matrix4, sq = 2, uv?: UvFn): void {
  loft(bd, ellipsoidRings(c, rx, ry, rz, n, col, bind, rough, sq, uv), segs, { capStart: true, capEnd: true, m });
}

/** Parametric head surface: θ from the crown (0) to under the chin (π), φ = 0 front, +π/2 = +X. */
export type HeadFn = (theta: number, phi: number, off: number, out: Vector3) => Vector3;

export interface ShellOpts {
  rows: number;
  segs: number;
  th0: (phi: number) => number; // start angle (0 = crown pole, shared vertex)
  th1: (phi: number) => number;
  off: (t: number, phi: number, theta: number) => number; // surface offset, t = 0..1 along rows
  col: (t: number, phi: number, theta: number, p: Vector3) => RGB;
  bind: Bind | ((t: number, phi: number) => Bind);
  rough: number;
  /** Atlas UV per vertex (t along rows, column fraction 0..1, φ, θ, position). Neutral if omitted. */
  uv?: (t: number, ju: number, phi: number, theta: number, p: Vector3) => readonly [number, number];
  /** Azimuth range; a full turn by default (closed, seam at the back). */
  phi0?: number;
  phi1?: number;
  /** Remaps the row parameter (denser rows where detail is). */
  rowMap?: (t: number) => number;
  /** Remaps the column parameter 0..1 across [phi0, phi1] (denser columns where detail is). */
  colMap?: (u: number) => number;
}

/** Grid over the head surface between θ0(φ) and θ1(φ). Hair, hijab, beard and the head itself.
 *  Returns the first / last column vertices (per row) and the crown pole so shells can be stitched. */
export function shell(bd: Builder, f: HeadFn, o: ShellOpts): { first: number[]; last: number[]; pole: number } {
  const closed = o.phi0 === undefined;
  const p0 = o.phi0 ?? -Math.PI, p1 = o.phi1 ?? Math.PI;
  const cols = o.segs + 1;
  const bindOf = (t: number, phi: number) => (typeof o.bind === 'function' ? o.bind(t, phi) : o.bind);
  const rowT = (i: number) => (o.rowMap ? o.rowMap(i / o.rows) : i / o.rows);
  // shared crown pole when every column starts at θ = 0
  const pole = o.th0(0) === 0 && o.th0(Math.PI / 2) === 0 && o.th0(Math.PI) === 0;
  let poleIdx = -1;
  if (pole) {
    f(0, 0, o.off(0, 0, 0), _p);
    poleIdx = bd.v(_p, o.col(0, 0, 0, _p), bindOf(0, 0), o.rough, o.uv ? o.uv(0, 0.5, 0, 0, _p) : NEUTRAL_UV);
  }
  const r0 = pole ? 1 : 0;
  const start = bd.vertexCount;
  const first: number[] = [], last: number[] = [];
  for (let i = r0; i <= o.rows; i++) {
    const t = rowT(i);
    for (let j = 0; j < cols; j++) {
      let phi = p0 + (p1 - p0) * (o.colMap ? o.colMap(j / o.segs) : j / o.segs);
      if (phi > Math.PI + 1e-9) phi -= Math.PI * 2; // callbacks always see φ in (−π, π]
      const th = o.th0(phi) + (o.th1(phi) - o.th0(phi)) * t;
      f(th, phi, o.off(t, phi, th), _p);
      const k = bd.v(_p, o.col(t, phi, th, _p), bindOf(t, phi), o.rough, o.uv ? o.uv(t, j / o.segs, phi, th, _p) : NEUTRAL_UV);
      if (j === 0) first.push(k);
      if (j === cols - 1) last.push(k);
    }
    if (closed) bd.twin(start + (i - r0) * cols, start + (i - r0) * cols + o.segs);
  }
  const at = (i: number, j: number) => (pole && i === 0 ? poleIdx : start + (i - r0) * cols + j);
  for (let i = 0; i < o.rows; i++) {
    for (let j = 0; j < o.segs; j++) {
      const a = at(i, j), b = at(i + 1, j), c = at(i, j + 1), d = at(i + 1, j + 1);
      if (!(pole && i === 0)) bd.tri(a, b, c);
      bd.tri(c, b, d);
    }
  }
  return { first, last, pole: poleIdx };
}

const _t = new Vector3(), _n = new Vector3(), _s = new Vector3(), _q = new Vector3();

/** Sweeps a flat rectangle (half width × half thickness) along a path. `up(i)` = outward normal of
 *  the surface the strip lies on (the rectangle's thin axis). Every face has its own vertices, so
 *  the broad faces shade flat-on (shared corner normals would tilt them 45° and read as dark planks). */
export function sweep(bd: Builder, pts: readonly Vector3[], up: (i: number) => Vector3, hw: number | ((i: number) => number), ht: number, col: RGB | ((i: number) => RGB), bind: Bind | ((i: number) => Bind), rough: number, closed = false, uv?: (i: number, side: number) => readonly [number, number]): void {
  const n = pts.length;
  const CORNERS = [[1, 1], [-1, 1], [-1, -1], [1, -1]] as const; // counter-clockwise seen along the path
  const first = bd.vertexCount;
  const corner: Vector3[] = [new Vector3(), new Vector3(), new Vector3(), new Vector3()];
  const ends: Vector3[][] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[closed ? (i - 1 + n) % n : Math.max(0, i - 1)], b = pts[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    _t.subVectors(b, a).normalize();
    _n.copy(up(i));
    _s.crossVectors(_t, _n).normalize(); // side
    _n.crossVectors(_s, _t).normalize(); // re-orthogonalised normal
    const w = typeof hw === 'function' ? hw(i) : hw;
    const c = typeof col === 'function' ? col(i) : col;
    const bnd = typeof bind === 'function' ? bind(i) : bind;
    CORNERS.forEach(([sx, sy], k) => corner[k].copy(pts[i]).addScaledVector(_s, sx * w).addScaledVector(_n, sy * ht));
    // face k runs from corner k to corner k + 1: two vertices of its own per section
    for (let k = 0; k < 4; k++) {
      bd.v(corner[k], c, bnd, rough, uv ? uv(i, CORNERS[k][0]) : NEUTRAL_UV);
      bd.v(corner[(k + 1) % 4], c, bnd, rough, uv ? uv(i, CORNERS[(k + 1) % 4][0]) : NEUTRAL_UV);
    }
    if (!closed && (i === 0 || i === n - 1)) ends.push(corner.map((q) => q.clone()));
  }
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const i2 = (i + 1) % n;
    for (let k = 0; k < 4; k++) {
      const a = first + i * 8 + k * 2, b = a + 1;
      const c = first + i2 * 8 + k * 2, d = c + 1;
      bd.tri(a, c, b);
      bd.tri(b, c, d);
    }
  }
  if (!closed) {
    // flat end caps
    const c0 = typeof col === 'function' ? col(0) : col, c1 = typeof col === 'function' ? col(n - 1) : col;
    const b0 = typeof bind === 'function' ? bind(0) : bind, b1 = typeof bind === 'function' ? bind(n - 1) : bind;
    const s0 = ends[0].map((q) => bd.v(q, c0, b0, rough)), s1 = ends[1].map((q) => bd.v(q, c1, b1, rough));
    bd.tri(s0[0], s0[1], s0[2]); bd.tri(s0[0], s0[2], s0[3]);
    bd.tri(s1[0], s1[2], s1[1]); bd.tri(s1[0], s1[3], s1[2]);
  }
}

/** Flat fan disc (centre colour → rim colour), facing `normal`. Lenses, coffee. */
export function disc(bd: Builder, c: Vector3, normal: Vector3, rx: number, ry: number, segs: number, cCol: RGB, rimCol: RGB, bind: Bind, rough: number, upHint = new Vector3(0, 1, 0)): void {
  const xAxis = new Vector3().crossVectors(upHint, normal).normalize();
  const yAxis = new Vector3().crossVectors(normal, xAxis).normalize();
  const ci = bd.v(c, cCol, bind, rough);
  const first = bd.vertexCount;
  for (let j = 0; j < segs; j++) {
    const a = (j / segs) * Math.PI * 2;
    _q.copy(c).addScaledVector(xAxis, Math.cos(a) * rx).addScaledVector(yAxis, Math.sin(a) * ry);
    bd.v(_q, rimCol, bind, rough);
  }
  for (let j = 0; j < segs; j++) bd.tri(ci, first + j, first + ((j + 1) % segs));
}
