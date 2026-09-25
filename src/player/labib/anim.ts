// Procedural animation for Labib: layered poses (locomotion blend, air, stun), one-shot actions with
// crossfades, facial channels (brows, lids, eyes), and spring-driven secondary motion on the ears,
// tail and satchel. Everything is preallocated; update() does not allocate.
import { Euler, MathUtils, Object3D, Quaternion, Vector3 } from 'three';
import type { AvatarAction, AvatarMotion } from '../../core/types';
import { BONE_SPECS, NB, bi, type Rig } from './rig';

const TAU = Math.PI * 2;
/** Small deterministic PRNG so idle behaviour is reproducible (and never touches Math.random). */
let seed = 0x2545f491;
const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
const { clamp, lerp, smoothstep } = MathUtils;
const ease = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
/** 0→1→0 window between a and d with ramps a..b and c..d */
const win = (u: number, a: number, b: number, c: number, d: number) => ease((u - a) / (b - a)) * (1 - ease((u - c) / (d - c)));
const wave = (u: number, a: number, b: number) => ease((u - a) / (b - a));

// bone ids
const J = {
  hips: bi('hips'), spine: bi('spine'), chest: bi('chest'), neck: bi('neck'), head: bi('head'), nose: bi('nose'), bag: bi('bag'),
  clav: bi('clavL'), arm: bi('armL'), fore: bi('foreL'), hand: bi('handL'),
  thumb: bi('thumbL'), thumb2: bi('thumb2L'), index: bi('indexL'), index2: bi('index2L'), fing: bi('fingL'), fing2: bi('fing2L'),
  thigh: bi('thighL'), shin: bi('shinL'), foot: bi('footL'), toe: bi('toeL'),
  ear: bi('earL'), ear2: bi('ear2L'), ear3: bi('ear3L'), eye: bi('eyeL'), lidU: bi('lidUL'), lidL: bi('lidLL'), brow: bi('browL'), browR: bi('browR'),
  tail: [0, 1, 2, 3, 4].map((i) => bi(`tail${i}`)),
};
const MIRROR = new Int32Array(NB).map((_, i) => {
  const n = BONE_SPECS[i].name;
  return n.endsWith('L') && BONE_SPECS.some((b) => b.name === n.slice(0, -1) + 'R') ? bi(n.slice(0, -1) + 'R') : -1;
});

const THIGH = 0.22, SHIN = 0.195;

/** Per-bone layer class for one-shot actions: 0 = upper body, 1 = legs (+ hips), 2 = spine chain. */
const LAYER = new Uint8Array(NB);
for (const b of [J.hips, J.thigh, J.shin, J.foot, J.toe]) { LAYER[b] = 1; if (MIRROR[b] >= 0) LAYER[MIRROR[b]] = 1; }
for (const b of [J.spine, J.chest, J.neck, J.head]) LAYER[b] = 2;

/** Rotations (euler XYZ, bone-local, on top of the rest pose) + position offsets for every bone. */
class Pose {
  readonly r = new Float32Array(NB * 3);
  readonly p = new Float32Array(NB * 3);
  clear(): this { this.r.fill(0); this.p.fill(0); return this; }
  /** centre bone */
  c(b: number, x: number, y: number, z: number): this { const i = b * 3; this.r[i] += x; this.r[i + 1] += y; this.r[i + 2] += z; return this; }
  /** sided bone written with LEFT semantics; right = mirrored (x, -y, -z) */
  s(bLeft: number, right: boolean, x: number, y: number, z: number): this {
    if (!right) return this.c(bLeft, x, y, z);
    return this.c(MIRROR[bLeft], x, -y, -z);
  }
  /** both sides, symmetric */
  both(bLeft: number, x: number, y: number, z: number): this { return this.s(bLeft, false, x, y, z).s(bLeft, true, x, y, z); }
  pos(b: number, x: number, y: number, z: number): this { const i = b * 3; this.p[i] += x; this.p[i + 1] += y; this.p[i + 2] += z; return this; }
  addScaled(o: Pose, w: number): this {
    if (w === 0) return this;
    for (let i = 0; i < this.r.length; i++) { this.r[i] += o.r[i] * w; this.p[i] += o.p[i] * w; }
    return this;
  }
  /**
   * Blends toward `o` per bone layer: upper body by `w`, legs by `wLegs`; the spine chain lerps when
   * standing and becomes additive when moving (`add` = 1), so the run lean and bounce survive an action.
   */
  layerTo(o: Pose, w: number, wLegs: number, add: number): this {
    if (w <= 0) return this;
    for (let b = 0; b < NB; b++) {
      const cls = LAYER[b];
      const k = cls === 1 ? wLegs : w;
      const keep = cls === 2 ? add : 0; // share of the base pose kept under the action
      for (let j = b * 3; j < b * 3 + 3; j++) {
        this.r[j] += (o.r[j] - this.r[j] * (1 - keep)) * k;
        this.p[j] += (o.p[j] - this.p[j] * (1 - keep)) * k;
      }
    }
    return this;
  }
}

class Spring {
  x = 0; v = 0;
  constructor(public k: number, public c: number) {}
  step(target: number, dt: number): number {
    const a = this.k * (target - this.x) - this.c * this.v;
    this.v += a * dt;
    this.x += this.v * dt;
    return this.x;
  }
  kick(dv: number): void { this.v += dv; }
  reset(): void { this.x = this.v = 0; }
}

