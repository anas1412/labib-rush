// Street module: everything at street level except building facades and landmarks.
// Ground + colliders for the whole playable map, ficus rows, street furniture, kiosks, café
// terraces, map closures and the Lake of Tunis. Sub-builders live in ./street/.
import * as THREE from 'three';
import type { BuildContext, SpawnAnchors, StreetResult } from '../core/types';
import { BINS, KIOSKS, LANES, ROAD_X } from '../core/layout';
import { loadFonts } from '../core/fonts';
import { Owned, Space, StaticBatch } from './street/common';
import { loadMaterials } from './street/materials';
import { buildGround, ISLANDS, CROSSINGS_NORTH, CROSSINGS_SOUTH, CROSSING_HALF } from './street/ground';
import { buildTrees } from './street/trees';
import { buildKiosks } from './street/kiosks';
import { buildCafes } from './street/cafes';
import { buildFurniture } from './street/furniture';
import { buildLake } from './street/water';

export async function buildStreet(ctx: BuildContext): Promise<StreetResult> {
  const o = new Owned(ctx);
  const root = new THREE.Group();
  root.name = 'street';
  const [M] = await Promise.all([loadMaterials(ctx, o), loadFonts()]);

  // Reserved space: bins (1.5 m clear), traffic lanes, landmark islands, crossing paths.
  const space = new Space();
  for (const b of BINS) space.circle(b.x, b.z, 1.5);
  for (const l of LANES) space.rect(ROAD_X.min - 30, ROAD_X.max + 30, l.z - 2, l.z + 2);
  for (const i of ISLANDS) space.circle(i.x, i.z, i.r + 0.6);
  for (const x of CROSSINGS_NORTH) space.rect(x - CROSSING_HALF - 0.3, x + CROSSING_HALF + 0.3, -14.5, -6.5);
  for (const x of CROSSINGS_SOUTH) space.rect(x - CROSSING_HALF - 0.3, x + CROSSING_HALF + 0.3, 6.5, 14.5);
  // crossing landings on the sidewalks
  for (const x of CROSSINGS_NORTH) space.rect(x - CROSSING_HALF - 0.3, x + CROSSING_HALF + 0.3, -23.8, -22);
  for (const x of CROSSINGS_SOUTH) space.rect(x - CROSSING_HALF - 0.3, x + CROSSING_HALF + 0.3, 22, 23.8);
  for (const k of KIOSKS) space.rect(k.x - 3.4, k.x + 3.4, k.z - 2.3, k.z + 2.3); // body, stand, crates

  const anchors: SpawnAnchors = { benches: [], cafeTables: [], kioskRoofs: [], planters: [], roadEdges: [], cafeChairs: [] };
  const batch = new StaticBatch(); // static props, merged per material per chunk at the end

  const ground = buildGround(ctx, o, M);
  root.add(...ground.meshes);
  anchors.roadEdges.push(...ground.roadEdges);

  const trees = buildTrees(ctx, o, M, space);
  root.add(...trees.meshes);

  const kiosks = buildKiosks(ctx, o, M, batch);
  root.add(...kiosks.meshes);
  anchors.kioskRoofs.push(...kiosks.roofs);

  const cafes = buildCafes(ctx, o, space, batch, trees.foliage);
  root.add(...cafes.meshes);
  anchors.cafeTables.push(...cafes.tables);
  anchors.cafeChairs.push(...cafes.chairs);

  const furniture = buildFurniture(ctx, o, M, space, batch, trees.positions, trees.foliage);
  root.add(...furniture.meshes);
  anchors.benches.push(...furniture.benches);
  anchors.planters.push(...furniture.planters);

  const lake = buildLake(ctx, o, M, batch);
  root.add(...lake.meshes);
  root.add(...batch.build(o));

  root.traverse((c) => {
    c.matrixAutoUpdate = false;
    c.updateMatrix();
  });
  root.updateMatrixWorld(true);

  // Water ripples, flags and foliage animate in their shaders from ctx.uniforms (uTime/uWind).
  // Per frame only the tree LOD follows the camera (a re-sort every few metres of travel).
  return {
    root,
    anchors,
    update(_dt, _time, cameraPosition) {
      trees.update(cameraPosition);
    },
    dispose() {
      root.removeFromParent();
      o.dispose();
    },
  };
}
