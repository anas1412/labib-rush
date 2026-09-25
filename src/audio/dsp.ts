// Tiny WebAudio synthesis kit shared by the SFX, music and ambience. Everything takes a
// BaseAudioContext, so the exact same code renders live (AudioContext) and offline
// (OfflineAudioContext, used by dev/audio.ts to verify levels and spectra).
//
// Conventions: `t` is an absolute context time (s); `dest` is the node a voice connects into.
// Voices build a short-lived node chain, schedule it, and stop their sources at the end, so the
// browser garbage-collects the whole chain afterwards (nothing to dispose).

export const rnd = (a: number, b: number): number => a + Math.random() * (b - a);
export const pick = <T>(list: readonly T[]): T => list[(Math.random() * list.length) | 0];
export const mtof = (m: number): number => 440 * 2 ** ((m - 69) / 12);
/** Random pitch factor within ±cents, so repeats never sound machine-identical. */
export const vary = (cents: number): number => 2 ** (rnd(-cents, cents) / 1200);

// ---------------------------------------------------------------------------------------------
// Noise buffers (one set per context, 3 s mono; sources start at a random offset and loop)

export interface NoiseSet { white: AudioBuffer; pink: AudioBuffer; brown: AudioBuffer }
export type NoiseKind = keyof NoiseSet;
const noiseCache = new WeakMap<BaseAudioContext, NoiseSet>();

export function noiseBuffers(ctx: BaseAudioContext): NoiseSet {
  let set = noiseCache.get(ctx);
  if (set) return set;
  const len = Math.floor(ctx.sampleRate * 3);
  const make = (fill: (d: Float32Array) => void) => {
    const b = ctx.createBuffer(1, len, ctx.sampleRate);
    fill(b.getChannelData(0));
    return b;
  };
  set = {
    white: make((d) => { for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1; }),
    // Paul Kellet's economy pink filter
    pink: make((d) => {
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99765 * b0 + w * 0.099046;
        b1 = 0.963 * b1 + w * 0.2965164;
        b2 = 0.57 * b2 + w * 1.0526913;
        d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
      }
    }),
    // leaky-integrated white noise (−6 dB/oct): rumble beds
    brown: make((d) => {
      let y = 0;
      for (let i = 0; i < len; i++) { y = (y + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = y * 3.5; }
    }),
  };
  // zero mean (brown noise wanders), then crossfade the last 20 ms into the start so looping
  // sources never click at the seam
  const xf = Math.floor(ctx.sampleRate * 0.02);
  for (const b of [set.white, set.pink, set.brown]) {
    const d = b.getChannelData(0);
    let mean = 0;
    for (let i = 0; i < len; i++) mean += d[i];
    mean /= len;
    for (let i = 0; i < len; i++) d[i] -= mean;
    for (let i = 0; i < xf; i++) {
      const k = i / xf;
      d[len - xf + i] = d[len - xf + i] * (1 - k) + d[i] * k;
    }
  }
  noiseCache.set(ctx, set);
  return set;
}

// ---------------------------------------------------------------------------------------------
// Node helpers

/** Gain node, optionally connected to a node or (for modulation) an AudioParam. */
export function gain(ctx: BaseAudioContext, value: number, dest?: AudioNode | AudioParam): GainNode {
  const g = ctx.createGain();
  g.gain.value = value;
  if (dest instanceof AudioParam) g.connect(dest);
  else if (dest) g.connect(dest);
  return g;
}

export function filt(ctx: BaseAudioContext, type: BiquadFilterType, freq: number, q = 0.707, dest?: AudioNode): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  if (dest) f.connect(dest);
  return f;
}

export function pan(ctx: BaseAudioContext, value: number, dest: AudioNode): StereoPannerNode {
  const p = ctx.createStereoPanner();
  p.pan.value = value;
  p.connect(dest);
  return p;
}

const curveCache = new Map<number, Float32Array<ArrayBuffer>>();
/** tanh saturation curve (drive ≈ 1 gentle … 6 hard), normalised to ±1. */
export function driveCurve(drive: number): Float32Array<ArrayBuffer> {
  let c = curveCache.get(drive);
  if (!c) {
    c = new Float32Array(1024);
    const n = Math.tanh(drive);
    for (let i = 0; i < c.length; i++) c[i] = Math.tanh(((i / (c.length - 1)) * 2 - 1) * drive) / n;
    curveCache.set(drive, c);
  }
  return c;
}

export function shaper(ctx: BaseAudioContext, drive: number, dest: AudioNode): WaveShaperNode {
  const w = ctx.createWaveShaper();
  w.curve = driveCurve(drive);
  w.oversample = '2x';
  w.connect(dest);
  return w;
}

// ---------------------------------------------------------------------------------------------
// Envelopes

/** 0 → peak in `a`, optional hold at peak, exponential decay to −60 dB over `d`. Returns the end time. */
export function env(p: AudioParam, t: number, peak: number, a: number, d: number, hold = 0): number {
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + a);
  if (hold > 0) p.setValueAtTime(peak, t + a + hold);
  const end = t + a + hold + d;
  p.exponentialRampToValueAtTime(Math.max(peak * 1e-3, 1e-6), end);
  p.linearRampToValueAtTime(0, end + 0.005);
  return end + 0.005;
}

// ---------------------------------------------------------------------------------------------
// Voices

export interface ToneOpts {
  type?: OscillatorType;
  f: number; // start frequency (Hz)
  f1?: number; // glide target (exponential)
  glide?: number; // glide time (default = decay)
  peak: number;
  a?: number; // attack (default 2 ms)
  d: number; // decay to −60 dB
  hold?: number;
  detune?: number; // cents
  vib?: readonly [rateHz: number, cents: number];
  /** FM: modulator at f·ratio, peak deviation index·f, decaying over `decay` (constant if omitted). */
  fm?: readonly [ratio: number, index: number, decay?: number];
}

