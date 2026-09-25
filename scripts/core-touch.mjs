// Touch controls check on a phone viewport (844x390 @3x, touch): node scripts/core-touch.mjs
// Holds a thumb on the floating joystick (left), drags look on the right and holds Jump, then
// screenshots and prints player movement / camera yaw change / #touch visibility. Then checks the
// touchscreen-laptop case: a mouse click returns to mouse mode, a touch switches back.
import { chromium } from 'playwright-core';

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', args: ['--use-angle=gl', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] });
const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.route('**/@vite/client', (r) => r.fulfill({ contentType: 'application/javascript', body: 'export {}' }));
await page.goto('http://127.0.0.1:5180/dev/core.html?q=low&spawn=-200,0,90', { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 90000 });
const cdp = await ctx.newCDPSession(page);
const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i + 1 })) });
const state = () => page.evaluate(() => { const c = window.__core; return { x: +c.player.position.x.toFixed(2), z: +c.player.position.z.toFixed(2), y: +c.player.position.y.toFixed(2), yaw: +c.rig.yaw.toFixed(3), touch: c.input.isTouch, shown: document.getElementById('touch').classList.contains('tc-show') }; });
await page.waitForTimeout(500);
const s0 = await state();
// thumb 1 on the left: push the stick up (forward); thumb 2 drags look on the right
await touch('touchStart', [[140, 300]]);
for (let i = 1; i <= 8; i++) { await touch('touchMove', [[140, 300 - i * 6]]); await page.waitForTimeout(16); }
await touch('touchMove', [[140, 252], [600, 200]]);
for (let i = 1; i <= 10; i++) { await touch('touchMove', [[140, 252], [600 + i * 8, 200]]); await page.waitForTimeout(16); }
await page.waitForTimeout(600);
const jump = await page.evaluate(() => { const r = document.querySelector('.tc-jump').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
await touch('touchMove', [[140, 252], [680, 200], jump]);
// highest point over the next 0.5 s (robust to slow frames on a shared GPU)
const yMax = await page.evaluate(() => new Promise((res) => { let m = 0; const t0 = performance.now(); const f = () => { m = Math.max(m, window.__core.player.position.y); if (performance.now() - t0 < 500) requestAnimationFrame(f); else res(m); }; f(); }));
await page.screenshot({ path: 'shots/core-touch.png' });
const s1 = { ...(await state()), y: yMax };
await touch('touchEnd', []);
await page.waitForTimeout(300);
const s2 = await state();
console.log({ before: s0, holding: s1, released: s2 });
console.log(s1.touch && s1.shown && Math.hypot(s1.x - s0.x, s1.z - s0.z) > 2 && s1.yaw !== s0.yaw && s1.y > s0.y + 0.2 ? 'PASS touch: stick moves, drag looks, jump jumps' : 'FAIL touch');
// touchscreen laptop: a real mouse click switches back to mouse mode (overlay hidden, no stick)
await page.mouse.click(140, 300);
await page.waitForTimeout(150);
const s3 = await state();
const stickOn = await page.evaluate(() => document.querySelector('.tc-stick').classList.contains('tc-on'));
console.log(!s3.touch && !s3.shown && !stickOn ? 'PASS mouse after touch: back to mouse mode' : `FAIL mouse after touch ${JSON.stringify({ ...s3, stickOn })}`);
// and a touch brings the touch controls back
await touch('touchStart', [[700, 200]]); await touch('touchEnd', []);
await page.waitForTimeout(100);
const s4 = await state();
console.log(s4.touch && s4.shown ? 'PASS touch again: touch mode' : 'FAIL touch again');
await browser.close();
