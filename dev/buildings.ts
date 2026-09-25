// Buildings module preview: all street walls on a flat floor under the shared harness.
// Logs [buildings] stats and self-checks: collider rays (from public space they must hit a wall
// before leaving the map; rays inside landmark gaps are skipped, the landmarks module closes those)
// and the plan (no building narrower than 6 m along its main facade).
// URL: harness params (?cam, target, fov, q) plus
//   ?engine=1          render through the game engine (its lighting, IBL, cascaded shadows, post)
//   ?street=1 / ?landmarks=1   add the sibling modules for context shots (default: a flat floor)
//   ?hide=bld-N3-glass,bld-*-cutout   hide meshes by name (profiling)
//   ?gpu=<variant>     A/B GPU timing, result in window.__gpu (see below)
import * as THREE from 'three';
import { createHarness } from './harness';
import { buildBuildings } from '../src/world/buildings';
import { planCity } from '../src/world/buildings/plan';
import { ALLEYS, CROSS_STREETS, CURB, LANDMARKS, X_MAX, X_MIN, Z } from '../src/core/layout';
import { G, Physics } from '../src/core/physics';
import { Assets } from '../src/core/assets';
import type { BuildContext, Quality } from '../src/core/types';

const qs = new URLSearchParams(location.search);
const vec = (s: string | null, d: [number, number, number]) => (s ? (s.split(',').map(Number) as [number, number, number]) : d);
const win = window as unknown as Record<string, unknown>;

interface Page {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  ctx: BuildContext;
  onFrame(fn: (dt: number, t: number) => void): void;
  ready(): void;
  /** Wraps the per-frame render (GPU A/B timing). */
  wrapRender(wrap: (render: () => void) => void): void;
}

async function harnessPage(): Promise<Page> {
  const h = await createHarness({ cam: [-200, 1.2, 0], target: [-150, 6, -10] });
  return {
    ...h,
    wrapRender(wrap) {
      const render = h.renderer.render.bind(h.renderer);
      h.renderer.render = (scene, cam) => wrap(() => render(scene, cam));
    },
  };
}

/** Same page contract, rendered by the real engine (fixed camera from ?cam / ?target). */
async function enginePage(): Promise<Page> {
  const { createEngine } = await import('../src/core/engine');
  document.body.style.margin = '0';
  const app = document.createElement('div');
  app.style.cssText = 'position:fixed;inset:0';
  document.body.appendChild(app);
  const engine = createEngine(app);
  const quality = (qs.get('q') as Quality | null) ?? 'high';
  engine.setQuality(quality);
  engine.dynamicResolution = false; // stable screenshots and timings
  const assets = new Assets(engine.renderer);
  await engine.initLighting(assets);
  const physics = await Physics.create();
  const uniforms = { uTime: { value: 0 }, uWind: { value: new THREE.Vector3(1.5, 0.3, 0.5) } };
  const ctx: BuildContext = { physics, assets, quality, renderer: engine.renderer, uniforms };
  const cam = new THREE.Vector3(...vec(qs.get('cam'), [-200, 1.2, 0]));
  const target = new THREE.Vector3(...vec(qs.get('target'), [-150, 6, -10]));
  if (qs.has('fov')) engine.camera.fov = Number(qs.get('fov'));
  engine.camera.updateProjectionMatrix();
  const frameFns: ((dt: number, t: number) => void)[] = [];
  let render = (dt: number) => engine.render(dt);
  let last = performance.now(), frames = 0, acc = 0;
  win.__stats = { fps: 0, calls: 0, triangles: 0 };
  engine.renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    uniforms.uTime.value += dt;
    engine.camera.position.copy(cam);
    engine.camera.lookAt(target);
    engine.setFocus(target);
    frameFns.forEach((f) => f(dt, uniforms.uTime.value));
    render(dt);
    frames++;
    acc += dt;
    if (acc > 0.5) {
      const info = engine.renderer.info.render;
      win.__stats = { fps: Math.round(frames / acc), calls: info.calls, triangles: info.triangles };
      frames = 0;
      acc = 0;
    }
  });
  return {
    renderer: engine.renderer, scene: engine.scene, camera: engine.camera, ctx,
    onFrame: (fn) => frameFns.push(fn),
    ready: () => (win.__ready = true),
    wrapRender(wrap) {
      const inner = render;
      render = (dt) => wrap(() => inner(dt));
    },
  };
}

const h = qs.get('engine') === '1' ? await enginePage() : await harnessPage();