/** Fingers: curl 0 = open, 1 = fist. `index` / `thumb` override for pointing & thumbs-up. */
function hand(P: Pose, right: boolean, curl: number, index = curl, thumb = curl): void {
  P.s(J.fing, right, 0, 0.05 * curl, -1.25 * curl).s(J.fing2, right, 0, 0, -1.35 * curl);
  P.s(J.index, right, 0, -0.04, -1.2 * index).s(J.index2, right, 0, 0, -1.3 * index);
  P.s(J.thumb, right, 0.4 * thumb, 0.55 * thumb, -0.35 * thumb).s(J.thumb2, right, 0, 0.3 * thumb, -0.7 * thumb);
}

/** Relaxed stance shared by everything (arms down from the A-pose, soft elbows). */
function stance(P: Pose): void {
  P.both(J.arm, -0.06, 0.12, -0.64).both(J.fore, -0.3, 0, 0.05).both(J.hand, 0.2, 0.08, -0.12);
  hand(P, false, 0.3); hand(P, true, 0.3);
}

type Face = { browY: number; browTilt: number; lidU: number; lidL: number; lookX: number; lookY: number };

type ActionDef = {
  dur: number; fadeIn: number; fadeOut: number;
  /** leg (and hips) weight of the action when standing / when moving: 0 keeps the walk/run cycle underneath */
  legs: number; legsMoving: number;
  /** playback speed-up at full run (1 = none) */
  runRate?: number;
  /** `mv` = 0 standing … 1 moving */
  pose: (P: Pose, u: number, t: number, f: Face, mv: number) => void;
};

