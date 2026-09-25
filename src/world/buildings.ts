// Buildings module: every facade lining the avenue (not the landmarks), the west plaza edge,
// Avenue de France, the east backdrop, cross-street arms/closures, alley walls and a low-detail
// hinterland of rooftops behind them. See src/world/buildings/* for the generator.
//
// Rendering: geometry is merged per material per ~60 m chunk along X and per side (north/south),
// so a chunk costs ≤ 4 draw calls (masonry texture-array PBR, interior-mapped glass, alpha-tested
// ironwork/foliage, shop signs) and frustum culling still works. Every chunk is a THREE.LOD with a
// near version (full modules) and a far version (flat shutters, simplified mouldings, no small
// props), anchored on the facade line. The hinterland of each chunk is one extra mesh shared by
// both versions. Flags share one mesh.
//
// Shadows: none of the detailed geometry casts (it would be drawn into every cascade at full
// detail). Instead one proxy mesh of closed boxes (building masses, balconies, cornices, awnings…)
// casts; it is skipped in the main pass. Near ironwork/plants cast their own alpha-tested shadows.
import { Group, LOD, Mesh, Vector3, type BufferGeometry, type Material, type Object3D } from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { BuildContext, WorldPart } from '../core/types';
import { G } from '../core/physics';
import { X_MAX, X_MIN, Z } from '../core/layout';
import { GeoBuf } from './buildings/geo';
import { loadBuildingTextures } from './buildings/textures';
import { buildSignAtlas } from './buildings/signs';
import { createMaterials } from './buildings/materials';
import { assignSigns, planCity } from './buildings/plan';
import { buildBuilding, collider, hinterBlock, type Bufs, type ColliderBox } from './buildings/facade';
import { rng, range } from './buildings/rng';

const CHUNK = 60;
/** Camera distance (m, to the chunk's facade-line anchor) beyond which the far version is drawn.
 *  Matches the engine's shadow range per preset: beyond it the near version's detail is mostly
 *  sub-pixel triangles (measured ≈ 4 ms of shading waste at 170 m on the target iGPU). */
const LOD_FAR = { low: 100, medium: 100, high: 130, ultra: 180 } as const;

export interface BuildingsStats {
  buildings: number;
  chunks: number;
  meshes: number;
  trianglesNear: number; // near versions of all chunks
  trianglesFar: number; // far versions
  trianglesHinter: number; // hinterland (shared by both)
  trianglesProxy: number; // shadow proxy
  colliders: number;
}

interface Chunk {
  near: Bufs;
  far: Bufs;
  hinter: GeoBuf;
  cx: number;
  cz: number;
}

/** Per-chunk buffers; flags and the shadow proxy are map-wide and passed in per pass. */
const newBufs = (sink: GeoBuf): Bufs => ({ mas: new GeoBuf(), back: new GeoBuf(), glass: new GeoBuf(), cut: new GeoBuf(), sign: new GeoBuf(), flag: sink, shadow: sink });

/** Chunk index along X: 60 m inside the playable avenue, one chunk per backdrop beyond it. */
function chunkIndex(x: number): number {
  if (x < X_MIN) return -1;
  if (x >= X_MAX) return 99;
  return Math.floor((x - X_MIN) / CHUNK);
}

