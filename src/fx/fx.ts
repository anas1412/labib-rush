// Pooled GPU particles (Fx contract, src/core/types.ts). Three instanced-quad pools, one draw call
// each: `glow` (additive HDR sparkles, rings, streaks — feeds bloom), `soft` (alpha-blended lit dust
// puffs) and `solid` (lit cut-out confetti, leaves and scraps that write depth, so no sorting).
// Particles are written once into a ring buffer at burst time; the vertex shader evaluates their
// whole life from that spawn data (see material.ts), including the wind felt at spawn. Per frame the
// CPU only advances a clock and uploads the ring slots written since the last frame: no allocations,
// no per-particle work.
//
// Burst anchors (`position`): litter item (sparkle, goldSparkle), ground under the feet (dust,
// confetti, spill, hit), power-up base (powerup), bin base (deposit — swirls into the rim),
// a canopy point (leaves), Labib's feet with `direction` = travel direction (speedLines).
import {
  BufferAttribute, Color, DynamicDrawUsage, Group, InstancedBufferGeometry, InstancedInterleavedBuffer,
  InterleavedBufferAttribute, Mesh, Vector3, type ShaderMaterial,
} from 'three';
import { LIGHTING } from '../core/config';
import { CURB } from '../core/layout';
import type { BuildContext, Fx, FxKind, Quality } from '../core/types';
import { createAtlas, SHAPE } from './atlas';
import { createParticleMaterial, type ParticleUniforms, type PoolKind } from './material';

const STRIDE = 34; // floats per particle (8 × vec4 + vec2)
const CAPACITY: Record<PoolKind, number> = { glow: 1300, soft: 300, solid: 1400 }; // 3000 live max
const QUALITY_COUNT: Record<Quality, number> = { low: 0.5, medium: 0.75, high: 1, ultra: 1 };
const CULL_DIST = 90; // bursts farther than this from the camera are skipped
const BIN_RIM = 1.045; // props/bin.ts OPENING_Y (BinModel.openingHeight), not exported by props

// linear-light scale for the lit pools, matched by eye to the engine's sun (7.5) + sky IBL (0.85)
const SUN_RADIANCE = 2.2;
const SKY = [0.36, 0.42, 0.52] as const;

/** Default counts (scaled by quality). An explicit `opts.count` is used as is. */
const DEFAULT_COUNT: Record<FxKind, number> = {
  sparkle: 16, goldSparkle: 30, dust: 7, confetti: 160, spill: 16, powerup: 24, hit: 7, deposit: 20, leaves: 8, speedLines: 4,
};

const SPARKLE = 0xffdf8f, SPARKLE_STAR = 0xffc21a; // pickup: pale gold glow, saturated gold stars
const GOLD_CORE = 0xffe7a0;
const DUST = 0xd2c09c; // a touch darker and warmer than the paving, so puffs read on it
const CONFETTI = [0xe70013, 0xe70013, 0xe70013, 0xffffff, 0xffffff, 0xffffff, 0xf5c542, 0x3ddc97, 0x1e7be0] as const; // Tunisian red/white first
const SCRAPS = [0xc8102e, 0xc4cad0, 0x58b0c8, 0xf2b705, 0xe9e2d0, 0x6fae3b] as const; // can, foil, bottle, chips, paper, glass
const LEAVES = [0x3d6b28, 0x4f7d2e, 0x2f5a22, 0x5a8a34, 0x9c9a3c] as const; // ficus greens + one yellowed

const MOTION_DRAG = 0, MOTION_SWIRL = 1;
const BILLBOARD = 0, STREAK = 4, FLAT = 8, TUMBLE = 12; // orient × 4
const NO_GROUND = -1e4;

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const sgn = () => (Math.random() < 0.5 ? -1 : 1);
const pickOf = <T>(l: readonly T[]) => l[(Math.random() * l.length) | 0];

