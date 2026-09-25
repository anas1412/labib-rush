// Labib Rush — game entry. Boot (loading screen → engine → world → systems), the state machine
// (menu · play · paused · over) and the frame loop. The UI owns its screens; this file drives the
// game in response to its handlers (see docs/integration-notes.md, "ui").
import { Vector3 } from 'three';
import { Assets } from './core/assets';
import { Emitter } from './core/events';
import { FIXED_DT, Physics } from './core/physics';
import { PLAYER_SPAWN } from './core/layout';
import type { GameContext, GameEvents, InputFrame, Settings, UIHandlers } from './core/types';
import { createEngine } from './core/engine';
import { createInput } from './core/input';
import { createPlayerController } from './player/controller';
import { createCameraRig } from './player/cameraRig';
import { createLabib } from './player/labib';
import { buildStreet } from './world/street';
import { buildBuildings } from './world/buildings';
import { buildLandmarks } from './world/landmarks';
import { createProps } from './props';
import { createPeople } from './npc/people';
import { createCrowd } from './npc/crowd';
import { createTraffic } from './npc/traffic';
import { createUI, createProjector } from './ui';
import { createStore, STORAGE_PREFIX } from './ui/storage';
import { createAudio } from './audio/audio';
import { createFx } from './fx/fx';
import { createSession } from './gameplay/session';
import { createFeedback } from './gameplay/feedback';

const OVER_BEAT = 1.2; // s between the final whistle and the results screen

function webgl2(): boolean {
  try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; }
}

function fatal(title: string, text: string): void {
  const box = document.getElementById('boot-error');
  if (!box) return;
  box.querySelector('h1')!.textContent = title;
  box.querySelector('p')!.textContent = text;
  box.hidden = false;
}

