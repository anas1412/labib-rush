// Multi-view screenshots of dev/core.html in one browser session.
// node scripts/core-shots.mjs [--tag=x] [--eval=js] [--views=a,b] [--size=1600x900] [--mobile]
// Views: play (gameplay cam at spawn), eye-west (1.2 m toward the sun), eye-east, eye-road,
// south-walk, wall-behind / trunk-behind (spring arm), wide, menu. Prints [stats] per view. Output: shots/core-<view><tag>.png
import { chromium } from 'playwright-core';

const opt = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.join('=') || true]; }));
const [w, h] = String(opt.size || '1600x900').split('x').map(Number);
const VIEWS = {
  play: 'spawn=-236,0,90',
  'play-sun': 'spawn=-150,0,270',
  'eye-west': 'cam=-196,1.2,3&target=-262,6,-2',
  'eye-east': 'cam=-226,1.2,-3&target=-150,3.5,0',
  'south-walk': 'cam=-128,1.2,26.5&target=-70,2.5,21',
  'eye-road': 'cam=-230,1.2,-19&target=-150,2,-14',
  'wall-behind': 'spawn=-100,-29.2,0',
  'trunk-behind': 'spawn=-131.25,9.5,90',
  wide: 'cam=-170,42,70&target=-80,0,-5',
  menu: 'menu=1',
  'menu-late': 'menu=1&wait=20000',
  'menu-exit': 'menu=1&exit=1',
};
const names = opt.views ? String(opt.views).split(',') : Object.keys(VIEWS);
const tag = opt.tag ? `-${opt.tag}` : '';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', args: ['--use-angle=gl', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] });
const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1, isMobile: !!opt.mobile, hasTouch: !!opt.mobile });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[console.${m.type()}]`, m.text()); });
await page.route('**/@vite/client', (r) => r.fulfill({ contentType: 'application/javascript', body: 'export {}' }));
for (const v of names) {
  await page.goto(`http://127.0.0.1:5180/dev/core.html?${VIEWS[v]}&${opt.q ? `q=${opt.q}` : ''}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 90000 });
  await page.evaluate(() => { window.__core.engine.dynamicResolution = false; document.getElementById('dev-hud').style.display = 'none'; });
  if (opt.eval) await page.evaluate(String(opt.eval));
  const q = new URLSearchParams(VIEWS[v]);
  await page.waitForTimeout(Number(q.get('wait') || opt.wait || 2500));
  if (q.get('exit')) { await page.keyboard.press('KeyM'); await page.waitForTimeout(450); } // mid-blend into gameplay
  const out = `shots/core-${v}${tag}.png`;
  await page.screenshot({ path: out });
  const s = await page.evaluate(() => window.__stats);
  console.log(out, '[stats]', JSON.stringify(s));
}
await browser.close();
