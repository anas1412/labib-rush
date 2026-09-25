// FX showroom: every burst kind fires in a loop at its own station on the promenade paving.
// Grid (default): 5 × 2 stations, 3.2 m apart, labelled. The props bin sits at the deposit station,
// Labib (for scale) at the hit station.
// Params (besides the harness ones):
//   ?kind=<FxKind>   one station at the origin (Labib stands there; speedLines runs him forward)
//   ?period=2.4      seconds between bursts per station
//   ?freeze=0.35     deterministic frame: every station bursts once, the FX clock advances exactly
//                    this long (60 Hz steps), then stops — for screenshots of mid-burst frames
//   ?engine=1        render through the game Engine (AgX, LUT grade, AO, bloom) instead of the harness.
//                    This is the reference look: the harness tone-maps per fragment *before* additive
//                    blending, so overlapping glows clip to white there; the engine blends in HDR first.
//   ?labib=0 ?bin=0  skip the reference models · ?labels=0 hide labels
//   ?stress=1        every kind bursting continuously (pools saturated) to check fps / draw calls
//   ?disposeTest=1   20 × (createFx → burst everything → render → dispose); logs [fx-dispose] GPU memory
// Logs [fx-check] with pool stats.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createHarness } from './harness';
import { createEngine } from '../src/core/engine';
import { Assets } from '../src/core/assets';
import { Physics } from '../src/core/physics';
import { CURB } from '../src/core/layout';
import { createFx } from '../src/fx/fx';
import { createProps } from '../src/props';
import { createLabib } from '../src/player/labib';
import type { AvatarMotion, BuildContext, FxKind, LabibAvatar, Quality } from '../src/core/types';

const params = new URLSearchParams(location.search);
const only = params.get('kind') as FxKind | null;
const period = Number(params.get('period') ?? 2.4);
const freeze = params.get('freeze') !== null ? Number(params.get('freeze')) : null;
const stress = params.get('stress') === '1';
const w = window as unknown as { __stats: unknown; __ready: boolean; __fx: unknown };

interface View { scene: THREE.Scene; camera: THREE.PerspectiveCamera; controls: OrbitControls; ctx: BuildContext; onFrame(fn: (dt: number) => void): void; ready(): void }

async function engineView(): Promise<View> {
  document.body.style.margin = '0';
  document.body.style.overflow = 'hidden';
  const engine = createEngine(document.body);
  const q = (params.get('q') as Quality) || 'high';
  engine.setQuality(q);
  engine.dynamicResolution = false; // stable screenshots
  const assets = new Assets(engine.renderer);
  await engine.initLighting(assets);
  const v = (s: string | null, d: number[]) => (s ? s.split(',').map(Number) : d);
  const cam = v(params.get('cam'), [0, 3.2, 9]), tgt = v(params.get('target'), [0, 0.8, 1.5]);
  engine.camera.position.set(cam[0], cam[1], cam[2]);
  engine.camera.fov = Number(params.get('fov') || 50);
  engine.camera.updateProjectionMatrix();
  const controls = new OrbitControls(engine.camera, engine.renderer.domElement);
  controls.target.set(tgt[0], tgt[1], tgt[2]);
  controls.update();
  const uniforms = { uTime: { value: 0 }, uWind: { value: new THREE.Vector3(1.5, 0.3, 0.5) } };
  const ctx: BuildContext = { physics: await Physics.create(), assets, quality: q, renderer: engine.renderer, uniforms };
  const fns: ((dt: number) => void)[] = [];
  const timer = new THREE.Timer();
  let frames = 0, acc = 0;
  engine.renderer.setAnimationLoop(() => {
    timer.update();
    const dt = Math.min(timer.getDelta(), 0.1);
    uniforms.uTime.value = timer.getElapsed();
    controls.update();
    engine.setFocus(controls.target);
    fns.forEach((f) => f(dt));
    engine.render(dt);
    frames++; acc += dt;
    if (acc > 0.5) { w.__stats = { fps: Math.round(frames / acc), calls: engine.renderer.info.render.calls, triangles: engine.renderer.info.render.triangles }; frames = 0; acc = 0; }
  });
  return { scene: engine.scene, camera: engine.camera, controls, ctx, onFrame: (f) => fns.push(f), ready: () => { w.__ready = true; } };
}

