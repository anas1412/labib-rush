// Geometry kit for the landmarks: architectural primitives + a per-material merge bucket.
// All helpers return fresh, non-shared BufferGeometries in local coordinates; `Bucket.add` bakes a
// transform in and `Bucket.build` merges everything per material into one mesh (one draw call).
import {
  BoxGeometry, BufferAttribute, BufferGeometry, CylinderGeometry, ExtrudeGeometry, Group, LatheGeometry, LOD,
  Matrix4, Mesh, Object3D, Path, Quaternion, Shape, Euler, Vector2, Vector3, type Material, type MeshStandardMaterial,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// ---------------------------------------------------------------------------------------------
// Transforms

const _q = new Quaternion();
const _e = new Euler();
/** Translation + Euler rotation (radians, order YXZ) + uniform or per-axis scale. */
export function T(x = 0, y = 0, z = 0, ry = 0, rx = 0, rz = 0, s: number | [number, number, number] = 1): Matrix4 {
  const sc = typeof s === 'number' ? new Vector3(s, s, s) : new Vector3(...s);
  return new Matrix4().compose(new Vector3(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz, 'YXZ')), sc);
}

// ---------------------------------------------------------------------------------------------
// Merge bucket

export interface BuildOptions {
  castShadow?: boolean;
  receiveShadow?: boolean;
}

/** Beyond this camera distance (m) fine ornament added with `Bucket.addDetail` is not drawn. */
export const DETAIL_DIST = 140;

/** Materials whose `userData.tile` (meters per texture repeat) is set get world box-projected UVs. */
export class Bucket {
  private lists = new Map<Material, BufferGeometry[]>();
  private detail = new Map<Material, BufferGeometry[]>();
  private opts = new Map<Material, BuildOptions>();

  /** Adds `geo` (consumed) transformed by `m`. */
  add(mat: Material, geo: BufferGeometry, m?: Matrix4): void {
    push(this.lists, mat, m ? geo.applyMatrix4(m) : geo);
  }

  /** Fine ornament (garlands, reliefs, small statues): merged into its own mesh per material that
   *  casts no shadow and is hidden beyond DETAIL_DIST. */
  addDetail(mat: Material, geo: BufferGeometry, m?: Matrix4): void {
    push(this.detail, mat, m ? geo.applyMatrix4(m) : geo);
  }

  /** Adds a copy of `geo` for every matrix. */
  addMany(mat: Material, geo: BufferGeometry, ms: Matrix4[]): void {
    for (const m of ms) this.add(mat, geo.clone(), m);
    geo.dispose();
  }

  setOptions(mat: Material, o: BuildOptions): void {
    this.opts.set(mat, o);
  }

  /**
   * Merges per material. Materials whose `userData.trim` points at a shared "trim" material are
   * merged together into that one (their colour / roughness / metalness baked into per-vertex
   * `color` and `pbr` attributes), which keeps small metal/wood/marble parts to one draw call.
   */
  build(name: string): Group {
    const g = new Group();
    g.name = name;
    for (const [mat, list] of byTarget(this.lists)) {
      const mesh = mergedMesh(`${name}:${mat.name}`, mat, list);
      const o = this.opts.get(mat) ?? {};
      // small trim parts and panes inside frames add shadow-pass cost for no visible gain
      mesh.castShadow = o.castShadow ?? !['trim', 'glass', 'shopWindow'].includes(mat.name);
      mesh.receiveShadow = o.receiveShadow ?? true;
      g.add(mesh);
    }
    for (const [mat, list] of byTarget(this.detail)) {
      const mesh = mergedMesh(`${name}:${mat.name}:detail`, mat, list);
      // LOD distance is measured to the LOD's origin: move it to the mesh centre
      const c = mesh.geometry.boundingSphere!.center;
      const lod = new LOD();
      lod.name = mesh.name;
      lod.position.copy(c);
      mesh.position.copy(c).negate();
      mesh.updateMatrix();
      lod.addLevel(mesh, 0);
      lod.addLevel(new Object3D(), DETAIL_DIST);
      g.add(lod);
    }
    this.lists.clear();
    this.detail.clear();
    return g;
  }
}

