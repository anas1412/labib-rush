// Gameplay moments for visual review: litter field, flying bags, power-ups + golden beam, a trick
// shot sequence, radar, mint tea. node dev/game-moments.mjs [quality]
import { launch, boot, run, sleep } from './game-lib.mjs';
const q = process.argv[2] || 'high';
const { browser, page, errors } = await launch();
await page.addInitScript((q) => {
  localStorage.setItem('labibRush.v1.name', 'Anas');
  localStorage.setItem('labibRush.v1.settings', JSON.stringify({ quality: q }));
  localStorage.setItem('labibRush.v1.hints', JSON.stringify(['controls', 'move', 'pickup', 'deposit', 'kick', 'radar', 'litterbug']));
}, q);
await boot(page);
await sleep(1500);
const shot = (n) => page.screenshot({ path: `shots/moment-${n}.png` });
const g = (fn, a) => page.evaluate(fn, a);
await page.getByRole('button', { name: /^Play/ }).first().click();
await sleep(4200);

// litter field ahead at gameplay distance
await g(() => { const G = window.__game; G.teleport(-120, 6, Math.PI / 2); for (let i = 0; i < 14; i++) G.session.debug.spawn(['can', 'bottle', 'chips'][i % 3], -112 + i * 2.6, 6 + Math.sin(i * 1.7) * 4); });
await sleep(900);
await shot('litter-field');
// flying bags + power-ups + golden
await g(() => { const G = window.__game, s = G.session.debug; s.spawn('bag', -113, 5); s.spawn('bag', -110, 8); s.spawn('tea', -114, 3); s.spawn('chechia', -112, 9.5); s.spawn('golden', -95, 4); });
await sleep(2500);
await shot('bags-powerups');
// trick shot sequence
await g(() => { const G = window.__game; G.teleport(-47, 2, Math.PI / 2); G.session.debug.spawn('can', -45.2, 2); G.session.debug.spawn('bottle', -45.4, 2.6); });
await sleep(600);
await page.keyboard.press('KeyF');
for (let i = 0; i < 6; i++) { await sleep(130); await shot(`trick-${i}`); }
await sleep(400);
console.log('after trick', await run(page));
// radar through walls
await g(() => window.__game.teleport(-130, -26, Math.PI / 2));
await sleep(500);
await page.keyboard.press('KeyE');
await sleep(350);
await shot('radar');
// mint tea: grab it, then sprint
await g(() => { const G = window.__game; G.teleport(20, 8, Math.PI / 2); G.session.debug.spawn('tea', 21.5, 8); });
await page.keyboard.down('KeyW'); await page.keyboard.down('ShiftLeft');
await sleep(1400);
await shot('tea');
await page.keyboard.up('ShiftLeft'); await page.keyboard.up('KeyW');
console.log('run', await run(page), await g(() => window.__game.session.debug.counts()));
console.log(errors.length ? `ERRORS ${errors.length}` : 'zero console errors');
await browser.close();
