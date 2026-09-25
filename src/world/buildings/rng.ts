// Deterministic PRNG (mulberry32) so the city looks the same on every load.
export type Rng = () => number;

export function rng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = <T>(r: Rng, arr: readonly T[]): T => arr[Math.floor(r() * arr.length) % arr.length];
export const range = (r: Rng, a: number, b: number): number => a + (b - a) * r();
export const chance = (r: Rng, p: number): boolean => r() < p;