/** Mutable particle spec reused for every spawn. Field order = the GPU layout (material.ts). */
class Spec {
  readonly f = new Float32Array(STRIDE);
  /** The shared wind (xz m/s, y gustiness), read at spawn time only. */
  constructor(private readonly wind: { value: Vector3 }) {}
  reset(): this { this.f.fill(0); this.f[27] = NO_GROUND; return this; }
  pos(x: number, y: number, z: number, birth: number): this { const f = this.f; f[0] = x; f[1] = y; f[2] = z; f[3] = birth; return this; }
  vel(x: number, y: number, z: number, life: number): this { const f = this.f; f[4] = x; f[5] = y; f[6] = z; f[7] = life; return this; }
  size(s0: number, s1: number, rot = Math.random() * 6.283, spin = 0): this { const f = this.f; f[8] = s0; f[9] = s1; f[10] = rot; f[11] = spin; return this; }
  c0(c: Color, k: number, a: number): this { const f = this.f; f[12] = c.r * k; f[13] = c.g * k; f[14] = c.b * k; f[15] = a; return this; }
  c1(c: Color, k: number, a: number): this { const f = this.f; f[16] = c.r * k; f[17] = c.g * k; f[18] = c.b * k; f[19] = a; return this; }
  /** `wind` = how strongly the piece follows the current wind (each piece gets its own gust). */
  phys(drag: number, grav: number, wind: number, mode: number): this {
    const f = this.f, w = this.wind.value;
    f[20] = drag; f[21] = grav; f[23] = mode;
    if (wind > 0) { const g = wind * (1 + w.y * rnd(-0.5, 0.5)); f[32] = w.x * g; f[33] = w.z * g; }
    return this;
  }
  /** Lit pools: 1 = unlit, keeps its colour (reward stars that must read on bright paving). */
  emit(e: number): this { this.f[22] = e; return this; }
  axis(x: number, y: number, z: number): this { const f = this.f; f[24] = x; f[25] = y; f[26] = z; return this; }
  ground(y: number): this { this.f[27] = y; return this; }
  extra(sway: number, swayRate: number, param: number, shape: number): this { const f = this.f; f[28] = sway; f[29] = swayRate; f[30] = param; f[31] = shape; return this; }
}

class Pool {
  readonly mesh: Mesh;
  deadAt = 0;
  private readonly data: Float32Array;
  private readonly buf: InstancedInterleavedBuffer;
  private readonly geo: InstancedBufferGeometry;
  private head = 0;
  private dirtyStart = 0;
  private dirtyCount = 0;
  // reused update-range records (three reads then clears `updateRanges` on upload)
  private readonly ranges = [{ start: 0, count: 0 }, { start: 0, count: 0 }];

  constructor(readonly capacity: number, material: ShaderMaterial, renderOrder: number) {
    const geo = new InstancedBufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.data = new Float32Array(capacity * STRIDE); // all zero = born at 0 with life 0 = dead
    this.buf = new InstancedInterleavedBuffer(this.data, STRIDE, 1);
    this.buf.setUsage(DynamicDrawUsage);
    ['aA', 'aB', 'aC', 'aD', 'aE', 'aF', 'aG', 'aH'].forEach((n, i) => geo.setAttribute(n, new InterleavedBufferAttribute(this.buf, 4, i * 4)));
    geo.setAttribute('aI', new InterleavedBufferAttribute(this.buf, 2, 32));
    geo.instanceCount = 0;
    this.geo = geo;
    this.mesh = new Mesh(geo, material);
    this.mesh.frustumCulled = false; // positions live on the GPU
    this.mesh.renderOrder = renderOrder;
    this.mesh.visible = false;
    this.mesh.matrixAutoUpdate = false;
  }

  push(s: Spec): void {
    const i = this.head;
    this.data.set(s.f, i * STRIDE);
    this.head = i + 1 === this.capacity ? 0 : i + 1;
    if (i + 1 > this.geo.instanceCount) this.geo.instanceCount = i + 1;
    if (this.dirtyCount === 0) this.dirtyStart = i;
    if (this.dirtyCount < this.capacity) this.dirtyCount++;
    const end = s.f[3] + s.f[7];
    if (end > this.deadAt) this.deadAt = end;
  }

