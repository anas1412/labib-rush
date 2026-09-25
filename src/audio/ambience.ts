// City bed for the Avenue: a continuous low traffic rumble and café murmur, plus scheduled one-shots
// (cars passing with a Doppler sweep, the odd moped, distant horns, starlings, cup-and-saucer
// clinks). Kept gentle: it sits well under the music and SFX.
import { filt, gain, noise, pan, rnd, tone } from './dsp';
import { noiseBed, starling } from './instruments';

type Ctx = BaseAudioContext;
type EventKind = 'car' | 'moped' | 'horn' | 'birds' | 'clink';

/** Mean gap (s) between events of each kind; actual gaps are randomised ±60 %. */
const GAP: Record<EventKind, number> = { car: 5, moped: 17, horn: 22, birds: 11, clink: 7 };
const KINDS = Object.keys(GAP) as EventKind[];

export class Ambience {
  private readonly out: GainNode;
  /** Per-run fader: a restart during a stop fade gets a fresh one, so nothing snaps or clicks. */
  private bus: GainNode;
  private beds: AudioScheduledSourceNode[] = [];
  private nextAt: Record<EventKind, number> = { car: 0, moped: 0, horn: 0, birds: 0, clink: 0 };
  private running = false;
  private paused = false;

  constructor(private readonly ctx: Ctx, dest: AudioNode, private readonly verb: AudioNode) {
    this.out = gain(ctx, 1, dest);
    this.bus = gain(ctx, 0, this.out);
  }

  start(at = this.ctx.currentTime + 0.05): void {
    if (this.running) return;
    this.running = true;
    const c = this.ctx;
    const bus = (this.bus = gain(c, 0, this.out));
    // traffic rumble, slowly breathing
    const rumble = noiseBed(c, filt(c, 'highpass', 35, 0.7, bus), 'brown', 'lowpass', 240, 0.6, 0.12);
    const hum = noiseBed(c, bus, 'pink', 'bandpass', 420, 0.7, 0.015);
    // café murmur: speech-band noise with syllable-rate (≈3–6 Hz) flutter, left and right terraces
    const murmurs = [-0.6, 0.55].map((p, i) => {
      const bed = noiseBed(c, pan(c, p, bus), 'pink', 'bandpass', i ? 780 : 560, 1.1, 0.035);
      const lfo = [3.3 + i, 5.1 - i * 0.7].map((f) => {
        const o = c.createOscillator();
        o.frequency.value = f;
        o.connect(gain(c, 0.014, bed.g.gain));
        return o;
      });
      return [bed.src, ...lfo];
    }).flat();
    const breathe = c.createOscillator();
    breathe.frequency.value = 0.07;
    breathe.connect(gain(c, 0.04, rumble.g.gain));
    this.beds = [rumble.src, hum.src, breathe, ...murmurs];
    for (const s of this.beds) s.start(at);
    bus.gain.setValueAtTime(0, at);
    bus.gain.linearRampToValueAtTime(1, at + 2);
    for (const k of KINDS) this.nextAt[k] = at + rnd(0.5, 1) * GAP[k];
  }

  stop(fadeSec = 1.5): void {
    if (!this.running) return;
    this.running = false;
    const now = this.ctx.currentTime;
    const g = this.bus.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + fadeSec);
    for (const s of this.beds) s.stop(now + fadeSec + 0.05);
    this.beds = [];
  }

  setPaused(p: boolean): void {
    this.paused = p;
    if (!p) { const now = this.ctx.currentTime; for (const k of KINDS) this.nextAt[k] = Math.max(this.nextAt[k], now + 0.5); }
  }

  schedule(until: number): void {
    if (!this.running || this.paused) return;
    for (const k of KINDS) {
      while (this.nextAt[k] < until) {
        this.fire(k, this.nextAt[k]);
        this.nextAt[k] += GAP[k] * rnd(0.4, 1.6);
      }
    }
  }

  private fire(k: EventKind, t: number): void {
    const c = this.ctx, o = this.bus;
    switch (k) {
      case 'car': passBy(c, o, t, false); break;
      case 'moped': passBy(c, o, t, true); break;
      case 'horn': {
        // a distant, muffled horn somewhere down the avenue
        const lp = filt(c, 'lowpass', 1200, 0.7, pan(c, rnd(-0.8, 0.8), o));
        lp.connect(gain(c, 0.6, this.verb));
        const f = rnd(380, 480), len = rnd(0.15, 0.4);
        for (const r of [1, 1.26]) tone(c, lp, t, { type: 'square', f: f * r, peak: 0.02, a: 0.015, hold: len, d: 0.06 });
        break;
      }
      case 'birds': starling(c, o, t, rnd(1, 2.5), 0.35, 6 + ((Math.random() * 8) | 0)); break;
      case 'clink': {
        const p = pan(c, rnd(-0.7, 0.7), o);
        const f = rnd(2600, 3800);
        for (const [dt, pk] of [[0, 0.035], [rnd(0.09, 0.2), 0.018]] as const) {
          tone(c, p, t + dt, { f, peak: pk, d: 0.25 });
          tone(c, p, t + dt, { f: f * 2.71, peak: pk * 0.5, d: 0.12 });
        }
        break;
      }
    }
  }
}

/** A vehicle crossing the stereo field: tyre/wind noise sweep + engine tone with Doppler drop. */
function passBy(c: Ctx, o: AudioNode, t: number, moped: boolean): void {
  const dur = moped ? rnd(2.5, 3.5) : rnd(3, 5);
  const dir = Math.random() < 0.5 ? -1 : 1;
  const mid = t + dur * 0.5;
  const pn = c.createStereoPanner();
  pn.connect(o);
  pn.pan.setValueAtTime(-0.85 * dir, t);
  pn.pan.linearRampToValueAtTime(0.85 * dir, t + dur);
  const g = gain(c, 0, pn);
  const peak = moped ? rnd(0.04, 0.07) : rnd(0.06, 0.12);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak * 0.25, t + dur * 0.3);
  g.gain.linearRampToValueAtTime(peak, mid);
  g.gain.linearRampToValueAtTime(peak * 0.2, t + dur * 0.75);
  g.gain.linearRampToValueAtTime(0, t + dur);
  // tyres + wind
  noise(c, g, t, { kind: 'pink', type: 'bandpass', f: 320, q: 0.8, peak: 1, a: 0.01, hold: dur - 0.2, d: 0.15 });
  const whoosh = filt(c, 'bandpass', 400, 1.2, g);
  whoosh.frequency.setValueAtTime(350, t);
  whoosh.frequency.linearRampToValueAtTime(900, mid);
  whoosh.frequency.linearRampToValueAtTime(380, t + dur);
  noise(c, whoosh, t, { type: 'lowpass', f: 3000, peak: 0.6, a: 0.01, hold: dur - 0.2, d: 0.15 });
  // engine with a ~4 % Doppler drop as it passes
  const f = moped ? rnd(130, 180) : rnd(62, 95);
  const eng = c.createOscillator();
  eng.type = 'sawtooth';
  eng.frequency.setValueAtTime(f * 1.04, t);
  eng.frequency.setValueAtTime(f * 1.04, mid - 0.25);
  eng.frequency.linearRampToValueAtTime(f * 0.96, mid + 0.25);
  const lp = filt(c, 'lowpass', moped ? 1400 : 320, moped ? 2 : 0.8, gain(c, moped ? 0.35 : 0.5, g));
  eng.connect(lp);
  eng.start(t);
  eng.stop(t + dur + 0.05);
}
