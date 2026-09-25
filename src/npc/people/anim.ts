// Procedural animation for one person. Every frame each active animation writes a pose (Euler
// angles per bone + hip offset + a few control channels) into a Float32Array; loops cross-fade,
// one-shots are layered on top with an envelope, then the result is grounded with a tiny leg FK
// (so feet stay on the floor whatever the pose) and written to the bones.
import { Matrix4, Quaternion, Vector3, type Bone } from 'three';
import type { PersonAnim } from '../../core/types';
import { BONE, type Dims } from './body';
import type { Traits } from './traits';

/** Seconds after setAnim('throw') at which the item leaves the hand (gameplay can spawn litter then). */
export const THROW_RELEASE_SEC = 0.42;
/** Seconds after setAnim('pickUp') at which the hand reaches the floor. */
export const PICKUP_GRAB_SEC = 0.75;
/** Height (m) of the grip point (the held item's centre) above the feet at PICKUP_GRAB_SEC. */
export const PICKUP_GRIP_Y = 0.07;
/** Café chair seat height the 'sit' pose is built for (street café chairs: 0.46–0.48 m). */
export const SEAT_HEIGHT = 0.475;

type Loop = 'idle' | 'walk' | 'sit' | 'talk' | 'cheer';
type Shot = 'throw' | 'startled' | 'pickUp';
const SHOT_LEN: Record<Shot, number> = { throw: 1.1, startled: 1.0, pickUp: 1.8 };
const isShot = (a: PersonAnim): a is Shot => a === 'throw' || a === 'startled' || a === 'pickUp';

const NB = 17; // animated skeleton bones (cup / trash / bag are driven from channels)
const HX = NB * 3, HY = HX + 1, HZ = HX + 2; // hip offset
const GROUND = HX + 3; // 1 = keep the lowest foot on the floor
const PLANT = HX + 4; // 1 = keep the feet under their rest spot horizontally
const CUP = HX + 5, TRASH = HX + 6, SIP = HX + 7, BAG_SWING = HX + 8;
const BAG_OFF = HX + 9; // 1 = carried bag put away (seated)
const N = HX + 10;

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const smooth = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const TAU = Math.PI * 2;
/** Periodic Gaussian bump on a phase in [0,1). */
const bump = (x: number, c: number, w: number) => { let d = Math.abs(x - c); d = Math.min(d, 1 - d); return Math.exp(-((d / w) ** 2)); };
/** Piecewise-linear lookup over [x, y] pairs sorted by x. */
function tbl(rows: readonly (readonly [number, number])[], x: number): number {
  if (x <= rows[0][0]) return rows[0][1];
  for (let i = 1; i < rows.length; i++) if (x <= rows[i][0]) { const a = rows[i - 1], b = rows[i]; return lerp(a[1], b[1], (x - a[0]) / (b[0] - a[0])); }
  return rows[rows.length - 1][1];
}
// world pitch of the foot over the gait cycle (0 = heel strike): heel strike → flat → heel off → toe off → swing
const FOOT_PITCH = [[0, -0.2], [0.08, 0], [0.36, 0.03], [0.5, 0.32], [0.6, 0.5], [0.72, 0.08], [0.86, -0.14], [1, -0.2]] as const;

/** Channels a seated person keeps from the loop pose during one-shots (hips, legs, root offset). */
const LOWER = new Uint8Array(N);
for (const b of [BONE.hips, BONE.thighL, BONE.shinL, BONE.footL, BONE.thighR, BONE.shinR, BONE.footR]) LOWER.fill(1, b * 3, b * 3 + 3);
LOWER.fill(1, HX, PLANT + 1);

const set = (p: Float32Array, b: number, x: number, y: number, z: number) => { p[b * 3] = x; p[b * 3 + 1] = y; p[b * 3 + 2] = z; };
// throw keys over time (s): wind-up (forearm cocked back by the ear) → snap → follow-through
const TH_ARM_X = [[0, 0.05], [0.26, -1.0], [0.38, -1.35], [0.48, -0.95], [0.62, -0.5], [0.8, -0.35]] as const;
const TH_ARM_Y = [[0, 0], [0.26, 0.5], [0.4, 0.1], [0.6, 0]] as const;
const TH_ARM_Z = [[0, -0.08], [0.26, -0.55], [0.4, -0.25], [0.6, -0.15]] as const;
const TH_FORE_X = [[0, -0.3], [0.26, -2.1], [0.34, -1.5], [0.4, -0.5], [0.5, -0.25], [0.7, -0.3]] as const;
const TH_HAND_X = [[0, 0], [0.26, 0.55], [0.34, 0.45], [0.42, -0.8], [0.6, -0.35]] as const;
const TH_TWIST = [[0, 0], [0.28, -0.32], [0.44, 0.22], [0.75, 0.05]] as const;
// hoisted bone tables (no per-frame allocations)
const LEGS = [[BONE.thighL, BONE.shinL, BONE.footL], [BONE.thighR, BONE.shinR, BONE.footR]] as const;
const ARMS = [[1, BONE.armL, BONE.foreL, BONE.handL], [-1, BONE.armR, BONE.foreR, BONE.handR]] as const;
const CHAIN_R = [BONE.hips, BONE.spine, BONE.chest, BONE.armR, BONE.foreR, BONE.handR] as const;
const CHAIN_L = [BONE.hips, BONE.spine, BONE.chest, BONE.armL, BONE.foreL, BONE.handL] as const;

