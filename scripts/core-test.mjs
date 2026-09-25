// Core loop checks on dev/core.html: node scripts/core-test.mjs
// Real keyboard input (rAF-timed, the input path): acceleration, sprint, jump apex (held/tapped),
// kick event + cooldown, Esc, a key held through resume. Deterministic fixed-dt simulation
// (window.__core.sim): the same movement numbers, stopping, curb stepping, facade/tree collisions,
// knockback, camera clearance against walls, auto-recentre never steering in circles, no
// spring-arm pumping past trunks, over-the-head lift with a wall behind, trunk behind. Virtual
// clock: dynamic resolution under a 30 Hz cap, GPU-bound, and probe back-off.
// Prints PASS/FAIL/SKIP per check (SKIP = every try was frame-starved by other GPU users) and
// exits 1 on any failure.
import { chromium } from 'playwright-core';

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', args: ['--use-angle=gl', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.route('**/@vite/client', (r) => r.fulfill({ contentType: 'application/javascript', body: 'export {}' }));
await page.goto('http://127.0.0.1:5180/dev/core.html?q=low', { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 90000 });
await page.evaluate(() => {
  const c = window.__core;
  window.__kicks = 0;
  c.events.on('kick', () => window.__kicks++);
  window.__rec = null;
  const loop = () => {
    if (window.__rec) {
      const p = c.player;
      window.__rec.push({ t: performance.now(), x: p.position.x, y: p.position.y, z: p.position.z, vx: p.velocity.x, vy: p.velocity.y, vz: p.velocity.z, g: p.grounded, cam: c.cameraClearance() });
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
});

const results = [];
let starved = false; // set by record(): the samples behind the next checks are not trustworthy
const check = (name, ok, detail) => {
  if (starved) { console.log(`SKIP  ${name}  (frame-starved: >50 ms hitches on every try)  ${detail}`); return; }
  results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
};
const teleport = async (x, z, yawDeg) => { await page.evaluate(([x, z, y]) => window.__core.teleport(x, z, y), [x, z, yawDeg]); await page.waitForTimeout(400); };
// Records per-frame player state while fn runs. The GPU/CPU here are shared with other agents'
// browsers, so a timing-sensitive run that saw a >50 ms frame hitch is repeated (up to 4 tries).
const record = async (fn, tries = 4) => {
  for (let k = 0; ; k++) {
    await page.evaluate(() => { window.__rec = []; });
    await fn();
    const rec = await page.evaluate(() => { const r = window.__rec; window.__rec = null; const t0 = r[0].t; return r.map((s) => ({ ...s, t: (s.t - t0) / 1000 })); });
    const hitch = Math.max(...rec.slice(1).map((s, i) => s.t - rec[i].t));
    starved = hitch >= 0.05;
    if (!starved || k >= tries - 1) return rec;
  }
};
const hold = async (keys, ms) => { for (const k of keys) await page.keyboard.down(k); await page.waitForTimeout(ms); for (const k of [...keys].reverse()) await page.keyboard.up(k); };
const speed = (s) => Math.hypot(s.vx, s.vz);
const timeTo = (rec, v) => { const s0 = rec.find((s) => speed(s) > 0.05); const s1 = rec.find((s) => speed(s) >= v); return s0 && s1 ? s1.t - s0.t : Infinity; };

// 1) acceleration to run speed
let rec = await record(async () => { await teleport(-100, 0, 90); await hold(['KeyW'], 700); await page.waitForTimeout(500); });
const vmax = Math.max(...rec.map(speed));
check('run: top speed', Math.abs(vmax - 6.5) < 0.15, `max ${vmax.toFixed(2)} m/s`);
const tRun = timeTo(rec, 6.5 * 0.95);
check('run: 95% speed in ~0.2 s', tRun < 0.25, `${tRun.toFixed(3)} s`);

// 2) sprint
rec = await record(async () => { await teleport(-100, 0, 90); await hold(['ShiftLeft', 'KeyW'], 900); await page.waitForTimeout(300); });
const vs = Math.max(...rec.map(speed));
check('sprint: top speed', Math.abs(vs - 9.5) < 0.2, `max ${vs.toFixed(2)} m/s, 95% in ${timeTo(rec, 9.5 * 0.95).toFixed(3)} s`);

// 3) jump apex held vs tapped
rec = await record(async () => { await teleport(-100, 0, 90); await hold(['Space'], 700); await page.waitForTimeout(600); });
let y0 = rec[0].y, apex = Math.max(...rec.map((s) => s.y)) - y0;
check('jump (held): apex ≈ 1.5 m', Math.abs(apex - 1.5) < 0.12, `${apex.toFixed(3)} m`);
const landed = rec.at(-1).g && Math.abs(rec.at(-1).y - y0) < 0.02;
check('jump: lands back on the ground', landed, `y ${rec.at(-1).y.toFixed(3)} grounded ${rec.at(-1).g}`);
rec = await record(async () => { await teleport(-100, 0, 90); await hold(['Space'], 60); await page.waitForTimeout(900); });
y0 = rec[0].y; const apexTap = Math.max(...rec.map((s) => s.y)) - y0;
check('jump (tap): lower apex', apexTap < 1.0 && apexTap > 0.3, `${apexTap.toFixed(3)} m`);

// Collision and camera-clearance checks run as deterministic fixed-dt simulations (sim), so they
// hold on a busy machine. The input path itself is covered by the keyboard checks above.
const sim = (tp, frames, mx, my, opt) => page.evaluate(([tp, frames, mx, my, opt]) => { window.__core.teleport(...tp); return window.__core.sim(frames, mx, my, opt); }, [tp, frames, mx, my, opt]);
starved = false;

// stopping: run at full speed, release, time to a standstill
// the same movement numbers, deterministically (the keyboard runs above SKIP on a starved GPU)
{
  const r = await sim([-100, 0, 90], 60, 0, 1);
  const i95 = r.findIndex((q) => Math.hypot(q.vx, q.vz) >= 6.5 * 0.95);
  check('sim run: top speed in ~0.2 s', Math.abs(Math.hypot(r.at(-1).vx, r.at(-1).vz) - 6.5) < 0.05 && (i95 + 1) / 60 < 0.25, `${Math.hypot(r.at(-1).vx, r.at(-1).vz).toFixed(2)} m/s, 95% after ${((i95 + 1) / 60).toFixed(3)} s`);
  const sp = await sim([-100, 0, 90], 60, 0, 1, { sprint: true });
  check('sim sprint: top speed', Math.abs(Math.hypot(sp.at(-1).vx, sp.at(-1).vz) - 9.5) < 0.05, `${Math.hypot(sp.at(-1).vx, sp.at(-1).vz).toFixed(2)} m/s`);
  const jh = await sim([-100, 0, 90], 80, 0, 0, { jumpFrames: 60 });
  const jt = await sim([-100, 0, 90], 80, 0, 0, { jumpFrames: 4 });
  const apex = (q) => Math.max(...q.map((s) => s.y)) - 0.17;
  check('sim jump: held ≈ 1.5 m, tapped lower, lands', Math.abs(apex(jh) - 1.5) < 0.05 && apex(jt) < 1 && apex(jt) > 0.3 && jh.at(-1).g, `held ${apex(jh).toFixed(3)} m, tap ${apex(jt).toFixed(3)} m, grounded after ${jh.at(-1).g}`);
}
const [runUp, rel] = await page.evaluate(() => { const c = window.__core; c.teleport(-100, 0, 90); return [c.sim(60, 0, 1), c.sim(40, 0, 0)]; });
const iStop = rel.findIndex((s) => Math.hypot(s.vx, s.vz) < 0.1);
check('run: stops quickly', iStop >= 0 && iStop / 60 < 0.3, `${iStop < 0 ? 'never' : ((iStop + 1) / 60).toFixed(3) + ' s'} from ${Math.hypot(runUp.at(-1).vx, runUp.at(-1).vz).toFixed(2)} m/s`);

// 4) curbs: promenade → (down 0.15) road → (up 0.15) sidewalk → facade
rec = await sim([-103, 11, 0], 216, 0, 1);
const airFrames = rec.filter((s) => !s.g).length;
const zCurb1 = rec.findIndex((s) => s.z > 14.2), zCurb2 = rec.findIndex((s) => s.z > 22.2);
// average ground speed over ±0.2 s around each curb (single contact frames are expected)
const crossSpeed = (i) => { if (i < 0) return 0; const t = rec[i].t, a = rec.find((s) => s.t >= t - 0.2), b = [...rec].reverse().find((s) => s.t <= t + 0.2); return (b.z - a.z) / (b.t - a.t); };
const minV1 = crossSpeed(zCurb1), minV2 = crossSpeed(zCurb2);
const yRoad = rec.find((s) => s.z > 16 && s.z < 20)?.y ?? NaN, ySide = rec.find((s) => s.z > 24)?.y ?? NaN;
check('curbs: stay grounded', airFrames <= 2, `${airFrames} airborne frames`);
check('curbs: no speed loss', minV1 > 5.85 && minV2 > 5.85, `speed across down-curb ${minV1.toFixed(2)}, up-curb ${minV2.toFixed(2)} m/s`);
check('curbs: heights', Math.abs(yRoad - 0) < 0.02 && Math.abs(ySide - 0.15) < 0.02, `road y ${yRoad.toFixed(3)}, sidewalk y ${ySide.toFixed(3)}`);
const zEnd = rec.at(-1).z;
check('facade: cannot pass', zEnd < 30 - 0.33 && zEnd > 29, `stopped at z ${zEnd.toFixed(3)} (wall at 30, radius 0.35)`);

// 5) slide along a facade: diagonal into the north wall
rec = await sim([-100, -27, 180], 72, Math.SQRT1_2, Math.SQRT1_2);
const dx = Math.abs(rec.at(-1).x - rec[0].x), zMin = Math.min(...rec.map((s) => s.z));
check('facade: slides along the wall', dx > 3 && zMin > -30 + 0.33, `slid ${dx.toFixed(2)} m, min z ${zMin.toFixed(3)}`);

// 6) trees block
const tx = -234 + 8.5 * 10;
rec = await sim([tx - 3, 9.5, 90], 72, 0, 1);
check('tree trunk blocks', rec.at(-1).x < tx - 0.6, `stopped at x ${rec.at(-1).x.toFixed(2)} (trunk at ${tx}, r 0.3)`);

// 7) camera clearance with the camera forced toward walls, trees and kiosks
const camCases = [
  ['against north facade', -100, -29.5, 0],
  ['alley mouth corner', -63.5, -30.6, 135],
  ['trunk behind the player', -234 + 8.5 * 12 + 0.75, 9.5, 90],
  ['kiosk behind the player', -125, -4 + 1.75, 0],
];
for (const [name, x, z, yaw] of camCases) {
  rec = await sim([x, z, yaw], 42, 0, 0);
  const minC = Math.min(...rec.slice(1).map((s) => s.clear));
  check(`camera: clear of statics (${name})`, minC > 0.02, `min clearance ${minC.toFixed(3)} m`);
}
rec = await sim([-100, -28.6, 90], 90, -1, 0);
check('camera: clear while running along a wall', Math.min(...rec.slice(1).map((s) => s.clear)) > 0.02, `min clearance ${Math.min(...rec.slice(1).map((s) => s.clear)).toFixed(3)} m`);

// 8) kick event + 0.35 s cooldown
starved = false;
await teleport(-100, 0, 90);
await page.evaluate(() => { window.__kicks = 0; });
for (let i = 0; i < 5; i++) { await page.keyboard.press('KeyF'); await page.waitForTimeout(50); }
const kicks = await page.evaluate(() => window.__kicks);
check('kick: event with cooldown', kicks >= 1 && kicks <= 2, `${kicks} kicks from 5 presses in 0.25 s`);

// 9) knockback: stunned, input ignored, slides to a stop (deterministic: hit, then hold S)
const kb = await page.evaluate(() => {
  const c = window.__core;
  c.teleport(-100, 0, 90);
  c.sim(5, 0, 0);
  const x0 = c.player.position.x;
  c.player.knockback(new c.THREE.Vector3(1, 0, 0), 9, 1);
  const r = c.sim(54, 0, -1); // 0.9 s: still stunned
  return { moved: r.at(-1).x - x0, air: r.some((s) => !s.g) };
});
check('knockback: pushed along the hit direction', kb.moved > 2 && kb.air, `moved ${kb.moved.toFixed(2)} m on +X while holding S (hop: ${kb.air})`);

// 10) deterministic camera behaviour
starved = false;
/** Mean turning radius of the run (path length / total heading change), m. */
const turnRadius = (r) => {
  const mv = r.filter((s) => Math.hypot(s.vx, s.vz) > 3);
  let turn = 0, len = 0;
  for (let i = 1; i < mv.length; i++) {
    const d = Math.atan2(mv[i].vx, mv[i].vz) - Math.atan2(mv[i - 1].vx, mv[i - 1].vz);
    turn += Math.atan2(Math.sin(d), Math.cos(d));
    len += Math.hypot(mv[i].x - mv[i - 1].x, mv[i].z - mv[i - 1].z);
  }
  return Math.abs(turn) > 1e-3 ? len / Math.abs(turn) : Infinity;
};
let r = await sim([-300, -18, 180], 300, 1, 0); // west plaza, hold D 5 s, no look input
check('recentre: strafing runs straight', turnRadius(r) > 200, `turn radius ${turnRadius(r).toFixed(0)} m over ${(r.length / 60).toFixed(0)} s`);
r = await sim([-300, -25, 135], 300, Math.SQRT1_2, Math.SQRT1_2); // hold W+D
check('recentre: diagonal curves gently', turnRadius(r) >= 20, `turn radius ${turnRadius(r).toFixed(1)} m`);
r = await sim([-225, 8.6, 120], 240, 0.5, 0.866, { lookDX: 1e-9 }); // run past the south tree row, camera across it
const pump = Math.max(...r.slice(1).map((s, i) => r[i].arm - s.arm));
check('spring arm: no pumping past trunks', pump < 0.3 && Math.min(...r.slice(5).map((s) => s.clear)) > 0.02, `largest one-frame pull-in ${pump.toFixed(2)} m, 3 trunks passed`);
r = await sim([-100, -29.2, 0], 90, 0, 0); // back to a facade
const w = r.at(-1);
check('spring arm: rises over the head with a wall behind', w.clear > 0.02 && w.arm > 1 && w.avatar, `arm ${w.arm.toFixed(2)} m from the head, clearance ${w.clear.toFixed(2)} m`);
r = await sim([-234 + 8.5 * 12 + 0.75, 9.5, 90], 90, 0, 0); // trunk 0.75 m behind Labib
check('spring arm: a trunk behind does not collapse the arm', r.at(-1).arm > 4 && r.at(-1).clear > 0.02, `arm ${r.at(-1).arm.toFixed(2)} m`);

// 11) Esc pauses (keyboard path; pointer-lock loss is the same flag)
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
const paused = await page.evaluate(() => document.getElementById('dev-pause').classList.contains('on'));
check('Esc → pausePressed', paused, `pause overlay ${paused ? 'shown' : 'missing'}`);

// 12) a key held through the pause works as soon as play resumes (no re-press needed)
await page.keyboard.down('KeyW');
await page.waitForTimeout(200);
const xBefore = await page.evaluate(() => window.__core.player.position.x);
await page.click('#dev-pause');
await page.waitForTimeout(600);
const xAfter = await page.evaluate(() => window.__core.player.position.x);
await page.keyboard.up('KeyW');
check('held key survives resume', xAfter - xBefore > 1, `moved ${(xAfter - xBefore).toFixed(2)} m after resuming with W held`);

// 13) dynamic-resolution heuristics against a virtual clock: engine.render() is called directly
// while performance.now() reports a modelled frame time (GPU-bound ∝ pixels, or a 30 Hz cap).
// The scene is hidden to keep the real rendering cheap; this ends the rAF loop, so it runs last.
const dyn = await page.evaluate(() => {
  const e = window.__core.engine, realNow = performance.now.bind(performance);
  e.renderer.setAnimationLoop(null);
  e.scene.children.forEach((o) => { o.visible = false; });
  let clock = realNow();
  performance.now = () => clock;
  const run = (seconds, frameMs) => {
    e.setQuality('low');
    e.dynamicResolution = false; e.dynamicResolution = true; // back to scale 1
    const trace = [];
    let ups = 0, last = e.resolutionScale;
    for (let t = 0; t < seconds * 1000;) {
      const ms = frameMs(e.resolutionScale);
      clock += ms; t += ms;
      e.render(ms / 1000);
      if (e.resolutionScale > last) ups++;
      if (e.resolutionScale !== last) trace.push(`${(t / 1000).toFixed(1)}s→${e.resolutionScale}`);
      last = e.resolutionScale;
    }
    return { scale: e.resolutionScale, ups, trace: trace.join(' ') };
  };
  const cap = run(12, () => 1000 / 30); // 30 Hz cap: frame time never improves
  const gpu = run(12, (sc) => 25 * sc * sc); // GPU-bound: 40 fps at full resolution
  const edge = run(120, (sc) => 18.5 * sc * sc); // 54 fps native: every probe back to 1.0 fails
  performance.now = realNow;
  return { cap, gpu, edge };
});
check('dynamic res: a 30 Hz cap keeps full resolution', dyn.cap.scale === 1, `final scale ${dyn.cap.scale} (${dyn.cap.trace})`);
check('dynamic res: GPU-bound scales down to the target', dyn.gpu.scale < 1 && dyn.gpu.scale >= 0.8, `final scale ${dyn.gpu.scale} (${dyn.gpu.trace})`);
check('dynamic res: failed probes back off', dyn.edge.ups <= 5, `${dyn.edge.ups} step-ups in 120 s (${dyn.edge.trace})`);

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
