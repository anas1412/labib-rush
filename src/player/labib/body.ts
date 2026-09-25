// Labib's body, sculpted procedurally in the rest (A-)pose.
//
// Design (from reference photos of the 1992 statues and the cartoon): sandy fennec with a cream
// muzzle, huge ears with pink insides, black nose, thick dark brows and a big grin; a blue one-piece
// jumpsuit with light-blue ribbed collar/cuffs, a green belt and a round chest emblem; white cartoon
// gloves; a green satchel on the right hip (he collects litter in it); bare sandy feet; bushy tail.
//
// Organic parts are signed-distance sculpts meshed with Surface Nets (seamless smooth unions,
// gradient normals, baked SDF ambient occlusion); thin parts (ears, lids, brows, strap, emblem,
// eyes, nose) are parametric surfaces. Output: three skinned geometry groups sharing one skeleton.
import { Color, Vector3 } from 'three';
import type { Quality } from '../../core/types';
import {
  clamp01, sdCapsule, sdEllipsoid, sdRoundBox, sdRoundCone, sdSphere, segT, smax, smin, smoothstep,
  surfaceNets, vnoise, type Sdf,
} from './sdf';
import { GroupBuilder, SoftLabel, col, gridMesh, type AttribFn, type GroupData, type VAttr } from './builder';
import {
  ARM_DIR, BONE_SPECS, EAR_AXIS, EAR_FRONT, EAR_LEN, EYE_FWD, EYE_R, EYE_RIGHT, EYE_UP, FINGER, HAND_X, HAND_Y, HAND_Z,
  HD, HEAD_S, P, TAIL_PTS, bi, hd, toHead,
} from './rig';

/** One level of detail: the three skinned material groups. */
export interface BodySet {
  fur: GroupData; // head, neck, ears, lids, brows, mouth line, feet, tail (fur material)
  cloth: GroupData; // jumpsuit, trims, gloves, satchel, strap, emblem (fabric material, atlas map)
  gloss: GroupData; // eyes + nose (clearcoat material, atlas map)
  triangles: number;
}

/** Result of the body build: plain typed arrays, so it can run in a worker. */
export interface LabibBodyData {
  near: BodySet; // full detail for the quality level
  far: BodySet | null; // coarse LOD (the 'low' sculpt) for the gameplay camera; null at 'low'
  shell: GroupData | null; // coarse fur-bearing surfaces (tail, ears, head) for the shell pass
  shellFarCount: number; // index count of the shell's tail + ears prefix (drawn alone from afar)
  headTop: number; // top of the head (ears excluded), m
  parts: { name: string; tris: number; ms: number }[]; // build breakdown (dev info)
}

const HEAD_MIN = [-0.24, 0.77, -0.19] as const, HEAD_MAX = [0.24, 1.26, 0.335] as const;
const TAIL_MIN = [-0.11, 0.0, -0.44] as const, TAIL_MAX = [0.24, 0.62, -0.03] as const;

// ---------------------------------------------------------------------------------------------
// Palette (sRGB hex → linear)
const C = {
  sand: col(0xd8a468),
  sandDeep: col(0xc58a4f),
  sandLight: col(0xe8c28e),
  cream: col(0xf6ead6),
  pink: col(0xeeaaa0),
  pinkDeep: col(0xd98580),
  earRim: col(0xa66b3c),
  brow: col(0x2a1a10),
  mouth: col(0x4a2616),
  tailTip: col(0x3a2619),
  lash: col(0x2b1a12),
  suit: col(0x2a78d0),
  rib: col(0x86c9f2),
  belt: col(0x2f9a4c),
  glove: col(0xf4f1ea),
  stitch: col(0xc9c3b6),
  bag: col(0x2f6040),
  bagFlap: col(0x284f36),
  strap: col(0x26492f),
  buckle: col(0xc8a45a),
  white: col(0xffffff),
};

const VOXEL: Record<Quality, number> = { low: 1.7, medium: 1.35, high: 1.1, ultra: 0.9 };

// mirrored bone indices (L → R)
const REMAP = new Int32Array(BONE_SPECS.length).map((_, i) => {
  const n = BONE_SPECS[i].name;
  return n.endsWith('L') && BONE_SPECS.some((b) => b.name === n.slice(0, -1) + 'R') ? bi(n.slice(0, -1) + 'R') : i;
});
const remap = (b: number) => REMAP[b];

// frequently used bone ids
const B = {
  hips: bi('hips'), spine: bi('spine'), chest: bi('chest'), neck: bi('neck'), head: bi('head'), nose: bi('nose'), bag: bi('bag'),
  arm: bi('armL'), fore: bi('foreL'), hand: bi('handL'), clav: bi('clavL'),
  thumb: bi('thumbL'), thumb2: bi('thumb2L'), index: bi('indexL'), index2: bi('index2L'), fing: bi('fingL'), fing2: bi('fing2L'),
  thigh: bi('thighL'), shin: bi('shinL'), foot: bi('footL'), toe: bi('toeL'),
  ear: bi('earL'), ear2: bi('ear2L'), ear3: bi('ear3L'), eye: bi('eyeL'), lidU: bi('lidUL'), lidL: bi('lidLL'), brow: bi('browL'),
  tail: [0, 1, 2, 3, 4].map((i) => bi(`tail${i}`)),
};

const soft = new SoftLabel();
const tv = new Vector3();

// =============================================================================================
// HEAD + NECK (fur). The head is sculpted in design space (see rig.hd / HEAD_S); the neck in model space.
const EYE = HD.eye; // design space
const HEAD_C = [0, 1.097, 0] as const;
const hq = [0, 0, 0];

function tuft(x: number, y: number, z: number): number {
  // soft forelock: two rounded locks swept forward over the brow
  let d = sdRoundCone(x, y, z, 0.004, 1.2, 0.045, 0.012, 1.212, 0.092, 0.02, 0.011);
  d = smin(d, sdRoundCone(x, y, z, -0.014, 1.199, 0.042, -0.02, 1.207, 0.085, 0.016, 0.009), 0.012);
  return d;
}

/** Head without grooves, design space. */
function skullD(x: number, y: number, z: number): number {
  const ax = Math.abs(x);
  let d = sdEllipsoid(x, y, z, HEAD_C[0], HEAD_C[1], HEAD_C[2], 0.131, 0.132, 0.13);
  d = smin(d, sdEllipsoid(ax, y, z, 0.064, 1.036, 0.062, 0.07, 0.058, 0.068), 0.06); // cheeks
  d = smin(d, sdEllipsoid(ax, y, z, 0.1, 1.012, -0.012, 0.046, 0.036, 0.048), 0.045); // cheek ruff
  d = smin(d, sdRoundCone(x, y, z, 0, 1.056, 0.075, 0, 1.028, 0.245, 0.064, 0.026), 0.07); // muzzle
  d = smin(d, sdEllipsoid(x, y, z, 0, 1.076, 0.145, 0.04, 0.032, 0.09), 0.04); // nose bridge
  d = smin(d, sdEllipsoid(x, y, z, 0, 1.0, 0.132, 0.045, 0.028, 0.076), 0.035); // chin
  return d;
}

// smile: philtrum + wide grin curling up into the cheeks (left half; mirrored with |x|)
const SMILE: Vector3[] = [
  [0, 1.019, 0.238], [0, 1.006, 0.217], [0.015, 1.002, 0.203], [0.031, 1.006, 0.183], [0.043, 1.016, 0.16], [0.05, 1.03, 0.14], [0.051, 1.042, 0.13],
].map(([x, y, z]) => project(skullD, new Vector3(x, y, z), -0.0006));

function smileDist(x: number, y: number, z: number): number {
  const ax = Math.abs(x);
  // cheap bound: the smile lives in a ~7 cm sphere on the muzzle
  const bd = sdSphere(ax, y, z, 0.03, 1.02, 0.18, 0.075);
  if (bd > 0.03) return bd;
  let d = Infinity;
  for (let i = 0; i < SMILE.length - 1; i++) {
    const a = SMILE[i], b = SMILE[i + 1];
    d = Math.min(d, sdCapsule(ax, y, z, a.x, a.y, a.z, b.x, b.y, b.z, 0));
  }
  return d;
}

