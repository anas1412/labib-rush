// Municipal recycling bin: green squircle column, stainless collar, a domed lid with a round
// opening (trick shots drop in from above), white recycling symbol + "Recyclage / رسكلة".
// setHighlight shows a soft ground ring + light beam (visible from afar); bump() squashes the
// body and flaps the lid on a hinge at the back.
import {
  AdditiveBlending, BufferGeometry, DoubleSide, Float32BufferAttribute, Group, Mesh, MeshStandardMaterial,
  ShaderMaterial, UniformsLib, UniformsUtils, Vector3, type WebGLRenderer,
} from 'three';
import type { BinModel, Quality, SharedUniforms } from '../core/types';
import { binTexture } from './textures';
import { Trash, WHITE_UV, creasedNormals, lerp, mergeParts, paint, paintFn, texScale, vertexPbr } from './util';

const HALF = 0.29; // squircle half extent (body)
const H_BODY = 0.96, H_COLLAR = 1.0;
const HOLE_R = 0.19;
const OPENING_Y = 1.045;

/** Superellipse (n = 4) point at angle t, scaled to half extent a. Front (+Z) at t = π/2. */
function squircle(t: number, a: number): [number, number] {
  const c = Math.cos(t), s = Math.sin(t);
  return [a * Math.sign(c) * Math.sqrt(Math.abs(c)), a * Math.sign(s) * Math.sqrt(Math.abs(s))];
}

