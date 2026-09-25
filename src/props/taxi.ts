// Yellow Tunis taxi: a generic compact sedan (no badges) built procedurally.
// - Lower body: a loft of cross-sections along Z (wheel arches, rounded ends, cabin tub).
// - Greenhouse: rings lofted from the beltline to the roof; cells become glass, seals, pillars.
// - Wrap-around bumpers (painted band over a black textured insert) lofted along the plan outline.
// - Lamps, grilles and plates are decals projected onto the body; lamps bulge out with a bezel.
// Draw calls per taxi: paint, glass, atlas (trim + lamps + sign + interior), 3 wheel meshes = 6.
// Nothing is allocated per taxi: meshes share geometry; lamp states are 4 shared materials.
import {
  BufferAttribute, BufferGeometry, Color, CylinderGeometry, Euler, Float32BufferAttribute, Group,
  Matrix4, Mesh, MeshPhysicalMaterial, MeshStandardMaterial, TorusGeometry, Vector2, Vector3,
  type WebGLRenderer,
} from 'three';
import { DecalGeometry } from 'three/examples/jsm/geometries/DecalGeometry.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { Quality, TaxiModel } from '../core/types';
import { SIGN_STYLES, TAXI_ATLAS, taxiTextures } from './textures';
import {
  GLSL_NOISE, TriSoup, Trash, glassify, lathe, lerp, mergeParts, newLevels, paint, paintFn, smooth, texScale,
  vertexPbr, withNormals, type PartLook, type Profile,
} from './util';

// ---------------------------------------------------------------------------------------------
// Dimensions (m). Faces +Z; origin on the ground midway between the axles.
const B = {
  front: 2.08,
  rear: -2.22,
  halfW: 0.86,
  axle: 1.3,
  wheelR: 0.305,
  wheelX: 0.74,
  archR: 0.37,
  cabinF: 0.76, // cabin tub (open top under the greenhouse)
  cabinR: -1.435,
  beltF: 0.775, // windshield base / rear window base
  beltR: -1.45,
  roofY: 1.4,
  floorY: 0.43,
} as const;
/** Overall: bumpers stand 22 mm proud of the body ends; height includes the roof sign. */
export const TAXI_SIZE = { length: B.front - B.rear + 0.044, width: 1.76, height: 1.61 } as const;

const T_PAINT = 0, T_UNDER = 1, T_INTERIOR = 2, T_GLASS = 3, T_SEAL = 4, T_LINER = 5, T_BUMPER = 6;

const sq = (x: number) => x * x;

function planW(z: number): number {
  const W0 = B.halfW;
  let w = W0;
  const rcF = 0.42, rcR = 0.3;
  if (z > B.front - rcF) w = W0 - rcF + Math.sqrt(Math.max(0, sq(rcF) - sq(z - (B.front - rcF))));
  if (z < B.rear + rcR) w = W0 - rcR + Math.sqrt(Math.max(0, sq(rcR) - sq(B.rear + rcR - z)));
  return w - 0.02 * smooth(0.8, B.front, z) - 0.012 * smooth(-1.5, B.rear, z);
}

function yBottom(z: number): number {
  let y = 0.2;
  if (z > 1.75) y += 0.07 * sq((z - 1.75) / (B.front - 1.75));
  if (z < -1.85) y += 0.08 * sq((-1.85 - z) / (-1.85 - B.rear));
  return y;
}

/** Height where the side's shoulder turns over into the top surface (hood / belt / deck). */
function yEdge(z: number): number {
  if (z >= B.cabinF) {
    if (z > 1.95) return 0.76 - 0.2 * Math.pow((z - 1.95) / (B.front - 1.95), 1.6); // nose turns down into the fascia
    return 0.76 + 0.13 * Math.pow((1.95 - z) / (1.95 - B.cabinF), 0.8);
  }
  if (z >= B.beltR) return 0.89 + 0.025 * ((B.cabinF - z) / (B.cabinF - B.beltR));
  if (z > -2.1) return 0.915 + 0.015 * ((B.beltR - z) / (B.beltR + 2.1));
  return 0.93 - 0.04 * sq((-2.1 - z) / (-2.1 - B.rear)); // trunk lid: flat, crisp edge onto the rear panel
}

const crownOf = (z: number) => (z > B.cabinF ? 0.03 : z < B.beltR ? 0.022 : 0.02);

/** Rounds the end edges of the loft (radius e): inset near the nose and tail. */
function fillet(z: number, e: number): number {
  const d = Math.max(0, z - (B.front - e), B.rear + e - z);
  return e - Math.sqrt(Math.max(0, e * e - d * d));
}

/** Wheel-arch ceiling height at z, or null outside the arch opening. */
function archY(z: number): number | null {
  const yc = B.wheelR;
  const dz = Math.abs(Math.abs(z) - B.axle);
  const edge = Math.sqrt(sq(B.archR) - sq(0.2 - yc));
  return dz < edge ? yc + Math.sqrt(sq(B.archR) - dz * dz) : null;
}
const ARCH_EDGE = Math.sqrt(sq(B.archR) - sq(0.2 - B.wheelR));

const SKIN_Y = [0.2, 0.23, 0.27, 0.33, 0.355, 0.38, 0.45, 0.53, 0.61, 0.69, 0.715, 0.74, 0.79, 0.84, 0.88];
const RS = 0.05; // shoulder radius
const N_ARC = 4, N_TOP = 7;

interface Station { z: number; cabin: boolean; arch: boolean }

interface SectionInfo { W: number; yb: number; ye: number; crown: number; xc: number }

