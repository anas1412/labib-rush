// Mix graph shared by the live engine and the offline verification renders:
//
//   music ─┐
//   sfx ───┼─ game (pause fade) ─┐
//   amb ───┘                     ├─ master (mute) ─ glue compressor ─ limiter ─ ceiling ─ out
//   ui ──────────────────────────┤   (master starts with a 22 Hz DC/subsonic high-pass)
//   reverb send ─ convolver ─────┘ (return joins `game`, so pause silences the tails too)
import { filt, gain, noiseBuffers } from './dsp';

export interface Mixer {
  ctx: BaseAudioContext;
  master: GainNode;
  game: GainNode;
  music: GainNode;
  sfx: GainNode;
  ambience: GainNode;
  ui: GainNode;
  /** Reverb send input (a small warm "street" room). */
  reverb: GainNode;
}

/** Ceiling for the final soft clipper: nothing leaves the graph above −0.6 dBFS. */
const CEILING = 0.93;

export function createMixer(ctx: BaseAudioContext): Mixer {
  // --- master chain
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -16;
  comp.knee.value = 12;
  comp.ratio.value = 3;
  comp.attack.value = 0.006;
  comp.release.value = 0.2;
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -4;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.08;
  // transparent below −3 dBFS, tanh knee up to the ceiling (input pre-scaled by ½ so the curve's
  // ±1 domain covers ±2 of signal)
  const clip = ctx.createWaveShaper();
  const n = 2048, curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = ((i / (n - 1)) * 2 - 1) * 2;
    const ax = Math.abs(x), k = 0.7;
    curve[i] = Math.sign(x) * (ax < k ? ax : k + (CEILING - k) * Math.tanh((ax - k) / (CEILING - k)));
  }
  clip.curve = curve;
  clip.oversample = '4x';
  const pre = gain(ctx, 0.5, clip);
  const master = gain(ctx, 1, filt(ctx, 'highpass', 22, 0.7, comp)); // DC / subsonic blocker
  comp.connect(limiter);
  limiter.connect(pre);
  clip.connect(ctx.destination);

  // --- buses
  const game = gain(ctx, 1, master);
  const music = gain(ctx, 1, game);
  const sfx = gain(ctx, 1, game);
  const ambience = gain(ctx, 1, game);
  const ui = gain(ctx, 1, master);

  // --- reverb: early reflections off the facades + a 1.7 s exponentially decaying, darkening tail
  const conv = ctx.createConvolver();
  conv.buffer = impulse(ctx, 1.7);
  const reverb = gain(ctx, 1, conv);
  conv.connect(gain(ctx, 0.5, game));
  noiseBuffers(ctx); // warm the noise cache before the first sound

  return { ctx, master, game, music, sfx, ambience, ui, reverb };
}

function impulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const sr = ctx.sampleRate, len = Math.floor(sr * seconds);
  const b = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const k = 0.55 + 0.4 * (1 - t / seconds); // one-pole lowpass closes over time (air absorption)
      lp += k * (Math.random() * 2 - 1 - lp);
      d[i] = lp * Math.exp(-t * (6.9 / seconds)) * Math.min(1, t / 0.012);
    }
    // a few discrete early reflections (street canyon, ~7–45 m paths), different per ear
    for (const ms of ch ? [9, 21, 34, 47] : [12, 17, 29, 41]) d[Math.floor((ms / 1000) * sr)] += 0.5 * Math.exp(-ms / 40);
  }
  return b;
}