function push(map: Map<Material, BufferGeometry[]>, mat: Material, geo: BufferGeometry): void {
  let l = map.get(mat);
  if (!l) map.set(mat, (l = []));
  l.push(geo);
}

/** Normalises every geometry and regroups them by draw material (trim materials → shared trim). */
function byTarget(lists: Map<Material, BufferGeometry[]>): Map<Material, BufferGeometry[]> {
  const groups = new Map<Material, BufferGeometry[]>();
  let base = 0;
  for (const [mat, list] of lists) {
    const target = (mat.userData.trim as Material | undefined) ?? mat;
    for (const geo of list) {
      const n = deindex(clean(geo), base);
      base += geo.attributes.position.count;
      if (target !== mat) paint(n, mat as MeshStandardMaterial);
      push(groups, target, n);
      if (n !== geo) geo.dispose();
    }
  }
  return groups;
}

/** One static mesh from prepared (non-indexed) geometries: box-projected UVs if the material is
 *  tiled, then re-indexed so shared vertices are shaded once (≈3× fewer vertex invocations). */
function mergedMesh(name: string, mat: Material, prepared: BufferGeometry[]): Mesh {
  const merged = mergeGeometries(prepared, false);
  prepared.forEach((p) => p.dispose());
  if (!merged) throw new Error(`landmarks: merge failed for ${name}`);
  const tile = mat.userData.tile as number | undefined;
  if (tile) boxProjectUV(merged, tile);
  const indexed = reindex(merged);
  merged.dispose();
  indexed.computeBoundingSphere();
  indexed.computeBoundingBox();
  const mesh = new Mesh(indexed, mat);
  mesh.name = name;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}

/** Non-indexed version of `g` with an `origin` attribute: base + the source vertex of each corner. */
function deindex(g: BufferGeometry, base: number): BufferGeometry {
  const idx = g.index?.array;
  const n = idx ? idx.length : g.attributes.position.count;
  const org = new Float32Array(n); // exact for ids < 2^24
  for (let i = 0; i < n; i++) org[i] = base + (idx ? idx[i] : i);
  const out = idx ? g.toNonIndexed() : g;
  out.setAttribute('origin', new BufferAttribute(org, 1));
  return out;
}

/**
 * Inverse of `deindex` after per-triangle UV projection: corners that came from the same source
 * vertex and got the same UV become one vertex again (position/normal/colour were shared by
 * construction); corners on a projection seam keep their own copy. O(n), exact.
 */
function reindex(g: BufferGeometry): BufferGeometry {
  const org = g.attributes.origin.array, uv = g.attributes.uv.array;
  const n = org.length;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) { lo = Math.min(lo, org[i]); hi = Math.max(hi, org[i]); }
  const head = new Int32Array(hi - lo + 1).fill(-1); // latest kept corner per origin
  const chain = new Int32Array(n); // previous kept corner of the same origin
  const remap = new Uint32Array(n), keep = new Uint32Array(n);
  let kept = 0;
  for (let i = 0; i < n; i++) {
    const o = org[i] - lo;
    let j = head[o], k = -1;
    while (j >= 0) {
      if (uv[j * 2] === uv[i * 2] && uv[j * 2 + 1] === uv[i * 2 + 1]) { k = remap[j]; break; }
      j = chain[j];
    }
    if (k < 0) {
      chain[i] = head[o];
      head[o] = i;
      k = kept;
      keep[kept++] = i;
    }
    remap[i] = k;
  }
  const out = new BufferGeometry();
  for (const [name, a] of Object.entries(g.attributes)) {
    if (name === 'origin') continue;
    const sz = a.itemSize, src = a.array as Float32Array, dst = new Float32Array(kept * sz);
    for (let i = 0; i < kept; i++) for (let c = 0; c < sz; c++) dst[i * sz + c] = src[keep[i] * sz + c];
    out.setAttribute(name, new BufferAttribute(dst, sz));
  }
  out.setIndex(new BufferAttribute(kept > 65535 ? remap : new Uint16Array(remap), 1));
  return out;
}