/** One enveloped oscillator (+ optional vibrato / FM) into dest. Returns the end time. */
export function tone(ctx: BaseAudioContext, dest: AudioNode, t: number, o: ToneOpts): number {
  const osc = ctx.createOscillator();
  osc.type = o.type ?? 'sine';
  osc.frequency.setValueAtTime(o.f, t);
  if (o.f1 !== undefined) osc.frequency.exponentialRampToValueAtTime(o.f1, t + (o.glide ?? o.d));
  if (o.detune) osc.detune.value = o.detune;
  const g = gain(ctx, 0, dest);
  osc.connect(g);
  const end = env(g.gain, t, o.peak, o.a ?? 0.002, o.d, o.hold);
  osc.start(t);
  osc.stop(end);
  if (o.vib) {
    const lfo = ctx.createOscillator();
    lfo.frequency.value = o.vib[0];
    lfo.connect(gain(ctx, o.vib[1], osc.detune));
    lfo.start(t);
    lfo.stop(end);
  }
  if (o.fm) {
    const [ratio, index, decay] = o.fm;
    const mod = ctx.createOscillator();
    mod.frequency.value = o.f * ratio;
    const mg = gain(ctx, index * o.f, osc.frequency);
    if (decay !== undefined) {
      mg.gain.setValueAtTime(index * o.f, t);
      mg.gain.exponentialRampToValueAtTime(Math.max(index * o.f * 0.01, 0.01), t + decay);
    }
    mod.connect(mg);
    mod.start(t);
    mod.stop(end);
  }
  return end;
}

export interface NoiseOpts {
  kind?: NoiseKind;
  type?: BiquadFilterType; // default bandpass
  f: number;
  f1?: number;
  glide?: number;
  q?: number;
  peak: number;
  a?: number;
  d: number;
  hold?: number;
}

/** Filtered noise burst into dest. Returns the end time. */
export function noise(ctx: BaseAudioContext, dest: AudioNode, t: number, o: NoiseOpts): number {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffers(ctx)[o.kind ?? 'white'];
  src.loop = true;
  const g = gain(ctx, 0, dest);
  const f = filt(ctx, o.type ?? 'bandpass', o.f, o.q ?? 1, g);
  if (o.f1 !== undefined) {
    f.frequency.setValueAtTime(o.f, t);
    f.frequency.exponentialRampToValueAtTime(o.f1, t + (o.glide ?? o.d));
  }
  src.connect(f);
  const end = env(g.gain, t, o.peak, o.a ?? 0.001, o.d, o.hold);
  src.start(t, rnd(0, 2.5));
  src.stop(end);
  return end;
}

// ---------------------------------------------------------------------------------------------
// Karplus–Strong plucked strings (qanun). Buffers are rendered once per (context, note) and
// cached; each "course" sums three slightly detuned strings, like the qanun's triple strings.

const pluckCache = new WeakMap<BaseAudioContext, Map<number, AudioBuffer>>();

export function pluckBuffer(ctx: BaseAudioContext, midi: number): AudioBuffer {
  let byNote = pluckCache.get(ctx);
  if (!byNote) pluckCache.set(ctx, (byNote = new Map()));
  const cached = byNote.get(midi);
  if (cached) return cached;

  const sr = ctx.sampleRate;
  const len = Math.floor(sr * 1.6);
  const buf = ctx.createBuffer(1, len, sr);
  const out = buf.getChannelData(0);
  const f0 = mtof(midi);
  const t60 = 1.5 - Math.min(0.9, Math.max(0, (midi - 60) * 0.035)); // higher notes die faster
  for (const cents of [-4, 0.5, 3.5]) {
    const f = f0 * 2 ** (cents / 1200);
    const period = sr / f;
    // loop delay = N (ring) + 0.5 (two-point average) + d (all-pass fractional delay)
    const n = Math.max(2, Math.floor(period - 0.6));
    const d = period - 0.5 - n;
    const c = (1 - d) / (1 + d);
    const rho = 10 ** (-3 / (t60 * f)); // per-period loss for the target T60
    // excitation: the string's displaced shape when plucked near the bridge (triangle peaking at
    // 13 % of its length) plus a little filtered noise for the plectrum's grit; zero mean, unit peak
    const ring = new Float32Array(n);
    const apex = Math.max(1, Math.round(n * 0.13));
    let lp = 0, mean = 0, peak = 0;
    for (let i = 0; i < n; i++) {
      lp += 0.35 * (Math.random() * 2 - 1 - lp);
      ring[i] = (i < apex ? i / apex : (n - i) / (n - apex)) + 0.3 * lp;
      mean += ring[i];
    }
    mean /= n;
    for (let i = 0; i < n; i++) { ring[i] -= mean; peak = Math.max(peak, Math.abs(ring[i])); }
    for (let i = 0; i < n; i++) ring[i] /= peak;
    let p = 0, last = 0, apx = 0, apy = 0;
    for (let i = 0; i < len; i++) {
      const y = ring[p];
      out[i] += y * 0.33;
      const avg = 0.5 * (y + last) * rho;
      last = y;
      const ap = c * avg + apx - c * apy;
      apx = avg;
      apy = ap;
      ring[p] = ap;
      p = p + 1 === n ? 0 : p + 1;
    }
  }
  const fade = Math.floor(sr * 0.08);
  for (let i = 0; i < fade; i++) out[len - fade + i] *= 1 - i / fade;
  byNote.set(midi, buf);
  return buf;
}
