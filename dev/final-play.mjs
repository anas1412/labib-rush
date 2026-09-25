// Final integrated play-through (crowd + traffic wired): name → menu → play → litterbug throws and is
// caught → taxi honks, then hits → trick shot → deposit → game over → leaderboard → play again →
// reload persistence. Zero console errors required. Screenshots in shots/final-*.png.
// node dev/final-play.mjs
import { launch, boot, stats, run, sleep } from './game-lib.mjs';
import assert from 'node:assert/strict';

const { browser, context, page, errors } = await launch();
const shot = (n) => page.screenshot({ path: `shots/final-${n}.png` });
const g = (fn, arg) => page.evaluate(fn, arg);
const t0 = Date.now();
await boot(page);
console.log('boot', ((Date.now() - t0) / 1000).toFixed(1), 's');
await g(() => { const G = window.__game; G.log = { thrown: 0, caught: 0, honk: 0, hit: 0, trick: 0, deposit: 0 };
  G.events.on('litterThrown', () => G.log.thrown++); G.events.on('caught', () => G.log.caught++); G.events.on('honk', () => G.log.honk++);
  G.events.on('hit', () => G.log.hit++); G.events.on('trickShot', () => G.log.trick++); G.events.on('deposit', () => G.log.deposit++); });
const log = () => g(() => window.__game.log);
await sleep(1500);

await page.fill('.ui-input', 'Anas');
await page.keyboard.press('Enter');
await sleep(3000);
const menuNpcs = await g(() => ({ walkers: window.__game.crowd.debug.walkers().filter((w) => w.visible).length, cars: window.__game.traffic.debug.cars().length }));
console.log('menu npcs', menuNpcs);
assert.ok(menuNpcs.walkers > 10 && menuNpcs.cars > 0, 'crowd + taxis alive behind the menu');
await shot('01-menu');

await page.getByRole('button', { name: /^Play/ }).first().click();
await sleep(4200);
assert.equal(await g(() => window.__game.session.locked), false, 'playing after GO');
await shot('02-play');

// ---- litterbug: force one near Labib, wait for the throw, touch them -------------------------------
let caught = false;
for (let attempt = 0; attempt < 6 && !caught; attempt++) {
  const before = (await log()).thrown;
  const forced = await g(() => window.__game.crowd.debug.forceLitterbug(window.__game.player.position.x, window.__game.player.position.z));
  if (!forced) { await g(() => window.__game.teleport(-200 + attempt * 60, 12, Math.PI / 2)); await sleep(1500); continue; }
  for (let i = 0; i < 40 && (await log()).thrown === before; i++) await sleep(100);
  if ((await log()).thrown === before) continue;
  await sleep(300);
  await shot('03-litterbug-threw');
  // walk into the thrower (bug state 3 = catch window)
  for (let i = 0; i < 25 && !caught; i++) {
    await g(() => { const G = window.__game, w = G.crowd.debug.walkers().find((k) => k.bug === 3); if (!w) return;
      const p = G.player.position, dx = w.x - p.x, dz = w.z - p.z, d = Math.hypot(dx, dz) || 1;
      G.teleport(w.x - dx / d * 0.7, w.z - dz / d * 0.7, Math.atan2(dx, dz), p.y); });
    await sleep(100);
    caught = (await log()).caught > 0;
  }
}
console.log('litterbug', await log());
assert.ok((await log()).thrown >= 1, 'a litterbug threw');
assert.ok(caught, 'litterbug caught');
await sleep(200);
await shot('04-caught');
const scoreAfterCatch = (await run(page)).score;
assert.ok(scoreAfterCatch >= 100, 'caught pays +100');
await sleep(2000);
await shot('05-litterbug-pickup');

// ---- taxi: stand in a lane ahead of a moving taxi (26 m → honk), then step in close (hit) -------
const standBefore = (dist) => g((d) => { const G = window.__game;
  const c = G.traffic.debug.cars().find((k) => Math.abs(Math.abs(k.z) - 18) < 2.5 && k.x > -200 && k.x < 220 && k.v > 5);
  if (!c) return false; G.teleport(c.x + Math.sin(c.yaw) * d, c.z, c.yaw + Math.PI, 0.05); return true; }, dist);
