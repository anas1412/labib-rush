// Every game sound effect, synthesised procedurally. Each voice schedules into `o` (a per-play gain
// that carries the caller's volume) at time `t`; `p` is the pitch factor (1 = normal).
// Small random variation (vary/rnd) keeps repeats from sounding robotic.
import type { SfxName } from '../core/types';
import { filt, gain, noise, pan, pick, rnd, shaper, tone, vary } from './dsp';
import {
  bass, bell, brass, clap, crowd, cymbal, doum, fingerWhistle, marimba, pad, qanun, refWhistle, starling, tek, wings,
} from './instruments';

type Ctx = BaseAudioContext;
export type SfxVoice = (c: Ctx, o: AudioNode, t: number, p: number) => void;

// D Hijaz, the scale the music uses, so jingles sit in the same key
const D5 = 74, Eb5 = 75, Fs5 = 78, G5 = 79, A5 = 81, Bb5 = 82, D4 = 62, D3 = 50, A3 = 57;

let tock = false;

export const SFX: Record<SfxName, SfxVoice> = {
  // ---- litter
  pickup(c, o, t, p) {
    const f = 1046.5 * p * vary(12); // C6, raised by the combo
    tone(c, o, t, { f: 560 * p, f1: 170, glide: 0.05, peak: 0.3, d: 0.07 }); // tactile "pop"
    bell(c, o, t, f, 0.26, 0.2);
    bell(c, o, t + 0.055, f * 1.5, 0.24, 0.34);
    noise(c, o, t, { type: 'highpass', f: 6500, peak: 0.1, d: 0.025 });
  },

  pickupRare(c, o, t, p) {
    const f = 1174.7 * p; // D6 arpeggio up a bright major-Hijaz shape
    [1, 1.26, 1.5, 2, 2.52, 3].forEach((r, i) => bell(c, pan(c, (i % 2 ? 0.3 : -0.3), o), t + i * 0.05, f * r * vary(5), 0.2 - i * 0.015, 0.7));
    noise(c, o, t, { type: 'highpass', f: 7500, peak: 0.05, a: 0.05, hold: 0.25, d: 0.8 }); // shimmer air
    for (let i = 0; i < 8; i++) bell(c, pan(c, rnd(-0.7, 0.7), o), t + 0.32 + i * rnd(0.05, 0.11), f * pick([2, 2.52, 3, 4]), 0.06 * (1 - i / 9), 0.35);
    tone(c, o, t, { f: f / 2, peak: 0.08, a: 0.08, hold: 0.2, d: 0.9 }); // warm bed
    tone(c, o, t, { f: (f / 2) * 1.5, peak: 0.05, a: 0.1, hold: 0.2, d: 0.9 });
  },

  bagFull(c, o, t, p) {
    const lp = filt(c, 'lowpass', 1800, 0.7, o);
    tone(c, lp, t, { type: 'square', f: 587 * p, peak: 0.13, d: 0.11 });
    tone(c, lp, t + 0.12, { type: 'square', f: 440 * p, peak: 0.13, d: 0.2 });
    noise(c, o, t, { type: 'bandpass', f: 3000, q: 1.5, peak: 0.08, d: 0.12 }); // bag rustle
  },

  deposit(c, o, t, p) {
    // hollow thunk: body drop + two resonances of the empty bin
    tone(c, o, t, { f: 150 * p, f1: 68, glide: 0.09, peak: 0.55, d: 0.24 });
    noise(c, filt(c, 'bandpass', 235 * p, 7, gain(c, 3.2, o)), t, { type: 'lowpass', f: 1500, peak: 1, d: 0.14 });
    noise(c, filt(c, 'bandpass', 540 * p, 9, gain(c, 2.2, o)), t, { type: 'lowpass', f: 2200, peak: 1, d: 0.1 });
    // rattle: items tumbling in
    let tt = t + 0.04;
    for (let i = 0; i < 9; i++) {
      tt += rnd(0.018, 0.05);
      const k = 1 - i / 10;
      noise(c, o, tt, { type: 'bandpass', f: rnd(1800, 4200), q: 5, peak: 0.36 * k, d: rnd(0.015, 0.04) });
      if (Math.random() < 0.5) tone(c, o, tt, { f: rnd(900, 2600), peak: 0.05 * k, d: 0.05 });
    }
    // reward chime
    bell(c, o, t + 0.13, 1318.5 * p, 0.11, 0.35);
    bell(c, o, t + 0.21, 1975.5 * p, 0.09, 0.5);
  },

  trickShot(c, o, t) {
    tone(c, o, t, { f: 95, f1: 38, glide: 0.35, peak: 0.45, d: 0.55 }); // stadium boom
    refWhistle(c, o, t, [[0, 0.1], [0.17, 0.07], [0.3, 0.5]]);
    crowd(c, o, t + 0.08, 2.4, 1);
  },

  cheer(c, o, t) {
    crowd(c, o, t, 2.2, 0.9);
    fingerWhistle(c, pan(c, rnd(-0.6, 0.6), o), t + rnd(0.2, 0.5));
    if (Math.random() < 0.6) fingerWhistle(c, pan(c, rnd(-0.6, 0.6), o), t + rnd(0.9, 1.3));
  },

  caught(c, o, t, p) {
    [D5, Fs5, A5, D5 + 12].forEach((m, i) => marimba(c, o, t + i * 0.06, 587.33 * 2 ** ((m - D5) / 12) * p, 0.26));
    noise(c, o, t, { type: 'bandpass', f: 800, f1: 4000, glide: 0.12, q: 1.2, peak: 0.1, a: 0.02, d: 0.12 }); // swish
    tek(c, o, t + 0.24, 0.9);
  },

  litterThrown(c, o, t, p) {
    // cartoon "uh-oh": two falling syllables through "oh" formants
    const f = 392 * p * vary(20);
    for (const [dt, ff] of [[0, f], [0.17, f * 0.8]] as const) {
      const g = gain(c, 1, o);
      const f1 = filt(c, 'bandpass', 560, 5, g), f2 = filt(c, 'bandpass', 950, 6, g);
      const src = gain(c, 1);
      src.connect(f1); src.connect(f2);
      tone(c, src, t + dt, { type: 'sawtooth', f: ff * 1.04, f1: ff, glide: 0.05, peak: 0.5, a: 0.015, hold: 0.07, d: 0.09, vib: [6, 20] });
    }
    for (let i = 0; i < 8; i++) noise(c, o, t + 0.02 + i * rnd(0.012, 0.025), { type: 'highpass', f: rnd(3000, 6000), peak: rnd(0.04, 0.09), d: 0.01 }); // wrapper crinkle
  },

  // ---- power-ups
  powerup(c, o, t, p) {
    noise(c, o, t, { type: 'bandpass', f: 400, f1: 5000, glide: 0.38, q: 1.6, peak: 0.12, a: 0.25, d: 0.2 });
    tone(c, o, t, { type: 'triangle', f: 330 * p, f1: 1320 * p, glide: 0.35, peak: 0.14, a: 0.05, d: 0.4, vib: [9, 25] });
    [1, 1.26, 1.5, 2, 2.52].forEach((r, i) => bell(c, pan(c, i % 2 ? 0.35 : -0.35, o), t + 0.3 + i * 0.045, 1174.7 * p * r, 0.14, 0.45));
    noise(c, o, t + 0.3, { type: 'highpass', f: 8000, peak: 0.05, a: 0.02, d: 0.6 });
  },

  powerupEnd(c, o, t, p) {
    tone(c, o, t, { f: 880 * p, f1: 300 * p, glide: 0.36, peak: 0.15, a: 0.01, d: 0.4, vib: [9, 40] });
    tone(c, o, t, { type: 'triangle', f: 440 * p, f1: 150 * p, glide: 0.36, peak: 0.08, d: 0.4 });
  },

  timeAdded(c, o, t, p) {
    bell(c, o, t, 1760 * p, 0.16, 0.4);
    bell(c, o, t + 0.07, 2637 * p, 0.14, 0.55);
    noise(c, o, t + 0.05, { type: 'highpass', f: 8500, peak: 0.04, d: 0.25 });
  },

  // ---- hazards
  hit(c, o, t, p) {
    tone(c, o, t, { f: 170 * p, f1: 45, glide: 0.2, peak: 0.8, d: 0.32 }); // thump
    noise(c, o, t, { type: 'lowpass', f: 3000, f1: 350, glide: 0.1, q: 0.8, peak: 0.6, d: 0.13 }); // crunch
    for (const f of [523, 1247, 1873, 2711]) tone(c, o, t + 0.003, { f: f * vary(30), peak: 0.05, d: rnd(0.15, 0.35) }); // bodywork clank
    tone(c, o, t + 0.06, { type: 'triangle', f: 720 * p, f1: 210 * p, glide: 0.45, peak: 0.13, a: 0.01, d: 0.5, vib: [11, 70] }); // dizzy
    for (let i = 0; i < 3; i++) tone(c, o, t + 0.32 + i * 0.13, { f: 3100 * vary(60), f1: 3700, glide: 0.04, peak: 0.035, d: 0.06 }); // birdies
  },

  honk(c, o, t, p) {
    // classic two-tone car horn, a major third apart, buzzy diaphragm through a horn resonance
    const f1 = 415 * p * vary(35), f2 = f1 * 1.26;
    const out = filt(c, 'lowpass', 4500, 0.7, o);
    const body = filt(c, 'bandpass', 1900, 0.8, gain(c, 0.45, out));
    const drive = shaper(c, 2.5, body);
    const blasts: readonly (readonly [number, number])[] = Math.random() < 0.45 ? [[0, 0.11], [0.19, 0.36]] : [[0, rnd(0.3, 0.5)]];
    for (const [dt, len] of blasts) for (const f of [f1, f2]) {
      const osc = c.createOscillator();
      osc.type = 'square';
      osc.frequency.setValueAtTime(f * 0.96, t + dt);
      osc.frequency.exponentialRampToValueAtTime(f, t + dt + 0.03);
      const g = gain(c, 0, drive);
      osc.connect(g);
      g.gain.setValueAtTime(0, t + dt);
      g.gain.linearRampToValueAtTime(0.32, t + dt + 0.012);
      g.gain.setValueAtTime(0.32, t + dt + len);
      g.gain.linearRampToValueAtTime(0, t + dt + len + 0.035);
      osc.start(t + dt);
      osc.stop(t + dt + len + 0.05);
    }
  },

  // ---- Labib
  jump(c, o, t, p) {
    const q = p * vary(50);
    tone(c, o, t, { type: 'triangle', f: 190 * q, f1: 560 * q, glide: 0.13, peak: 0.2, a: 0.004, d: 0.22, vib: [22, 70] }); // boing
    tone(c, o, t, { f: 380 * q, f1: 1120 * q, glide: 0.13, peak: 0.05, a: 0.004, d: 0.15 });
    noise(c, o, t, { type: 'bandpass', f: 900, f1: 2600, glide: 0.12, q: 1.2, peak: 0.07, a: 0.01, d: 0.13 }); // whoosh
  },

  land(c, o, t, p) {
    tone(c, o, t, { f: 115 * p, f1: 45, glide: 0.08, peak: 0.5, d: 0.13 });
    noise(c, o, t, { kind: 'pink', type: 'lowpass', f: 600, peak: 0.5, d: 0.08 });
    noise(c, o, t + 0.004, { type: 'bandpass', f: rnd(2200, 3200), q: 1.5, peak: 0.1, d: 0.05 }); // grit on stone
  },

  footstep(c, o, t, p) {
    noise(c, o, t, { type: 'bandpass', f: rnd(1300, 2400) * p, q: 1.4, peak: 0.24, a: 0.002, d: 0.045 }); // scuff
    noise(c, o, t, { kind: 'pink', type: 'lowpass', f: 330, peak: 0.55, d: 0.05 }); // pad on stone
    if (Math.random() < 0.6) noise(c, o, t + rnd(0.005, 0.02), { type: 'highpass', f: 6500, peak: 0.07, d: 0.01 }); // claw tick
  },

  kick(c, o, t, p) {
    tone(c, o, t, { f: 190 * p, f1: 52, glide: 0.09, peak: 0.85, d: 0.17 }); // punch
    noise(c, o, t, { type: 'bandpass', f: 1300, q: 1, peak: 0.5, d: 0.035 }); // thwack
    noise(c, o, t, { type: 'highpass', f: 4500, peak: 0.2, d: 0.008 }); // click
    noise(c, o, t + 0.015, { type: 'bandpass', f: 2600, f1: 500, glide: 0.2, q: 0.8, peak: 0.11, a: 0.03, d: 0.18 }); // air
  },

  radar(c, o, t, p) {
    noise(c, o, t, { type: 'bandpass', f: 500, f1: 3600, glide: 0.25, q: 2, peak: 0.1, a: 0.1, d: 0.15 }); // ears sweep
    tone(c, o, t, { f: 170, f1: 70, glide: 0.35, peak: 0.28, d: 0.4 }); // pulse
    [0, 0.34, 0.68].forEach((dt, i) => {
      const lp = filt(c, 'lowpass', 6000 / (i + 1), 0.7, pan(c, [0, -0.55, 0.55][i], o));
      tone(c, lp, t + 0.08 + dt, { f: 1250 * p, peak: [0.26, 0.1, 0.045][i], a: 0.004, d: 1.1, fm: [1.5, 0.06] });
    });
  },

  comboUp(c, o, t, p) {
    [1, 1.26, 1.5, 2].forEach((r, i) => bell(c, o, t + i * 0.045, 880 * p * r, 0.15, 0.3));
    noise(c, o, t, { type: 'bandpass', f: 2000, f1: 7000, glide: 0.18, q: 1, peak: 0.06, a: 0.05, d: 0.12 });
  },

  comboBreak(c, o, t, p) {
    const lp = filt(c, 'lowpass', 1400, 0.7, o);
    tone(c, lp, t, { type: 'triangle', f: 392 * p, f1: 370 * p, glide: 0.14, peak: 0.2, a: 0.01, d: 0.16, vib: [7, 30] });
    tone(c, lp, t + 0.16, { type: 'triangle', f: 330 * p, f1: 262 * p, glide: 0.3, peak: 0.2, a: 0.01, d: 0.34, vib: [6, 40] });
  },

  // ---- timer / session
  tick(c, o, t, p) {
    tock = !tock;
    const f = (tock ? 1480 : 1900) * p;
    tone(c, o, t, { f, peak: 0.3, a: 0.001, d: 0.05 }); // wood block
    tone(c, o, t, { f: f * 2.3, peak: 0.07, a: 0.001, d: 0.02 });
    noise(c, o, t, { type: 'bandpass', f: 3000, q: 3, peak: 0.3, d: 0.014 });
    tone(c, o, t, { f: 72, f1: 45, glide: 0.1, peak: 0.3, d: 0.12 }); // low pulse, adds urgency
  },

  countdown(c, o, t, p) {
    tone(c, o, t, { f: 880 * p, peak: 0.3, a: 0.003, hold: 0.06, d: 0.22 });
    tone(c, o, t, { type: 'triangle', f: 1760 * p, peak: 0.06, a: 0.003, d: 0.12 });
  },

  go(c, o, t, p) {
    for (const r of [1, 1.26, 1.5]) tone(c, o, t, { type: 'triangle', f: 1174.7 * p * r, peak: 0.13, a: 0.004, hold: 0.22, d: 0.45 });
    tone(c, o, t, { f: 110, f1: 45, glide: 0.25, peak: 0.4, d: 0.35 });
    noise(c, o, t, { type: 'bandpass', f: 800, f1: 6000, glide: 0.3, q: 1, peak: 0.1, a: 0.02, d: 0.3 });
    cymbal(c, o, t, 0.5, 0.9);
  },

  gameOver(c, o, t, p) {
    // Hijaz cadence on qanun over a darbouka turnaround, landing on D
    const s = 0.127; // one 16th at the music's 118 BPM
    const line: readonly (readonly [number, number])[] = [[0, A5], [1, Bb5], [2, A5], [3, G5], [4, Fs5], [6, G5], [7, Fs5], [8, Eb5], [10, D5]];
    for (const [st, m] of line) qanun(c, o, t + st * s, Math.round(m + 12 * Math.log2(p)), st === 10 ? 1 : 0.8, st === 10 ? 1.6 : 0.5);
    for (let i = 0; i < 6; i++) qanun(c, o, t + 10 * s + 0.4 + i * 0.065, D5, 0.35 * (1 - i / 7), 0.3); // tremolo tail
    doum(c, o, t, 0.8); tek(c, o, t + 2 * s, 0.7); tek(c, o, t + 3 * s, 0.5, true);
    doum(c, o, t + 4 * s, 0.7); tek(c, o, t + 6 * s, 0.7); tek(c, o, t + 7 * s, 0.6, true); tek(c, o, t + 8 * s, 0.8);
    doum(c, o, t + 10 * s, 1);
    bass(c, o, t + 10 * s, D3 - 12, 0.9, 1.2);
    pad(c, o, t + 10 * s, [D3, A3, D4], 1.3, 1.6);
  },

  newBest(c, o, t) {
    // brass fanfare "ta-ta-ta TAAA" in D, cymbal swell, claps
    const s = 0.11;
    for (const [dt, m, len] of [[0, D5, 0.08], [s, D5, 0.08], [2 * s, D5, 0.08], [3 * s, G5, 0.2], [5 * s, Fs5, 0.08], [6 * s, A5, 0.75]] as const) {
      brass(c, o, t + dt, m, 1, len);
      brass(c, o, t + dt, m - 12, 0.6, len);
      if (dt >= 3 * s) brass(c, o, t + dt, m - 5, 0.5, len);
    }
    doum(c, o, t + 3 * s, 0.9);
    doum(c, o, t + 6 * s, 1);
    cymbal(c, o, t + 6 * s, 0.9, 1.8);
    for (let i = 0; i < 4; i++) clap(c, o, t + 6 * s + 0.25 + i * 0.254, 0.6);
    [1, 1.26, 1.5, 2, 2.52, 3].forEach((r, i) => bell(c, pan(c, rnd(-0.5, 0.5), o), t + 6 * s + 0.05 + i * 0.06, 1174.7 * r, 0.07, 0.5));
  },

  // ---- UI
  uiClick(c, o, t) {
    tone(c, o, t, { f: 1800 * vary(20), peak: 0.2, a: 0.001, d: 0.028 });
    noise(c, o, t, { type: 'highpass', f: 5000, peak: 0.08, d: 0.005 });
  },
  uiHover(c, o, t) {
    tone(c, o, t, { f: 2600 * vary(15), peak: 0.055, a: 0.002, d: 0.02 });
  },
  uiBack(c, o, t) {
    tone(c, o, t, { f: 1400, f1: 900, glide: 0.06, peak: 0.16, a: 0.002, d: 0.07 });
  },

  // ---- birds (flock scattering as Labib runs through)
  birds(c, o, t) {
    wings(c, o, t, 1);
    for (let i = 0; i < 3; i++) starling(c, o, t + rnd(0.05, 0.3), 1.4, 1, 9);
  },
};

