// Offline audio verification for the juice module (you cannot listen, so measure and look):
//   node scripts/juice-audio.mjs [sfx|inst|music|ambience|scene|all] [--only=name,name] [--raw]
// (--raw: SFX without the master dynamics, for linear level balancing)
// Renders through dev/audio.html's window.__juice (OfflineAudioContext, same code as the game), writes
// WAVs + ffmpeg spectrogram/waveform PNGs to shots/juice/, prints a stats table and flags problems:
// peaks above −1 dBFS, DC offset, clicks, non-silent tails.
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const [what = 'all', ...rest] = process.argv.slice(2);
const opt = Object.fromEntries(rest.map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.join('=') || true]; }));
const only = opt.only ? String(opt.only).split(',') : null;
const OUT = 'shots/juice';
mkdirSync(`${OUT}/wav`, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') console.log(`[console.error] ${m.text()}`); });
// Mock Vite's HMR socket: other agents edit shared files all the time and a full reload would kill a render.
await page.routeWebSocket(/.*/, () => {});
await page.goto('http://127.0.0.1:5180/dev/audio.html', { waitUntil: 'load' });
await page.waitForFunction(() => window.__juice && window.__ready, null, { timeout: 60000 });
await page.waitForTimeout(1500); // let Vite finish any dependency re-optimisation reload
await page.waitForFunction(() => window.__juice && window.__ready, null, { timeout: 60000 });

const rows = [];
async function render(name, js) {
  const r = await page.evaluate(js);
  writeFileSync(`${OUT}/wav/${name}.wav`, Buffer.from(r.wav, 'base64'));
  const s = r.stats;
  const flags = [];
  if (s.peakDb > -1) flags.push('PEAK>-1dB');
  if (Math.abs(s.dc) > 1e-3) flags.push('DC');
  // (in dense mixes the detector also hits the tek's 7 kHz noise grains, so only judge isolated sounds)
  if (s.clicks.length && !/music|ambience|scene/.test(name)) flags.push(`clicks@${s.clicks.join(',')}`);
  if (s.tailDb > -60 && !/music|ambience|scene/.test(name)) flags.push(`tail ${s.tailDb}dB`);
  rows.push({ name, ...s, clicks: s.clicks.length, flags: flags.join(' ') });
  // spectrogram (log frequency) + waveform, stacked
  const w = `${OUT}/wav/${name}.wav`;
  const long = s.seconds > 10;
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', w, '-lavfi',
    `showspectrumpic=s=${long ? '1400x360' : '700x260'}:legend=0:scale=log:fscale=log:mode=combined:color=intensity:drange=90,drawtext=text='${name}':x=8:y=6:fontcolor=white:fontsize=18`,
    `${OUT}/wav/${name}-spec.png`]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', w, '-lavfi', `showwavespic=s=${long ? '1400x140' : '700x110'}:split_channels=0:colors=0x7fe0b0:scale=lin`, `${OUT}/wav/${name}-wave.png`]);
  execFileSync('magick', [`${OUT}/wav/${name}-spec.png`, `${OUT}/wav/${name}-wave.png`, '-background', '#111', '-append', `${OUT}/wav/${name}-card.png`]);
}

const names = await page.evaluate(() => window.__juice.names);
if (what === 'sfx' || what === 'all') {
  for (const n of names) {
    if (only && !only.includes(n)) continue;
    const secs = ['trickShot', 'cheer', 'newBest', 'gameOver', 'pickupRare', 'birds', 'radar'].includes(n) ? 3.5 : ['honk', 'powerup', 'deposit', 'caught'].includes(n) ? 2 : 1.2;
    await render(n, `window.__juice.sfx(${JSON.stringify(n)}, 1, ${secs}, ${!!opt.raw})`);
  }
  const cards = names.filter((n) => !only || only.includes(n)).map((n) => `${OUT}/wav/${n}-card.png`);
  for (let i = 0; i < cards.length; i += 8) {
    execFileSync('magick', ['montage', ...cards.slice(i, i + 8), '-tile', '2x', '-geometry', '+4+4', '-background', '#000', `${OUT}/sfx-sheet-${i / 8 + 1}.png`]);
  }
}
if (what === 'inst') {
  for (const n of await page.evaluate(() => window.__juice.instruments)) await render(`inst-${n}`, `window.__juice.inst(${JSON.stringify(n)})`);
}
if (what === 'music' || what === 'all') {
  // intensity ramps 0 → 1 over the first 3 cycles, then drops; then the menu arrangement
  await render('music-game', `window.__juice.music(140, [[0,0],[20,0.3],[45,0.55],[70,0.85],[110,1],[125,0.2]])`);
  await render('music-menu', `window.__juice.music(40, [[0,0]], true)`);
}
if (what === 'ambience' || what === 'all') await render('ambience', `window.__juice.ambience(40)`);
if (what === 'scene' || what === 'all') await render('scene', `window.__juice.scene(9)`);

await browser.close();
console.table(rows.map(({ name, seconds, peakDb, loudDb, rmsDb, activeSec, dc, tailDb, flags }) => ({ name, seconds, peakDb, loudDb, rmsDb, activeSec, dc, tailDb, flags })));
