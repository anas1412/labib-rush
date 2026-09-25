// NPC dev page: the real street (+ buildings and landmarks unless ?lite=1), props, people, and the
// crowd / birds / traffic systems, with the real Labib + controller + camera rig. A fake session
// provides SessionHooks (thrown litter flies ballistically, "caught" removes it, a taxi hit knocks
// Labib back). Drive with WASD/Shift/mouse, or script it through window.__npc.
// Params: ?q=high  ?lite=1  ?play=0 (menu behaviour: no litterbugs/honks/hits)  ?spawn=x,z,yawDeg
//         ?cam=x,y,z&target=x,y,z (fixed camera)  ?fov=  ?route=x,z;x,z;… (autopilot loop)  ?sprint=1
//         ?chase=1 (autopilot chases litterbugs)  ?murmur=1 (starlings now)  ?bugs=1 (force a litterbug near Labib every 4 s)  ?dr=0 (no dynamic res)
import * as THREE from 'three';
import { Assets } from '../src/core/assets';
import { Emitter } from '../src/core/events';
import { FIXED_DT, G, groups, Physics } from '../src/core/physics';
import { CURB } from '../src/core/layout';
import { RULES } from '../src/core/config';
import {
  DEFAULT_SETTINGS, type AudioEngine, type Fx, type GameContext, type GameEvents, type InputFrame, type Quality,
  type SessionHooks, type UIController,
} from '../src/core/types';
import { createEngine } from '../src/core/engine';
import { createInput } from '../src/core/input';
import { createPlayerController } from '../src/player/controller';
import { createCameraRig } from '../src/player/cameraRig';
import { createLabib } from '../src/player/labib';
import { buildStreet } from '../src/world/street';
import { buildBuildings } from '../src/world/buildings';
import { buildLandmarks } from '../src/world/landmarks';
import { createProps } from '../src/props';
import { createPeople } from '../src/npc/people';
import { createCrowd } from '../src/npc/crowd';
import { createTraffic } from '../src/npc/traffic';

const params = new URLSearchParams(location.search);
const vec3 = (s: string | null) => (s ? new THREE.Vector3(...(s.split(',').map(Number) as [number, number, number])) : null);
const hudEl = document.getElementById('hud')!;
if (params.get('hud') === '0') hudEl.style.display = 'none';

const engine = createEngine(document.getElementById('app')!);
const q = (params.get('q') as Quality | null) ?? 'high';
engine.setQuality(q);
if (params.get('dr') === '0') engine.dynamicResolution = false;
const assets = new Assets(engine.renderer);
await engine.initLighting(assets);
const physics = await Physics.create();
const uniforms = { uTime: { value: 0 }, uWind: { value: new THREE.Vector3(1.5, 0.3, 0.5) } };
const bctx = { physics, assets, quality: engine.quality, renderer: engine.renderer, uniforms };
const t0 = performance.now();
const street = await buildStreet(bctx);
engine.scene.add(street.root);
if (params.get('lite') !== '1') {
  const [bld, lm] = await Promise.all([buildBuildings(bctx), buildLandmarks(bctx)]);
  engine.scene.add(bld.root, lm.root);
}
const [props, people, labib] = await Promise.all([createProps(bctx), createPeople(bctx), createLabib(bctx)]);
physics.step();
const worldMs = performance.now() - t0;

const settings = { ...DEFAULT_SETTINGS };
const events = new Emitter<GameEvents>();
const input = createInput(engine.renderer.domElement, settings);
engine.scene.add(labib.root);
const player = createPlayerController(physics, labib, events);
const rig = createCameraRig(engine.camera, physics, settings);
const sp = params.get('spawn')?.split(',').map(Number);
const spawnPos = sp ? new THREE.Vector3(sp[0], CURB + 0.02, sp[1]) : new THREE.Vector3(-60, CURB + 0.02, 1);
const spawnYaw = sp ? THREE.MathUtils.degToRad(sp[2] ?? 90) : Math.PI / 2;
player.reset(spawnPos, spawnYaw);
rig.reset(spawnYaw);
input.setEnabled(true);
engine.renderer.domElement.addEventListener('click', () => input.requestPointerLock());

