// Street module preview: the street alone under the shared harness (no buildings/landmarks).
// Self-check with physics raycasts (floors, bins, lanes, roofs, planter ledges, canopy, fences),
// logged as [street-check] and kept in window.__streetCheck. Params: ?hide=name|prefix*,
// ?far=1400 (game far plane), ?gpu=all,noTrees,… (GPU-timer A/B, window.__gpu), ?dispose.
import * as THREE from 'three';
import { createHarness } from './harness';
import { buildStreet } from '../src/world/street';
import { BINS, CURB, LANES, ROAD_X, X_MAX, X_MIN, Z } from '../src/core/layout';
import { G } from '../src/core/physics';

const h = await createHarness({ cam: [-230, 1.4, 2], target: [-200, 1.2, 0] });
// ?far=1400: the game camera's far plane (the harness uses 2000)
if (new URLSearchParams(location.search).has('far')) {
  h.camera.far = Number(new URLSearchParams(location.search).get('far'));
  h.camera.updateProjectionMatrix();
}
const t0 = performance.now();
const street = await buildStreet(h.ctx);
h.scene.add(street.root);
h.ctx.physics.step();
const buildMs = Math.round(performance.now() - t0);

// Floor heights where the player can stand: road 0, everything pedestrian CURB.
const probes: [string, number, number, number][] = [
  ['north road', 0, -18, 0], ['south road', 100, 18, 0], ['promenade', -100, 0, CURB], ['north sidewalk', 50, -26, CURB],
  ['south sidewalk', -50, 26, CURB], ['west plaza', -290, 20, CURB], ['east plaza', 300, -20, CURB], ['west arm road', -234, -45, 0],
  ['east arm sidewalk', 249, 45, CURB], ['alley', 25, 38, CURB],
];
const down = new THREE.Vector3(0, -1, 0);
const bad = probes.filter(([, x, z, y]) => {
  const hit = h.ctx.physics.raycast(new THREE.Vector3(x, 5, z), down, 10, G.STATIC);
  return !hit || Math.abs(hit.point.y - y) > 0.01;
});
// Nothing stands within 1.5 m of a bin spot or in a traffic lane; kiosk roofs are standable.
const floorAt = (x: number, z: number, from = 6) => h.ctx.physics.raycast(new THREE.Vector3(x, from, z), down, 12, G.STATIC | G.LOW_PROP)?.point.y ?? NaN;
const blockedBins = BINS.filter((b) => {
  for (const r of [0, 0.7, 1.4]) for (let k = 0; k < 8; k++) {
    const y = floorAt(b.x + Math.cos(k * 0.785) * r, b.z + Math.sin(k * 0.785) * r);
    if (Math.abs(y - CURB) > 0.01) return true;
  }
  return false;
});
let laneHits = 0;
for (const l of LANES) for (let x = ROAD_X.min + 1; x < ROAD_X.max - 1; x += 1.5) for (const dz of [-0.9, 0, 0.9]) if (Math.abs(floorAt(x, l.z + dz)) > 0.01) laneHits++;
const a = street.anchors;
const roofsOk = a.kioskRoofs.every((p) => Math.abs(floorAt(p.x, p.z) - p.y) < 0.02);
// planter anchors lie on a free ledge (not inside the planter's colliders)
const plantersOff = a.planters.filter((p) => Math.abs(floorAt(p.x, p.z, p.y + 1) - p.y) > 0.01).length;
// the canopy volume blocks a camera-style probe (G.STATIC) but not the walkway below it
const canopyHit = h.ctx.physics.raycast(new THREE.Vector3(-100, CURB + 1.5, -9.5), new THREE.Vector3(0, 1, 0), 10, G.STATIC);
const canopyOk = !!canopyHit && canopyHit.point.y > CURB + 3.2 && canopyHit.point.y < CURB + 4;
// canopy box extents (reported): underside, inner face at two heights, top
const hitY = (y: number, dy: number) => h.ctx.physics.raycast(new THREE.Vector3(-100, y, -9.5), new THREE.Vector3(0, dy, 0), 10, G.STATIC)?.point.y;
const hitZ = (y: number) => h.ctx.physics.raycast(new THREE.Vector3(-100, y, 0), new THREE.Vector3(0, 0, -1), 10, G.STATIC)?.point.z;
const canopy = { bottom: hitY(CURB + 1.5, 1), top: hitY(CURB + 12, -1), innerZ: [3.6, 4.5, 5.4, 6.3].map((y) => hitZ(CURB + y)) };
// closures: the collider face stands 0.1 m in front of each fence plane, at knee and head height
const wallAt = (o: THREE.Vector3, d: THREE.Vector3) => h.ctx.physics.raycast(o, d, 20, G.STATIC)?.point;
const fenceErr = [
  [new THREE.Vector3(-300, 0, 0), new THREE.Vector3(-1, 0, 0), 'x', X_MIN + 0.6],
  [new THREE.Vector3(300, 0, 3), new THREE.Vector3(1, 0, 0), 'x', X_MAX - 0.6],
  [new THREE.Vector3(25, 0, 35), new THREE.Vector3(0, 0, 1), 'z', Z.southFacade + 14 - 1.3],
  [new THREE.Vector3(-60, 0, -35), new THREE.Vector3(0, 0, -1), 'z', Z.northFacade - 14 + 1.3],
] as const;
const fencesOk = fenceErr.every(([o, d, ax, want]) => [1, 2].every((y) => {
  const p = wallAt(o.clone().setY(CURB + y), d);
  return !!p && Math.abs(p[ax] - want) < 0.02;
}));
const check = {
  buildMs, floorsOk: bad.length === 0, bad: bad.map((b) => b[0]), blockedBins: blockedBins.length, laneHits, roofsOk, plantersOff, canopyOk, canopy, fencesOk,
  anchors: Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v.length])),
};
console.log('[street-check]', JSON.stringify(check));
(window as unknown as { __streetCheck: typeof check }).__streetCheck = check;
(window as unknown as { __street: typeof street }).__street = street;
// ?hide=street-ficus-canopy,street-asphalt … hides meshes by name (profiling)
for (const n of (new URLSearchParams(location.search).get('hide') ?? '').split(',').filter(Boolean)) {
  // (layer 31 instead of `visible`, which the tree LOD manages)
  street.root.traverse((o) => { if (o.name === n || (n.endsWith('*') && o.name.startsWith(n.slice(0, -1)))) o.layers.set(31); });
}

