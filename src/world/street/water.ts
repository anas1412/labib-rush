// Lake of Tunis beyond LAKE_X: animated reflective water (PMREM sky reflections through a
// scrolling two-octave ripple normal map), the far shore and the Boukornine hills as hazy
// silhouettes, and the iron railing along the quay.
import * as THREE from 'three';
import type { BuildContext } from '../../core/types';
import { LAKE_X } from '../../core/layout';
import { Owned, StaticBatch, bake, makeRng, range, xf, type Place } from './common';
import { waterNormalTexture } from './canvas';
import type { StreetMaterials } from './materials';
import { QUAY_X, WATER_Y } from './ground';

export interface LakeResult {
  meshes: THREE.Object3D[];
}

/** A silhouette band along Z at distance x (vertex coloured, own haze instead of scene fog). */
function ridge(x: number, depth: number, zHalf: number, height: (z: number) => number, base: THREE.Color, top: THREE.Color): THREE.BufferGeometry {
  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  const n = 240;
  for (let i = 0; i <= n; i++) {
    const z = -zHalf + (i / n) * zHalf * 2;
    const h = height(z);
    pos.push(x, WATER_Y - 1, z, x + depth, h, z);
    const t = top.clone().lerp(base, THREE.MathUtils.clamp(1 - h / 260, 0, 0.6));
    col.push(base.r, base.g, base.b, t.r, t.g, t.b);
    if (i < n) {
      const a = i * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

export function buildLake(ctx: BuildContext, o: Owned, M: StreetMaterials, batch: StaticBatch): LakeResult {
  const nrm = o.add(waterNormalTexture());
  nrm.repeat.set(260, 260);
  const size = 5200;
  const water = o.add(new THREE.MeshStandardMaterial({
    color: 0x14343c, roughness: 0.07, metalness: 0, normalMap: nrm, normalScale: new THREE.Vector2(0.45, 0.45), envMapIntensity: 1.1,
  }));
  water.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = ctx.uniforms.uTime;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace('#include <normal_fragment_maps>', /* glsl */ `
      #ifdef USE_NORMALMAP_TANGENTSPACE
        vec3 stN1 = texture2D(normalMap, vNormalMapUv + vec2(uTime * 0.0021, uTime * 0.0013)).xyz * 2.0 - 1.0;
        vec3 stN2 = texture2D(normalMap, vNormalMapUv * 2.7 + vec2(-uTime * 0.0034, uTime * 0.0027)).xyz * 2.0 - 1.0;
        vec3 mapN = normalize(vec3(stN1.xy + stN2.xy * 0.6, stN1.z * stN2.z));
        mapN.xy *= normalScale;
        normal = normalize(tbn * mapN);
      #endif`);
  };
  water.customProgramCacheKey = () => 'st-lake';
  const lake = new THREE.Mesh(o.add(new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2)), water);
  lake.position.set(LAKE_X - 4 + size / 2, WATER_Y, 0);
  lake.name = 'street-lake';

  // far shore (La Goulette / Radès) and the twin-peaked Boukornine beyond, in golden-hour haze
  const r = makeRng(606);
  const bumps = Array.from({ length: 40 }, () => [range(r, -2400, 2400), range(r, 60, 260), range(r, 20, 70)] as const);
  const hills = (z: number) => {
    let h = 40 + 25 * Math.sin(z * 0.0021) + 18 * Math.sin(z * 0.0057 + 1.3);
    for (const [c, w, a] of bumps) h += a * Math.exp(-(((z - c) / w) ** 2));
    // Boukornine: two peaks south-east across the water
    h += 230 * Math.exp(-(((z - 760) / 260) ** 2)) + 190 * Math.exp(-(((z - 1180) / 210) ** 2));
    return h;
  };
  const shore = (z: number) => 6 + 3 * Math.sin(z * 0.013) + 2.5 * Math.sin(z * 0.041 + 2) + (Math.abs(z) < 1400 ? 4 : 0);
  // Silhouettes sit beyond the fog range: instead of vanishing into flat fog they take a fixed
  // share of the scene's fog colour, so they always read as hazy shapes that match the sky.
  // Depth-independent: the ridges lie beyond the game camera's far plane (1.4 km), so their depth
  // is pinned just in front of it (drawn behind everything else, never clipped, never culled).
  const sil = o.add(new THREE.MeshBasicMaterial({ vertexColors: true }));
  sil.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\ngl_Position.z = gl_Position.w * 0.9999999;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <fog_fragment>', '#ifdef USE_FOG\n gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, 0.3);\n#endif');
  };
  sil.customProgramCacheKey = () => 'st-silhouette';
  const far = new THREE.Mesh(o.add(ridge(1500, 180, 2600, (z) => hills(z) * 0.45, new THREE.Color(0xb7aeb4), new THREE.Color(0x8e8d9e))), sil);
  const near = new THREE.Mesh(o.add(ridge(1150, 40, 2400, shore, new THREE.Color(0xc0b2aa), new THREE.Color(0xa99f9f))), sil);
  far.name = 'street-hills';
  near.name = 'street-far-shore';
  far.frustumCulled = near.frustumCulled = false;

  // quay railing: posts + two rails, instanced in 10 m sections
  const post = new THREE.CylinderGeometry(0.035, 0.045, 1.0, 6, 1, true).translate(0, 0.5, 0);
  const cap = new THREE.SphereGeometry(0.06, 6, 4).translate(0, 1.02, 0);
  const rails = [0.95, 0.5].map((y) => xf(new THREE.CylinderGeometry(0.025, 0.025, 2.5, 5, 1, true), { p: [0, y, 1.25], r: [Math.PI / 2, 0, 0] }));
  const section = bake([post, cap, ...rails]);
  const places: Place[] = [];
  for (let z = -260; z < 260 - 1; z += 2.5) places.push({ x: QUAY_X - 0.3, y: 0.15, z }); // the quay's full length
  batch.place(section, M.iron, places, 'street-iron', true);
  section.dispose();

  // the water animates in its shader from the shared uTime uniform: nothing to update per frame
  return { meshes: [lake, far, near] };
}