// --- fake session ---------------------------------------------------------------------------------
let playing = params.get('play') !== '0';
interface Item { obj: THREE.Object3D; x: number; y: number; z: number; vx: number; vy: number; vz: number; id: number; age: number }
const items: Item[] = [];
let nextId = 1;
const log = { thrown: 0, caught: 0, hits: 0, honks: 0, litterEvents: 0, events: [] as string[] };
const groundY = (x: number, z: number) => (Math.abs(z) > 14 && Math.abs(z) < 22 && x > -240 && x < 260 ? 0 : CURB);
const kinds = ['can', 'bottle', 'chips'] as const;
const hooks: SessionHooks = {
  throwLitter(from, velocity) {
    const obj = props.litter(kinds[nextId % 3]);
    engine.scene.add(obj);
    const id = nextId++;
    items.push({ obj, x: from.x, y: from.y, z: from.z, vx: velocity.x, vy: velocity.y, vz: velocity.z, id, age: 0 });
    log.thrown++;
    log.events.push(`thrown #${id} t=${time.toFixed(1)}`);
    events.emit('litterThrown', { position: from.clone() }); // the real session's hook emits it too
    return id;
  },
  caught(position, litterId) {
    const k = items.findIndex((i) => i.id === litterId);
    if (k >= 0) { items[k].obj.removeFromParent(); items.splice(k, 1); }
    log.caught++;
    log.events.push(`caught #${litterId} at ${position.x.toFixed(1)},${position.z.toFixed(1)} t=${time.toFixed(1)}`);
  },
  player: () => ({ position: player.position, velocity: player.velocity, sprinting: frame.sprint && Math.hypot(player.velocity.x, player.velocity.z) > 7 }),
  hitPlayer(direction, speed) {
    player.knockback(direction, 9, RULES.hitStun);
    rig.shake(0.7);
    log.hits++;
    log.events.push(`hit v=${speed.toFixed(1)} t=${time.toFixed(1)}`);
  },
  isPlaying: () => playing,
};
events.on('honk', () => { log.honks++; });
events.on('litterThrown', () => { log.litterEvents++; });

const stub = <T,>() => new Proxy({}, { get: () => () => undefined }) as T;
const ctx: GameContext = {
  engine, physics, assets, events, uniforms, input, player, cameraRig: rig,
  audio: stub<AudioEngine>(), fx: stub<Fx>(), ui: stub<UIController>(), anchors: street.anchors,
};
const tc = performance.now();
const crowd = createCrowd(ctx, people, hooks);
const traffic = createTraffic(ctx, props, hooks);
const npcMs = performance.now() - tc;
if (params.get('murmur') === '1') crowd.debug.birds.murmurate();

// --- scripted input ---------------------------------------------------------------------------------
const frame: InputFrame = { move: { x: 0, y: 0 }, lookDX: 0, lookDY: 0, sprint: false, jumpPressed: false, jumpHeld: false, kickPressed: false, radarPressed: false, pausePressed: false };
let auto: { pts: THREE.Vector2[]; i: number; sprint: boolean } | null = null;
const routeParam = params.get('route');
if (routeParam) auto = { pts: routeParam.split(';').map((p) => new THREE.Vector2(...(p.split(',').map(Number) as [number, number]))), i: 0, sprint: params.get('sprint') === '1' };
let hold: { x: number; y: number; sprint: boolean; yaw: number } | null = null;
let chase = params.get('chase') === '1';
const fixedCam = vec3(params.get('cam')), fixedTarget = vec3(params.get('target'));
if (params.has('fov')) { engine.camera.fov = Number(params.get('fov')); engine.camera.updateProjectionMatrix(); }