// ---------------------------------------------------------------------------------------------
// One-shot actions (u = normalised time 0..1, t = seconds since start)
const ACTIONS: Partial<Record<AvatarAction, ActionDef>> = {
  kick: {
    dur: 0.62, fadeIn: 0.06, fadeOut: 0.2, legs: 1, legsMoving: 1, runRate: 1.55,
    pose(P, u, _t, f) {
      const wind = win(u, 0, 0.3, 0.32, 0.45), strike = win(u, 0.32, 0.45, 0.6, 0.95);
      // right leg: back-swing, then a big straight-leg strike
      P.s(J.thigh, true, 0.75 * wind - 1.45 * strike, 0, -0.05 * strike).s(J.shin, true, 1.5 * wind + 0.1 * strike, 0, 0).s(J.foot, true, 0.4 * strike, 0, 0);
      // support leg bends
      P.s(J.thigh, false, -0.25 * (wind + strike), 0, 0.05).s(J.shin, false, 0.45 * (wind + strike), 0, 0);
      P.c(J.hips, 0, -0.3 * strike + 0.15 * wind, 0).c(J.spine, -0.12 * strike + 0.1 * wind, 0.15 * strike, 0).c(J.chest, -0.1 * strike, 0.1 * strike, 0);
      // arms for balance: left out & forward, right back
      P.s(J.arm, false, -0.5 * strike, 0, 0.75 * (wind + strike)).s(J.arm, true, 0.7 * strike - 0.4 * wind, 0, 0.45 * (wind + strike));
      P.c(J.head, 0.25 * (wind + strike), 0, 0);
      f.browY += 0.004 * strike; f.lidU += 0.24 * wind;
    },
  },
  pickup: {
    dur: 0.5, fadeIn: 0.07, fadeOut: 0.16, legs: 1, legsMoving: 0.15,
    pose(P, u, _t, f, mv) {
      const bend = win(u, 0, 0.35, 0.5, 0.85), stash = win(u, 0.5, 0.7, 0.8, 1);
      // on the run the legs keep striding: a deeper waist bend and a longer reach make it a scoop
      P.c(J.spine, (0.38 + 0.2 * mv) * bend, 0, 0.1 * mv * bend).c(J.chest, (0.22 + 0.12 * mv) * bend, -0.15 * bend, 0).c(J.neck, -0.05 * bend, 0, 0).c(J.head, -(0.05 + 0.25 * mv) * bend, 0, 0);
      P.both(J.thigh, -0.95 * bend, 0, 0).both(J.shin, 1.5 * bend, 0, 0).both(J.foot, -0.5 * bend, 0, 0);
      // right hand reaches down & forward, grabs, then stashes into the satchel
      P.s(J.arm, true, -(1.0 + 0.2 * mv) * bend + 0.45 * stash, 0, (0.12 + 0.15 * mv) * bend + 0.1 * stash).s(J.fore, true, (0.25 + 0.15 * mv) * bend - 0.7 * stash, 0, 0);
      hand(P, true, 0.95 * wave(u, 0.28, 0.4) - 0.25 * bend * (1 - wave(u, 0.28, 0.4)));
      P.s(J.arm, false, -0.35 * bend, 0, 0.3 * bend);
      f.lookY += 0.35 * bend;
    },
  },
  deposit: {
    dur: 0.62, fadeIn: 0.06, fadeOut: 0.2, legs: 1, legsMoving: 0,
    pose(P, u, _t, f) {
      const reach = win(u, 0, 0.22, 0.3, 0.45), toss = win(u, 0.35, 0.55, 0.65, 1);
      P.s(J.arm, true, 0.5 * reach - 2.0 * toss, 0, 0.12 * reach + 0.1 * toss).s(J.fore, true, -0.7 * reach + 0.35 * toss, 0, 0);
      hand(P, true, 0.9 * reach + 0.2 * toss * (1 - wave(u, 0.55, 0.62)));
      P.c(J.spine, 0.1 * reach - 0.05 * toss, 0.2 * reach - 0.25 * toss, 0).c(J.chest, -0.1 * toss, -0.2 * toss, 0);
      P.s(J.arm, false, 0.4 * toss, 0, 0.35 * toss);
      P.c(J.head, -0.12 * toss, 0, 0);
      f.browY += 0.004 * toss;
    },
  },
  hit: {
    dur: 0.6, fadeIn: 0.03, fadeOut: 0.25, legs: 1, legsMoving: 0,
    pose(P, u, _t, f) {
      const k = win(u, 0, 0.12, 0.35, 1);
      P.c(J.spine, -0.35 * k, 0, 0.1 * k).c(J.chest, -0.3 * k, 0, 0).c(J.neck, -0.2 * k, 0, 0).c(J.head, -0.3 * k, 0, 0.15 * k);
      P.both(J.arm, -1.3 * k, 0, 0.55 * k).both(J.fore, -0.5 * k, 0, 0);
      hand(P, false, -0.3 * k); hand(P, true, -0.3 * k);
      P.s(J.thigh, false, -0.6 * k, 0, 0.1 * k).s(J.shin, false, 0.8 * k, 0, 0).s(J.thigh, true, -0.2 * k, 0, 0);
      f.lidU += 0.98 * k; f.lidL += 0.6 * k; f.browY += 0.006 * k; f.browTilt -= 0.25 * k;
    },
  },
  victory: {
    dur: 1.35, fadeIn: 0.08, fadeOut: 0.25, legs: 1, legsMoving: 0,
    pose(P, u, t, f) {
      const crouch = win(u, 0, 0.12, 0.14, 0.24), hop = win(u, 0.18, 0.3, 0.42, 0.56), pump = win(u, 0.3, 0.42, 0.85, 1);
      P.pos(J.hips, 0, -0.06 * crouch + 0.2 * hop, 0);
      P.both(J.thigh, -0.6 * crouch - 0.5 * hop, 0, 0).both(J.shin, 1.0 * crouch + 0.9 * hop, 0, 0);
      // right fist pumps above the head, twice
      const beat = 0.5 + 0.5 * Math.cos(Math.max(0, u - 0.42) * TAU * 3.2);
      P.s(J.arm, true, -0.35 * pump, 0, 2.75 * pump - 0.25 * pump * beat).s(J.fore, true, -1.5 * pump * (0.45 + 0.55 * beat), 0, 0);
      hand(P, true, 1.0 * pump + 0.3 * (1 - pump));
      // left fist tucked, elbow bent (cheer)
      P.s(J.arm, false, -0.45 * pump, -0.5 * pump, 0.3 * pump).s(J.fore, false, -1.7 * pump, 0, 0);
      hand(P, false, 0.9 * pump + 0.3 * (1 - pump));
      P.c(J.spine, -0.1 * pump, 0, 0).c(J.chest, -0.08 * pump, 0.1 * Math.sin(t * 9) * pump, 0).c(J.head, -0.2 * pump, 0, 0.1 * pump);
      f.lidL += 0.55 * pump; f.browY += 0.008 * pump; f.browTilt -= 0.1 * pump;
    },
  },
  caught: {
    dur: 1.7, fadeIn: 0.1, fadeOut: 0.3, legs: 1, legsMoving: 0,
    pose(P, u, t, f) {
      const point = win(u, 0, 0.1, 0.28, 0.38), wag = win(u, 0.3, 0.42, 0.85, 1);
      // right arm: point forward, then raise the forearm and wag the index finger "tsk tsk"
      const w = Math.sin(t * TAU * 3.4);
      P.s(J.arm, true, -1.5 * point - 1.05 * wag, 0.2 * wag, 0.1 * point + 0.62 * wag);
      P.s(J.fore, true, 0.28 * point - 1.7 * wag, 0, 0.45 * w * wag);
      P.s(J.hand, true, 0, 0, 1.0 * wag); // wrist extended so the index stands upright while it wags
      hand(P, true, 1, 0, 1);
      // left fist on the hip
      const hip = point + wag;
      P.s(J.arm, false, 0.45 * hip, -0.5 * hip, 0.6 * hip).s(J.fore, false, -1.3 * hip, 0, 0.25 * hip);
      hand(P, false, 0.8 * (point + wag) + 0.3);
      P.c(J.spine, 0.08 * (point + wag), 0.1 * point, 0).c(J.head, 0.08 * wag, 0.18 * Math.sin(t * TAU * 1.7) * wag, 0.12 * (point + wag));
      // kindly stern: one brow down, the other raised, eyes slightly narrowed
      f.browTilt += 0.18 * (point + wag * (1 - wave(u, 0.8, 0.95))); f.browY += 0.002 * wag; f.lidU += 0.26 * (point + wag);
    },
  },
};

// ---------------------------------------------------------------------------------------------

export interface AnimOutputs {
  /** squash/stretch scale for the rig group (y) — x/z preserve volume */
  squash: number;
  leanX: number; // forward lean of the whole body (rad)
  leanZ: number; // roll into turns (rad)
  flash: number; // hit flash 0..1
  earSpread: number; // extra outward ear spread (e.g. the chéchia pushes the ears apart)
}

