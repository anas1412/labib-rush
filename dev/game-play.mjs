// Full desktop playthrough: name → menu → Play → countdown → move / pick up / deposit / kick (trick
// shot) → timer runs out → game over (saved + highlighted) → R plays again → change name → reload
// persists name, scores, settings. Screenshots in shots/game-*.png. node dev/game-play.mjs
import { launch, boot, stats, run, pos, sleep } from './game-lib.mjs';
import assert from 'node:assert/strict';

const { browser, context, page, errors } = await launch();
const shot = (n) => page.screenshot({ path: `shots/game-${n}.png` });
const g = (fn, arg) => page.evaluate(fn, arg);
await boot(page);
await sleep(1500);

// first visit: name entry
await page.fill('.ui-input', 'Anas');
await page.keyboard.press('Enter');
await sleep(800);
await shot('01-menu');
await page.getByRole('button', { name: /^Play/ }).first().click();
assert.equal(await g(() => window.__game.mode), 'play', 'Play starts at once (auto-detect ran under the loading screen)');
await sleep(1200);
await shot('02-countdown');
assert.equal(await g(() => window.__game.session.locked), true, 'locked during countdown');
await page.keyboard.down('KeyW'); // held through the countdown: must not move yet
await sleep(800);
const p0 = await pos(page);
await sleep(2300);
assert.equal(await g(() => window.__game.session.locked), false, 'playing after GO');
await page.keyboard.up('KeyW');
await sleep(200);
await shot('03-start-east');
console.log('pos at GO', p0);
assert.ok(Math.abs(p0[0] - -236) < 0.2, 'did not move during countdown');

// run east for 2 s (sprint)
await page.keyboard.down('KeyW'); await page.keyboard.down('ShiftLeft');
await sleep(2000);
await page.keyboard.up('ShiftLeft'); await page.keyboard.up('KeyW');
const p1 = await pos(page);
console.log('pos after run', p1, await run(page));
assert.ok(p1[0] > -230, 'moved east');

// pick up: spawn a chain of cans in front and run through them
await g(() => { const p = window.__game.player.position; for (let i = 1; i <= 6; i++) window.__game.session.debug.spawn(i % 2 ? 'can' : 'chips', p.x + 1.2 * i, p.z); });
await page.keyboard.down('KeyW');
await sleep(1500);
await page.keyboard.up('KeyW');
let r = await run(page);
console.log('after chain', r);
assert.ok(r.bag >= 4, 'picked up litter');
await sleep(150);
await shot('04-combo-hud');

// deposit at the bin at (-160, 2): teleport 3 m west of it, walk in
await g(() => window.__game.teleport(-163.5, 2, Math.PI / 2));
await page.keyboard.down('KeyW'); await sleep(700); await page.keyboard.up('KeyW');
await sleep(250);
await shot('05-deposit');
r = await run(page);
console.log('after deposit', r);
assert.equal(r.bag, 0, 'bag emptied');
assert.ok(r.items >= 4, 'items binned');

// trick shot: 7 m west of the bin at (-95,-2), facing east, a can at the feet, kick
// the aim assist has a small, range-based error: allow a rim miss or two
for (let i = 0; i < 4; i++) {
  await g(() => { window.__game.teleport(-102, -2, Math.PI / 2); window.__game.session.debug.spawn('can', -100, -2); });
  await sleep(400);
  const t0 = (await run(page)).trick;
  await page.keyboard.press('KeyF');
  await sleep(500);
  await shot('06-trickshot-flight');
  await sleep(700);
  await shot('07-trickshot');
  r = await run(page);
  console.log('kick', i, r.trick > t0 ? 'GOAL' : 'miss');
  if (r.trick > t0) break;
}
console.log('after kick', r, await g(() => window.__game.session.debug.counts()));
assert.ok(r.trick >= 1, 'trick shot scored');

// radar (AZERTY default: E)
console.log('radar before', await g(() => { const r = window.__game.session.run; return { cd: r.radarCooldown, t: r.radarTime, el: r.elapsed, mode: window.__game.mode, paused: window.__game.paused }; }));
await page.keyboard.down('KeyE'); await sleep(80); await page.keyboard.up('KeyE');
await sleep(300);
await shot('08-radar');
assert.ok(await g(() => window.__game.session.run.radarTime > 0), 'radar on E');

// pause / resume
await page.keyboard.press('Escape');
await sleep(400);
const tPause = (await run(page)).timeLeft;
await sleep(1000);
assert.equal((await run(page)).timeLeft, tPause, 'timer frozen while paused');
await page.keyboard.press('Escape');
await sleep(400);
assert.equal(await g(() => window.__game.paused), false, 'resumed');

// timer runs out
await g(() => window.__game.session.debug.setTime(2));
await sleep(2600);
await shot('09-over-beat');
await sleep(2200);
await shot('10-gameover');
const me = await page.locator('.ui-row-me').count();
console.log('highlighted rows', me);
assert.ok(me >= 1, 'score highlighted');
const saved = await g(() => JSON.parse(localStorage.getItem('labibRush.v1.scores') || '[]'));
console.log('saved scores', saved.length, saved[0]);
assert.equal(saved.length, 1);

// R plays again
await page.keyboard.press('KeyR');
await sleep(600);
assert.equal(await g(() => window.__game.mode), 'play', 'play again with R');
assert.ok((await run(page)).timeLeft >= 89.9, 'fresh run');

// quit to menu via pause, change name, set QWERTY + shake off
await sleep(3500);
await page.keyboard.press('Escape'); await sleep(300);
await page.getByRole('button', { name: /Quit to menu/ }).click(); await sleep(500);
await page.getByRole('button', { name: /Change name/ }).click(); await sleep(300);
await page.fill('.ui-screen.ui-on .ui-input', 'Yasmine');
await page.keyboard.press('Enter'); await sleep(500);
await page.getByRole('button', { name: /^Settings/ }).click(); await sleep(300);
await page.getByRole('button', { name: /QWERTY/ }).click();
await page.locator('#ui-set-cameraShake').click();
await sleep(200);
await shot('11-settings');
await page.keyboard.press('Escape'); await sleep(300);

// reload: persisted?
await page.reload();
await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000 });
await sleep(1500);
const persisted = await g(() => ({ name: window.__game.ui.getPlayerName(), settings: window.__game.ui.getSettings(), scores: JSON.parse(localStorage.getItem('labibRush.v1.scores') || '[]').length }));
console.log('after reload', persisted);
assert.equal(persisted.name, 'Yasmine');
assert.equal(persisted.settings.keyboard, 'qwerty');
assert.equal(persisted.settings.cameraShake, false);
assert.equal(persisted.scores, 1);
await shot('12-menu-reloaded');
console.log('stats', JSON.stringify(await stats(page)));
console.log(errors.length ? `ERRORS ${errors.length}` : 'zero console errors');
await context.close();
await browser.close();