export class Animator {
  private readonly out = new Float32Array(N);
  private readonly a = new Float32Array(N);
  private readonly b = new Float32Array(N);
  private readonly shotPose = new Float32Array(N);
  /** Pose snapshot for transitions that can't cross-fade two live animations (see set()). */
  private readonly snap = new Float32Array(N);
  private snapW = 0;
  private snapLen = 0.3;
  private loop: Loop = 'idle';
  private prev: Loop | null = null;
  private fade = 1;
  private fadeLen = 0.3;
  private shot: Shot | null = null;
  private shotT = 0;
  private t: number;
  private phase: number; // gait phase 0..1
  private speed = 0;
  // look-around state
  private lookYaw = 0;
  private lookPitch = 0;
  private lookTY = 0;
  private lookTP = 0;
  private lookNext = 0;
  private rnd: number;
  /** Skirts, dresses and robes: the skirt panel bones follow the legs; pick-ups kneel. */
  private readonly skirted: boolean;
  /** Hem below the knee: shorter steps, less knee lift. */
  private readonly longSkirt: boolean;
  /** Extra forward bend of the pick-up pose, solved so the grip reaches PICKUP_GRIP_Y. */
  private pickLean = 0;
  private readonly q = new Quaternion();
  private readonly q2 = new Quaternion();
  private readonly axisX = new Vector3(1, 0, 0);
  private readonly axisZ = new Vector3(0, 0, 1);

  constructor(private readonly bones: Bone[], private readonly rest: Vector3[], private readonly d: Dims, private readonly tr: Traits) {
    this.t = tr.style.phase;
    this.phase = tr.style.phase % 1; // walkers created together don't march in lockstep
    const bk = tr.bottom.kind;
    this.skirted = bk === 'skirt' || bk === 'dress' || bk === 'longskirt' || bk === 'robe';
    this.longSkirt = this.skirted && tr.bottom.hem < 0.2;
    this.rnd = (tr.seed * 2654435761) >>> 0;
    this.lookNext = this.t + 1 + this.rand() * 3;
    this.pickLean = this.solvePickLean();
  }

  get current(): PersonAnim { return this.shot ?? this.loop; }

  set(anim: PersonAnim): void {
    if (isShot(anim)) {
      // a one-shot interrupting another would pop (the new one starts at weight 0): fade from the
      // current pose instead
      if (this.shot) this.snapshot(0.25);
      this.shot = anim;
      this.shotT = 0;
      return;
    }
    if (anim === this.loop) return;
    const len = anim === 'sit' || this.loop === 'sit' ? 0.7 : 0.3;
    if (this.prev && this.fade < 1) {
      // changed again mid cross-fade: fade from the pose as it is now
      this.snapshot(len);
      this.prev = null;
      this.fade = 1;
    } else {
      this.prev = this.loop;
      this.fadeLen = len;
      this.fade = 0;
    }
    this.loop = anim;
  }

  private snapshot(len: number): void {
    this.snap.set(this.out);
    this.snapW = 1;
    this.snapLen = len;
  }

  /** Stride length (m per gait cycle) at speed v. */
  private strideAt(v: number): number {
    const L = this.d.hipY;
    return clamp(L * (0.95 + 0.55 * v) * this.tr.style.stride * (this.longSkirt ? 0.86 : 1), 0.3 * L, 2.1 * L);
  }

