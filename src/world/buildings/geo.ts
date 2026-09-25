// Geometry builder for the procedural facades. Everything is authored in a local "facade frame":
//   u = along the facade (to the viewer's right when standing outside), y = up, w = outward.
// A frame is a rotation about Y plus a translation, always right-handed (u = up × w), so the
// same winding works for every facade orientation. Frames can be nested (push/pop) for rotated
// parts such as half-open shutters or angled flag poles.
//
// Every vertex carries: position, normal, uv, color (rgb) and a free vec4 `aExt` whose meaning
// depends on the material (masonry: layer + grime; glass: window seed/size/kind; cutout: sway).
import { BufferAttribute, BufferGeometry, ShapeUtils, Vector2 } from 'three';

export type V3 = [number, number, number];
export type P2 = [number, number];

function freeArray(this: { array: unknown }): void {
  this.array = null;
}

/** Growable float array without per-push allocations. */
class FArr {
  a: Float32Array;
  n = 0;
  constructor(cap: number) {
    this.a = new Float32Array(cap);
  }
  reserve(k: number): void {
    if (this.n + k <= this.a.length) return;
    let cap = this.a.length * 2;
    while (cap < this.n + k) cap *= 2;
    const b = new Float32Array(cap);
    b.set(this.a.subarray(0, this.n));
    this.a = b;
  }
}

class UArr {
  a: Uint32Array;
  n = 0;
  constructor(cap: number) {
    this.a = new Uint32Array(cap);
  }
  push3(i: number, j: number, k: number): void {
    if (this.n + 3 > this.a.length) {
      const b = new Uint32Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = i;
    this.a[this.n++] = j;
    this.a[this.n++] = k;
  }
}

interface Frame {
  ox: number; oy: number; oz: number;
  dx: number; dz: number; // u axis in world
}

const capCache = new WeakMap<P2[], { pts: Vector2[]; tris: number[][] }>();

/** Earcut output orientation is not guaranteed: force every triangle CCW in the given 2D space. */
function ccwTris(pts: Vector2[]): number[][] {
  const tris = ShapeUtils.triangulateShape(pts, []);
  for (const t of tris) {
    const a = pts[t[0]], b = pts[t[1]], c = pts[t[2]];
    if ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) < 0) [t[1], t[2]] = [t[2], t[1]];
  }
  return tris;
}

export class GeoBuf {
  private p = new FArr(4096 * 3);
  private nm = new FArr(4096 * 3);
  private t = new FArr(4096 * 2);
  private c = new FArr(4096 * 3);
  private e = new FArr(4096 * 4);
  private idx = new UArr(8192);
  private stack: Frame[] = [];
  private f: Frame = { ox: 0, oy: 0, oz: 0, dx: 1, dz: 0 };

  /** Current vertex color and extra attribute. */
  col: V3 = [1, 1, 1];
  ext: [number, number, number, number] = [0, 0, 0, 0];
  /** Optional vertical shading ramp (baked grime / AO): factor lerps f0→f1 for y in y0→y1. */
  private ramp: { y0: number; y1: number; f0: number; f1: number } | null = null;
  /** Offset added to tiling uvs (per building) so repeated textures don't line up. */
  uvOff: P2 = [0, 0];

  // ---------------------------------------------------------------------------------------------
  // Frames
  /** Sets the root frame: origin (world), outward normal (nx, nz) of the facade. */
  setFrame(ox: number, oy: number, oz: number, nx: number, nz: number): void {
    const l = Math.hypot(nx, nz);
    nx /= l;
    nz /= l;
    this.stack.length = 0;
    this.f = { ox, oy, oz, dx: nz, dz: -nx };
  }

  /** Nested frame: origin at local (u, y, w), rotated by `ang` about local Y (positive = u turns toward -w). */
  push(u: number, y: number, w: number, ang = 0): void {
    this.stack.push(this.f);
    const f = this.f;
    const [x, yy, z] = this.world(u, y, w);
    // local u axis rotated about Y: u' = cos*u - sin*w  (right-handed rotation about +Y)
    const c = Math.cos(ang), s = Math.sin(ang);
    const nx = -f.dz, nz = f.dx; // parent w axis in world
    const dx = c * f.dx - s * nx;
    const dz = c * f.dz - s * nz;
    this.f = { ox: x, oy: yy, oz: z, dx, dz };
  }