/** Bakes a material's colour (linear) and roughness/metalness into vertex attributes. */
function paint(g: BufferGeometry, m: MeshStandardMaterial): void {
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3), pbr = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    col[i * 3] = m.color.r; col[i * 3 + 1] = m.color.g; col[i * 3 + 2] = m.color.b;
    pbr[i * 2] = m.roughness; pbr[i * 2 + 1] = m.metalness;
  }
  g.setAttribute('color', new BufferAttribute(col, 3));
  g.setAttribute('pbr', new BufferAttribute(pbr, 2));
}

const KEEP = new Set(['position', 'normal', 'uv', 'color', 'pbr']);
/** Strips `g` (in place) to position/normal/uv/color/pbr, uv zero-filled if absent. */
function clean(g: BufferGeometry): BufferGeometry {
  for (const k of Object.keys(g.attributes)) if (!KEEP.has(k)) g.deleteAttribute(k);
  g.morphAttributes = {};
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.uv) g.setAttribute('uv', new BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  return g;
}

/** Per-triangle box projection in the geometry's frame: uv = coords / tile on the dominant plane. */
export function boxProjectUV(g: BufferGeometry, tile: number): void {
  const p = g.attributes.position.array as Float32Array;
  const uv = new Float32Array((p.length / 3) * 2);
  const a = new Vector3(), b = new Vector3(), c = new Vector3(), n = new Vector3();
  for (let t = 0; t < p.length / 9; t++) {
    a.fromArray(p, t * 9); b.fromArray(p, t * 9 + 3); c.fromArray(p, t * 9 + 6);
    n.subVectors(c, b).cross(b.clone().sub(a));
    const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
    for (let k = 0; k < 3; k++) {
      const x = p[t * 9 + k * 3], y = p[t * 9 + k * 3 + 1], z = p[t * 9 + k * 3 + 2];
      let u: number, v: number;
      if (ay >= ax && ay >= az) { u = x; v = -z; } // same as the street's paving (x/t, −z/t)
      else if (ax >= az) { u = n.x > 0 ? -z : z; v = y; }
      else { u = n.z > 0 ? x : -x; v = y; }
      uv[(t * 3 + k) * 2] = u / tile;
      uv[(t * 3 + k) * 2 + 1] = v / tile;
    }
  }
  g.setAttribute('uv', new BufferAttribute(uv, 2));
}

// ---------------------------------------------------------------------------------------------
// Primitives (origin conventions noted per helper)

/** Box with its base centred on the origin (y from 0 to h). */
export function box(w: number, h: number, d: number): BufferGeometry {
  return new BoxGeometry(w, h, d).translate(0, h / 2, 0);
}

/** Upright cylinder / frustum with its base on the origin. */
export function cyl(rTop: number, rBottom: number, h: number, segs = 16, open = false): BufferGeometry {
  return new CylinderGeometry(rTop, rBottom, h, segs, 1, open).translate(0, h / 2, 0);
}

/** Lathe around Y from [radius, y] pairs (bottom to top). */
export function lathe(pts: [number, number][], segs = 24, phiStart = 0, phiLength = Math.PI * 2): BufferGeometry {
  return new LatheGeometry(pts.map(([r, y]) => new Vector2(Math.max(r, 1e-4), y)), segs, phiStart, phiLength);
}

/** Faceted copy (flat normals), e.g. for low-segment lathes that should read as cut stone. */
export function flat(g: BufferGeometry): BufferGeometry {
  const f = g.index ? g.toNonIndexed() : g;
  if (f !== g) g.dispose();
  f.computeVertexNormals();
  return f;
}

