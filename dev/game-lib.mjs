// Shared Playwright helpers for the dev/game-*.mjs checks (same launch args as scripts/shot.mjs).
import { chromium } from 'playwright-core';

export const URL = process.env.GAME_URL || 'http://127.0.0.1:5180/';

export async function launch({ mobile = false, size, storage } = {}) {
  const [w, h] = (size || (mobile ? '844x390' : '1600x900')).split('x').map(Number);
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM || '/usr/bin/chromium',
    args: ['--use-angle=gl', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile, storageState: storage });
  const page = await context.newPage();
  await page.routeWebSocket(/.*/, () => {}); // no Vite full reloads while other agents edit files
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') { const t = `[console.${m.type()}] ${m.text()}`; if (m.type() === 'error') errors.push(t); console.log(t); } });
  page.on('pageerror', (e) => { errors.push(`[pageerror] ${e.message}`); console.log(`[pageerror] ${e.stack || e.message}`); });
  return { browser, context, page, errors };
}

export async function boot(page) {
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000 });
}

export const stats = (page) => page.evaluate(() => window.__game.stats());
export const run = (page) => page.evaluate(() => { const r = window.__game.session.run; return { timeLeft: r.timeLeft, score: r.score, bag: r.bag.length, over: r.over, mult: r.multiplier, items: r.stats.items, trick: r.stats.trickShots, pickups: r.stats.pickups }; });
export const pos = (page) => page.evaluate(() => { const p = window.__game.player.position; return [p.x, p.y, p.z].map((v) => +v.toFixed(2)); });
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
