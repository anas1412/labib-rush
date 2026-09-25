// Shared head shape + face layout. The body builder scales this unit surface by each person's head
// radii; the atlas painter uses the same numbers to place painted eyes, brows and lips, so paint
// and geometry always line up.
import { Vector3 } from 'three';

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const smooth = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const g = (x: number, c: number, w: number) => Math.exp(-(((x - c) / w) ** 2));

/** Head radii ratio x / y (same for everyone; the face cell is painted for it). */
export const HEAD_ASPECT = 0.84;
/** The face cell spans ±FACE_K head radii horizontally and vertically (see faceUV). */
export const FACE_K = 1.12;

/**
 * Unit head surface. θ from the crown (0) to under the chin (π), φ = 0 front, +π/2 = +X (the
 * character's left). Returns x in units of the x radius, y in units of the y radius and z in units
 * of the front (cos φ ≥ 0) or back radius. `jaw` 0 = narrow (women) … 1 = square (men).
 * Broad forms only (the head mesh has ~0.17 rad rows): a rounded cranium, a flatter face plane
 * with brow ridge, cheekbones, muzzle and chin, and a defined jaw line under which the surface
 * tucks in toward the neck. Finer features (lids, lips, creases) are painted into the face cell.
 */
export function unitHead(th: number, ph: number, jaw: number, out: Vector3): Vector3 {
  const st = Math.sin(th), ct = Math.cos(th), sp = Math.sin(ph), cp = Math.cos(ph);
  const fr = Math.max(cp, 0);
  const aph = Math.abs(ph);
  const low = smooth(1.7, 2.65, th); // 0 above the cheekbones → 1 at the jaw
  // jaw line: the chin edge at the front, the jaw angle under the ears
  const thJaw = 2.74 - 0.44 * smooth(0.25, 1.35, aph);
  const under = smooth(thJaw - 0.08, thJaw + 0.42, th);
  const cheek = g(th, 1.95, 0.32) * g(aph, 0.95, 0.42);
  const temple = g(th, 1.3, 0.25) * g(aph, 1.3, 0.35);
  let x = st * sp * (1 - (0.19 - 0.09 * jaw) * low * (0.3 + 0.7 * fr)) * (1 + 0.05 * cheek - 0.035 * temple + 0.03 * smooth(0.3, 1.1, th) * (1 - low));
  x *= 1 + 0.08 * jaw * g(th, 2.35, 0.22) * g(aph, 1.2, 0.35); // square jaw corners
  let z = st * cp;
  if (cp < 0) z *= (1 + 0.07 * g(th, 1.35, 0.45)) * (1 - 0.22 * smooth(1.9, 2.7, th)); // occiput bulge, nape tucks in
  else {
    z *= 1 - 0.16 * fr * fr * smooth(0.95, 1.6, th) * (1 - low); // flatter face plane
    z -= 0.06 * fr * g(th, 1.05, 0.3); // forehead slopes back a little
    z += fr * (0.08 * g(th, 1.42, 0.14) * g(aph, 0.38, 0.42) // brow ridge
      - 0.05 * g(th, 1.62, 0.13) * g(aph, 0.42, 0.26) // eyes sit under it
      + 0.05 * g(th, 1.92, 0.16) * g(aph, 0.72, 0.28) // cheekbones
      + 0.1 * g(th, 2.2, 0.2) * g(ph, 0, 0.45) // mouth muzzle
      - 0.03 * g(th, 2.42, 0.1) * g(ph, 0, 0.4) // under the lower lip
      + (0.08 + 0.04 * jaw) * g(th, 2.6, 0.14) * g(ph, 0, 0.42)); // chin
  }
  // under the jaw the surface tucks in toward the neck (the jaw overhangs it)
  const tuck = 1 - 0.34 * under;
  x *= tuck;
  z = z >= 0 ? z * (1 - 0.3 * under) : z * tuck;
  const y = ct + 0.07 * low * low * fr * (1 - under) - 0.05 * under * fr;
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