export async function buildBuildings(ctx: BuildContext): Promise<WorldPart & { stats: BuildingsStats }> {
  const [tex, signs] = await Promise.all([loadBuildingTextures(ctx), buildSignAtlas()]);
  const mats = createMaterials(tex, signs, ctx.uniforms, ctx.quality);
  const plan = planCity();
  assignSigns(plan);

  const chunks = new Map<string, Chunk>();
  const sink = new GeoBuf(); // stands in for flags / proxy in passes that must not emit them (stays empty)
  const chunkAt = (x: number, z: number): Chunk => {
    const i = chunkIndex(x);
    const key = `${z < 0 ? 'N' : 'S'}${i}`;
    let c = chunks.get(key);
    if (!c) {
      const cx = i === -1 ? X_MIN - 70 : i === 99 ? X_MAX + 40 : X_MIN + (i + 0.5) * CHUNK;
      const cz = z < 0 ? (i === -1 ? -12 : Z.northFacade) : i === -1 ? 12 : Z.southFacade;
      c = { near: newBufs(sink), far: newBufs(sink), hinter: new GeoBuf(), cx, cz };
      chunks.set(key, c);
    }
    return c;
  };

  const boxes: ColliderBox[] = [];
  const flagBuf = new GeoBuf();
  const proxyBuf = new GeoBuf();
  // quality 'low' (phones): only the simplified version is built and drawn at every distance.
  // The primary pass (near, or far on 'low') also emits colliders, flags and the shadow proxy.
  const low = ctx.quality === 'low';
  for (const b of plan.buildings) {
    const c = chunkAt(b.cx, b.cz);
    if (!low) buildBuilding(b, { ...c.near, flag: flagBuf, shadow: proxyBuf }, signs, ctx.quality, boxes, 0);
    buildBuilding(b, low ? { ...c.far, flag: flagBuf, shadow: proxyBuf } : c.far, signs, ctx.quality, low ? boxes : null, 1);
  }
  for (const w of plan.walls) collider(boxes, w, 20);

  // hinterland blocks behind the street walls (shared by both LOD versions)
  const R = rng(777);
  const reserved = plan.reserved;
  const free = (x0: number, z0: number, x1: number, z1: number) =>
    reserved.every(([a, b, c, d]) => x1 < a - 1 || x0 > c + 1 || z1 < b - 1 || z0 > d + 1);
  const hq = ctx.quality === 'low' ? 1.6 : 1;
  for (const side of [-1, 1]) {
    for (let zA = 31; zA < 120; ) {
      const dz = range(R, 14, 24) * hq;
      for (let x = -455; x < 392; ) {
        const dx = range(R, 12, 26) * hq;
        const gap = range(R, 1.5, 4);
        const x0 = x + gap / 2, x1 = Math.min(392, x + dx - gap / 2);
        const za = side * (zA + gap / 2), zb = side * (zA + dz - gap / 2);
        const z0 = Math.min(za, zb), z1 = Math.max(za, zb);
        if (x1 - x0 > 6 && free(x0, z0, x1, z1)) {
          const deep = zA > 70;
          const c = chunkAt((x0 + x1) / 2, side);
          const tmp: Bufs = { mas: c.hinter, back: c.hinter, glass: sink, cut: sink, sign: sink, flag: sink, shadow: sink };
          hinterBlock(x0, z0, x1, z1, 3 + Math.floor(R() * (deep ? 5 : 4)), R, tmp, signs, ctx.quality);
        }
        x += dx;
      }
      zA += dz;
    }
  }

  // meshes: one LOD per chunk
  const root = new Group();
  root.name = 'buildings';
  const geos: BufferGeometry[] = [];
  let trianglesNear = 0, trianglesFar = 0, meshes = 0;
  const lodFar = LOD_FAR[ctx.quality];
  const mesh = (buf: GeoBuf, m: Material, cx: number, cz: number, cast: boolean, name: string, parent: Object3D): Mesh | null => {
    if (buf.isEmpty()) return null;
    const g = buf.toGeometry(cx, 0, cz);
    geos.push(g);
    const me = new Mesh(g, m);
    me.castShadow = cast;
    me.receiveShadow = true;
    me.matrixAutoUpdate = false;
    me.name = name;
    parent.add(me);
    meshes++;
    return me;
  };
  const tris = (me: Mesh | null) => (me?.geometry.index ? me.geometry.index.count / 3 : 0);
  let trianglesHinter = 0;
  for (const [key, c] of chunks) {
    const lod = new LOD();
    lod.name = `bld-${key}`;
    lod.position.set(c.cx, 0, c.cz);
    for (const [lvl, bufs] of low ? ([[1, c.far]] as const) : ([[0, c.near], [1, c.far]] as const)) {
      const grp = new Group();
      grp.name = `bld-${key}-L${lvl}`;
      // draw order inside the merged mesh: protruding details first, then the walls behind them
      bufs.mas.append(bufs.back);
      let t = tris(mesh(bufs.mas, lvl === 0 ? mats.masonry : mats.masonryFar, c.cx, c.cz, false, `bld-${key}-L${lvl}-masonry`, grp));
      t += tris(mesh(bufs.cut, mats.cutout, c.cx, c.cz, lvl === 0, `bld-${key}-L${lvl}-cutout`, grp));
      t += tris(mesh(bufs.glass, mats.glass, c.cx, c.cz, false, `bld-${key}-L${lvl}-glass`, grp));
      t += tris(mesh(bufs.sign, mats.signs, c.cx, c.cz, false, `bld-${key}-L${lvl}-signs`, grp));
      if (lvl === 0) trianglesNear += t;
      else trianglesFar += t;
      lod.addLevel(grp, lvl === 0 || low ? 0 : lodFar, 0.08); // 8 % hysteresis: no flicker at the boundary
    }
    // hinterland: one cheap mesh shared by both versions (a plain child, always drawn)
    trianglesHinter += tris(mesh(c.hinter, mats.masonryFar, c.cx, c.cz, false, `bld-${key}-hinter`, lod));
    lod.updateMatrix();
    lod.matrixAutoUpdate = false;
    root.add(lod);
  }
  mesh(flagBuf, mats.flag, 0, 0, false, 'bld-flags', root);
  const proxy = mesh(proxyBuf, mats.proxy, 0, 0, true, 'bld-shadow-proxy', root);
  if (proxy) {
    proxy.receiveShadow = false;
    // only the shadow pass draws it: an empty draw range in the main pass, restored right after
    proxy.onBeforeRender = () => proxy.geometry.setDrawRange(0, 0);
    proxy.onAfterRender = () => proxy.geometry.setDrawRange(0, Infinity);
  }

  // colliders: one thin solid slab per facade segment
  const colliders: RAPIER.Collider[] = [];
  const v = new Vector3(), h = new Vector3();
  for (const b of boxes) colliders.push(ctx.physics.addBox(v.set(b.cx, b.cy, b.cz), h.set(b.hx, b.hy, b.hz), b.rotY, G.STATIC));

  return {
    root,
    stats: {
      buildings: plan.buildings.length, chunks: chunks.size, meshes, trianglesNear, trianglesFar, trianglesHinter,
      trianglesProxy: tris(proxy), colliders: colliders.length,
    },
    dispose() {
      for (const c of colliders) ctx.physics.removeCollider(c);
      geos.forEach((g) => g.dispose());
      mats.dispose();
      tex.dispose();
      signs.dispose();
      root.removeFromParent();
    },
  };
}