const BROW_D = [[0.021, 1.176, 0.138], [0.044, 1.188, 0.133], [0.07, 1.188, 0.118], [0.092, 1.171, 0.094]] as const;
/** Distance to the brow curve (design space, mirrored). */
function browDist(x: number, y: number, z: number): number {
  const ax = Math.abs(x);
  const bd = sdSphere(ax, y, z, 0.056, 1.178, 0.12, 0.05);
  if (bd > 0.04) return bd;
  let d = Infinity;
  for (let i = 0; i < BROW_D.length - 1; i++) {
    const a = BROW_D[i], b = BROW_D[i + 1];
    d = Math.min(d, sdCapsule(ax, y, z, a[0], a[1], a[2], b[0], b[1], b[2], 0));
  }
  return d;
}

function headD(x: number, y: number, z: number): number {
  let d = skullD(x, y, z);
  d = smax(d, -sdSphere(Math.abs(x), y, z, EYE[0], EYE[1], EYE[2], HD.eyeR - 0.0015), 0.01); // eye sockets (skin hugs the eyeball)
  d = smax(d, -(smileDist(x, y, z) - 0.0035), 0.014); // soft smile crease (the crisp line is a separate tube)
  return d;
}

const neckSdf = (x: number, y: number, z: number) =>
  smin(sdRoundCone(x, y, z, 0, 0.79, -0.012, 0, 0.95, -0.006, 0.05, 0.07), sdEllipsoid(x, y, z, 0, 0.905, -0.04, 0.05, 0.062, 0.05), 0.04);
/** Head + neck in model space (no grooves) — for projections & AO. */
function headBase(x: number, y: number, z: number): number {
  toHead(x, y, z, hq);
  return smin(skullD(hq[0], hq[1], hq[2]) * HEAD_S, neckSdf(x, y, z), 0.06);
}
function headSdf(x: number, y: number, z: number): number {
  toHead(x, y, z, hq);
  return smin(headD(hq[0], hq[1], hq[2]) * HEAD_S, neckSdf(x, y, z), 0.06);
}

const headAttr: AttribFn = (mx, my, mz, nx, ny, nz, o) => {
  toHead(mx, my, mz, hq);
  const x = hq[0], y = hq[1], z = hq[2];
  const ax = Math.abs(x);
  o.color(C.sand);
  // crown & back slightly deeper
  o.mix(C.sandDeep, smoothstep(1.12, 1.22, y) * 0.45 + smoothstep(0.0, -0.1, z) * 0.25);
  // cream lower face: muzzle underside, cheeks, chin, throat
  const eyeLine = 1.062 - Math.max(0, z - 0.12) * 0.2 - Math.max(0, ax - 0.055) * 0.4;
  let cream = smoothstep(0.012, -0.02, y - eyeLine) * smoothstep(-0.03, 0.05, z) * smoothstep(0.955, 0.99, y);
  o.mix(C.sandLight, smoothstep(0.0, 0.05, mz) * smoothstep(0.95, 0.88, my) * 0.55); // throat
  // light patches around the eyes (fennec "spectacles")
  const eyeD = sdSphere(ax, y, z, EYE[0], EYE[1], EYE[2], HD.eyeR);
  cream = Math.max(cream, smoothstep(0.028, 0.006, eyeD) * 0.7);
  o.mix(C.cream, cream);
  // warm bridge of the nose and a faint fennec tear line from the inner eye corner
  o.mix(C.sandDeep, smoothstep(0.028, 0.0, ax) * smoothstep(1.052, 1.085, y) * smoothstep(0.12, 0.2, z) * 0.5);
  o.mix(C.sandDeep, smoothstep(0.012, 0.0, sdCapsule(ax, y, z, 0.03, 1.08, 0.14, 0.022, 1.058, 0.19, 0)) * 0.35);
  // darker forelock marking on the crown
  o.mix(C.sandDeep, smoothstep(0.035, 0.0, tuft(x, y, z)) * 0.55);
  // smile line
  const sd = smileDist(x, y, z);
  o.scale(1 - 0.18 * smoothstep(0.012, 0.0, sd)); // soft shadowing in the crease
  // fur: length & comb (flows back from the nose, down the neck)
  let len = 0.005;
  len *= 1 - 0.6 * smoothstep(0.12, 0.22, z); // short on the muzzle
  len += 0.008 * smoothstep(0.075, 0.12, ax) * smoothstep(1.07, 1.0, y) * smoothstep(-0.05, 0.04, z); // cheek fluff
  len += 0.004 * smoothstep(0.03, 0.0, tuft(x, y, z)); // crown tuft
  len *= smoothstep(0.004, 0.02, eyeD); // bare around the eyes
  len *= smoothstep(0.004, 0.012, sd); // clean mouth line
  len *= smoothstep(0.008, 0.02, browDist(x, y, z)); // brows sit on short fur
  len *= smoothstep(0.82, 0.86, my); // nothing under the collar
  o.furLen = len;
  tv.set(x, y - 1.03, z - 0.33);
  if (my < 0.93) tv.set(0, -1, 0);
  tangent(tv, nx, ny, nz, o);
  // skinning: head / neck / chest by height (model space)
  const wHead = smoothstep(0.9, 0.955, my);
  const wChest = smoothstep(0.85, 0.815, my);
  o.w[B.head] += wHead;
  o.w[B.chest] += wChest;
  o.w[B.neck] += Math.max(0, 1 - wHead - wChest);
  bakeAo(o, mx, my, mz, nx, ny, nz, headAo, 0.45);
};
const headAo: Sdf = (x, y, z) => (y > 0.92 ? headBase(x, y, z) : Math.min(headBase(x, y, z), suitSdf(x, y, z)));

/** Shell pass variant: the coarse shell mesh can't resolve the mouth/eye details, keep it off the muzzle. */
const headShellAttr: AttribFn = (mx, my, mz, nx, ny, nz, o) => {
  headAttr(mx, my, mz, nx, ny, nz, o);
  toHead(mx, my, mz, hq);
  const eyeD = sdSphere(Math.abs(hq[0]), hq[1], hq[2], EYE[0], EYE[1], EYE[2], HD.eyeR);
  o.furLen *= smoothstep(0.005, 0.03, eyeD) * smoothstep(0.19, 0.1, hq[2]) * smoothstep(0.012, 0.035, browDist(hq[0], hq[1], hq[2]));
};

// =============================================================================================
// JUMPSUIT (cloth)
const S = P.shoulder, E = P.elbow, W = P.wrist, H = P.hip, K = P.knee, AN = P.ankle;
const SLEEVE_END = [W[0] - ARM_DIR[0] * 0.03, W[1] - ARM_DIR[1] * 0.03, W[2]] as const;
const LEG_END = [AN[0], AN[1] + 0.024, AN[2]] as const;

function torso(x: number, y: number, z: number): number {
  let t = sdEllipsoid(x, y, z, 0, 0.73, -0.012, 0.145, 0.114, 0.106); // chest
  t = smin(t, sdEllipsoid(x, y, z, 0, 0.585, 0.016, 0.148, 0.122, 0.128), 0.08); // round belly
  t = smin(t, sdEllipsoid(x, y, z, 0, 0.5, -0.004, 0.138, 0.07, 0.112), 0.06); // pelvis
  return t;
}
const upperArm = (ax: number, y: number, z: number) => sdRoundCone(ax, y, z, S[0], S[1], S[2], E[0], E[1], E[2], 0.051, 0.044);
const foreArm = (ax: number, y: number, z: number) => sdRoundCone(ax, y, z, E[0], E[1], E[2], SLEEVE_END[0], SLEEVE_END[1], SLEEVE_END[2], 0.044, 0.037);
const thigh = (ax: number, y: number, z: number) => sdRoundCone(ax, y, z, H[0], H[1], H[2], K[0], K[1], K[2], 0.078, 0.059);
const shin = (ax: number, y: number, z: number) => sdRoundCone(ax, y, z, K[0], K[1], K[2], LEG_END[0], LEG_END[1], LEG_END[2], 0.059, 0.051);

function suitSdf(x: number, y: number, z: number): number {
  const ax = Math.abs(x);
  const t = torso(x, y, z);
  let d = smin(t, sdSphere(ax, y, z, S[0] - 0.004, S[1] - 0.004, S[2], 0.054), 0.05);
  d = smin(d, smin(upperArm(ax, y, z), foreArm(ax, y, z), 0.012), 0.035);
  d = smin(d, smin(thigh(ax, y, z), shin(ax, y, z), 0.012), 0.045);
  // neckline: the suit rises into a neck-hugging band whose top edge (tilted like the collar ring) ends
  // inside the ribbed collar torus, so no voxel-stepped opening or neck fur shows under the collar
  const band = smax(sdRoundCone(x, y, z, 0, 0.76, -0.01, 0, 0.84, -0.01, 0.072, 0.067), y + 0.12 * z - 0.8385, 0.004);
  return smin(d, band, 0.03);
}