/** Loft of squircle rings: rings = [halfExtent, y, v] bottom → top. u = arc fraction. */
function squircleLoft(rings: [number, number, number][], segs: number, uvMode: 'wrap' | 'white', morphToCircle?: number[]): BufferGeometry {
  const pos: number[] = [], uv: number[] = [];
  // arc-length parametrisation so the print is not stretched at the corners
  const ts: number[] = [];
  const dense = 512;
  const cum = [0];
  let prev = squircle(0, 1);
  for (let i = 1; i <= dense; i++) {
    const p = squircle((i / dense) * Math.PI * 2, 1);
    cum.push(cum[i - 1] + Math.hypot(p[0] - prev[0], p[1] - prev[1]));
    prev = p;
  }
  for (let j = 0; j <= segs; j++) {
    const target = (j / segs) * cum[dense];
    let k = 0;
    while (k < dense && cum[k + 1] < target) k++;
    const f = (target - cum[k]) / Math.max(1e-9, cum[k + 1] - cum[k]);
    ts.push(((k + f) / dense) * Math.PI * 2);
  }
  const P = (r: number, j: number) => {
    const [a, y] = rings[r];
    let [x, z] = squircle(ts[j], a);
    const m = morphToCircle?.[r] ?? 0;
    if (m > 0) {
      x = lerp(x, a * Math.cos(ts[j]), m);
      z = lerp(z, a * Math.sin(ts[j]), m);
    }
    return [x, y, z];
  };
  for (let r = 0; r < rings.length - 1; r++) {
    for (let j = 0; j < segs; j++) {
      const a = P(r, j), b = P(r, j + 1), c = P(r + 1, j + 1), d = P(r + 1, j);
      // outward winding (t increases counter-clockwise seen from above → x toward z)
      pos.push(...a, ...d, ...c, ...a, ...c, ...b);
      // u runs clockwise seen from above so the print reads left-to-right from outside
      const u0 = 1 - j / segs, u1 = 1 - (j + 1) / segs, v0 = rings[r][2], v1 = rings[r + 1][2];
      if (uvMode === 'wrap') uv.push(u0, v0, u0, v1, u1, v1, u0, v0, u1, v1, u1, v0);
      else for (let k = 0; k < 6; k++) uv.push(WHITE_UV, 1 - WHITE_UV);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  const n = creasedNormals(g, 40);
  if (n !== g) g.dispose();
  return n;
}

const MARKER_VERT = /* glsl */ `
attribute float kind;
varying vec3 vPos;
varying float vKind;
varying vec3 vN;
varying vec3 vView;
varying float vDist;
void main() {
  vPos = position; vKind = kind;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vView = normalize(-mv.xyz);
  vDist = length(mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

const MARKER_FRAG = /* glsl */ `
uniform float uTime;
uniform float uAlpha;
uniform vec3 uColor;
varying vec3 vPos;
varying float vKind;
varying vec3 vN;
varying vec3 vView;
varying float vDist;
#ifdef USE_FOG
uniform float fogDensity;
uniform float fogNear;
uniform float fogFar;
#endif
void main() {
  float a;
  if (vKind < 0.5) {
    // ground ring: soft band + a ripple expanding outward
    float r = length(vPos.xz);
    float band = smoothstep(0.36, 0.5, r) * (1.0 - smoothstep(0.62, 0.95, r));
    float w = fract(uTime * 0.6);
    float ripple = exp(-pow((r - mix(0.4, 1.15, w)) * 9.0, 2.0)) * (1.0 - w);
    a = band * 0.55 + ripple * 0.7;
    a *= 1.0 - smoothstep(0.95, 1.2, r);
  } else {
    // beam: fades with height, soft at the silhouette edges, gentle shimmer
    float h = vPos.y;
    float edge = pow(abs(dot(normalize(vN), vView)), 1.5);
    a = pow(edge, 1.4) * (1.0 - smoothstep(1.2, 5.5, h)) * smoothstep(1.05, 1.6, h) * 0.26;
    a *= 0.8 + 0.2 * sin(h * 6.0 - uTime * 4.0);
  }
#ifdef USE_FOG
  // additive glow fades into the haze like everything around it (fog would otherwise ADD colour)
  #ifdef FOG_EXP2
    a *= exp(-fogDensity * vDist);
  #else
    a *= 1.0 - smoothstep(fogNear, fogFar, vDist);
  #endif
#endif
  gl_FragColor = vec4(uColor * a * uAlpha, 1.0);
}`;

function markerGeometry(): BufferGeometry {
  const pos: number[] = [], nor: number[] = [], kind: number[] = [];
  const S = 48;
  // ground ring (flat annulus)
  for (let i = 0; i < S; i++) {
    const a0 = (i / S) * Math.PI * 2, a1 = ((i + 1) / S) * Math.PI * 2;
    const r0 = 0.3, r1 = 1.2, y = 0.025;
    const p = (r: number, a: number) => [Math.cos(a) * r, y, Math.sin(a) * r];
    const quad = [p(r0, a0), p(r1, a1), p(r1, a0), p(r0, a0), p(r0, a1), p(r1, a1)];
    quad.forEach((q) => { pos.push(...q); nor.push(0, 1, 0); kind.push(0); });
  }
  // beam (open cylinder)
  const R = 0.36, y0 = 1.05, y1 = 6.2;
  for (let i = 0; i < S; i++) {
    const a0 = (i / S) * Math.PI * 2, a1 = ((i + 1) / S) * Math.PI * 2;
    const p = (a: number, y: number) => [Math.cos(a) * R, y, Math.sin(a) * R];
    const n = (a: number) => [Math.cos(a), 0, Math.sin(a)];
    const quad: [number[], number[]][] = [[p(a0, y0), n(a0)], [p(a0, y1), n(a0)], [p(a1, y1), n(a1)], [p(a0, y0), n(a0)], [p(a1, y1), n(a1)], [p(a1, y0), n(a1)]];
    quad.forEach(([q, m]) => { pos.push(...q); nor.push(...m); kind.push(1); });
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new Float32BufferAttribute(nor, 3));
  g.setAttribute('kind', new Float32BufferAttribute(kind, 1));
  g.computeBoundingSphere();
  return g;
}

export interface BinLib { make(): BinModel }

export function createBins(renderer: WebGLRenderer, quality: Quality, uniforms: SharedUniforms, trash: Trash): BinLib {
  const segs = quality === 'low' ? 32 : 64;
  const tex = trash.add(binTexture(renderer, texScale(quality)));
  const mat = trash.add(vertexPbr(new MeshStandardMaterial({ map: tex }), 'bin'));

  // --- body (static part): plinth, printed column, stainless collar, deck, throat, bag
  const vb = (y: number) => (y - 0.07) / (H_BODY - 0.07);
  const plinth = paint(squircleLoft([[HALF - 0.025, 0, 0], [HALF - 0.022, 0.06, 0], [HALF - 0.005, 0.07, 0]], segs, 'white'), { color: 0x2c2f31, rough: 0.8 });
  const column = paintFn(squircleLoft([[HALF - 0.005, 0.07, vb(0.07)], [HALF, 0.085, vb(0.085)], [HALF + 0.004, 0.5, vb(0.5)], [HALF + 0.008, H_BODY, vb(H_BODY)]], segs, 'wrap'),
    (_i, _p, l) => { l.r = 0.55; l.m = 0.15; }, true);
  const collar = paint(squircleLoft([[HALF + 0.008, H_BODY, 0], [HALF + 0.012, H_BODY + 0.004, 0], [HALF + 0.012, H_COLLAR - 0.004, 0], [HALF + 0.006, H_COLLAR, 0]], segs, 'white'),
    { color: 0xc4c8cc, rough: 0.28, metal: 1 });
  // deck under the lid: squircle → circle toward the throat, then down into the bin
  const deck = paint(squircleLoft([[HALF + 0.006, H_COLLAR, 0], [HOLE_R + 0.02, H_COLLAR - 0.005, 0], [HOLE_R, H_COLLAR - 0.02, 0], [HOLE_R - 0.002, 0.74, 0]], segs, 'white', [0, 1, 1, 1]),
    { color: 0x151816, rough: 0.9 });
  // black liner bag gathered at the bottom of the throat
  const bag = paintFn(squircleLoft([[HOLE_R - 0.002, 0.74, 0], [0.12, 0.735, 0], [0.0, 0.73, 0]], segs, 'white', [1, 1, 1]),
    (_i, p, l) => { l.c.setRGB(0.02, 0.022, 0.024); l.r = 0.35 + 0.2 * Math.sin(p.x * 60) * Math.sin(p.z * 50); });
  const bodyGeo = trash.add(mergeParts([plinth, column, collar, deck, bag]));

  // --- lid (animated): domed ring, hinge at the back (−Z). Origin at the hinge.
  const lidRings: [number, number, number][] = [
    [HALF + 0.016, H_COLLAR - 0.006, 0], [HALF + 0.018, H_COLLAR + 0.012, 0], [HALF + 0.004, H_COLLAR + 0.04, 0],
    [0.24, H_COLLAR + 0.066, 0], [HOLE_R + 0.028, H_COLLAR + 0.07, 0], [HOLE_R + 0.008, OPENING_Y + 0.012, 0],
    [HOLE_R, OPENING_Y, 0], [HOLE_R - 0.004, OPENING_Y - 0.02, 0],
  ];
  const lidMorph = [0, 0, 0.15, 0.55, 0.9, 1, 1, 1];
  const lid = paintFn(squircleLoft(lidRings, segs, 'white', lidMorph), (_i, p, l) => {
    const r = Math.hypot(p.x, p.z);
    const rim = r < HOLE_R + 0.012;
    l.c.set(rim ? 0x101211 : 0x1a6a38);
    l.r = rim ? 0.6 : 0.42;
    l.m = 0;
  });
  const hinge = new Vector3(0, H_COLLAR, -(HALF + 0.016));
  lid.translate(-hinge.x, -hinge.y, -hinge.z);
  const lidGeo = trash.add(lid);

  const markerGeo = trash.add(markerGeometry());
  // one material for every bin: each marker writes its own fade into uAlpha just before it draws
  // (ShaderMaterial + uniformsNeedUpdate re-uploads per object), so bins allocate nothing
  const markerUniforms = UniformsUtils.merge([UniformsLib.fog, { uAlpha: { value: 0 }, uColor: { value: new Vector3(0.45, 1.0, 0.55) } }]);
  markerUniforms.uTime = uniforms.uTime; // shared by reference (merge clones)
  const markerMat = trash.add(new ShaderMaterial({
    vertexShader: MARKER_VERT,
    fragmentShader: MARKER_FRAG,
    uniforms: markerUniforms,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
    fog: true,
  }));

  return {
    make() {
      const root = new Group();
      root.name = 'recycling-bin';
      const visual = new Group();
      const body = new Mesh(bodyGeo, mat);
      body.castShadow = body.receiveShadow = true;
      const lidPivot = new Group();
      lidPivot.position.copy(hinge);
      const lidMesh = new Mesh(lidGeo, mat);
      lidMesh.castShadow = lidMesh.receiveShadow = true;
      lidPivot.add(lidMesh);
      visual.add(body, lidPivot);
      const marker = new Mesh(markerGeo, markerMat);
      marker.visible = false;
      marker.renderOrder = 2;
      marker.onBeforeRender = () => {
        markerMat.uniforms.uAlpha.value = alpha;
        markerMat.uniformsNeedUpdate = true;
      };
      root.add(visual, marker);

      let target = 0, alpha = 0;
      let sq = 0, sqV = 0, lidA = 0, lidV = 0;
      return {
        root,
        openingHeight: OPENING_Y,
        openingRadius: HOLE_R,
        half: { x: HALF + 0.02, z: HALF + 0.02 },
        height: H_COLLAR + 0.07,
        setHighlight(on) { target = on ? 1 : 0; },
        bump() { sqV += 3.2; lidV -= 9; },
        update(dt) {
          const d = Math.min(dt, 1 / 20);
          // damped springs: squash (≈ 5 Hz) and lid flap (≈ 3 Hz, can't close past shut)
          sqV += (-260 * sq - 14 * sqV) * d; sq += sqV * d;
          lidV += (-360 * lidA - 10 * lidV) * d; lidA += lidV * d;
          if (lidA > 0) { lidA = 0; lidV *= -0.35; }
          visual.scale.set(1 + sq * 0.5, 1 - sq, 1 + sq * 0.5);
          lidPivot.rotation.x = lidA;
          alpha += (target - alpha) * Math.min(1, d * 6);
          marker.visible = alpha > 0.01;
        },
      };
    },
  };
}
