// Materials of the buildings module (all PBR MeshStandardMaterial with injected shader code):
//  • masonry  — texture-array PBR (layer per vertex) + procedural weathering (streaks, rising damp,
//               dust on ledges). One material for every opaque facade surface.
//  • glass    — window panes: env reflections + procedural painted frames/mullions + an
//               interior-mapping room behind the glass (walls, floor, ceiling, furniture, curtains,
//               lamps), so windows are never flat black.
//  • cutout   — alpha-tested ironwork/balustrades/foliage atlas, foliage sways with the wind.
//  • signs    — shop sign atlas with a glow map.
//  • flag     — Tunisian flags rippling with uTime/uWind.
//  • proxy    — shadow-caster proxy: drawn only into the shadow map (see buildings.ts).
import {
  Color, DoubleSide, MeshBasicMaterial, MeshStandardMaterial, ShaderChunk, Vector3, type Material, type WebGLProgramParametersWithUniforms,
} from 'three';
import type { Quality, SharedUniforms } from '../../core/types';
import { CURB, TREE_X, X_MIN } from '../../core/layout';
import { LAYER_PARAMS, type BuildingTextures } from './textures';
import type { SignAtlas } from './signs';

export interface BuildingMaterials {
  masonry: MeshStandardMaterial;
  masonryFar: MeshStandardMaterial;
  glass: MeshStandardMaterial;
  cutout: MeshStandardMaterial;
  signs: MeshStandardMaterial;
  flag: MeshStandardMaterial;
  proxy: MeshBasicMaterial;
  all: Material[];
  dispose(): void;
}

/** Window kinds stored in aExt.w of the glass buffer (shop panes add 0.2 / 0.4 for their interior type). */
export const WIN = { FRENCH: 0, SHOP: 1, MODERN: 2, CAFE: 3, FANLIGHT: 4, SMALL: 5 } as const;

const NOISE = /* glsl */ `
float bHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float bNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(bHash(i), bHash(i + vec2(1.0, 0.0)), f.x), mix(bHash(i + vec2(0.0, 1.0)), bHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
`;

/** The sun as the shader sees it (SunLight in the game, DirectionalLight in the dev harness):
 *  declares sC (colour × intensity) and sDW (world direction toward the sun). */
const SUN = /* glsl */ `
vec3 sC = vec3(0.0), sD = vec3(0.0, 1.0, 0.0);
#if NUM_SUN_LIGHTS > 0
sC = sunLights[0].color; sD = sunLights[0].direction;
#elif NUM_DIR_LIGHTS > 0
sC = directionalLights[0].color; sD = directionalLights[0].direction;
#endif
vec3 sDW = normalize((vec4(sD, 0.0) * viewMatrix).xyz);
`;

/** Shadow lookups (5-tap PCF per cascade) only where the sun can reach: surfaces facing away from
 *  it (the whole south row, east walls) get no direct light anyway. Exact, no visual change. */
const FACING_SHADOWS = ShaderChunk.lights_fragment_begin.replaceAll(
  '( directLight.visible && receiveShadow )',
  '( directLight.visible && receiveShadow && dot( geometryNormal, directLight.direction ) > 0.0 )',
);
if (FACING_SHADOWS === ShaderChunk.lights_fragment_begin) throw new Error('buildings: lights_fragment_begin changed, update FACING_SHADOWS');

/** far = cheap variant for distant LOD chunks: no weathering noise, no normal mapping. */
const CHEAP_IBL = ShaderChunk.lights_fragment_maps.replace(
  'vec3 iblRadiance = getIBLRadiance( geometryViewDir, geometryNormal, material.roughness );',
  'vec3 iblRadiance = iblIrradiance * RECIPROCAL_PI;',
);

