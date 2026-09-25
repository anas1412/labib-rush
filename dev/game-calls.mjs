// Draw-call breakdown at the start-of-run view: hides each top-level scene group in turn.
import { launch, boot, sleep } from './game-lib.mjs';
const q = process.argv[2] || 'high';
const { browser, page } = await launch();
await boot(page);
await page.evaluate((q) => { localStorage.setItem('labibRush.v1.name', JSON.stringify('Probe')); window.__game.engine.setQuality(q); }, q);
await page.evaluate(() => { window.__game.ui; });
await page.keyboard.press('Enter').catch(() => {});
await sleep(500);
// start a run through the handler path
await page.evaluate(() => document.querySelector('.ui-btn-play')?.click());
await sleep(5000);
const res = await page.evaluate(async () => {
  const g = window.__game, scene = g.engine.scene;
  const wait = () => new Promise((r) => setTimeout(r, 400));
  await wait();
  const base = g.stats();
  const out = { all: base.calls, tris: base.triangles };
  for (const c of scene.children) {
    if (!c.visible) continue;
    c.visible = false; await wait();
    out[c.name || c.type] = base.calls - g.stats().calls;
    c.visible = true;
  }
  return out;
});
console.log(q, JSON.stringify(res));
await browser.close();
