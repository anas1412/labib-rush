// Synthesised instruments shared by the music, the jingles and the ambience. Each call schedules one
// note/stroke at time `t` into `dest` (velocity `v` ≈ 0..1). Levels are balanced so a typical
// stroke peaks around −12 dBFS at v = 1 before the mix buses.
import { env, filt, gain, mtof, noise, noiseBuffers, pan, pluckBuffer, rnd, tone, vary } from './dsp';

type Ctx = BaseAudioContext;

// ---------------------------------------------------------------------------------------------
// Tunisian percussion

/** Darbouka "doum": deep centre stroke — pitched membrane drop + ring + skin slap. */
export function doum(c: Ctx, dest: AudioNode, t: number, v: number): void {
  const f = 96 * vary(20);
  tone(c, dest, t, { f: f * 1.45, f1: f, glide: 0.05, peak: 0.2 * v, a: 0.0015, d: 0.42 });
  tone(c, dest, t, { f: f * 2.3, f1: f * 1.62, glide: 0.04, peak: 0.045 * v, d: 0.16 });
  noise(c, dest, t, { type: 'lowpass', f: 1100, q: 0.5, peak: 0.08 * v, d: 0.03 });
}

/** Darbouka "tek" (strong hand, rim) or "ka" (weak hand): bright crack + short metallic ring. */
export function tek(c: Ctx, dest: AudioNode, t: number, v: number, ka = false): void {
  const k = ka ? 0.55 : 1;
  noise(c, dest, t, { type: 'bandpass', f: (ka ? 2900 : 3600) * vary(80), q: 0.9, peak: 0.4 * v * k, d: ka ? 0.03 : 0.045 });
  noise(c, dest, t, { type: 'highpass', f: 7000, peak: 0.1 * v * k, d: 0.006 });
  tone(c, dest, t, { type: 'triangle', f: 830 * vary(30), peak: 0.07 * v * k, d: 0.06 });
  tone(c, dest, t, { f: 2940 * vary(30), peak: 0.035 * v * k, d: 0.05 });
}

/** Bendir (frame drum with snares): very deep boom plus snare buzz, or an edge slap. */
export function bendir(c: Ctx, dest: AudioNode, t: number, v: number, slap = false): void {
  if (!slap) tone(c, dest, t, { f: 82, f1: 58, glide: 0.12, peak: 0.17 * v, a: 0.004, d: 0.55 });
  noise(c, dest, t, { type: 'bandpass', f: slap ? 1500 : 900, q: 0.8, peak: (slap ? 0.3 : 0.06) * v, d: slap ? 0.07 : 0.05 });
  // snare jangle: bright noise with a slower attack, the gut snares buzzing against the skin
  noise(c, dest, t + 0.004, { type: 'bandpass', f: 4200, q: 0.6, peak: (slap ? 0.12 : 0.09) * v, a: 0.01, d: slap ? 0.16 : 0.24 });
}

/** Handclap: 3 quick "flams" and a short tail, like two or three people clapping together. */
export function clap(c: Ctx, dest: AudioNode, t: number, v: number): void {
  const p = pan(c, rnd(-0.35, 0.35), dest);
  const f = 1250 * vary(120);
  for (const dt of [0, 0.008 + rnd(0, 0.004), 0.019 + rnd(0, 0.005)]) noise(c, p, t + dt, { type: 'bandpass', f, q: 1.4, peak: 0.7 * v, d: 0.012 });
  noise(c, p, t + 0.026, { type: 'bandpass', f: f * 1.1, q: 1.1, peak: 0.8 * v, d: 0.12 });
}

/** Chkacheks (iron castanets) / riq jingles: tiny metallic clack. */
export function chkachek(c: Ctx, dest: AudioNode, t: number, v: number): void {
  noise(c, dest, t, { type: 'bandpass', f: 7200 * vary(60), q: 2.2, peak: 0.22 * v, d: 0.035 });
  tone(c, dest, t, { f: 4150 * vary(20), peak: 0.03 * v, d: 0.03 });
  tone(c, dest, t, { f: 6230 * vary(20), peak: 0.02 * v, d: 0.025 });
}

