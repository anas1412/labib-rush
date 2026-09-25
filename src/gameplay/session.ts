// Gameplay session: one run of Labib Rush on top of the pure rules (./rules.ts).
// Owns bins (+ their colliders), litter (instanced on the floor, individual while kicked / flying /
// magnet-pulled), flying bags on the wind, power-ups, the golden bottle, the ear radar overlay, the
// wind uniform, the 3-2-1-GO countdown, first-run hints and the HUD feed. Emits GameEvents; the
// feedback router (./feedback.ts) turns them into sound, particles and callouts.
import type RAPIER from '@dimforge/rapier3d-compat';
import {
  AdditiveBlending, Color, CylinderGeometry, DoubleSide, Group, InstancedMesh, Matrix4, Mesh, Object3D, PlaneGeometry,
  Quaternion, ShaderMaterial, Vector3, type BufferGeometry,
} from 'three';
import { MAGNET_RADIUS, RULES, TEA_SPEED } from '../core/config';
import { BINS, CURB, LITTER_ZONES, PLAYER_SPAWN, PLAYER_SPAWN_YAW, ROAD_X, X_MAX, X_MIN } from '../core/layout';
import { G, groups } from '../core/physics';
import type {
  BinModel, Crowd, GameContext, GameSession, InputFrame, LitterKind, LitterShape, PowerUpKind, PropFactory, SessionHooks, Traffic,
} from '../core/types';
import * as R from './rules';

type Props = PropFactory & { litterShape(kind: LitterKind): LitterShape };

/** GameSession plus what main.ts (and DEV tests) need beyond the shared contract. */
export interface GameSessionEx extends GameSession {
  /** Countdown or run over: main feeds the controller a zero-move frame. */
  readonly locked: boolean;
  readonly run: R.Run;
  /** DEV/test helpers. */
  readonly debug: {
    counts(): { items: number; floor: number; phys: number; fly: number; powerups: number; bodies: number; colliders: number };
    setTime(seconds: number): void;
    litter(): { x: number; y: number; z: number; kind: LitterKind; state: string }[];
    spawn(kind: LitterKind | PowerUpKind, x: number, z: number): void;
  };
}

// ---- tuning ---------------------------------------------------------------------------------
const INSTANCED: LitterKind[] = ['can', 'bottle', 'chips'];
const BATCH_CAP = 160;
const MAX_ITEMS = 220;
const MARKER_CAP = MAX_ITEMS + 40; // glint/ring/radar instances (spills and settles can overshoot MAX_ITEMS a little)
const NEAR_RADIUS = 70; // "litter around the player" counts within this
const NEAR_BASE = 38, NEAR_PER_LEVEL = 7, NEAR_MAX = 72;
const SPAWN_MIN_D = 11; // m: new litter appears just outside the player's immediate reach
const SPAWN_EVERY = 0.75; // s between density checks (shorter with difficulty)
const INITIAL_SCATTER = 110;
const KICK_RANGE = 2.5, KICK_CONE = Math.cos((50 * Math.PI) / 180), KICK_MAX = 4; // reach from the kick point (0.7 m ahead): kick before auto-pickup grabs it
const ASSIST_RANGE = 16, ASSIST_DEG = 24, ASSIST_CONE = Math.cos((ASSIST_DEG * Math.PI) / 180);
/** Aim error radius (m) of an assisted lob: ~100% in at 4 m, ~60% at 10 m, ~30% at 16 m, worse off-axis. */
const aimError = (d: number, deg: number) => (0.14 + 0.03 * d) * (1 + deg / ASSIST_DEG);
const REST_SPEED = 0.18, REST_TIME = 0.35, PHYS_MAX_AGE = 9;
const PICK_DY_MIN = -0.6, PICK_DY_MAX = 1.0; // vertical reach (feet → item): kiosk roofs need a jump
const BAG_REACH = 1.45; // m above the feet: flying bags higher than this need a jump
const BAG_FULL_THROTTLE = 1.4;
const POWERUP_EVERY: [number, number] = [15, 25];
const POWERUP_LIFE = 32;
const POWERUP_KINDS: PowerUpKind[] = ['tea', 'bambalouni', 'mashmoum', 'chechia'];
const POWERUP_COLOR: Record<PowerUpKind, number> = { tea: 0x7dffc8, bambalouni: 0xffb84d, mashmoum: 0xfff6e0, chechia: 0xff3b3b };
const GOLDEN_EVERY: [number, number] = [45, 60];
const COUNTDOWN = 3;
const DEPOSIT_GULP = 0.5; // s: the fx swirl reaches the rim, then the bin bumps

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)];
const groundY = (x: number, z: number) => (x > ROAD_X.min && x < ROAD_X.max && Math.abs(z) > 14 && Math.abs(z) < 22 ? 0 : CURB);

type ItemState = 'floor' | 'phys' | 'fly' | 'magnet';
interface Item {
  id: number;
  kind: LitterKind;
  variant: number;
  state: ItemState;
  /** Pivot = collider centre (visual origin is `off` below it, in the item's frame). */
  pos: Vector3;
  quat: Quaternion;
  vel: Vector3;
  obj: Group | null; // individual visual (pivot)
  body: RAPIER.RigidBody | null;
  batch: Batch | null;
  slot: number;
  respilled: boolean;
  still: number;
  age: number;
  life: number; // flying bags: seconds before settling
  phase: number;
  alt: number; // flying bags: cruise altitude
}

const ONE = new Vector3(1, 1, 1);
const _m = new Matrix4(), _m2 = new Matrix4();

/** One InstancedMesh per template child (item parts + contact shadow) for one kind/variant. */
class Batch {
  readonly meshes: InstancedMesh[] = [];
  private readonly childM: (Matrix4 | null)[] = [];
  private readonly offset: Matrix4;
  readonly items: Item[] = [];
  count = 0;
  dirty = false;

  constructor(template: Object3D, off: number, parent: Object3D) {
    this.offset = new Matrix4().makeTranslation(0, -off, 0);
    template.updateMatrixWorld(true);
    for (const c of template.children) {
      const src = c as Mesh;
      const im = new InstancedMesh(src.geometry, src.material, BATCH_CAP);
      im.count = 0;
      im.frustumCulled = false; // spread over the whole avenue
      im.castShadow = src.castShadow;
      im.receiveShadow = src.receiveShadow;
      im.renderOrder = src.renderOrder;
      if (src.customDepthMaterial) im.customDepthMaterial = src.customDepthMaterial;
      im.name = `litter-batch-${template.name}-${c.name || 'part'}`;
      parent.add(im);
      this.meshes.push(im);
      this.childM.push(c.matrix.equals(_m2.identity()) ? null : c.matrix.clone());
    }
  }

  get full(): boolean { return this.count >= BATCH_CAP; }

  add(it: Item): void {
    it.batch = this;
    it.slot = this.count++;
    this.items[it.slot] = it;
    this.write(it.slot);
  }

  remove(it: Item): void {
    const last = --this.count;
    if (it.slot !== last) {
      const moved = this.items[last];
      this.items[it.slot] = moved;
      moved.slot = it.slot;
      this.write(it.slot);
    }
    it.batch = null;
    it.slot = -1;
    for (const m of this.meshes) m.count = this.count;
    this.dirty = true;
  }

