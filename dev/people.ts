// People preview: a 12-seed lineup (x −6.6..6.6, z 0, facing +Z), a walking group looping on an
// oval behind it (z ≈ −6), and a café row to the east (x 10..17) with tables/chairs matching the
// street module's dimensions (seat top 0.4775 m, table top 0.757 m).
// Params (besides the harness ones):
//   ?anim=idle|walk|talk|cheer|sit|throw|startled|pickUp   lineup animation (one-shots repeat)
//   ?seeds=0,1,2 (lineup seeds; default 0..11)  ?base=100 (seed offset)  ?speed=1.35 (walk)
//   ?walkSeeds=…  ?cafeSeeds=… (6)  — defaults mix trousers with skirts, dresses and robes
//   ?at=0.4   freeze `at` s after the (one-shot) start, after a deterministic 3 s warm-up
//   ?from=sit  start the lineup in this loop, switch to ?anim after the warm-up (transition check)
//   ?audit=500 (triangle budget over many seeds)  ?disposeTest=1 (GPU memory before/after 100 create+dispose)
//   ?only=lineup|walk|cafe   ?stress=60 (a 60-person crowd walking, for perf)   ?engine=1 (game renderer)
//   ?atlas=decal|normal|shade   overlay the shared detail atlas (debug the painters)
//   ?cafeShot=throw|startled|pickUp   one-shot on the seated patrons (with ?at= to freeze)
//   ?pickAudit=200   grip height at PICKUP_GRAB_SEC over many seeds (must be ≤ 0.1 m)
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createHarness } from './harness';
import { createEngine } from '../src/core/engine';
import { Assets } from '../src/core/assets';
import { Physics } from '../src/core/physics';
import { PICKUP_GRAB_SEC, SEAT_HEIGHT, createPeople, type PersonStats } from '../src/npc/people';
import type { BuildContext, Person, PersonAnim, Quality } from '../src/core/types';

const params = new URLSearchParams(location.search);
const only = params.get('only');
const show = (k: string) => !only || only === k;

interface View { scene: THREE.Scene; ctx: BuildContext; onFrame(fn: (dt: number, t: number) => void): void; ready(): void }

/** ?engine=1 renders through the game's Engine (AgX + grade + AO + bloom) instead of the harness. */
async function engineView(): Promise<View> {
  document.body.style.margin = '0';
  document.body.style.overflow = 'hidden';
  const engine = createEngine(document.body);
  const q = (params.get('q') as Quality) || 'high';
  engine.setQuality(q);
  const assets = new Assets(engine.renderer);
  await engine.initLighting(assets);
  const v = (s: string | null, d: number[]) => (s ? s.split(',').map(Number) : d);
  const cam = v(params.get('cam'), [0, 1.6, 8]), tgt = v(params.get('target'), [0, 1, 0]);
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

const h: View = params.get('engine') === '1' ? await engineView() : await createHarness({ cam: [0, 1.6, 8], target: [0, 1, 0] });

// Ground: the street module's promenade paving when present, plain stone otherwise.
{
  const g = new THREE.PlaneGeometry(80, 60, 1, 1);
  g.rotateX(-Math.PI / 2);
  const uv = g.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * 80) / 3.2, (uv.getY(i) * 60) / 3.2);
  const mat = new THREE.MeshStandardMaterial({ color: 0xc9bca4, roughness: 0.8 });
  const load = (u: string, srgb: boolean) => h.ctx.assets.texture(u, { srgb, repeat: [1, 1] }).catch(() => null);
  const [map, nor, arm] = await Promise.all([
    load('/textures/street/promenade_diff.webp', true), load('/textures/street/promenade_nor.webp', false), load('/textures/street/promenade_arm.webp', false),
  ]);
  if (map && nor && arm) Object.assign(mat, { map, normalMap: nor, roughnessMap: arm, aoMap: arm, color: new THREE.Color(0xffffff), roughness: 1 });
  mat.needsUpdate = true;
  const ground = new THREE.Mesh(g, mat);
  ground.receiveShadow = true;
  ground.position.set(5, 0, -4);
  h.scene.add(ground);
}