const context: { update?: (dt: number, t: number, cam: THREE.Vector3) => void }[] = [];
if (qs.get('street')) {
  const { buildStreet } = await import('../src/world/street');
  const st = await buildStreet(h.ctx);
  h.scene.add(st.root);
  context.push(st);
} else {
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(1200, 400).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x9d968c, roughness: 0.95 }),
  );
  floor.position.y = CURB;
  floor.receiveShadow = true;
  h.scene.add(floor);
}
if (qs.get('landmarks')) {
  const { buildLandmarks } = await import('../src/world/landmarks');
  const lm = await buildLandmarks(h.ctx);
  h.scene.add(lm.root);
  context.push(lm);
}

const t0 = performance.now();
const part = await buildBuildings(h.ctx);
h.scene.add(part.root);
h.ctx.physics.step();
const buildMs = Math.round(performance.now() - t0);

// Collider self-check: horizontal rays at 1 m from public space outward must hit STATIC.
const inLandmarkGap = (x: number, side: number) =>
  Object.values(LANDMARKS).some((l) => 'xMin' in l && x > l.xMin - 0.5 && x < l.xMax + 0.5 && (side < 0 ? l.zMax === Z.northFacade : l.zMin === Z.southFacade));
// Each ray has a max length just past the wall it must meet, so a hole is not masked by a wall further on.
const rays: [string, number, number, number, number, number][] = [];
for (let x = X_MIN + 2; x < X_MAX - 2; x += 5) {
  if (!inLandmarkGap(x, -1)) rays.push([`N${x}`, x, -27, 0, -1, 30]); // facade 3 m, alley back 17 m, arm end 29 m
  if (!inLandmarkGap(x, 1)) rays.push([`S${x}`, x, 27, 0, 1, 30]);
}
for (const c of CROSS_STREETS)
  for (const s of [-1, 1]) {
    rays.push([`arm${c.x}/${s}`, c.x, s * 40, 0, s, 17], [`armW${c.x}/${s}`, c.x, s * 45, -1, 0, 7], [`armE${c.x}/${s}`, c.x, s * 45, 1, 0, 7]);
    // the bend east of the arm end: its far end, its inner side and the closing building
    rays.push([`bendE${c.x}/${s}`, c.x + 10, s * 52, 1, 0, 11], [`bendIn${c.x}/${s}`, c.x + 10, s * 52, 0, -s, 5], [`bendOut${c.x}/${s}`, c.x + 10, s * 52, 0, s, 5]);
  }
for (const a of ALLEYS) rays.push([`alley${a.x}`, a.x, a.side * 33, 0, a.side, 12], [`alleyW${a.x}`, a.x, a.side * 36, -1, 0, 5], [`alleyE${a.x}`, a.x, a.side * 36, 1, 0, 5]);
for (const z of [-25, -18, 18, 25]) rays.push([`west${z}`, X_MIN + 5, z, -1, 0, 6]);
const miss = rays.filter(([, x, z, dx, dz, d]) => !h.ctx.physics.raycast(new THREE.Vector3(x, CURB + 1, z), new THREE.Vector3(dx, 0, dz), d, G.STATIC)).map((r) => r[0]);

// Plan self-check: slivers = main facades under 6 m (corner buildings, which also front the
// chamfer and the side street, under 4 m)
const plan = planCity();
const narrow = plan.buildings.flatMap((b) => {
  const corner = b.segs.some((s) => s.role === 'chamfer');
  return b.segs.filter((s) => s.role === 'main' && s.len < (corner ? 4 : 6)).map((s) => `${b.style}@${b.cx.toFixed(0)},${b.cz.toFixed(0)}:${s.len.toFixed(1)}m`);
});
const minMain = Math.min(...plan.buildings.flatMap((b) => b.segs.filter((s) => s.role === 'main').map((s) => s.len)));

const report = { buildMs, ...part.stats, rays: rays.length, miss, narrow, minMain: Math.round(minMain * 10) / 10 };
console.log('[buildings]', JSON.stringify(report));
win.__bld = report;
win.__plan = plan.buildings.map((b) => `${b.style[0]}${b.detail ? '*' : ''} ${b.cx.toFixed(0)},${b.cz.toFixed(0)} f${b.floors}${b.shops.length ? ' ' + b.shops.map((s) => s.kind).join('/') : ''}`);
win.__bldPart = part;

for (const n of (qs.get('hide') ?? '').split(',').filter(Boolean)) {
  const re = new RegExp('^' + n.replace(/\*/g, '.*') + '$');
  part.root.traverse((o) => { if (re.test(o.name)) o.visible = false; });
}
h.onFrame((dt, t) => {
  for (const c of context) c.update?.(dt, t, h.camera.position);
});

