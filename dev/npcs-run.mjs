// Scripted run of dev/npcs.html (same Chromium launch args as scripts/shot.mjs).
// node dev/npcs-run.mjs "<url>" '<steps json>' [--size=1600x900]
// steps: [["wait", ms], ["eval", "js"], ["print", "js expr"], ["shot", "shots/x.png"]]
// The page's dev-server WebSocket is blocked so other agents' edits don't full-reload it mid-run.
import { chromium } from 'playwright-core';

const [url, stepsJson, ...rest] = process.argv.slice(2);
const opt = Object.fromEntries(rest.map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.join('=') || true]; }));
const [w, h] = String(opt.size || '1600x900').split('x').map(Number);
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || '/usr/bin/chromium',
  args: ['--use-angle=gl', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
});
const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
await page.routeWebSocket(/.*/, () => {});
let threw = false;
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[console.${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => { threw = true; console.log(`[pageerror] ${e.stack || e.message}`); });
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });
// let shaders compile / the first frames run
await page.waitForFunction(() => window.__npc.checks.frames > 30, null, { timeout: 120000 });
for (const [op, arg] of JSON.parse(stepsJson || '[]')) {
  if (op === 'wait') await page.waitForTimeout(arg);
  else if (op === 'eval') await page.evaluate(arg);
  else if (op === 'print') console.log(`[${arg.slice(0, 40)}]`, JSON.stringify(await page.evaluate(arg)));
  else if (op === 'shot') { await page.screenshot({ path: arg }); console.log('saved', arg); }
}
const stats = await page.evaluate(() => window.__stats).catch(() => null);
if (stats) console.log('[stats]', JSON.stringify(stats));
await browser.close();
process.exit(threw ? 1 : 0);