  /** Queue the slots written since the last frame for upload (≤ 2 ranges: the ring may wrap). */
  flush(): void {
    if (this.dirtyCount === 0) return;
    const { capacity: cap, dirtyStart: a, dirtyCount: n } = this;
    const r = this.buf.updateRanges;
    r.length = 0;
    if (a + n <= cap) {
      this.ranges[0].start = a * STRIDE; this.ranges[0].count = n * STRIDE;
      r.push(this.ranges[0]);
    } else {
      this.ranges[0].start = a * STRIDE; this.ranges[0].count = (cap - a) * STRIDE;
      this.ranges[1].start = 0; this.ranges[1].count = (a + n - cap) * STRIDE;
      r.push(this.ranges[0], this.ranges[1]);
    }
    this.buf.needsUpdate = true;
    this.dirtyCount = 0;
  }

  /** Kill everything at once. Slots below instanceCount are always rewritten before they are drawn
   *  again (the ring restarts at 0), so no upload is needed. */
  clear(): void {
    this.head = 0;
    this.geo.instanceCount = 0;
    this.dirtyCount = 0;
    this.deadAt = 0;
    this.mesh.visible = false;
  }

  dispose(): void { this.geo.dispose(); }
}

/** The Fx contract plus two integration helpers (candidates for the shared contract). */
export interface FxSystem extends Fx {
  /** Instantly removes every live particle (run restart). */
  clear(): void;
  /** Follow Engine.setQuality / autoDetect: default burst counts scale with it. */
  setQuality(q: Quality): void;
}

