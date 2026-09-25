import { describe, expect, it } from 'vitest';
import { CHECHIA_SCORE, MASHMOUM_TIME, POWERUPS, RULES, TEA_SPEED } from '../src/core/config';
import {
  FULL_BAG_CALLOUT, applyPowerup, caught, createRun, deposit, hit, hudState, magnetActive, multiplierFor,
  pickup, radarActive, radarReady, result, scoreMultiplier, speedMultiplier, tick, trickShot, useRadar,
  type RuleEvent,
} from '../src/gameplay/rules';

const types = (evs: RuleEvent[]) => evs.map((e) => e.type);

describe('combo', () => {
  it('maps chain length to multipliers at the configured thresholds', () => {
    expect([1, 2, 3, 5, 6, 9, 10, 25].map(multiplierFor)).toEqual([1, 1, 2, 2, 3, 3, 5, 5]);
  });

  it('builds a chain with pickups inside the window and calls out each new multiplier', () => {
    const run = createRun();
    const callouts: (string | undefined)[] = [];
    for (let i = 0; i < 10; i++) {
      const r = pickup(run, 'can');
      callouts.push(r.callout);
      if (run.bag.length === RULES.bagMax) deposit(run);
      tick(run, RULES.comboWindow - 0.5);
    }
    expect(run.chain).toBe(10);
    expect(run.multiplier).toBe(5);
    expect(callouts.filter(Boolean)).toEqual([RULES.callouts[2], RULES.callouts[3], RULES.callouts[5]]);
  });

  it('scores pickups with the combo multiplier', () => {
    const run = createRun();
    expect(pickup(run, 'can').points).toBe(RULES.points.can);
    pickup(run, 'can');
    const third = pickup(run, 'bottle');
    expect(third.multiplier).toBe(2);
    expect(third.points).toBe(RULES.points.bottle * 2);
  });

  it('breaks after the window and reports the lost chain only if a multiplier was at stake', () => {
    const small = createRun();
    pickup(small, 'can');
    expect(types(tick(small, RULES.comboWindow + 0.01))).not.toContain('comboBreak');
    expect(small.chain).toBe(0);

    const big = createRun();
    for (let i = 0; i < 3; i++) pickup(big, 'can');
    const evs = tick(big, RULES.comboWindow + 0.01);
    expect(evs).toContainEqual({ type: 'comboBreak', chain: 3 });
    expect(big.multiplier).toBe(1);
    expect(pickup(big, 'can').chain).toBe(1);
  });

  it('tracks best combo and longest chain', () => {
    const run = createRun();
    for (let i = 0; i < 7; i++) { pickup(run, 'can'); if (run.bag.length === RULES.bagMax) deposit(run); }
    tick(run, RULES.comboWindow + 1);
    pickup(run, 'can');
    const r = result(run);
    expect(r.bestCombo).toBe(3);
    expect(r.longestChain).toBe(7);
  });
});

describe('bag and deposits', () => {
  it('refuses pickups when the bag is full', () => {
    const run = createRun();
    for (let i = 0; i < RULES.bagMax; i++) expect(pickup(run, 'chips').accepted).toBe(true);
    const r = pickup(run, 'golden');
    expect(r.accepted).toBe(false);
    expect(r.points).toBe(0);
    expect(run.bag).toHaveLength(RULES.bagMax);
  });

  it('pays items² × bonus and adds time per item', () => {
    const run = createRun();
    for (let i = 0; i < 4; i++) pickup(run, 'can');
    const before = run.score;
    const d = deposit(run);
    expect(d).toEqual({ items: 4, points: 16 * RULES.depositBonusPerItemSquared, timeAdded: 4 * RULES.timePerDepositedItem });
    expect(run.score - before).toBe(d.points);
    expect(run.bag).toHaveLength(0);
    expect(run.timeLeft).toBe(RULES.startTime + d.timeAdded);
    expect(deposit(run)).toEqual({ items: 0, points: 0, timeAdded: 0 });
  });

  it('calls out a full-bag deposit', () => {
    const run = createRun();
    for (let i = 0; i < RULES.bagMax; i++) pickup(run, 'can');
    expect(deposit(run).callout).toBe(FULL_BAG_CALLOUT);
  });

  it('caps the timer at maxTime and reports only the time really added', () => {
    const run = createRun();
    run.timeLeft = RULES.maxTime - 1;
    for (let i = 0; i < 4; i++) pickup(run, 'can');
    expect(deposit(run).timeAdded).toBeCloseTo(1);
    expect(run.timeLeft).toBe(RULES.maxTime);
    expect(applyPowerup(run, 'mashmoum').timeAdded).toBe(0);
  });
});