const h: View = params.get('engine') === '1' ? await engineView() : await createHarness({ cam: [0, 3.2, 9], target: [0, 0.8, 1.5] });

// Ground: the street module's promenade paving at promenade height (CURB), plain stone if missing.
{
  const g = new THREE.PlaneGeometry(60, 40, 1, 1);
  g.rotateX(-Math.PI / 2);
  const uv = g.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * 60) / 3.2, (uv.getY(i) * 40) / 3.2);
  const mat = new THREE.MeshStandardMaterial({ color: 0xc9bca4, roughness: 0.8 });
  const load = (u: string, srgb: boolean) => h.ctx.assets.texture(u, { srgb, repeat: [1, 1] }).catch(() => null);
  const [map, nor, arm] = await Promise.all([
    load('/textures/street/promenade_diff.webp', true), load('/textures/street/promenade_nor.webp', false), load('/textures/street/promenade_arm.webp', false),
  ]);
  if (map && nor && arm) Object.assign(mat, { map, normalMap: nor, roughnessMap: arm, aoMap: arm, color: new THREE.Color(0xffffff), roughness: 1 });
  mat.needsUpdate = true;
  const ground = new THREE.Mesh(g, mat);
  ground.receiveShadow = true;
  ground.position.y = CURB;
  h.scene.add(ground);
}

const fx = createFx(h.ctx);
h.scene.add(fx.root);

const KINDS: FxKind[] = ['sparkle', 'goldSparkle', 'confetti', 'dust', 'spill', 'powerup', 'hit', 'deposit', 'leaves', 'speedLines'];
const stations = (only ? [only] : KINDS).map((kind, i) => ({
  kind,
  pos: only ? new THREE.Vector3(0, CURB, 0) : new THREE.Vector3(((i % 5) - 2) * 3.2, CURB, i < 5 ? 0 : 3.4),
  phase: only ? 0 : (i * 0.37) % 1,
}));
const at = (k: FxKind) => stations.find((s) => s.kind === k)?.pos;

// reference models
let labib: LabibAvatar | null = null;
const idle: AvatarMotion = { state: 'idle', speed: 0, maxSpeed: 6.5, verticalVelocity: 0, grounded: true, turnRate: 0 };
const run: AvatarMotion = { state: 'run', speed: 9.1, maxSpeed: 6.5, verticalVelocity: 0, grounded: true, turnRate: 0 };
// Labib stands in the hit / speedLines station; next to single-kind stations for scale
const onStation = !only || only === 'hit' || only === 'speedLines';
const labibAt = at(onStation ? (only ?? 'hit') : only)?.clone().add(onStation ? new THREE.Vector3() : new THREE.Vector3(-1.1, 0, -0.4));
if (params.get('labib') !== '0' && labibAt && !stress) {
  labib = await createLabib(h.ctx);
  labib.root.position.copy(labibAt);
  labib.root.rotation.y = only === 'speedLines' ? Math.PI / 2 : onStation ? 0.5 : 1.2;
  if (only === 'speedLines') labib.setSprintTrail(true);
  h.scene.add(labib.root);
  for (let i = 0; i < 60; i++) labib.update(1 / 60, only === 'speedLines' ? run : idle);
}
const binAt = at('deposit');
if (params.get('bin') !== '0' && binAt && !stress) {
  const props = await createProps(h.ctx);
  const bin = props.bin();
  bin.root.position.copy(binAt);
  h.scene.add(bin.root);
  h.onFrame((dt) => bin.update(dt));
}

