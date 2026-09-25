// Labib's skeleton: bone names, hierarchy and rest pose (model space, origin at the feet, facing +Z).
// The body is built in an A-pose; every bone has a rest orientation ("basis") so that local rotations
// have anatomical meaning. Right-side bases are the mirror of the left with the local X axis flipped,
// which makes mirroring a pose trivial: right (x, y, z) = left (x, -y, -z)  (see `Pose.s` in anim.ts).
import { Bone, Matrix4, Quaternion, Skeleton, Vector3 } from 'three';

export const A = Math.SQRT1_2;

/** Left-arm direction in the A-pose (45° down and out). */
export const ARM_DIR: readonly [number, number, number] = [A, -A, 0];

/** The head is sculpted in a "design space" and scaled up about the head pivot (cartoon head size). */
export const HEAD_S = 1.2;
const HEAD_D0 = [0, 0.975, 0.01] as const; // pivot in design space
const HEAD_M0 = [0, 0.93, 0.01] as const; // pivot in model space
/** Head design space → model space. */
export function hd(x: number, y: number, z: number): [number, number, number] {
  return [HEAD_M0[0] + (x - HEAD_D0[0]) * HEAD_S, HEAD_M0[1] + (y - HEAD_D0[1]) * HEAD_S, HEAD_M0[2] + (z - HEAD_D0[2]) * HEAD_S];
}
/** Model space → head design space (writes into out). */
export function toHead(x: number, y: number, z: number, out: number[]): number[] {
  out[0] = HEAD_D0[0] + (x - HEAD_M0[0]) / HEAD_S;
  out[1] = HEAD_D0[1] + (y - HEAD_M0[1]) / HEAD_S;
  out[2] = HEAD_D0[2] + (z - HEAD_M0[2]) / HEAD_S;
  return out;
}

/** Left eye frame: forward (lid aperture direction at rest), up, right (= up × forward, points to +X).
 *  The aperture faces well outward so the eyes still read in profile; the pupils converge in anim.ts. */
export const EYE_FWD = new Vector3(0.36, 0.03, 1).normalize();
export const EYE_UP = new Vector3(0, 1, 0).addScaledVector(EYE_FWD, -EYE_FWD.y).normalize();
export const EYE_RIGHT = new Vector3().crossVectors(EYE_UP, EYE_FWD).normalize();
/** The eyeball sits this far (design space) in front of its socket centre, so it bulges out of the face. */
const EYE_PUSH = 0.005;

/** Head design-space landmarks (`eye` = socket centre, `eyeC` = eyeball centre). */
export const HD = {
  eye: [0.057, 1.11, 0.1],
  eyeC: [0.057 + EYE_FWD.x * EYE_PUSH, 1.11 + EYE_FWD.y * EYE_PUSH, 0.1 + EYE_FWD.z * EYE_PUSH],
  eyeR: 0.044,
  brow: [0.056, 1.18, 0.125],
  nose: [0, 1.034, 0.262],
  earBase: [0.1, 1.152, -0.03],
} as const;

export const P = {
  hips: [0, 0.525, 0],
  spine: [0, 0.625, -0.005],
  chest: [0, 0.725, -0.01],
  neck: [0, 0.82, -0.006],
  head: HEAD_M0,
  // left side (+X); right side mirrored
  shoulder: [0.14, 0.79, -0.012],
  elbow: [0.14 + 0.175 * A, 0.79 - 0.175 * A, -0.012],
  wrist: [0.14 + 0.33 * A, 0.79 - 0.33 * A, -0.012],
  hip: [0.08, 0.505, 0],
  knee: [0.08, 0.285, 0.012],
  ankle: [0.08, 0.09, -0.012],
  toe: [0.08, 0.03, 0.115],
  earBase: hd(...HD.earBase),
  eye: hd(...HD.eyeC),
  brow: hd(...HD.brow),
  nose: hd(...HD.nose),
  bagPivot: [-0.16, 0.635, -0.04],
} as const satisfies Record<string, readonly [number, number, number]>;

export const EAR_LEN = 0.5;
/** Left ear axis (tip direction): splayed well out (the classic Labib's signature), up and a little back. */
export const EAR_AXIS = new Vector3(0.72, 0.68, -0.15).normalize();
/** Left ear opening direction (front normal of the ear sheet), orthogonalised against the axis. */
export const EAR_FRONT = new Vector3(0.22, 0, 1).addScaledVector(EAR_AXIS, -new Vector3(0.22, 0, 1).dot(EAR_AXIS)).normalize();

