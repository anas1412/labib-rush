// 20 restarts in a row: FPS, draw calls, physics bodies/colliders, GPU memory and JS heap must not
// grow. Each run plays ~4 s with kicks/pickups so dynamic bodies exist when restarting.
import { launch, boot, stats, sleep } from './game-lib.mjs';
const { browser, page, errors } = await launch();
await page.addInitScript(() => {
  localStorage.setItem('labibRush.v1.name', 'Leak Test');
  localStorage.setItem('labibRush.v1.settings', JSON.stringify({ quality: 'high' }));
  localStorage.setItem('labibRush.v1.hints', JSON.stringify(['controls', 'move', 'pickup', 'deposit', 'kick', 'radar', 'litterbug']));
});
await boot(page);
await sleep(1500);
await page.getByRole('button', { name: /^Play/ }).first().click();
const rows = [];
for (let i = 0; i < 21; i++) {
  await sleep(3800); // countdown
  await page.evaluate(() => { const G = window.__game, p = G.player.position; for (let k = 0; k < 6; k++) G.session.debug.spawn('can', p.x + 1.5 + k * 0.4, p.z + (k % 3) - 1); G.session.hooks.hitPlayer(new (p.constructor)(0, 0, 1), 8); });
  await page.keyboard.down('KeyW'); await page.keyboard.press('KeyF'); await sleep(900); await page.keyboard.up('KeyW');
  await page.evaluate(() => window.gc?.());
  const s = await stats(page);
  rows.push(s);
  console.log(i, JSON.stringify({ fps: s.fps, calls: s.calls, bodies: s.bodies, colliders: s.colliders, geo: s.geometries, tex: s.textures, items: s.items, phys: s.phys, heapMB: Math.round(s.heap / 1e6) }));
  await page.keyboard.press('Escape'); await sleep(400);
  await page.getByRole('button', { name: /^Restart/ }).click();
}
console.log(errors.length ? `ERRORS ${errors.length}` : 'zero console errors');
await browser.close();
