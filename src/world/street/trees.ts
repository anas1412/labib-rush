// The signature ficus trees of the avenue: two rows of dense, clipped, rounded Ficus microcarpa
// canopies. One shared tree (trunk, opaque leafy core, shell of alpha-tested leaf cards) drawn with
// InstancedMesh. Canopy = smooth union of ellipsoid lobes with a clipped flat underside (an SDF);
// the core is an icosphere shrink-wrapped onto it, the cards are scattered over it. Normals come
// from the shape (soft, cloud-like shading), vertex colours carry depth AO, and the shader adds a
// per-tree bulge pattern (no two canopies alike), wind sway, leaf flutter and sun translucency.
// Neighbouring canopies overlap into a green tunnel. Trees within LOD.near of the camera use the
// full meshes; the rest a lighter trunk/core and a random part of the cards (update()).
import * as THREE from 'three';
import type { BuildContext } from '../../core/types';
import { G } from '../../core/physics';
import { CURB, TREE_ROWS_Z, TREE_X, EAST_BACKDROP } from '../../core/layout';
import { Owned, Space, boxCollider, cylCollider, instanced, makeRng, matrixOf, range, type Place, type Rng } from './common';
import { foliageTextures } from './canvas';
import type { StreetMaterials } from './materials';
import { QUAY_X } from './ground';

const CANOPY_C = new THREE.Vector3(0, 5.4, 0); // canopy centre above the tree base
const CUT_Y = 3.0; // clipped underside height (local)
const CORE_INSET = 0.22; // opaque core sits this far inside the canopy surface

interface Lobe { c: THREE.Vector3; r: THREE.Vector3 }

function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/** Canopy signed distance (approximate), local tree space. */
function makeSdf(lobes: Lobe[]): (p: THREE.Vector3) => number {
  const t = new THREE.Vector3();
  return (p) => {
    let d = Infinity;
    for (const l of lobes) {
      t.copy(p).sub(l.c).divide(l.r);
      const e = (t.length() - 1) * Math.min(l.r.x, l.r.y, l.r.z);
      d = d === Infinity ? e : smin(d, e, 0.9);
    }
    // clipped flat underside, rounded into the sides
    const cut = CUT_Y - p.y;
    return -smin(-d, -cut, 0.6);
  };
}

function canopyLobes(r: Rng): Lobe[] {
  const L = (x: number, y: number, z: number, rx: number, ry: number, rz: number): Lobe => ({
    c: new THREE.Vector3(x, y, z).add(CANOPY_C), r: new THREE.Vector3(rx, ry, rz),
  });
  // elongated along the row (X) so neighbouring canopies merge into one clipped green wall
  const lobes = [L(0, 0, 0, 5.0, 2.0, 3.7), L(0.2, 0.85, 0.1, 3.9, 1.35, 2.9)];
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + range(r, -0.3, 0.3);
    lobes.push(L(Math.cos(a) * 3.2, range(r, 0, 0.8), Math.sin(a) * 2.2, range(r, 1.8, 2.3), range(r, 1.3, 1.55), range(r, 1.6, 2.0)));
  }
  return lobes;
}

/** Surface point along direction `d` from the canopy centre (canopy is star-shaped). */
function surfaceAlong(sdf: (p: THREE.Vector3) => number, d: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  let lo = 0, hi = 7;
  for (let i = 0; i < 28; i++) {
    const m = (lo + hi) / 2;
    if (sdf(out.copy(CANOPY_C).addScaledVector(d, m)) < 0) lo = m;
    else hi = m;
  }
  return out.copy(CANOPY_C).addScaledVector(d, lo);
}

function gradient(sdf: (p: THREE.Vector3) => number, p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  const e = 0.05, t = new THREE.Vector3();
  const f = (dx: number, dy: number, dz: number) => sdf(t.set(p.x + dx, p.y + dy, p.z + dz));
  return out.set(f(e, 0, 0) - f(-e, 0, 0), f(0, e, 0) - f(0, -e, 0), f(0, 0, e) - f(0, 0, -e)).normalize();
}

