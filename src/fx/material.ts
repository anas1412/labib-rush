// Particle shader: all motion is evaluated on the GPU from per-particle spawn data, so the CPU only
// writes a particle once (at burst time) and advances one time uniform per frame.
//
// Per-instance layout (8 × vec4, interleaved):
//   aA  p0.xyz, birth time            aB  v0.xyz (swirl: angle0, vy, –), life
//   aC  size0, size1, rot0, spin      aD  colour0 rgb (linear, may be HDR), alpha0
//   aE  colour1 rgb, alpha1           aF  drag k, gravity g, wind factor, mode (= motion + 4·orient)
//   aG  axis.xyz (swirl: r0, ω, r1), groundY
//   aH  sway amplitude, sway rate, param (twinkle rate | streak length | foil glint), shape cell
//
// motion 0: drag physics  p = p0 + (v0 − a/k)(1 − e^(−kt))/k + a·t/k,  a = gravity + k·wind·windFactor
//           with flutter sway, and ground landing (bisection for the touchdown time, then rest)
// motion 1: swirl around p0 (radius r0 → r1, angular speed ω, vertical speed vy, gravity g)
// orient  0 camera billboard (spin) · 1 streak along velocity/axis · 2 flat on the ground · 3 tumbling 3D
import { AdditiveBlending, DoubleSide, NormalBlending, ShaderMaterial, Vector3, type IUniform, type Texture } from 'three';
import { ATLAS_COLS, ATLAS_ROWS } from './atlas';

const vertex = /* glsl */ `
uniform float uTime;
uniform vec3 uWind;
attribute vec4 aA;
attribute vec4 aB;
attribute vec4 aC;
attribute vec4 aD;
attribute vec4 aE;
attribute vec4 aF;
attribute vec4 aG;
attribute vec4 aH;
varying vec2 vUv;
varying vec4 vColor;
varying float vShape;
varying vec3 vNormal;
varying vec3 vWorld;
varying float vGround;
varying float vParam;
varying float vSize;

vec3 dragPos(vec3 p0, vec3 v0, vec3 a, float k, float t) {
  if (k < 1e-3) return p0 + v0 * t + 0.5 * a * t * t;
  return p0 + (v0 - a / k) * (1.0 - exp(-k * t)) / k + a * t / k;
}
vec3 dragVel(vec3 v0, vec3 a, float k, float t) {
  if (k < 1e-3) return v0 + a * t;
  return a / k + (v0 - a / k) * exp(-k * t);
}
vec3 rotAxis(vec3 v, vec3 k, float ang) {
  float c = cos(ang), s = sin(ang);
  return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c);
}

void main() {
  float age = uTime - aA.w;
  float life = aB.w;
  if (age < 0.0 || age >= life) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; } // dead: outside the clip volume
  float t01 = age / life;
  float orient = floor(aF.w / 4.0 + 0.01);
  float motion = aF.w - orient * 4.0;
  float k = aF.x;
  vec3 acc = vec3(0.0, -aF.y, 0.0) + k * aF.z * vec3(uWind.x, 0.0, uWind.z);

  vec3 p, vel;
  bool landed = false;
  if (motion < 0.5) {
    float tEval = age;
    p = dragPos(aA.xyz, aB.xyz, acc, k, age);
    if (p.y < aG.w) {
      // y(t) rises then falls once, so [0, age] brackets the single touchdown
      float lo = 0.0, hi = age;
      for (int i = 0; i < 10; i++) {
        float m = 0.5 * (lo + hi);
        if (dragPos(aA.xyz, aB.xyz, acc, k, m).y > aG.w) lo = m; else hi = m;
      }
      tEval = hi;
      landed = true;
      p = dragPos(aA.xyz, aB.xyz, acc, k, hi);
    }
    vel = landed ? vec3(0.0) : dragVel(aB.xyz, acc, k, age);
    if (aH.x > 0.0) {
      float ph = aC.z;
      p += aH.x * min(tEval * 2.0, 1.0) * vec3(sin(aH.y * tEval + ph), 0.0, cos(aH.y * 0.77 * tEval + ph * 1.3));
    }
    if (landed) p.y = aG.w + 0.004;
  } else {
    float ang = aB.x + aG.y * age;
    float e = t01 * t01 * (3.0 - 2.0 * t01);
    float r = mix(aG.x, aG.z, e);
    p = aA.xyz + vec3(cos(ang) * r, aB.y * age - 0.5 * aF.y * age * age, sin(ang) * r);
    vel = vec3(-sin(ang), 0.0, cos(ang)) * r * aG.y + vec3(0.0, aB.y - aF.y * age, 0.0);
  }

  float size = mix(aC.x, aC.y, t01);
  vec4 col = mix(aD, aE, t01);
  float param = aH.z;
  if (orient > 2.5) {
    size *= 1.0 - smoothstep(0.82, 1.0, t01); // cut-out pieces shrink away instead of fading
  } else {
    col.a *= smoothstep(0.0, 0.05, t01) * (1.0 - smoothstep(0.72, 1.0, t01));
    if (orient != 1.0 && param > 0.0) { // twinkle
      float tw = 0.5 + 0.5 * sin(age * param + aC.z * 7.0);
      col.rgb *= 0.35 + 0.65 * tw;
      size *= 0.8 + 0.2 * tw;
    }
  }

  vec2 c = position.xy;
  float ang = aC.z + aC.w * age;
  vec2 rc = vec2(c.x * cos(ang) - c.y * sin(ang), c.x * sin(ang) + c.y * cos(ang));
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 toCam = normalize(cameraPosition - p);
  vec3 wp;
  vec3 n = toCam;
  if (orient < 0.5) {
    wp = p + (camRight * rc.x + camUp * rc.y) * size;
  } else if (orient < 1.5) {
    vec3 ax = length(vel) > 0.05 ? normalize(vel) : normalize(aG.xyz);
    vec3 side = cross(ax, toCam);
    side = length(side) > 1e-4 ? normalize(side) : camRight;
    wp = p + ax * c.y * param + side * c.x * size;
  } else if (orient < 2.5) {
    wp = p + vec3(rc.x, 0.0, rc.y) * size;
    n = vec3(0.0, 1.0, 0.0);
  } else {
    vec3 u, v;
    if (landed) {
      u = vec3(cos(aC.z), 0.0, sin(aC.z));
      v = vec3(-sin(aC.z), 0.0, cos(aC.z));
      n = vec3(0.0, 1.0, 0.0);
    } else {
      vec3 axis = normalize(aG.xyz);
      u = rotAxis(vec3(1.0, 0.0, 0.0), axis, ang);
      v = rotAxis(vec3(0.0, 1.0, 0.0), axis, ang);
      n = cross(u, v);
    }
    wp = p + (u * c.x + v * c.y) * size;
  }

  vUv = c + 0.5;
  vColor = col;
  vShape = aH.w;
  vNormal = n;
  vWorld = wp;
  vGround = aG.w;
  vParam = param;
  vSize = size;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const fragment = /* glsl */ `