// ---------------------------------------------------------------------------------------------
// Melodic

/** Qanun course: Karplus–Strong strings + a plectrum click. `len` = seconds before damping. */
export function qanun(c: Ctx, dest: AudioNode, t: number, midi: number, v: number, len = 1.2): void {
  const src = c.createBufferSource();
  src.buffer = pluckBuffer(c, midi);
  const g = gain(c, 0, dest);
  src.connect(g);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.58 * v, t + 0.0015); // no step at the pluck
  const damp = t + Math.min(len, 1.5);
  g.gain.setTargetAtTime(0, damp, 0.06);
  src.start(t);
  src.stop(Math.min(t + 1.6, damp + 0.4));
  noise(c, dest, t, { type: 'bandpass', f: 5000, q: 0.8, peak: 0.05 * v, d: 0.006 }); // plectrum tick
}

/** Synth bass: sub sine + filtered saw with a plucky filter envelope. */
export function bass(c: Ctx, dest: AudioNode, t: number, midi: number, v: number, len: number): void {
  const f = mtof(midi);
  const lp = filt(c, 'lowpass', 900, 3, dest);
  lp.frequency.setValueAtTime(260 + 900 * v, t);
  lp.frequency.exponentialRampToValueAtTime(220, t + 0.18);
  const d = Math.min(0.5, len * 0.9);
  tone(c, lp, t, { type: 'sawtooth', f, peak: 0.06 * v, a: 0.004, hold: len * 0.4, d });
  tone(c, dest, t, { f, peak: 0.09 * v, a: 0.006, hold: len * 0.5, d });
}

/** Mizwad (Tunisian bagpipe) style reed lead: nasal double-reed formants with a slow vibrato. */
export function mizwad(c: Ctx, dest: AudioNode, t: number, midi: number, v: number, len: number): void {
  const f = mtof(midi);
  const out = gain(c, 1, dest);
  const body = filt(c, 'peaking', 1450, 2.2, filt(c, 'highpass', 380, 0.7, filt(c, 'lowpass', 5200, 0.7, out)));
  body.gain.value = 9;
  const hold = Math.max(0.02, len - 0.04);
  tone(c, body, t, { type: 'sawtooth', f, peak: 0.075 * v, a: 0.025, hold, d: 0.07, vib: [5.6, 11] });
  tone(c, body, t, { type: 'square', f, detune: 7, peak: 0.038 * v, a: 0.03, hold, d: 0.07, vib: [5.3, 9] });
}

/** Soft drone pad (two detuned saws per note through a gentle lowpass). */
export function pad(c: Ctx, dest: AudioNode, t: number, midis: readonly number[], v: number, len: number): void {
  const lp = filt(c, 'lowpass', 650, 0.5, dest);
  for (const m of midis) for (const det of [-9, 8]) {
    tone(c, lp, t, { type: 'sawtooth', f: mtof(m), detune: det, peak: 0.012 * v, a: Math.min(1.2, len * 0.3), hold: len * 0.5, d: len * 0.4 });
  }
}

/** Bright bell/chime: FM sine with an inharmonic partial. */
export function bell(c: Ctx, dest: AudioNode, t: number, f: number, peak: number, d: number): void {
  tone(c, dest, t, { f, peak, d, fm: [2, 1.2, d * 0.2] });
  tone(c, dest, t, { f: f * 2.76, peak: peak * 0.16, d: d * 0.35 });
}

/** Marimba-like bar: warm fundamental + short 4th partial + mallet tick. */
export function marimba(c: Ctx, dest: AudioNode, t: number, f: number, peak: number): void {
  tone(c, dest, t, { f, peak, d: 0.38 });
  tone(c, dest, t, { f: f * 3.93, peak: peak * 0.25, d: 0.05 });
  noise(c, dest, t, { type: 'lowpass', f: 2500, peak: peak * 0.3, d: 0.005 });
}