function sectionInfo(z: number): SectionInfo & { skinX: (y: number) => number } {
  const W = planW(z) - fillet(z, 0.03);
  const yb = yBottom(z) + fillet(z, 0.045);
  const ye = yEdge(z) - fillet(z, z < 0 ? 0.014 : 0.02); // crisp trunk-lid / hood edges
  const flare = 0.014 * Math.exp(-sq((Math.abs(z) - B.axle) / 0.5));
  const skinX = (y: number) => {
    let x = W;
    if (y > 0.55) x -= 0.06 * sq((y - 0.55) / 0.45);
    else x -= 0.025 * sq((0.55 - y) / 0.35);
    const rr = 0.07;
    if (y < yb + rr) x -= rr - Math.sqrt(Math.max(0, rr * rr - sq(yb + rr - y)));
    x += flare * (1 - smooth(0.55, 0.85, y));
    x += 0.008 * smooth(0.71, 0.745, y) * (1 - smooth(1.7, 2.0, Math.abs(z))); // shoulder character line
    x -= 0.012 * (1 - smooth(0.33, 0.37, y)) * (1 - smooth(1.6, 1.9, Math.abs(z))); // rocker step
    return x;
  };
  const xc = skinX(ye - RS) - RS;
  return { W, yb, ye, crown: crownOf(z), xc, skinX };
}

/** Top surface height of the lower body at (z, |x|). */
function topY(z: number, x: number): number {
  const s = sectionInfo(z);
  return s.ye + s.crown * (1 - sq(Math.min(1, Math.abs(x) / s.xc)));
}

/** Right half of a section, bottom centre → top centre, plus the tag of each segment. */
function section(st: Station): { pts: Vector2[]; tags: number[] } {
  const s = sectionInfo(st.z);
  const a = st.arch ? archY(st.z) : null;
  const ya = a !== null ? Math.max(s.yb, a) : s.yb;
  const pts: Vector2[] = [];
  const tags: number[] = [];
  const push = (x: number, y: number, tagNext: number) => { pts.push(new Vector2(x, y)); tags.push(tagNext); };
  const xin = Math.min(0.6, s.W - 0.16);
  push(0, s.yb, T_UNDER);
  push(xin, s.yb, T_UNDER);
  push(xin, ya, T_UNDER);
  const ySh = s.ye - RS;
  for (const Y of SKIN_Y) {
    const y = Math.min(ySh, Math.max(ya, Y));
    push(s.skinX(y), y, T_PAINT);
  }
  const cx = s.skinX(ySh) - RS;
  for (let k = 1; k <= N_ARC; k++) {
    const t = (k / N_ARC) * (Math.PI / 2);
    push(cx + RS * Math.cos(t), ySh + RS * Math.sin(t), T_PAINT);
  }
  const top = (x: number) => s.ye + s.crown * (1 - sq(x / cx));
  if (!st.cabin) {
    for (let k = 1; k <= N_TOP; k++) {
      const x = cx * (1 - k / N_TOP);
      push(x, top(x), T_PAINT);
    }
  } else {
    // door top, then down the inner door panel and across the floor (cabin tub)
    const xs = cx - 0.05;
    push(xs, top(xs), T_INTERIOR);
    push(xs - 0.01, s.ye - 0.06, T_INTERIOR);
    push(xs - 0.03, 0.66, T_INTERIOR);
    push(xs - 0.04, 0.5, T_INTERIOR);
    push(xs - 0.07, B.floorY + 0.01, T_INTERIOR);
    push(xs * 0.5, B.floorY, T_INTERIOR);
    push(0, B.floorY, T_INTERIOR);
  }
  return { pts, tags };
}

function stations(q: Quality): Station[] {
  const step = q === 'low' ? 0.14 : 0.1;
  const zs = new Set<number>();
  const add = (a: number, b: number, st: number) => { for (let z = a; z < b - 1e-6; z += st) zs.add(+z.toFixed(4)); };
  add(B.rear, B.rear + 0.03, 0.006);
  add(B.rear + 0.03, B.rear + 0.1, 0.02);
  add(B.rear + 0.1, B.front - 0.13, step);
  add(B.front - 0.13, B.front - 0.03, 0.02);
  add(B.front - 0.03, B.front, 0.006);
  zs.add(B.front);
  for (const s of [-1, 1]) add(s * B.axle - ARCH_EDGE, s * B.axle + ARCH_EDGE, q === 'low' ? 0.09 : 0.06);
  const out: Station[] = [...zs].sort((a, b) => a - b).map((z) => ({
    z, cabin: z > B.cabinR && z < B.cabinF, arch: archY(z) !== null,
  }));
  // discontinuities: duplicate stations just either side so the loft makes a clean wall
  const eps = 0.0005;
  const cuts = [-B.axle - ARCH_EDGE, -B.axle + ARCH_EDGE, B.axle - ARCH_EDGE, B.axle + ARCH_EDGE, B.cabinR, B.cabinF];
  for (const zc of cuts) {
    for (const z of [zc - eps, zc + eps]) out.push({ z, cabin: z > B.cabinR && z < B.cabinF, arch: archY(z) !== null });
  }
  out.sort((a, b) => a.z - b.z);
  return out.filter((s, i) => i === 0 || s.z - out[i - 1].z > 1e-4);
}

function buildLowerBody(q: Quality, soup: TriSoup): void {
  const sts = stations(q);
  const rings: Vector3[][] = [];
  const ringTags: number[][] = [];
  for (const st of sts) {
    const { pts, tags } = section(st);
    const n = pts.length;
    const ring: Vector3[] = [];
    const rt: number[] = [];
    for (let i = 0; i < n; i++) { ring.push(new Vector3(-pts[i].x, pts[i].y, st.z)); if (i < n - 1) rt.push(tags[i]); }
    // mirrored half (x>0), top centre → bottom centre, excluding shared centre points
    for (let i = n - 2; i >= 1; i--) ring.push(new Vector3(pts[i].x, pts[i].y, st.z));
    for (let i = n - 2; i >= 0; i--) rt.push(tags[i]);
    rings.push(ring);
    ringTags.push(rt);
  }
  const m = rings[0].length;
  for (let j = 0; j < rings.length - 1; j++) {
    const A = rings[j], C = rings[j + 1];
    const strip = sts[j + 1].z - sts[j].z < 0.002;
    const cabinChange = sts[j].cabin !== sts[j + 1].cabin;
    for (let k = 0; k < m; k++) {
      const k2 = (k + 1) % m;
      let tag = ringTags[j][k];
      if (strip) {
        // only the faces that actually span the jump (arch wall / firewall) change material;
        // the rest of the strip is a 1 mm sliver of ordinary skin
        const flat = Math.hypot(A[k].x - C[k].x, A[k].y - C[k].y) < 0.003 && Math.hypot(A[k2].x - C[k2].x, A[k2].y - C[k2].y) < 0.003;
        if (!flat) tag = cabinChange && tag !== T_UNDER ? T_INTERIOR : T_UNDER;
      }
      else if (tag !== ringTags[j + 1][k]) tag = T_INTERIOR;
      // winding: outward normals (x<0 half first, so A→C along +z)
      soup.quad(A[k], C[k], C[k2], A[k2], tag);
    }
  }
  // end caps (flat bumper faces)
  for (const [ring, sign] of [[rings[0], -1], [rings[rings.length - 1], 1]] as const) {
    const c = new Vector3();
    ring.forEach((p) => c.add(p));
    c.divideScalar(ring.length);
    for (let k = 0; k < m; k++) {
      const a = ring[k], b = ring[(k + 1) % m];
      if (sign > 0) soup.tri(c, b, a, T_PAINT);
      else soup.tri(c, a, b, T_PAINT);
    }
  }
}

