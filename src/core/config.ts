// Tuning values. Starting points from the design brief — playtest and tune for fun.
import type { LitterKind, PowerUpKind } from './types';

export const RULES = {
  startTime: 90,
  timePerDepositedItem: 1.5,
  warningSeconds: 10,
  maxTime: 180, // cap so strong players can't bank forever

  points: { can: 10, bottle: 15, chips: 20, bag: 50, golden: 200 } satisfies Record<LitterKind, number>,

  /** Combo: a pickup within `comboWindow` s of the previous one extends the chain. */
  comboWindow: 3,
  /** Chain length needed for each multiplier (index-aligned with `multipliers`). */
  comboThresholds: [1, 3, 6, 10],
  multipliers: [1, 2, 3, 5],
  callouts: { 2: 'Bravo!', 3: 'Mriguel!', 5: 'Barcha!' } as Record<number, string>,

  bagMax: 8,
  depositBonusPerItemSquared: 5, // bonus = items² × 5
  trickShotMultiplier: 2,
  caughtPoints: 100,
  caughtWindow: 3, // s after a throw during which touching the litterbug counts

  hitStun: 1,
  hitSpillFraction: 0.5,

  difficultyInterval: 30, // s between difficulty steps

  radar: { duration: 2, cooldown: 8, radius: 45 },
  pickupRadius: 1.1,
  depositRadius: 2.4,
} as const;

export const POWERUPS: Record<PowerUpKind, { duration: number; label: string }> = {
  tea: { duration: 8, label: 'Mint tea' }, // +40% speed
  bambalouni: { duration: 8, label: 'Bambalouni' }, // litter magnet
  mashmoum: { duration: 0, label: 'Mashmoum' }, // +10 s instantly
  chechia: { duration: 10, label: 'Chéchia' }, // ×2 score
};
export const TEA_SPEED = 1.4;
export const MAGNET_RADIUS = 7;
export const MASHMOUM_TIME = 10;
export const CHECHIA_SCORE = 2;

export const PLAYER = {
  runSpeed: 6.5, // default move speed (m/s)
  sprintSpeed: 9.5,
  accel: 38, // m/s² on ground
  decel: 30,
  airControl: 0.45,
  jumpHeight: 1.5, // m (with the physics world's arcade gravity)
  coyoteTime: 0.12,
  jumpBuffer: 0.14,
  capsuleRadius: 0.35,
  capsuleHalfHeight: 0.3, // total height = 2 * (halfHeight + radius) = 1.3 m
  stepHeight: 0.35, // curbs are 0.15, crates 1.0 are jumped
  turnSpeed: 14, // rad/s to face move direction
} as const;

/** Lighting shared by the engine and the dev harness. The HDRI (public/hdri/sky_*.hdr, Poly Haven
 *  "qwantani_late_afternoon_puresky") has its sun at 19° elevation; rotating the environment and
 *  background by `envRotationY` puts it in the west-south-west (late afternoon in Tunis), which is
 *  where `sunDirection` (pointing TOWARD the sun) aims. Verified by sampling the rendered sky. */
export const LIGHTING = {
  hdri1k: '/hdri/sky_1k.hdr',
  hdri2k: '/hdri/sky_2k.hdr',
  envRotationY: (-124 * Math.PI) / 180,
  sunDirection: [-0.888, 0.329, 0.321] as const,
  sunColor: 0xffce91,
} as const;
