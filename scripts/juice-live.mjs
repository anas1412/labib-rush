// Live smoke test of the real audio engine on dev/audio.html (real AudioContext in headless
// Chromium): unlock by click, run music + ambience, fire every SFX, sweep intensity, pause/resume,
// mute. Fails (exit 1) on any page error or console error.
import { chromium } from 'playwright-core';

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium' });
const page = await browser.newPage();
let bad = 0;
page.on('pageerror', (e) => { bad++; console.log(`[pageerror] ${e.message}`); });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') { bad += m.type() === 'error'; console.log(`[console.${m.type()}] ${m.text()}`); } });
await page.routeWebSocket(/.*/, () => {});
await page.goto('http://127.0.0.1:5180/dev/audio.html', { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready, null, { timeout: 60000 });
const click = (section, label) => page.locator('h2', { hasText: section }).locator('xpath=following-sibling::div[1]').getByRole('button', { name: label, exact: true }).click();
await click('Music', 'start');
await click('Ambience', 'start');
await page.waitForTimeout(1500);
const names = await page.evaluate(() => window.__juice.names);
for (const n of names) { await click('Sound effects', n); await page.waitForTimeout(120); }
for (const v of ['0.3', '0.6', '0.9', '1']) { await page.locator('h2', { hasText: 'Music' }).locator('xpath=following-sibling::div[1]').locator('input').fill(v); await page.waitForTimeout(600); }
await click('Settings', 'pause'); await page.waitForTimeout(500);
await click('Settings', 'ui:click event'); await page.waitForTimeout(200);
await click('Settings', 'pause'); await page.waitForTimeout(500);
await click('Settings', 'mute'); await page.waitForTimeout(300); await click('Settings', 'mute');
await click('Music', 'menu arrangement'); await page.waitForTimeout(2500);
await click('Music', 'stop (2 s fade)'); await click('Ambience', 'stop'); await page.waitForTimeout(2500);
console.log(await page.locator('#log').textContent().then((t) => t.split('\n').length), 'log lines;', bad ? `${bad} ERRORS` : 'no errors');
await browser.close();
process.exit(bad ? 1 : 0);