describe('trick shots, litterbugs, hits', () => {
  it('doubles a trick-shot item and counts it as binned', () => {
    const run = createRun();
    const r = trickShot(run, 'bottle');
    expect(r.points).toBe(RULES.points.bottle * RULES.trickShotMultiplier);
    expect(r.timeAdded).toBe(RULES.timePerDepositedItem);
    expect(result(run)).toMatchObject({ items: 1, trickShots: 1 });
  });

  it('gives points for a caught litterbug', () => {
    const run = createRun();
    expect(caught(run)).toBe(RULES.caughtPoints);
    expect(result(run).caught).toBe(1);
  });

  it('spills half the bag (rounded up, newest first) and resets the combo', () => {
    const run = createRun();
    (['can', 'bottle', 'chips', 'bag', 'golden'] as const).forEach((k) => pickup(run, k));
    const r = hit(run);
    expect(r.spilled).toEqual(['chips', 'bag', 'golden']);
    expect(r.chainLost).toBe(5);
    expect(run.bag).toEqual(['can', 'bottle']);
    expect(run.multiplier).toBe(1);
    expect(run.chain).toBe(0);
    expect(hit(createRun()).spilled).toEqual([]);
    expect(result(run).hits).toBe(1);
  });

  it('re-picking spilled items refills the bag but never pays their value twice', () => {
    const run = createRun();
    for (let i = 0; i < RULES.bagMax; i++) pickup(run, 'chips');
    const scoreBefore = run.score;
    const { spilled } = hit(run);
    expect(spilled).toHaveLength(RULES.bagMax / 2);
    for (const k of spilled) {
      const r = pickup(run, k, true);
      expect(r).toMatchObject({ accepted: true, points: 0 });
    }
    expect(run.score).toBe(scoreBefore);
    expect(run.bag).toHaveLength(RULES.bagMax);
    expect(run.chain).toBe(spilled.length); // re-picks still build a new combo
    expect(result(run).pickups).toBe(RULES.bagMax); // and are not counted twice
    expect(deposit(run).points).toBe(RULES.bagMax ** 2 * RULES.depositBonusPerItemSquared);
  });

  it('ignores scoring actions once the run is over', () => {
    const run = createRun();
    pickup(run, 'can');
    tick(run, RULES.startTime + 1);
    expect(run.over).toBe(true);
    const before = result(run);
    expect(hit(run).spilled).toEqual([]);
    expect(trickShot(run, 'golden').points).toBe(0);
    expect(caught(run)).toBe(0);
    expect(deposit(run).points).toBe(0);
    expect(applyPowerup(run, 'mashmoum').timeAdded).toBe(0);
    expect(useRadar(run)).toBe(false);
    expect(result(run)).toEqual(before);
  });
});

describe('power-ups', () => {
  it('runs timers and reports their end once', () => {
    const run = createRun();
    expect(applyPowerup(run, 'tea').duration).toBe(POWERUPS.tea.duration);
    applyPowerup(run, 'bambalouni');
    expect(speedMultiplier(run)).toBe(TEA_SPEED);
    expect(magnetActive(run)).toBe(true);
    expect(hudState(run).powerups.map((p) => p.kind)).toEqual(['tea', 'bambalouni']);
    const evs = tick(run, POWERUPS.tea.duration + 0.01);
    expect(evs.filter((e) => e.type === 'powerupEnd')).toEqual([
      { type: 'powerupEnd', kind: 'tea' }, { type: 'powerupEnd', kind: 'bambalouni' },
    ]);
    expect(types(tick(run, 1))).not.toContain('powerupEnd');
    expect(speedMultiplier(run)).toBe(1);
    expect(magnetActive(run)).toBe(false);
    expect(hudState(run).powerups).toHaveLength(0);
  });

  it('refreshes an active power-up instead of stacking it', () => {
    const run = createRun();
    applyPowerup(run, 'tea');
    tick(run, 5);
    applyPowerup(run, 'tea');
    expect(run.power.tea).toBe(POWERUPS.tea.duration);
  });

  it('mashmoum adds time instantly', () => {
    const run = createRun();
    expect(applyPowerup(run, 'mashmoum')).toEqual({ duration: 0, timeAdded: MASHMOUM_TIME });
    expect(run.timeLeft).toBe(RULES.startTime + MASHMOUM_TIME);
  });

  it('chéchia stacks with the combo multiplier and doubles other scoring', () => {
    const run = createRun();
    applyPowerup(run, 'chechia');
    for (let i = 0; i < 6; i++) pickup(run, 'can'); // ×3 combo
    expect(scoreMultiplier(run)).toBe(3 * CHECHIA_SCORE);
    expect(pickup(run, 'can').points).toBe(RULES.points.can * 3 * CHECHIA_SCORE);
    expect(caught(run)).toBe(RULES.caughtPoints * CHECHIA_SCORE);
    expect(trickShot(run, 'can').points).toBe(RULES.points.can * RULES.trickShotMultiplier * CHECHIA_SCORE);
    const items = run.bag.length;
    expect(deposit(run).points).toBe(items * items * RULES.depositBonusPerItemSquared * CHECHIA_SCORE);
  });
});

