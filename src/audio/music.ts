// Procedural Tunisian-flavoured loop in D Hijaz at 118 BPM: darbouka (doum/tek/ka), bendir,
// handclaps, chkacheks, synth bass, a qanun hook and a mizwad-style reed lead.
//
// Form: a 32-bar cycle A · B · A' · C (8 bars each, ~65 s): the hook and its answer phrase (A2),
// the B melody, the hook again with qanun tremolo and a saidi groove, then a breakdown that builds
// back up. Odd cycles swap A' to answer-first and give the breakdown the B melody, so the hook
// itself plays 2–4 times a cycle and a 5-minute run never hears the same 65 s twice in a row.
// Every 8th bar ends in one of two darbouka fills, picked at random.
// Layers fade in with intensity (0..1): claps ≥ 0.25, chkacheks ≥ 0.5, mizwad ≥ 0.8.
// The menu arrangement drops to a soft malfuf groove, long bass notes and a drone pad.
//
// Steps are 16th notes, scheduled ahead of time by `schedule(until)` (live: a lookahead timer in
// audio.ts; offline: one call covering the whole render).
import { gain, pan, rnd } from './dsp';
import { bass, bendir, chkachek, clap, doum, mizwad, pad, qanun, tek } from './instruments';

export const BPM = 118;
export const STEP = 60 / BPM / 4;

type Layer = 'perc' | 'claps' | 'shaker' | 'bass' | 'hook' | 'lead' | 'pad';
const LAYERS: readonly Layer[] = ['perc', 'claps', 'shaker', 'bass', 'hook', 'lead', 'pad'];
const PAN: Record<Layer, number> = { perc: 0.08, claps: 0, shaker: -0.35, bass: 0, hook: -0.18, lead: 0.28, pad: 0 };
const SEND: Record<Layer, number> = { perc: 0.12, claps: 0.3, shaker: 0.15, bass: 0, hook: 0.3, lead: 0.28, pad: 0.4 };

// ---- notes (MIDI), D Hijaz: D Eb F# G A Bb C
const D5 = 74, Eb5 = 75, Fs5 = 78, G5 = 79, A5 = 81, Bb5 = 82, C6 = 84, D6 = 86, Eb6 = 87;
const D2 = 38, Eb2 = 39, G2 = 43, C2 = 36;

type Note = readonly [step: number, midi: number, len: number];
const HOOK_A: readonly (readonly Note[])[] = [
  [[0, A5, 2], [2, Bb5, 1], [3, A5, 1], [4, G5, 2], [6, Fs5, 2], [8, G5, 3], [11, A5, 1], [12, Bb5, 2], [14, A5, 2]],
  [[0, G5, 2], [2, Fs5, 2], [4, Eb5, 2], [6, D5, 5], [12, Fs5, 1], [13, G5, 1], [14, A5, 2]],
  [[0, A5, 2], [2, Bb5, 1], [3, A5, 1], [4, G5, 2], [6, Fs5, 2], [8, G5, 2], [10, A5, 2], [12, C6, 2], [14, Bb5, 2]],
  [[0, A5, 4], [4, G5, 2], [6, Fs5, 2], [8, Eb5, 2], [10, Fs5, 2], [12, D5, 4]],
];
/** Answer phrase: higher, ornamented turns, and a half cadence on A that leads back into the hook. */
const HOOK_A2: readonly (readonly Note[])[] = [
  [[0, D6, 2], [2, C6, 1], [3, Bb5, 1], [4, A5, 2], [6, Bb5, 1], [7, A5, 1], [8, G5, 2], [10, A5, 2], [12, Bb5, 4]],
  [[0, A5, 2], [2, G5, 1], [3, Fs5, 1], [4, G5, 4], [8, Fs5, 2], [10, Eb5, 2], [12, Fs5, 2], [14, G5, 2]],
  [[0, A5, 1], [1, Bb5, 1], [2, A5, 2], [4, C6, 2], [6, Bb5, 2], [8, A5, 1], [9, Bb5, 1], [10, A5, 1], [11, G5, 1], [12, Fs5, 2], [14, G5, 2]],
  [[0, Fs5, 2], [2, Eb5, 2], [4, D5, 6], [10, Eb5, 1], [11, Fs5, 1], [12, A5, 4]],
];
const HOOK_B: readonly (readonly Note[])[] = [
  [[0, D6, 3], [3, C6, 1], [4, Bb5, 2], [6, A5, 2], [8, Bb5, 2], [10, C6, 2], [12, D6, 4]],
  [[0, Eb6, 2], [2, D6, 2], [4, C6, 2], [6, Bb5, 2], [8, A5, 6], [14, G5, 1], [15, A5, 1]],
  [[0, Bb5, 2], [2, A5, 2], [4, G5, 2], [6, A5, 1], [7, G5, 1], [8, Fs5, 2], [10, G5, 2], [12, A5, 4]],
  [[0, Bb5, 2], [2, A5, 2], [4, G5, 2], [6, Fs5, 2], [8, Eb5, 2], [10, D5, 6]],
];
/** Bass roots per half bar for each 4-bar phrase. */
const ROOTS_A: readonly (readonly [number, number])[] = [[D2, D2], [C2, D2], [G2, G2], [Eb2, D2]];
const ROOTS_B: readonly (readonly [number, number])[] = [[G2, G2], [C2, C2], [D2, D2], [Eb2, D2]];