function suitWeights(x: number, y: number, z: number, o: VAttr, scale = 1): void {
  const ax = Math.abs(x);
  const t = torso(x, y, z);
  const side = x >= 0;
  const L = (b: number) => (side ? b : REMAP[b]);
  soft.clear();
  // torso → hips/spine/chest by height (added below with its own share)
  soft.add(t, TORSO, 0.02);
  soft.add(sdSphere(ax, y, z, S[0], S[1], S[2], 0.05), L(B.arm), 0.02);
  soft.add(upperArm(ax, y, z), L(B.arm), 0.01);
  soft.add(foreArm(ax, y, z), L(B.fore), 0.008);
  soft.add(thigh(ax, y, z), L(B.thigh), 0.014);
  soft.add(shin(ax, y, z), L(B.shin), 0.008);
  // resolve into a scratch, then split the torso share by height
  scratch.fill(0);
  soft.resolve(scratch);
  const torsoShare = scratch[scratch.length - 1];
  for (let i = 0; i < scratch.length - 1; i++) o.w[i] += scratch[i] * scale;
  const wh = smoothstep(0.62, 0.54, y), wc = smoothstep(0.66, 0.76, y);
  o.w[B.hips] += torsoShare * wh * scale;
  o.w[B.chest] += torsoShare * wc * scale;
  o.w[B.spine] += torsoShare * Math.max(0, 1 - wh - wc) * scale;
}
const TORSO = BONE_SPECS.length; // pseudo bone: torso share, split by height
const scratch = new Float32Array(BONE_SPECS.length + 1);

const suitAttr: AttribFn = (x, y, z, nx, ny, nz, o) => {
  o.color(C.suit);
  // wrinkle mask (aFur.y on cloth): fabric bunches at elbows, knees, inner arms and around the belt
  const ax = Math.abs(x);
  o.ear = Math.max(
    smoothstep(0.075, 0.015, Math.hypot(ax - E[0], y - E[1], z - E[2])),
    smoothstep(0.085, 0.02, Math.hypot(ax - K[0], y - K[1], z - K[2])),
    smoothstep(0.05, 0.02, Math.abs(y - 0.603)) * 0.7,
    smoothstep(0.1, 0.02, Math.hypot(ax - S[0] + 0.02, y - S[1] + 0.06, z - S[2])) * 0.6,
  );
  bakeAo(o, x, y, z, nx, ny, nz, suitAo, 0.8);
  suitWeights(x, y, z, o);
};
const suitAo: Sdf = (x, y, z) => {
  let d = suitSdf(x, y, z);
  if (y > 0.74) d = Math.min(d, headBase(x, y, z));
  if (x < -0.1 && y > 0.4 && y < 0.68) d = Math.min(d, bagSdf(x, y, z));
  return d;
};


/**
 * Ribbed collar, wrist & ankle cuffs and the belt: crisp parametric bands wrapped around the suit
 * (the suit surface radius is found per angle by bisection), so their edges stay clean at any voxel size.
 */
function buildTrims(b: GroupBuilder, q: number): void {
  const na = Math.round(44 / q);
  const pt = new Vector3(), d = new Vector3(), e1 = new Vector3(), e2 = new Vector3();
  const surfR = (c: Vector3, ax: Vector3, t: number, dir: Vector3) => {
    // first exit along the ray (never jump into a neighbouring limb), then bisect
    let lo = 0, hi = 0.004;
    const at = (r: number) => suitSdf(c.x + ax.x * t + dir.x * r, c.y + ax.y * t + dir.y * r, c.z + ax.z * t + dir.z * r);
    while (hi < 0.3 && at(hi) < 0) { lo = hi; hi += 0.004; }
    for (let i = 0; i < 14; i++) {
      const m = (lo + hi) / 2;
      pt.copy(c).addScaledVector(ax, t).addScaledVector(dir, m);
      if (suitSdf(pt.x, pt.y, pt.z) < 0) lo = m; else hi = m;
    }
    return (lo + hi) / 2;
  };
  interface BandOpts { c: Vector3; axis: Vector3; hl: number; th: number; ribs: number; color: Color; mirror: boolean }
  const band = ({ c, axis, hl, th, ribs, color, mirror }: BandOpts) => {
    e1.set(1, 0, 0);
    if (Math.abs(axis.x) > 0.9) e1.set(0, 0, 1);
    e1.addScaledVector(axis, -e1.dot(axis)).normalize();
    e2.crossVectors(axis, e1);
    // closed profile loop in (t, offset): flat top with rounded edges, inner side hidden in the suit
    const rr = Math.min(th * 0.9, hl * 0.45);
    const prof: [number, number][] = [[-hl, -0.003]];
    for (let i = 0; i <= 3; i++) { const a = Math.PI - (i / 3) * (Math.PI / 2); prof.push([-hl + rr + Math.cos(a) * rr, th - rr + Math.sin(a) * rr]); }
    for (let i = 1; i <= 3; i++) prof.push([-hl + rr + ((2 * (hl - rr)) * i) / 4, th]);
    for (let i = 0; i <= 3; i++) { const a = Math.PI / 2 - (i / 3) * (Math.PI / 2); prof.push([hl - rr + Math.cos(a) * rr, th - rr + Math.sin(a) * rr]); }
    prof.push([hl, -0.003], [0, -0.004]);
    const radius = new Float32Array((prof.length + 1) * na);
    for (let r = 0; r < prof.length; r++)
      for (let k = 0; k < na; k++) {
        const th2 = (k / na) * Math.PI * 2;
        d.copy(e1).multiplyScalar(Math.cos(th2)).addScaledVector(e2, Math.sin(th2));
        radius[r * na + k] = surfR(c, axis, prof[r][0], d);
      }
    const mesh = gridMesh(prof.length, na, true, (r, k, out) => {
      const rr2 = r % prof.length;
      const [t, off] = prof[rr2];
      const a = (k / na) * Math.PI * 2;
      d.copy(e1).multiplyScalar(Math.cos(a)).addScaledVector(e2, Math.sin(a));
      const rib = ribs && off > 0 ? 0.0009 * Math.cos(a * ribs) * (off / th) : 0;
      out.copy(c).addScaledVector(axis, t).addScaledVector(d, radius[rr2 * na + k] + off + rib);
    }, true);
    let vi = 0;
    const attr: AttribFn = (x, y, z, _nx, _ny, _nz, o) => {
      const r = Math.floor(vi++ / na) % prof.length;
      o.color(color);
      if (!ribs) o.scale(0.82 + 0.18 * smoothstep(0.004, 0.0015, Math.abs(Math.abs(prof[r][0]) - hl + 0.0035))); // stitched edges
      suitWeights(x, y, z, o);
    };
    b.add(mesh, attr);
    if (mirror) { vi = 0; b.add(mesh, attr, { mirror: true, remap }); }
  };
  const armAxis = new Vector3(...ARM_DIR);
  band({ c: new Vector3(W[0], W[1], W[2]).addScaledVector(armAxis, -0.014), axis: armAxis, hl: 0.011, th: 0.0038, ribs: 28, color: C.rib, mirror: true });
  band({ c: new Vector3(AN[0], AN[1] + 0.018, AN[2]), axis: new Vector3(0, 1, 0), hl: 0.011, th: 0.0038, ribs: 34, color: C.rib, mirror: true });
  band({ c: new Vector3(0, 0.603, 0), axis: new Vector3(0, 1, 0), hl: 0.02, th: 0.0055, ribs: 0, color: C.belt, mirror: false });

  // collar: ribbed torus around the neck opening, lower at the front
  const nc = Math.round(12 / q);
  const collar = gridMesh(nc, na, true, (r, k, out) => {
    const a = (k / na) * Math.PI * 2, bta = (r / nc) * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    const rm = 0.0118 * (1 + 0.07 * Math.cos(a * 40) * Math.max(0, Math.cos(bta - 0.6)));
    const R = 0.066 + Math.cos(bta) * rm;
    const z = sa * R - 0.01;
    out.set(ca * R, 0.838 - z * 0.12 + Math.sin(bta) * rm, z);
  });
  b.add(collar, (x, y, z, _nx, _ny, _nz, o) => { o.color(C.rib); suitWeights(x, y, z, o, 0.75); o.w[B.neck] += 0.25; });
}

