// Landmarks of Avenue Habib Bourguiba (west → east): Porte de France (backdrop), St Vincent de
// Paul Cathedral, French Embassy, Ibn Khaldoun statue, Théâtre Municipal, Le Colisée, the
// equestrian Bourguiba statue and the Clock Tower. One file per landmark in ./landmarks/.
// Geometry is merged per material per landmark (each landmark is spatially compact, so frustum
// culling still works); colliders are G.STATIC (fences G.LOW_PROP). Fine ornament and the two
// bronze statues switch detail with camera distance through THREE.LOD (renderer-driven).
import { Group, Mesh } from 'three';
import type { BuildContext, WorldPart } from '../core/types';
import { loadFonts } from '../core/fonts';
import { createMaterials } from './landmarks/materials';
import { Env, SignAtlas, type Landmark } from './landmarks/env';
import { loadStatueMesh } from './landmarks/statueMesh';
import { plantCells } from './landmarks/plants';
import { buildIbnKhaldoun } from './landmarks/ibnKhaldoun';
import { buildBourguiba } from './landmarks/bourguiba';
import { buildCathedral } from './landmarks/cathedral';
import { buildEmbassy } from './landmarks/embassy';
import { buildTheatre } from './landmarks/theatre';
import { buildColisee } from './landmarks/colisee';
import { buildClockTower } from './landmarks/clockTower';
import { buildPorteDeFrance } from './landmarks/porteDeFrance';

export async function buildLandmarks(ctx: BuildContext): Promise<WorldPart> {
  const [mats, scholar, scholarFar, equestrian, equestrianFar, relief, angel] = await Promise.all([
    createMaterials(ctx),
    loadStatueMesh(ctx.assets, '/models/landmarks/scholar.bin'),
    loadStatueMesh(ctx.assets, '/models/landmarks/scholar_lod.bin'),
    loadStatueMesh(ctx.assets, '/models/landmarks/equestrian.bin'),
    loadStatueMesh(ctx.assets, '/models/landmarks/equestrian_lod.bin'),
    loadStatueMesh(ctx.assets, '/models/landmarks/relief.bin'),
    loadStatueMesh(ctx.assets, '/models/landmarks/angel.bin'),
    loadFonts(),
  ]);
  const signs = new SignAtlas();
  const env = new Env(ctx, mats, signs, plantCells(signs));

  const parts: Landmark[] = [
    buildCathedral(env, angel),
    buildEmbassy(env),
    buildIbnKhaldoun(env, scholar, scholarFar),
    buildBourguiba(env, equestrian, equestrianFar),
    buildTheatre(env, relief),
    buildColisee(env),
    buildClockTower(env),
    buildPorteDeFrance(env),
  ];
  relief.dispose(); // sources copied into the merged fronts
  angel.dispose();
  signs.finish();

  const root = new Group();
  root.name = 'landmarks';
  for (const p of parts) root.add(p.root);

  return {
    root,
    update(dt, time) {
      for (const p of parts) p.update?.(dt, time);
    },
    dispose() {
      for (const p of parts) p.dispose?.();
      root.traverse((o) => { if (o instanceof Mesh) o.geometry.dispose(); });
      root.removeFromParent();
      mats.all.forEach((m) => m.dispose());
      mats.textures.forEach((t) => t.dispose());
      signs.dispose();
      env.dispose();
    },
  };
}