function masonry(tex: BuildingTextures, quality: Quality, far: boolean): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
  if (far) m.defines = { BLD_FAR: '' };
  const layerParams = LAYER_PARAMS.map(([s, n, r]) => new Vector3(s, n, r));
  m.onBeforeCompile = (sh: WebGLProgramParametersWithUniforms) => {
    sh.uniforms.tAlb = { value: tex.albedo };
    sh.uniforms.tNrm = { value: tex.normal };
    sh.uniforms.tNoise = { value: tex.noise };
    sh.uniforms.uLayer = { value: layerParams };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 aExt;
varying vec4 vExt;
varying vec2 vTexUv;
varying vec3 vWPos;
varying vec3 vWNrm;`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>
vExt = aExt; vTexUv = uv;`)
      .replace('#include <project_vertex>', `#include <project_vertex>
vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vWNrm = normalize(mat3(modelMatrix) * objectNormal);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
precision highp sampler2DArray;
uniform sampler2DArray tAlb;
uniform sampler2DArray tNrm;
uniform sampler2D tNoise; // tileable value noise: r 8, g 32, b 64, a 16 cells per tile
uniform vec3 uLayer[${LAYER_PARAMS.length}];
varying vec4 vExt;
varying vec2 vTexUv;
varying vec3 vWPos;
varying vec3 vWNrm;`)
      .replace('#include <map_fragment>', `
int bLayer = int(vExt.x + 0.5);
vec3 bLp = uLayer[bLayer];
vec2 bUv = vTexUv * bLp.x;
vec3 bTex = vec3(bUv, float(bLayer));
diffuseColor.rgb *= texture(tAlb, bTex).rgb;
vec3 bNrmT = texture(tNrm, bTex).xyz;
float bGrime = 0.0;
// facade coordinates (along, up) in metres for the weathering noise
vec3 bWn = normalize(vWNrm);
float bHc = abs(bWn.z) > abs(bWn.x) ? vWPos.x : vWPos.z;
vec2 bWp = vec2(bHc, vWPos.y);
#ifdef BLD_FAR
diffuseColor.rgb *= 0.96 + 0.08 * texture(tNoise, bWp / 32.0).r;
#else
// Weathering from one baked noise texture (4 fetches, mip-filtered, so it stays alias-free with
// distance). Normal detail and the fine dirt fade out from 30 m, the rest from 80 m.
float bDist = length(vViewPosition);
float bNear = 1.0 - smoothstep(30.0, 45.0, bDist);
float bMid = 1.0 - smoothstep(80.0, 120.0, bDist);
vec2 bDx = dFdx(bWp), bDy = dFdy(bWp); // explicit gradients: the fetches sit in branches
if (vExt.y > 0.0 && bMid > 0.0) {
  vec4 nA = textureGrad(tNoise, bWp / 32.0, bDx / 32.0, bDy / 32.0);
  float n1 = nA.r, n2 = nA.g;
  // patchy tone (repainted / sun-bleached areas)
  diffuseColor.rgb *= 0.91 + 0.1 * n1 + 0.06 * n2;
  // long rain streaks, wobbling a little
  vec2 sk = vec2(0.2, 1.0 / 320.0);
  float streak = smoothstep(0.58, 0.92, textureGrad(tNoise, vec2(bHc + n2 * 0.19, vWPos.y) * sk, bDx * sk, bDy * sk).a) * smoothstep(0.3, 0.75, n1);
  float blot = smoothstep(0.6, 1.0, n1 * 0.7 + n2 * 0.3);
  // rising damp and splash just above the pavement
  float damp = 1.0 - smoothstep(0.0, 0.9 + 0.7 * n2, vWPos.y - 0.15);
  float ledge = smoothstep(0.55, 0.95, bWn.y);
  float fine = 0.0, drip = 0.0;
  if (bNear > 0.0) {
    // speckled dirt, and drip streaks under sills / ledges (aExt.z ramp baked by the generator)
    fine = smoothstep(0.45, 0.9, textureGrad(tNoise, bWp / 9.6, bDx / 9.6, bDy / 9.6).b * 0.6 + n2 * 0.4) * bNear;
    vec2 dk = vec2(1.0 / 9.8, 0.45 / 64.0);
    drip = vExt.z * smoothstep(0.35, 0.78, textureGrad(tNoise, vec2(bHc / 9.8, (vWPos.y * 0.45 + n2 * 3.0) / 64.0), bDx * dk, bDy * dk).b) * bNear;
  }
  bGrime = vExt.y * (0.75 * streak + 0.25 * fine + 0.4 * blot + 0.35 * ledge + 1.5 * drip) + damp * 0.5 * min(1.0, vExt.y * 1.8);
  bGrime *= bMid;
  diffuseColor.rgb *= mix(vec3(1.0), vec3(0.55, 0.5, 0.43), clamp(bGrime, 0.0, 0.85));
}
#endif
`)
      .replace('#include <roughnessmap_fragment>', `float roughnessFactor = clamp(bNrmT.z * bLp.z + bGrime * 0.1, 0.05, 1.0);`)
      // plaster/stone are rough: the prefiltered specular env lookup is replaced by the diffuse
      // irradiance already fetched (saves one PMREM lookup per pixel, visually equivalent here)
      .replace('#include <lights_fragment_begin>', FACING_SHADOWS)
      .replace('#include <lights_fragment_maps>', CHEAP_IBL)
      // The sky-only IBL has no street wall across the avenue: walls facing away from the sun get
      // the bounce of the sunlit wall opposite them (it fills ≈ 22 % of their view; average albedo
      // ≈ 0.5 with its windows and shopfronts).
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
{
  ${SUN}
  vec3 bN = normalize(vWNrm);
  float bOpp = max(0.0, -dot(sDW, bN)) * (1.0 - abs(bN.y));
  reflectedLight.indirectDiffuse += sC * (bOpp * 0.11) * BRDF_Lambert(material.diffuseColor);
}`)
      .replace('#include <normal_fragment_maps>', `