// ---- grooves: D doum · T tek · k ka · r ka roll (two 32nds) · B bendir boom · t bendir slap · x/X hit/accent
const DARB = {
  maqsum: 'D.T...T.D...T...',
  maqsumO: 'D.TkT.TkD.k.T.kk',
  saidi: 'D.T...D.D...T...',
  saidiO: 'D.Tk.kD.D.k.T.kr',
  malfuf: 'D..T..T.D..T..T.',
  fill: 'TkTkrrrr', // replaces the second half of a section's last bar (or fill2, at random)
  fill2: 'DkTkDkrr',
  build: 'TkTkTkTkrrrrrrrr',
} as const;
const BENDIR = { game: 'B.....t.B.....t.', calm: 'B.......B.......' } as const;
const CLAPS = { base: '....x.......x...', high: '....x..x....x..x' } as const;
const SHAKER = 'X.xxX.xxX.xxX.xx';
const BASS_GROOVE: readonly (readonly [step: number, deg: 'r' | 'f' | 'o', len: number])[] = [
  [0, 'r', 3], [3, 'r', 1], [6, 'r', 2], [8, 'r', 3], [11, 'f', 1], [12, 'r', 2], [14, 'o', 2],
];

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class Music {
  private readonly out: GainNode;
  private readonly layer: Record<Layer, GainNode>;
  private step = 0;
  private next = 0;
  private playing = false;
  private paused = false;
  private stopAt = Infinity;
  private intensity = 0;
  private menu = false;
  private menuNext = false;
  private fill: string = DARB.fill;
  /** Layer gains for the current intensity / arrangement (cached: read several times per step). */
  private tg: Record<Layer, number> = { perc: 0, claps: 0, shaker: 0, bass: 0, hook: 0, lead: 0, pad: 0 };

  constructor(private readonly ctx: BaseAudioContext, dest: AudioNode, verb: AudioNode) {
    this.out = gain(ctx, 0, dest);
    this.layer = {} as Record<Layer, GainNode>;
    for (const l of LAYERS) {
      const g = gain(ctx, 0, pan(ctx, PAN[l], this.out));
      g.connect(gain(ctx, SEND[l], verb));
      this.layer[l] = g;
    }
  }

  /** False while stopped or fading out, so a start() during a stop fade restarts the music. */
  get isPlaying(): boolean { return this.playing && this.stopAt === Infinity; }

  start(at = this.ctx.currentTime + 0.06): void {
    this.step = 0;
    this.next = at;
    this.playing = true;
    this.stopAt = Infinity;
    this.menu = this.menuNext;
    this.out.gain.cancelScheduledValues(at);
    this.out.gain.setValueAtTime(this.out.gain.value, at);
    this.out.gain.linearRampToValueAtTime(1, at + 0.25);
    this.applyLayers(at, 0.01);
  }

  stop(fadeSec = 1): void {
    if (!this.playing) return;
    const now = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(now);
    this.out.gain.setValueAtTime(this.out.gain.value, now);
    this.out.gain.linearRampToValueAtTime(0, now + Math.max(0.02, fadeSec));
    this.stopAt = now + Math.max(0.02, fadeSec);
  }

  setIntensity(v: number): void {
    const x = Math.min(1, Math.max(0, v));
    if (Math.abs(x - this.intensity) < 0.02) return;
    this.intensity = x;
    this.applyLayers(this.ctx.currentTime, 1.2);
  }

  /** Takes effect on the next bar line so the groove never breaks mid-bar. */
  setMenu(on: boolean): void {
    this.menuNext = on;
    if (!this.playing) this.menu = on;
  }

  setPaused(p: boolean): void {
    if (p === this.paused) return;
    this.paused = p;
    if (!p) this.next = Math.max(this.next, this.ctx.currentTime + 0.05);
  }

  /** Schedule every step that starts before `until` (context time). */
  schedule(until: number): void {
    if (!this.playing || this.paused) return;
    const now = this.ctx.currentTime;
    if (now >= this.stopAt) { this.playing = false; return; }
    if (this.next < now - 0.1) this.next = now + 0.05; // timer starved (tab throttled): resync, don't pile up
    while (this.next < until && this.next < this.stopAt) {
      this.playStep(this.step, this.next);
      this.step++;
      this.next += STEP;
    }
  }

  // --------------------------------------------------------------------------------------------
  private retarget(): void {
    const i = this.intensity, tg = this.tg, m = this.menu;
    tg.perc = m ? 0.6 : 0.9 + 0.1 * i;
    tg.claps = m ? 0 : smooth(0.2, 0.4, i);
    tg.shaker = m ? 0 : smooth(0.45, 0.65, i);
    tg.bass = m ? 0.7 : 1;
    tg.hook = m ? 0.75 : 1;
    tg.lead = m ? 0 : smooth(0.75, 0.9, i);
    tg.pad = m ? 0.9 : 0.7;
  }

  private applyLayers(t: number, tau: number): void {
    this.retarget();
    const tg = this.tg;
    for (const l of LAYERS) {
      const p = this.layer[l].gain;
      p.cancelScheduledValues(t);
      p.setTargetAtTime(tg[l], t, tau / 3);
    }
  }

  private on(l: Layer): boolean {
    return this.tg[l] > 0.01 || this.layer[l].gain.value > 0.01;
  }

  private playStep(s: number, t0: number): void {
    const c = this.ctx, L = this.layer;
    const st = s % 16, bar = Math.floor(s / 16);
    if (st === 0 && this.menuNext !== this.menu) { this.menu = this.menuNext; this.applyLayers(t0, 1.5); }
    const menu = this.menu, I = this.intensity;
    const cyc = bar % 32, sec = cyc >> 3, bis = cyc & 7, odd = ((bar >> 5) & 1) === 1;
    if (st === 0) this.fill = Math.random() < 0.5 ? DARB.fill : DARB.fill2;
    const t = t0 + rnd(-0.003, 0.003) + (st % 2 ? STEP * 0.06 : 0); // humanise + a touch of swing
    const vel = (base: number) => base * rnd(0.85, 1);

    // ---- darbouka
    if (this.on('perc')) {
      let groove: string;
      if (menu) groove = DARB.malfuf;
      else if (sec === 3) groove = bis >= 6 ? DARB.malfuf.slice(0, 8) + DARB.fill : DARB.malfuf;
      else if (sec === 1) groove = I > 0.35 ? DARB.saidiO : DARB.saidi;
      else if (sec === 2) groove = DARB.saidiO;
      else groove = I > 0.35 ? DARB.maqsumO : DARB.maqsum;
      if (!menu && sec === 3 && bis === 7) groove = DARB.build;
      else if (bis === 7 && (!menu || (bar & 15) === 15)) groove = groove.slice(0, 8) + this.fill;
      const ch = groove[st];
      const soft = menu ? 0.55 : 1;
      const cresc = groove === DARB.build ? 0.45 + 0.55 * (st / 15) : 1;
      if (ch === 'D') doum(c, L.perc, t, vel(soft));
      else if (ch === 'T') tek(c, L.perc, t, vel(0.9 * soft * cresc));
      else if (ch === 'k') tek(c, L.perc, t, vel(0.8 * soft * cresc), true);
      else if (ch === 'r') { tek(c, L.perc, t, vel(0.7 * cresc), true); tek(c, L.perc, t + STEP / 2, vel(0.6 * cresc), true); }
      else if (!menu && I > 0.7 && Math.random() < 0.18) tek(c, L.perc, t, vel(0.35), true); // ghost notes

      const b = (menu || sec === 3 ? BENDIR.calm : BENDIR.game)[st];
      if (b === 'B') bendir(c, L.perc, t, vel(menu ? 0.7 : 0.9));
      else if (b === 't' && I > 0.5) bendir(c, L.perc, t, vel(0.6), true);
    }

    // ---- claps and chkacheks
    if (!menu && this.on('claps') && (CLAPS[I > 0.75 ? 'high' : 'base'][st] === 'x')) clap(c, L.claps, t, vel(0.9));
    if (!menu && this.on('shaker') && sec !== 3) {
      const ch = SHAKER[st];
      if (ch !== '.') chkachek(c, L.shaker, t, vel(ch === 'X' ? 0.9 : 0.5));
    }

    // ---- bass
    const phrase = sec === 1 || (sec === 3 && odd) ? 'B' : 'A';
    const roots = (phrase === 'B' ? ROOTS_B : ROOTS_A)[bis & 3];
    if (this.on('bass')) {
      if (menu || sec === 3) {
        if (st === 0 || st === 8) bass(c, L.bass, t, roots[st >> 3], vel(0.75), STEP * 7);
      } else {
        for (const [bs, deg, len] of BASS_GROOVE) {
          if (bs !== st) continue;
          const r = roots[st >> 3];
          bass(c, L.bass, t, deg === 'r' ? r : deg === 'f' ? r + 7 : r + 12, vel(deg === 'r' ? 0.95 : 0.7), len * STEP);
        }
      }
    }

    // ---- qanun hook (+ mizwad doubling at high intensity)
    // A: hook then answer · A': the same (answer first in odd cycles) · B and odd breakdowns: B melody
    const bars = phrase === 'B' ? HOOK_B : (bis < 4) !== (sec === 2 && odd) ? HOOK_A : HOOK_A2;
    const hookBar = bars[bis & 3];
    for (const [ns, m, len] of hookBar) {
      if (ns !== st) continue;
      const sparse = menu || sec === 3;
      if (sparse && ns % 4 !== 0) continue; // menu / breakdown: only the strong notes
      if (this.on('hook')) {
        qanun(c, L.hook, t, m, vel(sparse ? 0.6 : 0.85), len * STEP + 0.15);
        if (sec === 2 && len >= 4) for (let k = 1; k < len * 2; k++) qanun(c, L.hook, t + k * STEP * 0.5, m, vel(0.4), STEP); // tremolo
      }
      if (!menu && sec !== 3 && this.on('lead')) mizwad(c, L.lead, t, m, vel(0.9), len * STEP);
    }

    // ---- drone pad (menu, breakdown, and softly under the B phrase)
    if (this.on('pad') && st === 0 && (bis & 3) === 0 && (menu || sec === 3 || sec === 1)) {
      const r = roots[0] + 12;
      pad(c, L.pad, t, [r, r + 7, r + 12], sec === 1 ? 0.5 : 1, STEP * 16 * 4);
    }
  }
}