  pop(): void {
    const f = this.stack.pop();
    if (f) this.f = f;
  }

  /** Local → world. w axis = (−dz, 0, dx) … derived from u = up × w. */
  world(u: number, y: number, w: number): V3 {
    const f = this.f;
    // u axis D = (dx, 0, dz); w axis N satisfies D = up × N → N = (−dz, 0, dx)
    return [f.ox + u * f.dx - w * f.dz, f.oy + y, f.oz + u * f.dz + w * f.dx];
  }

  /** Current frame's u axis in world (x, z). */
  axisU(): [number, number] {
    return [this.f.dx, this.f.dz];
  }

  /** Drip-streak ramp written into aExt.z (masonry weathering under sills and ledges). */
  private drip: { y0: number; y1: number; f0: number; f1: number } | null = null;

  setDrip(y0: number, y1: number, f0: number, f1: number): void {
    this.drip = { y0, y1, f0, f1 };
  }

  clearDrip(): void {
    this.drip = null;
  }

  setRamp(y0: number, y1: number, f0: number, f1: number): void {
    this.ramp = { y0, y1, f0, f1 };
  }

  clearRamp(): void {
    this.ramp = null;
  }

  // ---------------------------------------------------------------------------------------------
  // Raw emission
  /** Emits one vertex in local coordinates; returns its index. */
  v(u: number, y: number, w: number, nu: number, ny: number, nw: number, s: number, t: number, shade = 1): number {
    const f = this.f;
    const p = this.p, nm = this.nm, tt = this.t, c = this.c, e = this.e;
    p.reserve(3); nm.reserve(3); tt.reserve(2); c.reserve(3); e.reserve(4);
    let k = p.n;
    p.a[k] = f.ox + u * f.dx - w * f.dz;
    p.a[k + 1] = f.oy + y;
    p.a[k + 2] = f.oz + u * f.dz + w * f.dx;
    p.n += 3;
    k = nm.n;
    nm.a[k] = nu * f.dx - nw * f.dz;
    nm.a[k + 1] = ny;
    nm.a[k + 2] = nu * f.dz + nw * f.dx;
    nm.n += 3;
    tt.a[tt.n++] = s;
    tt.a[tt.n++] = t;
    let sh = shade;
    const r = this.ramp;
    if (r) {
      const a = Math.min(1, Math.max(0, (y - r.y0) / (r.y1 - r.y0)));
      sh *= r.f0 + (r.f1 - r.f0) * a;
    }
    k = c.n;
    c.a[k] = this.col[0] * sh;
    c.a[k + 1] = this.col[1] * sh;
    c.a[k + 2] = this.col[2] * sh;
    c.n += 3;
    k = e.n;
    e.a[k] = this.ext[0];
    e.a[k + 1] = this.ext[1];
    const dr = this.drip;
    e.a[k + 2] = dr ? dr.f0 + (dr.f1 - dr.f0) * Math.min(1, Math.max(0, (y - dr.y0) / (dr.y1 - dr.y0))) : this.ext[2];
    e.a[k + 3] = this.ext[3];
    e.n += 4;
    return p.n / 3 - 1;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push3(a, b, c);
  }

  quadIdx(a: number, b: number, c: number, d: number): void {
    this.idx.push3(a, b, c);
    this.idx.push3(a, c, d);
  }