/** Smooth 3D value noise in [0, 1] (build time only): leaf clumps of the clipped canopy. */
function clumpNoise(p: THREE.Vector3): number {
  const h = (x: number, y: number, z: number) => {
    const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const x = p.x * 1.3, y = p.y * 1.3, z = p.z * 1.3;
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const f = (t: number) => t * t * (3 - 2 * t);
  const fx = f(x - ix), fy = f(y - iy), fz = f(z - iz);
  const L = THREE.MathUtils.lerp;
  const v = (dx: number, dy: number, dz: number) => h(ix + dx, iy + dy, iz + dz);
  return L(L(L(v(0, 0, 0), v(1, 0, 0), fx), L(v(0, 1, 0), v(1, 1, 0), fx), fy), L(L(v(0, 0, 1), v(1, 0, 1), fx), L(v(0, 1, 1), v(1, 1, 1), fx), fy), fz);
}

/** Canopy AO (depth, height, underside, clumps) + slight hue variety, as a vertex colour (max
 *  channel 1). */
function canopyColour(r: Rng, p: THREE.Vector3, ny: number, depthAo: number, out: THREE.Color): THREE.Color {
  const hgt = THREE.MathUtils.smoothstep(p.y, CUT_Y, CANOPY_C.y + 2.4);
  let ao = depthAo * (0.6 + 0.4 * hgt) * (0.6 + 0.62 * clumpNoise(p));
  if (ny < -0.4) ao *= 0.78;
  out.setHSL(range(r, 0.22, 0.28), range(r, 0.2, 0.45), 0.5);
  return out.multiplyScalar(ao / Math.max(out.r, out.g, out.b));
}

/** Opaque canopy core: subdivided icosahedron shrink-wrapped onto the canopy shape. Per-face
 *  planar UVs into the seamless dense-leaf tile (the tile hides the seams). */
function coreGeometry(sdf: (p: THREE.Vector3) => number, detail: number, tile: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, detail); // non-indexed: 3 vertices per face
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const n = pos.count;
  const nor = new Float32Array(n * 3), uv = new Float32Array(n * 2), col = new Float32Array(n * 3);
  const d = new THREE.Vector3(), s = new THREE.Vector3(), gr = new THREE.Vector3(), c = new THREE.Color();
  const r = makeRng(55);
  for (let i = 0; i < n; i++) {
    d.fromBufferAttribute(pos, i).normalize();
    surfaceAlong(sdf, d, s);
    gradient(sdf, s, gr);
    s.addScaledVector(gr, -CORE_INSET);
    pos.setXYZ(i, s.x, s.y, s.z);
    nor.set([gr.x, gr.y, gr.z], i * 3);
    canopyColour(r, s, gr.y, 0.72, c);
    col.set([c.r, c.g, c.b], i * 3);
  }
  const a = new THREE.Vector3(), b = new THREE.Vector3(), e = new THREE.Vector3();
  for (let f = 0; f < n; f += 3) {
    a.fromBufferAttribute(pos, f);
    b.fromBufferAttribute(pos, f + 1).sub(a);
    e.fromBufferAttribute(pos, f + 2).sub(a);
    const fn = b.cross(e);
    const ax = Math.abs(fn.x), ay = Math.abs(fn.y), az = Math.abs(fn.z);
    for (let k = 0; k < 3; k++) {
      const vx = pos.getX(f + k), vy = pos.getY(f + k), vz = pos.getZ(f + k);
      const [u, v] = ax >= ay && ax >= az ? [vz, vy] : ay >= az ? [vx, vz] : [vx, vy];
      uv.set([u / tile, v / tile], (f + k) * 2);
    }
  }
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}

/** Leaf cards scattered over the core, breaking up its silhouette: small sprig clusters lying
 *  within ~25° of the canopy surface, some lifted off it so the outline reads leafy. */