export class Animator {
  readonly out: AnimOutputs = { squash: 1, leanX: 0, leanZ: 0, flash: 0, earSpread: 0 };
  private readonly rig: Rig;
  private readonly base = new Pose();
  private readonly tmp = new Pose();
  private readonly act = new Pose();
  private readonly act2 = new Pose();
  private readonly face: Face = { browY: 0, browTilt: 0, lidU: 0, lidL: 0, lookX: 0, lookY: 0 };
  private readonly faceTmp: Face = { browY: 0, browTilt: 0, lidU: 0, lidL: 0, lookX: 0, lookY: 0 };

  private t = 0;
  private phase = 0;
  private walkW = 0; private runW = 0; private airW = 0; private stunW = 0; private rising = 0;
  private idleTime = 0;
  // actions: current + fading previous
  private cur: { def: ActionDef; t: number } | null = null;
  private prev: { def: ActionDef; t: number; w: number } | null = null;
  // look-around & blinks
  private lookTarget = new Vector3();
  private look = new Vector3();
  private lookV = new Vector3();
  private nextLook = 2.5;
  private nextBlink = 2;
  private blinkT = -1;
  private doubleBlink = false;
  private nextTwitch = 2.5;
  // secondary motion
  private readonly earS = [0, 1, 2, 3].map(() => [new Spring(110, 9), new Spring(55, 5.5)]); // [L pitch, L roll, R pitch, R roll] × [base, tip]
  private readonly tailS = J.tail.map(() => [new Spring(60, 6), new Spring(60, 6)]); // [pitch, yaw]
  private readonly bagS = [new Spring(70, 5), new Spring(70, 5)];
  private readonly squashS = new Spring(260, 16);
  private lean = new Spring(40, 12);
  private leanF = new Spring(40, 12);
  // world-space tracking of the head/hips for inertial forces
  private readonly prevHead = new Vector3();
  private readonly headVel = new Vector3();
  private readonly headAcc = new Vector3();
  private readonly prevHips = new Vector3();
  private readonly hipsVel = new Vector3();
  private readonly hipsAcc = new Vector3();
  private tracking = false;
  private flash = 0;
  private readonly e = new Euler();
  private readonly q = new Quaternion();
  private readonly v = new Vector3();
  private readonly v2 = new Vector3();
  private readonly invRoot = new Quaternion();

  constructor(rig: Rig) {
    this.rig = rig;
  }

  trigger(a: AvatarAction): void {
    if (a === 'jump') {
      this.squashS.kick(3.2); // stretch on take-off
      return;
    }
    if (a === 'land') {
      this.squashS.kick(-4.5);
      this.landT = 0;
      return;
    }
    const def = ACTIONS[a];
    if (!def) return;
    if (this.cur) this.prev = { def: this.cur.def, t: this.cur.t, w: this.weightOf(this.cur) };
    this.cur = { def, t: 0 };
    if (a === 'hit') { this.flash = 1; for (const s of this.earS) s[0].kick(9); }
    if (a === 'victory') { for (const s of this.tailS) s[1].kick(4); }
  }
  private landT = 10;

  private weightOf(a: { def: ActionDef; t: number }): number {
    const { dur, fadeIn, fadeOut } = a.def;
    return clamp(a.t / fadeIn, 0, 1) * clamp((dur - a.t) / fadeOut, 0, 1);
  }

