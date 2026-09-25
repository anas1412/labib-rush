// Core perf report on dev/core.html: node scripts/core-perf.mjs [--view=x,z,yawDeg] [--size=1600x900] [--q=low,high] [--cap=30]
// --cap=30 halves the rAF rate (a 30 Hz frame cap: battery saver, 30 Hz panel) and checks that
// dynamic resolution and autoDetectQuality() recognise the cap instead of dropping quality.
// Per preset:
//   gpuMs    - GPU-bound frame time: N frames rendered back-to-back, then a 1-px readPixels sync
//              (best of several reps over --rounds=3 interleaved rounds: this machine's GPU is
//              shared with the desktop/other agents)
//   fps      - real vsync'd requestAnimationFrame rate, dynamic resolution OFF (scale 1)
//   dynFps   - same with dynamic resolution ON after it settles, and the scale it settled at
// Then runs engine.autoDetectQuality() from a fresh page and prints the preset it picks.
import { chromium } from 'playwright-core';

const opt = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.join('=') || true]; }));
const [w, h] = String(opt.size || '1600x900').split('x').map(Number);
const view = String(opt.view || '-236,0,90');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', args: ['--use-angle=gl', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] });
const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
// no HMR client: other agents' edits must not reload the page mid-measurement
await page.route('**/@vite/client', (r) => r.fulfill({ contentType: 'application/javascript', body: 'export {}' }));
if (opt.cap) {
  // every rAF callback waits one extra vsync: loops that re-request each frame run at 30 Hz
  await page.addInitScript(() => { const raf = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = (cb) => raf(() => raf(cb)); });
}
const open = async () => {
  await page.goto(`http://127.0.0.1:5180/dev/core.html?spawn=${view}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 90000 });
};
await open();

const rafFps = (sec) => page.evaluate((sec) => new Promise((res) => {
  const t = []; const t0 = performance.now();
  const f = (now) => { t.push(now); if (now - t0 < sec * 1000) requestAnimationFrame(f); else res(1000 * (t.length - 1) / (t.at(-1) - t[0])); };
  requestAnimationFrame(f);
}), sec);
const gpuMs = () => page.evaluate(() => {
  const e = window.__core.engine, gl = e.renderer.getContext(), px = new Uint8Array(4);
  const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let best = 1e9;
  for (let k = 0; k < 6; k++) { sync(); const t0 = performance.now(); for (let i = 0; i < 15; i++) e.render(1 / 60); sync(); best = Math.min(best, (performance.now() - t0) / 15); }
  return best;
});

if (opt.cap) {
  await page.evaluate((q) => window.__core.setQuality(q), String(opt.q || 'high'));
  const trace = [];
  for (let i = 0; i < 14; i++) { await page.waitForTimeout(1000); trace.push(await page.evaluate(() => `${window.__core.engine.fps.toFixed(0)}fps@${window.__core.engine.resolutionScale}`)); }
  console.log('dynamic resolution under a 30 Hz cap (1 s samples):', trace.join(' '));
  const picked = await page.evaluate(() => window.__core.engine.autoDetectQuality());
  console.log(`autoDetectQuality() under the cap → ${picked}`);
  await browser.close();
  process.exit(0);
}
const rows = {};
const presets = opt.q ? String(opt.q).split(',') : ['low', 'medium', 'high', 'ultra'];
// GPU time first, interleaved over several rounds (best of all): other GPU users come and go
for (let round = 0; round < Number(opt.rounds || 3); round++) {
  for (const q of presets) {
    await page.evaluate((q) => { const e = window.__core.engine; e.dynamicResolution = false; e.setQuality(q); }, q);
    await page.waitForTimeout(1000);
    const g = await gpuMs();
    const info = await page.evaluate(() => window.__core.engine.renderer.info.render);
    rows[q] ??= { gpuMs: Infinity, calls: info.calls, tris: info.triangles };
    rows[q].gpuMs = Math.min(rows[q].gpuMs, +g.toFixed(1));
  }
}
for (const q of presets) {
  await page.evaluate((q) => { const e = window.__core.engine; e.dynamicResolution = false; e.setQuality(q); }, q);
  await page.waitForTimeout(1200);
  const fps = await rafFps(3);
  await page.evaluate(() => { window.__core.engine.dynamicResolution = true; });
  await page.waitForTimeout(9000); // let it settle
  const dynFps = await rafFps(3);
  const scale = await page.evaluate(() => window.__core.engine.resolutionScale);
  Object.assign(rows[q], { fps: +fps.toFixed(1), dynFps: +dynFps.toFixed(1), dynScale: scale });
}
console.table(rows);

await open();
const t0 = Date.now();
const picked = await page.evaluate(() => window.__core.engine.autoDetectQuality());
console.log(`autoDetectQuality() → ${picked} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
await browser.close();
