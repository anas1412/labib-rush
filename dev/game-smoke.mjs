// Boot → menu screenshot + stats. node dev/game-smoke.mjs [out.png] [--mobile]
import { launch, boot, stats, sleep } from './game-lib.mjs';
const out = process.argv[2] || 'shots/game-menu.png';
const { browser, page, errors } = await launch({ mobile: process.argv.includes('--mobile') });
const t0 = Date.now();
await boot(page);
console.log('boot ms', Date.now() - t0);
await sleep(4000);
await page.screenshot({ path: out });
console.log('stats', JSON.stringify(await stats(page)));
console.log('errors', errors.length);
await browser.close();
