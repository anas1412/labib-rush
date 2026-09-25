// Audio dev page: live test bench for the real engine (buttons for every SFX, music intensity/menu,
// ambience, volumes, pause) plus offline renders for objective checks.
//
// Offline API (used by scripts/juice-audio.mjs): window.__juice
//   .sfx(name, pitch?)                  → Render   (one sound through the full mix chain, sfx bus = 1)
//   .music(seconds, script, menu?)      → Render   (script: [[time, intensity], …] applied live)
//   .ambience(seconds)                  → Render
//   .scene(seconds)                     → Render   (music + ambience + a burst of gameplay SFX at the
//                                                   default settings, i.e. what a player hears)
// Render = { stats, wav } with wav = base64 16-bit stereo PCM.
import { Vector3 } from 'three';
import { createAudio, triggerSfx } from '../src/audio/audio';
import { Ambience } from '../src/audio/ambience';
import { createMixer, type Mixer } from '../src/audio/mixer';
import { Music } from '../src/audio/music';
import { SFX } from '../src/audio/sfx';
import * as inst from '../src/audio/instruments';
import { DEFAULT_SETTINGS, type SfxName, type Settings } from '../src/core/types';

const SR = 48000;
const NAMES = Object.keys(SFX) as SfxName[];

// ---------------------------------------------------------------------------------------------
// Offline rendering + analysis

interface Stats {
  seconds: number;
  peakDb: number;
  rmsDb: number; // over the part above −50 dB
  loudDb: number; // loudest 100 ms window (RMS)
  dc: number;
  tailDb: number; // level of the last 10 ms
  activeSec: number; // time until the signal falls below −60 dB for good
  clicks: number[]; // times (s) of suspicious discontinuities
}

const db = (x: number) => (x > 0 ? 20 * Math.log10(x) : -200);

function analyse(buf: AudioBuffer): Stats {
  const L = buf.getChannelData(0), R = buf.getChannelData(1), n = buf.length;
  let peak = 0, sum = 0, sumSq = 0, act = 0, last = 0;
  const win = Math.floor(SR * 0.1);
  let loud = 0, wSq = 0;
  for (let i = 0; i < n; i++) {
    const m = 0.5 * (L[i] + R[i]);
    const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
    if (a > peak) peak = a;
    if (a > 1e-3) last = i;
    sum += m;
    const e = 0.5 * (L[i] * L[i] + R[i] * R[i]);
    if (a > 0.00316) { sumSq += e; act++; }
    wSq += e;
    if (i >= win) { const o = 0.5 * (L[i - win] ** 2 + R[i - win] ** 2); wSq -= o; }
    if (i >= win && wSq / win > loud) loud = wSq / win;
  }
  // click detector: an isolated spike in the second difference, far above its neighbourhood on
  // BOTH sides (±3 ms, excluding ±0.2 ms around it). Intentional sharp attacks keep going after
  // the onset, so they are not flagged; a discontinuity in an otherwise smooth signal is.
  const clicks: number[] = [];
  const d2 = new Float32Array(n);
  for (let i = 2; i < n; i++) d2[i] = Math.abs(L[i] - 2 * L[i - 1] + L[i - 2]);
  const cs = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + d2[i];
  const w = Math.floor(SR * 0.003), g = Math.floor(SR * 0.0002);
  for (let i = w + g; i < n - w - g; i++) {
    if (d2[i] < 0.03) continue;
    const before = (cs[i - g] - cs[i - g - w]) / w, after = (cs[i + g + w] - cs[i + g]) / w;
    if (d2[i] > 12 * (Math.max(before, after) + 1e-5) && (clicks.length === 0 || i / SR - clicks[clicks.length - 1] > 0.01)) clicks.push(+(i / SR).toFixed(4));
  }
  let tail = 0;
  for (let i = n - Math.floor(SR * 0.01); i < n; i++) tail = Math.max(tail, Math.abs(L[i]), Math.abs(R[i]));
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return {
    seconds: Math.round((n / SR) * 100) / 100, peakDb: r1(db(peak)), rmsDb: r1(db(Math.sqrt(sumSq / Math.max(1, act)))), loudDb: r1(db(Math.sqrt(loud))),
    dc: +(sum / n).toExponential(2), tailDb: r1(db(tail)), activeSec: Math.round((last / SR) * 100) / 100, clicks: clicks.slice(0, 8),
  };
}

