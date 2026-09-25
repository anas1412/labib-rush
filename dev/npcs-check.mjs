// Headless behaviour check for the npc module (same Chromium launch args as scripts/shot.mjs).
// node dev/npcs-check.mjs [baseUrl]   → exits 1 if an assertion fails.
// 1. A standing Labib in a taxi's lane: honked, never hit (the taxi stops, or eases off, re-honks, stops).
// 2. Menus (playing=false): no honk, no hit.
// 3. Litterbugs: warn → throw → catch loop runs; one 'litterThrown' event per throw (session hook owns it).
// 4. Walkers never inside STATIC/LOW_PROP colliders, taxis never overlap or leave the asphalt.
import { chromium } from 'playwright-core';

const base = process.argv[2] || 'http://127.0.0.1:5180/dev/npcs.html';
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || '/usr/bin/chromium',
  args: ['--use-angle=gl', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
});
const fails = [];
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) fails.push(msg); };
async function open(q) {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
  await page.routeWebSocket(/.*/, () => {});
  page.on('pageerror', (e) => fails.push(`pageerror ${e.message}`));
  await page.goto(`${base}?${q}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });
  await page.waitForFunction(() => window.__npc.checks.frames > 30, null, { timeout: 120000 });
  return page;
}

// 1 + 2: taxi trials
{
  const page = await open('lite=1&q=medium&hud=0');
  for (const playing of [true, false]) {
    await page.evaluate((p) => window.__npc.setPlaying(p), playing);
    let trials = 0, hits = 0, honks = 0;
    for (let i = 0; i < 8 && trials < 6; i++) {
      await page.waitForTimeout(1500);
      const r = await page.evaluate(() => { const n = window.__npc; n.log.hits = 0; n.log.honks = 0; return n.standBeforeTaxi(26); });
      if (!r) continue;
      trials++;
      await page.waitForTimeout(9000);
      const l = await page.evaluate(() => ({ hits: window.__npc.log.hits, honks: window.__npc.log.honks }));
      hits += l.hits; honks += l.honks;
      console.log(`  playing=${playing} trial ${trials}: honks ${l.honks} hits ${l.hits}`);
    }
    ok(trials >= 4, `playing=${playing}: ${trials} standing trials ran`);
    if (playing) { ok(hits === 0, `standing Labib never hit (${hits})`); ok(honks >= trials, `honked in every trial (${honks}/${trials})`); }
    else { ok(hits === 0 && honks === 0, `menus: no honk/hit (${honks}/${hits})`); }
  }
  await page.close();
}

// 3 + 4: litterbugs + collisions on the full street
{
  const page = await open('q=high&hud=0&chase=1&bugs=1&spawn=-60,1,90');
  await page.waitForTimeout(30000);
  const r = await page.evaluate(() => { const n = window.__npc; return { log: { ...n.log, events: n.log.events.length }, checks: n.checks }; });
  console.log('  ', JSON.stringify(r));
  ok(r.log.thrown >= 3, `litter thrown (${r.log.thrown})`);
  ok(r.log.caught >= 1, `litterbugs caught (${r.log.caught})`);
  ok(r.log.litterEvents === r.log.thrown, `one litterThrown event per throw (${r.log.litterEvents}/${r.log.thrown})`);
  ok(r.checks.walkerOverlaps === 0, `walkers inside props: ${r.checks.walkerOverlaps}/${r.checks.walkerSamples}`);
  ok(r.checks.carOverlaps === 0 && r.checks.carOffRoad === 0, `taxis overlap ${r.checks.carOverlaps}, off road ${r.checks.carOffRoad}`);
  await page.close();
}
await browser.close();
console.log(fails.length ? `\n${fails.length} FAILED` : '\nall passed');
process.exit(fails.length ? 1 : 0);