// =============================================================================================
// GLOVES (cloth, left hand in hand-local coordinates u,v,w; mirrored for the right)
type F3 = readonly [number, number, number];
const fingerSeg = (u: number, v: number, w: number, a: F3, b: F3, ra: number, rb: number) => sdRoundCone(u, v, w, a[0], a[1], a[2], b[0], b[1], b[2], ra, rb);

function gloveParts(u: number, v: number, w: number, out: Float32Array): number {
  const palm = smin(
    sdEllipsoid(u, v, w, 0.046, 0.0, 0.0, 0.044, 0.02, 0.04),
    sdCapsule(u, v, w, 0.07, 0.001, -0.025, 0.07, 0.001, 0.027, 0.0165), 0.02);
  const cuff = sdRoundCone(u, v, w, -0.032, 0, 0, 0.012, 0, 0, 0.031, 0.028);
  const t1 = fingerSeg(u, v, w, FINGER.thumb[0], FINGER.thumb[1], 0.0135, 0.0128);
  const t2 = fingerSeg(u, v, w, FINGER.thumb[1], FINGER.thumb[2], 0.0128, 0.0118);
  const i1 = fingerSeg(u, v, w, FINGER.index[0], FINGER.index[1], 0.0128, 0.0124);
  const i2 = fingerSeg(u, v, w, FINGER.index[1], FINGER.index[2], 0.0124, 0.0118);
  const m1 = fingerSeg(u, v, w, FINGER.middle[0], FINGER.middle[1], 0.013, 0.0126);
  const m2 = fingerSeg(u, v, w, FINGER.middle[1], FINGER.middle[2], 0.0126, 0.012);
  const r1 = fingerSeg(u, v, w, FINGER.ring[0], FINGER.ring[1], 0.0122, 0.0118);
  const r2 = fingerSeg(u, v, w, FINGER.ring[1], FINGER.ring[2], 0.0118, 0.0112);
  out[0] = palm; out[1] = cuff; out[2] = t1; out[3] = t2; out[4] = i1; out[5] = i2; out[6] = Math.min(m1, r1); out[7] = Math.min(m2, r2);
  let d = smin(palm, cuff, 0.02);
  d = smin(d, smin(t1, t2, 0.006), 0.012);
  d = smin(d, smin(i1, i2, 0.005), 0.007);
  d = smin(d, smin(m1, m2, 0.005), 0.007);
  d = smin(d, smin(r1, r2, 0.005), 0.007);
  return d;
}
const gp = new Float32Array(8);
const gloveSdf: Sdf = (u, v, w) => gloveParts(u, v, w, gp);
const GLOVE_BONES = () => [B.hand, B.hand, B.thumb, B.thumb2, B.index, B.index2, B.fing, B.fing2];

const gloveAttr: AttribFn = (u, v, w, nu, nv, nw, o) => {
  // (u,v,w) are hand-local here; the caller transforms positions afterwards
  o.color(C.glove);
  // three stitch lines on the back of the glove (classic cartoon glove)
  if (v > 0) {
    const along = smoothstep(0.004, 0.012, u) * smoothstep(0.058, 0.048, u);
    for (const ww of [-0.013, 0, 0.013]) o.mix(C.stitch, along * smoothstep(0.0022, 0.0008, Math.abs(w - ww)) * 0.9);
  }
  gloveParts(u, v, w, gp);
  const bones = GLOVE_BONES();
  soft.clear();
  for (let i = 0; i < 8; i++) soft.add(gp[i], bones[i], i < 2 ? 0.01 : 0.004);
  soft.resolve(o.w);
  // cuff end blends into the forearm
  const wf = smoothstep(-0.005, -0.03, u);
  if (wf > 0) { for (let i = 0; i < o.w.length; i++) o.w[i] *= 1 - wf; o.w[B.fore] += wf; }
  bakeAo(o, u, v, w, nu, nv, nw, gloveSdf, 0.6);
};

// =============================================================================================
// FEET (fur, left; mirrored)
const FX = P.ankle[0];
/** Distance to the two shallow toe creases on top of the foot (they fade out before the front face). */
const toeCrease = (x: number, y: number, z: number) =>
  Math.min(sdCapsule(x, y, z, FX + 0.0155, 0.05, 0.088, FX + 0.0165, 0.041, 0.128, 0), sdCapsule(x, y, z, FX - 0.0155, 0.05, 0.088, FX - 0.0165, 0.041, 0.128, 0));
function footSdf(x: number, y: number, z: number): number {
  let d = sdEllipsoid(x, y, z, FX, 0.04, 0.05, 0.054, 0.04, 0.1);
  d = smin(d, sdEllipsoid(x, y, z, FX, 0.018, 0.045, 0.058, 0.02, 0.112), 0.02); // wide, flat sole
  d = smin(d, sdSphere(x, y, z, FX, 0.046, -0.03, 0.044), 0.03);
  // three toe pads: a gently scalloped front silhouette
  d = smin(d, sdEllipsoid(x, y, z, FX + 0.031, 0.026, 0.122, 0.02, 0.022, 0.024), 0.012);
  d = smin(d, sdEllipsoid(x, y, z, FX, 0.029, 0.133, 0.022, 0.024, 0.025), 0.012);
  d = smin(d, sdEllipsoid(x, y, z, FX - 0.031, 0.026, 0.122, 0.02, 0.022, 0.024), 0.012);
  d = smin(d, sdRoundCone(x, y, z, FX, 0.05, -0.012, FX, 0.15, -0.012, 0.041, 0.036), 0.035);
  d = smax(d, -(toeCrease(x, y, z) - 0.0022), 0.005); // shallow creases, no pits
  return smax(d, -y, 0.012); // flat sole on the ground
}
const footAttr: AttribFn = (x, y, z, nx, ny, nz, o) => {
  o.color(C.sand).mix(C.sandLight, smoothstep(0.06, 0.13, z) * 0.8);
  o.mix(C.sandDeep, smoothstep(0.012, 0.0, y) * 0.8);
  o.scale(1 - 0.3 * smoothstep(0.007, 0.0015, toeCrease(x, y, z))); // toe separations read by colour
  o.furLen = 0.0045 * smoothstep(0.0, 0.015, y) * smoothstep(0.14, 0.12, y);
  tangent(tv.set(0, -0.3, 1), nx, ny, nz, o);
  const wt = smoothstep(0.075, 0.11, z);
  const ws = smoothstep(0.1, 0.14, y);
  o.w[B.toe] += wt * (1 - ws);
  o.w[B.foot] += (1 - wt) * (1 - ws);
  o.w[B.shin] += ws;
  bakeAo(o, x, y, z, nx, ny, nz, footAo, 0.7);
};
const footAo: Sdf = (x, y, z) => Math.min(footSdf(x, y, z), suitSdf(x, y, z), y + 0.0); // + ground contact

// =============================================================================================
// TAIL (fur)
const TAIL_R = [0.03, 0.062, 0.092, 0.106, 0.094, 0.042];
function tailSeg(x: number, y: number, z: number, i: number): number {
  const a = TAIL_PTS[i], b = TAIL_PTS[i + 1];
  return sdRoundCone(x, y, z, a[0], a[1], a[2], b[0], b[1], b[2], TAIL_R[i], TAIL_R[i + 1]);
}
function tailSdf(x: number, y: number, z: number): number {
  let d = tailSeg(x, y, z, 0);
  for (let i = 1; i < 5; i++) d = smin(d, tailSeg(x, y, z, i), 0.04);
  // fluffy clumps
  const b = TAIL_PTS[0];
  const fromBase = Math.hypot(x - b[0], y - b[1], z - b[2]);
  return d + 0.006 * vnoise(x * 38, y * 38, z * 38) * smoothstep(0.05, 0.12, fromBase);
}
const tailAttr: AttribFn = (x, y, z, nx, ny, nz, o) => {
  // arc position along the tail (0 base → 1 tip)
  let best = Infinity, s = 0, seg = 0;
  for (let i = 0; i < 5; i++) {
    const d = tailSeg(x, y, z, i);
    if (d < best) { best = d; seg = i; }
  }
  const a = TAIL_PTS[seg], b = TAIL_PTS[seg + 1];
  s = (seg + segT(x, y, z, a[0], a[1], a[2], b[0], b[1], b[2])) / 5;
  o.color(C.sand).mix(C.sandLight, smoothstep(0.2, -0.6, ny) * 0.6);
  // the tip darkens gradually over the last quarter (no hard cap)
  o.mix(C.sandDeep, smoothstep(0.55, 0.78, s) * 0.55).mix(C.tailTip, smoothstep(0.74, 1.0, s) * 0.92);
  o.furLen = 0.012 + 0.014 * smoothstep(0.05, 0.4, s);
  o.tipWhite = 0.15 * (1 - smoothstep(0.8, 0.9, s));
  tangent(tv.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]), nx, ny, nz, o);
  soft.clear();
  for (let i = 0; i < 5; i++) soft.add(tailSeg(x, y, z, i), B.tail[i], 0.02);
  soft.resolve(o.w);
  bakeAo(o, x, y, z, nx, ny, nz, tailAo, 0.5);
};
const tailAo: Sdf = (x, y, z) => Math.min(tailSdf(x, y, z), suitSdf(x, y, z));

