// Phone landscape (844x390, touch): name → Play → touch controls visible → drag the stick to run,
// tap Jump/Kick → timer out → game over → Play again. node dev/game-mobile.mjs
import { launch, boot, run, pos, sleep } from './game-lib.mjs';
import assert from 'node:assert/strict';
const { browser, context, page, errors } = await launch({ mobile: true });
const shot = (n) => page.screenshot({ path: `shots/mobile-${n}.png` });
await boot(page);
await sleep(1500);
await page.tap('.ui-screen.ui-on .ui-input');
await page.fill('.ui-screen.ui-on .ui-input', 'لبيب Fan');
await page.getByRole('button', { name: /Yalla/ }).tap();
await sleep(700);
await shot('01-menu');
await page.getByRole('button', { name: /^Play/ }).first().tap();
await sleep(4300);
assert.ok(await page.evaluate(() => document.getElementById('touch').classList.contains('tc-show')), 'touch controls shown');
await shot('02-play');
// drag the virtual stick up (forward) with CDP touch events
const cdp = await context.newCDPSession(page);
const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
const p0 = await pos(page);
await touch('touchStart', 150, 300);
for (let i = 1; i <= 6; i++) { await touch('touchMove', 150, 300 - i * 12); await sleep(30); }
await sleep(1500);
await shot('03-stick');
await touch('touchEnd', 0, 0);
const p1 = await pos(page);
console.log('stick move', p0, '→', p1);
assert.ok(Math.hypot(p1[0] - p0[0], p1[2] - p0[2]) > 3, 'stick moves Labib');
const jump = await page.locator('.tc-jump').boundingBox();
await page.touchscreen.tap(jump.x + jump.width / 2, jump.y + jump.height / 2);
await sleep(250);
console.log('y during jump', (await pos(page))[1]);
await page.evaluate(() => window.__game.session.debug.setTime(1.5));
await sleep(4500);
await shot('04-gameover');
assert.ok(await page.locator('.ui-row-me').count() >= 1, 'score highlighted');
await page.getByRole('button', { name: /Play again/ }).tap();
await sleep(800);
assert.equal(await page.evaluate(() => window.__game.mode), 'play');
console.log(await run(page));
console.log(errors.length ? `ERRORS ${errors.length}` : 'zero console errors');
await browser.close();
