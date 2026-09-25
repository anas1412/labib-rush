// Props showroom: every prop in one row on the promenade paving.
// Row (x): litter −4..0.6 · bin 1.6 · power-ups 3..6.6 · taxis 10 / 15 / 20 (facing +Z).
// Params (besides the harness ones): ?only=litter|bin|powerup|taxi  ?anim=0 (freeze)
//   ?brake=1 (taxis braking)  ?honk=1 (headlight flash held)  ?hl=0 (bin highlight off)
//   ?engine=1 (render through the game Engine)  ?colliders=1 (litter capsule / box wireframes)
//   ?stress=1 (gameplay-like load, incl. an instanced bag batch)  ?disposeTest=1 (GPU memory:
//   extra instances allocate nothing, factory.dispose() frees everything)
// Logs [props-check] with build time and per-prop draw calls / triangles.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createHarness } from './harness';
import { createProps } from '../src/props';
import { createEngine } from '../src/core/engine';
import { Assets } from '../src/core/assets';
import { Physics } from '../src/core/physics';
import type { BinModel, BuildContext, LitterKind, PowerUpKind, Quality, TaxiModel } from '../src/core/types';

const params = new URLSearchParams(location.search);
const only = params.get('only');
const anim = params.get('anim') !== '0';

interface View { scene: THREE.Scene; ctx: BuildContext; onFrame(fn: (dt: number, t: number) => void): void; ready(): void }

/** ?engine=1 renders through the game's Engine (AgX + LUT grade + AO + bloom) instead of the harness. */
async function engineView(): Promise<View> {
  document.body.style.margin = '0';
  document.body.style.overflow = 'hidden';
  const engine = createEngine(document.body);
  const q = (params.get('q') as Quality) || 'high';
  engine.setQuality(q);
  const assets = new Assets(engine.renderer);
  await engine.initLighting(assets);
  const v = (s: string | null, d: number[]) => (s ? s.split(',').map(Number) : d);
  const cam = v(params.get('cam'), [1.2, 1.3, 3.2]), tgt = v(params.get('target'), [1.2, 0.4, 0]);
  engine.camera.position.set(cam[0], cam[1], cam[2]);
  const controls = new OrbitControls(engine.camera, engine.renderer.domElement);
  controls.target.set(tgt[0], tgt[1], tgt[2]);
  controls.update();
  const uniforms = { uTime: { value: 0 }, uWind: { value: new THREE.Vector3(1.5, 0.3, 0.5) } };
  const ctx: BuildContext = { physics: await Physics.create(), assets, quality: q, renderer: engine.renderer, uniforms };
  const fns: ((dt: number, t: number) => void)[] = [];
  const timer = new THREE.Timer();
  let frames = 0, acc = 0;
  const w = window as unknown as { __stats: unknown; __ready: boolean };
  engine.renderer.setAnimationLoop(() => {
    timer.update();
    const dt = Math.min(timer.getDelta(), 0.1), t = timer.getElapsed();
    uniforms.uTime.value = t;
    controls.update();
    engine.setFocus(controls.target);
    fns.forEach((f) => f(dt, t));
    engine.render(dt);
    frames++; acc += dt;
    if (acc > 0.5) { w.__stats = { fps: Math.round(frames / acc), calls: engine.renderer.info.render.calls, triangles: engine.renderer.info.render.triangles }; frames = 0; acc = 0; }
  });
  return { scene: engine.scene, ctx, onFrame: (f) => fns.push(f), ready: () => { w.__ready = true; } };
}

const h: View = params.get('engine') === '1' ? await engineView() : await createHarness({ cam: [1.2, 1.3, 3.2], target: [1.2, 0.4, 0] });

// Ground: the street module's promenade paving (3.2 m per UV unit), plain stone if missing.
{
  const g = new THREE.PlaneGeometry(80, 40, 1, 1);
  g.rotateX(-Math.PI / 2);
  const uv = g.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * 80) / 3.2, (uv.getY(i) * 40) / 3.2);
  const mat = new THREE.MeshStandardMaterial({ color: 0xc9bca4, roughness: 0.8 });
  const load = (u: string, srgb: boolean) => h.ctx.assets.texture(u, { srgb, repeat: [1, 1] }).catch(() => null);
  const [map, nor, arm] = await Promise.all([
    load('/textures/street/promenade_diff.webp', true), load('/textures/street/promenade_nor.webp', false), load('/textures/street/promenade_arm.webp', false),
  ]);
  if (map && nor && arm) Object.assign(mat, { map, normalMap: nor, roughnessMap: arm, aoMap: arm, color: new THREE.Color(0xffffff), roughness: 1 });
  mat.needsUpdate = true;
  const ground = new THREE.Mesh(g, mat);
  ground.receiveShadow = true;
  ground.position.set(8, 0, 0);
  h.scene.add(ground);
}