// =============================================================================================
// SATCHEL (cloth) on the right hip, hanging from the bag bone
const BAG_C = [-0.182, 0.525, -0.035] as const;
function bagBody(x: number, y: number, z: number): number {
  const puff = 0.004 * (1 - Math.min(1, Math.abs(z - BAG_C[2]) / 0.085) ** 2);
  return sdRoundBox(x, y, z, BAG_C[0], BAG_C[1], BAG_C[2], 0.023 + puff, 0.068, 0.088, 0.018);
}
const bagFlap = (x: number, y: number, z: number) => sdRoundBox(x, y, z, BAG_C[0] - 0.025, BAG_C[1] + 0.03, BAG_C[2], 0.0035, 0.042, 0.09, 0.0034);
const bagBuckle = (x: number, y: number, z: number) => sdRoundBox(x, y, z, BAG_C[0] - 0.0295, BAG_C[1] - 0.004, BAG_C[2], 0.0022, 0.012, 0.013, 0.0018);
function bagSdf(x: number, y: number, z: number): number {
  return Math.min(smin(bagBody(x, y, z), bagFlap(x, y, z), 0.003), bagBuckle(x, y, z));
}
const bagAttr: AttribFn = (x, y, z, nx, ny, nz, o) => {
  o.color(C.bag);
  o.mix(C.bagFlap, smoothstep(0.001, -0.001, bagFlap(x, y, z)));
  o.mix(C.buckle, smoothstep(0.0008, -0.0008, bagBuckle(x, y, z)));
  // stitched seam around the side panel
  const seam = Math.abs(sdRoundBox(x, y, z, BAG_C[0], BAG_C[1], BAG_C[2], 0.033, 0.062, 0.082, 0.012));
  o.mix(C.strap, smoothstep(0.0025, 0.0008, seam) * 0.5);
  o.w[B.bag] = 1;
  bakeAo(o, x, y, z, nx, ny, nz, bagSdf, 0.6);
};

// =============================================================================================
// helpers

/** Projects p onto the level set f = offset (Newton along the gradient). */
function project(f: Sdf, p: Vector3, offset: number): Vector3 {
  const e = 0.0005;
  for (let i = 0; i < 8; i++) {
    const d = f(p.x, p.y, p.z) - offset;
    const gx = (f(p.x + e, p.y, p.z) - f(p.x - e, p.y, p.z)) / (2 * e);
    const gy = (f(p.x, p.y + e, p.z) - f(p.x, p.y - e, p.z)) / (2 * e);
    const gz = (f(p.x, p.y, p.z + e) - f(p.x, p.y, p.z - e)) / (2 * e);
    const g2 = gx * gx + gy * gy + gz * gz || 1;
    p.x -= (d * gx) / g2; p.y -= (d * gy) / g2; p.z -= (d * gz) / g2;
  }
  return p;
}
function gradient(f: Sdf, x: number, y: number, z: number, out: Vector3): Vector3 {
  const e = 0.0005;
  return out.set(f(x + e, y, z) - f(x - e, y, z), f(x, y + e, z) - f(x, y - e, z), f(x, y, z + e) - f(x, y, z - e)).normalize();
}

/** Writes the component of `dir` tangent to the surface normal into o.comb. */
function tangent(dir: Vector3, nx: number, ny: number, nz: number, o: VAttr): void {
  const d = dir.x * nx + dir.y * ny + dir.z * nz;
  o.comb.set(dir.x - nx * d, dir.y - ny * d, dir.z - nz * d);
  const l = o.comb.length();
  if (l > 1e-6) o.comb.multiplyScalar(1 / l);
}

/** SDF ambient occlusion (a few samples along the normal), multiplied into the vertex colour. */
function bakeAo(o: VAttr, x: number, y: number, z: number, nx: number, ny: number, nz: number, f: Sdf, strength: number): void {
  let occ = 0, w = 1;
  for (let i = 1; i <= 3; i++) {
    const h = 0.007 * i;
    occ += (h - f(x + nx * h, y + ny * h, z + nz * h)) * w;
    w *= 0.6;
  }
  const ao = clamp01(1 - strength * 15 * occ);
  o.scale(0.4 + 0.6 * ao);
}

// =============================================================================================
// Parametric parts

