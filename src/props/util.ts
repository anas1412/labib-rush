// Shared helpers for the props module: seeded random, value noise, canvas textures, the
// "vertex PBR" material patch (albedo/roughness/metalness/emission per vertex, so multi-part
// props merge into one draw call), part merging and crease-aware normals.
import {
  BufferAttribute, BufferGeometry, CanvasTexture, Color, CustomBlending, Float32BufferAttribute, LinearMipmapLinearFilter,
  NoColorSpace, OneFactor, OneMinusSrcAlphaFactor, RepeatWrapping, SRGBColorSpace, Vector3, Vector4,
  type ColorRepresentation, type MeshStandardMaterial, type WebGLRenderer,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// ---------------------------------------------------------------------------------------------
// Random + noise

/** mulberry32: small, fast, deterministic. Returns a function giving floats in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash3(x: number, y: number, z: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth 3D value noise in [0, 1]. */
export function noise3(x: number, y: number, z: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (dx: number, dy: number, dz: number) => hash3(xi + dx, yi + dy, zi + dz);
  return l(
    l(l(c(0, 0, 0), c(1, 0, 0), u), l(c(0, 1, 0), c(1, 1, 0), u), v),
    l(l(c(0, 0, 1), c(1, 0, 1), u), l(c(0, 1, 1), c(1, 1, 1), u), v),
    w,
  );
}

/** Fractal noise, roughly in [0, 1]. */
export function fbm3(x: number, y: number, z: number, octaves = 4): number {
  let s = 0, a = 0.5, n = 0;
  for (let i = 0; i < octaves; i++) {
    s += a * noise3(x, y, z);
    n += a;
    x *= 2.03; y *= 2.03; z *= 2.03;
    a *= 0.5;
  }
  return s / n;
}

/**
 * Tileable 2D fractal value noise for texture painting: random lattices (cellsX×cellsY, doubling
 * per octave) sampled with smoothstep-bilinear lookups — ~20× cheaper per pixel than fbm3.
 * Returns a sampler (u, v) → [0, 1]; u/v wrap.
 */
export function field(cellsX: number, cellsY: number, octaves: number, seed: number): (u: number, v: number) => number {
  const r = rng(seed * 7919 + 17);
  const lat: Float32Array[] = [];
  for (let o = 0; o < octaves; o++) {
    const a = new Float32Array((cellsX << o) * (cellsY << o));
    for (let i = 0; i < a.length; i++) a[i] = r();
    lat.push(a);
  }
  return (u, v) => {
    let s = 0, amp = 0.5, n = 0;
    for (let o = 0; o < octaves; o++) {
      const nx = cellsX << o, ny = cellsY << o, a = lat[o];
      let x = u * nx, y = v * ny;
      x = ((x % nx) + nx) % nx;
      y = ((y % ny) + ny) % ny;
      const xi = Math.floor(x), yi = Math.floor(y);
      const fx = x - xi, fy = y - yi;
      const x1 = (xi + 1) % nx, y1 = (yi + 1) % ny;
      const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
      const r0 = yi * nx, r1 = y1 * nx;
      const t = a[r0 + xi] + (a[r0 + x1] - a[r0 + xi]) * sx;
      const b = a[r1 + xi] + (a[r1 + x1] - a[r1 + xi]) * sx;
      s += amp * (t + (b - t) * sy);
      n += amp;
      amp *= 0.5;
    }
    return s / n;
  };
}

/** GLSL twin of noise3/fbm3 for shader-side dirt and flutter. */
export const GLSL_NOISE = /* glsl */ `
float prHash(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float prNoise(vec3 p) {
  vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(prHash(i), prHash(i + vec3(1,0,0)), f.x), mix(prHash(i + vec3(0,1,0)), prHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(prHash(i + vec3(0,0,1)), prHash(i + vec3(1,0,1)), f.x), mix(prHash(i + vec3(0,1,1)), prHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float prFbm(vec3 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * prNoise(p); p *= 2.03; a *= 0.5; } return s / 0.9375; }
`;

// ---------------------------------------------------------------------------------------------
// Disposal

/** Collects GPU resources so the factory can free everything it created in one call. */
export class Trash {
  private items = new Set<{ dispose(): void }>();
  add<T extends { dispose(): void }>(x: T): T {
    this.items.add(x);
    return x;
  }
  dispose(): void {
    this.items.forEach((x) => x.dispose());
    this.items.clear();
  }
}

// ---------------------------------------------------------------------------------------------
// Canvas textures

export type Ctx2D = CanvasRenderingContext2D;

export function canvas(w: number, h: number): { c: HTMLCanvasElement; g: Ctx2D } {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return { c, g: c.getContext('2d', { willReadFrequently: false })! };
}

/** Wraps a canvas as a mipmapped texture. srgb = albedo/emission; false = data (bump, masks). */
export function canvasTex(c: HTMLCanvasElement, renderer: WebGLRenderer, srgb = true, repeat = false): CanvasTexture {
  const t = new CanvasTexture(c);
  t.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
  t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  t.minFilter = LinearMipmapLinearFilter;
  if (repeat) t.wrapS = t.wrapT = RepeatWrapping;
  t.needsUpdate = true;
  return t;
}

/** Texture resolution scale per quality preset. */
export const texScale = (q: string): number => (q === 'low' ? 0.5 : q === 'medium' ? 0.75 : 1);

/**
 * Fills a rect (canvas pixels, ignoring the context transform) through a per-pixel callback
 * (u, v in 0..1) → out [r, g, b, a] 0..255. `res` < 1 evaluates at lower resolution and
 * upscales with smoothing — right for soft noise, and much faster.
 */
export function pixels(g: Ctx2D, x0: number, y0: number, w: number, h: number, fn: (u: number, v: number, out: number[]) => void, res = 1): void {
  const sw = Math.max(1, Math.round(w * res)), sh = Math.max(1, Math.round(h * res));
  const img = g.createImageData(sw, sh); // no GPU readback
  const d = img.data;
  const px = [0, 0, 0, 255];
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      px[3] = 255;
      fn(x / sw, y / sh, px);
      const i = (y * sw + x) * 4;
      d[i] = px[0]; d[i + 1] = px[1]; d[i + 2] = px[2]; d[i + 3] = px[3];
    }
  }
  if (sw === w && sh === h) {
    g.putImageData(img, x0, y0);
    return;
  }
  const tmp = canvas(sw, sh);
  tmp.g.putImageData(img, 0, 0);
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(tmp.c, x0, y0, w, h);
  g.restore();
}

