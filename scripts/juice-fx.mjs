// FX close-ups through the real engine: one browser, each kind at several freeze times, from a
// per-kind camera (eye level ≈ 1.2 m unless the effect lives higher). Writes shots/juice/fx-*.png and
// a contact sheet shots/juice/fx-sheet.png, and prints the [stats] line of each shot.
//   node scripts/juice-fx.mjs [kind,kind…] [--times=0.15,0.4,0.9] [--engine=0] [--q=high] [--size=1280x720]
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=') || true]; }));
const pickKinds = args.find((a) => !a.startsWith('--'))?.split(',');
const [W, H] = String(opt.size || '1280x720').split('x').map(Number);
const VIEWS = {
  sparkle: { cam: '0,1.2,3.2', target: '0,0.55,0', times: [0.12, 0.3, 0.6] },
  goldSparkle: { cam: '0,1.2,4', target: '0,1,0', times: [0.12, 0.45, 0.9] },
  dust: { cam: '0,1.0,2.6', target: '0,0.35,0', times: [0.15, 0.4, 0.8] },
  confetti: { cam: '0,1.2,7', target: '0,2.2,0', times: [0.3, 1.2, 3.2] },
  spill: { cam: '0,1.3,4.5', target: '0,0.5,0', times: [0.2, 0.5, 1.3] },
  powerup: { cam: '0,1.4,4.2', target: '0,0.7,0', times: [0.12, 0.35, 0.7] },
  hit: { cam: '0.8,1.3,3.4', target: '0,0.9,0', times: [0.08, 0.25, 0.7] },
  deposit: { cam: '0,1.5,3.2', target: '0,1.1,0', times: [0.15, 0.4, 0.62] },
  leaves: { cam: '0,1.2,6', target: '0,2.2,0', times: [1, 3, 7] },
  speedLines: { cam: '-4.2,1.7,1.3', target: '0,0.9,0', times: [0.5, 0.8] },
};
const kinds = pickKinds ?? Object.keys(VIEWS);
const OUT = 'shots/juice';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', args: ['--use-angle=gl', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[console.${m.type()}] ${m.text()}`); });
await page.routeWebSocket(/.*/, () => {});
const files = [];
for (const k of kinds) {
  const v = VIEWS[k];
  const times = opt.times ? String(opt.times).split(',').map(Number) : v.times;
  for (const t of times) {
    const url = `http://127.0.0.1:5180/dev/fx.html?kind=${k}&freeze=${t}&cam=${v.cam}&target=${v.target}&engine=${opt.engine ?? 1}&q=${opt.q ?? 'high'}`;
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 90000 });
    await page.waitForTimeout(Number(opt.wait ?? 900));
    const f = `${OUT}/fx-${k}-${t}.png`;
    await page.screenshot({ path: f });
    const stats = await page.evaluate(() => window.__stats);
    console.log(f, JSON.stringify(stats));
    files.push(f);
  }
}
await browser.close();
execFileSync('magick', ['montage', ...files, '-tile', '3x', '-geometry', `${Math.round(W / 2.5)}x${Math.round(H / 2.5)}+3+3`, '-background', '#111', `${OUT}/fx-sheet.png`]);
console.log(`${OUT}/fx-sheet.png`);