  private rand(): number {
    this.rnd = (Math.imul(this.rnd ^ (this.rnd >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0;
    return this.rnd / 4294967296;
  }

  update(dt: number, speed: number): void {
    this.t += dt;
    this.speed = speed;
    this.phase = (this.phase + (dt * speed) / this.strideAt(speed)) % 1;
    this.updateLook(dt);

    // loops (cross-fade)
    this.evalLoop(this.loop, this.a);
    if (this.prev && this.fade < 1) {
      this.fade = Math.min(1, this.fade + dt / this.fadeLen);
      this.evalLoop(this.prev, this.b);
      const w = smooth(0, 1, this.fade);
      for (let i = 0; i < N; i++) this.out[i] = lerp(this.b[i], this.a[i], w);
      if (this.fade >= 1) this.prev = null;
    } else this.out.set(this.a);

    // one-shot layered on top
    if (this.shot) {
      this.shotT += dt;
      const len = SHOT_LEN[this.shot];
      if (this.shotT >= len) this.shot = null;
      else {
        const env = this.evalShot(this.shot, this.shotT, this.out, this.shotPose);
        const p = this.out, s = this.shotPose;
        // seated: one-shots move the upper body only (the patron stays on the chair)
        const seated = this.loop === 'sit' ? 1 : this.prev === 'sit' ? 1 - this.fade : 0;
        for (let i = 0; i < N; i++) p[i] = lerp(p[i], s[i], LOWER[i] ? env * (1 - seated) : env);
        p[TRASH] = s[TRASH];
      }
    }
    if (this.snapW > 0) {
      const w = smooth(0, 1, this.snapW);
      for (let i = 0; i < N; i++) this.out[i] = lerp(this.out[i], this.snap[i], w);
      this.snapW -= dt / this.snapLen;
    }
    this.apply();
  }

  private updateLook(dt: number): void {
    if (this.t > this.lookNext) {
      const r = this.rand();
      this.lookTY = r < 0.35 ? 0 : (this.rand() * 2 - 1) * 0.75;
      this.lookTP = (this.rand() * 2 - 1) * 0.12 + (r > 0.9 ? 0.2 : 0);
      this.lookNext = this.t + 1.5 + this.rand() * 4;
    }
    const k = 1 - Math.exp(-dt * 3.5);
    this.lookYaw += (this.lookTY - this.lookYaw) * k;
    this.lookPitch += (this.lookTP - this.lookPitch) * k;
  }

  // ---------------------------------------------------------------------------------------------
  private evalLoop(l: Loop, p: Float32Array): void {
    p.fill(0);
    p[GROUND] = 1;
    p[PLANT] = 1;
    switch (l) {
      case 'idle': this.idle(p, 1); break;
      case 'walk': this.walk(p); break;
      case 'talk': this.talk(p); break;
      case 'cheer': this.cheer(p); break;
      case 'sit': this.sit(p); break;
    }
  }

  /** Relaxed standing: slow weight shift, breathing, looking around. */
  private idle(p: Float32Array, lookAmt: number): void {
    const t = this.t, st = this.tr.style, H = this.d.H;
    const ws = Math.sin(t * (TAU / 7.3)) * 0.8 + Math.sin(t * 0.37) * 0.2;
    const onL = smooth(-0.4, 0.4, ws); // 1 = weight on the left leg
    p[HX] = 0.011 * H * ws * st.sway;
    set(p, BONE.hips, st.stoop * 0.2, 0, 0.035 * ws * st.sway);
    set(p, BONE.thighL, -0.05 * (1 - onL), 0, 0.02);
    set(p, BONE.shinL, 0.16 * (1 - onL), 0, 0);
    set(p, BONE.thighR, -0.05 * onL, 0, -0.02);
    set(p, BONE.shinR, 0.16 * onL, 0, 0);
    this.flatFeet(p);
    const breathe = Math.sin(t * 1.55);
    set(p, BONE.spine, st.stoop * 0.6 + 0.01 * breathe, 0, -0.025 * ws);
    set(p, BONE.chest, st.stoop * 0.4 - 0.015 * breathe, 0, -0.01 * ws);
    set(p, BONE.neck, -st.stoop * 0.5 + this.lookPitch * 0.4 * lookAmt, this.lookYaw * 0.35 * lookAmt, 0);
    set(p, BONE.head, -st.stoop * 0.4 + this.lookPitch * 0.6 * lookAmt, this.lookYaw * 0.65 * lookAmt, 0.03 * Math.sin(t * 0.5) - 0.02 * ws);
    this.arms(p, st.idle, 0);
  }

  /** Standing arm poses per idle style (walkK 1 = walking: styles that swing are left to walk()).
   *  Euler angles in the parent frame: +x swings an arm back / −x bends a forearm up in front,
   *  y twists about the vertical, +z moves the left arm outward (−z the right one). */
  private arms(p: Float32Array, style: Traits['style']['idle'], walkK: number): void {
    const t = this.t;
    const br = Math.sin(t * 1.55) * 0.012; // breathing lifts folded arms a little
    if (style === 'behind') {
      // upper arms back + rotated inward so the bent forearms meet behind the lower back
      set(p, BONE.armL, 0.55, -1.2, 0); set(p, BONE.foreL, -0.9, 0, 0); set(p, BONE.handL, 0.2, 0, 0);
      set(p, BONE.armR, 0.55, 1.2, 0); set(p, BONE.foreR, -0.9, 0, 0); set(p, BONE.handR, 0.2, 0, 0);
    } else if (style === 'pockets') {
      set(p, BONE.armL, 0.14, 0.25, 0.08); set(p, BONE.foreL, -0.5, 0, 0); set(p, BONE.handL, -0.25, 0, 0.1);
      set(p, BONE.armR, 0.14, -0.25, -0.08); set(p, BONE.foreR, -0.5, 0, 0); set(p, BONE.handR, -0.25, 0, -0.1);
    } else if (style === 'crossed') {
      // forearms folded across the chest, left over right
      // (hands flexed so the fingers rest on the opposite upper arm)
      set(p, BONE.armL, -0.3 - br, -1.05, -0.08); set(p, BONE.foreL, -1.62, 0, 0); set(p, BONE.handL, 0, 0, -0.9);
      set(p, BONE.armR, -0.26 - br, 1.05, 0.08); set(p, BONE.foreR, -1.45, 0, 0); set(p, BONE.handR, 0, 0, 0.9);
    } else if (style === 'clasped') {
      // hands loosely joined in front of the belly
      set(p, BONE.armL, -0.1 - br, -0.55, -0.1); set(p, BONE.foreL, -0.95, 0, 0); set(p, BONE.handL, 0.15, 0.2, 0.25);
      set(p, BONE.armR, -0.1 - br, 0.55, 0.1); set(p, BONE.foreR, -0.95, 0, 0); set(p, BONE.handR, 0.15, -0.2, -0.25);
    } else {
      const sw = Math.sin(t * 1.1 + 1) * 0.02 * (1 - walkK);
      set(p, BONE.armL, 0.02 + sw, 0.12, -0.07); set(p, BONE.foreL, -0.3, -0.2, 0); set(p, BONE.handL, -0.12, 0, 0.08);
      set(p, BONE.armR, 0.02 - sw, -0.12, 0.07); set(p, BONE.foreR, -0.3, 0.2, 0); set(p, BONE.handR, -0.12, 0, -0.08);
    }
    if (this.tr.carry) { // bag hand: straighter arm, slightly away from the leg
      set(p, BONE.armL, 0.02, 0, 0.1); set(p, BONE.foreL, -0.12, 0, 0); set(p, BONE.handL, 0, 0, 0);
    }
  }

  /** Keep feet parallel to the floor given the current hip/thigh/knee angles. */
  private flatFeet(p: Float32Array): void {
    const hx = p[BONE.hips * 3];
    p[BONE.footL * 3] = -(hx + p[BONE.thighL * 3] + p[BONE.shinL * 3]);
    p[BONE.footR * 3] = -(hx + p[BONE.thighR * 3] + p[BONE.shinR * 3]);
  }

  /** Walk cycle synced to speed (phase advanced in update). */
  private walk(p: Float32Array): void {
    const st = this.tr.style, H = this.d.H, L = this.d.hipY;
    const v = this.speed;
    const kk = smooth(0.05, 0.45, v); // fades to a stand at very low speed
    const A = Math.asin(Math.min(0.55, this.strideAt(v) / (4 * L))) * kk;
    const ph = this.phase;
    const th = ph * TAU;
    const c = Math.cos(th), s = Math.sin(th);
    const Kst = 0.35 * A, Ksw = (this.longSkirt ? 1.6 : 2.3) * A;
    const hx = st.stoop * 0.25 + 0.03 * kk;
    set(p, BONE.hips, hx, -0.11 * A * c, 0.07 * A * s * st.sway);
    p[HX] = 0.012 * H * s * st.sway * kk;
    p[PLANT] = 0;
    for (let side = 0; side < 2; side++) {
      const q = (ph + side * 0.5) % 1;
      const cq = Math.cos(q * TAU);
      const thigh = -A * cq - 0.1 * A;
      const knee = Kst * bump(q, 0.1, 0.09) + Ksw * bump(q, 0.68, 0.14);
      const foot = tbl(FOOT_PITCH, q) * kk - (hx + thigh + knee);
      const leg = LEGS[side];
      set(p, leg[0], thigh, 0, side === 0 ? 0.015 : -0.015);
      set(p, leg[1], knee, 0, 0);
      set(p, leg[2], foot, 0, 0);
    }
    const lean = 0.03 + 0.03 * v * kk + st.stoop * 0.6;
    set(p, BONE.spine, lean, 0.06 * A * c, -0.02 * A * s);
    set(p, BONE.chest, st.stoop * 0.4, 0.1 * A * c, 0);
    // head stays level and looks ahead (glances only a little while walking)
    set(p, BONE.neck, -lean * 0.5 - st.stoop * 0.4, this.lookYaw * 0.15, 0);
    set(p, BONE.head, -lean * 0.4 - st.stoop * 0.3 + 0.02 * Math.cos(th * 2) * kk, -0.05 * A * c + this.lookYaw * 0.25, 0);
    if (st.idle === 'behind' && this.tr.age === 'senior' && !this.tr.carry) { this.arms(p, 'behind', 1); }
    else {
      const sw = A * 1.1 * st.armSwing;
      set(p, BONE.armL, 0.05 + sw * c, 0, 0.07); set(p, BONE.foreL, -(0.2 + 0.35 * Math.max(0, -c) * st.armSwing * kk), -0.15, 0); set(p, BONE.handL, -0.1, 0, 0);
      set(p, BONE.armR, 0.05 - sw * c, 0, -0.07); set(p, BONE.foreR, -(0.2 + 0.35 * Math.max(0, c) * st.armSwing * kk), 0.15, 0); set(p, BONE.handR, -0.1, 0, 0);
      if (this.tr.carry) { set(p, BONE.armL, 0.02 + sw * 0.3 * c, 0, 0.1); set(p, BONE.foreL, -0.1, 0, 0); set(p, BONE.handL, 0, 0, 0); }
    }
    if (this.tr.backpack) { set(p, BONE.armR, p[BONE.armR * 3], 0, -0.1); }
    p[BAG_SWING] = 0.14 * Math.sin(th + 0.6) * kk;
  }

  /** Conversation: idle legs, beat gestures, nods. */
  private talk(p: Float32Array): void {
    this.idle(p, 0.25);
    const t = this.t, e = this.tr.style.energy;
    const g1 = (0.5 + 0.5 * Math.sin(t * 1.7) * Math.sin(t * 0.63 + 1.3)) * e;
    const g2 = (0.5 + 0.5 * Math.sin(t * 1.23 + 2) * Math.sin(t * 0.51 + 0.4)) * e * 0.7;
    const beat = Math.pow(Math.max(0, Math.sin(t * 4.3)), 6) * e;
    set(p, BONE.armR, -0.2 - 0.4 * g1 - 0.12 * beat, 0.25 * g1, -0.12 - 0.22 * g1);
    set(p, BONE.foreR, -0.95 - 0.45 * g1 + 0.25 * beat, 0.7 * g1, 0);
    set(p, BONE.handR, 0.15 * g1 - 0.3 * beat, 0, -0.25 * g1);
    if (!this.tr.carry) {
      set(p, BONE.armL, -0.12 - 0.35 * g2, -0.2 * g2, 0.1 + 0.18 * g2);
      set(p, BONE.foreL, -0.7 - 0.5 * g2, -0.6 * g2, 0);
      set(p, BONE.handL, 0.15 * g2, 0, 0.2 * g2);
    }
    set(p, BONE.chest, p[BONE.chest * 3] + 0.02 * beat, 0.06 * (g1 - g2), 0);
    set(p, BONE.head, p[BONE.head * 3] + 0.06 * Math.sin(t * 3.3) * (0.3 + g1) + 0.05 * beat, p[BONE.head * 3 + 1] + 0.12 * Math.sin(t * 0.4), 0.05 * Math.sin(t * 0.7));
  }

  /** Clapping or arms-up cheering with little hops. */
  private cheer(p: Float32Array): void {
    this.idle(p, 0);
    const t = this.t, H = this.d.H;
    // one style per person (blending clap ↔ arms-up swings the arms through a T-pose); a bag in
    // one hand makes clapping impossible, so bag carriers raise the free arm
    const up = this.tr.style.cheer || this.tr.carry ? 1 : 0;
    const clap = 0.5 + 0.5 * Math.sin(t * TAU * 2.3);
    const wave = Math.sin(t * 7);
    for (const [side, a, f, hnd] of ARMS) {
      if (side > 0 && this.tr.carry) continue; // the bag hand keeps its idle pose
      // clap: upper arm forward + rotated inward so the bent forearms bring the hands together
      const cy = -side * (0.42 + 0.3 * clap);
      const ux = -0.25, uz = side * (2.5 + 0.1 * wave), uf = -0.3 - 0.25 * Math.max(0, wave * side);
      set(p, a, lerp(-0.72, ux, up), lerp(cy, 0, up), lerp(side * 0.05, uz, up));
      set(p, f, lerp(-1.6, uf, up), 0, 0);
      set(p, hnd, lerp(-0.15, 0, up), 0, 0);
    }
    const hop = Math.pow(Math.max(0, Math.sin(t * TAU * 1.15)), 2) * up;
    p[HY] += 0.028 * H * hop;
    const bounce = Math.abs(Math.sin(t * Math.PI * 2.3)) * (1 - up);
    for (const [tb, sb] of LEGS) { p[tb * 3] -= 0.1 * bounce + 0.15 * (1 - hop) * up; p[sb * 3] += 0.2 * bounce + 0.3 * (1 - hop) * up; }
    this.flatFeet(p);
    set(p, BONE.head, -0.12, 0.25 * Math.sin(t * 0.8), 0.06 * Math.sin(t * 2.3));
    set(p, BONE.chest, -0.05, 0.05 * Math.sin(t * 2.3), 0);
  }

  /** Seated on a café chair (seat at SEAT_HEIGHT above the feet), sipping coffee now and then. */
  private sit(p: Float32Array): void {
    const t = this.t, d = this.d, H = d.H;
    p[GROUND] = 0;
    p[PLANT] = 0;
    const hipsY = SEAT_HEIGHT + 0.05 * H;
    p[HY] = hipsY - d.hipY;
    p[HZ] = -0.035;
    // thighs: solve so the feet reach the floor with the shins slightly forward
    const sw = -0.2;
    const ca = clamp((hipsY - d.shin * Math.cos(sw) - d.ankleY) / d.thigh, -1, 1);
    const a = -Math.acos(ca);
    const spread = this.tr.female ? 0.05 : 0.14;
    set(p, BONE.thighL, a, -spread * 0.5, spread);
    set(p, BONE.shinL, sw - a, 0, -spread * 0.6);
    set(p, BONE.thighR, a + 0.04, spread * 0.5, -spread);
    set(p, BONE.shinR, sw - a - 0.08, 0, spread * 0.6);
    set(p, BONE.footL, -sw, 0, 0);
    set(p, BONE.footR, -sw + 0.08, 0, 0);
    // sip cycle
    const period = 9 + (this.tr.seed % 5);
    const tau = (t + this.tr.style.phase * 3) % period;
    const w = smooth(0, 0.9, tau) * (1 - smooth(2.7, 3.6, tau));
    const lean = 0.08 + 0.04 * Math.sin(t * 0.3);
    set(p, BONE.spine, lean + 0.04 * w, 0, 0);
    set(p, BONE.chest, 0.02 - 0.03 * w, 0.05 * Math.sin(t * 0.25), 0);
    set(p, BONE.neck, this.lookPitch * 0.3, this.lookYaw * 0.3 * (1 - w), 0);
    set(p, BONE.head, -0.05 - 0.14 * w + this.lookPitch * 0.4, this.lookYaw * 0.5 * (1 - w), 0.02 * Math.sin(t * 0.6));
    // left forearm resting on the table edge
    set(p, BONE.armL, -0.45, 0.1, 0.12); set(p, BONE.foreL, -1.2, -0.5, 0); set(p, BONE.handL, 0.15, 0, 0);
    // right hand: cup on the table ↔ at the mouth
    set(p, BONE.armR, lerp(-0.42, -0.62, w), lerp(0, 0.2, w), lerp(-0.1, -0.42, w));
    set(p, BONE.foreR, lerp(-1.4, -2.2, w), lerp(0.2, 0.6, w), 0);
    set(p, BONE.handR, lerp(0.55, -0.15, w), 0, 0);
    p[CUP] = 1;
    p[BAG_OFF] = 1;
    p[SIP] = w;
  }

  // ---------------------------------------------------------------------------------------------
  /** Writes the one-shot pose into `s` (starting from the loop pose `base`), returns its weight. */
  private evalShot(k: Shot, tt: number, base: Float32Array, s: Float32Array): number {
    s.set(base);
    const H = this.d.H;
    if (k === 'throw') {
      // overhand flick to the front-right: wind up with the forearm cocked back past the shoulder,
      // snap forward and down (release at THROW_RELEASE_SEC), follow through to the front of the hip;
      // the chest twists into it. Legs keep doing the loop.
      set(s, BONE.armR, tbl(TH_ARM_X, tt), tbl(TH_ARM_Y, tt), tbl(TH_ARM_Z, tt));
      set(s, BONE.foreR, tbl(TH_FORE_X, tt), 0.25, 0);
      set(s, BONE.handR, tbl(TH_HAND_X, tt), 0, 0);
      const tw = tbl(TH_TWIST, tt);
      set(s, BONE.spine, base[BONE.spine * 3] + 0.05 * smooth(0.3, 0.5, tt), tw * 0.35, 0);
      set(s, BONE.chest, base[BONE.chest * 3] + 0.04 * smooth(0.3, 0.5, tt), tw * 0.65, 0);
      set(s, BONE.head, base[BONE.head * 3] + 0.06, -0.2 - tw * 0.4, 0);
      s[TRASH] = tt < THROW_RELEASE_SEC ? 1 : 0;
      return smooth(0, 0.12, tt) * (1 - smooth(0.7, 1.1, tt));
    }
    if (k === 'startled') {
      const hop = Math.sin(Math.PI * clamp(tt / 0.32, 0, 1));
      s[HX] = 0;
      s[HZ] = -0.055 * H * smooth(0, 0.2, tt);
      s[HY] = 0.03 * H * hop;
      s[PLANT] = 0;
      set(s, BONE.hips, -0.05, 0, 0);
      set(s, BONE.thighL, 0.05 - 0.3 * hop, 0, 0.05); set(s, BONE.shinL, 0.15 + 0.55 * hop, 0, 0);
      set(s, BONE.thighR, 0.2, 0, -0.05); set(s, BONE.shinR, 0.3 + 0.2 * hop, 0, 0);
      this.flatFeet(s);
      set(s, BONE.spine, -0.2, 0, 0); set(s, BONE.chest, -0.12, 0, 0);
      set(s, BONE.neck, -0.08, 0, 0); set(s, BONE.head, -0.12, 0.08 * Math.sin(tt * 25) * (1 - tt), 0);
      set(s, BONE.armL, -1.1, -0.2, 0.5); set(s, BONE.foreL, -1.35, -0.5, 0); set(s, BONE.handL, -0.5, 0, 0);
      set(s, BONE.armR, -1.1, 0.2, -0.5); set(s, BONE.foreR, -1.35, 0.5, 0); set(s, BONE.handR, -0.5, 0, 0);
      s[BAG_SWING] = 0.4 * hop;
      return smooth(0, 0.06, tt) * (1 - smooth(0.45, 1.0, tt));
    }
    // pickUp: squat (or kneel in a skirt), reach the right hand to the floor, stand up holding it
    const reach = smooth(0.3, PICKUP_GRAB_SEC, tt) * (1 - smooth(0.95, 1.45, tt));
    this.pickPose(s, reach);
    s[TRASH] = tt > PICKUP_GRAB_SEC && tt < SHOT_LEN.pickUp - 0.15 ? 1 : 0;
    return smooth(0, 0.55, tt) * (1 - smooth(1.0, 1.8, tt));
  }

  /** Pick-up pose at full weight; `k` 0..1 extends the reaching arm + the solved extra bend. */
  private pickPose(s: Float32Array, k: number): void {
    s[HX] = 0;
    s[HZ] = 0;
    s[PLANT] = 1;
    s[GROUND] = 1;
    let bend: number; // hips + spine + chest forward bend
    if (this.skirted) {
      // kneel on the right knee (a skirt can't follow a deep squat), left foot planted forward
      set(s, BONE.hips, 0.15, 0, 0);
      set(s, BONE.thighL, -1.62, -0.08, 0.06); set(s, BONE.shinL, 2.0, 0, 0);
      set(s, BONE.thighR, -0.12, 0.05, -0.05); set(s, BONE.shinR, 1.95, 0, 0);
      this.flatFeet(s);
      s[BONE.footR * 3] = 1.25 - (0.15 - 0.12 + 1.95); // toes tucked under
      set(s, BONE.spine, 0.3 + this.pickLean * 0.55 * k, 0.05, 0); set(s, BONE.chest, 0.2 + this.pickLean * 0.45 * k, 0.05, 0);
      bend = 0.15 + 0.3 + 0.2;
    } else {
      // squat, knees apart, heels down
      set(s, BONE.hips, 0.3, 0, 0);
      // (both legs give the same hip height, so neither heel lifts)
      set(s, BONE.thighL, -1.65, -0.22, 0.2); set(s, BONE.shinL, 1.8, 0, -0.08);
      set(s, BONE.thighR, -1.5, 0.22, -0.2); set(s, BONE.shinR, 1.86, 0, 0.08);
      this.flatFeet(s);
      set(s, BONE.spine, 0.25 + this.pickLean * 0.55 * k, 0.08, 0); set(s, BONE.chest, 0.2 + this.pickLean * 0.45 * k, 0.05, 0);
      bend = 0.3 + 0.25 + 0.2;
    }
    bend += this.pickLean * k;
    // head looks at the item: counter part of the bend
    set(s, BONE.neck, -0.25 * bend + 0.1, 0, 0); set(s, BONE.head, -0.2 * bend + 0.25, -0.1, 0);
    // right arm hangs to the floor (a little forward of vertical) with a nearly straight elbow
    set(s, BONE.armR, lerp(-0.35, -bend - 0.22, k), lerp(0.1, 0.15, k), lerp(-0.12, -0.1, k));
    set(s, BONE.foreR, lerp(-0.7, -0.12, k), 0.2, 0);
    set(s, BONE.handR, lerp(0.1, 0.35, k), 0, 0);
    // left forearm rests on the left knee
    set(s, BONE.armL, -bend + 0.35, 0, 0.18); set(s, BONE.foreL, -1.1, -0.4, 0); set(s, BONE.handL, 0.2, 0, 0);
  }

  /** Finds pickLean so the grip point (trash bone) sits PICKUP_GRIP_Y above the floor at the grab.
   *  Monotone in the lean (the arm compensates the bend), so a bisection is exact and cheap; runs
   *  once per person (~20 µs). */
  private solvePickLean(): number {
    const s = this.shotPose, B = this.bones;
    const m = new Matrix4();
    let lo = 0, hi = 1.4;
    for (let it = 0; it < 16; it++) {
      this.pickLean = (lo + hi) / 2;
      s.fill(0);
      this.pickPose(s, 1);
      const [hy, hz] = this.ground(s);
      m.identity();
      for (const i of CHAIN_R) {
        const b = B[i];
        b.rotation.set(s[i * 3], s[i * 3 + 1], s[i * 3 + 2]);
        if (i === BONE.hips) b.position.set(this.rest[i].x, this.rest[i].y + hy, this.rest[i].z + hz);
        b.updateMatrix();
        m.multiply(b.matrix);
      }
      m.multiply(B[BONE.trash].matrix);
      if (m.elements[13] > PICKUP_GRIP_Y) lo = this.pickLean; else hi = this.pickLean;
    }
    return (lo + hi) / 2;
  }

  // ---------------------------------------------------------------------------------------------
  /** Hip offset (y, z) that keeps the lowest foot / knee on the floor and the feet planted. Tiny leg
   *  FK in the sagittal plane. */
  private ground(p: Float32Array): [number, number] {
    const d = this.d;
    const hp = p[BONE.hips * 3];
    let need = 0, zSum = 0;
    for (const [tb, sb, fb] of LEGS) {
      const A = hp + p[tb * 3], K = A + p[sb * 3], P = K + p[fb * 3];
      const knee = d.thigh * Math.cos(A);
      const drop = knee + d.shin * Math.cos(K);
      const cp = Math.cos(P), sp = Math.sin(P);
      const heel = -d.ankleY * cp + 0.26 * d.footLen * sp;
      const toe = -(d.ankleY - 0.003 * d.H) * cp - 0.72 * d.footLen * sp;
      need = Math.max(need, drop - Math.min(heel, toe), knee + 0.03 * d.H); // (the knee only matters kneeling)
      zSum += -d.thigh * Math.sin(A) - d.shin * Math.sin(K);
    }
    return [p[HY] + p[GROUND] * (need - d.hipY), p[HZ] - p[PLANT] * zSum * 0.5];
  }

  /** Grounding + write to bones + prop bones. */
  private apply(): void {
    const p = this.out, B = this.bones;
    const [hipsY, hipsZ] = this.ground(p);
    for (let i = 0; i < NB; i++) B[i].rotation.set(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
    B[BONE.hips].position.set(this.rest[BONE.hips].x + p[HX], this.rest[BONE.hips].y + hipsY, this.rest[BONE.hips].z + hipsZ);
    if (this.skirted) {
      // skirt panels: the front follows the leg that is further forward, the back the one further
      // back (upper panel from the hip, lower panel from the knee); the sides blend both
      const tL = p[BONE.thighL * 3], tR = p[BONE.thighR * 3];
      const sL = tL + p[BONE.shinL * 3], sR = tR + p[BONE.shinR * 3];
      const f = Math.min(tL, tR), b = Math.max(tL, tR);
      B[BONE.skirtF].rotation.set(f, 0, 0);
      B[BONE.skirtB].rotation.set(b, 0, 0);
      B[BONE.skirtFL].rotation.set(Math.min(sL, sR) - f, 0, 0);
      B[BONE.skirtBL].rotation.set((Math.max(sL, sR) - b) * 0.75, 0, 0); // fabric doesn't follow a kicked-up heel fully
    }

    const hide = 1e-4;
    B[BONE.trash].scale.setScalar(p[TRASH] > 0.5 ? 1 : hide);
    const cupOn = p[CUP] > 0.5;
    B[BONE.cup].scale.setScalar(cupOn ? 1 : hide);
    if (cupOn) this.upright(BONE.cup, CHAIN_R, this.axisX, -0.9 * p[SIP]);
    if (this.tr.carry) {
      B[BONE.bag].scale.setScalar(p[BAG_OFF] > 0.5 ? hide : 1);
      this.upright(BONE.bag, CHAIN_L, this.axisZ, p[BAG_SWING]);
    }
  }

  /** Orients a prop bone upright in model space (plus a tilt about `axis`), whatever the hand does. */
  private upright(bone: number, chain: readonly number[], axis: Vector3, tilt: number): void {
    const q = this.q.identity();
    for (const i of chain) q.multiply(this.bones[i].quaternion);
    q.invert().multiply(this.q2.setFromAxisAngle(axis, tilt));
    this.bones[bone].quaternion.copy(q);
  }
}
