// Cloth flags on poles: canvas-painted French tricolour / Tunisian flag, waving in the shared wind
// (uTime / uWind) with a vertex shader; the flag turns to stream downwind.
import { DoubleSide, Group, Mesh, MeshStandardMaterial, PlaneGeometry, Vector3, type BufferGeometry } from 'three';
import type { SharedUniforms } from '../../core/types';
import { canvasTexture } from './materials';
import { cyl, lathe, mergeAll } from './kit';

export type FlagKind = 'fr' | 'tn';

function paint(kind: FlagKind): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 384; c.height = 256;
  const g = c.getContext('2d')!;
  const W = c.width, H = c.height;
  if (kind === 'fr') {
    g.fillStyle = '#1d3a8a'; g.fillRect(0, 0, W / 3, H);
    g.fillStyle = '#f4f4f0'; g.fillRect(W / 3, 0, W / 3, H);
    g.fillStyle = '#d1202f'; g.fillRect((2 * W) / 3, 0, W / 3 + 1, H);
  } else {
    // Tunisia: red field, white disc (1/2 of the height), red crescent and five-pointed star.
    g.fillStyle = '#e70013'; g.fillRect(0, 0, W, H);
    const cx = W / 2, cy = H / 2, r = H / 4;
    g.fillStyle = '#fff'; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#e70013'; g.beginPath(); g.arc(cx, cy, r * 0.75, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#fff'; g.beginPath(); g.arc(cx + r * 0.2, cy, r * 0.6, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#e70013'; g.beginPath();
    const sx = cx + r * 0.17, sr = r * 0.44;
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const rr = i % 2 ? sr * 0.382 : sr;
      g.lineTo(sx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
    }
    g.closePath(); g.fill();
  }
  return c;
}

export interface Flag {
  root: Group;
  update(dt: number): void;
  dispose(): void;
}

/** Flag pole (+ ball finial) geometry, base on the origin, for the caller's merge bucket. */
export function flagPole(h: number): BufferGeometry {
  return mergeAll([cyl(0.045, 0.07, h, 8), lathe([[0.09, 0], [0.1, 0.06], [0.06, 0.14], [0, 0.16]], 10).translate(0, h, 0)]);
}

/**
 * Waving cloth w (along the fly) × h whose hoist edge hangs from the top of a pole of height
 * `pole` standing at the group origin (the pole itself comes from `flagPole`). Place the group
 * unrotated in world space so it can turn downwind.
 */
export function createFlag(kind: FlagKind, w: number, h: number, pole: number, uniforms: SharedUniforms): Flag {
  const tex = canvasTexture(paint(kind));
  const mat = new MeshStandardMaterial({ name: `flag-${kind}`, map: tex, side: DoubleSide, roughness: 0.8 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uWind = uniforms.uWind;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform vec3 uWind;')
      .replace('#include <begin_vertex>', /* glsl */ `#include <begin_vertex>
        {
          float s = uv.x; // 0 at the hoist → 1 at the fly
          float wind = clamp(length(uWind.xz), 0.4, 8.0);
          float ph = s * 7.0 - uTime * (3.0 + wind * 0.9);
          float amp = (0.05 + 0.03 * wind) * ${w.toFixed(2)} * s;
          transformed.z += sin(ph) * amp + sin(ph * 2.3 + uv.y * 3.0) * amp * 0.35;
          transformed.y -= s * s * ${(h * 0.12).toFixed(3)} / (0.6 + wind * 0.3);
          transformed.x -= (1.0 - cos(sin(ph) * 0.5)) * ${w.toFixed(2)} * 0.15 * s;
        }`)
      .replace('#include <beginnormal_vertex>', /* glsl */ `#include <beginnormal_vertex>
        {
          float wind = clamp(length(uWind.xz), 0.4, 8.0);
          float ph = uv.x * 7.0 - uTime * (3.0 + wind * 0.9);
          objectNormal = normalize(vec3(-cos(ph) * 0.9 * uv.x, 0.0, 1.0));
        }`);
  };
  mat.customProgramCacheKey = () => `lm-flag-${w}-${h}`;
  const geo = new PlaneGeometry(w, h, 28, 10).translate(w / 2 + 0.06, pole - h / 2 - 0.25, 0);
  const cloth = new Mesh(geo, mat);
  cloth.name = `flag-${kind}`;
  // no shadow: the default depth pass would cast the flat, un-waved rectangle
  cloth.castShadow = false;
  const root = new Group();
  root.add(cloth);
  const dir = new Vector3();
  let yaw = 0;
  return {
    root,
    update(dt) {
      dir.copy(uniforms.uWind.value);
      if (dir.x * dir.x + dir.z * dir.z < 1e-4) return;
      // local +X (the fly) streams downwind
      let d = Math.atan2(-dir.z, dir.x) - yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      yaw += d * Math.min(1, dt * 1.5);
      cloth.rotation.y = yaw;
    },
    dispose() {
      geo.dispose(); tex.dispose(); mat.dispose();
    },
  };
}
