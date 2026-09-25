// Shared helpers for the street module: seeded RNG, resource ownership, geometry baking,
// instancing, space reservation (so props never overlap bins, lanes, islands…), shader patches.
import * as THREE from 'three';
import { ShaderChunk } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { BuildContext } from '../../core/types';
import { G } from '../../core/physics';

export type Rng = () => number;

/** mulberry32: small deterministic PRNG so the street looks the same every run. */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const range = (r: Rng, a: number, b: number) => a + (b - a) * r();

/** Everything the street allocates, freed in one go by dispose(). */
export class Owned {
  private items = new Set<{ dispose(): void }>();
  private colliders: RAPIER.Collider[] = [];
  constructor(private ctx: BuildContext) {}
  add<T extends { dispose(): void }>(x: T): T {
    this.items.add(x);
    return x;
  }
  collider(c: RAPIER.Collider): void {
    this.colliders.push(c);
  }
  dispose(): void {
    this.items.forEach((x) => x.dispose());
    this.items.clear();
    for (const c of this.colliders) this.ctx.physics.removeCollider(c);
    this.colliders = [];
  }
}

// ---------------------------------------------------------------------------------------------
// Colliders (static). Heights are absolute world y.
const v1 = new THREE.Vector3();
const v2 = new THREE.Vector3();
export function boxCollider(o: Owned, ctx: BuildContext, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, member: number = G.STATIC): void {
  v1.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  v2.set(Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, Math.abs(z1 - z0) / 2);
  o.collider(ctx.physics.addBox(v1, v2, 0, member));
}
/** Box given by centre, half extents and Y rotation. */
export function obbCollider(o: Owned, ctx: BuildContext, cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, rotY: number, member: number): void {
  o.collider(ctx.physics.addBox(v1.set(cx, cy, cz), v2.set(hx, hy, hz), rotY, member));
}
export function cylCollider(o: Owned, ctx: BuildContext, x: number, z: number, y0: number, y1: number, r: number, member: number = G.STATIC): void {
  o.collider(ctx.physics.addCylinder(v1.set(x, (y0 + y1) / 2, z), r, (y1 - y0) / 2, member));
}

// ---------------------------------------------------------------------------------------------
// Geometry baking: transform primitives and merge them into one indexed geometry.
const m4 = new THREE.Matrix4();
const q4 = new THREE.Quaternion();
const e4 = new THREE.Euler();
const s4 = new THREE.Vector3();
const p4 = new THREE.Vector3();

export interface Xf {
  p?: [number, number, number];
  r?: [number, number, number]; // euler XYZ radians
  s?: [number, number, number] | number;
}
export function matrixOf(t: Xf): THREE.Matrix4 {
  const s = t.s === undefined ? 1 : t.s;
  if (typeof s === 'number') s4.set(s, s, s);
  else s4.set(s[0], s[1], s[2]);
  q4.setFromEuler(e4.set(...(t.r ?? [0, 0, 0])));
  return m4.compose(p4.set(...(t.p ?? [0, 0, 0])), q4, s4);
}
/** Applies a transform in place and returns the geometry (for fluent part lists). */
export function xf(g: THREE.BufferGeometry, t: Xf): THREE.BufferGeometry {
  return g.applyMatrix4(matrixOf(t));
}

/** Merges parts (position/normal/uv, plus color if every part has it). Frees the parts. */
export function bake(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const keepColor = parts.every((g) => g.getAttribute('color'));
  const clean = parts.map((g) => {
    for (const name of Object.keys(g.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv' && !(keepColor && name === 'color')) g.deleteAttribute(name);
    }
    if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
    if (!g.getIndex()) g.setIndex([...Array(g.getAttribute('position').count).keys()]);
    g.morphAttributes = {};
    return g;
  });
  const out = mergeGeometries(clean, false);
  if (!out) throw new Error('street: mergeGeometries failed (attribute mismatch)');
  parts.forEach((g) => g.dispose());
  out.computeBoundingSphere();
  out.computeBoundingBox();
  return out;
}

/** Sets every vertex colour of a geometry (for vertex-coloured merged props). */
export function paint(g: THREE.BufferGeometry, color: THREE.ColorRepresentation): THREE.BufferGeometry {
  const c = new THREE.Color(color);
  const n = g.getAttribute('position').count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) a.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.Float32BufferAttribute(a, 3));
  return g;
}