export const EYE_R = HD.eyeR * HEAD_S;

/** Tail spine at rest: hangs in a lazy S behind the legs like a real fennec's, the tip curling out to his
 *  left (from the chase camera the brush is seen along its length, not end-on). Lifted when running. */
export const TAIL_PTS: readonly (readonly [number, number, number])[] = [
  [0, 0.525, -0.075],
  [0.006, 0.458, -0.165],
  [0.022, 0.368, -0.232],
  [0.045, 0.27, -0.268],
  [0.075, 0.182, -0.285],
  [0.112, 0.11, -0.31],
];

interface BoneSpec {
  name: string;
  parent: string | null;
  pos: readonly [number, number, number];
  /** Rest orientation as basis columns (X, Y, Z) in model space; identity when omitted. */
  basis?: readonly [Vector3, Vector3, Vector3];
}

// hand-local frame of the LEFT hand: X along the fingers, Y = back of the hand, Z = thumb side (forward)
export const HAND_X = new Vector3(A, -A, 0);
export const HAND_Y = new Vector3(A, A, 0);
export const HAND_Z = new Vector3(0, 0, 1);
const EAR_X = new Vector3().crossVectors(EAR_AXIS, EAR_FRONT);

/** Maps a point in the left hand's local frame to model space. */
export function handToModel(u: number, v: number, w: number, out: Vector3): Vector3 {
  return out.set(P.wrist[0], P.wrist[1], P.wrist[2]).addScaledVector(HAND_X, u).addScaledVector(HAND_Y, v).addScaledVector(HAND_Z, w);
}
const hv = (u: number, v: number, w: number): [number, number, number] => {
  const p = handToModel(u, v, w, new Vector3());
  return [p.x, p.y, p.z];
};
const earPt = (t: number): [number, number, number] => [P.earBase[0] + EAR_AXIS.x * t, P.earBase[1] + EAR_AXIS.y * t, P.earBase[2] + EAR_AXIS.z * t];

// finger joint positions in the hand frame (u, v, w) — shared with the glove sculpt
export const FINGER = {
  thumb: [[0.028, -0.008, 0.03], [0.052, -0.014, 0.056], [0.074, -0.016, 0.068]],
  index: [[0.074, 0.002, 0.025], [0.106, -0.002, 0.027], [0.13, -0.008, 0.028]],
  middle: [[0.076, 0.003, 0.0], [0.11, -0.001, 0.0], [0.137, -0.008, 0.0]],
  ring: [[0.073, 0.002, -0.024], [0.103, -0.002, -0.026], [0.126, -0.008, -0.027]],
} as const;

const HB: [Vector3, Vector3, Vector3] = [HAND_X, HAND_Y, HAND_Z];
const ELBOW: [Vector3, Vector3, Vector3] = [new Vector3(A, A, 0), new Vector3(A, -A, 0), new Vector3(0, 0, -1)];
const LEFT: BoneSpec[] = [
  { name: 'clav', parent: 'chest', pos: [0.04, 0.795, -0.012] },
  // upper arm: identity basis → rotZ abducts, rotX swings forward (−) / back (+), like the legs
  { name: 'arm', parent: 'clav', pos: P.shoulder },
  // forearm: X = elbow hinge (rotX − flexes forward), Y = along the forearm (twist), Z = backward (rotZ = sideways)
  { name: 'fore', parent: 'arm', pos: P.elbow, basis: ELBOW },
  { name: 'hand', parent: 'fore', pos: P.wrist, basis: HB },
  { name: 'thumb', parent: 'hand', pos: hv(...FINGER.thumb[0]), basis: HB },
  { name: 'thumb2', parent: 'thumb', pos: hv(...FINGER.thumb[1]), basis: HB },
  { name: 'index', parent: 'hand', pos: hv(...FINGER.index[0]), basis: HB },
  { name: 'index2', parent: 'index', pos: hv(...FINGER.index[1]), basis: HB },
  { name: 'fing', parent: 'hand', pos: hv(0.075, 0.003, -0.012), basis: HB },
  { name: 'fing2', parent: 'fing', pos: hv(0.107, -0.001, -0.013), basis: HB },
  { name: 'thigh', parent: 'hips', pos: P.hip },
  { name: 'shin', parent: 'thigh', pos: P.knee },
  { name: 'foot', parent: 'shin', pos: P.ankle },
  { name: 'toe', parent: 'foot', pos: P.toe },
  { name: 'ear', parent: 'head', pos: earPt(0), basis: [EAR_X, EAR_AXIS, EAR_FRONT] },
  { name: 'ear2', parent: 'ear', pos: earPt(EAR_LEN * 0.33), basis: [EAR_X, EAR_AXIS, EAR_FRONT] },
  { name: 'ear3', parent: 'ear2', pos: earPt(EAR_LEN * 0.66), basis: [EAR_X, EAR_AXIS, EAR_FRONT] },
  { name: 'eye', parent: 'head', pos: P.eye, basis: [EYE_RIGHT, EYE_UP, EYE_FWD] },
  { name: 'lidU', parent: 'head', pos: P.eye, basis: [EYE_RIGHT, EYE_UP, EYE_FWD] },
  { name: 'lidL', parent: 'head', pos: P.eye, basis: [EYE_RIGHT, EYE_UP, EYE_FWD] },
  { name: 'brow', parent: 'head', pos: P.brow },
];