/** Every atlas reserves this top-left patch as pure white: solid (untextured) parts sample it. */
export const WHITE_UV = 4 / 1024;
/** uv attribute pointing every vertex at the white patch (canvas top-left → v near 1). */
function whiteUV(n: number): Float32BufferAttribute {
  const a = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { a[i * 2] = WHITE_UV; a[i * 2 + 1] = 1 - WHITE_UV; }
  return new Float32BufferAttribute(a, 2);
}
export function whitePatch(g: Ctx2D): void {
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 16, 16);
}

// ---------------------------------------------------------------------------------------------
// Vertex-PBR material patch

export interface Levels { value: Vector4 }
export const newLevels = (x = 1, y = 1, z = 1, w = 1): Levels => ({ value: new Vector4(x, y, z, w) });

/**
 * Makes a Standard/Physical material read per-vertex albedo (`color`), roughness (pbr.x),
 * metalness (pbr.y), emission strength (pbr.z) and emission channel (pbr.w: 0 = always on,
 * 1/2/3 = uLevels.x/y/z, e.g. headlights / tail+brake / roof sign). Emission colour comes from
 * the emissiveMap when set, otherwise from the albedo. Materials sharing `key` share a program.
 */
export function vertexPbr<T extends MeshStandardMaterial>(m: T, key: string, levels: Levels = newLevels()): T {
  m.vertexColors = true;
  m.roughness = 1;
  m.metalness = 1;
  if (!m.emissiveMap) m.emissive.set(0x000000);
  else m.emissive.set(0xffffff);
  m.onBeforeCompile = (s) => {
    s.uniforms.uLevels = levels;
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 pbr;\nvarying vec4 vPbr;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPbr = pbr;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec4 vPbr;\nuniform vec4 uLevels;')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor *= vPbr.x;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor *= vPbr.y;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        float prLvl = vPbr.w < 0.5 ? 1.0 : vPbr.w < 1.5 ? uLevels.x : vPbr.w < 2.5 ? uLevels.y : uLevels.z;
        #ifdef USE_EMISSIVEMAP
          totalEmissiveRadiance *= vPbr.z * prLvl;
        #else
          totalEmissiveRadiance = diffuseColor.rgb * vPbr.z * prLvl;
        #endif`,
      );
  };
  m.customProgramCacheKey = () => `vpbr-${key}`;
  return m;
}