async function boot(): Promise<void> {
  const app = document.getElementById('app')!;
  if (!webgl2()) {
    fatal('WebGL 2 is not available', 'Labib Rush needs WebGL 2. Try an up-to-date Chrome, Firefox, Safari or Edge, and make sure hardware acceleration is turned on.');
    return;
  }

  // Handlers are wired to the game once it exists; before that the UI is only showing loading.
  const h: UIHandlers = { onPlay() {}, onPause() {}, onResume() {}, onRestart() {}, onQuitToMenu() {}, onSettingsChange() {}, onUserGesture() {} };
  const handlers: UIHandlers = {
    onPlay: () => h.onPlay(), onPause: () => h.onPause(), onResume: () => h.onResume(), onRestart: () => h.onRestart(),
    onQuitToMenu: () => h.onQuitToMenu(), onSettingsChange: (s) => h.onSettingsChange(s), onUserGesture: () => h.onUserGesture(),
  };
  const ui = createUI(app, handlers);
  const audio = createAudio();
  let settings: Settings = ui.getSettings();
  audio.setSettings(settings);
  h.onUserGesture = () => audio.unlock(); // the menu music starts on the first gesture, even while loading
  audio.startMusic();
  audio.startAmbience();
  audio.setMenuMusic(true);

  // ---- loading progress: weighted tasks + the shared asset manager's byte progress -------------
  const TASKS = { lighting: 0.12, physics: 0.04, street: 0.18, buildings: 0.17, landmarks: 0.14, labib: 0.14, props: 0.08, people: 0.06, npcs: 0.05, compile: 0.07 } as const;
  type Task = keyof typeof TASKS;
  const done = new Set<Task>();
  let assetP = 0, shown = 0, label = 'Waking up Labib…';
  const LABELS: Record<Task, string> = {
    lighting: 'Lighting the golden hour', physics: 'Setting up physics', street: 'Paving the Avenue', buildings: 'Raising the façades',
    landmarks: 'Building the landmarks', labib: 'Grooming Labib’s ears', props: 'Scattering litter', people: 'Dressing the passers-by', npcs: 'Filling the cafés, calling the taxis', compile: 'Warming up shaders',
  };
  const paint = () => {
    let p = 0, pending = 0;
    for (const t of Object.keys(TASKS) as Task[]) { if (done.has(t)) p += TASKS[t]; else pending += TASKS[t]; }
    shown = Math.max(shown, Math.min(0.99, p + pending * assetP * 0.6));
    ui.setLoading(shown, label);
  };
  const task = async <T>(t: Task, p: Promise<T>): Promise<T> => {
    const v = await p;
    done.add(t);
    const next = (Object.keys(TASKS) as Task[]).find((k) => !done.has(k));
    label = next ? LABELS[next] : 'Yalla!';
    paint();
    return v;
  };
  paint();

  const engine = createEngine(app);
  engine.setQuality(settings.quality);

  const assets = new Assets(engine.renderer);
  assets.onProgress = (p) => { assetP = p; paint(); };
  label = LABELS.lighting;
  const [physics] = await Promise.all([task('physics', Physics.create()), task('lighting', engine.initLighting(assets))]);

  const uniforms = { uTime: { value: 0 }, uWind: { value: new Vector3(-1.2, 0.2, 0) } };
  const bctx = { physics, assets, quality: engine.quality, renderer: engine.renderer, uniforms };
  const fx = createFx(bctx);
  const [street, buildings, landmarks, labib, props, people] = await Promise.all([
    task('street', buildStreet(bctx)),
    task('buildings', buildBuildings(bctx)),
    task('landmarks', buildLandmarks(bctx)),
    task('labib', createLabib(bctx)),
    task('props', createProps(bctx)),
    task('people', createPeople(bctx)),
  ]);
  const scene = engine.scene;
  scene.add(street.root, buildings.root, landmarks.root, labib.root, fx.root);
  physics.step(); // builds the query pipeline for raycasts (spawn placement, camera)

  const events = new Emitter<GameEvents>();
  const player = createPlayerController(physics, labib, events);
  const rig = createCameraRig(engine.camera, physics, settings);
  const input = createInput(engine.renderer.domElement, settings);
  const ctx: GameContext = { engine, physics, assets, events, uniforms, input, player, cameraRig: rig, audio, fx, ui, anchors: street.anchors };
  const session = createSession(ctx, props);
  const feedback = createFeedback(ctx);
  // crowd + traffic build synchronously (nav grid, person pool): let the label paint first
  await new Promise((r) => setTimeout(r, 0));
  const npcs = await task('npcs', Promise.resolve().then(() => ({
    crowd: createCrowd(ctx, people, session.hooks),
    traffic: createTraffic(ctx, props, session.hooks),
  })));
  session.attach(npcs);
  ui.setProjector(createProjector(engine.camera));

  // compile every program under the loading screen (buildings/labib ask for it)
  rig.setMenuMode(true);
  rig.update(0.016, input.poll(), player);
  await task('compile', engine.renderer.compileAsync(scene, engine.camera).catch(() => undefined));

  // ---- state machine ------------------------------------------------------------------------
  type Mode = 'menu' | 'play' | 'over';
  let mode: Mode = 'menu';
  let paused = false;
  let overT = 0;
  let overResult: GameEvents['runEnd']['result'] | null = null;
  const store = createStore(STORAGE_PREFIX); // read-only use: the player's best before a run is saved

  function toMenu(): void {
    mode = 'menu';
    paused = false;
    input.setEnabled(false);
    rig.setMenuMode(true);
    audio.setPaused(false);
    audio.setMenuMusic(true);
  }
  async function startRun(): Promise<void> {
    paused = false;
    overResult = null;
    session.start();
    ui.enterGame();
    input.setEnabled(true);
    input.requestPointerLock();
    rig.setMenuMode(false);
    audio.setPaused(false);
    audio.setMenuMusic(false);
    audio.startMusic();
    mode = 'play';
  }
  function pause(): void {
    if (mode !== 'play' || paused) return;
    paused = true;
    input.setEnabled(false);
    audio.setPaused(true);
    ui.showPause();
    events.emit('pause', {});
  }
  function resume(): void {
    if (!paused) return;
    paused = false;
    input.setEnabled(true);
    input.requestPointerLock();
    audio.setPaused(false);
    events.emit('resume', {});
  }

  h.onUserGesture = () => audio.unlock();
  h.onPlay = () => void startRun();
  h.onRestart = () => void startRun();
  h.onPause = pause;
  h.onResume = resume;
  h.onQuitToMenu = () => { session.abort(); toMenu(); };
  h.onSettingsChange = (s) => {
    const qChanged = s.quality !== settings.quality;
    settings = s;
    audio.setSettings(s);
    input.setSettings(s);
    rig.setSettings(s);
    if (qChanged) {
      engine.setQuality(s.quality);
      fx.setQuality(engine.quality);
    }
  };
  events.on('runEnd', ({ result }) => {
    mode = 'over';
    overT = OVER_BEAT;
    overResult = result;
    input.setEnabled(false);
  });
  const autoPause = () => { if (mode === 'play') pause(); };
  document.addEventListener('visibilitychange', () => { if (document.hidden) autoPause(); });
  addEventListener('blur', autoPause);

  // ---- frame loop -----------------------------------------------------------------------------
  const zero: InputFrame = { move: { x: 0, y: 0 }, lookDX: 0, lookDY: 0, sprint: false, jumpPressed: false, jumpHeld: false, kickPressed: false, radarPressed: false, pausePressed: false };
  const lockedFrame: InputFrame = { ...zero, move: { x: 0, y: 0 } };
  const fwd = new Vector3();
  let acc = 0;
  let last = performance.now();

  // Frame cap: 30 fps on 'low'/'medium' (steadier on weak devices, saves battery), 60 on 'high'/'ultra'.
  // 2 ms slack so a 60 Hz display's rAF jitter doesn't drop frames.
  function frame(now: number): void {
    const minMs = 1000 / (engine.quality === 'low' || engine.quality === 'medium' ? 30 : 60) - 2;
    if (now - last < minMs) return;
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    if (document.hidden) return;
    const f = input.poll();
    if (mode === 'play' && f.pausePressed) pause();

    if (!paused) {
      const simDt = dt * feedback.timeScale;
      uniforms.uTime.value += simDt;
      const live = mode === 'play' && session.playing;
      let pf = zero;
      if (live) {
        pf = f;
        if (session.locked) { // countdown: look around, don't move
          lockedFrame.lookDX = f.lookDX; lockedFrame.lookDY = f.lookDY;
          pf = lockedFrame;
        }
      }
      player.update(simDt, pf, rig.yaw);
      acc += simDt;
      let steps = 0;
      while (acc >= FIXED_DT && steps < 5) { physics.step(); acc -= FIXED_DT; steps++; }
      if (steps === 5) acc = 0;
      if (live) session.update(simDt, f);
      else session.updateAmbient(simDt);
      rig.update(dt, live ? pf : zero, player);

      const cam = engine.camera.position;
      street.update?.(dt, uniforms.uTime.value, cam);
      landmarks.update?.(dt, uniforms.uTime.value, cam);
      fx.update(dt, cam);
      feedback.update(dt);
      engine.camera.getWorldDirection(fwd);
      audio.setListener(cam, fwd);

      if (mode === 'over' && overResult && (overT -= dt) <= 0) {
        const result = overResult;
        overResult = null;
        const best = store.bestScore(ui.getPlayerName());
        ui.showGameOver(result);
        if (result.score > 0 && (best === null || result.score > best)) {
          audio.play('newBest');
          fx.burst('confetti', player.position, { scale: 1.3 });
          npcs.crowd.cheer(player.position, 30);
        }
      }
    }
    engine.render(dt);
  }
  engine.renderer.setAnimationLoop(frame);

  toMenu();
  ui.finishLoading();

  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__game = {
      engine, physics, player, session, ui, events, rig, fx, crowd: npcs.crowd, traffic: npcs.traffic,
      get mode() { return mode; },
      get paused() { return paused; },
      teleport(x: number, z: number, yaw = player.yaw, y = PLAYER_SPAWN.y) { player.reset(new Vector3(x, y, z), yaw); rig.reset(yaw); },
      stats() {
        const i = engine.renderer.info;
        return { fps: Math.round(engine.fps), calls: i.render.calls, triangles: i.render.triangles, geometries: i.memory.geometries, textures: i.memory.textures, quality: engine.quality, scale: engine.resolutionScale, ...session.debug.counts(), heap: (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize };
      },
    };
    (window as unknown as Record<string, unknown>).__ready = true;
  }
}

boot().catch((e: unknown) => {
  console.error(e);
  fatal('Something went wrong', 'Labib tripped over a cable while loading. Please reload the page.');
});