/** Brass stab (fanfare): three detuned saws, opening filter, late vibrato. */
export function brass(c: Ctx, dest: AudioNode, t: number, midi: number, v: number, len: number): void {
  const f = mtof(midi);
  const lp = filt(c, 'lowpass', 500, 1.2, dest);
  lp.frequency.setValueAtTime(500, t);
  lp.frequency.exponentialRampToValueAtTime(3200, t + 0.06);
  lp.frequency.exponentialRampToValueAtTime(1700, t + 0.06 + len);
  for (const det of [-8, 0, 7]) tone(c, lp, t, { type: 'sawtooth', f, detune: det, peak: 0.07 * v, a: 0.03, hold: len, d: 0.18, vib: [5.5, 8] });
}

/** Crash/ride cymbal wash. */
export function cymbal(c: Ctx, dest: AudioNode, t: number, v: number, d = 1.6): void {
  noise(c, dest, t, { type: 'highpass', f: 5500, q: 0.5, peak: 0.22 * v, a: 0.002, d });
  noise(c, dest, t, { type: 'bandpass', f: 3200, q: 0.8, peak: 0.1 * v, d: d * 0.4 });
}

// ---------------------------------------------------------------------------------------------
// Voices of the city

/** Stadium-style crowd cheer: formant-filtered shouting voices, breath noise and applause. */
export function crowd(c: Ctx, dest: AudioNode, t: number, dur: number, v: number): void {
  const bus = gain(c, v, dest);
  for (let i = 0; i < 12; i++) {
    const st = t + rnd(0, 0.22);
    const f0 = rnd(190, 430);
    const o = c.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(f0 * 0.82, st);
    o.frequency.exponentialRampToValueAtTime(f0 * rnd(1.05, 1.3), st + rnd(0.25, 0.6));
    o.frequency.exponentialRampToValueAtTime(f0 * rnd(0.78, 0.95), st + dur);
    const lfo = c.createOscillator();
    lfo.frequency.value = rnd(4.5, 7.5);
    lfo.connect(gain(c, rnd(15, 35), o.detune));
    const g = gain(c, 0, pan(c, rnd(-0.85, 0.85), bus));
    // "ah" / "eh" vowel formants
    o.connect(filt(c, 'bandpass', rnd(650, 880), 5, g));
    o.connect(filt(c, 'bandpass', rnd(1150, 1750), 7, gain(c, 0.7, g)));
    o.connect(filt(c, 'bandpass', rnd(2450, 2950), 9, gain(c, 0.4, g)));
    const end = env(g.gain, st, rnd(0.18, 0.3), rnd(0.12, 0.25), dur * rnd(0.45, 0.6), dur * rnd(0.3, 0.45));
    o.start(st); o.stop(end);
    lfo.start(st); lfo.stop(end);
  }
  noise(c, bus, t, { kind: 'pink', type: 'bandpass', f: 1300, q: 0.55, peak: 0.16, a: 0.15, hold: dur * 0.35, d: dur * 0.6 });
  // applause: many individual claps thinning out
  for (let i = 0; i < 42; i++) {
    const ct = t + 0.12 + dur * Math.random() ** 1.6;
    const k = 1 - (ct - t) / (dur * 1.15);
    noise(c, pan(c, rnd(-0.9, 0.9), bus), ct, { type: 'bandpass', f: rnd(900, 2400), q: 1.3, peak: rnd(0.06, 0.16) * k, d: 0.018 });
  }
}