#ifndef BLD_FAR
if (bNear > 0.0) {
  vec2 nxy = (bNrmT.xy * 2.0 - 1.0) * bLp.y * bNear;
  vec3 mapN = vec3(nxy, sqrt(max(1e-4, 1.0 - dot(nxy, nxy))));
  vec3 q0 = dFdx(-vViewPosition), q1 = dFdy(-vViewPosition);
  vec2 st0 = dFdx(bUv), st1 = dFdy(bUv);
  vec3 N = normal;
  vec3 q1p = cross(q1, N), q0p = cross(N, q0);
  vec3 T = q1p * st0.x + q0p * st1.x;
  vec3 B = q1p * st0.y + q0p * st1.y;
  float det = max(dot(T, T), dot(B, B));
  float sc = det == 0.0 ? 0.0 : inversesqrt(det);
  normal = normalize(T * (sc * mapN.x) + B * (sc * mapN.y) + N * mapN.z);
}
#endif
`);
  };
  m.customProgramCacheKey = () => `bld-masonry-${quality}-${far ? 'far' : 'near'}`;
  return m;
}

function glass(quality: Quality): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ vertexColors: true, roughness: 0.05, metalness: 0, envMapIntensity: 2.2 });
  const low = quality === 'low';
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uInterior = { value: 0.26 };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 aExt;
varying vec4 vWin;
varying vec2 vWUv;
varying vec3 vWPos;
varying vec3 vWNrm;`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>
vWin = aExt; vWUv = uv;`)
      .replace('#include <project_vertex>', `#include <project_vertex>
vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vWNrm = normalize(mat3(modelMatrix) * objectNormal);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uInterior;
varying vec4 vWin;
varying vec2 vWUv;
varying vec3 vWPos;
varying vec3 vWNrm;
${NOISE}
float h1(float n) { return fract(sin(n * 91.345 + 7.13) * 43758.5453); }
float bar(float d, float hw) { float aa = max(fwidth(d), 1e-4); return 1.0 - smoothstep(hw - aa, hw + aa, d); }
vec3 wallPal(float s) {
  float k = floor(s * 8.0);
  if (k < 1.0) return vec3(0.72, 0.64, 0.50);
  if (k < 2.0) return vec3(0.50, 0.58, 0.62);
  if (k < 3.0) return vec3(0.56, 0.62, 0.50);
  if (k < 4.0) return vec3(0.80, 0.77, 0.70);
  if (k < 5.0) return vec3(0.74, 0.56, 0.46);
  if (k < 6.0) return vec3(0.66, 0.60, 0.54);
  if (k < 7.0) return vec3(0.84, 0.80, 0.72);
  return vec3(0.60, 0.52, 0.56);
}
// Shop goods: packaging colours per item.
vec3 goodsCol(vec2 cell, float seed) {
  float g = h1(cell.x * 1.7 + cell.y * 13.1 + seed * 5.3);
  if (g < 0.2) return vec3(0.82, 0.8, 0.75);
  if (g < 0.32) return vec3(0.62, 0.12, 0.1);
  if (g < 0.44) return vec3(0.12, 0.24, 0.52);
  if (g < 0.54) return vec3(0.82, 0.62, 0.16);
  if (g < 0.64) return vec3(0.2, 0.42, 0.24);
  if (g < 0.76) return vec3(0.48, 0.34, 0.22);
  if (g < 0.86) return vec3(0.12, 0.12, 0.13);
  return vec3(0.68, 0.58, 0.54);
}
// Shop walls by interior type (from the shop kind, encoded in the pane kind: see facade.ts
// SHOP_INTERIOR): s = metres along the wall, fy = height above the floor. 0: stocked shelves (books,
// pastries, chemist, newsagent), 1: boutique (sparse lit niches on a pale wall), 2: clothes on rails
// with folded stock above.
vec3 shopWall(float s, float fy, float seed, vec3 wall, float type) {
  if (type > 1.5) {
    if (fy > 1.78 && fy < 1.82) return vec3(0.35, 0.34, 0.33); // rail
    if (fy > 0.7 && fy < 1.76) {
      float cw = 0.05 + 0.04 * h1(floor(s / 0.07) + seed);
      vec3 c = goodsCol(vec2(floor(s / cw), 7.0), seed);
      c = mix(c, vec3(dot(c, vec3(0.333))), 0.35);
      return c * (0.75 + 0.25 * fract(s / cw)) * (1.0 - 0.35 * smoothstep(1.2, 0.7, fy)); // folds, hem in shade
    }
    if (fy < 2.25 && fy > 1.95) return goodsCol(vec2(floor(s / 0.3), 3.0), seed + 5.0) * 0.8; // folded stock
    return wall;
  }
  bool boutique = type > 0.5;
  if (fy > 2.3 || fy < 0.1 || (boutique && (fy < 0.8 || fy > 2.0))) return wall;
  float band = floor(fy / 0.42), fb = fract(fy / 0.42);
  if (fb < 0.09) return boutique ? wall * 0.85 : vec3(0.24, 0.22, 0.2); // shelf board
  float cw = boutique ? 0.3 + 0.3 * h1(band * 7.0 + seed) : 0.16 + 0.22 * h1(band * 7.0 + seed);
  vec2 cell = vec2(floor(s / cw), band);
  float fx = fract(s / cw);
  if (h1(cell.x * 3.1 + band * 11.0 + seed * 2.0) < (boutique ? 0.6 : 0.14)) return wall * (boutique ? 1.0 : 0.5); // empty slot
  if (fb > 0.12 + 0.85 * (0.45 + 0.5 * h1(cell.x * 5.3 + band * 3.0 + seed))) return wall * 0.55; // above the item
  vec3 c = goodsCol(cell, seed);
  c = mix(c, vec3(dot(c, vec3(0.333))), 0.25);
  return c * (0.7 + 0.3 * step(0.08, fx) * step(fx, 0.92)) * (boutique ? 1.25 : 1.0);
}
// Interior mapping: the view ray continues through the pane into a box room behind it
// (window-local meters, x across, y up, z into the room).
vec3 roomColor(vec2 wm, float W, float H, float kind, float seed, vec3 V, vec3 T, vec3 N) {
  vec3 r = vec3(dot(V, T), V.y, -dot(V, N));
  r.z = max(r.z, 1e-3);
  bool cafe = kind > 2.5 && kind < 3.5;
  bool shop = (kind > 0.5 && kind < 1.5) || cafe;
  float stype = floor((kind - 0.95) * 5.0); // WIN.SHOP + 0 / 0.2 / 0.4 → 0 / 1 / 2
  float D = shop ? mix(6.0, 10.0, h1(seed * 3.1)) : mix(3.4, 5.5, h1(seed * 7.1));
  float ex = shop ? 0.3 : mix(0.8, 2.0, h1(seed * 5.7));
  float yb = kind < 0.5 ? 0.06 : kind > 4.5 ? 0.9 : shop ? 0.5 : 0.85;
  float yt = shop ? 0.6 : mix(0.45, 0.9, h1(seed * 2.3));
  vec3 p = vec3(wm, 0.0);
  float tx = r.x > 0.0 ? (W + ex - p.x) / r.x : (-ex - p.x) / min(r.x, -1e-5);
  float ty = r.y > 0.0 ? (H + yt - p.y) / r.y : (-yb - p.y) / min(r.y, -1e-5);
  float tz = D / r.z;
  float t = min(tz, min(tx, ty));
  vec3 h = p + r * t;
  float fy = h.y + yb; // height above the room floor
  float xr = (h.x + ex) / (W + 2.0 * ex); // 0..1 across the room
  vec3 wall = wallPal(h1(seed * 11.3));
  if (cafe) wall = vec3(0.45, 0.30, 0.18);
  vec3 col;
  float fx = h1(seed * 17.0);
  bool floorHit = t == ty && r.y < 0.0;
  bool gondola = false;
  // café: pendant lamps, tables and chairs, the bar counter (extra planes tested before the room
  // box). Tables are vertical silhouettes: seen from the pavement, horizontal table-top discs are
  // edge-on and read as stains on the floor.
  if (cafe) {
    // hanging lamps on a 2.2 m grid
    float tl = (H + yt - 0.9 - p.y) / r.y;
    if (r.y > 0.0 && tl < t) {
      vec3 ql = p + r * tl;
      vec2 cl = fract(vec2(ql.x / 2.2 + 0.5, ql.z / 2.2)) - 0.5;
      if (ql.z > 1.0 && length(cl) < 0.09) return vec3(3.2, 2.2, 1.2);
    }
    // two rows of bistro tables with bentwood chairs (silhouettes on planes across the room)
    for (int k = 0; k < 2; k++) {
      float zr = k == 0 ? 2.0 : 3.8;
      float tr = (zr - p.z) / r.z;
      if (tr >= t) continue;
      vec3 q = p + r * tr;
      float y = q.y + yb;
      float lx = fract((q.x + float(k) * 0.9) / 1.8) * 1.8 - 0.9, ax = abs(lx); // from the table axis
      float chx = abs(ax - 0.55);
      vec3 c = vec3(-1.0);
      if (y > 0.73 && y < 0.77 && ax < 0.3) c = vec3(0.78, 0.76, 0.72); // marble top
      else if ((y < 0.73 && ax < 0.025) || (y < 0.03 && ax < 0.2)) c = vec3(0.06); // pedestal, foot
      else if (chx < 0.19 && y > 0.43 && y < 0.47) c = vec3(0.24, 0.14, 0.08); // seat
      else if (chx < 0.19 && chx > 0.16 && y < (ax > 0.55 ? 0.9 : 0.45)) c = vec3(0.18, 0.1, 0.06); // legs, back posts
      else if (ax > 0.55 && chx < 0.19 && y > 0.82 && y < 0.9) c = vec3(0.2, 0.12, 0.07); // back rail
      if (c.x >= 0.0) return c * (1.1 - 0.4 * zr / D);
    }
    // bar counter across the back of the room
    float tc = (D - 1.1) / r.z;
    vec3 qc = p + r * tc;
    if (tc < t && qc.y + yb < 1.1 && qc.y + yb > 0.0) {
      vec3 cc = qc.y + yb > 1.0 ? vec3(0.55, 0.5, 0.45) : qc.y + yb > 0.9 ? vec3(0.62, 0.48, 0.2) : vec3(0.28, 0.16, 0.09) * (0.85 + 0.15 * step(0.5, fract(qc.x * 1.6)));
      return cc * 1.1;
    }
  }
  // shop: free-standing display gondola across the middle of the room
  if (shop && !cafe) {
    wall = mix(wall, vec3(0.8, 0.78, 0.74), 0.6);
    float tg = (D * 0.5 - p.z) / r.z;
    vec3 qg = p + r * tg;
    float xg = (qg.x + ex) / (W + 2.0 * ex);
    if (tg < t && qg.y + yb < 1.45 && abs(xg - 0.5) < 0.24) {
      t = tg; h = qg; fy = qg.y + yb; xr = xg;
      gondola = true;
    }
  }
  if (gondola) {
    col = fy > 1.38 ? vec3(0.3, 0.28, 0.26) : shopWall(h.x, fy + 0.12, seed + 3.0, vec3(0.35, 0.34, 0.33), stype);
  } else if (t == tz) {
    col = wall;
    if (shop && !cafe) {
      // stocked shelving along the back wall, a counter in front of one side
      col = shopWall(h.x, fy, seed, wall, stype);
      if (fy < 1.0 && xr > 0.62 && xr < 0.92) col = vec3(0.3, 0.21, 0.15) * (0.85 + 0.15 * step(0.9, fy));
    } else if (cafe) {
      // wood panelling, a mirror band reflecting the warm room, cornice
      col = fy < 1.1 ? vec3(0.32, 0.2, 0.12) : fy < 2.4 ? mix(vec3(0.5, 0.4, 0.3), vec3(0.72, 0.6, 0.45), smoothstep(1.1, 2.4, fy)) * (0.9 + 0.1 * step(0.5, fract(h.x * 0.5))) : vec3(0.5, 0.36, 0.22);
      if (abs(fract(h.x * 0.5) - 0.5) > 0.47) col *= 0.6; // mirror frames
    } else {
      if (fy < 0.12) col *= 0.6; // skirting
      if (fy < 0.85 && abs(xr - fx) < 0.2) col = mix(vec3(0.28, 0.19, 0.12), vec3(0.42, 0.3, 0.2), step(0.5, h1(seed * 4.0))); // sideboard / sofa
      if (abs(fy - 1.65) < 0.26 && abs(xr - (1.0 - fx)) < 0.07) col = vec3(0.3, 0.32, 0.34) * (0.6 + h1(seed) * 0.7); // picture
      if (h1(seed * 9.0) > 0.55 && abs(xr - 0.5 - (fx - 0.5) * 0.4) < 0.09 && fy < 2.1) col *= 0.3; // doorway
    }
  } else if (t == tx) {
    col = wall * 0.8;
    if (cafe) col = fy < 1.1 ? vec3(0.28, 0.18, 0.11) : vec3(0.62, 0.52, 0.4);
    else if (shop) col = shopWall(h.z + 7.0, fy, seed + 1.0, wall, stype);
    else if (h1(seed * 31.0) > 0.5 && fy < 2.0 && abs(fract(h.z * 0.35 + fx) - 0.5) < 0.2) {
      // bookcase
      float bk = h1(floor(h.z * 12.0) + floor(fy * 3.0) * 7.0);
      col = step(0.2, fract(fy * 3.0)) > 0.5 ? vec3(0.25 + bk * 0.4, 0.2 + bk * 0.2, 0.15 + bk * 0.15) : vec3(0.3, 0.2, 0.12);
    }
  } else if (floorHit) {
    if (cafe) col = mix(vec3(0.62, 0.58, 0.52), vec3(0.5, 0.44, 0.38), step(0.5, fract((floor(h.x * 2.5) + floor(h.z * 2.5)) * 0.5))); // cement tiles
    else if (h1(seed * 13.0) > 0.45) col = vec3(0.36, 0.23, 0.13) * (0.8 + 0.25 * bNoise(vec2(h.x * 0.9, floor(h.z * 7.0) * 3.1)));
    else col = mix(vec3(0.6, 0.56, 0.5), vec3(0.42, 0.4, 0.38), step(0.5, fract((floor(h.x * 3.3) + floor(h.z * 3.3)) * 0.5)));
    if (!shop && abs(xr - 0.5) < 0.3 && h.z > D * 0.3 && h.z < D * 0.75) col *= vec3(0.85, 0.55, 0.5); // rug
  } else {
    col = vec3(0.82, 0.8, 0.76);
    if (shop && !cafe) col = vec3(0.62, 0.6, 0.57) + step(0.86, fract(h.x * 0.8)) * step(0.72, fract(h.z * 0.5)) * 0.7; // strip lights
  }
  // light: daylight falling off with depth + lamps
  float depthF = clamp(h.z / D, 0.0, 1.0);
  float lit = mix(1.0, 0.22, sqrt(depthF)) * (0.85 + 0.3 * smoothstep(0.0, 2.5, fy));
  vec3 L = vec3(lit);
  bool lamp = cafe || shop || h1(seed * 5.3) < 0.2;
  vec3 lampC = cafe ? vec3(1.0, 0.7, 0.4) : vec3(1.0, 0.85, 0.65);
  if (lamp) {
    vec3 lp = vec3(W * 0.5, H + yt - 0.4, D * 0.5);
    float dl = length(h - lp);
    L += lampC * (shop && !cafe ? 0.8 : 1.0) / (1.0 + dl * dl * 0.25);
  }
  col *= L;
  if (shop && !cafe) col *= 0.9;
  if (cafe) col *= 1.2;
  return col;
}
`)
      .replace('#include <color_fragment>', `