const t0 = performance.now();
const props = await createProps(h.ctx);
const buildMs = Math.round(performance.now() - t0);

const row: { name: string; obj: THREE.Object3D; group: string }[] = [];
const add = (name: string, obj: THREE.Object3D, group: string, x: number, y = 0, z = 0, ry = 0) => {
  obj.position.set(x, y, z);
  obj.rotation.y = ry;
  row.push({ name, obj, group });
  if (!only || only === group) h.scene.add(obj);
};

const litter: [LitterKind, number, number, number][] = [
  ['can', -4, 0.1, 0.3], ['can', -3.55, -0.1, 1.2], ['can', -3.1, 0.05, 2.2], ['bottle', -2.4, 0, -0.4],
  ['chips', -1.5, 0, 0.5], ['chips', -0.8, 0, -0.3], ['golden', 0, 0, 0],
];
litter.forEach(([k, x, z, r], i) => add(`${k}${i}`, props.litter(k), 'litter', x, 0, z, r));
if (params.get('colliders') === '1') {
  // capsule along local X centred at (0, radius, 0) (green) and the rest-pose box (orange)
  const wire = (c: number) => new THREE.MeshBasicMaterial({ color: c, wireframe: true, depthTest: false, transparent: true, opacity: 0.6 });
  for (const { obj } of row) {
    const kind = obj.name.replace('litter-', '') as LitterKind;
    const sh = props.litterShape(kind);
    const cap = new THREE.Mesh(new THREE.CapsuleGeometry(sh.radius, sh.halfLength * 2, 4, 10).rotateZ(Math.PI / 2), wire(0x33ff66));
    cap.position.y = sh.radius;
    const box = new THREE.Mesh(new THREE.BoxGeometry(sh.half.x * 2, sh.half.y * 2, sh.half.z * 2), wire(0xffaa22));
    box.position.y = sh.half.y;
    obj.add(cap, box);
  }
}
const bag = props.litter('bag');
add('bag', bag, 'litter', 0.7, 0.35, 0.2, 0.4);

const bin: BinModel = props.bin();
add('bin', bin.root, 'bin', 1.9, 0, 0);
bin.setHighlight(params.get('hl') !== '0');

const pw: PowerUpKind[] = ['tea', 'bambalouni', 'mashmoum', 'chechia'];
pw.forEach((k, i) => add(k, props.powerup(k), 'powerup', 3.4 + i * 1.1, 0.25, 0, 0));

const taxis: TaxiModel[] = [0, 1, 2].map((v) => props.taxi(v));
taxis.forEach((t, i) => add(`taxi${i}`, t.root, 'taxi', 10 + i * 5, 0, 0, 0.5));
if (params.get('brake') === '1') taxis.forEach((t) => t.setBraking(true));

// per-prop cost: meshes → draw calls (transparent double-sided counts twice), triangles
const cost = row.map(({ name, obj }) => {
  let calls = 0, tris = 0;
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mat = m.material as THREE.Material;
    calls += mat.transparent && mat.side === THREE.DoubleSide && !mat.forceSinglePass ? 2 : 1;
    const g = m.geometry;
    const n = (g.index ? g.index.count : g.getAttribute('position').count) / 3;
    tris += n * ((m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh).count : 1);
  });
  return `${name}:${calls}dc/${Math.round(tris)}t`;
});
const check = { buildMs, cost: cost.join(' ') };
console.log('[props-check]', JSON.stringify(check));
(window as unknown as { __check: unknown }).__check = check;

let bumpT = 0, honkT = 0, drive = 0;
h.onFrame((dt, t) => {
  if (params.get('honk') === '1') taxis.forEach((x) => x.honk());
  if (!anim) { taxis.forEach((x) => x.update(0, 0, 0)); bin.update(dt); return; }
  bumpT += dt; honkT += dt;
  if (bumpT > 2.5) { bumpT = 0; bin.bump(); }
  if (honkT > 3) { honkT = 0; taxis[1].honk(); }
  drive += dt;
  taxis.forEach((x, i) => {
    x.setBraking(params.get('brake') === '1' || (i === 2 && Math.sin(t * 1.5) > 0));
    x.update(dt, dt * 2, i === 0 ? Math.sin(drive) * 0.45 : 0);
  });
  bin.update(dt);
});
(window as unknown as { __props: unknown }).__props = { props, bin, taxis, row };