const t0 = performance.now();
const people = await createPeople(h.ctx);
const factoryMs = Math.round(performance.now() - t0);
const all: { p: Person; speed: () => number; move?: (dt: number) => void }[] = [];
const anim = (params.get('anim') || 'idle') as PersonAnim;
const oneShot = anim === 'throw' || anim === 'startled' || anim === 'pickUp';
const base = Number(params.get('base') ?? 0);
const seeds = params.get('seeds') ? params.get('seeds')!.split(',').map(Number) : Array.from({ length: 12 }, (_, i) => i + base);
const walkSpeed = Number(params.get('speed') ?? 1.35);

// lineup
if (show('lineup')) {
  seeds.forEach((s, i) => {
    const p = people.create(s);
    p.root.position.set((i - (seeds.length - 1) / 2) * 1.2, 0, 0);
    h.scene.add(p.root);
    const from = params.get('from') as PersonAnim | null;
    if (from) p.setAnim(from);
    else if (!oneShot) p.setAnim(anim);
    all.push({ p, speed: () => (anim === 'walk' ? walkSpeed : 0) });
  });
}

// walking group on an oval behind the lineup
if (show('walk')) {
  const ws = params.get('walkSeeds') ? params.get('walkSeeds')!.split(',').map(Number) : [200, 4, 201, 5, 17, 202, 26];
  const n = ws.length;
  for (let i = 0; i < n; i++) {
    const p = people.create(ws[i] + base);
    h.scene.add(p.root);
    p.setAnim('walk');
    const sp = 1.15 + (i % 3) * 0.18;
    let u = i / n;
    const rx = 9, rz = 2.4, cz = -6.5, per = (2 * Math.PI * Math.sqrt((rx * rx + rz * rz) / 2)) / sp;
    const move = (dt: number) => {
      u = (u + dt / per) % 1;
      const a = u * Math.PI * 2;
      p.root.position.set(Math.cos(a) * rx, 0, cz + Math.sin(a) * rz + (i % 2) * 0.6);
      p.root.rotation.y = Math.atan2(-Math.sin(a) * rx, Math.cos(a) * rz);
    };
    move(0);
    all.push({ p, speed: () => sp, move });
  }
}

const cafe: Person[] = [];
// café row: 3 tables, two patrons each facing across the table (street layout: chairs at ±0.55 m)
const cafeSeeds = params.get('cafeSeeds') ? params.get('cafeSeeds')!.split(',').map(Number) : [2, 300, 4, 301, 5, 9];
if (show('cafe')) {
  const wood = new THREE.MeshStandardMaterial({ color: 0x8a6a48, roughness: 0.7 });
  const metal = new THREE.MeshStandardMaterial({ color: 0x2a2a2c, roughness: 0.4, metalness: 0.8 });
  const marble = new THREE.MeshStandardMaterial({ color: 0xe8e4dc, roughness: 0.25 });
  for (let k = 0; k < 3; k++) {
    const tx = 11 + k * 2.4, tz = 0.5;
    const top = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.03, 24), marble);
    top.position.set(tx, 0.742, tz);
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.73, 8), metal);
    leg.position.set(tx, 0.365, tz);
    for (const m of [top, leg]) { m.castShadow = m.receiveShadow = true; h.scene.add(m); }
    for (const side of [-1, 1]) {
      const cx = tx + side * 0.55;
      const chair = new THREE.Group();
      const seat = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.035, 0.4), wood);
      seat.position.y = SEAT_HEIGHT - 0.0175;
      const back = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.03), wood);
      back.position.set(0, 0.7, -0.24);
      chair.add(seat, back);
      for (const [lx, lz] of [[-0.19, 0.18], [0.19, 0.18], [-0.19, -0.2], [0.19, -0.2]]) {
        const l = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.46, 6), metal);
        l.position.set(lx, 0.23, lz);
        chair.add(l);
      }
      chair.traverse((o) => { o.castShadow = o.receiveShadow = true; });
      const yaw = side < 0 ? Math.PI / 2 : -Math.PI / 2; // facing the table
      chair.position.set(cx, 0, tz);
      chair.rotation.y = yaw;
      h.scene.add(chair);
      const p = people.create(cafeSeeds[k * 2 + (side > 0 ? 1 : 0)] + base);
      p.root.position.set(cx, 0, tz); // root = floor under the seat anchor (anchor.y − SEAT_HEIGHT)
      p.root.rotation.y = yaw;
      p.setAnim('sit');
      h.scene.add(p.root);
      cafe.push(p);
      all.push({ p, speed: () => 0 });
    }
  }
}