float gW = vWin.y, gH = vWin.z, gKind = vWin.w, gSeed = vWin.x;
vec2 wm = vWUv * vec2(gW, gH);
float border = min(min(wm.x, gW - wm.x), min(wm.y, gH - wm.y));
float gFrame = bar(border, gKind > 0.5 && gKind < 1.5 ? 0.05 : 0.065);
if (gKind < 0.5) {
  // French casement: two leaves, transom, glazing bars
  float tr = gH - min(0.55, gH * 0.22);
  gFrame = max(gFrame, bar(abs(wm.x - gW * 0.5), 0.04));
  if (gH > 1.8) gFrame = max(gFrame, bar(abs(wm.y - tr), 0.035));
  float pane = (gH > 1.8 ? tr : gH) / 3.0;
  if (wm.y < tr) gFrame = max(gFrame, bar(abs(fract(wm.y / pane + 0.5) - 0.5) * pane, 0.016));
} else if (gKind < 1.5 || (gKind > 2.5 && gKind < 3.5)) {
  // shop: slim frame, transom, café: small panes on top
  gFrame = max(gFrame, bar(abs(wm.y - (gH - 0.55)), 0.03));
  if (gKind > 2.5 && wm.y > gH - 0.55) gFrame = max(gFrame, bar(abs(fract(wm.x / 0.45 + 0.5) - 0.5) * 0.45, 0.015));
  if (gW > 2.6) gFrame = max(gFrame, bar(abs(fract(wm.x / (gW / floor(gW / 1.3)) + 0.5) - 0.5) * (gW / floor(gW / 1.3)), 0.025));
} else if (gKind < 2.5) {
  // modern: aluminium mullions every ~1.2 m + a vent row
  float m = gW / max(1.0, floor(gW / 1.2));
  gFrame = max(gFrame, bar(abs(fract(wm.x / m + 0.5) - 0.5) * m, 0.03));
  gFrame = max(gFrame, bar(abs(wm.y - gH * 0.78), 0.025));
} else if (gKind < 4.5) {
  // fanlight: radiating bars
  vec2 c = vec2(gW * 0.5, 0.0);
  float an = atan(wm.y - c.y, wm.x - c.x);
  gFrame = max(gFrame, bar(abs(fract(an / 0.314159 + 0.5) - 0.5) * 0.3 * length(wm - c), 0.02));
} else {
  gFrame = max(gFrame, bar(abs(wm.x - gW * 0.5), 0.035));
  gFrame = max(gFrame, bar(abs(wm.y - gH * 0.5), 0.03));
}
diffuseColor.rgb = vColor.rgb * gFrame;
`)
      .replace('#include <roughnessmap_fragment>', `float roughnessFactor = mix(0.03 + 0.1 * h1(gSeed * 3.7), 0.5, gFrame);`)
      .replace('#include <lights_fragment_begin>', FACING_SHADOWS)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
{
  vec3 N = normalize(vWNrm);
  vec3 T = normalize(cross(vec3(0.0, 1.0, 0.0), N));
  vec3 V = normalize(vWPos - cameraPosition);
  float fres = 0.04 + 0.96 * pow(1.0 - clamp(-dot(V, N), 0.0, 1.0), 5.0);
  // distant (or 'low' quality) windows: a flat room tint instead of the full interior mapping
  vec3 room = wallPal(h1(gSeed * 11.3)) * (0.25 + 0.4 * vWUv.y) * ((gKind > 0.5 && gKind < 1.5) || (gKind > 2.5 && gKind < 3.5) ? 1.4 : 1.0);
  ${low ? '' : 'if (length(vViewPosition) < 60.0) room = roomColor(wm, gW, gH, gKind, gSeed, V, T, N);'}
  // curtains / nets just behind the pane (residential)
  if (gKind < 0.5 || gKind > 4.5 || (gKind > 1.5 && gKind < 2.5)) {
    float cs = h1(gSeed * 19.0);
    vec3 cc = mix(vec3(0.92, 0.9, 0.84), vec3(0.62, 0.22, 0.2), step(0.85, h1(gSeed * 23.0)));
    float fold = 0.85 + 0.15 * sin(wm.x * 38.0);
    if (cs > 0.35 && cs < 0.75) {
      float k = mix(0.12, 0.35, h1(gSeed * 29.0)) * gW;
      if (wm.x < k || wm.x > gW - k) room = mix(room, cc * fold * 0.75, 0.92);
    } else if (cs >= 0.75) {
      room = mix(room, cc * fold * 0.7, 0.55);
    }
  }
  totalEmissiveRadiance += room * uInterior * (1.0 - gFrame) * (1.0 - fres);
}`)
      // What a window really reflects below the opposite roofline: the street wall across the avenue
      // (or side street), the promenade trees and the pavement. The reflected ray is intersected with
      // that wall's plane; the sky from the env map is kept above it.
      .replace('#include <lights_fragment_end>', `{
  ${SUN}
  vec3 gN = normalize(vWNrm);
  vec3 gR = reflect(normalize(vWPos - cameraPosition), gN);
  float gOut = max(dot(gR, gN), 0.03); // metres away from the wall per metre of ray
  bool gAve = abs(gN.z) > 0.7;
  float gT = (gAve ? (vWPos.x < ${X_MIN.toFixed(1)} ? 24.0 : 60.0) : 11.0) / gOut;
  vec3 gP = vWPos + gR * gT;
  float amb = dot(radiance, vec3(0.3333)) * 0.5;
  // opposite facade: sunlit if it faces the sun, window grid (faded with distance), shopfronts
  vec3 syn = vec3(0.92, 0.84, 0.72) * (sC * (max(0.0, -dot(sDW, gN)) * 0.75 / PI) + amb);
  float fl = gP.y - 4.9, wy = fract(fl / 3.35);
  float win = step(0.0, fl) * step(0.22, wy) * step(wy, 0.8) * step(abs(fract((gAve ? gP.x : gP.z) / 3.6) - 0.5), 0.19);
  syn *= fl < 0.0 ? 0.5 : mix(1.0, 0.3, win * (1.0 - smoothstep(20.0, 50.0, length(vViewPosition))));
  float gWt = 1.0 - smoothstep(19.0, 23.0, gP.y); // below the opposite roofline
  // promenade tree rows (avenue facades only): canopies ≈ 3–9 m high, 12.5 m from the centre line
  if (gAve && vWPos.x > ${TREE_X.min.toFixed(1)} && vWPos.x < ${TREE_X.max.toFixed(1)} && abs(vWPos.z) > 20.0) {
    float yt = vWPos.y + gR.y * (abs(vWPos.z) - 12.5) / gOut;
    if (yt > 3.2 && yt < 9.0) { syn = vec3(0.05, 0.075, 0.035) * (sC * 0.12 + amb * 1.5); gWt = 1.0; }
  }
  // pavement in front of the wall
  if (gR.y < 0.0 && gP.y < ${CURB.toFixed(2)}) {
    syn = vec3(0.4, 0.37, 0.33) * (sC * (sDW.y * 0.35 / PI) + amb);
    gWt = 1.0;
  }
  radiance = mix(radiance, syn * 1.6, gWt * (1.0 - gFrame));
}
#include <lights_fragment_end>`);
  };
  m.customProgramCacheKey = () => `bld-glass-${low ? 'low' : 'hi'}`;
  return m;
}

