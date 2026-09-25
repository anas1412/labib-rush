// Pure run rules: timer, score, combo, bag, power-ups, radar. No DOM, no three.js.
// Gameplay owns one `Run` per round, calls `tick` once per simulation step and the action
// functions when things happen, then forwards the returned data to events / HUD / audio.
// Every number comes from src/core/config.ts so tuning happens in one place.
import { CHECHIA_SCORE, MASHMOUM_TIME, POWERUPS, RULES, TEA_SPEED } from '../core/config';
import type { HudState, LitterKind, PowerUpKind, RunResult } from '../core/types';

const TIMED_POWERUPS = ['tea', 'bambalouni', 'chechia'] as const satisfies readonly PowerUpKind[];
type TimedPowerUp = (typeof TIMED_POWERUPS)[number];

/** Callout for a completely full bag being binned (the other Derja callouts come from RULES). */
export const FULL_BAG_CALLOUT = 'Yaatik saha!';

export interface Run {
  timeLeft: number;
  elapsed: number;
  score: number;
  /** Pickups in the current combo chain (0 = no chain). */
  chain: number;
  /** Seconds left before the chain breaks. */
  comboTimer: number;
  /** Current combo multiplier (RULES.multipliers). */
  multiplier: number;
  bag: LitterKind[];
  /** Seconds left per timed power-up (0 = inactive). */
  power: Record<TimedPowerUp, number>;
  radarCooldown: number;
  radarTime: number;
  difficulty: number;
  over: boolean;
  stats: {
    items: number; pickups: number; deposits: number; trickShots: number;
    caught: number; bestCombo: number; longestChain: number; hits: number;
  };
  /** Reused every frame by hudState() so the HUD path allocates nothing. */
  readonly hud: HudState;
  /** Reused by tick(): its result is only valid until the next tick. */
  readonly events: RuleEvent[];
  readonly hudChips: Record<TimedPowerUp, { kind: PowerUpKind; remaining: number; duration: number }>;
}

export type RuleEvent =
  | { type: 'timeWarning'; secondsLeft: number } // once per displayed second, last RULES.warningSeconds
  | { type: 'comboBreak'; chain: number } // only when a multiplier > 1 is lost
  | { type: 'powerupEnd'; kind: PowerUpKind }
  | { type: 'difficulty'; level: number } // every RULES.difficultyInterval seconds
  | { type: 'runOver' };

export interface PickupResult {
  accepted: boolean; // false = bag full (or run over): the item stays on the ground
  points: number;
  multiplier: number; // combo multiplier after this pickup
  chain: number;
  callout?: string; // set when the combo multiplier just went up
}

export interface DepositResult { items: number; points: number; timeAdded: number; callout?: string }
export interface ScoreTimeResult { points: number; timeAdded: number }
export interface PowerupResult { duration: number; timeAdded: number }
export interface HitResult { spilled: LitterKind[]; chainLost: number }

export function createRun(): Run {
  return {
    timeLeft: RULES.startTime,
    elapsed: 0,
    score: 0,
    chain: 0,
    comboTimer: 0,
    multiplier: 1,
    bag: [],
    power: { tea: 0, bambalouni: 0, chechia: 0 },
    radarCooldown: 0,
    radarTime: 0,
    difficulty: 0,
    over: false,
    stats: { items: 0, pickups: 0, deposits: 0, trickShots: 0, caught: 0, bestCombo: 1, longestChain: 0, hits: 0 },
    events: [],
    hud: { timeLeft: RULES.startTime, score: 0, multiplier: 1, comboProgress01: 0, bag: 0, bagMax: RULES.bagMax, powerups: [], radarCooldown01: 0 },
    hudChips: {
      tea: { kind: 'tea', remaining: 0, duration: POWERUPS.tea.duration },
      bambalouni: { kind: 'bambalouni', remaining: 0, duration: POWERUPS.bambalouni.duration },
      chechia: { kind: 'chechia', remaining: 0, duration: POWERUPS.chechia.duration },
    },
  };
}