/** Ear sheet (left), in ear-bone space → model. Broad and spoon-shaped, cupped, thick at the base, pointed tip. */
function buildEar(b: GroupBuilder, q: number): void {
  const nv = Math.round(38 / q), nphi = Math.round(36 / q);
  const V0 = -0.14;
  const X = new Vector3().crossVectors(EAR_AXIS, EAR_FRONT);
  const Y = EAR_AXIS, Z = EAR_FRONT;
  const base = new Vector3(...P.earBase);
  const EAR_W = 0.138; // max half width
  const W_PTS: [number, number][] = [[-0.14, 0.4], [0, 0.5], [0.12, 0.8], [0.3, 0.98], [0.44, 1.0], [0.6, 0.88], [0.74, 0.66], [0.86, 0.42], [0.94, 0.22], [1, 0]];
  const halfW = (v: number) => {
    for (let i = 0; i < W_PTS.length - 1; i++) {
      const [va, fa] = W_PTS[i], [vb, fb] = W_PTS[i + 1];
      if (v > vb) continue;
      const t = (v - va) / (vb - va);
      // smooth through the body of the ear, straight edges into a crisp point at the tip
      return EAR_W * (fa + (fb - fa) * (va >= 0.86 ? t : t * t * (3 - 2 * t)));
    }
    return 0;
  };
  const vAt = (r: number) => V0 + (1 - V0) * (1 - (1 - r / nv) ** 1.25);
  const pos = (v: number, u: number, side: number, out: Vector3) => {
    const hw = halfW(v);
    const D = 0.044 * (1 - clamp01(v)) ** 0.7 * smoothstep(-0.14, 0.06, v);
    const cup = -D * (1 - u * u) - 0.06 * clamp01(v) ** 2;
    const T = (0.016 * (1 - clamp01(v)) + 0.0045 * clamp01(v)) * (v < 0 ? 1.3 : 1);
    // sheet normal tilts with the cup slope
    const slope = hw > 1e-5 ? (2 * D * u) / hw : 0;
    const nX = slope, nZ = 1;
    const nl = Math.hypot(nX, nZ);
    const off = (T / 2) * side;
    out.copy(base)
      .addScaledVector(X, u * hw + (nX / nl) * off)
      .addScaledVector(Y, v * EAR_LEN)
      .addScaledVector(Z, cup + (nZ / nl) * off);
    return out;
  };
  const mesh = gridMesh(nv, nphi, true, (r, c, out) => {
    const phi = (c / nphi) * Math.PI * 2;
    const v = vAt(r);
    pos(v, Math.cos(phi), Math.sin(phi), out);
  });
  // attribute pass needs (v, u, side) per vertex: recompute from indices
  const attr: AttribFn = (_x, _y, _z, nx, ny, nz, o) => {
    const id = vi++;
    const r = Math.floor(id / nphi), c = id % nphi;
    const phi = (c / nphi) * Math.PI * 2;
    const v = vAt(r), u = Math.cos(phi), front = Math.sin(phi);
    const au = Math.abs(u);
    o.ear = 1;
    if (front > 0) {
      // pink skin in the bowl, sandy rolled rim, white fringes along the inner edges
      const inner = smoothstep(0.84, 0.66, au) * smoothstep(-0.04, 0.08, v) * smoothstep(0.97, 0.85, v);
      o.color(C.sand).mix(C.cream, smoothstep(0.93, 0.8, au) * 0.6).mix(C.pink, inner).mix(C.pinkDeep, inner * (1 - clamp01(v * 1.3)) * 0.55);
      const fringe = smoothstep(0.38, 0.62, au) * smoothstep(0.9, 0.76, au) * (1 - smoothstep(0.5, 0.82, v));
      o.furLen = 0.02 * fringe * (0.55 + 0.45 * (1 - v)) + 0.003 * smoothstep(0.8, 0.95, au);
      o.tipWhite = fringe;
      tangent(tv.copy(Y).multiplyScalar(0.7).addScaledVector(X, -Math.sign(u) * 0.7).addScaledVector(Z, 0.3), nx, ny, nz, o);
    } else {
      // back: light at the root, warming toward the tip, with a darker rim so the shape reads from behind
      o.color(C.sandLight).mix(C.sand, smoothstep(-0.05, 0.3, v)).mix(C.sandDeep, smoothstep(0.35, 1, v) * 0.5);
      o.mix(C.earRim, smoothstep(0.8, 0.97, au) * 0.65);
      o.furLen = 0.0035;
      tangent(tv.copy(Y), nx, ny, nz, o);
    }
    const w1 = 1 - smoothstep(0.2, 0.42, v), w3 = smoothstep(0.55, 0.78, v);
    const wh = smoothstep(0.02, -0.1, v);
    o.w[B.head] += wh;
    o.w[B.ear] += w1 * (1 - wh);
    o.w[B.ear3] += w3;
    o.w[B.ear2] += Math.max(0, 1 - w1 - w3);
  };
  let vi = 0;
  b.add(mesh, attr);
  vi = 0;
  b.add(mesh, attr, { mirror: true, remap });

  // soft white fur locks rising out of the bowl from the inner-ear base and curling forward (real geometry,
  // so they read at every quality; the shell pass adds fuzz at high/ultra): [u, v, length, fan, forward curl]
  const TUFTS: [number, number, number, number, number][] = [
    [-0.46, 0.06, 0.07, -0.55, 0.03], [-0.3, 0.03, 0.09, -0.32, 0.04], [-0.12, 0.01, 0.105, -0.1, 0.05], [0.04, 0.0, 0.095, 0.06, 0.046],
    [0.2, 0.02, 0.1, 0.22, 0.05], [0.36, 0.04, 0.085, 0.4, 0.04], [0.5, 0.07, 0.065, 0.6, 0.03],
  ];
  const root = new Vector3(), p1 = new Vector3(), p2 = new Vector3(), c = new Vector3(), t = new Vector3(), n = new Vector3(), s2 = new Vector3();
  const ns = Math.round(10 / q), na = 6;
  for (const [u0, v0, len, fan, curl] of TUFTS) {
    pos(v0, u0, 1, root).addScaledVector(Z, -0.004);
    const dir = new Vector3().copy(Y).addScaledVector(X, fan * 0.5).addScaledVector(Z, 0.5).normalize();
    p1.copy(root).addScaledVector(dir, len * 0.5).addScaledVector(Z, -0.004);
    p2.copy(root).addScaledVector(dir, len).addScaledVector(Z, curl).addScaledVector(X, fan * 0.025);
    const bez = (tt: number, out: Vector3) =>
      out.copy(root).multiplyScalar((1 - tt) ** 2).addScaledVector(p1, 2 * (1 - tt) * tt).addScaledVector(p2, tt * tt);
    const tuftMesh = gridMesh(ns, na, true, (r, k, out) => {
      const tt = r / ns;
      bez(tt, c);
      bez(Math.min(1, tt + 0.02), t).sub(bez(Math.max(0, tt - 0.02), s2)).normalize();
      n.copy(Z).addScaledVector(t, -Z.dot(t)).normalize();
      s2.crossVectors(t, n);
      // flat lock: wide at the root, bulging a little, tapering to a soft point
      const rad = 0.0105 * Math.sin(Math.PI * (0.18 + 0.82 * tt)) ** 0.7 * (1 - tt) ** 0.6 + 0.0004;
      const a = (k / na) * Math.PI * 2;
      out.copy(c).addScaledVector(s2, Math.cos(a) * rad).addScaledVector(n, Math.sin(a) * rad * 0.4);
    }, true);
    // bend the normals toward the ear's front (hair-card trick): the thin locks shade like the bowl they
    // grow from instead of turning into dark spikes on the shadow side
    const tn = tuftMesh.normals;
    for (let i = 0; i < tn.length; i += 3) {
      tv.set(tn[i] * 0.35 + Z.x, tn[i + 1] * 0.35 + Z.y, tn[i + 2] * 0.35 + Z.z).normalize();
      tn[i] = tv.x; tn[i + 1] = tv.y; tn[i + 2] = tv.z;
    }
    let ti = 0;
    const tAttr: AttribFn = (x, y, z, nx, ny, nz, o) => {
      const tt = Math.floor(ti++ / na) / ns;
      o.color(C.pink).mix(C.cream, smoothstep(0.0, 0.4, tt)).mix(C.white, smoothstep(0.55, 1, tt) * 0.35).scale(0.8 + 0.2 * tt);
      o.ear = 1;
      o.furLen = 0.004 * (1 - tt);
      o.tipWhite = 1;
      tangent(tv.copy(Y), nx, ny, nz, o);
      const vv = ((x - base.x) * Y.x + (y - base.y) * Y.y + (z - base.z) * Y.z) / EAR_LEN;
      const w1 = 1 - smoothstep(0.2, 0.42, vv);
      o.w[B.ear] += w1;
      o.w[B.ear2] += 1 - w1;
    };
    b.add(tuftMesh, tAttr);
    ti = 0;
    b.add(tuftMesh, tAttr, { mirror: true, remap });
  }
}

/** Eyeball (left) around the eye bone, big cartoon iris with a cornea bulge. UV → gloss atlas left half. */
function buildEye(b: GroupBuilder, q: number): void {
  const nr = Math.round(28 / q), na = Math.round(44 / q);
  const c = new Vector3(...P.eye);
  const IRIS = 0.68; // iris radius as a fraction of the eyeball (matches the atlas)
  const mesh = gridMesh(nr, na, true, (r, k, out) => {
    const th = (r / nr) * Math.PI, a = (k / na) * Math.PI * 2;
    const rho = Math.sin(th);
    const bulge = th < Math.PI / 2 ? 0.0026 * Math.max(0, 1 - (rho / IRIS) ** 2) ** 2 : 0;
    const R = EYE_R + bulge;
    out.copy(c).addScaledVector(EYE_FWD, Math.cos(th) * R).addScaledVector(EYE_RIGHT, Math.cos(a) * rho * R).addScaledVector(EYE_UP, Math.sin(a) * rho * R);
  });
  let vi = 0;
  const attr: AttribFn = (_x, _y, _z, _nx, _ny, _nz, o) => {
    const id = vi++;
    const r = Math.floor(id / na), k = id % na;
    const th = (r / nr) * Math.PI, a = (k / na) * Math.PI * 2;
    const rho = th < Math.PI / 2 ? Math.sin(th) : 1;
    o.u = 0.25 + 0.245 * rho * Math.cos(a);
    o.v = 0.5 + 0.49 * rho * Math.sin(a);
    o.w[B.eye] = 1;
  };
  b.add(mesh, attr);
  vi = 0;
  b.add(mesh, attr, { mirror: true, remap });
}

function buildNose(b: GroupBuilder, q: number): void {
  const nr = Math.round(20 / q), na = Math.round(32 / q);
  const c = new Vector3(P.nose[0], P.nose[1], P.nose[2] + 0.004);
  const S = HEAD_S;
  const nost = [new Vector3(0.012 * S, -0.007 * S, 0.02 * S), new Vector3(-0.012 * S, -0.007 * S, 0.02 * S)];
  const d = new Vector3();
  const mesh = gridMesh(nr, na, true, (r, k, out) => {
    const th = (r / nr) * Math.PI, a = (k / na) * Math.PI * 2;
    d.set(Math.sin(th) * Math.cos(a), Math.cos(th), Math.sin(th) * Math.sin(a)); // y-pole
    let rx = 0.03 * S, ry = 0.0235 * S, rz = 0.0245 * S;
    if (d.y > 0) { rx *= 1.05; rz *= 1.02; } // broader, heart-ish top
    if (d.z < 0) rz *= 1.25; // sinks back into the muzzle
    out.set(d.x * rx, d.y * ry, d.z * rz);
    for (const n of nost) {
      const dd = out.distanceToSquared(n);
      out.multiplyScalar(1 - 0.1 * Math.exp(-dd / (0.00004 * S * S)));
    }
    out.add(c);
  }, true);
  b.add(mesh, (_x, _y, _z, _nx, _ny, _nz, o) => { o.u = 0.75; o.v = 0.5; o.w[B.nose] = 1; });
}