  /** Planar quad from 4 local points (CCW seen from the front); uv per corner; flat normal. */
  quad(a: V3, b: V3, c: V3, d: V3, ta: P2, tb: P2, tc: P2, td: P2, sa = 1, sb = 1, sc = 1, sd = 1): void {
    const e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2];
    const e2x = d[0] - a[0], e2y = d[1] - a[1], e2z = d[2] - a[2];
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const i0 = this.v(a[0], a[1], a[2], nx, ny, nz, ta[0], ta[1], sa);
    const i1 = this.v(b[0], b[1], b[2], nx, ny, nz, tb[0], tb[1], sb);
    const i2 = this.v(c[0], c[1], c[2], nx, ny, nz, tc[0], tc[1], sc);
    const i3 = this.v(d[0], d[1], d[2], nx, ny, nz, td[0], td[1], sd);
    this.quadIdx(i0, i1, i2, i3);
  }

  // ---------------------------------------------------------------------------------------------
  // Axis-aligned rectangles in the local frame. uv: explicit rect [s0,t0,s1,t1] or tiling meters.
  /** Rectangle in the plane w = const, facing +w (dir=1) or −w (dir=−1). */
  rectW(u0: number, u1: number, y0: number, y1: number, w: number, dir: 1 | -1 = 1, uv?: readonly number[], shadeTop = 1, shadeBot = 1): void {
    const [ou, ov] = this.uvOff;
    const s0 = uv ? uv[0] : u0 + ou, t0 = uv ? uv[1] : y0 + ov, s1 = uv ? uv[2] : u1 + ou, t1 = uv ? uv[3] : y1 + ov;
    if (dir === 1) this.quad([u0, y0, w], [u1, y0, w], [u1, y1, w], [u0, y1, w], [s0, t0], [s1, t0], [s1, t1], [s0, t1], shadeBot, shadeBot, shadeTop, shadeTop);
    else this.quad([u1, y0, w], [u0, y0, w], [u0, y1, w], [u1, y1, w], [s1, t0], [s0, t0], [s0, t1], [s1, t1], shadeBot, shadeBot, shadeTop, shadeTop);
  }

  /** Rectangle in the plane u = const, facing +u (dir=1) or −u. */
  rectU(u: number, w0: number, w1: number, y0: number, y1: number, dir: 1 | -1 = 1, uv?: readonly number[], shadeIn = 1, shadeOut = 1): void {
    const [ou, ov] = this.uvOff;
    // shadeIn applies at w0 (usually the deep side), shadeOut at w1
    if (dir === 1) {
      const s0 = uv ? uv[0] : -w1 + ou, s1 = uv ? uv[2] : -w0 + ou, t0 = uv ? uv[1] : y0 + ov, t1 = uv ? uv[3] : y1 + ov;
      this.quad([u, y0, w1], [u, y0, w0], [u, y1, w0], [u, y1, w1], [s0, t0], [s1, t0], [s1, t1], [s0, t1], shadeOut, shadeIn, shadeIn, shadeOut);
    } else {
      const s0 = uv ? uv[0] : w0 + ou, s1 = uv ? uv[2] : w1 + ou, t0 = uv ? uv[1] : y0 + ov, t1 = uv ? uv[3] : y1 + ov;
      this.quad([u, y0, w0], [u, y0, w1], [u, y1, w1], [u, y1, w0], [s0, t0], [s1, t0], [s1, t1], [s0, t1], shadeIn, shadeOut, shadeOut, shadeIn);
    }
  }

  /** Rectangle in the plane y = const, facing +y (dir=1) or −y. */
  rectY(y: number, u0: number, u1: number, w0: number, w1: number, dir: 1 | -1 = 1, uv?: readonly number[], shadeIn = 1, shadeOut = 1): void {
    const [ou, ov] = this.uvOff;
    const s0 = uv ? uv[0] : u0 + ou, s1 = uv ? uv[2] : u1 + ou, t0 = uv ? uv[1] : w0 + ov, t1 = uv ? uv[3] : w1 + ov;
    if (dir === 1) this.quad([u0, y, w1], [u1, y, w1], [u1, y, w0], [u0, y, w0], [s0, t1], [s1, t1], [s1, t0], [s0, t0], shadeOut, shadeOut, shadeIn, shadeIn);
    else this.quad([u0, y, w0], [u1, y, w0], [u1, y, w1], [u0, y, w1], [s0, t0], [s1, t0], [s1, t1], [s0, t1], shadeIn, shadeIn, shadeOut, shadeOut);
  }

  /** Box; `faces` bitmask: 1 +w, 2 −w, 4 +u, 8 −u, 16 +y, 32 −y. uv = meters (tiling). */
  box(u0: number, u1: number, y0: number, y1: number, w0: number, w1: number, faces = 63, uv?: readonly number[]): void {
    if (faces & 1) this.rectW(u0, u1, y0, y1, w1, 1, uv);
    if (faces & 2) this.rectW(u0, u1, y0, y1, w0, -1, uv);
    if (faces & 4) this.rectU(u1, w0, w1, y0, y1, 1, uv);
    if (faces & 8) this.rectU(u0, w0, w1, y0, y1, -1, uv);
    if (faces & 16) this.rectY(y1, u0, u1, w0, w1, 1, uv);
    if (faces & 32) this.rectY(y0, u0, u1, w0, w1, -1, uv);
  }

  // ---------------------------------------------------------------------------------------------
  // Mouldings: extrude a profile (list of [w, y] from the wall outward and back) along u.
  /**
   * @param prof  profile points [w, y] relative to (wBase, yBase). First and last point usually at w = 0.
   * @param k0,k1 mitre factors at u0/u1: the end is shifted by −k0·w / +k1·w (1 = 90° outer corner).
   * @param caps  close the ends with the profile polygon (for free-standing ends).
   */
  extrude(prof: P2[], u0: number, u1: number, yBase: number, wBase: number, k0 = 0, k1 = 0, caps = true): void {
    const [ou] = this.uvOff;
    let tacc = 0;
    for (let i = 0; i < prof.length - 1; i++) {
      const [wa, ya] = prof[i];
      const [wb, yb] = prof[i + 1];
      const dw = wb - wa, dy = yb - ya;
      const len = Math.hypot(dw, dy);
      if (len < 1e-5) continue;
      // outward normal in (w, y): (dy, −dw)
      const nw = dy / len, ny = -dw / len;
      const shadeA = wa < 0.015 ? 0.8 : 1, shadeB = wb < 0.015 ? 0.8 : 1;
      const a0 = u0 - k0 * wa, a1 = u1 + k1 * wa, b0 = u0 - k0 * wb, b1 = u1 + k1 * wb;
      const i0 = this.v(a0, yBase + ya, wBase + wa, 0, ny, nw, a0 + ou, tacc, shadeA);
      const i1 = this.v(a1, yBase + ya, wBase + wa, 0, ny, nw, a1 + ou, tacc, shadeA);
      const i2 = this.v(b1, yBase + yb, wBase + wb, 0, ny, nw, b1 + ou, tacc + len, shadeB);
      const i3 = this.v(b0, yBase + yb, wBase + wb, 0, ny, nw, b0 + ou, tacc + len, shadeB);
      this.quadIdx(i0, i1, i2, i3);
      tacc += len;
    }
    if (caps) {
      this.cap(prof, u0, yBase, wBase, -1, k0);
      this.cap(prof, u1, yBase, wBase, 1, k1);
    }
  }

  /** End cap of an extruded profile (closed against the wall at w = 0). */
  private cap(prof: P2[], u: number, yBase: number, wBase: number, dir: 1 | -1, k: number): void {
    if (k !== 0) return; // mitred ends meet their neighbour, no cap
    let c = capCache.get(prof);
    if (!c) {
      const pts = prof.map(([w, y]) => new Vector2(w, y));
      const first = prof[0], last = prof[prof.length - 1];
      if (last[0] !== 0) pts.push(new Vector2(0, last[1]));
      if (first[0] !== 0) pts.push(new Vector2(0, first[1]));
      c = { pts, tris: ccwTris(pts) };
      capCache.set(prof, c);
    }
    const base = c.pts.map((p) => this.v(u, yBase + p.y, wBase + p.x, dir, 0, 0, p.x, p.y));
    // CCW in (w, y) is seen mirrored from +u (its screen-right is −w)
    for (const [a, b, cc] of c.tris) {
      if (dir === 1) this.tri(base[a], base[cc], base[b]);
      else this.tri(base[a], base[b], base[cc]);
    }
  }

  /**
   * Extrudes a profile [w, y] along a plan polyline (u, w) of the current frame, one straight piece
   * per chord, mitred at the joints. The profile's w is the chord's left-hand normal (outward for a
   * path running left → right, like the bowed balconies).
   */
  extrudePath(prof: P2[], path: P2[], yBase: number): void {
    const n = path.length - 1;
    const dir = (i: number): P2 => {
      const du = path[i + 1][0] - path[i][0], dw = path[i + 1][1] - path[i][1];
      const l = Math.hypot(du, dw) || 1;
      return [du / l, dw / l];
    };
    const mit = (i: number): number => {
      if (i <= 0 || i >= n) return 0;
      const [au, aw] = dir(i - 1), [bu, bw] = dir(i);
      return Math.tan(Math.atan2(-(bw * au - bu * aw), bu * au + bw * aw) / 2); // normal of chord i−1 = (−aw, au)
    };
    for (let i = 0; i < n; i++) {
      const [du, dw] = dir(i);
      const len = Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]);
      this.push(path[i][0], 0, path[i][1], Math.atan2(-dw, du));
      this.extrude(prof, 0, len, yBase, 0, mit(i), mit(i + 1));
      this.pop();
    }
  }

  // ---------------------------------------------------------------------------------------------
  /** Prism: a 2D polygon in the facade plane (u, y) extruded from w0 to w1 (front at w1). */
  prism(poly: P2[], w0: number, w1: number, sides = true, back = false): void {
    const [ou, ov] = this.uvOff;
    const cw = ShapeUtils.isClockWise(poly.map(([u, y]) => new Vector2(u, y)));
    const ordered = cw ? [...poly].reverse() : poly;
    const tris = ccwTris(ordered.map(([u, y]) => new Vector2(u, y)));
    const front = ordered.map(([u, y]) => this.v(u, y, w1, 0, 0, 1, u + ou, y + ov));
    for (const [a, b, c] of tris) this.tri(front[a], front[b], front[c]);
    if (back) {
      const bk = ordered.map(([u, y]) => this.v(u, y, w0, 0, 0, -1, u + ou, y + ov));
      for (const [a, b, c] of tris) this.tri(bk[a], bk[c], bk[b]);
    }
    if (sides) {
      for (let i = 0; i < ordered.length; i++) {
        const [ua, ya] = ordered[i];
        const [ub, yb] = ordered[(i + 1) % ordered.length];
        const len = Math.hypot(ub - ua, yb - ya);
        if (len < 1e-5) continue;
        // CCW polygon: outward edge normal = (dy, −du)
        const nu = (yb - ya) / len, ny = -(ub - ua) / len;
        const s = Math.abs(nu) > 0.7 ? ya : ua;
        const s2 = Math.abs(nu) > 0.7 ? yb : ub;
        const i0 = this.v(ua, ya, w0, nu, ny, 0, s + ou, w0, 0.85);
        const i1 = this.v(ub, yb, w0, nu, ny, 0, s2 + ou, w0, 0.85);
        const i2 = this.v(ub, yb, w1, nu, ny, 0, s2 + ou, w1);
        const i3 = this.v(ua, ya, w1, nu, ny, 0, s + ou, w1);
        this.quadIdx(i0, i1, i2, i3);
      }
    }
  }

  /** Horizontal prism: polygon in plan (u, w) extruded from y0 to y1 (balcony slabs, roofs). */
  prismY(poly: P2[], y0: number, y1: number, top = true, bottom = true, sides = true): void {
    const [ou, ov] = this.uvOff;
    // plan polygon: map (u, w) → 2D (u, −w) so CCW test matches looking down +y
    const cw = ShapeUtils.isClockWise(poly.map(([u, w]) => new Vector2(u, -w)));
    const ord = cw ? [...poly].reverse() : poly;
    const tris = ccwTris(ord.map(([u, w]) => new Vector2(u, -w)));
    if (top) {
      const t = ord.map(([u, w]) => this.v(u, y1, w, 0, 1, 0, u + ou, w + ov));
      for (const [a, b, c] of tris) this.tri(t[a], t[b], t[c]);
    }
    if (bottom) {
      const b = ord.map(([u, w]) => this.v(u, y0, w, 0, -1, 0, u + ou, w + ov, 0.8));
      for (const [a, bb, c] of tris) this.tri(b[a], b[c], b[bb]);
    }
    if (sides) {
      let acc = 0;
      for (let i = 0; i < ord.length; i++) {
        const [ua, wa] = ord[i];
        const [ub, wb] = ord[(i + 1) % ord.length];
        const len = Math.hypot(ub - ua, wb - wa);
        if (len < 1e-5) continue;
        // polygon CCW in (u, −w) → outward normal in (u, w): (−dw, du)… computed via 2D cross
        const du = ub - ua, dw = wb - wa;
        const nu = -dw / len, nw = du / len;
        const i0 = this.v(ua, y0, wa, nu, 0, nw, acc + ou, y0 + ov);
        const i1 = this.v(ub, y0, wb, nu, 0, nw, acc + len + ou, y0 + ov);
        const i2 = this.v(ub, y1, wb, nu, 0, nw, acc + len + ou, y1 + ov);
        const i3 = this.v(ua, y1, wa, nu, 0, nw, acc + ou, y1 + ov);
        this.quadIdx(i0, i1, i2, i3);
        acc += len;
      }
    }
  }

  /**
   * Surface of revolution around the local vertical axis at (cu, cw). prof = [radius, y].
   * uv: meters around/up (tiling layers) or, with `uvRect`, stretched over that atlas rect.
   */
  lathe(prof: P2[], cu: number, cy: number, cw: number, seg: number, capTop = false, uvRect?: readonly number[]): void {
    const ring: number[][] = [];
    const y0 = prof[0][1], y1 = prof[prof.length - 1][1];
    const circ = 2 * Math.PI * Math.max(...prof.map((p) => p[0]));
    for (let i = 0; i < prof.length; i++) {
      // normal from neighbouring profile points
      const pa = prof[Math.max(0, i - 1)], pb = prof[Math.min(prof.length - 1, i + 1)];
      const dr = pb[0] - pa[0], dy = pb[1] - pa[1];
      const l = Math.hypot(dr, dy) || 1;
      const nr = dy / l, ny = -dr / l;
      const row: number[] = [];
      const tv = uvRect ? uvRect[1] + ((prof[i][1] - y0) / (y1 - y0 || 1)) * (uvRect[3] - uvRect[1]) : prof[i][1];
      for (let s = 0; s <= seg; s++) {
        const a = (s / seg) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        const r = prof[i][0];
        const su = uvRect ? uvRect[0] + (s / seg) * (uvRect[2] - uvRect[0]) : (s / seg) * circ;
        row.push(this.v(cu + r * ca, cy + prof[i][1], cw + r * sa, nr * ca, ny, nr * sa, su, tv));
      }
      ring.push(row);
    }
    for (let i = 0; i < prof.length - 1; i++)
      for (let s = 0; s < seg; s++) {
        const a = ring[i][s], b = ring[i][s + 1], c = ring[i + 1][s + 1], d = ring[i + 1][s];
        // winding: profile goes bottom→top with outward normals: (a, d, c, b) is CCW from outside
        this.quadIdx(a, d, c, b);
      }
    if (capTop) {
      const top = prof[prof.length - 1];
      const cuv = uvRect ? [(uvRect[0] + uvRect[2]) / 2, uvRect[3]] : [0, 0];
      const ci = this.v(cu, cy + top[1], cw, 0, 1, 0, cuv[0], cuv[1]);
      const row: number[] = [];
      for (let s = 0; s <= seg; s++) {
        const a = (s / seg) * Math.PI * 2;
        row.push(this.v(cu + top[0] * Math.cos(a), cy + top[1], cw + top[0] * Math.sin(a), 0, 1, 0, cuv[0], cuv[1]));
      }
      for (let s = 0; s < seg; s++) this.tri(ci, row[s + 1], row[s]);
    }
  }

  /** Round tube between two local points (drain pipes, poles). `uv` = constant atlas uv. */
  tube(a: V3, b: V3, r: number, seg = 6, uv?: readonly [number, number]): void {
    const ax = b[0] - a[0], ay = b[1] - a[1], az = b[2] - a[2];
    const len = Math.hypot(ax, ay, az);
    const tx = ax / len, ty = ay / len, tz = az / len;
    // perpendicular basis (p, q) around the axis t
    let px = ty, py = -tx, pz = 0;
    let l = Math.hypot(px, py);
    if (l < 1e-3) { px = 1; py = 0; l = 1; }
    px /= l; py /= l;
    let qx = ty * pz - tz * py, qy = tz * px - tx * pz, qz = tx * py - ty * px;
    l = Math.hypot(qx, qy, qz);
    qx /= l; qy /= l; qz /= l;
    const r0: number[] = [], r1: number[] = [];
    for (let s = 0; s <= seg; s++) {
      const ang = (s / seg) * Math.PI * 2;
      const c = Math.cos(ang), sn = Math.sin(ang);
      const nx = px * c + qx * sn, ny = py * c + qy * sn, nz = pz * c + qz * sn;
      r0.push(this.v(a[0] + nx * r, a[1] + ny * r, a[2] + nz * r, nx, ny, nz, uv ? uv[0] : s / seg, uv ? uv[1] : 0));
      r1.push(this.v(b[0] + nx * r, b[1] + ny * r, b[2] + nz * r, nx, ny, nz, uv ? uv[0] : s / seg, uv ? uv[1] : len));
    }
    for (let s = 0; s < seg; s++) this.quadIdx(r0[s], r0[s + 1], r1[s + 1], r1[s]);
  }

  /** A vertical strip of quads following a plan polyline (u, w) — railing cards on curved balconies. */
  strip(path: P2[], y0: number, y1: number, uvRow: readonly [number, number], uvPerMeter: number): void {
    let acc = 0;
    for (let i = 0; i < path.length - 1; i++) {
      const [ua, wa] = path[i];
      const [ub, wb] = path[i + 1];
      const len = Math.hypot(ub - ua, wb - wa);
      const s0 = acc * uvPerMeter, s1 = (acc + len) * uvPerMeter;
      this.quad([ua, y0, wa], [ub, y0, wb], [ub, y1, wb], [ua, y1, wa], [s0, uvRow[0]], [s1, uvRow[0]], [s1, uvRow[1]], [s0, uvRow[1]]);
      acc += len;
    }
  }

  // ---------------------------------------------------------------------------------------------
  /** Appends all vertices/triangles of another buffer (already in world space). */
  append(o: GeoBuf): void {
    const base = this.p.n / 3;
    for (const [dst, src] of [[this.p, o.p], [this.nm, o.nm], [this.t, o.t], [this.c, o.c], [this.e, o.e]] as const) {
      dst.reserve(src.n);
      dst.a.set(src.a.subarray(0, src.n), dst.n);
      dst.n += src.n;
    }
    for (let i = 0; i < o.idx.n; i += 3) this.idx.push3(o.idx.a[i] + base, o.idx.a[i + 1] + base, o.idx.a[i + 2] + base);
  }

  isEmpty(): boolean {
    return this.idx.n === 0;
  }

  /** Builds a BufferGeometry, optionally recentred on (cx, cy, cz). Attribute `aExt` = vec4. */
  toGeometry(cx = 0, cy = 0, cz = 0): BufferGeometry {
    const g = new BufferGeometry();
    const nv = this.p.n / 3;
    const pos = this.p.a.slice(0, this.p.n);
    if (cx || cy || cz)
      for (let i = 0; i < pos.length; i += 3) {
        pos[i] -= cx;
        pos[i + 1] -= cy;
        pos[i + 2] -= cz;
      }
    const attrs: [string, BufferAttribute][] = [
      ['position', new BufferAttribute(pos, 3)],
      ['normal', new BufferAttribute(this.nm.a.slice(0, this.nm.n), 3)],
      ['uv', new BufferAttribute(this.t.a.slice(0, this.t.n), 2)],
      ['color', new BufferAttribute(this.c.a.slice(0, this.c.n), 3)],
      ['aExt', new BufferAttribute(this.e.a.slice(0, this.e.n), 4)],
    ];
    for (const [name, attr] of attrs) g.setAttribute(name, attr);
    const ia = this.idx.a.slice(0, this.idx.n);
    const index = new BufferAttribute(nv > 65535 ? ia : Uint16Array.from(ia), 1);
    g.setIndex(index);
    g.computeBoundingBox();
    g.computeBoundingSphere();
    // static geometry: drop the CPU copies once they are on the GPU (bounds are already computed;
    // nothing raycasts these meshes). A lost WebGL context therefore needs a module rebuild.
    for (const attr of [...attrs.map((a) => a[1]), index]) attr.onUpload(freeArray);
    return g;
  }
}