// perf: a gameplay-sized crowd walking straight lines across a 40 × 30 m area
if (params.get('stress')) {
  const n = Number(params.get('stress'));
  for (let i = 0; i < n; i++) {
    const p = people.create(1000 + i);
    const dir = i % 2 ? 1 : -1, sp = 1.1 + (i % 5) * 0.1;
    const z = -20 + (i % 15) * 2.2, x0 = -20 + ((i * 7.3) % 40);
    p.root.position.set(x0, 0, z);
    p.root.rotation.y = (dir * Math.PI) / 2;
    p.setAnim(i % 9 === 0 ? 'talk' : 'walk');
    h.scene.add(p.root);
    const move = (dt: number) => { p.root.position.x += dir * sp * dt; if (Math.abs(p.root.position.x) > 22) p.root.position.x = -dir * 22; };
    all.push({ p, speed: () => (i % 9 === 0 ? 0 : sp), move });
  }
}
const buildMs = Math.round(performance.now() - t0);

// ?audit=500: build many seeds off-scene and check the per-person triangle budget (≤ 3000)
if (params.get('audit')) {
  const n = Number(params.get('audit'));
  const a0 = performance.now();
  let worst = { seed: -1, tris: 0 }, sum = 0;
  const over: string[] = [];
  for (let i = 0; i < n; i++) {
    const p = people.create(i);
    const tris = (p.root.userData.people as PersonStats).triangles;
    sum += tris;
    if (tris > worst.tris) worst = { seed: i, tris };
    if (tris > 3000 && over.length < 6) over.push(`${i}:${tris}:${JSON.stringify((p.root.userData.people as PersonStats).parts)}`);
    p.dispose();
  }
  const audit = { n, maxTris: worst.tris, worstSeed: worst.seed, avgTris: Math.round(sum / n), msPerPerson: +((performance.now() - a0) / n).toFixed(2), withinBudget: worst.tris <= 3000, over };
  console.log('[people-audit]', JSON.stringify(audit));
  Object.assign(window, { __audit: audit });
}

// ?pickAudit=200: the pick-up must bring the held item (trash bone) down to the floor
if (params.get('pickAudit')) {
  const n = Number(params.get('pickAudit'));
  const v = new THREE.Vector3();
  let worst = { seed: -1, y: 0 }, sum = 0;
  for (let i = 0; i < n; i++) {
    const p = people.create(i);
    p.update(1 / 60, 0);
    p.setAnim('pickUp');
    for (let t = 0; t < PICKUP_GRAB_SEC - 1e-6; t += 1 / 60) p.update(Math.min(1 / 60, PICKUP_GRAB_SEC - t), 0);
    p.root.updateMatrixWorld(true);
    (p.root.children[0] as THREE.SkinnedMesh).skeleton.bones[18].getWorldPosition(v);
    sum += v.y;
    if (v.y > worst.y) worst = { seed: i, y: v.y };
    p.dispose();
  }
  const res = { n, maxY: +worst.y.toFixed(3), worstSeed: worst.seed, avgY: +(sum / n).toFixed(3), ok: worst.y <= 0.1 };
  console.log('[people-pick]', JSON.stringify(res));
  Object.assign(window, { __pick: res });
}