/** Combo multiplier for a chain length (thresholds are index-aligned with multipliers). */
export function multiplierFor(chain: number): number {
  let m: number = RULES.multipliers[0];
  RULES.comboThresholds.forEach((t, i) => { if (chain >= t) m = RULES.multipliers[i]; });
  return m;
}

function chechiaFactor(run: Run): number {
  return run.power.chechia > 0 ? CHECHIA_SCORE : 1;
}

/** Adds time, respecting RULES.maxTime. Returns the seconds actually added. */
function addTime(run: Run, seconds: number): number {
  const before = run.timeLeft;
  run.timeLeft = Math.min(RULES.maxTime, run.timeLeft + seconds);
  return run.timeLeft - before;
}

function resetCombo(run: Run): number {
  const lost = run.multiplier > 1 ? run.chain : 0;
  run.chain = 0;
  run.comboTimer = 0;
  run.multiplier = 1;
  return lost;
}

/** Advances the run by dt seconds (skip while paused). Returns what happened, in order.
 *  The array is reused (no allocation in the fixed-step loop): read it before the next tick. */
export function tick(run: Run, dt: number): RuleEvent[] {
  const events = run.events;
  events.length = 0;
  if (run.over || dt <= 0) return events;
  const prev = run.timeLeft;
  run.timeLeft = Math.max(0, run.timeLeft - dt);
  run.elapsed += dt;

  // The timer displays ceil(timeLeft); warn whenever that value drops to n in 1..warningSeconds.
  for (let n = Math.min(Math.ceil(prev) - 1, RULES.warningSeconds); n >= Math.max(1, Math.ceil(run.timeLeft)); n--) {
    events.push({ type: 'timeWarning', secondsLeft: n });
  }

  if (run.chain > 0) {
    run.comboTimer -= dt;
    if (run.comboTimer <= 0) {
      const lost = resetCombo(run);
      if (lost) events.push({ type: 'comboBreak', chain: lost });
    }
  }

  for (const kind of TIMED_POWERUPS) {
    if (run.power[kind] <= 0) continue;
    run.power[kind] = Math.max(0, run.power[kind] - dt);
    if (run.power[kind] === 0) events.push({ type: 'powerupEnd', kind });
  }

  run.radarCooldown = Math.max(0, run.radarCooldown - dt);
  run.radarTime = Math.max(0, run.radarTime - dt);

  const level = Math.floor(run.elapsed / RULES.difficultyInterval);
  if (level > run.difficulty) {
    run.difficulty = level;
    events.push({ type: 'difficulty', level });
  }

  if (run.timeLeft === 0) {
    run.over = true;
    events.push({ type: 'runOver' });
  }
  return events;
}

/**
 * Litter goes into the bag and scores now (value × combo × chéchia).
 * `respilled`: the item was knocked out of the bag by a taxi (see hit()) and already scored when it
 * was first picked up, so it pays 0 this time; it still refills the bag and extends the combo.
 */
export function pickup(run: Run, kind: LitterKind, respilled = false): PickupResult {
  if (run.over || run.bag.length >= RULES.bagMax) {
    return { accepted: false, points: 0, multiplier: run.multiplier, chain: run.chain };
  }
  const before = run.multiplier;
  run.chain = run.comboTimer > 0 ? run.chain + 1 : 1;
  run.comboTimer = RULES.comboWindow;
  run.multiplier = multiplierFor(run.chain);
  const points = respilled ? 0 : RULES.points[kind] * scoreMultiplier(run);
  run.score += points;
  run.bag.push(kind);
  if (!respilled) run.stats.pickups++;
  run.stats.bestCombo = Math.max(run.stats.bestCombo, run.multiplier);
  run.stats.longestChain = Math.max(run.stats.longestChain, run.chain);
  const callout = run.multiplier > before ? RULES.callouts[run.multiplier] : undefined;
  return { accepted: true, points, multiplier: run.multiplier, chain: run.chain, ...(callout ? { callout } : {}) };
}

