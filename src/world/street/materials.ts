// Shared PBR materials of the street. Textures: Poly Haven CC0 sets converted to WebP
// (public/textures/street/<name>_{diff,nor,arm}.webp, credits in docs/credits/street.md).
// All geometry uses metric UVs (1 UV unit = `tile` metres), so one texture instance serves every mesh.
import * as THREE from 'three';
import type { BuildContext } from '../../core/types';
import { Z, TREE_ROWS_Z } from '../../core/layout';
import { Owned, patchMacroVariation } from './common';
import { coversTextures, grateTextures, paintWearTexture } from './canvas';

export interface StreetMaterials {
  asphalt: THREE.MeshStandardMaterial;
  promenade: THREE.MeshStandardMaterial;
  sidewalk: THREE.MeshStandardMaterial;
  plaza: THREE.MeshStandardMaterial;
  /** Granite drawn over paving (curb tops, inlaid bands, gutters): polygon offset wins coplanar. */
  graniteInlay: THREE.MeshStandardMaterial;
  /** Granite for solid blocks (curb faces, planters, quay). */
  granite: THREE.MeshStandardMaterial;
  paint: THREE.MeshStandardMaterial;
  covers: THREE.MeshStandardMaterial;
  grate: THREE.MeshStandardMaterial;
  bark: THREE.MeshStandardMaterial;
  wood: THREE.MeshStandardMaterial;
  /** Painted cast iron (lamp posts, bench frames, bollards, poles). */
  iron: THREE.MeshStandardMaterial;
  galvanized: THREE.MeshStandardMaterial;
  lampGlass: THREE.MeshStandardMaterial;
  /** Vertex-coloured props (flowers, food, small details). */
  vcolor: THREE.MeshStandardMaterial;
  /** Texture metres per UV unit for each tiled material. */
  tile: { asphalt: number; promenade: number; sidewalk: number; plaza: number; granite: number; bark: number; wood: number };
}

export async function loadMaterials(ctx: BuildContext, o: Owned): Promise<StreetMaterials> {
  const set = async (name: string) => {
    const base = `/textures/street/${name}`;
    const [map, normalMap, arm] = await Promise.all([
      ctx.assets.texture(`${base}_diff.webp`, { srgb: true, repeat: [1, 1] }),
      ctx.assets.texture(`${base}_nor.webp`, { repeat: [1, 1] }),
      ctx.assets.texture(`${base}_arm.webp`, { repeat: [1, 1] }),
    ]);
    [map, normalMap, arm].forEach((t) => o.add(t));
    // grazing-angle sharpness matters for colour; normal/ARM detail is lost there anyway
    normalMap.anisotropy = arm.anisotropy = Math.min(4, map.anisotropy);
    return { map, normalMap, roughnessMap: arm, aoMap: arm };
  };
  const [asphaltT, promT, sideT, plazaT, graniteT, barkT, woodT] = await Promise.all(
    ['asphalt', 'promenade', 'sidewalk', 'plaza', 'granite', 'bark', 'wood'].map(set),
  );
  const std = (p: THREE.MeshStandardMaterialParameters) => o.add(new THREE.MeshStandardMaterial(p));

  const asphalt = std({ ...asphaltT, aoMapIntensity: 0.7, normalScale: new THREE.Vector2(1.2, 1.2) });
  // avenue lanes (|z| 14..22): darker oil line down each lane centre, polished tyre tracks
  patchMacroVariation(asphalt, 0.28, 22, 'asphalt', /* glsl */ `
    float stAz = abs(vStWorld.z);
    if (stAz > ${Z.northRoadInner * -1}.0 && stAz < ${Z.southRoadOuter}.0) {
      float stDl = min(abs(stAz - 16.0), abs(stAz - 20.0));
      diffuseColor.rgb *= 1.0 - 0.2 * smoothstep(0.5, 0.0, stDl) * (0.5 + 0.5 * stD);
      diffuseColor.rgb *= 1.0 + 0.07 * smoothstep(0.35, 0.0, abs(stDl - 0.85));
    }`);
  const promenade = std({ ...promT, aoMapIntensity: 0.6 });
  // grime and leaf litter concentrate in the tree zones (|z| ≈ TREE_ROWS_Z)
  patchMacroVariation(promenade, 0.14, 16, 'promenade', /* glsl */ `
    diffuseColor.rgb *= 1.0 - 0.1 * smoothstep(3.2, 0.6, abs(abs(vStWorld.z) - ${Math.abs(TREE_ROWS_Z[0]).toFixed(2)})) * (0.4 + 0.6 * stM);`);
  const sidewalk = std({ ...sideT, aoMapIntensity: 0.6 });
  patchMacroVariation(sidewalk, 0.16, 14, 'sidewalk');
  const plaza = std({ ...plazaT, aoMapIntensity: 0.6 });
  patchMacroVariation(plaza, 0.12, 18, 'plaza');

  // roughness > 1 scales the map up: honed rather than polished granite (no mirror streaks at grazing sun)
  const granite = std({ ...graniteT, aoMapIntensity: 0.5, roughness: 1.7 });
  const graniteInlay = std({ ...graniteT, color: new THREE.Color(1.15, 1.13, 1.1), roughness: 1.7, aoMapIntensity: 0.5, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });

  const wear = o.add(paintWearTexture(ctx.renderer));
  const paint = std({
    color: 0xe9e6dc, roughness: 0.62, alphaMap: wear, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  });

  const cov = coversTextures(ctx.renderer);
  o.add(cov.map);
  o.add(cov.bump);
  const covers = std({
    map: cov.map, bumpMap: cov.bump, bumpScale: 3, roughness: 0.55, metalness: 0.55, alphaTest: 0.5,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6,
  });
  const gr = grateTextures(ctx.renderer);
  o.add(gr.map);
  o.add(gr.bump);
  const grate = std({
    map: gr.map, bumpMap: gr.bump, bumpScale: 4, roughness: 0.6, metalness: 0.5,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6,
  });

  const bark = std({ ...barkT, color: 0xdedad2, normalScale: new THREE.Vector2(1.0, 1.0) });
  const wood = std({ ...woodT, color: 0xd8c2a8, roughness: 0.7 });
  const iron = std({ color: 0x1c2420, roughness: 0.42, metalness: 0.55 });
  const galvanized = std({ color: 0xa9adae, roughness: 0.38, metalness: 0.9 });
  const lampGlass = std({ color: 0xfff4de, emissive: 0xffc27a, emissiveIntensity: 0.9, roughness: 0.15, metalness: 0 });
  const vcolor = std({ vertexColors: true, roughness: 0.65 });

  return {
    asphalt, promenade, sidewalk, plaza, granite, graniteInlay, paint, covers, grate, bark, wood, iron, galvanized, lampGlass, vcolor,
    tile: { asphalt: 4.0, promenade: 3.2, sidewalk: 2.0, plaza: 3.0, granite: 1.15, bark: 1.8, wood: 1.5 },
  };
}