  /** Must be called once per frame; `root` is the avatar root (for inertial forces). */
  update(dt: number, m: AvatarMotion, root: Object3D): void {
    dt = Math.min(dt, 1 / 20);
    this.t += dt;
    const t = this.t;

    // --- state weights
    const stun = m.state === 'stun';
    // no running legs mid-air, and a stunned (knocked-back) Labib slides rather than jogs
    const speed = (m.grounded ? m.speed : m.speed * 0.3) * (stun ? 0.25 : 1);
    this.walkW += (smoothstep(speed, 0.05, 0.9) - this.walkW) * (1 - Math.exp(-10 * dt));
    this.runW += (smoothstep(speed, 1.6, 4.8) - this.runW) * (1 - Math.exp(-8 * dt));
    this.airW += ((m.grounded ? 0 : 1) - this.airW) * (1 - Math.exp(-(m.grounded ? 22 : 10) * dt));
    this.rising += ((m.verticalVelocity > 0.5 ? 1 : 0) - this.rising) * (1 - Math.exp(-9 * dt));
    this.stunW += ((stun ? 1 : 0) - this.stunW) * (1 - Math.exp(-(stun ? 12 : 5) * dt));
    this.idleTime = speed < 0.2 && m.grounded ? this.idleTime + dt : 0;

    // --- locomotion phase (cycles per second tied to speed so feet don't skate)
    const stride = lerp(0.85, 2.1, this.runW) + Math.max(0, m.speed - 6.5) * 0.12;
    this.phase = (this.phase + (Math.max(speed, 0.0) / stride) * dt) % 1;
    const ph = this.phase;

    const P = this.base.clear();
    const F = this.face;
    F.browY = F.browTilt = F.lidU = F.lidL = F.lookX = F.lookY = 0;
    stance(P);

    // idle (always partly present: breathing, weight shift)
    const idleW = 1 - this.walkW;
    const br = Math.sin(t * TAU / 3.4);
    P.c(J.chest, 0.025 * br, 0, 0).c(J.spine, 0.01 * br, 0, 0).both(J.clav, 0, 0, 0.03 * br);
    // relaxed contrapposto: weight on the left leg, right knee soft, slow sway between them
    const sway = 0.6 + 0.4 * Math.sin(t * 0.5);
    const cp = idleW * sway;
    P.c(J.hips, 0, 0.05 * cp + 0.03 * Math.sin(t * 0.45) * idleW, 0.06 * cp).pos(J.hips, 0.016 * cp, 0, 0);
    P.s(J.thigh, false, 0, 0.1, -0.06 * cp + 0.03 * idleW).s(J.thigh, true, -0.12 * cp, 0.1, 0.03 * cp + 0.04 * idleW);
    P.s(J.shin, true, 0.26 * cp, 0, 0).s(J.foot, true, -0.08 * cp, 0, 0);
    P.c(J.spine, 0, -0.03 * cp, -0.055 * cp).c(J.chest, 0, -0.02 * cp, -0.02 * cp).c(J.head, 0, 0.03 * cp, 0.06 * cp);
    P.both(J.fore, -0.12 * idleW, 0, 0).s(J.arm, true, -0.05 * cp, 0, 0.04 * cp);

    // walk / run cycle
    if (this.walkW > 0.001) this.locomotion(P, ph, this.walkW, this.runW);

    // air: jump (rising) / fall
    if (this.airW > 0.001) {
      const A = this.tmp.clear();
      const up = this.rising, down = 1 - up;
      A.both(J.thigh, -0.75 * up - 0.3 * down, 0, 0.05).both(J.shin, 1.25 * up + 0.45 * down, 0, 0).both(J.foot, 0.3, 0, 0);
      A.both(J.arm, -0.6 * up, 0, 0.6 * up + 1.1 * down).both(J.fore, -0.7 * up - 0.25 * down, 0, 0);
      const flail = Math.sin(t * 15) * down;
      A.s(J.arm, false, 0.25 * flail, 0, 0.15 * flail).s(J.arm, true, -0.25 * flail, 0, 0.15 * flail);
      A.s(J.thigh, false, 0.2 * flail, 0, 0).s(J.thigh, true, -0.2 * flail, 0, 0);
      A.c(J.spine, -0.1 * up + 0.08 * down, 0, 0).c(J.head, -0.12 * up + 0.2 * down, 0, 0);
      hand(A, false, 0.1 * down - 0.2 * up); hand(A, true, 0.1 * down - 0.2 * up);
      P.addScaled(A, this.airW);
      F.browY += 0.006 * down * this.airW; F.lidU -= 0.12 * down * this.airW; F.lookY += 0.3 * down * this.airW;
    }

    // landing squash pose (knees absorb)
    this.landT += dt;
    const land = win(this.landT, 0, 0.05, 0.08, 0.32) * (1 - this.airW);
    if (land > 0) P.both(J.thigh, -0.5 * land, 0, 0).both(J.shin, 0.9 * land, 0, 0).c(J.spine, 0.2 * land, 0, 0).both(J.arm, -0.2 * land, 0, 0.35 * land);

    // stun: dizzy wobble
    if (this.stunW > 0.001) {
      const S = this.tmp.clear(), s = this.stunW, w = t * 5.5;
      S.c(J.head, 0.2 * Math.cos(w), 0.12 * Math.sin(w * 0.5), 0.28 * Math.sin(w)).c(J.neck, 0.1 * Math.cos(w + 1), 0, 0.1 * Math.sin(w + 1));
      S.c(J.spine, 0.12 + 0.06 * Math.cos(w * 0.5), 0, 0.12 * Math.sin(w * 0.5)).c(J.chest, 0.06, 0, 0.08 * Math.sin(w * 0.5 + 0.8));
      S.both(J.arm, 0.1, 0, -0.1).both(J.fore, 0.15, 0, 0);
      S.s(J.arm, false, 0.2 * Math.sin(w * 0.5), 0, 0).s(J.arm, true, -0.2 * Math.sin(w * 0.5), 0, 0);
      S.both(J.thigh, -0.25, 0, 0).both(J.shin, 0.4, 0, 0);
      S.s(J.thigh, false, 0, 0, 0.1 * Math.sin(w * 0.5)).s(J.thigh, true, 0, 0, -0.1 * Math.sin(w * 0.5));
      hand(S, false, -0.2); hand(S, true, -0.2);
      P.addScaled(S, s);
      // eyes roll in circles (opposite directions), half-closed lids
      F.lidU += 0.52 * s; F.browTilt -= 0.3 * s; F.browY += 0.004 * s;
    }

    // one-shot actions (crossfade current over previous)
    this.applyActions(P, F, dt);

    // idle life: look around, fidget with ears
    this.idleLife(P, F, dt, m);

    this.secondary(P, dt, m, root);
    this.blinks(F, dt);
    this.applyFace(P, F, t);

    // whole-body lean (turns + acceleration) and squash
    const lean = clamp(-m.turnRate * m.speed * 0.022, -0.32, 0.32) * (m.grounded ? 1 : 0.4);
    this.out.leanZ = this.lean.step(lean, dt);
    this.out.leanX = this.leanF.step(0.07 * this.runW + clamp(this.hipsAccLocalZ * 0.006, -0.1, 0.12), dt);
    const stretch = m.grounded ? 0 : clamp(m.verticalVelocity * 0.012, -0.05, 0.1);
    this.out.squash = 1 + this.squashS.step(stretch, dt);
    this.flash = Math.max(0, this.flash - dt * 4.5);
    this.out.flash = this.flash * this.flash;

    this.groundLock(P);
    this.write(P);
  }