/** Upper/lower eyelid shells around the eyeball (fur group, rigid on the lid bones). */
function buildLids(b: GroupBuilder, q: number): void {
  const na = Math.round(32 / q);
  const c = new Vector3(...P.eye);
  // lids clear the cornea bulge (0.0038) when they sweep across the eye
  const ro = EYE_R + 0.0046, ri = EYE_R + 0.003;
  for (const upper of [true, false]) {
    const edge = upper ? 0.6 : 0.8; // edge angle from the lid axis at the front of the eye
    const axis = upper ? EYE_UP : tv.copy(EYE_UP).negate().clone();
    // the edge reaches the eye's equator at the corners (on the blink axis, so blinks close fully); the sharp
    // sin⁴ falloff keeps the aperture open until close to the corners, so the eye still reads open in profile
    const edgeAt = (a: number) => edge + (Math.PI / 2 + 0.04 - edge) * Math.sin(a) ** 4;
    // profile in (normalised angle, radius): outer shell → rolled rim → inner shell
    const prof: [number, number][] = [];
    const nOut = Math.round(9 / q);
    for (let i = 0; i <= nOut; i++) prof.push([i / nOut, ro]);
    const nRim = 6;
    const rm = (ro + ri) / 2, rr = (ro - ri) / 2;
    for (let i = 1; i < nRim; i++) {
      const a = (Math.PI * i) / nRim;
      prof.push([1 + (Math.sin(a) * rr * 1.6) / rm / edge, rm + Math.cos(a) * rr]);
    }
    for (let i = 3; i >= 0; i--) prof.push([i / 3, ri]);
    const side = new Vector3();
    const mesh = gridMesh(prof.length - 1, na, true, (r, k, out) => {
      const [tn, rad] = prof[r];
      const a = (k / na) * Math.PI * 2;
      const th = tn * edgeAt(a);
      side.copy(EYE_FWD).multiplyScalar(Math.cos(a)).addScaledVector(EYE_RIGHT, Math.sin(a));
      out.copy(axis).multiplyScalar(Math.cos(th)).addScaledVector(side, Math.sin(th)).multiplyScalar(rad).add(c);
    });
    let vi = 0;
    const attr: AttribFn = (_x, _y, _z, _nx, _ny, _nz, o) => {
      const id = vi++;
      const r = Math.floor(id / na), a = ((id % na) / na) * Math.PI * 2;
      const [tn, rad] = prof[r];
      // skin-coloured lids (they sit in the light "spectacle" patch) with a thin lash line on the rim,
      // strongest over the pupil and fading toward the corners (no droopy dark diagonal in profile)
      o.color(C.sand).mix(C.cream, upper ? 0.6 : 0.72);
      const rimT = (tn > 1 ? 1 : smoothstep(0.86, 1, tn) * (rad > ri + 0.0002 ? 1 : 0.7)) * (1 - 0.7 * Math.sin(a) ** 4);
      o.mix(C.lash, rimT * (upper ? 0.95 : 0.3));
      o.w[upper ? B.lidU : B.lidL] = 1;
    };
    b.add(mesh, attr);
    vi = 0;
    b.add(mesh, attr, { mirror: true, remap });
  }
}

/** Thick cartoon brow (left), a tapered flat tube lying on the forehead. */
function buildBrows(b: GroupBuilder, q: number): void {
  const pts = BROW_D.map(([x, y, z]) => project(headBase, new Vector3(...hd(x, y, z)), 0.0018));
  const ns = Math.round(20 / q), na = Math.round(14 / q);
  const p = new Vector3(), t = new Vector3(), n = new Vector3(), s = new Vector3();
  const curve = (u: number, out: Vector3) => {
    const f = u * (pts.length - 1);
    const i = Math.min(pts.length - 2, Math.floor(f));
    return out.lerpVectors(pts[i], pts[i + 1], f - i);
  };
  const mesh = gridMesh(ns, na, true, (r, k, out) => {
    const u = r / ns;
    curve(u, p);
    curve(Math.min(1, u + 0.01), t).sub(curve(Math.max(0, u - 0.01), s)).normalize();
    gradient(headBase, p.x, p.y, p.z, n);
    s.crossVectors(n, t).normalize();
    const taper = Math.sqrt(Math.max(0, Math.sin(Math.PI * u))) * (1.05 - 0.35 * u);
    const a = (k / na) * Math.PI * 2;
    out.copy(p).addScaledVector(s, Math.cos(a) * 0.0105 * taper).addScaledVector(n, Math.sin(a) * 0.0042 * taper + 0.001);
  }, true);
  const attr: AttribFn = (_x, _y, _z, _nx, _ny, _nz, o) => { o.color(C.brow); o.w[B.brow] = 1; };
  b.add(mesh, attr);
  b.add(mesh, attr, { mirror: true, remap });
}

/** Crisp cartoon mouth line: a thin dark tapered tube lying in the smile crease (mirrored halves). */
function buildMouth(b: GroupBuilder, q: number): void {
  const pts = SMILE.map((p) => project(headBase, new Vector3(...hd(p.x, p.y, p.z)), 0.0006));
  const ns = Math.round(28 / q), na = Math.round(8 / q);
  const p = new Vector3(), t = new Vector3(), n = new Vector3(), sd = new Vector3(), tmp = new Vector3();
  const curve = (u: number, out: Vector3) => {
    const f = u * (pts.length - 1);
    const i = Math.min(pts.length - 2, Math.floor(f));
    return out.lerpVectors(pts[i], pts[i + 1], f - i);
  };
  const mesh = gridMesh(ns, na, true, (r, k, out) => {
    const u = r / ns;
    curve(u, p);
    curve(Math.min(1, u + 0.01), t).sub(curve(Math.max(0, u - 0.01), tmp)).normalize();
    gradient(headBase, p.x, p.y, p.z, n);
    sd.crossVectors(n, t).normalize();
    // thick at the philtrum/centre, tapering into the cheek at the corner
    const taper = Math.sqrt(Math.max(0, 1 - u)) * Math.min(1, u * 10 + 0.55);
    const a = (k / na) * Math.PI * 2;
    out.copy(p).addScaledVector(sd, Math.cos(a) * 0.0024 * taper).addScaledVector(n, Math.sin(a) * 0.0012 * taper);
  }, true);
  const attr: AttribFn = (_x, _y, _z, _nx, _ny, _nz, o) => { o.color(C.mouth); o.w[B.head] = 1; };
  b.add(mesh, attr);
  b.add(mesh, attr, { mirror: true, remap });
}

/** Chest emblem: a disc conforming to the suit (UV → cloth atlas emblem). */
function buildEmblem(b: GroupBuilder, q: number): void {
  const nr = Math.round(10 / q), na = Math.round(44 / q);
  const R = 0.042, cy = 0.738;
  const n = new Vector3();
  const surf = (x: number, y: number, out: Vector3) => {
    let z = 0.3;
    for (let i = 0; i < 64; i++) { const d = suitSdf(x, y, z); z -= d; if (Math.abs(d) < 1e-5) break; }
    gradient(suitSdf, x, y, z, n);
    return out.set(x, y, z).addScaledVector(n, 0.0011);
  };
  const mesh = gridMesh(nr, na, true, (r, k, out) => {
    const rho = r / nr, a = (k / na) * Math.PI * 2;
    surf(R * rho * Math.cos(a), cy + R * rho * Math.sin(a), out);
  });
  let vi = 0;
  b.add(mesh, (x, y, z, nx, ny, nz, o) => {
    const id = vi++;
    const rho = Math.floor(id / na) / nr, a = ((id % na) / na) * Math.PI * 2;
    o.u = 0.75 + 0.235 * rho * Math.cos(a);
    o.v = 0.25 + 0.235 * rho * Math.sin(a);
    bakeAo(o, x, y, z, nx, ny, nz, suitAo, 0.5);
    suitWeights(x, y, z, o);
  });
}