function wav(buf: AudioBuffer): string {
  const n = buf.length, bytes = new Uint8Array(44 + n * 4), v = new DataView(bytes.buffer);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 4, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true); v.setUint32(24, SR, true);
  v.setUint32(28, SR * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 4, true);
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  for (let i = 0; i < n; i++) {
    v.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L[i])) * 32767, true);
    v.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R[i])) * 32767, true);
  }
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

interface Render { stats: Stats; wav: string }

/** Offline render driven like the live engine: every 50 ms of audio time the context suspends,
 *  `onTick(now)` runs (schedulers, scripted changes), then rendering resumes. */
async function renderOffline(seconds: number, setup: (mix: Mixer) => ((now: number) => void) | void): Promise<Render> {
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * SR), SR);
  const mix = createMixer(ctx);
  const onTick = setup(mix);
  if (onTick) {
    onTick(0);
    for (let t = 0.05; t < seconds; t += 0.05) {
      void ctx.suspend(t).then(() => { onTick(ctx.currentTime); void ctx.resume(); });
    }
  }
  const buf = await ctx.startRendering();
  return { stats: analyse(buf), wav: wav(buf) };
}

const setBuses = (mix: Mixer, s: Settings) => {
  mix.music.gain.value = s.musicVolume ** 2;
  mix.sfx.gain.value = s.sfxVolume ** 2;
  mix.ambience.gain.value = s.sfxVolume ** 2 * 0.55;
  mix.ui.gain.value = s.sfxVolume ** 2;
};

type Inst = 'doum' | 'tek' | 'ka' | 'bendir' | 'slap' | 'clap' | 'chkachek' | 'qanun' | 'bass' | 'mizwad' | 'pad';
const INST: Record<Inst, (c: BaseAudioContext, d: AudioNode, t: number) => void> = {
  doum: (c, d, t) => inst.doum(c, d, t, 1), tek: (c, d, t) => inst.tek(c, d, t, 0.9), ka: (c, d, t) => inst.tek(c, d, t, 0.8, true),
  bendir: (c, d, t) => inst.bendir(c, d, t, 0.9), slap: (c, d, t) => inst.bendir(c, d, t, 0.6, true), clap: (c, d, t) => inst.clap(c, d, t, 0.9),
  chkachek: (c, d, t) => inst.chkachek(c, d, t, 0.9), qanun: (c, d, t) => inst.qanun(c, d, t, 81, 0.85, 0.4),
  bass: (c, d, t) => inst.bass(c, d, t, 38, 0.95, 0.38), mizwad: (c, d, t) => inst.mizwad(c, d, t, 81, 0.9, 0.4),
  pad: (c, d, t) => inst.pad(c, d, t, [50, 57, 62], 1, 1.8),
};

const juice = {
  names: NAMES,
  instruments: Object.keys(INST) as Inst[],
  /** One instrument (music-layer velocity) hit 4 times through the music bus at gain 1. */
  inst(name: Inst): Promise<Render> {
    return renderOffline(2.4, (mix) => { for (let i = 0; i < 4; i++) INST[name](mix.ctx, mix.music, 0.02 + i * 0.5); });
  },
  /** raw = bypass the master dynamics (compressor/limiter/clipper) to read linear, uncompressed levels. */
  sfx(name: SfxName, pitch = 1, seconds = 3.5, raw = false): Promise<Render> {
    return renderOffline(seconds, (mix) => {
      if (raw) { mix.master.disconnect(); mix.master.connect(mix.ctx.destination); }
      triggerSfx(mix, name, 0.02, pitch);
    });
  },
  music(seconds: number, script: [number, number][] = [[0, 0]], menu = false): Promise<Render> {
    return renderOffline(seconds, (mix) => {
      const m = new Music(mix.ctx, mix.music, mix.reverb);
      m.setMenu(menu);
      m.setIntensity(script[0][1]);
      m.start(0.05);
      let k = 1;
      return (now) => {
        while (k < script.length && script[k][0] <= now) m.setIntensity(script[k++][1]);
        m.schedule(now + 0.2);
      };
    });
  },
  ambience(seconds: number): Promise<Render> {
    return renderOffline(seconds, (mix) => {
      const a = new Ambience(mix.ctx, mix.ambience, mix.reverb);
      a.start(0.02);
      return (now) => a.schedule(now + 0.2);
    });
  },
  scene(seconds: number): Promise<Render> {
    return renderOffline(seconds, (mix) => {
      setBuses(mix, DEFAULT_SETTINGS);
      const m = new Music(mix.ctx, mix.music, mix.reverb);
      m.setIntensity(0.5);
      m.start(0.05);
      const a = new Ambience(mix.ctx, mix.ambience, mix.reverb);
      a.start(0.02);
      // a busy gameplay moment: steps, a pickup chain, a deposit, a honk, a trick shot
      for (let t = 0.3; t < seconds; t += 0.19) triggerSfx(mix, 'footstep', t, 1, 0.7);
      [1, 1.4, 1.75, 2.1, 2.4].forEach((t, i) => triggerSfx(mix, 'pickup', t, 1 + i * 0.06));
      triggerSfx(mix, 'comboUp', 2.45, 1.1);
      triggerSfx(mix, 'honk', 3.2);
      triggerSfx(mix, 'deposit', 4.2);
      triggerSfx(mix, 'timeAdded', 4.4);
      triggerSfx(mix, 'kick', 5.5);
      triggerSfx(mix, 'trickShot', 6.3);
      return (now) => { m.schedule(now + 0.2); a.schedule(now + 0.2); };
    });
  },
};
(window as unknown as { __juice: typeof juice }).__juice = juice;