  private hipsAccLocalZ = 0;

  private locomotion(P: Pose, ph: number, walkW: number, runW: number): void {
    const L = this.tmp.clear();
    const walk = 1 - runW;
    for (let side = 0; side < 2; side++) {
      const right = side === 1;
      const p = (ph + (right ? 0.5 : 0)) % 1;
      const c = Math.cos(p * TAU), sn = Math.sin(p * TAU);
      // thigh: forward at p=0, back at 0.5
      const thighW = -0.42 * c;
      const thighR = -0.25 - 0.85 * c;
      // knee: small in stance, big fold in swing
      const swing = p > 0.5 ? Math.sin(((p - 0.5) / 0.5) * Math.PI) : 0;
      const kneeW = 0.1 + 0.95 * Math.pow(Math.max(0, Math.sin(((p - 0.5) / 0.45) * Math.PI)), 1.3) * (p > 0.5 && p < 0.95 ? 1 : 0);
      const kneeR = 0.35 + 1.75 * Math.pow(swing, 0.9) + 0.25 * Math.max(0, sn);
      const toeOff = win(p, 0.4, 0.5, 0.55, 0.7);
      L.s(J.thigh, right, lerp(thighW, thighR, runW), 0, 0.03);
      L.s(J.shin, right, lerp(kneeW, kneeR, runW), 0, 0);
      L.s(J.foot, right, lerp(0.35, 0.6, runW) * toeOff - 0.15 * win(p, 0.85, 0.95, 1.0, 1.01), 0, 0);
      // arms swing opposite to the legs; bent & pumping when running
      const armSwing = lerp(0.42, 0.95, runW) * c; // + = back
      L.s(J.arm, right, armSwing, 0, lerp(0.05, 0.14, runW));
      L.s(J.fore, right, lerp(-0.2, -1.4, runW) + lerp(0, 0.35, runW) * c, 0, 0);
      hand(L, right, lerp(0.35, 0.9, runW));
    }
    const c2 = Math.cos(ph * TAU), s2 = Math.sin(ph * TAU * 2);
    L.c(J.hips, 0, 0.14 * c2 * lerp(1, 0.7, runW), 0.05 * Math.sin(ph * TAU) * walk);
    L.c(J.spine, lerp(0.04, 0.22, runW), -0.08 * c2, 0).c(J.chest, lerp(0.02, 0.08, runW), -0.1 * c2, 0);
    L.c(J.neck, -lerp(0.02, 0.12, runW), 0.04 * c2, 0).c(J.head, -lerp(0.03, 0.16, runW) + 0.03 * s2, 0.04 * c2, 0);
    // running bounce (flight phase just after each push-off)
    L.pos(J.hips, 0, runW * 0.045 * Math.max(0, Math.sin(ph * TAU * 2 - 0.9)), 0);
    L.both(J.clav, 0, 0, -0.03 * runW);
    P.addScaled(L, walkW);
  }

  private runAction(a: { def: ActionDef; t: number }, target: Pose, face: Face, w: number, P: Pose, F: Face): void {
    target.clear();
    face.browY = face.browTilt = face.lidU = face.lidL = face.lookX = face.lookY = 0;
    stance(target);
    const mv = this.walkW;
    a.def.pose(target, clamp(a.t / a.def.dur, 0, 1), a.t, face, mv);
    // actions replace the base pose (legs only when standing); breathing/secondary motion are layered on afterwards
    P.layerTo(target, w, w * lerp(a.def.legs, a.def.legsMoving, mv), mv);
    F.browY += face.browY * w; F.browTilt += face.browTilt * w; F.lidU += face.lidU * w; F.lidL += face.lidL * w;
    F.lookX += face.lookX * w; F.lookY += face.lookY * w;
  }

  private rate(d: ActionDef): number {
    return lerp(1, d.runRate ?? 1, this.runW);
  }

  private applyActions(P: Pose, F: Face, dt: number): void {
    if (this.prev) {
      this.prev.t += dt * this.rate(this.prev.def);
      this.prev.w -= dt / 0.15;
      if (this.prev.w <= 0 || this.prev.t >= this.prev.def.dur) this.prev = null;
      else this.runAction(this.prev, this.act2, this.faceTmp, this.prev.w * (this.cur ? 1 - this.weightOf(this.cur) : 1), P, F);
    }
    if (this.cur) {
      this.cur.t += dt * this.rate(this.cur.def);
      if (this.cur.t >= this.cur.def.dur) this.cur = null;
      else this.runAction(this.cur, this.act, this.faceTmp, this.weightOf(this.cur), P, F);
    }
  }