/**
 * Wrap-around bumper at one end (sign +1 front, −1 rear): a band standing ~2 cm proud of the
 * body, swept along the plan outline from wheel arch to wheel arch. Painted upper band (T_PAINT)
 * over a black textured lower insert (T_BUMPER); the ends taper into the side skin.
 */
function buildBumper(sign: 1 | -1, q: Quality, soup: TriSoup): void {
  const zEnd = sign > 0 ? B.front : B.rear;
  const zStart = sign * (B.axle + ARCH_EDGE + 0.02);
  const skin = (z: number) => { const si = sectionInfo(z); let x = 0; for (const y of [0.24, 0.3, 0.36, 0.42]) x = Math.max(x, si.skinX(y)); return x; };
  // right half of the outline in plan (x, z): side → around the corner → end-face centre
  const raw: Vector2[] = [];
  for (let i = 0; i <= 48; i++) { const z = lerp(zStart, zEnd, i / 48); raw.push(new Vector2(skin(z), z)); }
  const xf = skin(zEnd);
  for (let i = 1; i <= 12; i++) raw.push(new Vector2(xf * (1 - i / 12), zEnd));
  // resample evenly by arc length, then smooth (rounds the end fillet's tight turn)
  const len = [0];
  for (let i = 1; i < raw.length; i++) len.push(len[i - 1] + raw[i].distanceTo(raw[i - 1]));
  const L = len[len.length - 1], N = Math.ceil(L / (q === 'low' ? 0.06 : 0.04));
  let half: Vector2[] = [];
  for (let k = 0, j = 0; k <= N; k++) {
    const t = (k / N) * L;
    while (j < len.length - 2 && len[j + 1] < t) j++;
    half.push(raw[j].clone().lerp(raw[j + 1], (t - len[j]) / Math.max(1e-9, len[j + 1] - len[j])));
  }
  for (let it = 0; it < 3; it++) half = half.map((p, i) => (i === 0 || i === half.length - 1 ? p : p.clone().add(half[i - 1]).add(half[i + 1]).divideScalar(3)));
  half[half.length - 1].x = 0;
  // full path: left arch → centre → right arch
  const path = [...half.map((p) => new Vector2(-p.x, p.y)), ...half.slice(0, -1).reverse()];
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + path[i].distanceTo(path[i - 1]));
  const P = cum[cum.length - 1];
  const D = 0.022;
  const yT = sign > 0 ? 0.47 : 0.48, yM = sign > 0 ? 0.345 : 0.355, yB = 0.2;
  // cross-section (offset: fraction of the local depth d, or absolute when < 0 = tucked inside)
  const prof: [number, number, number][] = [
    [-0.015, yT + 0.008, T_PAINT], [0.45, yT, T_PAINT], [0.88, yT - 0.01, T_PAINT], [1, yT - 0.03, T_PAINT],
    [1, yM + 0.014, T_PAINT], [0.97, yM + 0.004, T_BUMPER], [0.86, yM, T_BUMPER], [0.9, yM - 0.01, T_BUMPER],
    [0.95, yB + 0.04, T_BUMPER], [0.8, yB + 0.01, T_BUMPER], [0.35, yB, T_BUMPER], [-0.02, yB + 0.012, T_BUMPER],
  ];
  const rows = path.map((p, i) => {
    const a = path[Math.max(0, i - 1)], b = path[Math.min(path.length - 1, i + 1)];
    const t = new Vector2().subVectors(b, a).normalize();
    const n = new Vector2(-t.y * sign, t.x * sign); // outward in plan
    const d = D * (0.2 + 0.8 * smooth(0, 0.16, Math.min(cum[i], P - cum[i])));
    return prof.map(([o, y]) => {
      const off = o < 0 ? o : o * d;
      return new Vector3(p.x + n.x * off, y, p.y + n.y * off);
    });
  });
  for (let i = 0; i < rows.length - 1; i++) {
    for (let j = 0; j < prof.length - 1; j++) {
      const a = rows[i][j], b = rows[i + 1][j], c = rows[i + 1][j + 1], d = rows[i][j + 1];
      if (sign > 0) soup.quad(a, d, c, b, prof[j][2]);
      else soup.quad(a, b, c, d, prof[j][2]);
    }
  }
}

/** Rakes the nose (fascia leans back toward the hood) and the rear panel (leans forward). */
function rakeEnds(soup: TriSoup): void {
  const p = soup.pos;
  for (let i = 0; i < p.length; i += 3) {
    const y = p[i + 1], z = p[i + 2];
    if (z > 1.78) p[i + 2] = z - 0.1 * smooth(0.36, 0.78, y) * smooth(1.78, B.front, z);
    else if (z < -1.9) p[i + 2] = z + 0.045 * smooth(0.5, 0.92, y) * smooth(-1.9, B.rear, z);
  }
}

// ---------------------------------------------------------------------------------------------
// Greenhouse: rings lofted between the beltline loop and the roof loop.

interface Loop { zF: number; zFs: number; zR: number; zRs: number; w: number; rc: number }
const BELT: Loop = { zF: B.beltF, zFs: B.beltF, zR: B.beltR, zRs: B.beltR, w: 0.735, rc: 0.09 };
const ROOF: Loop = { zF: 0.03, zFs: -0.02, zR: -1.0, zRs: -0.97, w: 0.62, rc: 0.1 };
const B_PILLAR = [-0.3, -0.4] as const;
const SEAL_W = 0.018;