// --- self checks ------------------------------------------------------------------------------------
const checks = { frames: 0, walkerOverlaps: 0, walkerSamples: 0, worst: [] as string[], carOverlaps: 0, carOffRoad: 0, minCarGap: 1e9 };
const probe = new physics.R.Cylinder(0.55, 0.16);
const rot = { x: 0, y: 0, z: 0, w: 1 };
function checkWalkers(): void {
  for (const w of crowd.debug.walkers()) {
    checks.walkerSamples++;
    let hit: string | null = null;
    physics.world.intersectionsWithShape({ x: w.x, y: CURB + 0.85, z: w.z }, rot, probe, (c) => {
      if (c.parent()) return true;
      const t = c.translation();
      hit = `${t.x.toFixed(1)},${t.y.toFixed(2)},${t.z.toFixed(1)}`;
      return false;
    }, undefined, groups(0xffff, G.STATIC | G.LOW_PROP));
    if (hit) { checks.walkerOverlaps++; if (checks.worst.length < 12) checks.worst.push(`walker ${w.x.toFixed(1)},${w.z.toFixed(1)} mode ${w.mode} in collider @${hit}`); }
  }
}
function checkCars(): void {
  const cs = traffic.debug.cars();
  for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) {
    const a = cs[i], b = cs[j];
    const d = Math.hypot(a.x - b.x, a.z - b.z);
    checks.minCarGap = Math.min(checks.minCarGap, d);
    if (d < 6 && obbOverlap(a, b)) { checks.carOverlaps++; if (checks.worst.length < 12) checks.worst.push(`cars overlap ${a.x.toFixed(1)},${a.z.toFixed(1)} / ${b.x.toFixed(1)},${b.z.toFixed(1)}`); }
  }
  for (const c of cs) {
    // body corners must stay on asphalt (road bands, arms) — never the promenade or sidewalks
    for (const [lf, lr] of [[2.2, 0.88], [2.2, -0.88], [-2.3, 0.88], [-2.3, -0.88]]) {
      const fx = Math.sin(c.yaw), fz = Math.cos(c.yaw);
      const x = c.x + fx * lf - fz * lr, z = c.z + fz * lf + fx * lr;
      const az = Math.abs(z);
      const onAve = x > -240.2 && x < 260.2 && az > 13.9 && az < 22.1;
      const onArm = az >= 21.9 && (Math.abs(x + 234) < 4.1 || Math.abs(x - 254) < 4.1);
      if (!onAve && !onArm) { checks.carOffRoad++; if (checks.worst.length < 12) checks.worst.push(`car corner off road ${x.toFixed(2)},${z.toFixed(2)}`); }
    }
  }
}
function obbOverlap(a: { x: number; z: number; yaw: number }, b: { x: number; z: number; yaw: number }): boolean {
  const axes = [a.yaw, a.yaw + Math.PI / 2, b.yaw, b.yaw + Math.PI / 2];
  const corners = (c: { x: number; z: number; yaw: number }) => {
    const fx = Math.sin(c.yaw), fz = Math.cos(c.yaw);
    return [[2.17, 0.88], [2.17, -0.88], [-2.17, 0.88], [-2.17, -0.88]].map(([f, r]) => [c.x + fx * f - fz * r, c.z + fz * f + fx * r]);
  };
  const ca = corners(a), cb = corners(b);
  for (const ang of axes) {
    const ax = Math.sin(ang), az = Math.cos(ang);
    const pa = ca.map(([x, z]) => x * ax + z * az), pb = cb.map(([x, z]) => x * ax + z * az);
    if (Math.max(...pa) < Math.min(...pb) || Math.max(...pb) < Math.min(...pa)) return false;
  }
  return true;
}