  private idleLife(P: Pose, F: Face, dt: number, m: AvatarMotion): void {
    // glance targets: eyes lead, head follows
    this.nextLook -= dt;
    if (this.nextLook <= 0) {
      const calm = this.idleTime > 1;
      this.lookTarget.set((rand() * 2 - 1) * (calm ? 0.55 : 0.2), (rand() * 2 - 1) * (calm ? 0.18 : 0.06) - 0.03, 0);
      if (rand() < 0.3) this.lookTarget.set(0, 0, 0);
      this.nextLook = 1.2 + rand() * 3.2;
      this.saccade = 1;
    }
    const target = this.v.copy(this.lookTarget).multiplyScalar(1 - this.walkW * 0.6);
    // critically damped follow
    const kk = 24, cc = 2 * Math.sqrt(kk);
    this.lookV.addScaledVector(this.v2.copy(target).sub(this.look).multiplyScalar(kk).addScaledVector(this.lookV, -cc), dt);
    this.look.addScaledVector(this.lookV, dt);
    const yaw = this.look.x, pitch = this.look.y;
    const actionDamp = 1 - (this.cur ? this.weightOf(this.cur) : 0) * 0.8;
    P.c(J.neck, pitch * 0.3 * actionDamp, yaw * 0.35 * actionDamp, 0).c(J.head, pitch * 0.6 * actionDamp, yaw * 0.55 * actionDamp, -yaw * 0.12 * actionDamp);
    // the eyes lead the head
    this.saccade = Math.max(0, this.saccade - dt * 4);
    F.lookX += (target.x - yaw) * 0.9 + yaw * 0.15;
    F.lookY += (target.y - pitch) * 0.9;
    // random ear twitches
    this.nextTwitch -= dt;
    if (this.nextTwitch <= 0) {
      const i = rand() < 0.5 ? 0 : 2;
      this.earS[i][0].kick((rand() * 2 - 1) * 5);
      this.earS[i + 1][0].kick(-3 - rand() * 3);
      this.nextTwitch = (m.speed < 0.3 ? 1.5 : 3) + rand() * 3.5;
    }
  }
  private saccade = 0;

