import { describe, expect, it } from 'vitest';
import { inPlayArea, PLAYER_SPAWN, ALLEYS } from '../src/core/layout';

describe('inPlayArea', () => {
  it('accepts the avenue, alleys and walkable landmark fronts', () => {
    expect(inPlayArea(PLAYER_SPAWN.x, PLAYER_SPAWN.z)).toBe(true);
    const a = ALLEYS[0];
    expect(inPlayArea(a.x, -30 - a.depth + 1)).toBe(true);
    expect(inPlayArea(-30, 42)).toBe(true); // Colisée gallery
    expect(inPlayArea(-272, 31.5)).toBe(true); // in front of the embassy railing
  });
  it('rejects the embassy garden and anything beyond the map ends', () => {
    expect(inPlayArea(-272, 40)).toBe(false);
    expect(inPlayArea(315, 0)).toBe(false);
    expect(inPlayArea(0, 45)).toBe(false); // behind a facade block
  });
});