/** Empties the bag into a bin: items² × bonus (× chéchia) and time per item. */
export function deposit(run: Run): DepositResult {
  const items = run.bag.length;
  if (run.over || items === 0) return { items: 0, points: 0, timeAdded: 0 };
  const points = items * items * RULES.depositBonusPerItemSquared * chechiaFactor(run);
  run.score += points;
  run.bag.length = 0;
  run.stats.items += items;
  run.stats.deposits++;
  const timeAdded = addTime(run, items * RULES.timePerDepositedItem);
  return { items, points, timeAdded, ...(items >= RULES.bagMax ? { callout: FULL_BAG_CALLOUT } : {}) };
}

/** A kicked item landed in a bin ("GOOOAL!"): double its value, and it counts as a binned item. */
export function trickShot(run: Run, kind: LitterKind): ScoreTimeResult {
  if (run.over) return { points: 0, timeAdded: 0 };
  const points = RULES.points[kind] * RULES.trickShotMultiplier * chechiaFactor(run);
  run.score += points;
  run.stats.items++;
  run.stats.trickShots++;
  return { points, timeAdded: addTime(run, RULES.timePerDepositedItem) };
}

/** A litterbug touched within RULES.caughtWindow of the throw. */
export function caught(run: Run): number {
  if (run.over) return 0;
  const points = RULES.caughtPoints * chechiaFactor(run);
  run.score += points;
  run.stats.caught++;
  return points;
}

/** Taxi hit: combo reset and half the bag (rounded up, newest first) spills out. Those items were
 *  already scored: gameplay scatters them and must re-pick them with pickup(run, kind, true). */
export function hit(run: Run): HitResult {
  if (run.over) return { spilled: [], chainLost: 0 };
  run.stats.hits++;
  const chainLost = resetCombo(run);
  const n = Math.ceil(run.bag.length * RULES.hitSpillFraction);
  return { spilled: run.bag.splice(run.bag.length - n, n), chainLost };
}

/** Starts (or refreshes) a power-up. Mashmoum is instant time. */
export function applyPowerup(run: Run, kind: PowerUpKind): PowerupResult {
  if (run.over) return { duration: 0, timeAdded: 0 };
  if (kind === 'mashmoum') return { duration: 0, timeAdded: addTime(run, MASHMOUM_TIME) };
  run.power[kind] = POWERUPS[kind].duration;
  return { duration: POWERUPS[kind].duration, timeAdded: 0 };
}

export const speedMultiplier = (run: Run): number => (run.power.tea > 0 ? TEA_SPEED : 1);
/** Combo multiplier × chéchia. Applied to pickups; deposits/trick shots/catches use chéchia only. */
export const scoreMultiplier = (run: Run): number => run.multiplier * chechiaFactor(run);
export const magnetActive = (run: Run): boolean => run.power.bambalouni > 0;
export const radarReady = (run: Run): boolean => !run.over && run.radarCooldown <= 0;
export const radarActive = (run: Run): boolean => run.radarTime > 0;

/** Fires the ear radar if it is off cooldown. The cooldown runs from the moment of use. */
export function useRadar(run: Run): boolean {
  if (!radarReady(run)) return false;
  run.radarCooldown = RULES.radar.cooldown;
  run.radarTime = RULES.radar.duration;
  return true;
}

/** Snapshot for UIController.updateHud. Returns the same object every call (no allocation). */
export function hudState(run: Run): HudState {
  const h = run.hud;
  h.timeLeft = run.timeLeft;
  h.score = run.score;
  h.multiplier = run.multiplier;
  h.comboProgress01 = run.chain > 0 ? Math.max(0, run.comboTimer / RULES.comboWindow) : 0;
  h.bag = run.bag.length;
  h.radarCooldown01 = run.radarCooldown / RULES.radar.cooldown;
  h.powerups.length = 0;
  for (const kind of TIMED_POWERUPS) {
    if (run.power[kind] <= 0) continue;
    const chip = run.hudChips[kind];
    chip.remaining = run.power[kind];
    h.powerups.push(chip);
  }
  return h;
}

export function result(run: Run): RunResult {
  return { score: run.score, durationSec: Math.round(run.elapsed), ...run.stats };
}