describe('timer', () => {
  it('warns once per second in the last seconds, then ends the run once', () => {
    const run = createRun();
    const warnings: number[] = [];
    let overs = 0;
    for (let t = 0; t < RULES.startTime + 2; t += 1 / 60) {
      for (const e of tick(run, 1 / 60)) {
        if (e.type === 'timeWarning') warnings.push(e.secondsLeft);
        if (e.type === 'runOver') overs++;
      }
    }
    expect(warnings).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(overs).toBe(1);
    expect(run.timeLeft).toBe(0);
    expect(pickup(run, 'can').accepted).toBe(false);
    expect(tick(run, 1)).toEqual([]);
  });

  it('re-arms warnings when time is added back', () => {
    const run = createRun();
    run.timeLeft = 5.5;
    expect(tick(run, 0.6)).toContainEqual({ type: 'timeWarning', secondsLeft: 5 });
    applyPowerup(run, 'mashmoum'); // 14.9 s
    tick(run, 4.8);
    expect(tick(run, 0.2)).toContainEqual({ type: 'timeWarning', secondsLeft: 10 });
  });

  it('reuses one events array (no allocation per step)', () => {
    const run = createRun();
    const a = tick(run, 0.1);
    expect(tick(run, 0.1)).toBe(a);
    run.timeLeft = 0.05;
    expect(tick(run, 0.1)).toEqual([{ type: 'runOver' }]);
    expect(tick(run, 0.1)).toBe(a);
    expect(a).toEqual([]);
  });

  it('steps difficulty every interval', () => {
    const run = createRun();
    const evs = tick(run, RULES.difficultyInterval + 0.1);
    expect(evs).toContainEqual({ type: 'difficulty', level: 1 });
    expect(run.difficulty).toBe(1);
  });
});

describe('radar and HUD', () => {
  it('has a duration and a cooldown from the moment of use', () => {
    const run = createRun();
    expect(useRadar(run)).toBe(true);
    expect(radarActive(run)).toBe(true);
    expect(useRadar(run)).toBe(false);
    tick(run, RULES.radar.duration + 0.01);
    expect(radarActive(run)).toBe(false);
    expect(radarReady(run)).toBe(false);
    expect(hudState(run).radarCooldown01).toBeGreaterThan(0);
    tick(run, RULES.radar.cooldown);
    expect(radarReady(run)).toBe(true);
    expect(hudState(run).radarCooldown01).toBe(0);
  });

  it('reuses the same HUD object and reflects the run', () => {
    const run = createRun();
    const a = hudState(run);
    pickup(run, 'can');
    const b = hudState(run);
    expect(b).toBe(a);
    expect(b).toMatchObject({ score: RULES.points.can, bag: 1, bagMax: RULES.bagMax, multiplier: 1, comboProgress01: 1 });
    tick(run, RULES.comboWindow / 2);
    expect(hudState(run).comboProgress01).toBeCloseTo(0.5);
  });
});

describe('result', () => {
  it('summarises a run', () => {
    const run = createRun();
    for (let i = 0; i < 3; i++) pickup(run, 'can');
    deposit(run);
    trickShot(run, 'can');
    caught(run);
    tick(run, 12.4);
    expect(result(run)).toEqual({
      score: run.score, items: 4, pickups: 3, deposits: 1, trickShots: 1, caught: 1,
      bestCombo: 2, longestChain: 3, durationSec: 12, hits: 0,
    });
  });
});