  private blinks(F: Face, dt: number): void {
    this.nextBlink -= dt;
    if (this.nextBlink <= 0 && this.blinkT < 0) {
      this.blinkT = 0;
      this.doubleBlink = rand() < 0.2;
      this.nextBlink = 2 + rand() * 3.5;
    }
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      const d = 0.17;
      let b = win(this.blinkT, 0, 0.06, 0.08, d);
      if (this.doubleBlink) b = Math.max(b, win(this.blinkT, d + 0.05, d + 0.11, d + 0.13, 2 * d + 0.05));
      F.lidU += b * 1.66;
      F.lidL += b * 0.4;
      if (this.blinkT > (this.doubleBlink ? 2 * d + 0.06 : d)) this.blinkT = -1;
    }
  }

  private applyFace(P: Pose, F: Face, t: number): void {
    const stun = this.stunW;
    const ex = clamp(F.lookX, -0.5, 0.5), ey = clamp(F.lookY, -0.4, 0.4);
    const spin = t * 9;
    // eyes (slight convergence), dizzy circles when stunned
    // (the lid aperture faces outward, rig.EYE_FWD; the pupils converge back toward the front)
    P.s(J.eye, false, ey + 0.3 * stun * Math.sin(spin), ex - 0.14 + 0.35 * stun * Math.cos(spin), 0);
    P.s(J.eye, true, ey + 0.3 * stun * Math.sin(-spin + 1), -ex - 0.14 + 0.35 * stun * Math.cos(-spin + 1), 0);
    // upper lids follow the eye pitch; lower lids rise a little when looking up / smiling
    const lu = clamp(F.lidU + ey * 0.5, -0.3, 1.72);
    const ll = clamp(F.lidL - ey * 0.25, -0.2, 0.6);
    P.both(J.lidU, lu, 0, 0).both(J.lidL, -ll, 0, 0);
    // brows: raise (y) and tilt (z: + = stern/inner down)
    P.pos(J.brow, 0, F.browY, F.browY * 0.2).pos(J.browR, 0, F.browY, F.browY * 0.2);
    P.both(J.brow, 0, 0, F.browTilt);
    // nose sniff when looking around quickly
    P.c(J.nose, 0.04 * Math.sin(t * 17) * this.saccade, 0, 0);
  }

  /** World-space finite differences of a bone → low-passed acceleration in the avatar frame. */
  private track(b: Object3D, prev: Vector3, vel: Vector3, acc: Vector3, dt: number): void {
    const e = b.matrixWorld.elements;
    this.v.set(e[12], e[13], e[14]);
    if (!this.tracking) { prev.copy(this.v); vel.set(0, 0, 0); acc.set(0, 0, 0); return; }
    this.v2.copy(this.v).sub(prev).divideScalar(Math.max(dt, 1e-3));
    prev.copy(this.v);
    this.v.copy(this.v2).sub(vel).divideScalar(Math.max(dt, 1e-3)).applyQuaternion(this.invRoot);
    vel.copy(this.v2);
    acc.lerp(this.v.clampLength(0, 120), 1 - Math.exp(-dt * 18));
  }

  /** Ears, tail and bag springs, driven by the head/hips world accelerations (local frame). */
  private secondary(P: Pose, dt: number, m: AvatarMotion, root: Object3D): void {
    const head = this.rig.bones[J.head], hips = this.rig.bones[J.hips];
    this.invRoot.copy(root.quaternion).invert();
    this.track(head, this.prevHead, this.headVel, this.headAcc, dt);
    this.track(hips, this.prevHips, this.hipsVel, this.hipsAcc, dt);
    this.tracking = true;
    this.hipsAccLocalZ = this.hipsAcc.z;

    const sub = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / sub;
    const a = this.headAcc;
    const run = this.runW;
    const speedLocal = m.speed;
    // ears: pitch (+ forward) and roll (+ inward) per side, LEFT semantics
    for (let side = 0; side < 2; side++) {
      const sx = side === 0 ? 1 : -1;
      // at speed the ears sweep back only a little and splay outward, so they stay big & pointed from behind
      const pitchT = clamp(-0.008 * a.z - 0.003 * a.y, -0.5, 0.5) - 0.22 * run - 0.02 * speedLocal * (1 - run);
      const rollT = clamp(0.008 * a.x * sx - 0.006 * Math.max(0, a.y) + 0.003 * Math.max(0, -a.y), -0.5, 0.4) - 0.5 * this.stunW - this.out.earSpread - 0.16 * run;
      const s = this.earS[side * 2], r = this.earS[side * 2 + 1];
      for (let i = 0; i < sub; i++) {
        s[0].step(pitchT, h); s[1].step(s[0].x * 0.9, h);
        r[0].step(rollT, h); r[1].step(r[0].x * 0.9, h);
      }
      s[0].x = clamp(s[0].x, -0.9, 0.9); s[1].x = clamp(s[1].x, -0.9, 0.9);
      r[0].x = clamp(r[0].x, -0.9, 0.7); r[1].x = clamp(r[1].x, -0.9, 0.7);
      const right = side === 1;
      const flap = 0.04 * Math.sin(this.t * 3 + side * 1.7) * (1 - this.walkW);
      P.s(J.ear, right, s[0].x * 0.5, 0, r[0].x * 0.5 + flap);
      P.s(J.ear2, right, s[1].x * 0.4 + 0.25 * s[0].x, 0, r[1].x * 0.35);
      P.s(J.ear3, right, s[1].x * 0.35, 0, r[1].x * 0.3);
    }
    // tail: sways at idle, streams when running, lags behind turns and bounces
    const ha = this.hipsAcc;
    for (let i = 0; i < J.tail.length; i++) {
      const [sp, sy] = this.tailS[i];
      const lagPh = this.t * 1.1 - i * 0.55;
      const idleSway = 0.13 * Math.sin(lagPh) * (1 - run);
      const runWag = 0.08 * Math.sin(this.phase * TAU * 2 - i * 0.7) * run;
      // the hanging tail lifts into a streaming brush with speed (and droops further when stunned)
      const lift = i === 0 ? 0.26 * this.walkW + 0.44 * run - 0.12 * this.stunW : i < 3 ? 0.08 * run : 0.03 * run;
      const pitchT = lift - 0.0035 * ha.y + 0.002 * ha.z;
      const yawT = idleSway + runWag + 0.004 * ha.x - (this.cur?.def === ACTIONS.victory ? 0.35 * Math.sin(this.t * 16) : 0);
      for (let s = 0; s < sub; s++) {
        sp.step(pitchT + (i > 0 ? this.tailS[i - 1][0].x * 0.35 : 0), h);
        sy.step(yawT + (i > 0 ? this.tailS[i - 1][1].x * 0.5 : 0), h);
      }
      P.c(J.tail[i], sp.x, sy.x, 0);
    }
    // satchel pendulum
    for (let s = 0; s < sub; s++) {
      this.bagS[0].step(clamp(-0.004 * ha.z, -0.4, 0.4), h);
      this.bagS[1].step(clamp(0.004 * ha.x - 0.002 * ha.y, -0.4, 0.4), h);
    }
    P.c(J.bag, this.bagS[0].x, 0, this.bagS[1].x);
  }

  /** Keeps the lower foot on the ground when grounded: hips drop by the legs' lost vertical reach. */
  private groundLock(P: Pose): void {
    const r = P.r;
    const hipX = r[J.hips * 3];
    let reach = 0;
    for (let side = 0; side < 2; side++) {
      const right = side === 1;
      const th = right ? MIRROR[J.thigh] : J.thigh, sh = right ? MIRROR[J.shin] : J.shin;
      const a1 = hipX + r[th * 3], a2 = a1 + r[sh * 3];
      const ab = r[th * 3 + 2];
      reach = Math.max(reach, (THIGH * Math.cos(a1) + SHIN * Math.cos(a2)) * Math.cos(ab));
      // keep the stance sole flat-ish on the ground
      const ft = right ? MIRROR[J.foot] : J.foot;
      r[ft * 3] -= (a2 * 0.85) * (1 - this.airW);
    }
    const drop = (THIGH + SHIN - reach) * (1 - this.airW);
    P.p[J.hips * 3 + 1] -= drop;
  }

  private write(P: Pose): void {
    const { bones, restQuat, restPos } = this.rig;
    for (let i = 0; i < NB; i++) {
      const b = bones[i];
      this.e.set(P.r[i * 3], P.r[i * 3 + 1], P.r[i * 3 + 2], 'XYZ');
      b.quaternion.copy(restQuat[i]).multiply(this.q.setFromEuler(this.e));
      b.position.set(restPos[i].x + P.p[i * 3], restPos[i].y + P.p[i * 3 + 1], restPos[i].z + P.p[i * 3 + 2]);
    }
  }
}