// ---------------------------------------------------------------------------------------------
// Live bench

const audio = createAudio();
let settings: Settings = { ...DEFAULT_SETTINGS };
audio.setSettings(settings);
const app = document.getElementById('app')!;
const log = document.getElementById('log')!;
const say = (s: string) => { log.textContent = `${s}\n${log.textContent ?? ''}`.slice(0, 3000); };
addEventListener('pointerdown', () => audio.unlock(), { capture: true });
addEventListener('keydown', () => audio.unlock(), { capture: true });

function section(title: string): HTMLDivElement {
  const h = document.createElement('h2');
  h.textContent = title;
  const row = document.createElement('div');
  row.className = 'row';
  app.append(h, row);
  return row;
}
function button(row: HTMLElement, label: string, fn: (b: HTMLButtonElement) => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.onclick = () => fn(b);
  row.append(b);
  return b;
}
function slider(row: HTMLElement, label: string, value: number, fn: (v: number) => void): void {
  const l = document.createElement('label');
  const i = document.createElement('input');
  Object.assign(i, { type: 'range', min: '0', max: '1', step: '0.01', value: String(value) });
  i.oninput = () => fn(Number(i.value));
  l.append(label, i);
  row.append(l);
}

let combo = 0;
const sfxRow = section('Sound effects');
for (const n of NAMES) {
  button(sfxRow, n, () => {
    const pitch = n === 'pickup' ? 1 + Math.min(combo++, 12) * 0.06 : 1;
    // positional demo: honks and birds come from a random side 12 m away
    const position = n === 'honk' || n === 'birds' ? new Vector3((Math.random() - 0.5) * 24, 0, -12) : undefined;
    audio.play(n, { pitch, position });
    say(`play ${n}${pitch !== 1 ? ` pitch ${pitch.toFixed(2)}` : ''}${position ? ` at x=${position.x.toFixed(1)}` : ''}`);
  });
}
button(sfxRow, 'reset combo', () => { combo = 0; });
audio.setListener(new Vector3(0, 1.6, 0), new Vector3(0, 0, -1));

const musicRow = section('Music');
button(musicRow, 'start', () => audio.startMusic());
button(musicRow, 'stop (2 s fade)', () => audio.stopMusic(2));
button(musicRow, 'menu arrangement', (b) => { b.classList.toggle('on'); audio.setMenuMusic(b.classList.contains('on')); });
slider(musicRow, 'intensity', 0, (v) => audio.setMusicIntensity(v));

const ambRow = section('Ambience');
button(ambRow, 'start', () => audio.startAmbience());
button(ambRow, 'stop', () => audio.stopAmbience());

const setRow = section('Settings');
slider(setRow, 'music', settings.musicVolume, (v) => { settings = { ...settings, musicVolume: v }; audio.setSettings(settings); });
slider(setRow, 'sfx', settings.sfxVolume, (v) => { settings = { ...settings, sfxVolume: v }; audio.setSettings(settings); });
button(setRow, 'mute', (b) => { b.classList.toggle('on'); settings = { ...settings, muted: b.classList.contains('on') }; audio.setSettings(settings); });
button(setRow, 'pause', (b) => { b.classList.toggle('on'); audio.setPaused(b.classList.contains('on')); });
button(setRow, 'ui:click event', () => dispatchEvent(new CustomEvent('ui:click', { detail: { kind: 'click' } })));

(window as unknown as { __ready: boolean }).__ready = true;