/** Extrudes a Shape (in XY) along +Z by `depth`. */
export function extrude(shape: Shape, depth: number, curveSegments = 12): BufferGeometry {
  return new ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments });
}

export type ArchKind = 'round' | 'horseshoe' | 'pointed' | 'segmental' | 'flat';

/**
 * Outline of an arched opening in XY as a closed counter-clockwise loop: centred on cx, from y0
 * (sill) up the jambs to `spring`, then the arch head. For 'horseshoe', `spring` is the height of
 * the arch circle's centre (its widest point); the jambs stop below it where the arc turns inward.
 */
export function archOutline(cx: number, y0: number, w: number, spring: number, kind: ArchKind = 'round', segs = 16): Vector2[] {
  const r = w / 2;
  const P = (x: number, y: number) => new Vector2(x, y);
  if (kind === 'flat') return [P(cx - r, y0), P(cx + r, y0), P(cx + r, spring), P(cx - r, spring)];
  if (kind === 'horseshoe') {
    const R = r * HORSESHOE_K;
    const beta = Math.acos(1 / HORSESHOE_K);
    const jamb = spring - R * Math.sin(beta);
    const pts = [P(cx - r, y0), P(cx + r, y0), P(cx + r, jamb)];
    const n = segs * 2;
    for (let i = 1; i < n; i++) {
      const a = -beta + ((Math.PI + 2 * beta) * i) / n;
      const lift = Math.pow(Math.max(0, Math.sin(a)), 10) * R * 0.1; // slightly pointed crown
      pts.push(P(cx + R * Math.cos(a), spring + R * Math.sin(a) + lift));
    }
    pts.push(P(cx - r, jamb));
    return pts;
  }
  const pts = [P(cx - r, y0), P(cx + r, y0), P(cx + r, spring)];
  if (kind === 'round') {
    for (let i = 1; i < segs; i++) {
      const a = (Math.PI * i) / segs;
      pts.push(P(cx + Math.cos(a) * r, spring + Math.sin(a) * r));
    }
  } else if (kind === 'segmental') {
    const h = r * 0.35;
    const R = (r * r + h * h) / (2 * h);
    const cy = spring + h - R;
    const a0 = Math.asin(r / R);
    for (let i = 1; i < segs; i++) {
      const t = a0 - (2 * a0 * i) / segs;
      pts.push(P(cx + R * Math.sin(t), cy + R * Math.cos(t)));
    }
  } else {
    const R = w * POINTED_K;
    const aMax = Math.acos((R - r) / R);
    const n = Math.max(2, segs / 2);
    for (let i = 1; i <= n; i++) {
      const a = (aMax * i) / n;
      pts.push(P(cx + r - R + R * Math.cos(a), spring + R * Math.sin(a)));
    }
    for (let i = n - 1; i >= 1; i--) {
      const a = Math.PI - (aMax * i) / n;
      pts.push(P(cx - r + R + R * Math.cos(a), spring + R * Math.sin(a)));
    }
  }
  pts.push(P(cx - r, spring));
  return pts;
}

const HORSESHOE_K = 1.14; // arch circle radius / half opening
const POINTED_K = 0.8; // arc radius / opening width (0.5 = round, 1 = equilateral)

/** Height of the top of an arch outline (absolute, same frame as `spring`). */
export function archTop(w: number, spring: number, kind: ArchKind): number {
  const r = w / 2;
  switch (kind) {
    case 'round': return spring + r;
    case 'segmental': return spring + r * 0.35;
    case 'pointed': { const R = w * POINTED_K; return spring + R * Math.sin(Math.acos((R - r) / R)); }
    case 'horseshoe': return spring + r * HORSESHOE_K * 1.1;
    default: return spring;
  }
}

export interface Opening {
  cx: number; // centre x (wall-local)
  y0: number; // sill height
  w: number;
  spring: number; // spring line height (top of the straight jambs)
  kind?: ArchKind;
}