/** Class of the loop cell that starts at each point. */
type Col = 'glass' | 'seal' | 'a' | 'b' | 'c';

/** Right half (x ≥ 0) from the front centre to the rear centre; points as (x, z). */
function halfLoop(L: Loop, q: Quality): { p: Vector2[]; col: Col[] } {
  const lo = q === 'low';
  const nF = lo ? 4 : 7, nC = 3, nS1 = lo ? 4 : 7, nS2 = lo ? 3 : 6, nR = lo ? 3 : 5;
  const wf = L.w - L.rc;
  const fz = (x: number) => L.zF - (L.zF - L.zFs) * sq(x / wf);
  const rz = (x: number) => L.zR + (L.zRs - L.zR) * sq(x / wf);
  const p: Vector2[] = [], col: Col[] = [];
  const put = (x: number, z: number, c: Col) => { p.push(new Vector2(x, z)); col.push(c); };
  const bez = (a: Vector2, b: Vector2, c: Vector2, t: number) => new Vector2(
    (1 - t) ** 2 * a.x + 2 * (1 - t) * t * b.x + t * t * c.x, (1 - t) ** 2 * a.y + 2 * (1 - t) * t * b.y + t * t * c.y);
  for (let i = 0; i < nF; i++) { const x = (i / nF) * (wf - SEAL_W); put(x, fz(x), 'glass'); }
  put(wf - SEAL_W, fz(wf - SEAL_W), 'seal');
  const zA = L.zFs - L.rc, zC = L.zRs + L.rc;
  for (let i = 0; i < nC; i++) {
    const b = bez(new Vector2(wf, L.zFs), new Vector2(L.w, L.zFs), new Vector2(L.w, zA), i / nC);
    put(b.x, b.y, 'a');
  }
  const run = (z0: number, z1: number, n: number, c: Col) => { for (let i = 0; i < n; i++) put(L.w, lerp(z0, z1, i / n), c); };
  run(zA, zA - SEAL_W, 1, 'seal');
  run(zA - SEAL_W, B_PILLAR[0] + SEAL_W, nS1, 'glass');
  run(B_PILLAR[0] + SEAL_W, B_PILLAR[0], 1, 'seal');
  run(B_PILLAR[0], B_PILLAR[1], 1, 'b');
  run(B_PILLAR[1], B_PILLAR[1] - SEAL_W, 1, 'seal');
  run(B_PILLAR[1] - SEAL_W, zC + SEAL_W, nS2, 'glass');
  run(zC + SEAL_W, zC, 1, 'seal');
  for (let i = 0; i < nC; i++) {
    const b = bez(new Vector2(L.w, zC), new Vector2(L.w, L.zRs), new Vector2(wf, L.zRs), i / nC);
    put(b.x, b.y, 'c');
  }
  put(wf, rz(wf), 'seal');
  for (let i = 0; i < nR; i++) { const x = (wf - SEAL_W) * (1 - i / nR); put(x, rz(x), 'glass'); }
  put(0, rz(0), 'glass'); // rear centre (end point)
  return { p, col };
}

/** Full closed loop: right half front→rear, left half (mirrored) rear→front. */
function fullLoop(L: Loop, q: Quality): { p: Vector2[]; col: Col[] } {
  const h = halfLoop(L, q);
  const n = h.p.length;
  const p = [...h.p], col = [...h.col.slice(0, n - 1)];
  for (let i = n - 1; i >= 1; i--) p.push(new Vector2(-h.p[i].x, h.p[i].y));
  p.pop(); // front centre is p[0]
  // left cells run the other way: cell (i → i-1) on the right has class col[i-1]
  for (let i = n - 1; i >= 1; i--) col.push(h.col[i - 1]);
  return { p, col };
}