// labels
const labels = params.get('labels') !== '0' && !only ? stations.map((s) => {
  const d = document.createElement('div');
  d.className = 'fx-label';
  d.textContent = s.kind;
  document.body.append(d);
  return { d, p: s.pos.clone().setY(s.pos.y - 0.05) };
}) : [];
const proj = new THREE.Vector3();
const placeLabels = () => {
  for (const l of labels) {
    proj.copy(l.p).project(h.camera);
    l.d.style.left = `${((proj.x + 1) / 2) * innerWidth}px`;
    l.d.style.top = `${((1 - proj.y) / 2) * innerHeight + 6}px`;
    l.d.style.display = proj.z < 1 ? '' : 'none';
  }
};

const dir = new THREE.Vector3(1, 0, 0);
const tmp = new THREE.Vector3();
function fire(kind: FxKind, p: THREE.Vector3): void {
  if (kind === 'leaves') fx.burst('leaves', tmp.copy(p).setY(p.y + 4));
  else if (kind === 'speedLines') fx.burst('speedLines', p, { direction: dir });
  else if (kind === 'deposit') { fx.burst('deposit', p); fx.burst('sparkle', tmp.copy(p).setY(p.y + 1.1), { count: 6, color: 0x9dffc4 }); }
  else if (kind === 'powerup') fx.burst('powerup', p);
  else fx.burst(kind, p);
}

// speedLines needs real motion: the emitter (and Labib, and the camera if single-kind) runs along +X
const runner = at('speedLines')?.clone();
const runnerHome = runner?.clone();
let runT = 0;
function stepRunner(dt: number): void {
  if (!runner || !runnerHome) return;
  runT += dt;
  if (runT > 1 / 30) {
    runT = 0;
    fx.burst('speedLines', runner, { direction: dir });
  }
  const dx = 9.1 * dt;
  runner.x += dx;
  if (only === 'speedLines') {
    labib?.root.position.copy(runner);
    h.camera.position.x += dx;
    h.controls.target.x += dx;
  }
  if (runner.x - runnerHome.x > 6 && only !== 'speedLines') runner.copy(runnerHome);
}

const clockCam = () => h.camera.position;
if (freeze !== null) {
  // deterministic: burst everything once, then advance the FX clock in 60 Hz steps
  fx.update(0, clockCam());
  for (const s of stations) if (s.kind !== 'speedLines') fire(s.kind, s.pos);
  for (let t = 0; t < freeze; t += 1 / 60) { stepRunner(1 / 60); fx.update(1 / 60, clockCam()); labib?.update(1 / 60, only === 'speedLines' ? run : idle); }
  h.onFrame(() => { fx.update(0, clockCam()); placeLabels(); });
} else {
  const since = stations.map((s) => period * (1 - s.phase));
  h.onFrame((dt) => {
    stations.forEach((s, i) => {
      if (s.kind === 'speedLines') return;
      since[i] += dt;
      const every = stress ? 0.05 : period;
      if (since[i] >= every) { since[i] = 0; fire(s.kind, s.pos); }
    });
    stepRunner(dt);
    fx.update(dt, clockCam());
    labib?.update(dt, only === 'speedLines' ? run : idle);
    placeLabels();
  });
}

if (params.get('disposeTest') === '1') {
  const r = h.ctx.renderer;
  const mem = () => ({ geometries: r.info.memory.geometries, textures: r.info.memory.textures });
  await new Promise((res) => setTimeout(res, 300));
  const before = mem();
  for (let i = 0; i < 20; i++) {
    const f = createFx(h.ctx);
    h.scene.add(f.root);
    for (const k of KINDS) f.burst(k, tmp.set(0, CURB, 0), { direction: dir });
    f.update(0.1, h.camera.position);
    r.render(h.scene, h.camera);
    f.dispose();
  }
  r.render(h.scene, h.camera);
  const result = { before, after: mem() };
  (window as unknown as { __fxDispose: unknown }).__fxDispose = result;
  console.log('[fx-dispose]', JSON.stringify(result));
}

w.__fx = fx;
console.log('[fx-check]', JSON.stringify({ stations: stations.length, stress, freeze }));
h.ready();