const CENTER: BoneSpec[] = [
  { name: 'hips', parent: null, pos: P.hips },
  { name: 'spine', parent: 'hips', pos: P.spine },
  { name: 'chest', parent: 'spine', pos: P.chest },
  { name: 'neck', parent: 'chest', pos: P.neck },
  { name: 'head', parent: 'neck', pos: P.head },
  { name: 'nose', parent: 'head', pos: P.nose },
  { name: 'bag', parent: 'hips', pos: P.bagPivot },
  ...TAIL_PTS.slice(0, 5).map((p, i): BoneSpec => ({ name: `tail${i}`, parent: i === 0 ? 'hips' : `tail${i - 1}`, pos: p })),
];

const mirrorVec = (v: Vector3) => new Vector3(-v.x, v.y, v.z);
function mirrorSpec(s: BoneSpec): BoneSpec {
  const parentIsSided = LEFT.some((l) => l.name === s.parent);
  return {
    name: s.name + 'R',
    parent: parentIsSided ? s.parent + 'R' : s.parent,
    pos: [-s.pos[0], s.pos[1], s.pos[2]],
    basis: s.basis ? [mirrorVec(s.basis[0]).negate(), mirrorVec(s.basis[1]), mirrorVec(s.basis[2])] : [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)],
  };
}

export const BONE_SPECS: BoneSpec[] = [
  ...CENTER,
  ...LEFT.map((s) => ({ ...s, name: s.name + 'L', parent: LEFT.some((l) => l.name === s.parent) ? s.parent + 'L' : s.parent })),
  ...LEFT.map(mirrorSpec),
];
// (identity-basis right bones: mirror(I) with X flipped is I again, so the mirror rule holds for them too)

export const BONE_INDEX: Record<string, number> = Object.fromEntries(BONE_SPECS.map((b, i) => [b.name, i]));
export const NB = BONE_SPECS.length;
export const bi = (name: string): number => {
  const i = BONE_INDEX[name];
  if (i === undefined) throw new Error(`labib: unknown bone ${name}`);
  return i;
};

export interface Rig {
  bones: Bone[];
  skeleton: Skeleton;
  /** Rest local quaternion of each bone (pose rotations are applied on top). */
  restQuat: Quaternion[];
  restPos: Vector3[];
}

/** Builds bones in the rest pose; `parent` receives the root bone. */
export function buildRig(): Rig {
  const bones: Bone[] = [];
  const world: Matrix4[] = [];
  const restQuat: Quaternion[] = [];
  const restPos: Vector3[] = [];
  const m = new Matrix4();
  const inv = new Matrix4();
  const s = new Vector3();
  for (const spec of BONE_SPECS) {
    const b = new Bone();
    b.name = spec.name;
    const w = new Matrix4();
    const [bx, by, bz] = spec.basis ?? [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];
    w.makeBasis(bx, by, bz).setPosition(spec.pos[0], spec.pos[1], spec.pos[2]);
    let local = w;
    if (spec.parent) {
      const pi = BONE_INDEX[spec.parent];
      inv.copy(world[pi]).invert();
      local = m.multiplyMatrices(inv, w).clone();
      bones[pi].add(b);
    }
    local.decompose(b.position, b.quaternion, s);
    restQuat.push(b.quaternion.clone());
    restPos.push(b.position.clone());
    bones.push(b);
    world.push(w);
  }
  bones[0].updateMatrixWorld(true);
  const skeleton = new Skeleton(bones);
  return { bones, skeleton, restQuat, restPos };
}