const stats = all.map(({ p }) => p.root.userData.people as PersonStats);
const tris = stats.map((s) => s.triangles);
const check = { factoryMs, buildMs, people: all.length, maxTris: Math.max(...tris), avgTris: Math.round(tris.reduce((a, b) => a + b, 0) / tris.length), seeds: stats.slice(0, seeds.length).map((s) => `${s.seed}:${s.triangles}`).join(' ') };
console.log('[people-check]', JSON.stringify(check));
Object.assign(window, { __check: check, __people: all.map((a) => a.p), __factory: people });

// deterministic warm-up, optional freeze
const step = 1 / 60;
const at = params.get('at') !== null ? Number(params.get('at')) : null;
for (let i = 0; i < 180; i++) all.forEach((a) => { a.move?.(step); a.p.update(step, a.speed()); });
if (oneShot || params.get('from')) all.slice(0, seeds.length).forEach((a) => a.p.setAnim(anim));
// ?cafeShot=throw|startled|pickUp: fire a one-shot on the seated patrons (upper body only)
const cafeShot = params.get('cafeShot') as PersonAnim | null;
if (cafeShot) cafe.forEach((p) => p.setAnim(cafeShot));
let frozen = false;
if (at !== null) {
  for (let t = 0; t < at; t += step) all.forEach((a) => { a.move?.(step); a.p.update(step, a.speed()); });
  frozen = true;
}

let since = 0;
let updMs = 0, updN = 0;
h.onFrame((dt) => {
  if (frozen) return;
  since += dt;
  if (oneShot && since > 2.6) { since = 0; all.slice(0, seeds.length).forEach((a) => a.p.setAnim(anim)); }
  const u0 = performance.now();
  for (const a of all) { a.move?.(dt); a.p.update(dt, a.speed()); }
  updMs += performance.now() - u0; updN++;
  if (updN === 60) { (window as unknown as { __upd: number }).__upd = +(updMs / updN).toFixed(3); updMs = 0; updN = 0; }
});
if (params.get('disposeTest') === '1') {
  const r = h.ctx.renderer;
  const frame = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
  await frame();
  const before = { ...r.info.memory };
  const tmp: Person[] = [];
  for (let i = 0; i < 100; i++) { const p = people.create(5000 + i); p.root.position.set((i % 10) - 5, 0, 4 + Math.floor(i / 10)); h.scene.add(p.root); tmp.push(p); }
  await frame();
  const during = { ...r.info.memory };
  tmp.forEach((p) => p.dispose());
  await frame();
  const after = { ...r.info.memory };
  const res = { before, during, after, leaked: after.geometries - before.geometries + after.textures - before.textures };
  console.log('[people-dispose]', JSON.stringify(res));
  Object.assign(window, { __dispose: res });
}
// ?atlas=…: draw the shared atlas over the page (row 0 of the DataTexture is the bottom)
const atlasView = params.get('atlas');
if (atlasView && all.length) {
  const mesh = all[0].p.root.children[0] as THREE.SkinnedMesh;
  const mat = mesh.material as THREE.MeshPhysicalMaterial;
  const tex = (atlasView === 'decal' ? mat.map : mat.normalMap) as THREE.DataTexture;
  const { data, width, height } = tex.image as { data: Uint8Array; width: number; height: number };
  const cv = document.createElement('canvas');
  cv.width = width; cv.height = height;
  Object.assign(cv.style, { position: 'fixed', left: '0', top: '0', width: '100vw', height: `${(100 * height) / width}vw`, zIndex: '10', background: '#808080' });
  const img = new ImageData(width, height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = ((height - 1 - y) * width + x) * 4, o = (y * width + x) * 4;
    if (atlasView === 'shade') { img.data[o] = img.data[o + 1] = img.data[o + 2] = data[i + 3]; img.data[o + 3] = 255; }
    else if (atlasView === 'normal') { img.data.set([data[i], data[i + 1], data[i + 2], 255], o); }
    else { const a = data[i + 3] / 255; for (let k = 0; k < 3; k++) img.data[o + k] = data[i + k] * a + 128 * (1 - a); img.data[o + 3] = 255; }
  }
  cv.getContext('2d')!.putImageData(img, 0, 0);
  document.body.appendChild(cv);
}
h.ready();
