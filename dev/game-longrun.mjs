// Long continuous play: samples heap / GPU memory / DOM / physics every 15 s while Labib runs around.
import { launch, boot, stats, sleep } from './game-lib.mjs';
const { browser, page, errors } = await launch();
await page.addInitScript(() => {
  localStorage.setItem('labibRush.v1.name', 'Leak Test');
  localStorage.setItem('labibRush.v1.hints', JSON.stringify(['controls', 'move', 'pickup', 'deposit', 'kick', 'radar', 'litterbug']));
});
await boot(page);
await sleep(1500);
await page.getByRole('button', { name: /^Play/ }).first().click();
await sleep(4000);
const t0 = Date.now();
for (let i = 0; i < 12; i++) {
  await page.evaluate(() => { window.__game.session.run.timeLeft = 170; });
  await page.keyboard.down('KeyW'); await page.keyboard.down('ShiftLeft');
  for (let k = 0; k < 15; k++) { await page.mouse.move(800 + (k % 2 ? 300 : -300), 450); await page.keyboard.press('KeyF'); await page.keyboard.press('Space'); await sleep(1000); }
  await page.keyboard.up('KeyW'); await page.keyboard.up('ShiftLeft');
  await page.evaluate(() => window.gc?.());
  const s = await stats(page);
  const dom = await page.evaluate(() => document.getElementsByTagName('*').length);
  console.log(Math.round((Date.now() - t0) / 1000) + 's', JSON.stringify({ heapMB: Math.round(s.heap / 1e6), geo: s.geometries, tex: s.textures, calls: s.calls, bodies: s.bodies, colliders: s.colliders, items: s.items, dom, fps: s.fps }));
}
console.log(errors.length ? `ERRORS ${errors.length}: ${errors.slice(0, 3).join(' | ')}` : 'zero console errors');
await browser.close();