function buildGreenhouse(q: Quality, soup: TriSoup): void {
  const belt = fullLoop(BELT, q), roof = fullLoop(ROOF, q);
  const n = belt.p.length;
  const col = belt.col;
  const levels = [-0.07, 0, 0.045, 0.25, 0.5, 0.75, 0.955, 1];
  const rows: Vector3[][] = [];
  const outward = (i: number, loop: Vector2[]) => {
    const a = loop[(i - 1 + n) % n], b = loop[(i + 1) % n];
    const t = new Vector2().subVectors(b, a).normalize();
    // loop runs front → +x side → rear → −x side: outward is the tangent turned toward −(inside)
    return new Vector2(-t.y, t.x);
  };
  for (const l of levels) {
    const row: Vector3[] = [];
    const t = Math.max(0, l);
    for (let i = 0; i < n; i++) {
      const b = belt.p[i], r = roof.p[i];
      const o = outward(i, belt.p);
      const bow = l < 0 ? 0.012 : 0.03 * Math.sin(Math.PI * t);
      const x = lerp(b.x, r.x, t) + o.x * bow, z = lerp(b.y, r.y, t) + o.y * bow;
      let y = lerp(topY(b.y, b.x) - 0.004, B.roofY, t);
      if (l < 0) y -= 0.035;
      row.push(new Vector3(x, y, z));
    }
    rows.push(row);
  }
  const roofC = new Vector2(0, (ROOF.zF + ROOF.zR) / 2);
  for (const [f, dy] of [[0.985, 0.014], [0.95, 0.022], [0.8, 0.03], [0.55, 0.036], [0.25, 0.039], [0, 0.04]] as const) {
    rows.push(roof.p.map((r) => new Vector3(lerp(roofC.x, r.x, f), B.roofY + dy, lerp(roofC.y, r.y, f))));
  }
  const nGlassRows = levels.length - 1; // rows 0..nGlassRows-1 are the sides; above is the roof
  const tagOf = (r: number, i: number): number => {
    const c = col[i];
    if (r === 0 || r >= nGlassRows) return T_PAINT;
    if (c === 'a' || c === 'c') return T_PAINT;
    if (c === 'b' || c === 'seal') return T_SEAL;
    return r === 1 || r === nGlassRows - 1 ? T_SEAL : T_GLASS;
  };
  const inset = (v: Vector3, roofRow: boolean) => {
    const dir = new Vector3(roofC.x - v.x, 0, roofC.y - v.z).normalize();
    return v.clone().addScaledVector(dir, 0.025).add(new Vector3(0, roofRow ? -0.03 : 0, 0));
  };
  for (let r = 0; r < rows.length - 1; r++) {
    for (let i = 0; i < n; i++) {
      const i2 = (i + 1) % n;
      const a = rows[r][i], b = rows[r][i2], c = rows[r + 1][i2], d = rows[r + 1][i];
      const tag = tagOf(r, i);
      soup.quad(a, b, c, d, tag);
      if (tag !== T_GLASS && r > 0) {
        const rr = r >= nGlassRows;
        soup.quad(inset(a, rr), inset(d, rr), inset(c, rr), inset(b, rr), T_LINER);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Materials

const PAINTS = [
  { color: 0xe8bf00, dirt: 0.25, cc: 1, rough: 0.3 }, // clean, fresh paint
  { color: 0xdca600, dirt: 0.75, cc: 0.55, rough: 0.4 }, // older, deeper, dusty
  { color: 0xefc614, dirt: 0.45, cc: 1, rough: 0.32 }, // lemon shade
] as const;

function paintMaterial(color: number, dirt: number): MeshPhysicalMaterial {
  const m = new MeshPhysicalMaterial({ color: new Color(color), roughness: 0.3, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.035 });
  const uDirt = { value: dirt };
  m.onBeforeCompile = (s) => {
    s.uniforms.uDirt = uDirt;
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vObj;\nvarying vec3 vObjN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObj = position; vObjN = normal;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
      uniform float uDirt;
      varying vec3 vObj;
      varying vec3 vObjN;
      ${GLSL_NOISE}
      // anti-aliased thin line at d = 0, width w (m); fades instead of aliasing when sub-pixel
      float prLine(float d, float w) { float fw = max(fwidth(d), 1e-5); float lw = max(w, fw); return (1.0 - smoothstep(lw * 0.5, lw * 0.5 + fw, abs(d))) * min(1.0, w / lw); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float prLow = 1.0 - smoothstep(0.22, 0.72, vObj.y);
        float prArch = 1.0 - smoothstep(0.25, 0.6, length(vec2(vObj.y - 0.35, abs(vObj.z) - ${B.axle.toFixed(2)})));
        float prN = prFbm(vObj * vec3(7.0, 11.0, 7.0));
        float prStreak = prNoise(vec3(vObj.x * 4.0, vObj.y * 0.7, vObj.z * 36.0));
        float prDirt = clamp(uDirt * (prLow * 0.95 + prArch * 0.55 + 0.03) * smoothstep(0.38, 0.8, prN + 0.28 * prStreak), 0.0, 1.0);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.28, 0.24, 0.18) * (0.75 + 0.5 * prN), prDirt * 0.8);
        float prSeam = 0.0;
        if (abs(vObjN.x) > 0.35 && vObj.y > 0.27 && vObj.y < 0.925) {
          prSeam = max(prSeam, prLine(vObj.z - 0.785, 0.004));
          prSeam = max(prSeam, prLine(vObj.z + 0.235, 0.004));
          prSeam = max(prSeam, prLine(vObj.z + 0.905, 0.004) * step(0.36, vObj.y));
          if (vObj.z < 0.785 && vObj.z > -0.905) prSeam = max(prSeam, prLine(vObj.y - 0.285, 0.004));
        }
        if (vObjN.y > 0.3) {
          // hood: side gutters + front edge; trunk lid on the deck: sides + front edge
          if (vObj.z > 0.8 && vObj.z < 1.9) prSeam = max(prSeam, prLine(abs(vObj.x) - 0.7, 0.004));
          if (vObj.z > 1.7 && vObj.y > 0.62 && abs(vObj.x) < 0.7) prSeam = max(prSeam, prLine(vObj.z - 1.9, 0.004));
          if (vObj.z < -1.47) {
            prSeam = max(prSeam, prLine(abs(vObj.x) - 0.52, 0.004));
            if (abs(vObj.x) < 0.52) prSeam = max(prSeam, prLine(vObj.z + 1.52, 0.004));
          }
        }
        if (vObjN.z < -0.5 && vObj.y > 0.5) {
          // trunk lid down the rear panel, between the tail lamps
          if (abs(vObj.x) < 0.52) prSeam = max(prSeam, prLine(vObj.y - 0.585, 0.004));
          if (vObj.y > 0.585) prSeam = max(prSeam, prLine(abs(vObj.x) - 0.52, 0.004));
        }
        diffuseColor.rgb *= 1.0 - 0.85 * prSeam;`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.9, prDirt);')
      .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n#ifdef USE_CLEARCOAT\nmaterial.clearcoat *= clamp(1.0 - prDirt * 0.9 - prSeam, 0.0, 1.0);\n#endif');
  };
  m.customProgramCacheKey = () => 'taxi-paint';
  return m;
}

// ---------------------------------------------------------------------------------------------
// Parts

const LOOK = {
  under: { color: 0x0f1011, rough: 0.85 },
  interior: { color: 0x232427, rough: 0.9 },
  seal: { color: 0x0b0c0d, rough: 0.35 },
  liner: { color: 0x4b4a47, rough: 0.95 },
  black: { color: 0x0d0e10, rough: 0.45 },
  chrome: { color: 0xd6dade, rough: 0.12, metal: 1 },
  bumper: { color: 0x16171a, rough: 0.72 },
  seat: { color: 0x2b2c30, rough: 0.92 },
} satisfies Record<string, PartLook>;

/** Decal projected onto `target` (box at pos, yawed rotY, size), uv mapped into atlas rect. */
function decal(target: Mesh, pos: Vector3, rotY: number, size: Vector3, rect: readonly [number, number, number, number], look: PartLook, lift = 0.003): BufferGeometry {
  const g = new DecalGeometry(target, pos, new Euler(0, rotY, 0), size);
  const p = g.getAttribute('position'), n = g.getAttribute('normal'), uv = g.getAttribute('uv');
  const [x, y, w, h] = rect;
  for (let i = 0; i < p.count; i++) {
    p.setXYZ(i, p.getX(i) + n.getX(i) * lift, p.getY(i) + n.getY(i) * lift, p.getZ(i) + n.getZ(i) * lift);
    uv.setXY(i, (x + uv.getX(i) * w) / 1024, 1 - (y + (1 - uv.getY(i)) * h) / 1024);
  }
  return paint(g, look, true);
}

/**
 * A lamp unit: the decal bulges off the body like a lens (edge lift → centre lift) and its
 * outline is closed down into the paint by a bezel wall, so it reads as a part with depth.
 */
function lamp(target: Mesh, pos: Vector3, rotY: number, size: Vector3, rect: readonly [number, number, number, number], look: PartLook, bezel: PartLook): BufferGeometry[] {
  const g = new DecalGeometry(target, pos, new Euler(0, rotY, 0), size);
  const p = g.getAttribute('position'), n = g.getAttribute('normal'), uv = g.getAttribute('uv');
  const base = (p.array as Float32Array).slice();
  const [x, y, w, h] = rect;
  for (let i = 0; i < p.count; i++) {
    const u = uv.getX(i), v = uv.getY(i);
    const lift = 0.004 + 0.009 * (1 - sq(2 * u - 1)) * (1 - sq(2 * v - 1));
    p.setXYZ(i, p.getX(i) + n.getX(i) * lift, p.getY(i) + n.getY(i) * lift, p.getZ(i) + n.getZ(i) * lift);
    uv.setXY(i, (x + u * w) / 1024, 1 - (y + (1 - v) * h) / 1024);
  }
  // boundary edges (used by one triangle only) → wall quads down to 3 mm under the surface
  const key = (i: number) => `${Math.round(base[i * 3] * 1e5)},${Math.round(base[i * 3 + 1] * 1e5)},${Math.round(base[i * 3 + 2] * 1e5)}`;
  const edges = new Map<string, [number, number] | null>();
  for (let t = 0; t < p.count; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = t + e, b = t + ((e + 1) % 3);
      const ka = key(a), kb = key(b);
      const fwd = `${ka}|${kb}`, rev = `${kb}|${ka}`;
      if (edges.has(rev)) edges.set(rev, null);
      else edges.set(fwd, [a, b]);
    }
  }
  const wall: number[] = [];
  const top = new Vector3(), bot = (i: number) => new Vector3(base[i * 3] - n.getX(i) * 0.003, base[i * 3 + 1] - n.getY(i) * 0.003, base[i * 3 + 2] - n.getZ(i) * 0.003);
  for (const e of edges.values()) {
    if (!e) continue;
    const [a, b] = e;
    const ta = top.fromBufferAttribute(p, a).toArray(), tb = new Vector3().fromBufferAttribute(p, b).toArray();
    const a0 = bot(a).toArray(), b0 = bot(b).toArray();
    wall.push(...ta, ...a0, ...b0, ...ta, ...b0, ...tb);
  }
  const wg = new BufferGeometry();
  wg.setAttribute('position', new Float32BufferAttribute(wall, 3));
  wg.computeVertexNormals();
  return [paint(g, look, true), paint(wg, bezel)];
}

function box(w: number, h: number, d: number, r: number, x: number, y: number, z: number, look: PartLook, rot?: Euler): BufferGeometry {
  const g = new RoundedBoxGeometry(w, h, d, 1, r);
  if (rot) g.applyMatrix4(new Matrix4().makeRotationFromEuler(rot));
  g.translate(x, y, z);
  return paint(g, look);
}

/** Lathe with crease-aware normals (wheel parts). */
const latheY = (p: Profile, segs: number) => withNormals(lathe(p, segs), 50);

function wheelGeometry(q: Quality): BufferGeometry {
  const segs = q === 'low' ? 18 : 28;
  const tire: Profile = [
    [0.19, -0.08], [0.215, -0.093], [0.265, -0.096], [0.297, -0.084], [0.305, -0.066], [0.305, -0.012],
    [0.298, -0.009], [0.298, 0.009], [0.305, 0.012], [0.305, 0.066], [0.297, 0.084], [0.265, 0.096], [0.215, 0.093], [0.19, 0.08],
  ];
  const hub: Profile = [
    [0.198, 0.074], [0.186, 0.086], [0.155, 0.088], [0.1, 0.092], [0.07, 0.09], [0.058, 0.097], [0, 0.101],
  ];
  const back: Profile = [[0, -0.05], [0.19, -0.05], [0.19, -0.08]];
  const t = paintFn(latheY(tire, segs), (_i, p, l) => {
    const r = Math.hypot(p.x, p.z);
    l.c.set(r > 0.3 ? 0x0b0b0b : 0x111111);
    l.r = r > 0.3 ? 0.95 : 0.82;
  });
  const h = paintFn(latheY(hub, q === 'low' ? 24 : 40), (_i, p, l) => {
    const r = Math.hypot(p.x, p.z), a = Math.atan2(p.x, p.z);
    const vent = r > 0.085 && r < 0.155 && Math.cos(a * 8) > 0.55;
    l.c.set(vent ? 0x111214 : r < 0.04 ? 0x55595e : 0xc9cdd2);
    l.r = vent ? 0.6 : 0.3;
    l.m = vent ? 0 : 1;
  });
  const bk = paint(latheY(back, segs), { color: 0x2a2b2d, rough: 0.7, metal: 0.4 });
  const g = mergeParts([t, h, bk]);
  g.rotateZ(-Math.PI / 2); // axis Y → X, hubcap facing +X
  g.computeBoundingSphere();
  return g;
}

/** Everything black/chrome/lit on the car (+ the roof sign of one style) in one geometry. */
function atlasParts(paintMesh: Mesh, style: number, soupParts: Map<number, BufferGeometry>): BufferGeometry {
  const A = TAXI_ATLAS;
  const parts: BufferGeometry[] = [];
  const add = (tag: number, look: PartLook) => { const g = soupParts.get(tag); if (g) parts.push(paint(g.clone(), look)); };
  add(T_UNDER, LOOK.under);
  add(T_INTERIOR, LOOK.interior);
  add(T_SEAL, LOOK.seal);
  add(T_LINER, LOOK.liner);
  add(T_BUMPER, LOOK.bumper);
  const bumper = new Mesh(soupParts.get(T_BUMPER));
  bumper.updateMatrixWorld(true);
  const head = { color: 0xffffff, rough: 0.06, metal: 0.9, emit: 5, channel: 1 };
  const tail = { color: 0xffffff, rough: 0.08, metal: 0.2, emit: 2.6, channel: 2 };
  const plate = { color: 0xffffff, rough: 0.4, metal: 0.2 };
  const grille = { color: 0xffffff, rough: 0.5, metal: 0.3 };
  const WHITE = [0, 0, 16, 16] as const;
  for (const s of [-1, 1]) {
    parts.push(...lamp(paintMesh, new Vector3(s * 0.6, 0.675, 2.0), 0, new Vector3(0.4, 0.13, 0.6), A.head, head, LOOK.chrome));
    parts.push(...lamp(paintMesh, new Vector3(s * 0.62, 0.78, -2.1), Math.PI, new Vector3(0.3, 0.13, 0.6), A.tail, tail, LOOK.black));
    // red reflectors on the rear bumper insert
    parts.push(decal(bumper, new Vector3(s * 0.6, 0.29, B.rear), Math.PI, new Vector3(0.14, 0.035, 0.3), WHITE, { color: 0x9a0a12, rough: 0.2 }, 0.002));
  }
  parts.push(decal(paintMesh, new Vector3(0, 0.655, 2.0), 0, new Vector3(0.72, 0.085, 0.5), A.grille, grille));
  parts.push(decal(bumper, new Vector3(0, 0.272, 2.1), 0, new Vector3(0.95, 0.085, 0.3), A.lower, grille, 0.002));
  parts.push(decal(paintMesh, new Vector3(0, 0.41, 2.12), 0, new Vector3(0.5, 0.11, 0.3), A.plate(style), plate));
  parts.push(decal(paintMesh, new Vector3(0, 0.665, -2.12), Math.PI, new Vector3(0.5, 0.11, 0.4), A.plate(style), plate));
  // mirrors, handles, wipers, exhaust
  for (const s of [-1, 1]) {
    parts.push(box(0.2, 0.11, 0.075, 0.03, s * 0.9, 0.97, 0.6, LOOK.black, new Euler(0, s * 0.1, 0)));
    parts.push(box(0.06, 0.04, 0.05, 0.01, s * 0.8, 0.935, 0.63, LOOK.black));
    parts.push(box(0.16, 0.085, 0.006, 0.003, s * 0.905, 0.97, 0.56, { color: 0xcfd6dc, rough: 0.03, metal: 1 }, new Euler(0, s * 0.1, 0)));
    for (const z of [-0.07, -0.76]) {
      const x = sectionInfo(z).skinX(0.8);
      parts.push(box(0.022, 0.028, 0.14, 0.01, s * (x + 0.006), 0.8, z, LOOK.black));
    }
  }
  for (const x of [0.28, -0.26]) parts.push(box(0.55, 0.012, 0.022, 0.005, x, 0.93, 0.72, LOOK.black, new Euler(0.5, 0, x > 0 ? 0.06 : -0.05)));
  {
    const ex = new CylinderGeometry(0.028, 0.028, 0.12, 12);
    ex.rotateX(Math.PI / 2);
    ex.translate(-0.45, 0.175, B.rear + 0.03);
    parts.push(paint(ex, { color: 0x3a3632, rough: 0.5, metal: 0.8 }));
  }
  // interior: dashboard, steering wheel, seats, headrests
  parts.push(box(1.42, 0.24, 0.34, 0.05, 0, 0.8, 0.56, LOOK.interior));
  {
    const sw = new TorusGeometry(0.18, 0.018, 8, 28);
    sw.rotateX(-0.45);
    sw.translate(0.37, 0.88, 0.36);
    parts.push(paint(sw, LOOK.black));
  }
  for (const s of [-1, 1]) {
    parts.push(box(0.48, 0.13, 0.46, 0.05, s * 0.37, B.floorY + 0.12, 0.2, LOOK.seat));
    parts.push(box(0.48, 0.58, 0.12, 0.05, s * 0.37, 0.8, -0.08, LOOK.seat, new Euler(-0.15, 0, 0)));
    parts.push(box(0.26, 0.17, 0.1, 0.04, s * 0.37, 1.17, -0.14, LOOK.seat));
    parts.push(box(0.24, 0.15, 0.09, 0.04, s * 0.4, 1.12, -1.12, LOOK.seat));
  }
  parts.push(box(1.36, 0.13, 0.46, 0.05, 0, B.floorY + 0.12, -0.72, LOOK.seat));
  parts.push(box(1.36, 0.5, 0.12, 0.05, 0, 0.77, -1.04, LOOK.seat, new Euler(-0.2, 0, 0)));
  parts.push(box(1.4, 0.02, 0.36, 0.008, 0, 0.935, -1.27, LOOK.interior)); // parcel shelf
  // roof sign: lightbox with lettered faces + foot
  const st = [
    { w: 0.56, h: 0.14, d: 0.13 },
    { w: 0.5, h: 0.15, d: 0.16 },
    { w: 0.62, h: 0.125, d: 0.12 },
  ][style];
  const signZ = -0.42, signY = B.roofY + 0.04 + 0.016;
  parts.push(box(st.w * 0.72, 0.018, st.d * 1.1, 0.006, 0, signY + 0.009 - 0.008, signZ, LOOK.black));
  {
    const g = new RoundedBoxGeometry(st.w, st.h, st.d, 2, 0.012);
    const pos = g.getAttribute('position'), nor = g.getAttribute('normal'), uv = g.getAttribute('uv');
    const front = A.sign(style, false), back = A.sign(style, true);
    const bg = new Color(SIGN_STYLES[style].bg);
    const col = new Float32Array(pos.count * 3), pbr = new Float32Array(pos.count * 4);
    for (let i = 0; i < pos.count; i++) {
      const nz = nor.getZ(i);
      const x = pos.getX(i), y = pos.getY(i);
      const faceZ = Math.abs(nz) > 0.7;
      if (faceZ) {
        const [rx, ry, rw, rh] = nz > 0 ? front : back;
        const u = nz > 0 ? x / st.w + 0.5 : 0.5 - x / st.w;
        const v = y / st.h + 0.5;
        uv.setXY(i, (rx + u * rw) / 1024, 1 - (ry + (1 - v) * rh) / 1024);
        col.set([1, 1, 1], i * 3);
      } else {
        uv.setXY(i, 4 / 1024, 1 - 4 / 1024);
        col.set([bg.r, bg.g, bg.b], i * 3);
      }
      pbr.set([0.35, 0, faceZ ? 1.6 : 0.4, 3], i * 4);
    }
    g.setAttribute('color', new BufferAttribute(col, 3));
    g.setAttribute('pbr', new BufferAttribute(pbr, 4));
    g.translate(0, signY + 0.018 + st.h / 2, signZ);
    parts.push(g);
  }
  return mergeParts(parts);
}

// ---------------------------------------------------------------------------------------------

export interface TaxiLib {
  make(variant: number): TaxiModel;
}

/** Lamp states → emission levels (head, tail, sign); one shared atlas material per state. */
const LAMP_STATES = [
  [0.35, 0.25], // idle: parking lights
  [0.35, 1], // braking
  [1.6, 0.25], // honk flash
  [1.6, 1], // honk flash while braking
] as const;
const SIGN_LEVEL = 0.85;

export function createTaxis(renderer: WebGLRenderer, quality: Quality, trash: Trash): TaxiLib {
  const soup = new TriSoup();
  buildLowerBody(quality, soup);
  buildBumper(1, quality, soup);
  buildBumper(-1, quality, soup);
  rakeEnds(soup);
  buildGreenhouse(quality, soup);
  const parts = soup.build(38);
  const paintGeo = trash.add(parts.get(T_PAINT)!);
  paintGeo.computeBoundingSphere();
  const glassGeo = parts.get(T_GLASS)!;
  {
    // recess the glass a few mm behind its seals
    const p = glassGeo.getAttribute('position'), n = glassGeo.getAttribute('normal');
    for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) - n.getX(i) * 0.004, p.getY(i) - n.getY(i) * 0.004, p.getZ(i) - n.getZ(i) * 0.004);
    glassGeo.computeBoundingSphere();
  }
  trash.add(glassGeo);
  const tex = taxiTextures(renderer, texScale(quality));
  trash.add(tex.map); trash.add(tex.emit);
  const target = new Mesh(paintGeo);
  target.updateMatrixWorld(true);
  const atlasGeo = [0, 1, 2].map((s) => trash.add(atlasParts(target, s, parts)));
  for (const t of [T_UNDER, T_INTERIOR, T_SEAL, T_LINER, T_BUMPER]) parts.get(t)?.dispose();
  const paints = PAINTS.map((p) => { const m = trash.add(paintMaterial(p.color, p.dirt)); m.clearcoat = p.cc; m.roughness = p.rough; return m; });
  const glass = trash.add(glassify(new MeshPhysicalMaterial({
    color: new Color(0x0c1216), roughness: 0.03, metalness: 0, opacity: 0.8, ior: 1.52, envMapIntensity: 1.4,
  }), 'taxi'));
  const lampMats = LAMP_STATES.map(([h, t]) => trash.add(vertexPbr(
    new MeshStandardMaterial({ map: tex.map, emissiveMap: tex.emit }), 'taxi-atlas', newLevels(h, t, SIGN_LEVEL, 1))));
  // wheels: one geometry for a single wheel (front, steerable) and one for the rear axle pair
  const wheelGeo = trash.add(wheelGeometry(quality));
  const rearGeo = trash.add(mergeParts([
    wheelGeo.clone().translate(B.wheelX, 0, 0),
    wheelGeo.clone().rotateY(Math.PI).translate(-B.wheelX, 0, 0),
  ]));
  const wheelMat = trash.add(vertexPbr(new MeshStandardMaterial(), 'taxi-wheel'));

  return {
    make(variant) {
      const v = ((variant % 3) + 3) % 3;
      const root = new Group();
      root.name = `taxi-${v}`;
      const body = new Mesh(paintGeo, paints[v]);
      const glassMesh = new Mesh(glassGeo, glass);
      const atlas = new Mesh(atlasGeo[v], lampMats[0]);
      const wheel = (g: BufferGeometry, x: number, z: number) => {
        const w = new Mesh(g, wheelMat);
        w.position.set(x, B.wheelR, z);
        w.rotation.order = 'YXZ'; // steer about Y, then spin about the axle
        w.castShadow = w.receiveShadow = true;
        return w;
      };
      const fr = wheel(wheelGeo, B.wheelX, B.axle), fl = wheel(wheelGeo, -B.wheelX, B.axle), rear = wheel(rearGeo, 0, -B.axle);
      // body + wheels give the shadow silhouette; trim/interior would only add shadow-pass cost
      body.castShadow = true;
      body.receiveShadow = atlas.receiveShadow = true;
      root.add(body, atlas, fr, fl, rear, glassMesh);

      let spin = 0, braking = false, honkT = 0;
      const pose = (steer: number) => {
        fr.rotation.set(spin, steer, 0);
        fl.rotation.set(-spin, steer + Math.PI, 0); // left wheel is the right one turned around
        rear.rotation.x = spin;
      };
      pose(0);

      return {
        root,
        length: TAXI_SIZE.length,
        width: TAXI_SIZE.width,
        height: TAXI_SIZE.height,
        /** distance: metres travelled this frame (negative = reversing). steer: front-wheel angle,
         *  clamped to ±0.6 rad; positive turns toward +X, i.e. the car's LEFT (it faces +Z). */
        update(dt, distance, steerAngle) {
          spin = (spin + distance / B.wheelR) % (Math.PI * 2);
          pose(Math.max(-0.6, Math.min(0.6, steerAngle)));
          let flash = false;
          if (honkT > 0) {
            honkT = Math.max(0, honkT - dt);
            const t = 0.5 - honkT; // two quick flashes
            flash = (t > 0 && t < 0.12) || (t > 0.22 && t < 0.34);
          }
          atlas.material = lampMats[(flash ? 2 : 0) + (braking ? 1 : 0)];
        },
        setBraking(on) { braking = on; },
        honk() { honkT = 0.5; },
      };
    },
  };
}