// ?stress=1: a gameplay-like population spread over 40 × 24 m (60 litter, 8 taxis, 6 bins, 4 power-ups)
if (params.get('stress') === '1') {
  const kinds: LitterKind[] = ['can', 'can', 'bottle', 'chips', 'bag', 'can', 'bottle', 'chips', 'golden'];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const g = new THREE.Group();
  for (let i = 0; i < 60; i++) {
    const k = kinds[i % kinds.length];
    const o = props.litter(k);
    o.position.set(-12 + rnd() * 40, k === 'bag' ? 0.4 + rnd() : 0, -12 + rnd() * 24);
    o.rotation.y = rnd() * 6.28;
    g.add(o);
  }
  const extraTaxis = Array.from({ length: 8 }, (_, i) => props.taxi(i));
  extraTaxis.forEach((t, i) => { t.root.position.set(-10 + i * 5, 0, i % 2 ? -8 : 8); g.add(t.root); });
  const extraBins = Array.from({ length: 6 }, () => props.bin());
  extraBins.forEach((b, i) => { b.root.position.set(-8 + i * 6, 0, 4); b.setHighlight(true); g.add(b.root); });
  pw.forEach((k, i) => { const o = props.powerup(k); o.position.set(i * 3, 0.3, -4); g.add(o); });
  // bags as one InstancedMesh: the flutter shader must read each instance's phase / wind frame
  const bagMesh = props.litter('bag').children[0] as THREE.Mesh;
  const bags = new THREE.InstancedMesh(bagMesh.geometry, bagMesh.material, 6);
  bags.customDepthMaterial = bagMesh.customDepthMaterial;
  bags.castShadow = true;
  const m4 = new THREE.Matrix4();
  for (let i = 0; i < 6; i++) bags.setMatrixAt(i, m4.makeRotationY(i * 1.1).setPosition(-6 + i * 1.2, 0.6 + (i % 3) * 0.3, 10));
  g.add(bags);
  h.scene.add(g);
  h.onFrame((dt) => { extraTaxis.forEach((t) => t.update(dt, dt * 8, 0)); extraBins.forEach((b) => b.update(dt)); });
}

// ?disposeTest=1: build a second factory, render its props once, dispose, compare GPU memory
if (params.get('disposeTest') === '1') {
  const r = h.ctx.renderer;
  const mem = () => ({ geometries: r.info.memory.geometries, textures: r.info.memory.textures, programs: r.info.programs?.length ?? 0 });
  await new Promise((res) => setTimeout(res, 500));
  const before = mem();
  const f2 = await createProps(h.ctx);
  const tmp = new THREE.Group();
  // one of everything (every variant) so all shared resources get uploaded once
  const kinds: LitterKind[] = ['can', 'can', 'can', 'chips', 'chips', 'bag', 'bag', 'bottle', 'golden'];
  kinds.forEach((k) => tmp.add(f2.litter(k)));
  pw.forEach((k) => tmp.add(f2.powerup(k)));
  [0, 1, 2].forEach((v) => tmp.add(f2.taxi(v).root));
  const b0 = f2.bin(); b0.setHighlight(true); b0.update(0.3); tmp.add(b0.root);
  h.scene.add(tmp);
  await new Promise((res) => setTimeout(res, 500));
  const during = mem();
  // more instances must not allocate GPU resources (shared geometry / materials only)
  for (let i = 0; i < 10; i++) {
    const t = f2.taxi(i); t.update(0.016, 0.1, 0.2); t.setBraking(i % 2 === 0); t.honk();
    const b = f2.bin(); b.setHighlight(true); b.update(0.016);
    tmp.add(t.root, b.root, ...kinds.map((k) => f2.litter(k)), ...pw.map((k) => f2.powerup(k)));
  }
  await new Promise((res) => setTimeout(res, 500));
  const moreInstances = mem();
  h.scene.remove(tmp);
  f2.dispose();
  await new Promise((res) => setTimeout(res, 500));
  (window as unknown as { __dispose: unknown }).__dispose = { before, during, moreInstances, after: mem() };
}
h.ready();
