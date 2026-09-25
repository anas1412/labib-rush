// Trick-shot reliability: 12 assisted kicks from 3–10 m; prints the hit rate.
import { launch, boot, run, sleep } from './game-lib.mjs';
const { browser, page } = await launch();
await page.addInitScript(() => { localStorage.setItem('labibRush.v1.name', 'Trick'); localStorage.setItem('labibRush.v1.hints', JSON.stringify(['controls','move','pickup','deposit','kick','radar','litterbug'])); });
await boot(page); await sleep(1000);
await page.getByRole("button", { name: /^Play/ }).first().click(); await page.waitForFunction(() => !window.__game.session.locked, null, { timeout: 20000 });
let hits = 0;
for (let i = 0; i < 12; i++) {
  const d = 3 + (i % 8);
  const before = (await run(page)).trick;
  const kind = ['can', 'bottle', 'chips'][i % 3];
  await page.evaluate(([d, kind]) => { const G = window.__game; G.teleport(-95 - d, -2, Math.PI / 2); G.session.debug.spawn(kind, -95 - d + 2, -2); }, [d, kind]);
  await sleep(300);
  await page.keyboard.press('KeyF');
  await sleep(1600);
  const ok = (await run(page)).trick > before;
  hits += ok;
  const c = await page.evaluate(() => window.__game.session.debug.counts());
  console.log(d, kind, ok ? 'GOAL' : 'miss', JSON.stringify(c));
}
console.log('hit rate', hits, '/ 12');
await browser.close();
