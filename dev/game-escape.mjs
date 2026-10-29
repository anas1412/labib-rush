// Repeated map escapes: teleport outside the play area, let the guard put Labib back, watch memory.
import { launch, boot, stats, sleep, pos } from './game-lib.mjs';
const { browser, page, errors } = await launch();
await page.addInitScript(() => {
  localStorage.setItem('labibRush.v1.name', 'Leak Test');
  localStorage.setItem('labibRush.v1.hints', JSON.stringify(['controls', 'move', 'pickup', 'deposit', 'kick', 'radar', 'litterbug']));
});
await boot(page);
await sleep(1500);
await page.getByRole('button', { name: /^Play/ }).first().click();
await sleep(4000);
for (let i = 0; i < 30; i++) {
  await page.evaluate((i) => { const G = window.__game; G.session.run.timeLeft = 170; i % 2 ? G.teleport(-272, 42) : G.teleport(0, 0, undefined, -8); }, i);
  await sleep(700);
  if (i % 5 === 4) {
    await page.evaluate(() => window.gc?.());
    const s = await stats(page);
    console.log(i + 1, 'escapes', JSON.stringify({ pos: await pos(page), heapMB: Math.round(s.heap / 1e6), geo: s.geometries, tex: s.textures, calls: s.calls, bodies: s.bodies, colliders: s.colliders, fps: s.fps }));
  }
}
console.log(errors.length ? `ERRORS ${errors.length}: ${errors.slice(0, 3).join(' | ')}` : 'zero console errors');
await browser.close();
