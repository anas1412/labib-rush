// Shared head shape + face layout. The body builder scales this unit surface by each person's head
// radii; the atlas painter uses the same numbers to place painted eyes, brows and lips, so paint
// and geometry always line up.
import { Vector3 } from 'three';

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const smooth = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const g = (x: number, c: number, w: number) => Math.exp(-(((x - c) / w) ** 2));

/** Head radii ratio x / y (same for everyone; the face cell is painted for it). */
export const HEAD_ASPECT = 0.058 / 0.072;
/** The face cell spans ±FACE_K head radii horizontally and vertically (see faceUV). */
export const FACE_K = 1.12;

/**
 * Unit head surface. θ from the crown (0) to under the chin (π), φ = 0 front, +π/2 = +X (the
 * character's left). Returns x in units of the x radius, y in units of the y radius and z in units
 * of the front (cos φ ≥ 0) or back radius. `jaw` 0 = narrow (women) … 1 = square (men).
 */
export function unitHead(th: number, ph: number, jaw: number, out: Vector3): Vector3 {
  const st = Math.sin(th), ct = Math.cos(th), sp = Math.sin(ph), cp = Math.cos(ph);
  const low = smooth(1.55, 3.0, th); // 0 above the cheekbones → 1 under the chin
  const fr = Math.max(cp, 0);
  const aph = Math.abs(ph);
  const cheek = g(th, 1.95, 0.35) * g(aph, 0.75, 0.45);
  const temple = g(th, 1.25, 0.25) * g(aph, 1.25, 0.35);
  let x = st * sp * (1 - (0.2 - 0.07 * jaw) * low * (0.45 + 0.55 * fr)) * (1 + 0.04 * smooth(0.3, 1.2, th) * (1 - low) + 0.035 * cheek - 0.03 * temple);
  let z = st * cp;
  if (cp < 0) z *= (1 - 0.42 * low) * (1 + 0.05 * g(th, 1.15, 0.4)); // nape tucks in, occiput bulges
  else {
    z *= 1 - 0.12 * fr * fr * smooth(0.9, 1.7, th) * (1 - low); // flatter face plane
    z += 0.1 * low * low * fr; // jaw & chin forward
    z += fr * (0.028 * g(th, 1.4, 0.16) * g(aph, 0.38, 0.32) // brow ridge
      - 0.018 * g(th, 1.63, 0.14) * g(aph, 0.42, 0.22) // eye area sits slightly in
      + 0.03 * g(th, 2.2, 0.2) * g(ph, 0, 0.5) // mouth muzzle
      + (0.018 + 0.012 * jaw) * g(th, 2.58, 0.14) * g(ph, 0, 0.38)); // chin
  }
  x *= 1 + 0.06 * jaw * g(th, 2.45, 0.25) * g(aph, 1.0, 0.4); // square jaw corners
  const y = ct + 0.06 * low * low * fr;
  return out.set(x, y, z);
}

/** Painted-feature anchors on the unit head (θ, φ). */
export const FACE = {
  eye: { th: 1.61, ph: 0.4 },
  brow: { th: 1.4, ph: 0.4 },
  noseTip: { th: 1.92 },
  mouth: { th: 2.21 },
} as const;

const _v = new Vector3();
/** Painter coordinates of a unit-head point: x-radius units on BOTH axes (one y radius is
 *  1 / HEAD_ASPECT x radii), so circles drawn by the face painter come out round on the head. */
export function faceXY(th: number, ph: number, jaw = 0.5): [number, number] {
  unitHead(th, ph, jaw, _v);
  return [_v.x, _v.y / HEAD_ASPECT];
}

/** Face cell UV (0..1) of a head-local point given in head radii (x in x-radius, y in y-radius units). */
export const faceUV = (x: number, y: number): [number, number] => [(x / FACE_K + 1) / 2, (y / FACE_K + 1) / 2];