/** Draw calls per system: render with each hidden, diff against all visible. */
function callBreakdown(): Record<string, number> {
  const taxis: THREE.Object3D[] = [];
  engine.scene.traverse((o) => { if (o.name.startsWith('taxi-')) taxis.push(o); });
  const crowdRoot = engine.scene.getObjectByName('crowd')!;
  const birds = crowd.debug.birds.root;
  const persons: THREE.Object3D[] = [];
  crowdRoot.traverse((o) => { if (o.name.startsWith('person-') && o.parent === crowdRoot) persons.push(o); });
  const measure = () => { engine.render(0); return engine.renderer.info.render.calls; };
  const all = measure();
  const toggle = (objs: THREE.Object3D[], fn: () => void) => {
    const vis = objs.map((o) => o.visible);
    objs.forEach((o) => (o.visible = false));
    fn();
    objs.forEach((o, i) => (o.visible = vis[i]));
  };
  let noPeople = 0, noBirds = 0, noTaxis = 0, noCrowd = 0;
  toggle(persons, () => { noPeople = measure(); });
  toggle([birds], () => { noBirds = measure(); });
  toggle(taxis, () => { noTaxis = measure(); });
  toggle([crowdRoot], () => { noCrowd = measure(); });
  const visTaxis = taxis.filter((t) => t.visible).length;
  return { all, people: all - noPeople, birds: all - noBirds, taxis: all - noTaxis, crowdTotal: all - noCrowd, taxisOn: visTaxis, perTaxi: visTaxis ? +((all - noTaxis) / visTaxis).toFixed(1) : 0 };
}

// --- loop ---------------------------------------------------------------------------------------------
let time = 0, acc = 0, frames = 0, fpsAcc = 0, fps = 0, bugT = 2;
const timer = new THREE.Timer();
const cpu = { crowd: 0, traffic: 0 };
engine.renderer.setAnimationLoop(() => {
  timer.update();
  const dt = Math.min(timer.getDelta(), 0.1);
  time += dt;
  uniforms.uTime.value = time;
  let f = input.poll();
  if (chase) {
    // autopilot toward the nearest litterbug (warning / throwing / catch-me)
    let best: { x: number; z: number } | null = null, bd = 1e9;
    for (const w of crowd.debug.walkers()) if (w.bug >= 1 && w.bug <= 3) { const d = (w.x - player.position.x) ** 2 + (w.z - player.position.z) ** 2; if (d < bd) { bd = d; best = w; } }
    if (best) auto = { pts: [new THREE.Vector2(best.x, best.z)], i: 0, sprint: bd > 16 };
    else if (auto && auto.pts.length === 1) { auto = null; hold = { x: 0, y: 0, yaw: player.yaw, sprint: false }; }
  }
  if (auto || hold) {
    const p = player.position;
    let yaw = 0, mx = 0, my = 1, sprint = false;
    if (auto) {
      const tgt = auto.pts[auto.i];
      if (Math.hypot(tgt.x - p.x, tgt.y - p.z) < 1.5) auto.i = (auto.i + 1) % auto.pts.length;
      yaw = Math.atan2(tgt.x - p.x, tgt.y - p.z);
      sprint = auto.sprint;
    } else if (hold) { yaw = hold.yaw; mx = hold.x; my = hold.y; sprint = hold.sprint; }
    Object.assign(frame, f, { move: { x: mx, y: my }, sprint, lookDX: -wrap(yaw - rig.yaw) * Math.min(1, dt * 2.5) });
    f = frame;
    player.update(dt, f, yaw);
  } else {
    Object.assign(frame, f);
    player.update(dt, f, rig.yaw);
  }
  acc += dt;
  for (let i = 0; acc >= FIXED_DT && i < 5; i++) { physics.step(); acc -= FIXED_DT; }
  acc = Math.min(acc, FIXED_DT);
  rig.update(dt, f, player);
  if (fixedCam) { engine.camera.position.copy(fixedCam); engine.camera.lookAt(fixedTarget ?? new THREE.Vector3()); }
  // litter flight
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    it.age += dt;
    const gy = groundY(it.x, it.z);
    if (it.y > gy + 0.001 || it.vy > 0) {
      it.vy -= 9.81 * 1.6 * dt;
      it.x += it.vx * dt; it.y += it.vy * dt; it.z += it.vz * dt;
      if (it.y < gy) { it.y = gy; it.vy = 0; it.vx *= 0.3; it.vz *= 0.3; }
    }
    it.obj.position.set(it.x, it.y, it.z);
    if (it.age > 40) { it.obj.removeFromParent(); items.splice(i, 1); }
  }
  if (params.get('bugs') === '1') { bugT -= dt; if (bugT <= 0) { bugT = 4; crowd.debug.forceLitterbug(player.position.x, player.position.z); } }
  let c0 = performance.now();
  crowd.update(dt, time);
  cpu.crowd += (performance.now() - c0 - cpu.crowd) * 0.05;
  c0 = performance.now();
  traffic.update(dt, time);
  cpu.traffic += (performance.now() - c0 - cpu.traffic) * 0.05;
  street.update?.(dt, time, engine.camera.position);
  engine.render(dt);
  checks.frames++;
  if (checks.frames % 10 === 0) { checkWalkers(); checkCars(); }
  frames++; fpsAcc += dt;
  if (fpsAcc > 0.5) {
    fps = Math.round(frames / fpsAcc); frames = 0; fpsAcc = 0;
    const info = engine.renderer.info.render;
    (window as unknown as { __stats: unknown }).__stats = { fps, calls: info.calls, triangles: info.triangles };
    const b = crowd.debug.birds.stats;
    hudEl.textContent = [
      `fps ${fps}  calls ${info.calls}  tris ${(info.triangles / 1000).toFixed(0)}k  scale ${engine.resolutionScale.toFixed(2)}  q ${engine.quality}`,
      `walkers ${crowd.debug.walkers().length}  bodies ${crowd.debug.bodies()}  taxis ${traffic.debug.cars().length}  pigeons flying ${b.flying}/${b.pigeons}  starlings ${b.murmuration.toFixed(2)}`,
      `thrown ${log.thrown}  caught ${log.caught}  honks ${log.honks}  hits ${log.hits}  playing ${playing}`,
      `cpu crowd ${cpu.crowd.toFixed(2)} ms  traffic ${cpu.traffic.toFixed(2)} ms`,
      `overlaps walker ${checks.walkerOverlaps}/${checks.walkerSamples}  car ${checks.carOverlaps}  offroad ${checks.carOffRoad}`,
      `labib ${player.position.x.toFixed(1)}, ${player.position.z.toFixed(1)}`,
    ].join('\n');
  }
});

