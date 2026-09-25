// Social card: a real trick-shot moment at 1200x630, HUD hidden, with a small wordmark → public/og.jpg
// Usage: OG_MS=1150 node dev/game-og.mjs  (then: magick shots/og.png -quality 86 public/og.jpg)
import { launch, boot, sleep } from './game-lib.mjs';
const { browser, page } = await launch({ size: '1200x630' });
await page.addInitScript(() => { localStorage.setItem('labibRush.v1.name', 'Og'); localStorage.setItem('labibRush.v1.hints', JSON.stringify(['controls', 'move', 'pickup', 'deposit', 'kick', 'radar', 'litterbug'])); });
await boot(page); await sleep(1500);
await page.getByRole('button', { name: /^Play/ }).first().click();
await page.waitForFunction(() => window.__game.session.playing && !window.__game.session.locked, null, { timeout: 30000 });
await sleep(1500);
const delay = +(process.env.OG_MS || 520);
for (let i = 0; i < 6; i++) {
  await page.evaluate(() => {
    const G = window.__game;
    G.session.debug.setTime(80);
    G.teleport(-100.5, -2.6, Math.PI / 2 - 0.08);
    G.session.debug.spawn('can', -99.3, -2.6);
    G.session.debug.spawn('golden', -88, -6);
  });
  await sleep(1200);
  const t = await page.evaluate(() => window.__game.session.run.stats.trickShots);
  await page.keyboard.press('KeyF');
  await sleep(delay);
  await page.evaluate(() => {
    const d = document.createElement('div');
    d.id = 'og-mark';
    document.querySelector('.ui-root').style.visibility = 'hidden';
    d.innerHTML = '<b>Labib Rush</b><span>Avenue Habib Bourguiba</span>';
    d.style.cssText = 'position:fixed;left:44px;bottom:40px;z-index:99;color:#fff;font-family:"Baloo Bhaijaan 2",system-ui;text-shadow:0 3px 18px rgba(0,0,0,.55);line-height:1';
    d.querySelector('b').style.cssText = 'display:block;font-size:76px;font-weight:800;letter-spacing:-1px';
    d.querySelector('span').style.cssText = 'display:block;margin-top:6px;font-size:26px;font-weight:600;opacity:.92';
    document.body.append(d);
  });
  await page.screenshot({ path: 'shots/og.png' });
  await page.evaluate(() => { document.getElementById('og-mark')?.remove(); document.querySelector('.ui-root').style.visibility = ''; });
  await sleep(1500);
  const scored = (await page.evaluate(() => window.__game.session.run.stats.trickShots)) > t;
  console.log('attempt', i, scored ? 'scored' : 'miss');
  if (scored) break;
}
await browser.close();