h.onFrame((dt, t) => street.update?.(dt, t, h.camera.position));

// ?gpu=all,noTrees,…: GPU time of a whole frame (shadow + main pass) per variant from timer
// queries; low percentiles are robust against other processes sharing the GPU. window.__gpu.
if (new URLSearchParams(location.search).has('gpu')) {
  const gl = h.renderer.getContext() as WebGL2RenderingContext;
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  const byPrefix = (...p: string[]) => {
    const list: THREE.Object3D[] = [];
    street.root.traverse((o) => { if (p.some((x) => o.name.startsWith(x))) list.push(o); });
    return list;
  };
  const pool: Record<string, THREE.Object3D[]> = {
    all: [], noTrees: byPrefix('street-ficus', 'street-tree'), noCards: byPrefix('street-ficus-cards'), noCore: byPrefix('street-ficus-core'),
    noTrunks: byPrefix('street-ficus-trunks'),
    noWater: byPrefix('street-lake'), noHills: byPrefix('street-hills', 'street-far-shore'),
    noGround: byPrefix('street-asphalt', 'street-promenade', 'street-sidewalk', 'street-plaza', 'street-inlay', 'street-curb', 'street-paint', 'street-covers'),
    noProps: byPrefix('street-iron', 'street-wood', 'street-lamp', 'street-cafe', 'street-kiosk', 'street-planter', 'street-hedges', 'street-flowers', 'street-galvanized', 'street-flag', 'street-sign', 'street-fence'),
  };
  // experiments that change materials instead of hiding meshes: [apply, restore]
  const groundMats = [...new Set(pool.noGround.map((o) => (o as THREE.Mesh).material as THREE.MeshStandardMaterial))];
  const texOf = (m: THREE.MeshStandardMaterial) => [m.map, m.normalMap, m.roughnessMap, m.aoMap].filter((t): t is THREE.Texture => !!t);
  const aniso0 = new Map(groundMats.flatMap(texOf).map((t) => [t, t.anisotropy]));
  const aniso = (n: number) => () => groundMats.forEach((m) => texOf(m).forEach((t) => { t.anisotropy = n || aniso0.get(t)!; t.needsUpdate = true; }));
  const saved = new Map(groundMats.map((m) => [m, m.normalMap]));
  const fol = [...new Set([...pool.noCore, ...pool.noCards].map((o) => (o as THREE.Mesh).material as THREE.MeshStandardMaterial))];
  const coreM = (pool.noCore[0] as THREE.Mesh).material as THREE.MeshStandardMaterial, coreN = coreM.normalMap;
  const exp: Record<string, [() => void, () => void]> = {
    aniso2: [aniso(2), aniso(0)],
    aniso8: [aniso(8), aniso(0)],
    noShadowPass: [() => (h.renderer.shadowMap.autoUpdate = false), () => (h.renderer.shadowMap.autoUpdate = true)],
    noCoreShadow: [() => pool.noCore.forEach((o) => (o.castShadow = false)), () => pool.noCore.forEach((o) => (o.castShadow = true))],
    noCardShadow: [() => pool.noCards.forEach((o) => (o.userData.cast = o.castShadow, o.castShadow = false)), () => pool.noCards.forEach((o) => (o.castShadow = !!o.userData.cast))],
    fullIbl: [() => fol.forEach((m) => { m.defines = { ...m.defines, ST_FULL_IBL: '' }; m.needsUpdate = true; }), () => fol.forEach((m) => { delete m.defines!.ST_FULL_IBL; m.needsUpdate = true; })],
    coreNoNormal: [() => { coreM.normalMap = null; coreM.needsUpdate = true; }, () => { coreM.normalMap = coreN; coreM.needsUpdate = true; }],
    cardsFirst: [() => pool.noCards.forEach((o) => (o.renderOrder = -1)), () => pool.noCards.forEach((o) => (o.renderOrder = 1))],
    onlySky: [() => (street.root.visible = false), () => (street.root.visible = true)],
    halfRes: [() => h.renderer.setPixelRatio(0.5), () => h.renderer.setPixelRatio(1)],
    noGroundNormal: [() => groundMats.forEach((m) => { m.normalMap = null; m.needsUpdate = true; }), () => groundMats.forEach((m) => { m.normalMap = saved.get(m) ?? null; m.needsUpdate = true; })],
  };
  const out: Record<string, string> = {};
  if (ext) {
    let samples: number[] = [];
    const pending: WebGLQuery[] = [];
    const render = h.renderer.render.bind(h.renderer);
    h.renderer.render = (scene, camera) => {
      const q = gl.createQuery()!;
      gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      render(scene, camera);
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      pending.push(q);
      while (pending.length && gl.getQueryParameter(pending[0], gl.QUERY_RESULT_AVAILABLE)) {
        const q0 = pending.shift()!;
        if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) samples.push(gl.getQueryParameter(q0, gl.QUERY_RESULT) / 1e6);
        gl.deleteQuery(q0);
      }
    };
    // runs in the background (the page reports ready at once): poll window.__gpu
    void (async () => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const names = (new URLSearchParams(location.search).get('gpu') || 'all').split(',');
    const acc: Record<string, number[]> = {};
    const rounds = Number(new URLSearchParams(location.search).get('rounds') || 3);
    for (let k = 0; k < rounds; k++) {
      for (const n of names) {
        (pool[n] ?? []).forEach((o) => (o.visible = false));
        exp[n]?.[0]();
        await wait(400);
        samples = [];
        await wait(1500);
        (acc[n] ??= []).push(...samples);
        (pool[n] ?? []).forEach((o) => (o.visible = true));
        exp[n]?.[1]();
      }
    }
    for (const [n, v] of Object.entries(acc)) {
      v.sort((a, b) => a - b);
      const q = (f: number) => v[Math.min(v.length - 1, Math.floor(v.length * f))].toFixed(1);
      out[n] = `p5 ${q(0.05)} p10 ${q(0.1)} p50 ${q(0.5)} ms (${v.length})`;
    }
    (window as unknown as { __gpu: typeof out }).__gpu = out;
    })();
  } else (window as unknown as { __gpu: typeof out }).__gpu = { error: 'no timer query extension' };
}
// ?dispose: rebuild-and-dispose cycle must return GPU memory and colliders to the baseline.
if (new URLSearchParams(location.search).has('dispose')) {
  const mem = () => ({ ...h.renderer.info.memory, colliders: h.ctx.physics.world.colliders.len() });
  h.renderer.render(h.scene, h.camera);
  const before = mem();
  street.dispose?.();
  h.renderer.render(h.scene, h.camera);
  const after = mem();
  const again = await buildStreet(h.ctx);
  h.scene.add(again.root);
  h.renderer.render(h.scene, h.camera);
  const rebuilt = mem();
  (window as unknown as { __dispose: unknown }).__dispose = { before, after, rebuilt };
}
h.ready();