function wrap(a: number): number { return Math.atan2(Math.sin(a), Math.cos(a)); }

Object.assign(window, {
  __npc: {
    crowd, traffic, player, rig, engine, log, checks, cpu, items,
    timing: { worldMs, npcMs },
    graph: crowd.debug.graph,
    setPlaying(on: boolean) { playing = on; },
    chase(on = true) { chase = on; },
    route(pts: [number, number][], sprint = false) { auto = { pts: pts.map(([x, z]) => new THREE.Vector2(x, z)), i: 0, sprint }; hold = null; },
    hold(x: number, y: number, yaw: number, sprint = false) { hold = { x, y, yaw, sprint }; auto = null; },
    stop() { auto = null; hold = { x: 0, y: 0, yaw: player.yaw, sprint: false }; },
    teleport(x: number, z: number, yawDeg = 90) { player.reset(new THREE.Vector3(x, CURB + 0.02, z), THREE.MathUtils.degToRad(yawDeg)); rig.reset(THREE.MathUtils.degToRad(yawDeg)); },
    callBreakdown,
    /** Put Labib in the lane `dist` m ahead of a taxi driving the avenue (honk / stop / hit test). */
    standBeforeTaxi(dist = 30) {
      const c = traffic.debug.cars().find((k) => Math.abs(Math.abs(k.z) - 18) < 2.5 && k.x > -200 && k.x < 220 && k.v > 5);
      if (!c) return false;
      const x = c.x + Math.sin(c.yaw) * dist, z = c.z;
      player.reset(new THREE.Vector3(x, 0.02, z), c.yaw + Math.PI);
      rig.reset(c.yaw + Math.PI);
      auto = null; hold = { x: 0, y: 0, yaw: c.yaw + Math.PI, sprint: false };
      return { x, z };
    },
    forceLitterbug: () => crowd.debug.forceLitterbug(player.position.x, player.position.z),
    murmurate: () => crowd.debug.birds.murmurate(),
    cheer: (r = 12) => crowd.cheer(player.position, r),
    reset: () => { crowd.reset(); traffic.reset(); },
  },
  __ready: true,
});