/** Scales UVs (so primitives tile a texture by real size). */
export function uvScale(g: THREE.BufferGeometry, su: number, sv: number): THREE.BufferGeometry {
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  return g;
}

/** Placement of one instance: position, yaw, uniform or xyz scale. */
export interface Place {
  x: number;
  y: number;
  z: number;
  ry?: number;
  s?: number | [number, number, number];
}

/** InstancedMesh from placements (frustum culling uses the bounds of all instances). */
export function instanced(
  o: Owned, geo: THREE.BufferGeometry, mat: THREE.Material, places: Place[],
  opts: { cast?: boolean; receive?: boolean; name?: string; colors?: THREE.Color[] } = {},
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, places.length));
  mesh.count = places.length;
  places.forEach((p, i) => mesh.setMatrixAt(i, matrixOf({ p: [p.x, p.y, p.z], r: [0, p.ry ?? 0, 0], s: p.s ?? 1 })));
  if (opts.colors) opts.colors.forEach((c, i) => mesh.setColorAt(i, c));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = !!opts.cast;
  mesh.receiveShadow = opts.receive ?? true;
  mesh.name = opts.name ?? '';
  mesh.computeBoundingSphere();
  mesh.computeBoundingBox();
  o.add(geo);
  o.add(mesh); // frees the instance buffers
  return mesh;
}

// ---------------------------------------------------------------------------------------------
/** Static props are merged per material per CHUNK metres along X: one draw call per material and
 *  piece of avenue, and the main and shadow passes cull every piece on its own. */
export const CHUNK = 120;
const CHUNK_X0 = -320;
const chunkOf = (x: number) => Math.max(0, Math.floor((x - CHUNK_X0) / CHUNK));

export class StaticBatch {
  private groups = new Map<THREE.Material, { name: string; cast: boolean; chunks: THREE.BufferGeometry[][] }>();
  private group(mat: THREE.Material, name: string, cast: boolean) {
    let g = this.groups.get(mat);
    if (!g) this.groups.set(mat, (g = { name, cast, chunks: [] }));
    g.cast ||= cast;
    return g;
  }
  /** World-space geometry (taken over and freed by build()), filed by its centre x. */
  add(geo: THREE.BufferGeometry, mat: THREE.Material, name: string, cast: boolean): void {
    geo.computeBoundingBox();
    const c = chunkOf((geo.boundingBox!.min.x + geo.boundingBox!.max.x) / 2);
    ((this.group(mat, name, cast).chunks[c] ??= [])).push(geo);
  }
  /** Copies of `proto` (still owned by the caller) at each placement. */
  place(proto: THREE.BufferGeometry, mat: THREE.Material, places: Place[], name: string, cast: boolean): void {
    for (const p of places) this.add(proto.clone().applyMatrix4(matrixOf({ p: [p.x, p.y, p.z], r: [0, p.ry ?? 0, 0], s: p.s ?? 1 })), mat, name, cast);
  }
  build(o: Owned): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const [mat, g] of this.groups) {
      g.chunks.forEach((parts, i) => {
        if (!parts?.length) return;
        const m = new THREE.Mesh(o.add(bake(parts)), mat);
        m.name = `${g.name}-c${i}`;
        m.castShadow = g.cast;
        m.receiveShadow = true;
        out.push(m);
      });
    }
    this.groups.clear();
    return out;
  }
}