/** Satchel strap: a flat band over the right shoulder, resting on the suit surface. */
function buildStrap(b: GroupBuilder, q: number): void {
  const ctrl = [
    [-0.178, 0.57, 0.028], [-0.16, 0.645, 0.08], [-0.115, 0.75, 0.098], [-0.095, 0.828, 0.03], [-0.1, 0.8, -0.075], [-0.14, 0.68, -0.11], [-0.178, 0.57, -0.098],
  ].map(([x, y, z]) => new Vector3(x, y, z));
  const surf: Sdf = (x, y, z) => Math.min(suitSdf(x, y, z), bagSdf(x, y, z) + 0.01);
  const ns = Math.round(56 / q);
  const pts: Vector3[] = [];
  for (let i = 0; i <= ns; i++) {
    const f = (i / ns) * (ctrl.length - 1);
    const k = Math.min(ctrl.length - 2, Math.floor(f));
    const t = f - k;
    // Catmull-Rom
    const p0 = ctrl[Math.max(0, k - 1)], p1 = ctrl[k], p2 = ctrl[k + 1], p3 = ctrl[Math.min(ctrl.length - 1, k + 2)];
    const t2 = t * t, t3 = t2 * t;
    const p = new Vector3()
      .addScaledVector(p0, -0.5 * t3 + t2 - 0.5 * t)
      .addScaledVector(p1, 1.5 * t3 - 2.5 * t2 + 1)
      .addScaledVector(p2, -1.5 * t3 + 2 * t2 + 0.5 * t)
      .addScaledVector(p3, 0.5 * t3 - 0.5 * t2);
    const d = surf(p.x, p.y, p.z);
    if (d < 0.0045) project(surf, p, 0.0045);
    pts.push(p);
  }
  const n = new Vector3(), t = new Vector3(), s = new Vector3();
  const corners = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
  const mesh = gridMesh(ns, 4, true, (r, k, out) => {
    const p = pts[r];
    t.subVectors(pts[Math.min(ns, r + 1)], pts[Math.max(0, r - 1)]).normalize();
    gradient(surf, p.x, p.y, p.z, n);
    s.crossVectors(t, n).normalize();
    n.crossVectors(s, t).normalize();
    const [cs, cn] = corners[k];
    out.copy(p).addScaledVector(s, cs * 0.014).addScaledVector(n, cn * 0.0022);
  });
  let vi = 0;
  b.add(mesh, (x, y, z, _nx, _ny, _nz, o) => {
    const r = Math.floor(vi++ / 4);
    o.color(C.strap);
    const end = Math.min(r, ns - r) / ns; // near the bag → bag bone
    const wb = smoothstep(0.1, 0.02, end);
    suitWeights(x, y, z, o, 1 - wb);
    o.w[B.bag] += wb;
  });
}

// =============================================================================================

type Mark = (name: string, mesh?: { indices: Uint32Array }) => void;

/** Builds one level of detail (fur / cloth / gloss groups) at voxel scale `q`. */
function buildSet(q: number, mark: Mark): { set: BodySet; headTop: number } {
  const fur = new GroupBuilder();
  const cloth = new GroupBuilder();
  const gloss = new GroupBuilder();

  // --- head + neck
  const head = surfaceNets(headSdf, HEAD_MIN, HEAD_MAX, 0.0074 * q);
  fur.add(head, headAttr);
  mark('head', head);
  let headTop = 0;
  for (let i = 1; i < head.positions.length; i += 3) headTop = Math.max(headTop, head.positions[i]);
  buildEar(fur, q);
  buildLids(fur, q);
  buildBrows(fur, q);
  buildMouth(fur, q);
  mark('ears+lids+brows+mouth');

  // --- feet (left sculpt, mirrored)
  const foot = surfaceNets(footSdf, [0.014, -0.012, -0.09], [0.147, 0.17, 0.18], 0.0078 * q);
  fur.add(foot, footAttr);
  fur.add(foot, footAttr, { mirror: true, remap });
  mark('feet x2', foot);

  // --- tail
  const tail = surfaceNets(tailSdf, TAIL_MIN, TAIL_MAX, 0.012 * q);
  fur.add(tail, tailAttr);
  mark('tail', tail);

  // --- suit
  const suit = surfaceNets(suitSdf, [-0.44, 0.05, -0.15], [0.44, 0.86, 0.15], 0.0112 * q);
  cloth.add(suit, suitAttr);
  mark('suit', suit);
  buildTrims(cloth, q);
  buildEmblem(cloth, q);
  mark('trims+emblem');

  // --- gloves: mesh in hand space, transform to model space
  const glove = surfaceNets(gloveSdf, [-0.045, -0.04, -0.045], [0.155, 0.036, 0.092], 0.0048 * q);
  const g = { positions: new Float32Array(glove.positions.length), normals: new Float32Array(glove.normals.length), indices: glove.indices };
  for (let i = 0; i < glove.positions.length; i += 3) {
    const [u, v, w] = [glove.positions[i], glove.positions[i + 1], glove.positions[i + 2]];
    const [nu, nv, nw] = [glove.normals[i], glove.normals[i + 1], glove.normals[i + 2]];
    g.positions[i] = P.wrist[0] + HAND_X.x * u + HAND_Y.x * v + HAND_Z.x * w;
    g.positions[i + 1] = P.wrist[1] + HAND_X.y * u + HAND_Y.y * v + HAND_Z.y * w;
    g.positions[i + 2] = P.wrist[2] + HAND_X.z * u + HAND_Y.z * v + HAND_Z.z * w;
    g.normals[i] = HAND_X.x * nu + HAND_Y.x * nv + HAND_Z.x * nw;
    g.normals[i + 1] = HAND_X.y * nu + HAND_Y.y * nv + HAND_Z.y * nw;
    g.normals[i + 2] = HAND_X.z * nu + HAND_Y.z * nv + HAND_Z.z * nw;
  }
  // attributes are evaluated in hand space: wrap the callback with the inverse transform
  const gloveAttrModel: AttribFn = (x, y, z, nx, ny, nz, o) => {
    const px = x - P.wrist[0], py = y - P.wrist[1], pz = z - P.wrist[2];
    gloveAttr(
      px * HAND_X.x + py * HAND_X.y + pz * HAND_X.z, px * HAND_Y.x + py * HAND_Y.y + pz * HAND_Y.z, px * HAND_Z.x + py * HAND_Z.y + pz * HAND_Z.z,
      nx * HAND_X.x + ny * HAND_X.y + nz * HAND_X.z, nx * HAND_Y.x + ny * HAND_Y.y + nz * HAND_Y.z, nx * HAND_Z.x + ny * HAND_Z.y + nz * HAND_Z.z,
      o,
    );
  };
  cloth.add(g, gloveAttrModel);
  cloth.add(g, gloveAttrModel, { mirror: true, remap });
  mark('gloves x2', glove);

  // --- satchel + strap (right side only)
  const bag = surfaceNets(bagSdf, [-0.23, 0.44, -0.14], [-0.14, 0.61, 0.07], 0.0072 * q);
  cloth.add(bag, bagAttr);
  mark('bag', bag);
  buildStrap(cloth, q);

  // --- eyes + nose
  buildEye(gloss, q);
  buildNose(gloss, q);

  const set: BodySet = { fur: fur.pack(), cloth: cloth.pack(), gloss: gloss.pack(), triangles: 0 };
  set.triangles = (set.fur.index.length + set.cloth.index.length + set.gloss.index.length) / 3;
  mark('pack');
  return { set, headTop };
}

export function buildBody(quality: Quality): LabibBodyData {
  const parts: { name: string; tris: number; ms: number }[] = [];
  let tp = performance.now();
  const mark: Mark = (name, mesh) => {
    const now = performance.now();
    parts.push({ name, tris: mesh ? mesh.indices.length / 3 : 0, ms: Math.round(now - tp) });
    tp = now;
  };
  const q = VOXEL[quality];
  const { set: near, headTop } = buildSet(q, mark);

  // coarse LOD for the gameplay camera (~6 m): at that distance the difference is sub-pixel
  let far: BodySet | null = null;
  if (quality !== 'low') {
    const t0 = performance.now();
    far = buildSet(VOXEL.low, () => {}).set;
    parts.push({ name: 'far LOD', tris: far.triangles, ms: Math.round(performance.now() - t0) });
    tp = performance.now();
  }

  // fur shell sources (only at qualities that render shells). Tail + ears come first, so a prefix of
  // the index (`shellFarCount`) draws just their fuzzy silhouettes from the gameplay camera.
  let shell: GroupData | null = null, shellFarCount = 0;
  if (quality === 'high' || quality === 'ultra') {
    const sb = new GroupBuilder();
    sb.add(surfaceNets(tailSdf, TAIL_MIN, TAIL_MAX, 0.018 * q), tailAttr);
    buildEar(sb, q * 1.6);
    shellFarCount = sb.furIndex().length;
    sb.add(surfaceNets(headSdf, HEAD_MIN, HEAD_MAX, 0.014 * q), headShellAttr);
    shell = sb.pack(sb.furIndex());
    mark('shells');
  }
  return { near, far, shell, shellFarCount, headTop, parts };
}