/**
 * Wall slab in the XY plane (x from -w/2..w/2, y 0..h), extruded toward +Z by `depth`, with
 * arched openings cut through. Place with a matrix so +Z points outward (the facade normal).
 */
export function wall(w: number, h: number, depth: number, openings: Opening[] = [], x0 = -w / 2): BufferGeometry {
  const s = new Shape();
  s.moveTo(x0, 0); s.lineTo(x0 + w, 0); s.lineTo(x0 + w, h); s.lineTo(x0, h); s.closePath();
  for (const o of openings) {
    const pts = archOutline(o.cx, o.y0, o.w, o.spring, o.kind ?? 'round').reverse();
    s.holes.push(new Path(pts));
  }
  return extrude(s, depth);
}

/** Flat panel (for glass/doors) filling an opening, in XY at z = 0, facing +Z. */
export function openingPanel(o: Opening): BufferGeometry {
  const s = new Shape(archOutline(o.cx, o.y0, o.w, o.spring, o.kind ?? 'round'));
  const g = extrude(s, 0.02, 12);
  return g;
}

/**
 * Molding: a profile [out, up] (meters, `out` = projection from the wall, `up` = height) extruded
 * along X over `length`, centred at x=0; the wall face is z = 0, projecting toward +Z.
 */
export function molding(profile: [number, number][], length: number): BufferGeometry {
  const s = new Shape();
  s.moveTo(0, profile[0][1]);
  for (const [o, u] of profile) s.lineTo(o, u);
  s.lineTo(0, profile[profile.length - 1][1]);
  s.closePath();
  // shape is (x = out, y = up), extruded along +Z; rotating -90° about Y maps out → +Z and the
  // extrusion to -X, then centre it.
  const g = extrude(s, length, 1);
  g.rotateY(-Math.PI / 2);
  g.translate(length / 2, 0, 0);
  return g;
}

/** Common cornice profiles (out, up), meters. Scale with `k`. */
export const PROFILES = {
  cornice: (k = 1): [number, number][] => [[0.02, 0], [0.08, 0.04], [0.1, 0.12], [0.16, 0.16], [0.22, 0.2], [0.36, 0.26], [0.42, 0.32], [0.44, 0.4], [0.02, 0.42]].map(([a, b]) => [a * k, b * k]),
  string: (k = 1): [number, number][] => [[0.02, 0], [0.08, 0.03], [0.1, 0.1], [0.14, 0.14], [0.14, 0.2], [0.02, 0.22]].map(([a, b]) => [a * k, b * k]),
  base: (k = 1): [number, number][] => [[0.2, 0], [0.2, 0.35], [0.14, 0.42], [0.1, 0.5], [0.02, 0.56]].map(([a, b]) => [a * k, b * k]),
  sill: (k = 1): [number, number][] => [[0.02, 0], [0.12, 0.02], [0.14, 0.08], [0.1, 0.12], [0.02, 0.12]].map(([a, b]) => [a * k, b * k]),
};

/** Arch molding (archivolt): a stepped [radial, out] profile swept over the arc a0..a1 (radians,
 *  0 = +X, π/2 = up) of radius r in the XY plane (centre at origin), projecting toward +Z. */
export function archivolt(r: number, width: number, depth: number, segs = 24, a0 = 0, a1 = Math.PI): BufferGeometry {
  const pts: [number, number][] = [
    [r + width, 0], [r + width, depth * 0.6], [r + width * 0.8, depth], [r + width * 0.2, depth], [r, depth * 0.7], [r, 0],
  ];
  // Lathe point (ρ sinφ, y, ρ cosφ) rotated +90° about X → (ρ sinφ, -ρ cosφ, y): arc angle α = φ - π/2.
  const g = lathe(pts, segs, a0 + Math.PI / 2, a1 - a0);
  g.rotateX(Math.PI / 2);
  return g;
}