/**
 * Transparent glass whose reflections are not dimmed by its opacity (premultiplied output:
 * diffuse × alpha + specular) — much closer to real glass than plain alpha blending, and it
 * needs no transmission pass. Use a dark `color` (glass has almost no diffuse) and a low opacity.
 * `edge` > 0 raises the opacity toward it at grazing angles (Fresnel), so a thin glass keeps a
 * readable silhouette.
 */
export function glassify<T extends MeshStandardMaterial>(m: T, key: string, edge = 0): T {
  m.transparent = true;
  m.depthWrite = false;
  m.blending = CustomBlending;
  m.blendSrc = OneFactor;
  m.blendDst = OneMinusSrcAlphaFactor;
  m.onBeforeCompile = (s) => {
    s.fragmentShader = s.fragmentShader.replace(
      '#include <opaque_fragment>',
      `float prA = diffuseColor.a;
      ${edge > 0 ? `prA = mix(prA, ${edge.toFixed(3)}, pow(1.0 - abs(dot(normal, normalize(vViewPosition))), 3.0));` : ''}
      gl_FragColor = vec4(totalDiffuse * prA + totalSpecular + totalEmissiveRadiance, prA);`,
    );
  };
  m.customProgramCacheKey = () => `glass-${key}`;
  return m;
}

// ---------------------------------------------------------------------------------------------
// Parts: geometries tagged with per-vertex material values, merged into one draw call.

export interface PartLook {
  color: ColorRepresentation;
  rough: number;
  metal?: number;
  emit?: number;
  channel?: number; // emission channel, see vertexPbr
}

const tmpC = new Color();

/** Tags every vertex of geo with a look; uv is forced to the white patch unless keepUV. */
export function paint(geo: BufferGeometry, look: PartLook, keepUV = false): BufferGeometry {
  const n = geo.getAttribute('position').count;
  tmpC.set(look.color);
  const col = new Float32Array(n * 3);
  const pbr = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    col[i * 3] = tmpC.r; col[i * 3 + 1] = tmpC.g; col[i * 3 + 2] = tmpC.b;
    pbr[i * 4] = look.rough; pbr[i * 4 + 1] = look.metal ?? 0; pbr[i * 4 + 2] = look.emit ?? 0; pbr[i * 4 + 3] = look.channel ?? 0;
  }
  geo.setAttribute('color', new BufferAttribute(col, 3));
  geo.setAttribute('pbr', new BufferAttribute(pbr, 4));
  if (!keepUV || !geo.getAttribute('uv')) geo.setAttribute('uv', whiteUV(n));
  return geo;
}

/** Per-vertex look from a callback (vertex index, position) — for gradients/speckles. */
export function paintFn(geo: BufferGeometry, fn: (i: number, p: Vector3, look: { c: Color; r: number; m: number; e: number; ch: number }) => void, keepUV = false): BufferGeometry {
  const pos = geo.getAttribute('position');
  const n = pos.count;
  const col = new Float32Array(n * 3);
  const pbr = new Float32Array(n * 4);
  const p = new Vector3();
  const look = { c: new Color(), r: 0.5, m: 0, e: 0, ch: 0 };
  for (let i = 0; i < n; i++) {
    p.fromBufferAttribute(pos, i);
    look.c.set(0xffffff); look.r = 0.5; look.m = 0; look.e = 0; look.ch = 0;
    fn(i, p, look);
    col[i * 3] = look.c.r; col[i * 3 + 1] = look.c.g; col[i * 3 + 2] = look.c.b;
    pbr[i * 4] = look.r; pbr[i * 4 + 1] = look.m; pbr[i * 4 + 2] = look.e; pbr[i * 4 + 3] = look.ch;
  }
  geo.setAttribute('color', new BufferAttribute(col, 3));
  geo.setAttribute('pbr', new BufferAttribute(pbr, 4));
  if (!keepUV || !geo.getAttribute('uv')) geo.setAttribute('uv', whiteUV(n));
  return geo;
}

