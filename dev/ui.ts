// UI preview page. ?screen=loading|name|menu|leaderboard|settings|howto|credits|hud|pause|gameover
// Extra: &mobile=1 (touch layout even without a touch device) &t=8 (HUD timer seconds)
//        &fresh=1 (HUD exactly as a new run starts: real createRun() + tick(), no fake pickups)
//        &rank=out|first (game-over entry outside the top 10 / new #1) &empty=1 (no scores)
//        &keep=1 (don't wipe/seed the dev keys: test persistence across reloads)
//        &bg=/shots/some-game-view.png (a real scene screenshot behind the UI instead of the gradient)
// window.__ui exposes the controller for scripted tests.
// DEV ONLY: fake leaderboard rows live here and are written under the 'labibRush.dev.' prefix,
// which is wiped on every load; the game's real 'labibRush.v1.' keys are never touched.
import { Vector3 } from 'three';
import { createUI } from '../src/ui';
import { createStore } from '../src/ui/storage';
import { applyPowerup, createRun, hudState, pickup, tick, useRadar } from '../src/gameplay/rules';
import type { RunResult, ScoreEntry } from '../src/core/types';

const DEV_PREFIX = 'labibRush.dev.';
const params = new URLSearchParams(location.search);
const screen = params.get('screen') ?? 'menu';
const rankMode = params.get('rank');
const bg = params.get('bg');
if (bg) Object.assign(document.getElementById('bg')!.style, { background: `center / cover url(${JSON.stringify(bg)})`, filter: 'none', inset: '0' });

const keep = !!params.get('keep');
const fresh = !!params.get('fresh');
try {
  if (!keep) for (const k of Object.keys(localStorage)) if (k.startsWith(DEV_PREFIX)) localStorage.removeItem(k);
} catch { /* storage blocked: the UI falls back to memory anyway */ }

const devStore = createStore(DEV_PREFIX);
if (screen !== 'name' && !keep) devStore.setName(params.get('name') ?? 'Anas');
const FAKE: [string, number][] = [
  ['Yasmine', 14820], ['مريم', 12960], ['Mehdi_07', 11240], ['Khalil-T', 9870], ['سليم', 9420], ['Rania.B', 8100],
  ['Anas', 7650], ['Ons', 6980], ['نور الهدى', 6010], ['Aziz', 5420], ['Hela', 4880], ['Omar', 4300], ['Sami', 3920], ['Eya', 3100],
];
if (!params.get('empty') && !keep) {
  FAKE.forEach(([name, score], i) => devStore.addScore({
    name, score, items: Math.round(score / 260), bestCombo: score > 9000 ? 5 : score > 5000 ? 3 : 2,
    durationSec: 90 + Math.round(score / 120), date: new Date(Date.UTC(2026, 8, 1 + i, 18)).toISOString(),
  } satisfies ScoreEntry));
}
if (screen !== 'name' && !keep && !params.get('controls')) devStore.markHint('controls'); // &controls=1 shows the first-play card

const ui = createUI(document.getElementById('app')!, {
  onPlay: () => startHud(),
  onPause: () => ui.showPause(),
  onResume: () => undefined,
  onRestart: () => startHud(),
  onQuitToMenu: () => undefined,
  onSettingsChange: (s) => console.info('[ui-dev] settings', JSON.stringify(s)),
  onUserGesture: () => console.info('[ui-dev] user gesture'),
}, { storagePrefix: DEV_PREFIX });
(window as unknown as { __ui: typeof ui }).__ui = ui;
addEventListener('ui:click', (e) => console.info('[ui-dev] ui:click', (e as CustomEvent<{ kind: string }>).detail.kind));

if (params.get('mobile')) document.querySelector('.ui-root')!.classList.add('ui-touch');

