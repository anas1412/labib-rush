// Screenshot helper: node scripts/shot.mjs <url> <out.png> [--ready] [--wait=ms] [--size=WxH] [--mobile] [--eval=js]
// --ready waits (up to 90 s) for window.__ready === true (dev harness pages set it) before --wait.
// Prints console errors/warnings and page errors. Exit code 1 if the page threw.
import { chromium } from 'playwright-core';

const [url, out = 'shots/shot.png', ...rest] = process.argv.slice(2);
const opt = Object.fromEntries(rest.map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.join('=') || true]; }));
const [w, h] = String(opt.size || '1600x900').split('x').map(Number);
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || '/usr/bin/chromium',
  args: ['--use-angle=gl', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
});
const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1, isMobile: !!opt.mobile, hasTouch: !!opt.mobile });
let threw = false;
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[console.${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => { threw = true; console.log(`[pageerror] ${e.stack || e.message}`); });
await page.goto(url, { waitUntil: 'load' });
if (opt.ready) await page.waitForFunction(() => window.__ready === true, null, { timeout: 90000 }).catch(() => console.log('[warn] window.__ready never became true'));
await page.waitForTimeout(Number(opt.wait || 3000));
if (opt.eval) console.log('[eval]', JSON.stringify(await page.evaluate(opt.eval)));
await page.screenshot({ path: out });
console.log(`saved ${out}`);
const stats = await page.evaluate(() => window.__stats).catch(() => null);
if (stats) console.log('[stats]', JSON.stringify(stats));
await browser.close();
process.exit(threw ? 1 : 0);