/** Merges painted parts (drops attributes other than position/normal/uv/color/pbr). */
export function mergeParts(parts: BufferGeometry[]): BufferGeometry {
  const keep = ['position', 'normal', 'uv', 'color', 'pbr'];
  const anyNonIndexed = parts.some((g) => !g.index);
  const prepared = parts.map((g) => {
    let h = anyNonIndexed && g.index ? g.toNonIndexed() : g;
    if (h === g) h = g.clone();
    for (const name of Object.keys(h.attributes)) if (!keep.includes(name)) h.deleteAttribute(name);
    if (!h.getAttribute('normal')) h.computeVertexNormals();
    h.morphAttributes = {};
    h.clearGroups();
    return h;
  });
  const merged = mergeGeometries(prepared, false)!;
  prepared.forEach((g) => g.dispose());
  parts.forEach((g) => g.dispose());
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

/**
 * Crease-aware smooth normals for a NON-indexed geometry: vertices at the same position share
 * normals only with faces within `creaseDeg` (area weighted). Zero-area faces are removed first.
 * (three's toCreasedNormals quantises to 1 cm, too coarse for 6 cm cans.) Returns a new
 * geometry when it had to convert/compact, else the input with its normal attribute replaced.
 */
export function creasedNormals(geo: BufferGeometry, creaseDeg = 35, eps = 1e-5): BufferGeometry {
  let g = geo.index ? geo.toNonIndexed() : geo;
  const P = g.getAttribute('position').array as Float32Array;
  const nTri = P.length / 9;
  const faceN = new Float32Array(nTri * 3);
  const good = new Uint8Array(nTri);
  let kept = 0;
  for (let f = 0; f < nTri; f++) {
    const o = f * 9;
    const ux = P[o + 6] - P[o + 3], uy = P[o + 7] - P[o + 4], uz = P[o + 8] - P[o + 5];
    const vx = P[o] - P[o + 3], vy = P[o + 1] - P[o + 4], vz = P[o + 2] - P[o + 5];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (nx * nx + ny * ny + nz * nz > 1e-16) {
      faceN[kept * 3] = nx; faceN[kept * 3 + 1] = ny; faceN[kept * 3 + 2] = nz;
      good[f] = 1;
      kept++;
    }
  }
  if (kept < nTri) {
    const out = new BufferGeometry();
    for (const [name, attr] of Object.entries(g.attributes)) {
      const sz = attr.itemSize * 3, src = attr.array as Float32Array;
      const dst = new Float32Array(kept * sz);
      for (let f = 0, k = 0; f < nTri; f++) if (good[f]) { for (let c = 0; c < sz; c++) dst[k * sz + c] = src[f * sz + c]; k++; }
      out.setAttribute(name, new BufferAttribute(dst, attr.itemSize));
    }
    if (g !== geo) g.dispose();
    g = out;
  }
  const pos = g.getAttribute('position').array as Float32Array;
  const n = pos.length / 3;
  // group coincident vertices: sort by quantised position
  const inv = 1 / eps;
  const qx = new Int32Array(n), qy = new Int32Array(n), qz = new Int32Array(n);
  for (let i = 0; i < n; i++) { qx[i] = Math.round(pos[i * 3] * inv); qy[i] = Math.round(pos[i * 3 + 1] * inv); qz[i] = Math.round(pos[i * 3 + 2] * inv); }
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => qx[a] - qx[b] || qy[a] - qy[b] || qz[a] - qz[b]);
  const cosT = Math.cos((creaseDeg * Math.PI) / 180);
  const normals = new Float32Array(n * 3);
  const len = new Float32Array(kept);
  for (let f = 0; f < kept; f++) len[f] = Math.hypot(faceN[f * 3], faceN[f * 3 + 1], faceN[f * 3 + 2]);
  for (let s0 = 0; s0 < n;) {
    let s1 = s0 + 1;
    const a0 = order[s0];
    while (s1 < n && qx[order[s1]] === qx[a0] && qy[order[s1]] === qy[a0] && qz[order[s1]] === qz[a0]) s1++;
    for (let k = s0; k < s1; k++) {
      const i = order[k], fi = (i / 3) | 0;
      const ix = faceN[fi * 3] / len[fi], iy = faceN[fi * 3 + 1] / len[fi], iz = faceN[fi * 3 + 2] / len[fi];
      let ax = 0, ay = 0, az = 0;
      for (let m = s0; m < s1; m++) {
        const fj = (order[m] / 3) | 0;
        const jx = faceN[fj * 3], jy = faceN[fj * 3 + 1], jz = faceN[fj * 3 + 2];
        if ((jx * ix + jy * iy + jz * iz) / len[fj] >= cosT) { ax += jx; ay += jy; az += jz; }
      }
      const l = Math.hypot(ax, ay, az) || 1;
      normals[i * 3] = ax / l; normals[i * 3 + 1] = ay / l; normals[i * 3 + 2] = az / l;
    }
    s0 = s1;
  }
  g.setAttribute('normal', new BufferAttribute(normals, 3));
  return g;
}

/** creasedNormals + disposes the input when a new geometry had to be made. */
export function withNormals(g: BufferGeometry, creaseDeg = 50): BufferGeometry {
  const n = creasedNormals(g, creaseDeg);
  if (n !== g) g.dispose();
  return n;
}