function cutout(tex: BuildingTextures, uniforms: SharedUniforms): MeshStandardMaterial {
  const m = new MeshStandardMaterial({
    map: tex.cutout, alphaTest: 0.5, side: DoubleSide, vertexColors: true, roughness: 0.62, metalness: 0.1,
  });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uniforms.uTime;
    sh.uniforms.uWind = uniforms.uWind;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 aExt;
uniform float uTime;
uniform vec3 uWind;
varying vec4 vCut;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vCut = aExt;
if (aExt.x > 0.0) {
  vec3 wp = (modelMatrix * vec4(transformed, 1.0)).xyz;
  float w = length(uWind.xz);
  float s = sin(uTime * (1.3 + w * 0.3) + wp.x * 0.7 + wp.z * 0.5) + 0.5 * sin(uTime * 3.1 + wp.y * 2.0);
  transformed.xz += normalize(uWind.xz + 1e-4) * s * aExt.x * (0.015 + 0.012 * w);
}`);
    // Thin ironwork under minification: a fixed alpha test makes it vanish (or turn into solid
    // squares), dithering shimmers. The alpha threshold drops with the mip level so bars stay
    // continuous; from 28 to 36 m (view distance, so grazing close-ups stay alpha-tested) ironwork
    // turns into an opaque band: the mip-averaged pattern over a per-card proxy of what lies behind
    // it (aExt.yzw: shaded wall, dark glass…), the gaps filling in by coverage (no pop, no dither).
    // Foliage (aExt.x > 0, it sways) stays alpha-tested in its own colour at every distance.
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <lights_fragment_begin>', FACING_SHADOWS)
      .replace('#include <lights_fragment_maps>', CHEAP_IBL) // rough iron and leaves: no env reflection fetch
      .replace('#include <common>', `#include <common>
varying vec4 vCut;`)
      .replace('#include <alphatest_fragment>', `{
  // mip level as picked by 8x anisotropic filtering (major axis / probe count)
  vec2 ts = vMapUv * vec2(1024.0, 2048.0);
  float px = length(dFdx(ts)), py = length(dFdy(ts));
  float pmax = max(px, py), pmin = max(min(px, py), 1e-6);
  float lod = log2(pmax / min(ceil(pmax / pmin), 8.0));
  float a = diffuseColor.a;
  vec3 tc = diffuseColor.rgb / max(a, 0.05); // transparent texels are black: undo the premultiply
  float thr = 0.5 - 0.22 * smoothstep(0.8, 2.6, lod);
  if (vCut.x > 0.0) {
    if (a < thr) discard;
    diffuseColor.rgb = tc;
  } else {
    float far = smoothstep(28.0, 36.0, length(vViewPosition));
    if (a < thr * (1.0 - far)) discard;
    diffuseColor.rgb = mix(tc, mix(vCut.yzw, tc, clamp(a * 1.15, 0.0, 1.0)), far);
  }
}`);
  };
  m.customProgramCacheKey = () => 'bld-cutout';
  return m;
}

function flag(tex: BuildingTextures, uniforms: SharedUniforms): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ map: tex.flag, side: DoubleSide, roughness: 0.8 });
  const wave = `
float fW = aExt.x;
float fWind = length(uWind.xz);
float fAmp = (0.07 + 0.035 * fWind) * fW;
float fPh = uTime * (3.2 + fWind * 0.8) - fW * 7.0 + aExt.y;`;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uniforms.uTime;
    sh.uniforms.uWind = uniforms.uWind;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 aExt;
uniform float uTime;
uniform vec3 uWind;`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
${wave}
vec3 fDir = vec3(aExt.z, 0.0, aExt.w);
objectNormal = normalize(objectNormal - fDir * cos(fPh) * fAmp * 7.0 / 1.4);`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
transformed += normal * sin(fPh) * fAmp;
transformed.y -= fW * fW * 0.08;`);
  };
  m.customProgramCacheKey = () => 'bld-flag';
  return m;
}

export function createMaterials(tex: BuildingTextures, signs: SignAtlas, uniforms: SharedUniforms, quality: Quality): BuildingMaterials {
  const mas = masonry(tex, quality, false);
  const masFar = masonry(tex, quality, true);
  const gl = glass(quality);
  const cut = cutout(tex, uniforms);
  const sg = new MeshStandardMaterial({
    map: signs.map, emissiveMap: signs.emissive, emissive: new Color(1, 1, 1), emissiveIntensity: 0.9, roughness: 0.42, metalness: 0,
  });
  const fl = flag(tex, uniforms);
  // shadow proxy: invisible in the main pass (buildings.ts also skips its draw there)
  const proxy = new MeshBasicMaterial({ colorWrite: false, depthWrite: false });
  const all: Material[] = [mas, masFar, gl, cut, sg, fl, proxy];
  return { masonry: mas, masonryFar: masFar, glass: gl, cutout: cut, signs: sg, flag: fl, proxy, all, dispose: () => all.forEach((m) => m.dispose()) };
}