  write(slot: number): void {
    const it = this.items[slot];
    _m.compose(it.pos, it.quat, ONE).multiply(this.offset);
    for (let i = 0; i < this.meshes.length; i++) {
      const cm = this.childM[i];
      this.meshes[i].setMatrixAt(slot, cm ? _m2.multiplyMatrices(_m, cm) : _m);
      this.meshes[i].count = this.count;
    }
    this.dirty = true;
  }

  flush(): void {
    if (!this.dirty) return;
    for (const m of this.meshes) m.instanceMatrix.needsUpdate = true;
    this.dirty = false;
  }

  clear(): void {
    for (let i = 0; i < this.count; i++) { this.items[i].batch = null; this.items[i].slot = -1; }
    this.count = 0;
    for (const m of this.meshes) m.count = 0;
  }

  dispose(): void {
    for (const m of this.meshes) { m.removeFromParent(); m.dispose(); }
  }
}

// ---- shaders: readability glint + ground ring, radar x-ray, golden beam, power-up halo --------
const BILLBOARD_VERT = /* glsl */ `
uniform float uTime; uniform float uSize; uniform float uLift;
varying vec2 vUv; varying float vA; varying float vT;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec3 c = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  c.y += uLift;
  float seed = hash(c.xz);
  vec4 mv = viewMatrix * vec4(c, 1.0);
  float dist = -mv.z;
  #ifdef GLINT
    float t = fract(uTime * 0.55 + seed);
    float tw = smoothstep(0.0, 0.06, t) * (1.0 - smoothstep(0.06, 0.26, t));
    vA = tw * smoothstep(3.0, 8.0, dist) * (1.0 - smoothstep(65.0, 90.0, dist));
    float size = uSize * (0.4 + 0.6 * tw) * (1.0 + dist * 0.06);
  #else
    vA = 1.0;
    float size = uSize * (1.0 + dist * 0.035);
  #endif
  vT = fract(uTime * 1.1 + seed);
  mv.xy += position.xy * size;
  vUv = uv;
  gl_Position = projectionMatrix * mv;
}`;
const GLINT_FRAG = /* glsl */ `
uniform vec3 uColor;
varying vec2 vUv; varying float vA;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float core = exp(-dot(p, p) * 22.0);
  float rays = exp(-abs(p.x) * 26.0) * exp(-abs(p.y) * 3.2) + exp(-abs(p.y) * 26.0) * exp(-abs(p.x) * 3.2);
  float a = (core + rays * 0.8) * vA;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor * a, 1.0);
}`;
const RADAR_FRAG = /* glsl */ `
uniform vec3 uColor; uniform float uAlpha;
varying vec2 vUv; varying float vT;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float dot0 = exp(-r * r * 30.0);
  float ring = exp(-pow((r - 0.35 - vT * 0.6) * 9.0, 2.0)) * (1.0 - vT);
  float rim = exp(-pow((r - 0.42) * 14.0, 2.0)) * 0.5;
  float a = (dot0 * 1.4 + ring + rim) * uAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor * a, 1.0);
}`;
const RING_VERT = /* glsl */ `
uniform float uTime;
varying vec2 vUv; varying float vA;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec3 c = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float dist = distance(cameraPosition, c);
  float size = 0.55 + dist * 0.02;
  vA = smoothstep(3.0, 9.0, dist) * (1.0 - smoothstep(55.0, 80.0, dist)) * (0.75 + 0.25 * sin(uTime * 2.2 + hash(c.xz) * 6.2832));
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * vec4(c.x + position.x * size, c.y + 0.012, c.z - position.y * size, 1.0);
}`;
const RING_FRAG = /* glsl */ `
uniform vec3 uColor;
varying vec2 vUv; varying float vA;
void main() {
  float r = length(vUv * 2.0 - 1.0);
  float ring = smoothstep(0.58, 0.78, r) * (1.0 - smoothstep(0.78, 1.0, r));
  float a = (ring + (1.0 - smoothstep(0.0, 0.75, r)) * 0.18) * vA;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor * a, 1.0);
}`;
const BEAM_VERT = /* glsl */ `
varying float vH; varying float vFade; varying float vEdge;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vH = uv.y;
  vFade = smoothstep(3.0, 12.0, distance(cameraPosition, modelMatrix[3].xyz));
  vec3 n = normalize(mat3(modelMatrix) * normal);
  vEdge = abs(dot(n, normalize(cameraPosition - w.xyz)));
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const BEAM_FRAG = /* glsl */ `
uniform float uTime; uniform vec3 uColor;
varying float vH; varying float vFade; varying float vEdge;
void main() {
  float a = pow(1.0 - vH, 2.6) * smoothstep(0.0, 0.03, vH) * pow(vEdge, 3.0) * vFade * (0.75 + 0.25 * sin(uTime * 3.0 - vH * 40.0));
  gl_FragColor = vec4(uColor * a, 1.0);
}`;
const HALO_FRAG = /* glsl */ `
uniform vec3 uColor; uniform float uAlpha; uniform float uTime;
varying vec2 vUv;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float a = (exp(-r * r * 5.0) * 0.55 + exp(-pow((r - 0.62 - 0.05 * sin(uTime * 3.0)) * 10.0, 2.0)) * 0.35) * uAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor * a, 1.0);
}`;
const HALO_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  mv.xy += position.xy * 1.35;
  vUv = uv;
  gl_Position = projectionMatrix * mv;
}`;

interface BinSlot { model: BinModel; base: Vector3; colliders: RAPIER.Collider[]; gulp: number }
interface PowerSlot { kind: PowerUpKind; root: Group; model: Object3D; halo: Mesh; base: Vector3; age: number; phase: number }