function cardsGeometry(sdf: (p: THREE.Vector3) => number, r: Rng, count: number): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], col: number[] = [], idx: number[] = [], cardN: number[] = [], cardC: number[] = [];
  const d = new THREE.Vector3(), s = new THREE.Vector3(), n = new THREE.Vector3(), cn = new THREE.Vector3();
  const tu = new THREE.Vector3(), tv = new THREE.Vector3(), corner = new THREE.Vector3(), cnrm = new THREE.Vector3(), sp = new THREE.Vector3();
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    do d.set(range(r, -1, 1), range(r, -1, 1), range(r, -1, 1)); while (d.lengthSq() > 1 || d.lengthSq() < 0.01);
    d.normalize();
    surfaceAlong(sdf, d, s);
    gradient(sdf, s, n);
    // 55 %: surface cover lying within ~25° of the tangent plane; 45 %: smaller sprigs at any angle,
    // centred on the leafy surface so their outer half breaks the outline
    // (the underside and its rounded rim, seen from the walk below, only get small flat cards:
    // bigger ones stand off the curved rim and read as paper sheets at grazing angles)
    const under = n.y < -0.25;
    const sprig = !under && r() < 0.45;
    s.addScaledVector(n, sprig ? range(r, -0.05, 0.12) : under ? range(r, -0.16, -0.02) : range(r, -0.14, 0.06));
    const size = sprig ? range(r, 0.4, 0.62) : under ? range(r, 0.35, 0.5) : range(r, 0.55, 0.85);
    tu.set(range(r, -1, 1), range(r, -1, 1), range(r, -1, 1)).cross(n).normalize();
    cn.copy(n).addScaledVector(tu, Math.tan(sprig ? range(r, 0.2, 1.35) : range(r, 0, under ? 0.2 : 0.45))).normalize();
    tu.set(range(r, -1, 1), range(r, -1, 1), range(r, -1, 1)).cross(cn).normalize();
    tv.crossVectors(cn, tu).normalize();
    const cell = Math.floor(r() * 4);
    const u0 = (cell % 2) * 0.5, v0 = cell >= 2 ? 0 : 0.5;
    canopyColour(r, s, n.y, 0.8 + 0.2 * r(), c);
    const base = pos.length / 3;
    for (const [a, b, cu, cv] of [[-1, -1, 0, 0], [1, -1, 1, 0], [1, 1, 1, 1], [-1, 1, 0, 1]] as const) {
      corner.copy(s).addScaledVector(tu, (a * size) / 2).addScaledVector(tv, (b * size) / 2);
      pos.push(corner.x, corner.y, corner.z);
      // shape normal at the corner, blended a little with the card's own tilt
      surfaceAlong(sdf, cnrm.copy(corner).sub(CANOPY_C).normalize(), sp);
      gradient(sdf, sp, cnrm).lerp(cn, 0.15).normalize();
      nor.push(cnrm.x, cnrm.y, cnrm.z);
      uv.push(u0 + cu * 0.5, v0 + cv * 0.5);
      col.push(c.r, c.g, c.b);
      cardN.push(n.x, n.y, n.z);
      cardC.push(s.x, s.y, s.z);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aCardN', new THREE.Float32BufferAttribute(cardN, 3)); // canopy normal at the card centre
  g.setAttribute('aCardC', new THREE.Float32BufferAttribute(cardC, 3)); // card centre
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** Tube along a curve with a radius function; UVs in metres / uvLen for tiling bark. */
function taperTube(curve: THREE.Curve<THREE.Vector3>, radius: (t: number) => number, seg: number, radial: number, uvLen: number, wobble = 0, seed = 1): THREE.BufferGeometry {
  const frames = curve.computeFrenetFrames(seg, false);
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
  const len = curve.getLength();
  const r = makeRng(seed);
  const wob = Array.from({ length: radial }, () => 1 + (r() - 0.5) * wobble);
  const P = new THREE.Vector3(), N = new THREE.Vector3();
  for (let i = 0; i <= seg; i++) {
    const t = i / seg;
    curve.getPointAt(t, P);
    const rr = radius(t);
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      N.copy(frames.normals[i]).multiplyScalar(Math.cos(a)).addScaledVector(frames.binormals[i], Math.sin(a)).normalize();
      const w = wob[j % radial];
      pos.push(P.x + N.x * rr * w, P.y + N.y * rr * w, P.z + N.z * rr * w);
      nor.push(N.x, N.y, N.z);
      uv.push(((j / radial) * Math.PI * 2 * Math.max(rr, 0.12)) / uvLen, (t * len) / uvLen);
    }
  }
  for (let i = 0; i < seg; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * (radial + 1) + j, b = a + radial + 1;
      idx.push(a, a + 1, b, b, a + 1, b + 1); // counter-clockwise seen from outside
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** `detail` scales the tube resolution only (same random draws), so the far trunk matches. */
function trunkGeometry(r: Rng, uvLen: number, lod: number, detail = 1): THREE.BufferGeometry {
  const k = (n: number) => Math.max(3, Math.round(n * detail));
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const parts: THREE.BufferGeometry[] = [];
  const top = V(0.12, 2.35, 0.04);
  // main trunk with a flared base
  parts.push(taperTube(new THREE.CatmullRomCurve3([V(0, -0.05, 0), V(0.03, 0.9, 0.02), V(0.08, 1.7, 0.0), top]),
    (t) => 0.24 + 0.2 * Math.exp(-t * 9) - 0.03 * t, k(8), k(11), uvLen, 0.12, 3));
  // buttress roots into the grate soil
  for (let j = 0; j < 4; j++) {
    const a = (j / 4) * Math.PI * 2 + range(r, -0.3, 0.3);
    const L = range(r, 0.38, 0.5);
    parts.push(taperTube(new THREE.CatmullRomCurve3([V(0, 0.42, 0), V(Math.cos(a) * 0.26, 0.1, Math.sin(a) * 0.26), V(Math.cos(a) * L, -0.05, Math.sin(a) * L)]),
      (t) => 0.12 - 0.08 * t, k(3), k(5), uvLen, 0, 10 + j));
  }
  // limbs spreading into the canopy + secondary branches (visible from under the canopy)
  const limbs = 4;
  for (let j = 0; j < limbs; j++) {
    const a = (j / limbs) * Math.PI * 2 + range(r, -0.4, 0.4);
    const out = range(r, 1.3, 2.3), up = range(r, 4.4, 5.6);
    const mid = V(Math.cos(a) * out * 0.45 + top.x, range(r, 3.2, 3.7), Math.sin(a) * out * 0.35 + top.z);
    const end = V(Math.cos(a) * out, up, Math.sin(a) * out * 0.8);
    const curve = new THREE.CatmullRomCurve3([top.clone().add(V(0, -0.25, 0)), mid, end]);
    parts.push(taperTube(curve, (t) => 0.18 - 0.11 * t, k(5), k(6), uvLen, 0.08, 20 + j));
    for (let b = 0; b < (lod > 0.7 ? 2 : 1); b++) {
      const o = curve.getPointAt(range(r, 0.45, 0.7));
      const ba = a + range(r, -1.1, 1.1);
      const e2 = V(o.x + Math.cos(ba) * range(r, 0.8, 1.4), o.y + range(r, 0.6, 1.3), o.z + Math.sin(ba) * range(r, 0.6, 1.1));
      parts.push(taperTube(new THREE.CatmullRomCurve3([o, o.clone().lerp(e2, 0.5).add(V(0, 0.15, 0)), e2]), (t) => 0.065 - 0.04 * t, k(3), 3, uvLen, 0, 40 + j * 3 + b));
    }
  }
  return parts.length === 1 ? parts[0] : mergeParts(parts);
}

function mergeParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let count = 0, icount = 0;
  for (const p of parts) { count += p.getAttribute('position').count; icount += p.getIndex()!.count; }
  const pos = new Float32Array(count * 3), nor = new Float32Array(count * 3), uv = new Float32Array(count * 2);
  const idx = new Uint32Array(icount);
  let vo = 0, io = 0;
  for (const p of parts) {
    pos.set(p.getAttribute('position').array as Float32Array, vo * 3);
    nor.set(p.getAttribute('normal').array as Float32Array, vo * 3);
    uv.set(p.getAttribute('uv').array as Float32Array, vo * 2);
    const pi = p.getIndex()!.array;
    for (let i = 0; i < pi.length; i++) idx[io + i] = pi[i] + vo;
    vo += p.getAttribute('position').count;
    io += pi.length;
    p.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}

/** Per-tree canopy bulges + wind sway + leaf flutter, shared by the leaf materials and their
 *  shadow depth materials (so shadows match the lit shape). */
function canopyVertex(shader: THREE.WebGLProgramParametersWithUniforms, ctx: BuildContext, cards = false): void {
  shader.uniforms.uTime = ctx.uniforms.uTime;
  shader.uniforms.uWind = ctx.uniforms.uWind;
  if (cards) {
    // Cards on the far side of the canopy (as seen from this camera, the sun's in the shadow
    // pass) are hidden by the opaque core: drop them before rasterisation, per card from its
    // centre normal. (Drawing cards before the core measured slower: alpha-tested depth writes
    // spoil the hierarchical-Z rejection of the core behind them.)
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', /* glsl */ `#include <project_vertex>
    {
      // decided from the card centre so all four corners agree (a partly collapsed card would
      // be clipped into a long sliver)
      #ifdef USE_INSTANCING
        vec3 stCn = (instanceMatrix * vec4(aCardN, 0.0)).xyz;
        vec4 stCc = modelViewMatrix * instanceMatrix * vec4(aCardC, 1.0);
      #else
        vec3 stCn = aCardN;
        vec4 stCc = modelViewMatrix * vec4(aCardC, 1.0);
      #endif
      stCn = normalize(mat3(modelViewMatrix) * stCn);
      vec3 stToEye = isOrthographic ? vec3(0.0, 0.0, 1.0) : normalize(-stCc.xyz);
      if (dot(stCn, stToEye) < -0.3) gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
    }`).replace('#include <common>', '#include <common>\nattribute vec3 aCardN;\nattribute vec3 aCardC;');
  }
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform vec3 uWind;')
    .replace('#include <begin_vertex>', /* glsl */ `#include <begin_vertex>
    {
      #ifdef USE_INSTANCING
        vec3 stIp = instanceMatrix[3].xyz;
        vec3 stW = (vec4(uWind.x, 0.0, uWind.z, 0.0) * instanceMatrix).xyz; // world -> local
      #else
        vec3 stIp = vec3(0.0);
        vec3 stW = vec3(uWind.x, 0.0, uWind.z);
      #endif
      float stPh = dot(stIp.xz, vec2(0.37, 0.23));
      // lumpy regrowth between clippings: a bulge pattern seeded by the tree position, pushed along
      // the canopy normal; the clipped flat underside stays flat
      float stS = fract(sin(dot(stIp.xz, vec2(12.9898, 78.233))) * 43758.5453) * 6.2832;
      // (along a smooth radial field, not the per-vertex normal, so leaf cards move rigidly)
      vec3 stQ = position - vec3(0.0, ${CANOPY_C.y.toFixed(2)}, 0.0);
      float stB = sin(stQ.x * 0.83 + stS) * sin(stQ.z * 1.21 + stS * 1.7) * 0.6
                + sin(stQ.x * 1.37 - stQ.y * 1.05 + stS * 2.3) * 0.45
                + sin(stQ.z * 1.9 + stQ.y * 0.7 + stS * 3.1) * 0.25;
      vec3 stR = normalize(stQ * vec3(0.55, 1.0, 0.75) + vec3(0.0, 0.3, 0.0));
      transformed += stR * (0.42 * stB * smoothstep(${(CUT_Y + 0.25).toFixed(2)}, ${(CUT_Y + 1.4).toFixed(2)}, position.y));
      float stH = clamp((position.y - 3.0) / 4.8, 0.0, 1.0);
      float stGust = 0.6 + 0.4 * sin(uTime * 0.61 + stPh) * sin(uTime * 0.23 + stPh * 1.7);
      float stSway = 0.65 + 0.35 * sin(uTime * 1.25 + stPh + position.x * 0.25) + 0.2 * sin(uTime * 2.3 + position.z * 0.4);
      transformed += stW * (0.028 * stH * stH * stSway * (0.7 + uWind.y * stGust));
      float stFl = sin(uTime * 6.1 + dot(position, vec3(2.3, 3.1, 1.7)) + stPh);
      transformed += normal * (0.014 * length(uWind.xz) * (0.5 + uWind.y) * stFl * stH);
    }`);
}

/** Per quality: trees nearer than `near` m (horizontal) get the full trunk, core and card set;
 *  the others draw `farCards` of their cards (0 = core only). */
const LOD = {
  low: { near: 45, farCards: 0 },
  medium: { near: 60, farCards: 0.3 },
  high: { near: 80, farCards: 0.45 },
  ultra: { near: 110, farCards: 0.6 },
} as const;

export interface TreesResult {
  meshes: THREE.Object3D[];
  positions: THREE.Vector3[];
  /** Opaque dense-leaf material, reused for clipped hedges. */
  foliage: THREE.Material;
  /** Re-partitions trees into the near (full) and far (light) meshes around the camera. */
  update(camera: THREE.Vector3): void;
}

export function buildTrees(ctx: BuildContext, o: Owned, M: StreetMaterials, space: Space): TreesResult {
  const hi = ctx.quality === 'high' || ctx.quality === 'ultra';
  const lod = { low: 0.5, medium: 0.75, high: 1, ultra: 1.25 }[ctx.quality];
  const { near: lodNear, farCards } = LOD[ctx.quality];
  const r = makeRng(9001);

  // --- foliage materials: opaque core (early-z friendly) + alpha-tested cards on top --------
  const tex = foliageTextures(ctx.renderer, ctx.quality === 'ultra' ? 2048 : ctx.quality === 'low' ? 512 : 1024);
  Object.values(tex).forEach((t) => o.add(t));
  const foliage = (cards: boolean) => (shader: THREE.WebGLProgramParametersWithUniforms) => {
    canopyVertex(shader, ctx, cards);
    if (cards) {
      // a card seen edge-on reads as a dark stroke: fade it out (through the alpha test) as the
      // view grazes its plane (geometric face normal from screen-space derivatives)
      shader.fragmentShader = shader.fragmentShader.replace('#include <alphatest_fragment>', /* glsl */ `
      {
        vec3 stFn = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
        diffuseColor.a *= smoothstep(0.14, 0.45, abs(dot(stFn, normalize(vViewPosition))));
      }
      #include <alphatest_fragment>`);
    }
    shader.fragmentShader = shader.fragmentShader
      // cards keep the canopy-shape normal on both faces (no back-face flip)
      .replace('float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;', 'float faceDirection = 1.0;')
      // leaves are small glossy facets: at canopy scale their sky reflections and sun glints read
      // as frost (grazing Fresnel toward the bright horizon), so keep only a hint of them
      .replace('#include <aomap_fragment>', 'reflectedLight.indirectSpecular *= 0.3;\nreflectedLight.directSpecular *= 0.5;\n#include <aomap_fragment>')
      // ...so the sky reflection is approximated by the (rough-limit) irradiance: one environment
      // lookup instead of two on the most overdrawn surfaces of the street
      .replace('#include <lights_fragment_maps>', THREE.ShaderChunk.lights_fragment_maps.replace(
        'vec3 iblRadiance = getIBLRadiance( geometryViewDir, geometryNormal, material.roughness );',
        '#ifdef ST_FULL_IBL\nvec3 iblRadiance = getIBLRadiance( geometryViewDir, geometryNormal, material.roughness );\n#else\nvec3 iblRadiance = iblIrradiance * RECIPROCAL_PI;\n#endif'))
      .replace('#include <opaque_fragment>', /* glsl */ `
      #if NUM_DIR_LIGHTS > 0
      {
        vec3 stV = normalize(vViewPosition);
        vec3 stL = directionalLights[0].direction;
        float stBack = pow(clamp(dot(-stV, stL), 0.0, 1.0), 4.0);
        float stAo = clamp(vColor.g, 0.0, 1.0);
        // light scattered through thin leaves toward the viewer (sun behind the canopy) + wrap fill
        outgoingLight += diffuseColor.rgb * vec3(1.0, 1.15, 0.55) * directionalLights[0].color * (0.7 * stBack + 0.05) * stAo * stAo;
      }
      #endif
      #include <opaque_fragment>`);
  };
  // cards: no normal map (the card is a cluster of tiny leaves; per-leaf shading comes from the
  // painted atlas), which also keeps the most-overdrawn shader cheap
  const cardsMat = o.add(new THREE.MeshStandardMaterial({
    map: tex.cardMap, alphaTest: 0.5, side: THREE.DoubleSide, vertexColors: true, roughness: 0.8, metalness: 0, envMapIntensity: 0.9,
  }));
  cardsMat.onBeforeCompile = foliage(true);
  cardsMat.customProgramCacheKey = () => 'st-ficus-cards';
  const coreMat = o.add(new THREE.MeshStandardMaterial({
    map: tex.tileMap, normalMap: tex.tileNormal, normalScale: new THREE.Vector2(0.45, 0.45), vertexColors: true, roughness: 0.8, metalness: 0, envMapIntensity: 0.9,
  }));
  coreMat.onBeforeCompile = foliage(false);
  coreMat.customProgramCacheKey = () => 'st-ficus-core';
  const depthOf = (p: THREE.MeshDepthMaterialParameters, key: string, cards = false) => {
    const m = o.add(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, ...p }));
    m.onBeforeCompile = (shader) => canopyVertex(shader, ctx, cards);
    m.customProgramCacheKey = () => key;
    return m;
  };
  // cards cast only from their dense middles so light leaks between them (dappled shade)
  const cardsDepth = depthOf({ map: tex.cardMap, alphaTest: 0.8, side: THREE.DoubleSide }, 'st-ficus-cards-depth', true);
  // ultra: the core's shadow gets small round holes (sun flecks); otherwise it is an opaque,
  // early-z friendly caster and the dapple comes from the leaf cards along the canopy edges
  const coreDepth = ctx.quality === 'ultra'
    ? depthOf({ alphaMap: tex.tileHoles, alphaTest: 0.5 }, 'st-ficus-core-depth')
    : depthOf({}, 'st-ficus-core-depth-solid');

  // --- placements ----------------------------------------------------------------------------
  const places: Place[] = [];
  const positions: THREE.Vector3[] = [];
  const addTree = (x: number, z: number, collide: boolean) => {
    const flip = r() < 0.5 ? 0 : Math.PI;
    const sxz = range(r, 0.92, 1.08);
    places.push({ x, y: CURB, z, ry: flip + range(r, -0.12, 0.12), s: [sxz * range(r, 0.95, 1.05), range(r, 0.9, 1.08), sxz] });
    positions.push(new THREE.Vector3(x, CURB, z));
    space.circle(x, z, 0.9);
    if (collide) cylCollider(o, ctx, x, z, CURB, CURB + 3.0, 0.3, G.STATIC);
  };
  for (const z of TREE_ROWS_Z) {
    for (let x = TREE_X.min; x <= TREE_X.max + 0.01; x += TREE_X.spacing) addTree(x + range(r, -0.15, 0.15), z, true);
    // the avenue keeps going beyond the east barrier (visual only)
    for (let x = EAST_BACKDROP.xMin + 8; x < QUAY_X - 8; x += TREE_X.spacing) addTree(x, z, false);
  }
  const colors = places.map(() => new THREE.Color().setHSL(0.25 + range(r, -0.02, 0.02), 0.2, range(r, 0.47, 0.53)).multiplyScalar(2));
  const N = places.length;

  // --- geometry: full (near) and light (far) sets ------------------------------------------------
  const sdf = makeSdf(canopyLobes(makeRng(4321)));
  const coreDetail = ctx.quality === 'ultra' ? 6 : ctx.quality === 'low' ? 4 : 5;
  const coreNear = coreGeometry(sdf, coreDetail, 1.1);
  const coreFar = coreGeometry(sdf, Math.max(3, coreDetail - 2), 1.1);
  const cardsNear = cardsGeometry(sdf, makeRng(99), Math.round(260 * lod));
  // far cards: the same buffers, drawing only the first (random) part of the cards
  const cardsFar = new THREE.BufferGeometry();
  for (const [k, a] of Object.entries(cardsNear.attributes)) cardsFar.setAttribute(k, a);
  cardsFar.setIndex(cardsNear.getIndex());
  cardsFar.setDrawRange(0, Math.round(cardsNear.getIndex()!.count * farCards / 6) * 6);
  cardsFar.boundingSphere = cardsNear.boundingSphere;
  const trunkNear = trunkGeometry(makeRng(77), M.tile.bark, lod);
  const trunkFar = trunkGeometry(makeRng(77), M.tile.bark, lod, 0.55);
  // wind + bulges push vertices a little outside the static bounds
  for (const g of [coreNear, coreFar, cardsNear, trunkNear, trunkFar]) {
    g.computeBoundingSphere();
    g.boundingSphere!.radius += 0.8;
  }
  o.add(cardsFar);

  // Near and far sets each share one instance-matrix buffer (and one colour buffer) across
  // trunk, core and cards; update() rewrites them when the camera has moved.
  const makeSet = (trunkG: THREE.BufferGeometry, coreG: THREE.BufferGeometry, cardsG: THREE.BufferGeometry, cardShadows: boolean, tag: string) => {
    const trunk = instanced(o, trunkG, M.bark, places, { cast: true, name: `street-ficus-trunks-${tag}` });
    const core = instanced(o, coreG, coreMat, places, { cast: true, name: `street-ficus-core-${tag}`, colors });
    const cards = instanced(o, cardsG, cardsMat, places, { cast: cardShadows, name: `street-ficus-cards-${tag}`, colors });
    core.customDepthMaterial = coreDepth;
    cards.customDepthMaterial = cardsDepth;
    cards.renderOrder = 1; // after the opaque core: hidden card fragments fail the depth test early
    core.instanceMatrix = cards.instanceMatrix = trunk.instanceMatrix;
    core.instanceColor = cards.instanceColor;
    return { meshes: [trunk, core, cards], matrix: trunk.instanceMatrix, color: cards.instanceColor! };
  };
  const near = makeSet(trunkNear, coreNear, cardsNear, hi, 'near');
  const far = makeSet(trunkFar, coreFar, cardsFar, false, 'far');
  const setCount = (set: typeof near, n: number) => {
    for (const m of set.meshes) {
      m.count = n;
      m.visible = n > 0 && m.geometry.drawRange.count > 0; // (low: far trees draw no cards)
    }
    set.matrix.needsUpdate = true;
    set.color.needsUpdate = true;
    if (n > 0) for (const m of set.meshes) m.computeBoundingSphere();
  };
  setCount(far, 0); // until the first update(): everything at full detail
  const elems = places.map((p) => matrixOf({ p: [p.x, p.y, p.z], r: [0, p.ry ?? 0, 0], s: p.s ?? 1 }).toArray());
  const last = new THREE.Vector3(Infinity, 0, 0);
  const update = (cam: THREE.Vector3) => {
    if ((cam.x - last.x) ** 2 + (cam.z - last.z) ** 2 < 9) return; // re-sort every 3 m of travel
    last.copy(cam);
    let nn = 0, nf = 0;
    const nm = near.matrix.array as Float32Array, fm = far.matrix.array as Float32Array;
    const nc = near.color.array as Float32Array, fc = far.color.array as Float32Array;
    for (let i = 0; i < N; i++) {
      const p = places[i];
      const isNear = (p.x - cam.x) ** 2 + (p.z - cam.z) ** 2 < lodNear * lodNear;
      const k = isNear ? nn++ : nf++;
      (isNear ? nm : fm).set(elems[i], k * 16);
      const c = colors[i];
      const ca = isNear ? nc : fc;
      ca[k * 3] = c.r; ca[k * 3 + 1] = c.g; ca[k * 3 + 2] = c.b;
    }
    setCount(near, nn);
    setCount(far, nf);
  };

  // --- canopy colliders: the camera spring arm (and litter) must not pass through the foliage.
  // Per row a stack of boxes between the clipped underside and the crown, sized from the canopy
  // profile and inset from the leafy surface. Nothing walkable is that high: kiosk roofs end at
  // |z| 5.45, the boxes start beyond |z| 5.8.
  const halfWidth = (y: number) => {
    const p = new THREE.Vector3();
    let lo = 0, hi = 8;
    for (let i = 0; i < 24; i++) {
      const m = (lo + hi) / 2;
      if (sdf(p.set(0, y, m)) < 0) lo = m;
      else hi = m;
    }
    return lo;
  };
  coreNear.computeBoundingBox();
  const bb = coreNear.boundingBox!;
  // heights above the pavement: underside of the tallest tree up to near the crown of the lowest,
  // in four bands, each as wide as the narrowest tree (y scale 0.9, xz scale 0.92) is there
  const yLow = CUT_Y * 1.08 + 0.12, yTop = bb.max.y * 0.9 - 0.25, bands = 4;
  const x0 = TREE_X.min + bb.min.x * 0.85, x1 = TREE_X.max + bb.max.x * 0.85;
  for (let i = 0; i < bands; i++) {
    const a = yLow + ((yTop - yLow) * i) / bands, b = yLow + ((yTop - yLow) * (i + 1)) / bands;
    const hz = Math.min(halfWidth(a / 0.9), halfWidth(b / 0.9), halfWidth((a + b) / 1.8)) * 0.92 - 0.15;
    for (const z of TREE_ROWS_Z) boxCollider(o, ctx, x0, x1, CURB + a, CURB + b, z - hz, z + hz);
  }

  // --- iron grates (with a granite frame) around each trunk ---------------------------------
  const grateGeo = new THREE.PlaneGeometry(1.6, 1.6).rotateX(-Math.PI / 2);
  const grPlaces = positions.map((p) => ({ x: p.x, y: CURB + 0.002, z: p.z }));
  const grates = instanced(o, grateGeo, M.grate, grPlaces, { name: 'street-tree-grates' });
  const fw = 0.16, half = 0.8;
  const frameParts = [
    [0, -half - fw / 2, 1.6 + fw * 2, fw], [0, half + fw / 2, 1.6 + fw * 2, fw],
    [-half - fw / 2, 0, fw, 1.6], [half + fw / 2, 0, fw, 1.6],
  ].map(([x, z, w, d]) => {
    const g = new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2).translate(x, 0, z);
    const uvA = g.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uvA.count; i++) uvA.setXY(i, uvA.getX(i) * w / M.tile.granite, uvA.getY(i) * d / M.tile.granite);
    return g;
  });
  const frames = instanced(o, mergeParts(frameParts), M.graniteInlay, grPlaces, { name: 'street-tree-grate-frames' });

  return { meshes: [...near.meshes, ...far.meshes, grates, frames], positions, foliage: coreMat, update };
}
