// Gameplay tuning checks: litter density + greedy pickup rate, trick-shot odds by range, flying-bag heights.
// Usage: node dev/game-tuning.mjs [bot|trick|bags|all]
import { launch, boot, run, sleep } from './game-lib.mjs';
const which = process.argv[2] || 'all';
const { browser, page, errors } = await launch();
await page.addInitScript(() => { localStorage.setItem('labibRush.v1.name', 'Tuner'); localStorage.setItem('labibRush.v1.hints', JSON.stringify(['controls', 'move', 'pickup', 'deposit', 'kick', 'radar', 'litterbug'])); });
await boot(page); await sleep(1000);
await page.getByRole('button', { name: /^Play/ }).first().click();
await page.waitForFunction(() => window.__game.session.playing && !window.__game.session.locked, null, { timeout: 30000 });

const near = () => page.evaluate(() => {
  const p = window.__game.player.position; let n30 = 0, n70 = 0;
  for (const it of window.__game.session.debug.litter()) if (it.state === 'floor') { const d = Math.hypot(it.x - p.x, it.z - p.z); if (d < 30) n30++; if (d < 70) n70++; }
  return { n30, n70 };
});

if (which === 'bot' || which === 'all') {
  console.log('density at start', JSON.stringify(await near()));
  await page.screenshot({ path: 'shots/tune-start.png' });
  const t0 = (await run(page)).pickups;
  let bestMult = 1;
  await page.keyboard.down('KeyW'); await page.keyboard.down('ShiftLeft');
  const end = Date.now() + 30000;
  let shot = false;
  while (Date.now() < end) {
    const m = await page.evaluate(() => {
      const G = window.__game, p = G.player.position, r = G.session.run;
      if (r.bag.length >= 7) { G.session.run.bag.length = 0; } // bot empties the bag instead of walking to a bin
      // ground-level litter only; give up on a target that is not reached in 2.5 s (blocked by a prop)
      const bot = (window.__bot ??= { key: '', since: 0, skip: new Set() });
      let best = null, bd = Infinity;
      for (const it of G.session.debug.litter()) {
        const key = `${it.x.toFixed(1)},${it.z.toFixed(1)}`;
        if (it.state !== 'floor' || Math.abs(it.y - p.y) > 0.3 || bot.skip.has(key)) continue;
        const d = Math.hypot(it.x - p.x, it.z - p.z); if (d < bd) { bd = d; best = { ...it, key }; }
      }
      if (best) {
        if (best.key !== bot.key) { bot.key = best.key; bot.since = performance.now(); }
        else if (performance.now() - bot.since > 2500) bot.skip.add(best.key);
        G.rig.reset(Math.atan2(best.x - p.x, best.z - p.z));
      }
      return r.multiplier;
    });
    bestMult = Math.max(bestMult, m);
    if (!shot && Date.now() > end - 20000) { shot = true; await page.screenshot({ path: 'shots/tune-mid.png' }); }
    await sleep(120);
  }
  await page.keyboard.up('KeyW'); await page.keyboard.up('ShiftLeft');
  const n = (await run(page)).pickups - t0;
  console.log(`greedy bot: ${n} pickups in 30 s (${(30 / Math.max(1, n)).toFixed(2)} s each), best multiplier x${bestMult}`, JSON.stringify(await near()));
}

if (which === 'trick' || which === 'all') {
  for (const [d, deg] of [[4, 0], [10, 0], [16, 0], [10, 20]]) {
    let hits = 0; const N = 10;
    for (let i = 0; i < N; i++) {
      await page.evaluate(() => window.__game.session.debug.setTime(90));
      const before = (await run(page)).trick;
      await page.evaluate(([d, deg]) => {
        const G = window.__game, a = (deg * Math.PI) / 180;
        // bin at (-95,-2); stand d m away, facing +x rotated by deg so the bin is deg off-axis
        const x = -95 - d * Math.cos(a), z = -2 - d * Math.sin(a);
        G.teleport(x, z, Math.PI / 2);
        G.session.debug.spawn('can', x + 1.6, z);
      }, [d, deg]);
      await sleep(250);
      await page.keyboard.press('KeyF');
      await sleep(1700);
      if ((await run(page)).trick > before) hits++;
    }
    console.log(`trick ${d} m @ ${deg}°: ${hits}/${N}`);
  }
}

if (which === 'kickwalk' || which === 'all') {
  // walking at a bin 9 m ahead with a can 0.9 m in front: the kick must win over auto-pickup
  let hits = 0, picked = 0; const N = 6;
  for (let i = 0; i < N; i++) {
    await page.evaluate(() => window.__game.session.debug.setTime(90));
    const before = await run(page);
    await page.evaluate(() => { const G = window.__game; G.teleport(-104, -2, Math.PI / 2); G.session.debug.spawn('can', -103.1, -2); });
    await sleep(200);
    await page.keyboard.down('KeyW'); await sleep(+(process.env.KW_MS || 250)); await page.keyboard.press('KeyF'); await page.keyboard.up('KeyW');
    await sleep(1700);
    const after = await run(page);
    if (after.trick > before.trick) hits++;
    if (after.pickups > before.pickups) picked++;
  }
  console.log(`kick while walking at a bin: ${hits}/${N} goals, ${picked} auto-picked instead`);
}

if (which === 'bags' || which === 'all') {
  await page.evaluate(() => { const G = window.__game; G.teleport(-40, 2, Math.PI / 2); for (let i = 0; i < 4; i++) G.session.debug.spawn('bag', -30 + i * 3, 4); });
  const hs = [];
  for (let i = 0; i < 40; i++) {
    await sleep(150);
    hs.push(...(await page.evaluate(() => { const py = window.__game.player.position.y; return window.__game.session.debug.litter().filter((it) => it.state === 'fly').map((it) => +(it.y - py).toFixed(2)); })));
  }
  const low = hs.filter((h) => h < 1.45).length;
  console.log(`bag pivot heights above the feet: min ${Math.min(...hs)} max ${Math.max(...hs)}; below standing reach ${low}/${hs.length}`);
}
console.log('errors', errors.length, errors.slice(0, 5));
await browser.close();
