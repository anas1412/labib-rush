// Shared contracts between modules. Change only with care: every module codes against these.
// Units: meters, seconds, radians. Y is up. The avenue runs along X (west = -X, east = +X).
// North = -Z, south = +Z. See src/core/layout.ts for all map coordinates.
import type { Object3D, PerspectiveCamera, Scene, Vector3, WebGLRenderer } from 'three';
import type { Emitter } from './events';
import type { Physics } from './physics';
import type { Assets } from './assets';

export type Quality = 'low' | 'medium' | 'high' | 'ultra';

export type LitterKind = 'can' | 'bottle' | 'chips' | 'bag' | 'golden';
export type PowerUpKind = 'tea' | 'bambalouni' | 'mashmoum' | 'chechia';

export interface Settings {
  quality: Quality | 'auto';
  musicVolume: number; // 0..1
  sfxVolume: number; // 0..1
  muted: boolean;
  mouseSensitivity: number; // 0.2..3, 1 = default
  invertY: boolean;
  cameraShake: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  quality: 'auto',
  musicVolume: 0.6,
  sfxVolume: 0.8,
  muted: false,
  mouseSensitivity: 1,
  invertY: false,
  cameraShake: true,
};

/** One saved leaderboard row (browser localStorage). */
export interface ScoreEntry {
  name: string;
  score: number;
  items: number;
  bestCombo: number;
  durationSec: number;
  date: string; // ISO 8601
}

/** Final stats of a run, produced by gameplay/rules.ts and shown on the game-over screen. */
export interface RunResult {
  score: number;
  items: number; // litter items deposited in bins (incl. trick shots)
  pickups: number;
  deposits: number;
  trickShots: number;
  caught: number; // litterbugs caught
  bestCombo: number; // best multiplier reached (1,2,3,5)
  longestChain: number; // most pickups in one combo chain
  durationSec: number;
  hits: number;
}

/** What the HUD shows each frame. */
export interface HudState {
  timeLeft: number;
  score: number;
  multiplier: number; // 1,2,3,5 (x2 with chechia is shown separately via powerups)
  comboProgress01: number; // time left in current combo window, 1 = just picked up
  bag: number;
  bagMax: number;
  powerups: { kind: PowerUpKind; remaining: number; duration: number }[];
  radarCooldown01: number; // 0 = ready, 1 = just used
}

// ---------------------------------------------------------------------------------------------
// Events (src/core/events.ts Emitter). Gameplay emits, UI/audio/fx listen.
export interface GameEvents {
  pickup: { kind: LitterKind; points: number; multiplier: number; chain: number; position: Vector3 };
  bagFull: { position: Vector3 };
  deposit: { items: number; points: number; timeAdded: number; position: Vector3 };
  trickShot: { kind: LitterKind; points: number; position: Vector3 };
  caught: { points: number; position: Vector3 };
  litterThrown: { position: Vector3 };
  powerup: { kind: PowerUpKind; duration: number; position: Vector3 };
  powerupEnd: { kind: PowerUpKind };
  comboUp: { multiplier: number; callout: string };
  comboBreak: { chain: number };
  hit: { spilled: number; position: Vector3 };
  honk: { position: Vector3 };
  radar: { position: Vector3 };
  timeWarning: { secondsLeft: number }; // fired once per second during the last 10 s
  timeAdded: { seconds: number };
  // player → audio/fx
  jump: { position: Vector3 };
  land: { position: Vector3; impact: number }; // impact = downward speed m/s
  footstep: { position: Vector3; sprint: boolean };
  kick: { position: Vector3 };
  // session
  runStart: Record<string, never>;
  runEnd: { result: RunResult };
  pause: Record<string, never>;
  resume: Record<string, never>;
}

// ---------------------------------------------------------------------------------------------
// Input (src/core/input.ts)
export interface InputFrame {
  move: { x: number; y: number }; // -1..1, y = forward (camera relative), length <= 1
  lookDX: number; // radians of yaw delta requested this frame (already sensitivity-scaled)
  lookDY: number; // radians of pitch delta requested this frame
  sprint: boolean;
  jumpPressed: boolean; // edge-triggered this frame
  jumpHeld: boolean;
  kickPressed: boolean;
  radarPressed: boolean;
  pausePressed: boolean;
}