/** Reverb send per sound (0..1). */
export const WET: Partial<Record<SfxName, number>> = {
  cheer: 0.4, trickShot: 0.4, newBest: 0.3, gameOver: 0.3, honk: 0.2, radar: 0.35, deposit: 0.15, pickup: 0.12,
  pickupRare: 0.3, powerup: 0.25, comboUp: 0.15, timeAdded: 0.2, go: 0.2, birds: 0.25, caught: 0.15, litterThrown: 0.15, hit: 0.1,
};

/** Per-sound trim (linear), set from the offline loudness measurements (scripts/juice-audio.mjs). */
export const LEVEL: Partial<Record<SfxName, number>> = {
  // loudness plan (raw 100 ms RMS at sfx bus 1): steps/UI ≈ −28, frequent feedback −23…−19,
  // rewards −18…−16, big moments (trick shot, new best, game over, hit) −16…−14
  pickupRare: 1.26, bagFull: 1.8, deposit: 0.83, trickShot: 0.88, cheer: 1.5, caught: 0.95, litterThrown: 1.15,
  powerup: 2.4, powerupEnd: 1.1, timeAdded: 1.3, hit: 0.63, honk: 1.2, jump: 1.5, land: 0.7, footstep: 1.4, kick: 0.72,
  radar: 1.05, comboUp: 1.45, comboBreak: 1.14, tick: 1.37, countdown: 0.7, go: 0.8, gameOver: 0.75, newBest: 1.4,
  uiClick: 1.4, uiHover: 1.7, uiBack: 1.3, birds: 1.7,
};

/** Minimum spacing (s) between two plays of the same sound; extra requests are dropped. */
export const MIN_GAP: Partial<Record<SfxName, number>> = { footstep: 0.07, pickup: 0.035, uiHover: 0.04, tick: 0.2, honk: 0.25, land: 0.08 };