// ---------------------------------------------------------------------------------------------
// Lathes: profiles of (radius, y) revolved around +Y.

export type Profile = [r: number, y: number][];

/** Inserts points along long profile segments so deformations have vertices to bend. */
export function refine(p: Profile, maxStep: number): Profile {
  const out: Profile = [p[0]];
  for (let i = 1; i < p.length; i++) {
    const [r0, y0] = p[i - 1], [r1, y1] = p[i];
    const n = Math.max(1, Math.ceil(Math.hypot(r1 - r0, y1 - y0) / maxStep));
    for (let k = 1; k <= n; k++) out.push([lerp(r0, r1, k / n), lerp(y0, y1, k / n)]);
  }
  return out;
}

/**
 * Non-indexed lathe (position + uv, no normals: deform first, then withNormals). Faces point
 * outward when the profile runs bottom → top on the outside. uv(s, u, i): s = arc-length
 * fraction along the profile, u = angle fraction (0..1, seam duplicated), i = profile index.
 */
export function lathe(p: Profile, segs: number, uv?: (s: number, u: number, i: number) => [number, number]): BufferGeometry {
  const len = [0];
  for (let i = 1; i < p.length; i++) len.push(len[i - 1] + Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]));
  const total = len[len.length - 1] || 1;
  const pos: number[] = [], uvs: number[] = [];
  const P = (k: number, j: number) => {
    const a = (j / segs) * Math.PI * 2;
    pos.push(p[k][0] * Math.sin(a), p[k][1], p[k][0] * Math.cos(a));
    if (uv) uvs.push(...uv(len[k] / total, j / segs, k));
    else uvs.push(0, 0);
  };
  for (let i = 0; i < p.length - 1; i++) {
    for (let j = 0; j < segs; j++) {
      P(i, j); P(i, j + 1); P(i + 1, j + 1);
      P(i, j); P(i + 1, j + 1); P(i + 1, j);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  return g;
}

/** Moves every vertex through fn (in place). */
export function deform(g: BufferGeometry, fn: (p: Vector3) => void): BufferGeometry {
  const pos = g.getAttribute('position');
  const p = new Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    fn(p);
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  pos.needsUpdate = true;
  return g;
}

/** Collects triangles with a material tag each; splits into per-tag non-indexed geometries. */
export class TriSoup {
  readonly pos: number[] = [];
  readonly uv: number[] = [];
  readonly tag: number[] = [];
  tri(a: Vector3, b: Vector3, c: Vector3, tag: number, uva?: number[], uvb?: number[], uvc?: number[]): void {
    this.pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    this.uv.push(...(uva ?? [0, 0]), ...(uvb ?? [0, 0]), ...(uvc ?? [0, 0]));
    this.tag.push(tag);
  }
  quad(a: Vector3, b: Vector3, c: Vector3, d: Vector3, tag: number, uv?: number[][]): void {
    this.tri(a, b, c, tag, uv?.[0], uv?.[1], uv?.[2]);
    this.tri(a, c, d, tag, uv?.[0], uv?.[2], uv?.[3]);
  }
  /** Normals are computed across all tags (so seams between tags match), then split. */
  build(creaseDeg: number, eps = 1e-5): Map<number, BufferGeometry> {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new Float32BufferAttribute(this.uv, 2));
    // stash the tag per vertex so it survives degenerate removal
    const tagV = new Float32Array(this.tag.length * 3);
    this.tag.forEach((t, i) => tagV.fill(t, i * 3, i * 3 + 3));
    g.setAttribute('tagv', new BufferAttribute(tagV, 1));
    const withN = creasedNormals(g, creaseDeg, eps);
    const tv = withN.getAttribute('tagv');
    const out = new Map<number, BufferGeometry>();
    const tags = new Set<number>();
    for (let i = 0; i < tv.count; i += 3) tags.add(tv.getX(i));
    for (const t of tags) {
      const idx: number[] = [];
      for (let i = 0; i < tv.count; i += 3) if (tv.getX(i) === t) idx.push(i / 3);
      const sub = new BufferGeometry();
      for (const name of ['position', 'normal', 'uv']) {
        const attr = withN.getAttribute(name);
        const s = attr.itemSize;
        const arr = new Float32Array(idx.length * 3 * s);
        idx.forEach((f, i) => arr.set((attr.array as Float32Array).subarray(f * 3 * s, f * 3 * s + 3 * s), i * 3 * s));
        sub.setAttribute(name, new BufferAttribute(arr, s));
      }
      out.set(t, sub);
    }
    withN.dispose();
    g.dispose();
    return out;
  }
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
export const smooth = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