// ---------------------------------------------------------------------------------------------
/** Keeps props from overlapping each other and the gameplay-reserved spots. */
export class Space {
  private circles: { x: number; z: number; r: number }[] = [];
  private rects: { x0: number; x1: number; z0: number; z1: number }[] = [];
  free(x: number, z: number, r: number): boolean {
    for (const c of this.circles) if ((c.x - x) ** 2 + (c.z - z) ** 2 < (c.r + r) ** 2) return false;
    for (const b of this.rects) if (x + r > b.x0 && x - r < b.x1 && z + r > b.z0 && z - r < b.z1) return false;
    return true;
  }
  circle(x: number, z: number, r: number): void {
    this.circles.push({ x, z, r });
  }
  rect(x0: number, x1: number, z0: number, z1: number): void {
    this.rects.push({ x0: Math.min(x0, x1), x1: Math.max(x0, x1), z0: Math.min(z0, z1), z1: Math.max(z0, z1) });
  }
  /** free() then reserve; returns whether the spot was taken. */
  take(x: number, z: number, r: number): boolean {
    if (!this.free(x, z, r)) return false;
    this.circle(x, z, r);
    return true;
  }
}

// ---------------------------------------------------------------------------------------------
// Shader helpers.

/** GLSL value noise (2 octaves) used for macro variation of ground materials. */
export const NOISE_GLSL = /* glsl */ `
float stHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float stNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(stHash(i), stHash(i + vec2(1, 0)), u.x), mix(stHash(i + vec2(0, 1)), stHash(i + vec2(1, 1)), u.x), u.y);
}
float stFbm(vec2 p) { return stNoise(p) * 0.6 + stNoise(p * 2.7 + 13.1) * 0.4; }
`;

/**
 * Breaks up texture tiling on big ground surfaces: world-space low-frequency albedo and roughness
 * variation (patches of wear/dirt), computed in the shader so it costs no texture.
 */
export function patchMacroVariation(mat: THREE.MeshStandardMaterial, strength: number, scale: number, key: string, extra = ''): void {
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vStWorld;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
      #ifdef USE_INSTANCING
        vStWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
      #else
        vStWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
      #endif`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vStWorld;\n${NOISE_GLSL}`)
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        float stM = stFbm(vStWorld.xz * ${(1 / scale).toFixed(5)});
        float stD = stNoise(vStWorld.xz * ${(4 / scale).toFixed(5)});
        diffuseColor.rgb *= 1.0 + ${strength.toFixed(3)} * ((stM - 0.5) * 1.6 + (stD - 0.5) * 0.5);
        ${extra}`,
      )
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\nroughnessFactor = clamp(roughnessFactor * (0.9 + 0.2 * stM), 0.04, 1.0);`);
    // ARM texture: reuse the roughness fetch for AO (one anisotropic sample less per pixel)
    if (mat.aoMap && mat.aoMap === mat.roughnessMap) shader.fragmentShader = shader.fragmentShader.replace('#include <aomap_fragment>', ShaderChunk.aomap_fragment.replace('texture2D( aoMap, vAoMapUv ).r', 'texelRoughness.r'));
  };
  mat.customProgramCacheKey = () => `st-macro-${key}`;
}

// ---------------------------------------------------------------------------------------------
// Primitive helpers with metric UVs (1 UV unit = `tile` metres) so textures keep real scale.

/** Box (centred) whose UVs are in metres / tile on every face; `grainAlongX` rotates UVs so a
 *  wood grain running along v follows the box's X axis on the top/front faces. */
export function metricBox(w: number, h: number, d: number, tile: number, grainAlongX = false): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  // face order: +x, -x, +y, -y, +z, -z (4 vertices each); u/v extents of each face
  const ext: [number, number][] = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      let u = (uv.getX(i) * ext[f][0]) / tile, v = (uv.getY(i) * ext[f][1]) / tile;
      if (grainAlongX && f >= 2) [u, v] = [v, u];
      uv.setXY(i, u, v);
    }
  }
  return g;
}

/** Lathe from [radius, height] pairs; UV v in metres / tile. */
export function lathe(profile: [number, number][], segments: number, tile = 1): THREE.BufferGeometry {
  const g = new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), segments);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2, p.getY(i) / tile);
  return g;
}

/** Tube of constant radius through points (Catmull-Rom). */
export function tube(points: [number, number, number][], radius: number, segments = 12, radial = 6): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)));
  return new THREE.TubeGeometry(curve, segments, radius, radial, false);
}