uniform sampler2D uAtlas;
uniform vec3 uSunDir;
uniform vec3 uSun;
uniform vec3 uSky;
varying vec2 vUv;
varying vec4 vColor;
varying float vShape;
varying vec3 vNormal;
varying vec3 vWorld;
varying float vGround;
varying float vParam;
varying float vSize;

void main() {
  vec2 cell = vec2(mod(vShape, ${ATLAS_COLS}.0), floor(vShape / ${ATLAS_COLS}.0 + 0.01));
  vec4 tex = texture2D(uAtlas, (cell + clamp(vUv, 0.0, 1.0)) / vec2(${ATLAS_COLS}.0, ${ATLAS_ROWS}.0));
  float a = tex.a * vColor.a;
  vec3 col = vColor.rgb * tex.rgb;
#ifdef LIT
  vec3 V = normalize(cameraPosition - vWorld);
  #ifdef SOLID
    vec3 n = normalize(vNormal);
    if (dot(n, V) < 0.0) n = -n; // two-sided
    float ndl = dot(n, uSunDir);
    float diff = max(ndl, 0.0) + 0.3 * max(-ndl, 0.0); // thin paper / leaf lets some sun through
    float spec = pow(max(dot(n, normalize(uSunDir + V)), 0.0), 48.0) * vParam; // foil glint
    col = col * (uSky + uSun * diff) + uSun * spec;
  #else
    col = col * (uSky + uSun * 0.6);
  #endif
#endif
#ifndef SOLID
  // soft contact where a blended sprite meets the ground, instead of a hard depth-test edge
  if (vGround > -1000.0) a *= smoothstep(vGround, vGround + 0.35 * vSize + 0.02, vWorld.y);
#endif
#ifdef SOLID
  if (a < 0.5) discard;
  a = 1.0;
#endif
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export type PoolKind = 'glow' | 'soft' | 'solid';

export interface ParticleUniforms {
  [name: string]: IUniform;
  uTime: { value: number };
  uWind: { value: Vector3 };
  uAtlas: { value: Texture };
  uSunDir: { value: Vector3 };
  uSun: { value: Vector3 };
  uSky: { value: Vector3 };
}

/** glow: additive, unlit, HDR (feeds bloom) · soft: alpha-blended lit puffs · solid: lit cut-outs (depth-writing). */
export function createParticleMaterial(kind: PoolKind, uniforms: ParticleUniforms): ShaderMaterial {
  const m = new ShaderMaterial({
    uniforms,
    vertexShader: vertex,
    fragmentShader: fragment,
    defines: kind === 'glow' ? {} : kind === 'soft' ? { LIT: '' } : { LIT: '', SOLID: '' },
    transparent: kind !== 'solid',
    depthWrite: kind === 'solid',
    blending: kind === 'glow' ? AdditiveBlending : NormalBlending,
    side: DoubleSide,
  });
  m.forceSinglePass = true;
  return m;
}