// ---- fake HUD run driven by the real rules ------------------------------------------------------
let hudRaf = 0;
function startHud(): void {
  ui.enterGame();
  const run = createRun();
  if (!fresh) {
    run.timeLeft = Number(params.get('t') ?? 74.4);
    applyPowerup(run, 'tea');
    applyPowerup(run, 'chechia');
    useRadar(run);
    tick(run, 3);
    for (let i = 0; i < 6; i++) { pickup(run, i % 2 ? 'bottle' : 'can'); tick(run, 0.4); }
    run.score = 3890;
  }
  ui.setProjector((w) => ({ x: w.x, y: w.y, visible: w.z >= 0 })); // dev: "world" = screen px
  ui.setBinPointer(new Vector3(-400, innerHeight * 0.55, -1)); // off-screen to the left
  const say = ['Mriguel!', 'Barcha!', 'GOOOAL!', 'Yaatik saha!'];
  let n = 0, acc = 0, last = performance.now();
  const loop = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    acc += dt;
    if (fresh) tick(run, dt);
    else {
      run.comboTimer = Math.max(0.5, run.comboTimer - dt * 0.2);
      run.timeLeft = Math.max(0, run.timeLeft - dt * 0.2);
    }
    ui.updateHud(hudState(run));
    if (acc > 1.3 && !fresh) {
      acc = 0;
      ui.callout(say[n % say.length], n % say.length === 2 ? 'good' : 'combo');
      ui.floatText(n % 3 === 2 ? '+200' : `+${45 * (n % 3 + 1)}`, new Vector3(innerWidth * (0.42 + (n % 3) * 0.08), innerHeight * 0.62, 0), n % 3 === 2 ? 'gold' : 'points');
      ui.floatText('+3 s', new Vector3(innerWidth * 0.62, innerHeight * 0.5, 0), 'time');
      n++;
    }
    hudRaf = requestAnimationFrame(loop);
  };
  cancelAnimationFrame(hudRaf);
  hudRaf = requestAnimationFrame(loop);
  setTimeout(() => ui.showHint('pickup'), 300);
  if (screen === 'hud' && !fresh) setTimeout(() => ui.callout('Mriguel!', 'combo'), 1200);
}

const click = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('.ui-screen.ui-on button')].find((b) => b.textContent?.includes(text))?.click();

const RESULT: RunResult = {
  score: rankMode === 'first' ? 15630 : rankMode === 'out' ? 2480 : 10350,
  items: 38, pickups: 44, deposits: 7, trickShots: 3, caught: 2, bestCombo: 5, longestChain: 17, durationSec: 162, hits: 2,
};

async function main(): Promise<void> {
  // Fake "real" progress for the loading screen.
  const labels = ['Paving the promenade', 'Planting the ficus trees', 'Raising the Clock Tower', 'Calling the taxis'];
  ui.setLoading(0.62, labels[1]);
  await document.fonts.ready;
  if (screen === 'loading') { (window as unknown as { __ready: boolean }).__ready = true; return; }
  ui.setLoading(1, 'Ready');
  ui.finishLoading();
  await new Promise((r) => setTimeout(r, 700));
  switch (screen) {
    case 'leaderboard': click('Leaderboard'); break;
    case 'settings': click('Settings'); break;
    case 'howto': click('How to play'); break;
    case 'credits': click('Credits'); break;
    case 'rename': click('Change name'); break;
    case 'hud': click('Play'); break;
    case 'pause': click('Play'); setTimeout(() => ui.showPause(), 300); break;
    case 'gameover': click('Play'); setTimeout(() => { cancelAnimationFrame(hudRaf); ui.showGameOver(RESULT); }, 300); break;
  }
  (window as unknown as { __ready: boolean }).__ready = true;
}

// fps readout for scripts/shot.mjs
let frames = 0, t0 = performance.now();
const w = window as unknown as { __stats: { fps: number; calls: number; triangles: number } };
w.__stats = { fps: 0, calls: 0, triangles: 0 };
const count = (now: number) => {
  frames++;
  if (now - t0 > 500) { w.__stats = { fps: Math.round((frames * 1000) / (now - t0)), calls: 0, triangles: 0 }; frames = 0; t0 = now; }
  requestAnimationFrame(count);
};
requestAnimationFrame(count);

void main();