for (let i = 0; i < 20 && (await log()).honk === 0; i++) { if (await standBefore(26)) await sleep(2500); else await sleep(700); }
console.log('honk', await log());
assert.ok((await log()).honk >= 1, 'taxi honked');
await g(() => { const p = window.__game.player.position; for (let k = 0; k < 3; k++) window.__game.session.debug.spawn('can', p.x + 0.3, p.z + 0.3 * k); });
await sleep(300);
for (let i = 0; i < 30 && (await log()).hit === 0; i++) {
  if (await standBefore(4.5)) { await sleep(250); await shot('06-taxi-close'); await sleep(900); } else await sleep(500);
}
console.log('hit', await log());
assert.ok((await log()).hit >= 1, 'taxi hit Labib');
await sleep(250);
await shot('07-taxi-hit');
await sleep(1500);

// ---- trick shot ----------------------------------------------------------------------------------
let r;
for (let i = 0; i < 6; i++) {
  await g(() => { window.__game.teleport(-102, -2, Math.PI / 2); window.__game.session.debug.spawn('can', -100, -2); });
  await sleep(400);
  const tk = (await run(page)).trick;
  await page.keyboard.press('KeyF');
  await sleep(1100);
  r = await run(page);
  if (r.trick > tk) { await shot('08-trickshot'); break; }
}
assert.ok(r.trick >= 1, 'trick shot scored');

// ---- pickups + deposit ---------------------------------------------------------------------------
await g(() => { window.__game.teleport(-172, 2, Math.PI / 2); const p = window.__game.player.position; for (let i = 1; i <= 5; i++) window.__game.session.debug.spawn(i % 2 ? 'can' : 'bottle', p.x + 1.2 * i, p.z); });
await sleep(200);
await page.keyboard.down('KeyW'); await sleep(1500); await page.keyboard.up('KeyW');
console.log('bag', (await run(page)).bag);
await g(() => window.__game.teleport(-163.5, 2, Math.PI / 2));
await page.keyboard.down('KeyW'); await sleep(700); await page.keyboard.up('KeyW');
await sleep(250);
await shot('09-deposit');
r = await run(page);
console.log('after deposit', r, await log());
assert.ok((await log()).deposit >= 1 && r.bag === 0, 'deposited');

// ---- game over + leaderboard -------------------------------------------------------------------
await g(() => window.__game.session.debug.setTime(1.5));
await sleep(5500);
await shot('10-gameover');
assert.equal(await g(() => window.__game.mode), 'over');
assert.ok(await page.locator('.ui-row-me').count() >= 1, 'score highlighted');
const saved = await g(() => JSON.parse(localStorage.getItem('labibRush.v1.scores') || '[]'));
console.log('saved', saved);
assert.equal(saved.length, 1);
assert.equal(saved[0].name, 'Anas');

// ---- play again (timed) ------------------------------------------------------------------------
const tAgain = Date.now();
await page.keyboard.press('KeyR');
await page.waitForFunction(() => window.__game.mode === 'play');
console.log('play again in', Date.now() - tAgain, 'ms');
assert.ok(Date.now() - tAgain < 2000, 'play again < 2 s');
assert.ok((await run(page)).timeLeft >= 89.9, 'fresh run');
await sleep(4500);
await shot('11-play-again');
await page.keyboard.press('Escape'); await sleep(400);
await shot('12-pause');
const frozen = await g(() => { const w = window.__game.crowd.debug.walkers().find((k) => k.visible && k.mode === 1); return w ? [w.x, w.z] : null; });
await sleep(800);
const frozen2 = await g(() => { const w = window.__game.crowd.debug.walkers().find((k) => k.visible && k.mode === 1); return w ? [w.x, w.z] : null; });
assert.deepEqual(frozen, frozen2, 'crowd pauses with the game');
await page.getByRole('button', { name: /Quit to menu/ }).click(); await sleep(500);
await page.getByRole('button', { name: /^Leaderboard/ }).click(); await sleep(500);
await shot('13-leaderboard');
await page.keyboard.press('Escape'); await sleep(300);
await page.getByRole('button', { name: /^Settings/ }).click(); await sleep(300);
await page.locator('#ui-set-cameraShake').click(); await sleep(200);
await page.keyboard.press('Escape'); await sleep(300);

await page.reload();
await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000 });
await sleep(1500);
const persisted = await g(() => ({ name: window.__game.ui.getPlayerName(), settings: window.__game.ui.getSettings(), scores: JSON.parse(localStorage.getItem('labibRush.v1.scores') || '[]').length }));
console.log('after reload', persisted);
assert.equal(persisted.name, 'Anas');
assert.equal(persisted.settings.cameraShake, false);
assert.equal(persisted.scores, 1);
await shot('14-menu-reloaded');
console.log('stats', JSON.stringify(await stats(page)));
console.log(errors.length ? `ERRORS ${errors.length}\n${errors.join('\n')}` : 'zero console errors');
await context.close();
await browser.close();
process.exit(errors.length ? 1 : 0);