export function createFx(ctx: BuildContext): FxSystem {
  const root = new Group();
  root.name = 'fx';
  const atlas = createAtlas();
  const sunColor = new Color(LIGHTING.sunColor);
  const uniforms: ParticleUniforms = {
    uTime: { value: 0 },
    uAtlas: { value: atlas },
    uSunDir: { value: new Vector3(...LIGHTING.sunDirection).normalize() },
    uSun: { value: new Vector3(sunColor.r, sunColor.g, sunColor.b).multiplyScalar(SUN_RADIANCE) },
    uSky: { value: new Vector3(...SKY) },
  };
  const materials = { glow: createParticleMaterial('glow', uniforms), soft: createParticleMaterial('soft', uniforms), solid: createParticleMaterial('solid', uniforms) };
  const pools = {
    solid: new Pool(CAPACITY.solid, materials.solid, 0),
    soft: new Pool(CAPACITY.soft, materials.soft, 10),
    glow: new Pool(CAPACITY.glow, materials.glow, 11),
  };
  const poolList: readonly Pool[] = [pools.solid, pools.soft, pools.glow];
  for (const p of poolList) root.add(p.mesh);

  let time = 0;
  const camera = new Vector3(0, 1e6, 0); // until the first update: nothing is culled by distance
  let haveCamera = false;
  let countScale = QUALITY_COUNT[ctx.quality];
  const S = new Spec(ctx.uniforms.uWind);
  const col = new Color(), col2 = new Color(), white = new Color(1, 1, 1);
  const dir = new Vector3();
  const setCol = (c: Color, hex: number) => c.setHex(hex); // sRGB hex → linear working colour

  /** Short glow flash (colour `hex` fading to `hex1`); `ground` softens where it meets the floor. */
  const flash = (x: number, y: number, z: number, ground: number, hex: number, k: number, s0: number, s1: number, life: number, delay = 0, hex1 = hex) => {
    setCol(col, hex);
    setCol(col2, hex1);
    pools.glow.push(S.reset().pos(x, y, z, time + delay).vel(0, 0, 0, life).size(s0, s1).c0(col, k, 1).c1(col2, k * 0.4, 1).phys(0, 0, 0, MOTION_DRAG + BILLBOARD)
      .ground(ground).extra(0, 0, 0, SHAPE.glow));
  };

  /** Expanding ring lying flat at height y. */
  const ring = (x: number, y: number, z: number, hex: number, k: number, s0: number, s1: number, life: number, delay = 0) => {
    setCol(col, hex);
    pools.glow.push(S.reset().pos(x, y, z, time + delay).vel(0, 0, 0, life).size(s0, s1).c0(col, k, 1).c1(col, k * 0.35, 0)
      .phys(0, 0, 0, MOTION_DRAG + FLAT).extra(0, 0, 0, SHAPE.ring));
  };

  /** Unlit, alpha-blended cartoon stars popping up and out: unlike additive glows they stay
   *  readable on sunlit paving and against a bright sky. */
  const stars = (p: Vector3, y: number, n: number, sc: number, hex: number, delay = 0) => {
    setCol(col, hex);
    const a0 = Math.random() * 6.283;
    for (let i = 0; i < n; i++) {
      const a = a0 + (i / n) * 6.283 + rnd(-0.3, 0.3), sp = rnd(1.4, 2.4) * sc;
      pools.soft.push(S.reset().pos(p.x, y, p.z, time + delay).vel(Math.cos(a) * sp, rnd(3, 4.6) * sc, Math.sin(a) * sp, rnd(0.55, 0.75))
        .size(0.27 * sc, 0.16 * sc, rnd(-0.4, 0.4), rnd(3, 6) * sgn()).c0(col, 1.4, 1).c1(col, 1.15, 1).phys(2, 9, 0, MOTION_DRAG + BILLBOARD)
        .emit(1).ground(p.y).extra(0, 0, 0, SHAPE.star));
    }
  };

  const dust = (p: Vector3, n: number, sc: number, hex: number, d: Vector3 | undefined) => {
    setCol(col, hex);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.283, r = rnd(0.05, 0.22) * sc, sp = rnd(0.7, 1.7) * sc;
      const bx = d ? -d.x * 0.6 : 0, bz = d ? -d.z * 0.6 : 0;
      pools.soft.push(S.reset().pos(p.x + Math.cos(a) * r, p.y + (0.12 + rnd(0, 0.1)) * sc, p.z + Math.sin(a) * r, time)
        .vel(Math.cos(a) * sp + bx, rnd(0.2, 0.6) * sc, Math.sin(a) * sp + bz, rnd(0.8, 1.3))
        .size(0.22 * sc, rnd(0.78, 1.17) * sc, undefined, rnd(-0.7, 0.7))
        .c0(col, 1, rnd(0.68, 0.8)).c1(col, 1.05, 0).phys(3.2, -0.3, 0.5, MOTION_DRAG + BILLBOARD).ground(p.y).extra(0, 0, 0, SHAPE.puff));
    }
  };

  const randomAxis = () => {
    dir.set(rnd(-1, 1), rnd(-1, 1), rnd(-1, 1));
    if (dir.lengthSq() < 1e-4) dir.set(0, 1, 0);
    return dir.normalize();
  };

  const EMIT: Record<FxKind, (p: Vector3, n: number, sc: number, hex: number | undefined, d: Vector3 | undefined) => void> = {
    sparkle(p, n, sc, hex = SPARKLE) {
      flash(p.x, p.y + 0.2 * sc, p.z, p.y, 0xfff6e2, 3.2, 0.35 * sc, 1.4 * sc, 0.2, 0, hex); // white-hot core → gold
      ring(p.x, p.y + 0.03, p.z, hex, 2, 0.15 * sc, 1.5 * sc, 0.28);
      stars(p, p.y + 0.2, 5, sc, hex === SPARKLE ? SPARKLE_STAR : hex);
      setCol(col, hex);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * 6.283, up = rnd(0.25, 1), h = Math.sqrt(1 - up * up), sp = rnd(1.8, 3.8) * sc;
        pools.glow.push(S.reset().pos(p.x + rnd(-0.08, 0.08), p.y + rnd(0.05, 0.2), p.z + rnd(-0.08, 0.08), time)
          .vel(Math.cos(a) * h * sp, up * sp, Math.sin(a) * h * sp, rnd(0.5, 0.9)).size(0.3 * sc, 0.03 * sc, undefined, rnd(-2, 2))
          .c0(col, 2.8, 1).c1(col, 1.3, 1).phys(3.2, 2.5, 0, MOTION_DRAG + BILLBOARD).extra(0, 0, rnd(22, 38), SHAPE.flare));
      }
      for (let i = 0; i < n >> 1; i++) {
        const a = Math.random() * 6.283, sp = rnd(2, 4.5) * sc;
        pools.glow.push(S.reset().pos(p.x, p.y + 0.12, p.z, time).vel(Math.cos(a) * sp, rnd(1, 3) * sc, Math.sin(a) * sp, rnd(0.35, 0.65))
          .size(0.09 * sc, 0.015 * sc).c0(col, 2.4, 1).c1(col, 1.2, 1).phys(2.2, 5, 0, MOTION_DRAG + BILLBOARD).extra(0, 0, 0, SHAPE.glow));
      }
    },

    goldSparkle(p, n, sc, hex = 0xffb52e) {
      flash(p.x, p.y + 0.3 * sc, p.z, p.y, hex, 3, 0.5 * sc, 1.4 * sc, 0.26);
      setCol(col, hex);
      setCol(col2, 0xff8a1a);
      pools.glow.push(S.reset().pos(p.x, p.y + 0.05, p.z, time).vel(0, 0, 0, 0.45).size(0.2 * sc, 2.6 * sc).c0(col, 2.2, 1).c1(col, 0.8, 0)
        .phys(0, 0, 0, MOTION_DRAG + FLAT).extra(0, 0, 0, SHAPE.ring));
      stars(p, p.y + 0.3, 7, 1.2 * sc, hex);
      setCol(col, hex);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * 6.283, r = rnd(0, 1.6) * sc;
        pools.glow.push(S.reset().pos(p.x + rnd(-0.1, 0.1), p.y + 0.15, p.z + rnd(-0.1, 0.1), time)
          .vel(Math.cos(a) * r, rnd(3, 6) * sc, Math.sin(a) * r, rnd(0.9, 1.4)).size(0.34 * sc, 0.06 * sc, undefined, rnd(-2, 2))
          .c0(col, 3, 1).c1(col2, 1.3, 1).phys(1.4, 7, 0, MOTION_DRAG + BILLBOARD).extra(0, 0, rnd(18, 30), SHAPE.flare));
      }
      for (let i = 0; i < n >> 1; i++) {
        const a = Math.random() * 6.283, sp = rnd(2, 5) * sc;
        pools.glow.push(S.reset().pos(p.x, p.y + 0.2, p.z, time).vel(Math.cos(a) * sp, rnd(1, 3), Math.sin(a) * sp, rnd(0.5, 0.9))
          .size(0.1 * sc, 0.02 * sc).c0(col, 2.6, 1).c1(col2, 1.2, 1).phys(2, 6, 0, MOTION_DRAG + BILLBOARD).extra(0, 0, 0, SHAPE.glow));
      }
    },

    dust(p, n, sc, hex = DUST, d) { dust(p, n, sc, hex, d); },

    confetti(p, n, sc, _hex, d) {
      for (let i = 0; i < n; i++) {
        const hex = pickOf(CONFETTI);
        setCol(col, hex);
        const a = Math.random() * 6.283, r = rnd(0.6, 3.2) * sc;
        const ax = randomAxis();
        pools.solid.push(S.reset().pos(p.x + rnd(-0.25, 0.25), p.y + 0.3 + rnd(0, 0.2), p.z + rnd(-0.25, 0.25), time)
          .vel(Math.cos(a) * r + (d ? d.x * 3 : 0), rnd(7, 14) * sc, Math.sin(a) * r + (d ? d.z * 3 : 0), rnd(3.2, 4.4))
          .size(rnd(0.1, 0.14) * sc, rnd(0.1, 0.14) * sc, undefined, rnd(7, 15) * sgn()).c0(col, 1, 1).c1(col, 1, 1)
          .phys(4, 5, 0.35, MOTION_DRAG + TUMBLE).axis(ax.x, ax.y, ax.z).ground(p.y + 0.005)
          .extra(rnd(0.15, 0.4), rnd(3, 6), hex === 0xf5c542 ? 1.4 : hex === 0xffffff ? 0.5 : 0.3, SHAPE.rect));
      }
    },

    spill(p, n, sc, _hex, d) {
      for (let i = 0; i < n; i++) {
        const hex = pickOf(SCRAPS);
        setCol(col, hex);
        const a = Math.random() * 6.283, sp = rnd(2.5, 5) * sc;
        const ax = randomAxis();
        pools.solid.push(S.reset().pos(p.x + rnd(-0.15, 0.15), p.y + 0.55 + rnd(-0.1, 0.15), p.z + rnd(-0.15, 0.15), time)
          .vel(Math.cos(a) * sp + (d ? d.x * 2 : 0), rnd(3, 6) * sc, Math.sin(a) * sp + (d ? d.z * 2 : 0), rnd(1.6, 2.3))
          .size(rnd(0.12, 0.2) * sc, rnd(0.12, 0.2) * sc, undefined, rnd(9, 20) * sgn()).c0(col, 1, 1).c1(col, 1, 1)
          .phys(0.7, 13, 0.1, MOTION_DRAG + TUMBLE).axis(ax.x, ax.y, ax.z).ground(p.y + 0.005)
          .extra(0, 0, hex === 0xc4cad0 ? 1.2 : 0.35, SHAPE.rect));
      }
      dust(p, 5, 1.2 * sc, DUST, undefined);
      setCol(col, 0xfff4d6);
      for (let i = 0; i < 5; i++) {
        const a = Math.random() * 6.283, sp = rnd(2, 4);
        pools.glow.push(S.reset().pos(p.x, p.y + 0.6, p.z, time).vel(Math.cos(a) * sp, rnd(0.5, 2), Math.sin(a) * sp, rnd(0.25, 0.4))
          .size(0.16 * sc, 0.03 * sc).c0(col, 2, 1).c1(col, 1, 1).phys(4, 2, 0, MOTION_DRAG + BILLBOARD).extra(0, 0, 0, SHAPE.flare));
      }
    },

    powerup(p, n, sc, hex = 0x7dffc8) {
      setCol(col, hex);
      pools.glow.push(S.reset().pos(p.x, p.y + 0.06, p.z, time).vel(0, 0, 0, 0.55).size(0.3 * sc, 3 * sc).c0(col, 2.2, 1).c1(col, 0.8, 0)
        .phys(0, 0, 0, MOTION_DRAG + FLAT).extra(0, 0, 0, SHAPE.ring));
      pools.glow.push(S.reset().pos(p.x, p.y + 0.06, p.z, time + 0.12).vel(0, 0, 0, 0.6).size(0.2 * sc, 2 * sc).c0(col, 1.8, 1).c1(col, 0.6, 0)
        .phys(0, 0, 0, MOTION_DRAG + FLAT).extra(0, 0, 0, SHAPE.ring));
      flash(p.x, p.y + 0.4 * sc, p.z, p.y, hex, 2.6, 0.5 * sc, 1.5 * sc, 0.25);
      for (let i = 0; i < n; i++) {
        pools.glow.push(S.reset().pos(p.x, p.y + 0.1, p.z, time).vel((i / n) * 12.566, rnd(1.6, 2.8) * sc, 0, rnd(0.8, 1.25))
          .size(0.2 * sc, 0.04 * sc, undefined, rnd(-2, 2)).c0(col, 2.8, 1).c1(white, 1.6, 1).phys(0, 0.6, 0, MOTION_SWIRL + BILLBOARD)
          .axis(rnd(0.25, 0.45) * sc, 6.5, rnd(0.7, 1.2) * sc).extra(0, 0, rnd(20, 32), SHAPE.flare));
      }
      for (let i = 0; i < n >> 1; i++) {
        const a = Math.random() * 6.283, r = rnd(0, 0.6) * sc;
        pools.glow.push(S.reset().pos(p.x + Math.cos(a) * r, p.y + rnd(0, 0.3), p.z + Math.sin(a) * r, time).vel(0, rnd(1.5, 3.5) * sc, 0, rnd(0.6, 1))
          .size(0.07 * sc, 0.015 * sc).c0(col, 2.4, 1).c1(col, 1.2, 1).phys(1, 0, 0, MOTION_DRAG + BILLBOARD).extra(0, 0, 0, SHAPE.glow));
      }
    },

    hit(p, n, sc) {
      const y = p.y + 0.75 * sc;
      flash(p.x, y, p.z, p.y, 0xffe9a8, 3, 0.5 * sc, 1.3 * sc, 0.14);
      setCol(col, 0xffd21f);
      setCol(col2, 0xff9d00);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * 6.283 + rnd(-0.3, 0.3), sp = rnd(3.5, 5.2) * sc;
        // solid cartoon stars (alpha-blended, unlit) so the impact also reads against a bright sky
        pools.soft.push(S.reset().pos(p.x, y, p.z, time).vel(Math.cos(a) * sp, rnd(0.2, 0.9) * sp, Math.sin(a) * sp, rnd(0.45, 0.7))
          .size(0.28 * sc, 0.12 * sc, undefined, rnd(4, 8) * sgn()).c0(col, 1.4, 1).c1(col2, 1.15, 1).phys(5, 3, 0, MOTION_DRAG + BILLBOARD)
          .emit(1).extra(0, 0, 0, SHAPE.star));
      }
      // (no dizzy stars here: Labib is knocked metres away, so they belong to the avatar's stun pose)
      dust(p, 4, sc, DUST, undefined);
    },

    deposit(p, n, sc, hex = 0x4dff94) {
      // gold/white swirl with mint arcs (mint alone vanishes against the green bin), then at t + 0.5
      // the "gulp": a big flash, a ring spreading over the rim and a pop of flares and stars
      const rim = p.y + BIN_RIM, gulp = 0.5;
      setCol(col, hex);
      const a0 = Math.random() * 6.283;
      setCol(col2, SPARKLE_STAR);
      for (let i = 0; i < n; i++) {
        // half additive mint arcs tracing the spiral, half solid-gold twinkles (readable on the sky)
        const arc = i % 2 === 1;
        (arc ? pools.glow : pools.soft).push(S.reset().pos(p.x, rim + rnd(0.35, 0.7) * sc, p.z, time).vel(a0 + (i / n) * 6.283, -rnd(0.9, 1.4), 0, rnd(0.5, 0.7))
          .size((arc ? 0.18 : 0.3) * sc, (arc ? 0.07 : 0.12) * sc, undefined, rnd(-2, 2)).c0(arc ? col : col2, arc ? 2.2 : 1.4, 1).c1(arc ? white : col2, arc ? 1.5 : 1.2, 1)
          .phys(0, 0.8, 0, MOTION_SWIRL + (arc ? STREAK : BILLBOARD)).emit(1)
          .axis(rnd(0.5, 0.75) * sc, 9, 0.04).extra(0, 0, arc ? 0.35 * sc : 0, arc ? SHAPE.streak : SHAPE.flare));
      }
      flash(p.x, rim + 0.1, p.z, NO_GROUND, 0xfff6e2, 2.6, 0.5 * sc, 2 * sc, 0.28, gulp, GOLD_CORE);
      ring(p.x, rim + 0.02, p.z, hex, 2.2, 0.35 * sc, 2.2 * sc, 0.4, gulp);
      setCol(col, hex);
      setCol(col2, SPARKLE_STAR);
      for (let i = 0; i < 10; i++) {
        const a = Math.random() * 6.283, sp = rnd(0.3, 1.1) * sc;
        pools.glow.push(S.reset().pos(p.x, rim, p.z, time + gulp).vel(Math.cos(a) * sp, rnd(2.6, 4.2) * sc, Math.sin(a) * sp, rnd(0.5, 0.75))
          .size(0.26 * sc, 0.05 * sc, undefined, rnd(-2, 2)).c0(col2, 2.6, 1).c1(i % 2 ? col : col2, 1.3, 1)
          .phys(1.6, 6, 0, MOTION_DRAG + BILLBOARD).extra(0, 0, rnd(20, 32), SHAPE.flare));
      }
      stars(p, rim + 0.1, 4, sc, SPARKLE_STAR, gulp);
    },

    leaves(p, n, sc) {
      const ground = Math.min(CURB, p.y - 0.3);
      for (let i = 0; i < n; i++) {
        setCol(col, pickOf(LEAVES));
        const ax = randomAxis();
        pools.solid.push(S.reset().pos(p.x + rnd(-1.2, 1.2) * sc, p.y + rnd(-0.3, 0.3), p.z + rnd(-1.2, 1.2) * sc, time)
          .vel(rnd(-0.3, 0.3), rnd(-0.2, 0.1), rnd(-0.3, 0.3), rnd(6, 8)).size(rnd(0.18, 0.24) * sc, rnd(0.18, 0.24) * sc, undefined, rnd(1.5, 4) * sgn())
          .c0(col, 1, 1).c1(col, 0.9, 1).phys(3.2, 2.6, 1, MOTION_DRAG + TUMBLE).axis(ax.x, ax.y, ax.z).ground(ground)
          .extra(rnd(0.25, 0.5), rnd(1.8, 3.2), 0.35, SHAPE.leaf));
      }
    },

    speedLines(p, n, sc, hex = 0x6dffc0, d) {
      dir.set(d ? d.x : 0, 0, d ? d.z : 1);
      if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
      dir.normalize();
      setCol(col, hex);
      for (let i = 0; i < n; i++) {
        const side = rnd(0.35, 0.85) * sgn() * sc, fwd = rnd(-0.2, 0.5), sp = rnd(2, 4);
        pools.glow.push(S.reset().pos(p.x + dir.z * side + dir.x * fwd, p.y + rnd(0.2, 1.3) * sc, p.z - dir.x * side + dir.z * fwd, time)
          .vel(-dir.x * sp, 0, -dir.z * sp, rnd(0.18, 0.28)).size(0.05 * sc, 0.03 * sc, 0, 0).c0(col, 1.7, 0.9).c1(col, 0.8, 0)
          .phys(0, 0, 0, MOTION_DRAG + STREAK).axis(dir.x, 0, dir.z).extra(0, 0, rnd(0.9, 1.6) * sc, SHAPE.streak));
      }
    },
  };

  return {
    root,
    burst(kind, position, opts) {
      if (haveCamera && position.distanceToSquared(camera) > CULL_DIST * CULL_DIST) return;
      const n = Math.max(1, Math.round(opts?.count ?? DEFAULT_COUNT[kind] * countScale));
      EMIT[kind](position, n, opts?.scale ?? 1, opts?.color, opts?.direction);
    },
    update(dt, cameraPosition) {
      time += dt;
      uniforms.uTime.value = time;
      camera.copy(cameraPosition);
      haveCamera = true;
      for (let i = 0; i < poolList.length; i++) {
        const p = poolList[i];
        p.flush();
        p.mesh.visible = time < p.deadAt; // idle pools cost no draw call
      }
    },
    clear() {
      for (const p of poolList) p.clear();
    },
    setQuality(q) {
      countScale = QUALITY_COUNT[q];
    },
    dispose() {
      for (const p of poolList) p.dispose();
      for (const m of Object.values(materials)) m.dispose();
      atlas.dispose();
      root.removeFromParent();
    },
  };
}