export function createSession(ctx: GameContext, props: Props): GameSessionEx {
  const { physics, events, player, uniforms, ui, audio } = ctx;
  const { world, R: RAP } = physics;
  const scene = ctx.engine.scene;
  const gravity = -world.gravity.y;
  const root = new Group();
  root.name = 'gameplay';
  scene.add(root);

  let crowd: Crowd | null = null;
  let traffic: Traffic | null = null;
  let run = R.createRun();
  let state: 'idle' | 'countdown' | 'play' | 'over' = 'idle';
  let countdown = 0;
  let lastCount = 0;
  let time = 0;

  // ---- templates & batches ----------------------------------------------------------------------
  const shapes = {} as Record<LitterKind, LitterShape>;
  const offs = {} as Record<LitterKind, number>;
  const templates = {} as Record<LitterKind, Object3D[]>;
  const batches = {} as Record<LitterKind, Batch[]>;
  for (const kind of ['can', 'bottle', 'chips', 'bag', 'golden'] as LitterKind[]) {
    shapes[kind] = props.litterShape(kind);
    offs[kind] = kind === 'chips' ? shapes[kind].half.y : kind === 'bag' ? 0.16 : shapes[kind].radius;
    const seen = new Set<BufferGeometry>();
    templates[kind] = [];
    for (let i = 0; i < 4; i++) { // each kind cycles its variants: keep the distinct ones
      const t = props.litter(kind);
      const g = (t.children[0] as Mesh).geometry;
      if (!seen.has(g)) { seen.add(g); templates[kind].push(t); }
    }
    batches[kind] = INSTANCED.includes(kind) ? templates[kind].map((t) => new Batch(t, offs[kind], root)) : [];
  }

  // ---- marker meshes -----------------------------------------------------------------------------
  const quad = new PlaneGeometry(1, 1);
  const owned: { dispose(): void }[] = [quad];
  const add = <T extends { dispose(): void }>(x: T) => { owned.push(x); return x; };
  const glintMat = add(new ShaderMaterial({
    vertexShader: BILLBOARD_VERT, fragmentShader: GLINT_FRAG, defines: { GLINT: '' },
    uniforms: { uTime: uniforms.uTime, uSize: { value: 0.34 }, uLift: { value: 0.12 }, uColor: { value: new Color(2.4, 2.1, 1.5) } },
    transparent: true, depthWrite: false, blending: AdditiveBlending,
  }));
  const ringMat = add(new ShaderMaterial({
    vertexShader: RING_VERT, fragmentShader: RING_FRAG,
    uniforms: { uTime: uniforms.uTime, uColor: { value: new Color(0.72, 0.6, 0.32) } },
    transparent: true, depthWrite: false, blending: AdditiveBlending,
  }));
  const radarMat = add(new ShaderMaterial({
    vertexShader: BILLBOARD_VERT, fragmentShader: RADAR_FRAG,
    uniforms: { uTime: uniforms.uTime, uSize: { value: 0.7 }, uLift: { value: 0.2 }, uColor: { value: new Color(0.35, 1.6, 1.25) }, uAlpha: { value: 0 } },
    transparent: true, depthWrite: false, depthTest: false, blending: AdditiveBlending,
  }));
  const mkInst = (mat: ShaderMaterial, order: number, name: string) => {
    const m = new InstancedMesh(quad, mat, MARKER_CAP);
    m.count = 0; m.frustumCulled = false; m.renderOrder = order; m.name = name;
    root.add(m);
    return m;
  };
  const glints = mkInst(glintMat, 3, 'litter-glints');
  const rings = mkInst(ringMat, 1, 'litter-rings');
  const radarDots = mkInst(radarMat, 999, 'litter-radar');
  radarDots.visible = false;

  const beamGeo = add(new CylinderGeometry(0.28, 0.28, 30, 16, 1, true).translate(0, 15, 0));
  const beamMat = add(new ShaderMaterial({
    vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG,
    uniforms: { uTime: uniforms.uTime, uColor: { value: new Color(0.9, 0.55, 0.12) } },
    transparent: true, depthWrite: false, blending: AdditiveBlending, side: DoubleSide,
  }));
  const beam = new Mesh(beamGeo, beamMat);
  beam.name = 'golden-beam';
  beam.visible = false;
  beam.frustumCulled = false;
  root.add(beam);

  const haloMats = {} as Record<PowerUpKind, ShaderMaterial>;
  for (const k of POWERUP_KINDS) {
    const c = new Color(POWERUP_COLOR[k]).multiplyScalar(1.3);
    haloMats[k] = add(new ShaderMaterial({
      vertexShader: HALO_VERT, fragmentShader: HALO_FRAG,
      uniforms: { uColor: { value: c }, uAlpha: { value: 1 }, uTime: uniforms.uTime },
      transparent: true, depthWrite: false, blending: AdditiveBlending,
    }));
  }

  // ---- bins ----------------------------------------------------------------------------------------
  const bins: BinSlot[] = [];
  for (const b of BINS) {
    const model = props.bin();
    const base = new Vector3(b.x, CURB, b.z);
    model.root.position.copy(base);
    model.root.rotation.y = b.z > 0 ? Math.PI : 0; // front faces the promenade centre line
    root.add(model.root);
    // Hollow collider: 4 walls around the opening, so kicked litter can drop in (and the player can't).
    const h = model.height / 2, hx = model.half.x, t = 0.09;
    const cy = CURB + h;
    const colliders = [
      physics.addBox(new Vector3(b.x + hx - t, cy, b.z), new Vector3(t, h, hx)),
      physics.addBox(new Vector3(b.x - hx + t, cy, b.z), new Vector3(t, h, hx)),
      physics.addBox(new Vector3(b.x, cy, b.z + hx - t), new Vector3(hx - 2 * t, h, t)),
      physics.addBox(new Vector3(b.x, cy, b.z - hx + t), new Vector3(hx - 2 * t, h, t)),
    ];
    bins.push({ model, base, colliders, gulp: 0 });
  }

  // ---- items ---------------------------------------------------------------------------------------
  const items: Item[] = [];
  const pool: Item[] = [];
  let nextId = 1;
  let goldenItem: Item | null = null;
  const tmp = new Vector3(), tmpQ = new Quaternion();
  const axisY = new Vector3(0, 1, 0);
  const capsuleRot = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2); // Rapier capsules run along Y

  function newItem(kind: LitterKind, variant: number): Item {
    const it = pool.pop() ?? {
      id: 0, kind, variant, state: 'floor', pos: new Vector3(), quat: new Quaternion(), vel: new Vector3(), obj: null, body: null,
      batch: null, slot: -1, respilled: false, still: 0, age: 0, life: 0, phase: 0, alt: 0,
    } satisfies Item;
    it.id = nextId++; it.kind = kind; it.variant = variant; it.respilled = false;
    it.still = 0; it.age = 0; it.life = 0; it.phase = Math.random() * 100; it.alt = 0;
    it.vel.set(0, 0, 0);
    items.push(it);
    return it;
  }

  const variantOf = (kind: LitterKind) => Math.floor(Math.random() * templates[kind].length);

  function makeObj(it: Item): Group {
    const pivot = new Group();
    const vis = templates[it.kind][it.variant].clone();
    vis.position.y = -offs[it.kind];
    pivot.add(vis);
    root.add(pivot);
    return pivot;
  }
  function setShadow(it: Item, on: boolean): void {
    const s = it.obj?.children[0]?.getObjectByName('contact-shadow');
    if (s) s.visible = on;
  }
  function dropObj(it: Item): void {
    if (it.obj) { it.obj.removeFromParent(); it.obj = null; }
  }
  function dropBody(it: Item): void {
    if (it.body) { world.removeRigidBody(it.body); it.body = null; }
  }

  /** Puts an item on the floor (instanced when possible). pos = pivot, quat = yaw-only pose. */
  function toFloor(it: Item): void {
    dropBody(it);
    it.state = 'floor';
    it.vel.set(0, 0, 0);
    const list = batches[it.kind];
    const b = list.length ? list[it.variant] : null;
    if (b && !b.full) {
      dropObj(it);
      b.add(it);
    } else {
      if (!it.obj) it.obj = makeObj(it);
      it.obj.position.copy(it.pos);
      it.obj.quaternion.copy(it.quat);
      setShadow(it, true);
    }
  }
  /** Leaves the instanced batch (if any) and gets an individual visual. */
  function toIndividual(it: Item): void {
    if (it.batch) it.batch.remove(it);
    if (!it.obj) it.obj = makeObj(it);
    it.obj.position.copy(it.pos);
    it.obj.quaternion.copy(it.quat);
  }

  function removeItem(it: Item): void {
    if (it.batch) it.batch.remove(it);
    dropObj(it);
    dropBody(it);
    if (it === goldenItem) { goldenItem = null; beam.visible = false; }
    const i = items.indexOf(it);
    if (i >= 0) { items[i] = items[items.length - 1]; items.pop(); }
    pool.push(it);
  }

  function spawnFloor(kind: LitterKind, x: number, y: number, z: number, variant = variantOf(kind)): Item {
    const it = newItem(kind, variant);
    it.pos.set(x, y + offs[kind], z);
    it.quat.setFromAxisAngle(axisY, Math.random() * Math.PI * 2);
    toFloor(it);
    return it;
  }

  function makeBody(it: Item, vx: number, vy: number, vz: number): void {
    const s = shapes[it.kind];
    const body = world.createRigidBody(
      RAP.RigidBodyDesc.dynamic()
        .setTranslation(it.pos.x, it.pos.y, it.pos.z)
        .setRotation({ x: it.quat.x, y: it.quat.y, z: it.quat.z, w: it.quat.w })
        .setLinvel(vx, vy, vz)
        .setAngvel({ x: rand(-14, 14), y: rand(-8, 8), z: rand(-14, 14) })
        .setAngularDamping(0.6) // no linear damping: the aim-assist lob is exact ballistics
        .setCcdEnabled(true),
    );
    let desc: RAPIER.ColliderDesc;
    if (it.kind === 'chips') desc = RAP.ColliderDesc.cuboid(s.half.x, s.half.y, s.half.z);
    else if (it.kind === 'bag') desc = RAP.ColliderDesc.ball(0.16);
    else desc = RAP.ColliderDesc.capsule(s.halfLength, s.radius).setRotation(capsuleRot);
    world.createCollider(desc.setRestitution(0.35).setFriction(0.7).setDensity(it.kind === 'bag' ? 0.2 : 1)
      .setCollisionGroups(groups(G.LITTER, G.STATIC | G.LOW_PROP | G.LITTER)), body);
    it.body = body;
  }

  function toPhys(it: Item, vx: number, vy: number, vz: number): void {
    toIndividual(it);
    dropBody(it);
    it.state = 'phys';
    it.still = 0; it.age = 0;
    makeBody(it, vx, vy, vz);
    setShadow(it, false);
  }

  /** A physics item came to rest: snap to a lying pose (yaw of its long axis) on the floor. */
  function settle(it: Item): void {
    tmp.set(1, 0, 0).applyQuaternion(it.quat);
    const yaw = Math.abs(tmp.y) > 0.95 ? Math.random() * 6.283 : Math.atan2(-tmp.z, tmp.x);
    const bottom = it.pos.y - offs[it.kind];
    it.quat.setFromAxisAngle(axisY, yaw);
    // ground under it (floor, bench, planter): use the physics height, never below the street
    it.pos.y = Math.max(bottom, groundY(it.pos.x, it.pos.z) - 0.02) + offs[it.kind];
    toFloor(it);
  }

  // ---- placement --------------------------------------------------------------------------------
  const down = new Vector3(0, -1, 0);
  const rayO = new Vector3();
  /** Clear floor height at (x, z) around `y`, or null (prop, planter, statue lawn, bin, item). */
  function floorAt(x: number, z: number, y: number): number | null {
    rayO.set(x, y + 2.9, z);
    const hit = physics.raycast(rayO, down, 3.4, G.STATIC | G.LOW_PROP);
    if (!hit) return null;
    const hy = hit.point.y;
    if (hy < y - 0.03 || hy > y + 0.05) return null;
    for (const b of bins) if ((b.base.x - x) ** 2 + (b.base.z - z) ** 2 < 2.2) return null;
    return hy;
  }
  function crowded(x: number, z: number): boolean {
    for (const it of items) if ((it.pos.x - x) ** 2 + (it.pos.z - z) ** 2 < 0.25) return true;
    return false;
  }
  const ZONE_W = LITTER_ZONES.map((zn) => (zn.xMax - zn.xMin) * (zn.zMax - zn.zMin));
  const ZONE_SUM = ZONE_W.reduce((a, b) => a + b, 0);
  /** Random clear point in the litter zones, optionally within [minD, maxD] of `near`. */
  function zonePoint(near: Vector3 | null, minD: number, maxD: number, out: Vector3): boolean {
    for (let tries = 0; tries < 14; tries++) {
      let x: number, z: number, zi: number;
      if (near) {
        const a = Math.random() * Math.PI * 2, d = rand(minD, maxD);
        x = near.x + Math.cos(a) * d; z = near.z + Math.sin(a) * d;
        zi = LITTER_ZONES.findIndex((zn) => x >= zn.xMin && x <= zn.xMax && z >= zn.zMin && z <= zn.zMax);
        if (zi < 0) continue;
      } else {
        let r = Math.random() * ZONE_SUM;
        zi = 0;
        while (r > ZONE_W[zi] && zi < ZONE_W.length - 1) r -= ZONE_W[zi++];
        const zn = LITTER_ZONES[zi];
        x = rand(zn.xMin, zn.xMax); z = rand(zn.zMin, zn.zMax);
      }
      const y = floorAt(x, z, LITTER_ZONES[zi].y);
      if (y === null || crowded(x, z)) continue;
      out.set(x, y, z);
      return true;
    }
    return false;
  }
  type AnchorKey = 'benches' | 'cafeTables' | 'kioskRoofs' | 'planters' | 'roadEdges';
  const ANCHOR_W: [AnchorKey, number, number][] = [ // key, weight, jitter
    ['benches', 0.13, 0.3], ['cafeTables', 0.12, 0.12], ['kioskRoofs', 0.07, 0.35], ['planters', 0.1, 0.25], ['roadEdges', 0.12, 0.2],
  ];
  function anchorPoint(near: Vector3 | null, minD: number, maxD: number, out: Vector3): boolean {
    let r = Math.random();
    for (const [key, w, jitter] of ANCHOR_W) {
      if ((r -= w) > 0) continue;
      const list = ctx.anchors[key];
      if (!list.length) return false;
      for (let tries = 0; tries < 20; tries++) {
        const a = pick(list);
        if (near) {
          const d2 = (a.x - near.x) ** 2 + (a.z - near.z) ** 2;
          if (d2 < minD * minD || d2 > maxD * maxD) continue;
        }
        const x = a.x + rand(-jitter, jitter), z = a.z + (key === 'planters' ? 0 : rand(-jitter, jitter));
        if (crowded(x, z)) continue;
        out.set(x, a.y, z);
        return true;
      }
      return false;
    }
    return zonePoint(near, minD, maxD, out);
  }
  const floorKind = (): LitterKind => { const r = Math.random(); return r < 0.38 ? 'can' : r < 0.7 ? 'bottle' : 'chips'; };
  const spawnPt = new Vector3();
  function spawnLitter(near: Vector3 | null, minD: number, maxD: number): void {
    if (items.length >= MAX_ITEMS) return;
    if (!anchorPoint(near, minD, maxD, spawnPt)) return;
    spawnFloor(floorKind(), spawnPt.x, spawnPt.y, spawnPt.z);
    // small clusters on the ground nearby (a dropped snack, a tipped-over table) so 3 s chains are natural
    if (Math.random() > 0.55) return;
    const cx = spawnPt.x, cz = spawnPt.z;
    for (let n = 2 + Math.floor(Math.random() * 3), tries = 0; n > 0 && tries < 10 && items.length < MAX_ITEMS; tries++) {
      const a = Math.random() * Math.PI * 2, d = rand(1.5, 3);
      const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
      const y = floorAt(x, z, groundY(x, z));
      if (y === null || crowded(x, z)) continue;
      spawnFloor(floorKind(), x, y, z);
      n--;
    }
  }
  function scatter(): void {
    const ahead = new Vector3(PLAYER_SPAWN.x + 25, CURB, 0);
    for (let i = 0; i < 26; i++) spawnLitter(ahead, 3, 28);
    for (let i = 0; i < INITIAL_SCATTER - 26; i++) spawnLitter(null, 0, 0);
  }

  // ---- flying bags & wind --------------------------------------------------------------------------
  const wind = uniforms.uWind.value;
  let gustT = rand(5, 9), gustLeft = 0, gustDur = 0, gustDir = 0, gustStrength = 0;
  function updateWind(dt: number): void {
    const lvl = Math.min(run.difficulty, 5);
    const baseDir = Math.PI + 0.7 * Math.sin(time * 0.05) + 0.3 * Math.sin(time * 0.13); // sea breeze from the lake (east)
    const base = 1.1 + 0.25 * lvl + 0.3 * Math.sin(time * 0.31);
    let sx = Math.cos(baseDir) * base, sz = Math.sin(baseDir) * base;
    let gust = 0;
    gustT -= dt;
    if (gustT <= 0 && gustLeft <= 0) {
      gustDur = gustLeft = rand(2.2, 3.4);
      gustDir = baseDir + rand(-0.7, 0.7);
      gustStrength = 3.4 + 0.7 * lvl;
      gustT = Math.max(4, rand(9, 16) - lvl * 1.5);
      onGust();
    }
    if (gustLeft > 0) {
      gustLeft -= dt;
      gust = Math.sin(Math.PI * (1 - gustLeft / gustDur));
      sx += Math.cos(gustDir) * gustStrength * gust;
      sz += Math.sin(gustDir) * gustStrength * gust;
    }
    wind.set(sx, Math.min(1, 0.2 + 0.1 * lvl + gust * 0.8), sz);
  }
  function onGust(): void {
    if (state !== 'play') return;
    const p = player.position;
    let flying = 0;
    for (const it of items) if (it.state === 'fly') flying++;
    const n = Math.min(1 + (run.difficulty >= 2 ? 1 : 0), 2 + run.difficulty - flying);
    for (let i = 0; i < n; i++) {
      // lifted from upwind so it drifts across the player's path
      const d = rand(10, 22);
      const x = p.x - Math.cos(gustDir) * d + rand(-5, 5), z = Math.max(-27, Math.min(27, p.z - Math.sin(gustDir) * d + rand(-5, 5)));
      spawnFlyingBag(x, z);
    }
    if (ctx.fx) { tmp.set(p.x + rand(-6, 6), CURB + 4.5, Math.sign(p.z || 1) * 9.5); ctx.fx.burst('leaves', tmp); }
  }
  function spawnFlyingBag(x: number, z: number): Item {
    const it = newItem('bag', variantOf('bag'));
    it.state = 'fly';
    it.alt = rand(1.75, 2.4); // cruise above standing reach (BAG_REACH): catching one needs a jump
    it.life = rand(14, 22);
    it.pos.set(x, groundY(x, z) + 0.3, z);
    it.quat.setFromAxisAngle(axisY, Math.random() * 6.28);
    it.obj = makeObj(it);
    it.obj.position.copy(it.pos);
    return it;
  }
  function updateFlying(it: Item, dt: number): void {
    it.age += dt;
    it.life -= dt;
    const wander = 0.9;
    const tx = wind.x * 0.85 + Math.sin(it.phase + it.age * 0.7) * wander;
    const tz = wind.z * 0.85 + Math.cos(it.phase * 1.3 + it.age * 0.53) * wander;
    const k = 1 - Math.exp(-1.6 * dt);
    it.vel.x += (tx - it.vel.x) * k;
    it.vel.z += (tz - it.vel.z) * k;
    it.pos.x += it.vel.x * dt;
    it.pos.z += it.vel.z * dt;
    // soft walls: facades, map ends
    if (it.pos.z > 28.5) it.vel.z = -Math.abs(it.vel.z); else if (it.pos.z < -28.5) it.vel.z = Math.abs(it.vel.z);
    if (it.pos.x < X_MIN + 6) it.vel.x = Math.abs(it.vel.x); else if (it.pos.x > X_MAX - 6) it.vel.x = -Math.abs(it.vel.x);
    const g = groundY(it.pos.x, it.pos.z);
    const settleK = it.life < 0 ? Math.max(0, 1 + it.life / 2.5) : Math.min(1, it.age / 1.2);
    const targetY = g + 0.16 + (it.alt + 0.22 * Math.sin(it.age * 1.1 + it.phase) + wind.y * 0.3) * settleK;
    it.pos.y += (targetY - it.pos.y) * (1 - Math.exp(-2.2 * dt));
    tmpQ.setFromAxisAngle(axisY, dt * (0.8 + Math.abs(it.vel.x + it.vel.z) * 0.3));
    it.quat.premultiply(tmpQ);
    it.obj!.position.copy(it.pos);
    it.obj!.quaternion.copy(it.quat);
    it.obj!.rotation.x = Math.sin(it.age * 1.7 + it.phase) * 0.35 * settleK;
    it.obj!.rotation.z = Math.cos(it.age * 1.3 + it.phase) * 0.35 * settleK;
    if (it.life < -2.5) { it.pos.y = g + 0.16; it.quat.setFromAxisAngle(axisY, Math.random() * 6.28); toFloor(it); }
  }

  // ---- power-ups & golden bottle -------------------------------------------------------------------
  const powers: PowerSlot[] = [];
  let powerT = rand(10, 16);
  let goldenT = rand(35, 45);
  function spawnPowerup(forced?: PowerUpKind): void {
    const p = player.position;
    if (!forced && !zonePoint(p, 18, 55, spawnPt)) return;
    // mashmoum is more likely when time runs short
    const kind: PowerUpKind = forced ?? (run.timeLeft < 25 && Math.random() < 0.5 ? 'mashmoum' : pick(POWERUP_KINDS));
    const r = new Group();
    r.position.copy(spawnPt);
    const model = props.powerup(kind);
    const halo = new Mesh(quad, haloMats[kind]);
    halo.position.y = 0.3;
    halo.renderOrder = 3;
    halo.frustumCulled = false;
    model.add(halo);
    r.add(model);
    root.add(r);
    powers.push({ kind, root: r, model, halo, base: spawnPt.clone(), age: 0, phase: Math.random() * 6 });
    ctx.fx?.burst('powerup', spawnPt, { color: POWERUP_COLOR[kind], count: 14 });
  }
  function removePower(i: number): void {
    powers[i].root.removeFromParent();
    powers.splice(i, 1);
  }
  function spawnGolden(forced = false): void {
    if (goldenItem) return;
    if (!forced && !zonePoint(player.position, 35, 85, spawnPt)) return;
    goldenItem = spawnFloor('golden', spawnPt.x, spawnPt.y, spawnPt.z);
    beam.position.copy(spawnPt);
    beam.visible = true;
  }

  // ---- power-up effects ------------------------------------------------------------------------
  function powerOn(kind: PowerUpKind): void {
    const av = player.avatar;
    if (kind === 'tea') { player.setSpeedMultiplier(TEA_SPEED); av.setSprintTrail(true); }
    if (kind === 'chechia') av.setChechia(true);
  }
  function powerOff(kind: PowerUpKind): void {
    const av = player.avatar;
    if (kind === 'tea') { player.setSpeedMultiplier(1); av.setSprintTrail(false); }
    if (kind === 'chechia') av.setChechia(false);
  }
  function allPowersOff(): void {
    for (const k of POWERUP_KINDS) powerOff(k);
    player.avatar.setRadarGlow(false);
    radarOn = false;
  }

  // ---- events helpers ----------------------------------------------------------------------------
  const v3 = (v: Vector3, dy = 0) => new Vector3(v.x, v.y + dy, v.z); // event payloads are kept by listeners
  let bagFullAt = -10;
  let radarOn = false;
  let hintedLitterbug = false;

  function doPickup(it: Item): boolean {
    const r = R.pickup(run, it.kind, it.respilled);
    if (!r.accepted) {
      if (time - bagFullAt > BAG_FULL_THROTTLE) { bagFullAt = time; events.emit('bagFull', { position: v3(player.position) }); }
      return false;
    }
    const pos = v3(it.pos);
    removeItem(it);
    events.emit('pickup', { kind: it.kind, points: r.points, multiplier: r.multiplier, chain: r.chain, position: pos });
    if (r.callout) events.emit('comboUp', { multiplier: r.multiplier, callout: r.callout });
    player.avatar.trigger('pickup');
    if (run.bag.length >= 3) ui.showHint('deposit');
    return true;
  }

  function trick(it: Item, bin: BinSlot): void {
    const r = R.trickShot(run, it.kind);
    removeItem(it);
    bin.gulp = 0.12;
    const pos = v3(bin.base);
    events.emit('trickShot', { kind: it.kind, points: r.points, position: pos });
    if (r.timeAdded > 0) events.emit('timeAdded', { seconds: r.timeAdded });
    crowd?.cheer(pos, 30);
  }

  // ---- kick --------------------------------------------------------------------------------------
  /** Nearest bin in the aim-assist cone ahead of the player, if any. */
  function aimBin(p: Vector3, fx: number, fz: number): BinSlot | null {
    let target: BinSlot | null = null, best = Infinity;
    for (const b of bins) {
      const dx = b.base.x - p.x, dz = b.base.z - p.z, d = Math.hypot(dx, dz);
      if (d < 2 || d > ASSIST_RANGE || (dx * fx + dz * fz) / d < ASSIST_CONE) continue;
      if (d < best) { best = d; target = b; }
    }
    return target;
  }
  const kickList: Item[] = [];
  const offKick = events.on('kick', (e) => {
    if (state !== 'play') return;
    const p = player.position;
    const fx = Math.sin(player.yaw), fz = Math.cos(player.yaw);
    kickList.length = 0;
    for (const it of items) {
      if (it.state !== 'floor' && it.state !== 'phys') continue;
      const dx = it.pos.x - e.position.x, dz = it.pos.z - e.position.z;
      if (dx * dx + dz * dz > KICK_RANGE * KICK_RANGE || Math.abs(it.pos.y - p.y) > 0.8) continue;
      const px = it.pos.x - p.x, pz = it.pos.z - p.z, pl = Math.hypot(px, pz);
      if (pl > 0.25 && (px * fx + pz * fz) / pl < KICK_CONE) continue;
      kickList.push(it);
      if (kickList.length >= KICK_MAX) break;
    }
    if (!kickList.length) return;
    // aim assist: a bin roughly ahead turns the kick into a lob whose error grows with range and angle
    const target = aimBin(p, fx, fz);
    let err = 0;
    if (target) {
      const dx = target.base.x - p.x, dz = target.base.z - p.z, d = Math.hypot(dx, dz);
      err = aimError(d, (Math.acos(Math.min(1, (dx * fx + dz * fz) / d)) * 180) / Math.PI);
    }
    for (const it of kickList) {
      if (target) {
        const ea = Math.random() * Math.PI * 2, er = err * Math.sqrt(Math.random());
        const tx = target.base.x + Math.cos(ea) * er - it.pos.x, tz = target.base.z + Math.sin(ea) * er - it.pos.z;
        // lob over an apex above the rim so it drops in steeply instead of clipping the rim
        const d = Math.hypot(tx, tz);
        const ty = target.base.y + target.model.openingHeight + 0.05;
        const apex = Math.max(ty, it.pos.y) + 0.55 + d * 0.07;
        const up = Math.sqrt(2 * gravity * (apex - it.pos.y));
        const T = (up + Math.sqrt(2 * gravity * (apex - ty))) / gravity;
        toPhys(it, tx / T, up, tz / T);
      } else {
        const side = rand(-0.12, 0.12);
        toPhys(it, (fx + fz * side) * rand(7, 8.5), rand(3.8, 5), (fz - fx * side) * rand(7, 8.5));
      }
    }
  });

  // ---- hooks ---------------------------------------------------------------------------------------
  const playerView = { position: player.position, velocity: player.velocity, sprinting: false };
  const hooks: SessionHooks = {
    throwLitter(from, velocity) {
      const kind = floorKind();
      const it = newItem(kind, variantOf(kind));
      it.pos.copy(from);
      it.quat.setFromAxisAngle(axisY, Math.random() * 6.28);
      toPhys(it, velocity.x, velocity.y, velocity.z);
      events.emit('litterThrown', { position: v3(from) });
      if (!hintedLitterbug && state === 'play') { hintedLitterbug = true; ui.showHint('litterbug'); }
      return it.id;
    },
    caught(position, litterId) {
      if (state !== 'play') return;
      const it = items.find((x) => x.id === litterId);
      if (it) removeItem(it);
      const points = R.caught(run);
      events.emit('caught', { points, position: v3(position) });
      player.avatar.trigger('caught');
    },
    player() {
      playerView.sprinting = Math.hypot(player.velocity.x, player.velocity.z) > 7.5;
      return playerView;
    },
    hitPlayer(direction, speed) {
      if (state !== 'play' || player.stunned) return;
      const r = R.hit(run);
      const p = player.position;
      for (const kind of r.spilled) {
        const it = newItem(kind, variantOf(kind));
        it.respilled = true;
        it.pos.set(p.x, p.y + 0.9, p.z);
        it.quat.setFromAxisAngle(axisY, Math.random() * 6.28);
        const a = Math.random() * Math.PI * 2, s = rand(2.5, 4.5);
        toPhys(it, Math.cos(a) * s + direction.x * 2, rand(4, 6), Math.sin(a) * s + direction.z * 2);
      }
      player.knockback(direction, Math.min(12, 6 + speed * 0.3), RULES.hitStun);
      events.emit('hit', { spilled: r.spilled.length, position: v3(p) });
    },
    isPlaying: () => state === 'play',
  };

  // ---- per-frame work --------------------------------------------------------------------------
  const binPtr = new Vector3();

  function updateItems(dt: number, live: boolean): void {
    const p = player.position;
    const magnet = live && R.magnetActive(run) && run.bag.length < RULES.bagMax;
    // lining up a shot (a bin in the assist cone): cans still in front are left on the floor for the kick
    const fx = Math.sin(player.yaw), fz = Math.cos(player.yaw);
    const aiming = live && aimBin(p, fx, fz) !== null;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (i >= items.length) continue; // removed during this loop
      if (it.state === 'phys' && it.body) {
        const t = it.body.translation(), q = it.body.rotation();
        it.pos.set(t.x, t.y, t.z);
        it.quat.set(q.x, q.y, q.z, q.w);
        it.obj!.position.copy(it.pos);
        it.obj!.quaternion.copy(it.quat);
        it.age += dt;
        // trick shot: in (or balanced on) a bin opening. The hollow walls block side entries, so
        // anything this close to the rim came in from above.
        if (live) {
          let scored = false;
          for (const b of bins) {
            const dx = it.pos.x - b.base.x, dz = it.pos.z - b.base.z;
            const oy = b.base.y + b.model.openingHeight;
            if (dx * dx + dz * dz < (b.model.openingRadius + 0.1) ** 2 && it.pos.y < oy + 0.3 && it.pos.y > oy - 0.45) { trick(it, b); scored = true; break; }
          }
          if (scored) continue;
        }
        const v = it.body.linvel();
        it.still = v.x * v.x + v.y * v.y + v.z * v.z < REST_SPEED * REST_SPEED ? it.still + dt : 0;
        if (it.pos.y < -3) { removeItem(it); continue; }
        if (it.still > REST_TIME || it.body.isSleeping() || it.age > PHYS_MAX_AGE) settle(it);
      } else if (it.state === 'fly') {
        updateFlying(it, dt);
      } else if (it.state === 'magnet') {
        tmp.set(p.x, p.y + 0.7, p.z).sub(it.pos);
        const d = tmp.length();
        it.age += dt;
        const speed = 4 + it.age * 22;
        if (d < 0.45 || !live) {
          it.pos.set(p.x, p.y + 0.5, p.z);
          if (!live || !doPickup(it)) { it.quat.setFromAxisAngle(axisY, 0); toPhys(it, rand(-1, 1), 2, rand(-1, 1)); }
          continue;
        }
        it.pos.addScaledVector(tmp, Math.min(1, (speed * dt) / d));
        tmpQ.setFromAxisAngle(axisY, dt * 12);
        it.quat.premultiply(tmpQ);
        it.obj!.position.copy(it.pos);
        it.obj!.quaternion.copy(it.quat);
        continue;
      }
      if (!live) continue;
      // pickups (floor litter, flying bags)
      const dx = it.pos.x - p.x, dz = it.pos.z - p.z, d2 = dx * dx + dz * dz;
      const dy = it.pos.y - offs[it.kind] - p.y;
      if (it.state === 'floor') {
        if (d2 < RULES.pickupRadius * RULES.pickupRadius && dy > PICK_DY_MIN && dy < PICK_DY_MAX) {
          if (!(aiming && it.kind === 'can' && dx * fx + dz * fz > 0)) doPickup(it); // picked once under / behind Labib
        }
        else if (magnet && d2 < MAGNET_RADIUS * MAGNET_RADIUS && dy > -1 && dy < 3) {
          toIndividual(it);
          it.state = 'magnet'; it.age = 0;
          setShadow(it, false);
        } else if (d2 < 36) {
          ui.showHint('pickup');
          if (it.kind === 'can' && d2 < 9) ui.showHint('kick');
        }
      } else if (it.state === 'fly') {
        if (d2 < 1.0 && dy > -0.4 && dy < BAG_REACH) doPickup(it);
      }
    }
  }

  function updateMarkers(): void {
    let n = 0;
    for (const it of items) {
      if (it.state !== 'floor') continue;
      if (n >= MARKER_CAP) break;
      _m.makeTranslation(it.pos.x, it.pos.y - offs[it.kind], it.pos.z);
      glints.setMatrixAt(n, _m);
      rings.setMatrixAt(n, _m);
      n++;
    }
    glints.count = rings.count = n;
    glints.instanceMatrix.needsUpdate = rings.instanceMatrix.needsUpdate = true;
    for (const k of INSTANCED) for (const b of batches[k]) b.flush();
  }

  function updateRadar(dt: number): void {
    const active = state === 'play' && R.radarActive(run);
    const a = radarMat.uniforms.uAlpha;
    a.value += ((active ? 1 : 0) - a.value) * Math.min(1, dt * 8);
    radarDots.visible = a.value > 0.01;
    if (radarOn && !active) { radarOn = false; player.avatar.setRadarGlow(false); }
    if (!radarDots.visible) return;
    const p = player.position, r2 = RULES.radar.radius * RULES.radar.radius;
    let n = 0;
    for (const it of items) {
      if ((it.pos.x - p.x) ** 2 + (it.pos.z - p.z) ** 2 > r2) continue;
      if (n >= MARKER_CAP) break;
      radarDots.setMatrixAt(n++, _m.makeTranslation(it.pos.x, it.pos.y, it.pos.z));
    }
    radarDots.count = n;
    radarDots.instanceMatrix.needsUpdate = true;
  }

  function updateBins(dt: number, carrying: boolean): void {
    for (const b of bins) {
      b.model.setHighlight(carrying);
      if (b.gulp > 0 && (b.gulp -= dt) <= 0) b.model.bump();
      b.model.update(dt);
    }
  }

  function updatePowers(dt: number, live: boolean): void {
    const p = player.position;
    for (let i = powers.length - 1; i >= 0; i--) {
      const s = powers[i];
      s.age += dt;
      s.model.position.y = 0.55 + 0.12 * Math.sin(s.age * 2.4 + s.phase);
      s.model.rotation.y += dt * 1.6;
      const blink = s.age > POWERUP_LIFE - 4 ? (Math.sin(s.age * 18) > 0 ? 1 : 0.25) : 1;
      s.model.visible = blink > 0.5 || s.age < POWERUP_LIFE - 4;
      if (s.age > POWERUP_LIFE) { removePower(i); continue; }
      if (!live) continue;
      const dx = s.base.x - p.x, dz = s.base.z - p.z;
      if (dx * dx + dz * dz < 1.6 && Math.abs(s.base.y - p.y) < 1.4) {
        const r = R.applyPowerup(run, s.kind);
        powerOn(s.kind);
        events.emit('powerup', { kind: s.kind, duration: r.duration, position: v3(s.base) });
        if (r.timeAdded > 0) events.emit('timeAdded', { seconds: r.timeAdded });
        removePower(i);
      }
    }
  }

  /** Removes the floor item farthest from the player (beyond NEAR_RADIUS), a few at a time. */
  function recycleFar(): void {
    const p = player.position;
    for (let k = 0; k < 5; k++) {
      let far: Item | null = null, fd = NEAR_RADIUS * NEAR_RADIUS;
      for (const it of items) {
        if (it.state !== 'floor' || it.kind === 'golden') continue;
        const d2 = (it.pos.x - p.x) ** 2 + (it.pos.z - p.z) ** 2;
        if (d2 > fd) { fd = d2; far = it; }
      }
      if (!far) return;
      removeItem(far);
    }
  }
  function nearCount(): number {
    const p = player.position;
    let n = 0;
    for (const it of items) if (it.state === 'floor' && (it.pos.x - p.x) ** 2 + (it.pos.z - p.z) ** 2 < NEAR_RADIUS * NEAR_RADIUS) n++;
    return n;
  }
  let spawnT = 0;
  function updateSpawners(dt: number): void {
    const lvl = run.difficulty;
    spawnT -= dt;
    if (spawnT <= 0) {
      spawnT = Math.max(0.3, SPAWN_EVERY - lvl * 0.08);
      if (nearCount() < Math.min(NEAR_MAX, NEAR_BASE + NEAR_PER_LEVEL * lvl)) {
        if (items.length >= MAX_ITEMS - 4) recycleFar(); // the far end of the avenue fills up: move litter to the player
        spawnLitter(player.position, SPAWN_MIN_D, NEAR_RADIUS);
      }
    }
    powerT -= dt;
    if (powerT <= 0) { powerT = rand(...POWERUP_EVERY); if (powers.length < 2) spawnPowerup(); }
    goldenT -= dt;
    if (goldenT <= 0) { goldenT = rand(...GOLDEN_EVERY); spawnGolden(); }
  }

  function handleRules(dt: number): void {
    const evs = R.tick(run, dt);
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      switch (e.type) {
        case 'timeWarning': events.emit('timeWarning', { secondsLeft: e.secondsLeft }); break;
        case 'comboBreak': events.emit('comboBreak', { chain: e.chain }); break;
        case 'powerupEnd': powerOff(e.kind); events.emit('powerupEnd', { kind: e.kind }); break;
        case 'difficulty': crowd?.setDifficulty(e.level); traffic?.setDifficulty(e.level); break;
        case 'runOver': endRun(); return;
      }
    }
  }

  function endRun(): void {
    state = 'over';
    allPowersOff();
    ui.setBinPointer(null);
    ui.showHint(null);
    player.avatar.trigger('victory');
    events.emit('runEnd', { result: R.result(run) });
  }

  function hud(): void {
    ui.updateHud(R.hudState(run));
    if (run.bag.length > 0 && state === 'play') {
      const p = player.position;
      let best: BinSlot | null = null, bd = Infinity;
      for (const b of bins) { const d = (b.base.x - p.x) ** 2 + (b.base.z - p.z) ** 2; if (d < bd) { bd = d; best = b; } }
      ui.setBinPointer(binPtr.set(best!.base.x, best!.base.y + 1.5, best!.base.z));
    } else ui.setBinPointer(null);
  }

  function ambient(dt: number, live: boolean): void {
    time += dt;
    updateWind(dt);
    updateItems(dt, live);
    updatePowers(dt, live);
    beam.visible = !!goldenItem;
    updateMarkers();
    updateRadar(dt);
    updateBins(dt, live && run.bag.length > 0);
    const t = uniforms.uTime.value;
    crowd?.update(dt, t);
    traffic?.update(dt, t);
  }

  // ---- lifecycle -------------------------------------------------------------------------------
  function clearAll(): void {
    for (let i = items.length - 1; i >= 0; i--) removeItem(items[i]);
    for (const k of INSTANCED) for (const b of batches[k]) b.clear();
    while (powers.length) removePower(powers.length - 1);
    goldenItem = null;
    beam.visible = false;
  }

  scatter();

  const session: GameSessionEx = {
    hooks,
    get playing() { return state === 'countdown' || state === 'play'; },
    get locked() { return state !== 'play'; },
    get run() { return run; },

    attach(s) { crowd = s.crowd; traffic = s.traffic; },

    start() {
      clearAll();
      allPowersOff();
      run = R.createRun();
      player.reset(PLAYER_SPAWN, PLAYER_SPAWN_YAW);
      ctx.cameraRig.reset(PLAYER_SPAWN_YAW);
      (ctx.fx as { clear?: () => void }).clear?.();
      crowd?.reset(); traffic?.reset();
      crowd?.setDifficulty(0); traffic?.setDifficulty(0);
      scatter();
      spawnT = 0; powerT = rand(10, 16); goldenT = rand(35, 45); gustT = rand(5, 9); gustLeft = 0;
      bagFullAt = -10; hintedLitterbug = false;
      for (const b of bins) b.gulp = 0;
      state = 'countdown';
      countdown = COUNTDOWN + 0.35; // a beat for the camera glide before "3"
      lastCount = COUNTDOWN + 1;
      ui.setBinPointer(null);
      hud();
    },

    update(dt, frame: InputFrame) {
      if (state === 'countdown') {
        countdown -= dt;
        const n = Math.ceil(countdown);
        if (n < lastCount && n <= COUNTDOWN) {
          lastCount = n;
          if (n > 0) { ui.callout(String(n), 'info'); audio.play('countdown', { pitch: 1 + (COUNTDOWN - n) * 0.06 }); }
        }
        if (countdown <= 0) {
          state = 'play';
          ui.callout('GO!', 'good');
          audio.play('go');
          events.emit('runStart', {});
          ui.showHint('move');
        }
        ambient(dt, false);
        hud();
        return;
      }
      if (state !== 'play') { ambient(dt, false); return; }

      if (frame.radarPressed && R.useRadar(run)) {
        radarOn = true;
        player.avatar.setRadarGlow(true);
        events.emit('radar', { position: v3(player.position) });
      }
      handleRules(dt);
      if (state !== 'play') { ambient(dt, false); return; }
      if (run.elapsed > 20) ui.showHint('radar');

      // deposit at the nearest bin in reach
      if (run.bag.length > 0) {
        const p = player.position;
        for (const b of bins) {
          const dx = b.base.x - p.x, dz = b.base.z - p.z;
          if (dx * dx + dz * dz > RULES.depositRadius * RULES.depositRadius || Math.abs(b.base.y - p.y) > 1.2) continue;
          const d = R.deposit(run);
          b.gulp = DEPOSIT_GULP;
          events.emit('deposit', { items: d.items, points: d.points, timeAdded: d.timeAdded, position: v3(b.base) });
          if (d.timeAdded > 0) events.emit('timeAdded', { seconds: d.timeAdded });
          player.avatar.trigger('deposit');
          break;
        }
      }
      updateSpawners(dt);
      ambient(dt, true);
      hud();
    },

    updateAmbient(dt) { ambient(dt, false); },

    abort() {
      if (state === 'idle') return;
      state = 'idle';
      allPowersOff();
      ui.setBinPointer(null);
      ui.showHint(null);
    },

    dispose() {
      offKick();
      clearAll();
      for (const b of bins) { for (const c of b.colliders) physics.removeCollider(c); b.model.root.removeFromParent(); }
      for (const k of INSTANCED) for (const b of batches[k]) b.dispose();
      for (const o of owned) o.dispose();
      root.removeFromParent();
      glints.dispose(); rings.dispose(); radarDots.dispose();
    },

    debug: {
      counts() {
        let floor = 0, phys = 0, fly = 0;
        for (const it of items) { if (it.state === 'floor') floor++; else if (it.state === 'phys') phys++; else if (it.state === 'fly') fly++; }
        return { items: items.length, floor, phys, fly, powerups: powers.length, bodies: world.bodies.len(), colliders: world.colliders.len() };
      },
      setTime(s) { run.timeLeft = s; },
      litter: () => items.map((it) => ({ x: it.pos.x, y: it.pos.y, z: it.pos.z, kind: it.kind, state: it.state })),
      spawn(kind, x, z) {
        spawnPt.set(x, groundY(x, z), z);
        if (kind === 'bag') spawnFlyingBag(x, z);
        else if (kind === 'golden') spawnGolden(true);
        else if (kind === 'tea' || kind === 'bambalouni' || kind === 'mashmoum' || kind === 'chechia') spawnPowerup(kind);
        else spawnFloor(kind, x, spawnPt.y, z);
      },
    },
  };
  return session;
}