/** Ring/torus-like band around an arch: tube of radius tr along a circle arc of radius r (XY). */
export function arcTube(r: number, tr: number, a0 = 0, a1 = Math.PI, segs = 24, radial = 8): BufferGeometry {
  const pts: number[] = [], idx: number[] = [];
  for (let i = 0; i <= segs; i++) {
    const a = a0 + ((a1 - a0) * i) / segs;
    const c = new Vector3(Math.cos(a) * r, Math.sin(a) * r, 0);
    const n = new Vector3(Math.cos(a), Math.sin(a), 0);
    for (let j = 0; j <= radial; j++) {
      const b = (Math.PI * 2 * j) / radial;
      const p = c.clone().addScaledVector(n, Math.cos(b) * tr).add(new Vector3(0, 0, Math.sin(b) * tr));
      pts.push(p.x, p.y, p.z);
    }
  }
  for (let i = 0; i < segs; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * (radial + 1) + j, b = a + radial + 1;
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pts), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Baluster (lathe) of height h, base on origin. */
export function baluster(h: number, r: number, segs = 6): BufferGeometry {
  const k = h;
  return lathe([
    [r * 1.1, 0], [r * 1.1, 0.08 * k], [r * 0.6, 0.12 * k], [r * 0.55, 0.2 * k], [r * 1.0, 0.38 * k], [r * 0.9, 0.5 * k],
    [r * 0.45, 0.68 * k], [r * 0.45, 0.8 * k], [r * 0.9, 0.86 * k], [r * 1.1, 0.92 * k], [r * 1.1, k], [0, k],
  ], segs);
}

/** Balustrade along X centred at origin: plinth, balusters, handrail (all one geometry). */
export function balustrade(length: number, h = 1.0, spacing = 0.28): BufferGeometry {
  const parts: BufferGeometry[] = [box(length, 0.14, 0.34)];
  const n = Math.max(2, Math.floor(length / spacing));
  const b = baluster(h - 0.28, 0.07);
  for (let i = 0; i < n; i++) parts.push(b.clone().translate(-length / 2 + (i + 0.5) * (length / n), 0.14, 0));
  parts.push(box(length, 0.14, 0.38).translate(0, h - 0.14, 0));
  const g = mergeAll(parts);
  b.dispose();
  return g;
}

/** Merges already-transformed geometries of mixed index/attribute layout into one (indexed). */
export function mergeAll(parts: BufferGeometry[]): BufferGeometry {
  parts.forEach(clean);
  // mergeGeometries wants all-indexed or none: give non-indexed parts a trivial index
  if (parts.some((p) => p.index)) {
    for (const p of parts) if (!p.index) p.setIndex(new BufferAttribute(Uint32Array.from({ length: p.attributes.position.count }, (_, i) => i), 1));
  }
  const g = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return g!;
}

/** Hipped roof over a w (x) × d (z) rectangle centred on the origin, eaves at y = 0, ridge at h
 *  (ridge along the longer side; all four slopes equal). */
export function hipRoof(w: number, d: number, h: number): BufferGeometry {
  const hw = w / 2, hd = d / 2;
  const alongX = w >= d;
  const inset = alongX ? hd : hw; // ridge ends pulled in by half the short side
  const r0 = alongX ? new Vector3(-hw + inset, h, 0) : new Vector3(0, h, -hd + inset);
  const r1 = alongX ? new Vector3(hw - inset, h, 0) : new Vector3(0, h, hd - inset);
  const c = [new Vector3(-hw, 0, -hd), new Vector3(hw, 0, -hd), new Vector3(hw, 0, hd), new Vector3(-hw, 0, hd)];
  const tris: Vector3[] = alongX
    ? [c[3], c[2], r1, c[3], r1, r0, c[1], c[0], r0, c[1], r0, r1, c[0], c[3], r0, c[2], c[1], r1]
    : [c[0], c[3], r1, c[0], r1, r0, c[2], c[1], r0, c[2], r0, r1, c[1], c[0], r0, c[3], c[2], r1];
  const pos = new Float32Array(tris.length * 3);
  tris.forEach((v, i) => v.toArray(pos, i * 3));
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}
