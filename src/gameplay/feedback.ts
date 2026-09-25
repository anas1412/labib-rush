// Feedback router: turns gameplay events into juice — sound, particles, floating text, callouts,
// camera shake, a tiny hit-stop and the music intensity. Tasteful by design: every source is
// throttled or scaled so a busy moment stays readable.
import { Vector3 } from 'three';
import { RULES } from '../core/config';
import type { GameContext, SfxName } from '../core/types';
import { FULL_BAG_CALLOUT } from './rules';

export interface Feedback {
  update(dt: number): void;
  dispose(): void;
  /** Gameplay time scale (a short hit-stop on trick shots). main multiplies the sim dt by it. */
  readonly timeScale: number;
}

const POWER_COLOR = { tea: 0x7dffc8, bambalouni: 0xffb84d, mashmoum: 0xfff6e0, chechia: 0xff3b3b } as const;
const MULT_INTENSITY: Record<number, number> = { 1: 0, 2: 0.14, 3: 0.26, 5: 0.4 };
const DELAY_SLOTS = 8;

export function createFeedback(ctx: GameContext): Feedback {
  const { events: ev, audio, fx, ui, cameraRig: rig, player } = ctx;
  const offs: (() => void)[] = [];
  const on: typeof ev.on = (type, fn) => { const off = ev.on(type, fn); offs.push(off); return off; };

  let running = false;
  let runTime = 0;
  let multiplier = 1;
  let lastSeconds = 99;
  let tea = false;
  let speedAcc = 0;
  let hitStop = 0;
  let intensity = 0;
  const dir = new Vector3();
  const up = (p: Vector3, dy: number) => new Vector3(p.x, p.y + dy, p.z); // UI keeps the vector

  // small fixed ring of delayed sounds/texts (deposit "gulp")
  const delayed: { t: number; sfx: SfxName | null; text: string | null }[] = [];
  for (let i = 0; i < DELAY_SLOTS; i++) delayed.push({ t: -1, sfx: null, text: null });
  const later = (t: number, sfx: SfxName | null, text: string | null) => {
    const s = delayed.find((d) => d.t < 0) ?? delayed[0];
    s.t = t; s.sfx = sfx; s.text = text;
  };

  on('runStart', () => { running = true; runTime = 0; multiplier = 1; lastSeconds = 99; tea = false; });
  on('runEnd', () => { running = false; tea = false; multiplier = 1; audio.play('gameOver'); });

  on('pickup', (e) => {
    const rare = e.kind === 'golden' || e.kind === 'bag';
    audio.play(rare ? 'pickupRare' : 'pickup', { pitch: 1 + 0.055 * Math.min(e.chain - 1, 12) });
    fx.burst(e.kind === 'golden' ? 'goldSparkle' : 'sparkle', e.position, { scale: 1 + 0.04 * Math.min(e.chain - 1, 10) });
    if (e.points > 0) ui.floatText(`+${e.points}`, up(e.position, 0.6), e.kind === 'golden' ? 'gold' : 'points');
    multiplier = e.multiplier;
    if (e.kind === 'golden') { ui.callout('Dhahab!', 'good'); rig.shake(0.18); }
  });
  on('comboUp', (e) => {
    multiplier = e.multiplier;
    ui.callout(e.callout, 'combo');
    audio.play('comboUp', { pitch: 1 + 0.08 * RULES.multipliers.indexOf(e.multiplier as 1) });
    if (e.multiplier >= 5) player.avatar.trigger('victory');
  });
  on('comboBreak', () => { multiplier = 1; audio.play('comboBreak'); });
  on('bagFull', (e) => { audio.play('bagFull'); ui.floatText('Bag full!', up(e.position, 1.9), 'bad'); });

  on('deposit', (e) => {
    audio.play('deposit', { position: e.position });
    fx.burst('deposit', e.position, { scale: 0.9 + 0.035 * e.items });
    ui.floatText(`+${e.points}`, up(e.position, 1.7), 'points');
    if (e.items >= RULES.bagMax) { ui.callout(FULL_BAG_CALLOUT, 'combo'); fx.burst('confetti', e.position, { scale: 0.8 }); }
    rig.shake(0.1 + 0.015 * e.items, 0.25);
  });
  on('timeAdded', (e) => { lastSeconds = 99; later(0.45, 'timeAdded', `+${e.seconds.toFixed(1).replace(/\.0$/, '')} s`); });

  on('trickShot', (e) => {
    audio.play('trickShot', { position: e.position });
    audio.play('cheer');
    ui.callout('GOOOAL!', 'good');
    ui.floatText(`+${e.points}`, up(e.position, 1.8), 'gold');
    fx.burst('confetti', e.position);
    fx.burst('sparkle', up(e.position, 1.05), { scale: 1.4 });
    rig.shake(0.3, 0.35);
    hitStop = 0.085;
    player.avatar.trigger('victory');
  });

  on('caught', (e) => {
    audio.play('caught', { position: e.position });
    ui.callout('Caught!', 'good');
    ui.floatText(`+${e.points}`, up(e.position, 2), 'points');
    fx.burst('sparkle', e.position, { scale: 1.3 });
  });
  on('litterThrown', (e) => audio.play('litterThrown', { position: e.position }));

  on('powerup', (e) => {
    audio.play('powerup');
    fx.burst('powerup', e.position, { color: POWER_COLOR[e.kind] });
    if (e.kind === 'tea') tea = true;
    const label = { tea: 'Tay!', bambalouni: 'Bambalouni!', mashmoum: 'Mashmoum!', chechia: 'Chéchia ×2!' }[e.kind];
    ui.callout(label, 'good');
  });
  on('powerupEnd', (e) => { audio.play('powerupEnd'); if (e.kind === 'tea') tea = false; });

  on('hit', (e) => {
    audio.play('hit', { position: e.position });
    fx.burst('hit', e.position);
    dir.copy(player.velocity).setY(0);
    fx.burst('spill', e.position, { direction: dir.lengthSq() > 1e-4 ? dir.normalize() : undefined });
    if (e.spilled > 0) ui.floatText(`-${e.spilled}`, up(e.position, 1.9), 'bad');
    ui.callout('Aïe!', 'bad');
    rig.shake(0.7, 0.5);
    multiplier = 1;
  });
  on('honk', (e) => audio.play('honk', { position: e.position }));
  on('radar', () => audio.play('radar'));
  on('timeWarning', (e) => { lastSeconds = e.secondsLeft; audio.play('tick', { pitch: e.secondsLeft <= 3 ? 1.12 : 1 }); });

  on('jump', () => audio.play('jump'));
  on('land', (e) => {
    audio.play('land', { volume: Math.min(1, 0.35 + e.impact / 12) });
    if (e.impact > 2) fx.burst('dust', e.position, { count: 8, scale: Math.min(1.6, 0.6 + e.impact / 8) });
  });
  on('footstep', (e) => {
    audio.play('footstep', { volume: e.sprint ? 1 : 0.7 });
    if (e.sprint) {
      dir.copy(player.velocity).setY(0);
      if (dir.lengthSq() > 1e-4) fx.burst('dust', e.position, { count: 3, scale: 0.8, direction: dir.normalize() });
    }
  });
  on('kick', () => audio.play('kick'));

  return {
    get timeScale() { return hitStop > 0 ? 0.08 : 1; },

    update(dt) {
      hitStop = Math.max(0, hitStop - dt);
      if (running) runTime += dt;
      for (const d of delayed) {
        if (d.t < 0) continue;
        d.t -= dt;
        if (d.t > 0) continue;
        d.t = -1;
        if (d.sfx) audio.play(d.sfx);
        if (d.text) ui.floatText(d.text, up(player.position, 2.1), 'time');
      }
      // mint tea: speed lines behind Labib (~30 bursts/s while moving)
      if (tea && running) {
        speedAcc += dt * 30;
        dir.copy(player.velocity).setY(0);
        if (speedAcc >= 1 && dir.lengthSq() > 4) { speedAcc = 0; fx.burst('speedLines', player.position, { direction: dir.normalize() }); }
      }
      let target = 0.3;
      if (running) {
        target = 0.3 + 0.1 * Math.min(4, Math.floor(runTime / RULES.difficultyInterval)) + (MULT_INTENSITY[multiplier] ?? 0);
        if (lastSeconds <= RULES.warningSeconds) target = Math.max(target, 0.9);
      }
      intensity += (Math.min(1, target) - intensity) * Math.min(1, dt * 1.5);
      audio.setMusicIntensity(intensity);
    },

    dispose() {
      for (const off of offs) off();
      offs.length = 0;
    },
  };
}