// ?gpu=<variant>: A/B GPU timing (EXT_disjoint_timer_query_webgl2), alternating the full scene (A)
// with a variant (B) in 30-frame blocks so drift from other GPU users cancels out.
// Variants: hide (no buildings), hidemas / hideglass / hidecut, plain / basic (simpler masonry
// material), noshadow (no shadow casting by the buildings), noproxy / nocutcast (one caster off),
// noreceive, far (far shader everywhere), allfar (far version of every chunk).
const gpuVariant = qs.get('gpu');
if (gpuVariant) {
  const gl = h.renderer.getContext() as WebGL2RenderingContext;
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  if (ext) {
    const meshes: THREE.Mesh[] = [];
    part.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
    const orig = meshes.map((m) => ({ mat: m.material as THREE.Material, cast: m.castShadow, recv: m.receiveShadow }));
    const plain = new THREE.MeshStandardMaterial({ vertexColors: true });
    const basic = new THREE.MeshBasicMaterial({ vertexColors: true });
    const farMat = meshes.find((m) => m.name.includes('L1-masonry'))?.material as THREE.Material | undefined;
    const lods: THREE.LOD[] = [];
    part.root.traverse((o) => { if ((o as THREE.LOD).isLOD && (o as THREE.LOD).levels.length > 1) lods.push(o as THREE.LOD); });
    const lodFar = lods[0]?.levels[1].distance ?? 0;
    const apply = (b: boolean) => {
      lods.forEach((l) => { l.levels[1].distance = b && gpuVariant === 'allfar' ? 0.01 : lodFar; });
      applyMeshes(b);
    };
    const applyMeshes = (b: boolean) => meshes.forEach((m, i) => {
      m.material = orig[i].mat; m.castShadow = orig[i].cast; m.receiveShadow = orig[i].recv; m.visible = true;
      if (!b) return;
      const mas = m.name.endsWith('masonry');
      if (gpuVariant === 'hide') m.visible = false;
      if (gpuVariant === 'hidemas' && mas) m.visible = false;
      if (gpuVariant === 'plain' && mas) m.material = plain;
      if (gpuVariant === 'noshadow') m.castShadow = false;
      if (gpuVariant === 'far' && mas && farMat) m.material = farMat;
      if (gpuVariant === 'noreceive' && mas) m.receiveShadow = false;
      if (gpuVariant === 'basic' && mas) m.material = basic;
      if (gpuVariant === 'noproxy' && m.name === 'bld-shadow-proxy') m.castShadow = false;
      if (gpuVariant === 'nocutcast' && m.name.endsWith('cutout')) m.castShadow = false;
      if (gpuVariant === 'hideglass' && m.name.endsWith('glass')) m.visible = false;
      if (gpuVariant === 'hidecut' && m.name.endsWith('cutout')) m.visible = false;
    });
    let block = 0, n = 0;
    const A: number[] = [], B: number[] = [];
    const pending: { q: WebGLQuery; b: boolean }[] = [];
    h.wrapRender((render) => {
      const isB = block % 2 === 1;
      const q = gl.createQuery()!;
      gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      render();
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      pending.push({ q, b: isB });
      while (pending.length && gl.getQueryParameter(pending[0].q, gl.QUERY_RESULT_AVAILABLE)) {
        const p = pending.shift()!;
        const ms = gl.getQueryParameter(p.q, gl.QUERY_RESULT) / 1e6;
        if (!gl.getParameter(ext.GPU_DISJOINT_EXT) && block >= 2) (p.b ? B : A).push(ms);
        gl.deleteQuery(p.q);
      }
      if (++n >= 30) {
        n = 0; block++;
        apply(block % 2 === 1);
        if (block === 14) {
          // p10 as well as the median: other GPU users time-slice in and inflate long frames most
          const pct = (v: number[], p: number) => { const s2 = [...v].sort((x, y) => x - y); return Math.round(s2[Math.floor(s2.length * p)] * 100) / 100; };
          const r2 = (x: number) => Math.round(x * 100) / 100;
          win.__gpu = {
            variant: gpuVariant, A: pct(A, 0.5), B: pct(B, 0.5), delta: r2(pct(A, 0.5) - pct(B, 0.5)),
            A10: pct(A, 0.1), B10: pct(B, 0.1), delta10: r2(pct(A, 0.1) - pct(B, 0.1)),
          };
        }
      }
    });
  }
}
h.ready();