/** Referee pea whistle: a trilled ~3 kHz blast (the pea rattles at ~30 Hz). */
export function refWhistle(c: Ctx, dest: AudioNode, t: number, blasts: readonly (readonly [number, number])[]): void {
  const f = 2950 * vary(40);
  for (const [dt, len] of blasts) {
    tone(c, dest, t + dt, { f, peak: 0.17, a: 0.01, hold: len, d: 0.05, fm: [0.011, 0.055] });
    noise(c, dest, t + dt, { type: 'bandpass', f, q: 5, peak: 0.08, a: 0.01, hold: len, d: 0.05 });
  }
}

/** Two-finger "wheet-wheeoo" whistle from the crowd. */
export function fingerWhistle(c: Ctx, dest: AudioNode, t: number): void {
  const f = 2200 * vary(80);
  tone(c, dest, t, { f: f * 0.7, f1: f * 1.4, glide: 0.12, peak: 0.1, a: 0.02, d: 0.14 });
  const o = c.createOscillator();
  const g = gain(c, 0, dest);
  o.connect(g);
  o.frequency.setValueAtTime(f * 1.05, t + 0.24);
  o.frequency.exponentialRampToValueAtTime(f * 1.45, t + 0.34);
  o.frequency.exponentialRampToValueAtTime(f * 0.95, t + 0.62);
  const end = env(g.gain, t + 0.24, 0.1, 0.03, 0.12, 0.25);
  o.start(t + 0.24); o.stop(end);
}

/** A starling's burst of whistles, clicks and rattles (`n` calls over ~`dur` s). */
export function starling(c: Ctx, dest: AudioNode, t: number, dur: number, v: number, n = 10): void {
  const p = pan(c, rnd(-0.8, 0.8), dest);
  let tt = t;
  for (let i = 0; i < n && tt < t + dur; i++) {
    const kind = Math.random();
    const f = rnd(2200, 4200);
    if (kind < 0.3) tone(c, p, tt, { f, f1: f * rnd(1.4, 1.9), glide: 0.07, peak: 0.1 * v, a: 0.004, d: rnd(0.05, 0.09) });
    else if (kind < 0.55) tone(c, p, tt, { f: f * 1.4, f1: f * rnd(0.6, 0.8), glide: 0.06, peak: 0.09 * v, a: 0.003, d: rnd(0.04, 0.08) });
    else if (kind < 0.75) tone(c, p, tt, { f, peak: 0.07 * v, a: 0.01, hold: rnd(0.05, 0.12), d: 0.04, fm: [rnd(0.01, 0.02), rnd(0.08, 0.15)] });
    else {
      // rattle: a rapid run of clicks
      const clicks = 4 + ((Math.random() * 5) | 0);
      for (let k = 0; k < clicks; k++) noise(c, p, tt + k * 0.014, { type: 'bandpass', f: rnd(4500, 6500), q: 3, peak: 0.12 * v, d: 0.006 });
    }
    tt += rnd(0.05, 0.2);
  }
}

/** Pigeon/starling wing flutter as a flock takes off. */
export function wings(c: Ctx, dest: AudioNode, t: number, v: number): void {
  for (let b = 0; b < 3; b++) {
    const p = pan(c, rnd(-0.7, 0.7), dest);
    const rate = rnd(12, 17);
    const flaps = 8 + ((Math.random() * 6) | 0);
    const st = t + rnd(0, 0.15);
    for (let i = 0; i < flaps; i++) {
      const k = 1 - i / (flaps + 2);
      noise(c, p, st + i / rate + rnd(-0.004, 0.004), { kind: 'pink', type: 'bandpass', f: rnd(700, 1300), q: 0.9, peak: 0.25 * v * k, a: 0.012, d: 0.045 });
    }
  }
}

/** Continuous looping noise bed (for ambience): returns the source and its output gain. */
export function noiseBed(c: Ctx, dest: AudioNode, kind: 'white' | 'pink' | 'brown', type: BiquadFilterType, f: number, q: number, level: number) {
  const src = c.createBufferSource();
  src.buffer = noiseBuffers(c)[kind];
  src.loop = true;
  const g = gain(c, level, dest);
  src.connect(filt(c, type, f, q, g));
  return { src, g };
}