export interface Input {
  readonly isTouch: boolean;
  /** Call once per rendered frame; returns and resets edge-triggered presses and look deltas. */
  poll(): InputFrame;
  setEnabled(enabled: boolean): void; // disabled = zero input, touch controls hidden, pointer released
  setSettings(s: Settings): void;
  requestPointerLock(): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------------------------
// Labib avatar (src/player/labib.ts). Visual only: the controller moves avatar.root.
export type AvatarState = 'idle' | 'walk' | 'run' | 'jump' | 'fall' | 'stun';
export type AvatarAction = 'jump' | 'land' | 'kick' | 'pickup' | 'deposit' | 'hit' | 'victory' | 'caught';

export interface AvatarMotion {
  state: AvatarState;
  speed: number; // horizontal m/s
  maxSpeed: number; // current max run speed (for blend normalisation)
  verticalVelocity: number;
  grounded: boolean;
  turnRate: number; // rad/s, signed (for lean)
}

export interface LabibAvatar {
  /** Origin at the feet, facing local +Z. */
  root: Object3D;
  /** Standing height to the top of the head (ears excluded), meters. */
  height: number;
  update(dt: number, motion: AvatarMotion): void;
  trigger(action: AvatarAction): void;
  setChechia(on: boolean): void;
  setRadarGlow(on: boolean): void;
  setSprintTrail(on: boolean): void; // mint-tea speed boost visual
  dispose(): void;
}

// ---------------------------------------------------------------------------------------------
// Player controller (src/player/controller.ts)
export interface PlayerController {
  readonly position: Vector3; // feet position (world)
  readonly velocity: Vector3;
  readonly yaw: number; // facing, radians, 0 = +Z
  readonly grounded: boolean;
  readonly stunned: boolean;
  avatar: LabibAvatar;
  update(dt: number, input: InputFrame, cameraYaw: number): void;
  knockback(direction: Vector3, strength: number, stunSec: number): void;
  setSpeedMultiplier(m: number): void;
  reset(position: Vector3, yaw: number): void;
}

// ---------------------------------------------------------------------------------------------
// World building (src/world/*). Each builder returns a WorldPart; colliders go into ctx.physics.
export interface SharedUniforms {
  uTime: { value: number };
  uWind: { value: Vector3 }; // xz = direction * strength (m/s), y = gustiness 0..1
}

export interface BuildContext {
  physics: Physics;
  assets: Assets;
  quality: Quality;
  renderer: WebGLRenderer;
  uniforms: SharedUniforms;
}

export interface WorldPart {
  root: Object3D;
  update?(dt: number, time: number, cameraPosition: Vector3): void;
  dispose?(): void;
}

/** Positions (world) where gameplay can spawn litter. Surface height is included in y. */
export interface SpawnAnchors {
  benches: Vector3[]; // under/near benches, on the ground
  cafeTables: Vector3[]; // on table tops
  kioskRoofs: Vector3[]; // on kiosk roofs (reachable by jumping)
  planters: Vector3[]; // inside planters/hedges edges
  roadEdges: Vector3[]; // gutter next to the curb (risky: taxis)
  cafeChairs: Vector3[]; // seat positions for seated NPCs (y = seat height), facing given by nearest table
}

export interface StreetResult extends WorldPart {
  anchors: SpawnAnchors;
}

// ---------------------------------------------------------------------------------------------
// Engine (src/core/engine.ts): renderer, lighting, atmosphere, post-processing, quality.
export interface Engine {
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly quality: Quality;
  readonly fps: number; // smoothed
  /** Loads HDRI/env, creates sun + sky + fog. Call once before building the world. */
  initLighting(assets: Assets): Promise<void>;
  setQuality(q: Quality): void;
  /** Measures real frame times for ~seconds with the current scene and picks a preset. */
  autoDetectQuality(seconds?: number): Promise<Quality>;
  /** Keeps shadow frustum centred on the player. */
  setFocus(position: Vector3): void;
  render(dt: number): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------------------------
// Camera rig (src/player/cameraRig.ts)
export interface CameraRig {
  readonly yaw: number; // for camera-relative movement
  update(dt: number, input: InputFrame, target: PlayerController): void;
  shake(intensity: number, duration?: number): void; // respects settings.cameraShake
  setSettings(s: Settings): void;
  /** Menu mode: slow cinematic orbit/dolly around a point (used behind the main menu). */
  setMenuMode(on: boolean): void;
  reset(yaw: number): void;
}

// ---------------------------------------------------------------------------------------------
// Audio (src/audio/audio.ts)
export type SfxName =
  | 'pickup' | 'pickupRare' | 'bagFull' | 'deposit' | 'trickShot' | 'cheer' | 'caught' | 'litterThrown'
  | 'powerup' | 'powerupEnd' | 'hit' | 'honk' | 'jump' | 'land' | 'footstep' | 'kick' | 'radar'
  | 'comboUp' | 'comboBreak' | 'tick' | 'timeAdded' | 'gameOver' | 'newBest' | 'uiClick' | 'uiHover'
  | 'uiBack' | 'countdown' | 'go' | 'birds';

export interface AudioEngine {
  /** Must be called from a user gesture handler (click/keydown/touchend). Safe to call repeatedly. */
  unlock(): void;
  setSettings(s: Settings): void;
  play(name: SfxName, opts?: { pitch?: number; volume?: number; position?: Vector3 }): void;
  /** For positional sounds: call every frame with camera position/orientation. */
  setListener(position: Vector3, forward: Vector3): void;
  startMusic(): void;
  stopMusic(fadeSec?: number): void;
  setMusicIntensity(v01: number): void; // rises with combo / final seconds
  setMenuMusic(on: boolean): void; // calmer arrangement for menus
  startAmbience(): void;
  stopAmbience(): void;
  setPaused(paused: boolean): void;
}

// ---------------------------------------------------------------------------------------------
// FX (src/fx/fx.ts): pooled GPU particles.
export type FxKind = 'sparkle' | 'goldSparkle' | 'dust' | 'confetti' | 'spill' | 'powerup' | 'hit' | 'deposit' | 'leaves' | 'speedLines';

export interface Fx {
  root: Object3D;
  burst(kind: FxKind, position: Vector3, opts?: { count?: number; color?: number; scale?: number; direction?: Vector3 }): void;
  update(dt: number, cameraPosition: Vector3): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------------------------
// UI (src/ui/*): all DOM screens + HUD + persistence of name/scores/settings.
export interface UIHandlers {
  onPlay(): void; // Play (menu) or Play again (game over)
  onPause(): void; // HUD pause button (touch)
  onResume(): void;
  onRestart(): void;
  onQuitToMenu(): void;
  onSettingsChange(s: Settings): void;
  onUserGesture(): void; // first click/tap/key anywhere — used to unlock audio
}

export interface ScreenPoint { x: number; y: number; visible: boolean } // CSS pixels

export interface UIController {
  setLoading(progress01: number, label: string): void;
  /** Hides the loading screen, then shows name entry (first visit) or the main menu. */
  finishLoading(): void;
  /** Hide menus, show HUD (+ first-run hints). */
  enterGame(): void;
  updateHud(h: HudState): void; // called every frame, must be cheap (only touch changed DOM)
  callout(text: string, kind?: 'combo' | 'good' | 'bad' | 'info'): void; // big centre text, e.g. "Mriguel!"
  floatText(text: string, world: Vector3, kind?: 'points' | 'time' | 'bad' | 'gold'): void;
  setProjector(fn: (world: Vector3) => ScreenPoint): void;
  /** Screen-edge arrow for the nearest bin. null hides it. */
  setBinPointer(world: Vector3 | null): void;
  showHint(id: 'move' | 'pickup' | 'deposit' | 'kick' | 'radar' | 'litterbug' | null): void;
  showPause(): void;
  hidePause(): void;
  /** Saves the score for the current player, shows results + refreshed leaderboard. */
  showGameOver(result: RunResult): void;
  getSettings(): Settings;
  getPlayerName(): string;
  isInGame(): boolean;
}

// ---------------------------------------------------------------------------------------------
/** Everything a gameplay system may need. Built once in main.ts. */
export interface GameContext {
  engine: Engine;
  physics: Physics;
  assets: Assets;
  events: Emitter<GameEvents>;
  uniforms: SharedUniforms;
  input: Input;
  player: PlayerController;
  cameraRig: CameraRig;
  audio: AudioEngine;
  fx: Fx;
  ui: UIController;
  anchors: SpawnAnchors;
}

// ---------------------------------------------------------------------------------------------
// Props (src/props/index.ts → `createProps(ctx)`): model factories used by gameplay & NPCs.
// Every call returns a NEW Object3D (geometry/materials shared internally). Origin at the bottom
// centre, real-world scale, facing +Z unless stated.
export interface BinModel {
  root: Object3D;
  /** Height of the rim/opening above the base (trick-shot detection), and opening radius. */
  openingHeight: number;
  openingRadius: number;
  /** Footprint half extents for a static collider (x, z) and total height. */
  half: { x: number; z: number };
  height: number;
  setHighlight(on: boolean): void; // subtle glow/marker when Labib carries litter
  bump(): void; // short squash/lid-flap animation on deposit
  update(dt: number): void;
}

export interface TaxiModel {
  root: Object3D; // yellow Tunis taxi, faces +Z, origin between the wheels on the ground
  length: number;
  width: number;
  height: number;
  /** Call every frame with the distance travelled this frame (m) to spin the wheels. */
  update(dt: number, distance: number, steer: number): void;
  setBraking(on: boolean): void;
  honk(): void; // visual: headlight flash
}

export interface PropFactory {
  litter(kind: LitterKind): Object3D; // 'bag' flutters via shared uniforms
  /** Approximate collision radius (m) for a kicked item's ball/capsule collider. */
  litterRadius(kind: LitterKind): number;
  bin(): BinModel;
  powerup(kind: PowerUpKind): Object3D; // display model ~0.5 m, gameplay adds bobbing
  taxi(variant?: number): TaxiModel;
  dispose(): void;
}

// ---------------------------------------------------------------------------------------------
// People (src/npc/people.ts → `createPeople(ctx)`): pedestrians, café patrons, litterbugs.
export type PersonAnim = 'idle' | 'walk' | 'sit' | 'throw' | 'startled' | 'cheer' | 'pickUp' | 'talk';

export interface Person {
  root: Object3D; // origin at the feet, facing +Z
  height: number;
  setAnim(anim: PersonAnim): void; // 'throw' / 'startled' / 'pickUp' play once then return to the previous loop
  /** speed = current walking speed (m/s) to sync the stride. */
  update(dt: number, speed: number): void;
  setVisible(on: boolean): void;
  dispose(): void;
}

export interface PeopleFactory {
  /** Deterministic variety from a seed (clothes, skin tone, height, hair, accessories). */
  create(seed: number): Person;
  dispose(): void;
}
