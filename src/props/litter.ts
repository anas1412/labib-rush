// Litter: crushed soda cans (3 flavours), a crushed 1.5 L PET water bottle, a crinkled foil
// chips bag (2 flavours), a white/blue plastic bag that flutters in the wind (vertex shader on
// ctx.uniforms) and the rare golden bottle. Modelled at real size, then ground litter is scaled up
// (SCALE) so it reads from the gameplay camera. Rest poses: origin at the bottom centre, long axis
// along local X (capsule colliders, see LitterShape). Ground litter carries a soft contact shadow.
import {
  BufferAttribute, BufferGeometry, Color, DoubleSide, Float32BufferAttribute, Group, Matrix4, Mesh,
  MeshBasicMaterial, MeshDepthMaterial, MeshPhysicalMaterial, MeshStandardMaterial, RGBADepthPacking, Vector3,
  type Material, type Object3D, type WebGLRenderer,
} from 'three';
import type { LitterKind, Quality, SharedUniforms } from '../core/types';
import {
  BAG_MOUTH, BOTTLE_ATLAS, CAN_BAND, CHIPS_SEAL, bagTexture, bottleTexture, canTexture, chipsTextures,
} from './textures';
import {
  GLSL_NOISE, Trash, deform, fbm3, glassify, lathe, lerp, mergeParts, noise3, paint, paintFn, refine, rng, smooth,
  texScale, vertexPbr, withNormals, type Profile,
} from './util';

/** Real size × this: a 1:1 can is ~8 px tall from the gameplay camera, too small to spot. */
const SCALE: Record<LitterKind, number> = { can: 1.4, bottle: 1.3, chips: 1.3, bag: 1, golden: 1.3 };

/** Moves geometries (after the optional matrix) so they rest on y = 0, centred in x/z. */
function restOnGround(geos: BufferGeometry[], m?: Matrix4): void {
  if (m) geos.forEach((g) => g.applyMatrix4(m));
  const b = bounds(geos);
  geos.forEach((g) => {
    g.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2);
    g.computeBoundingSphere();
  });
}

function bounds(geos: BufferGeometry[]): { min: Vector3; max: Vector3 } {
  const min = new Vector3(Infinity, Infinity, Infinity), max = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const g of geos) {
    g.computeBoundingBox();
    min.min(g.boundingBox!.min);
    max.max(g.boundingBox!.max);
  }
  return { min, max };
}

const scaled = (m: Matrix4, s: number): Matrix4 => m.premultiply(new Matrix4().makeScale(s, s, s));

// ---------------------------------------------------------------------------------------------
// Can: 330 ml, Ø 66 mm × 115 mm, crushed and lying on its side.

const CAN_PROFILE: Profile = [
  [0, 0.0105], [0.012, 0.0098], [0.02, 0.0078], [0.0245, 0.0042], [0.0256, 0.0004], [0.0272, 0.0006],
  [0.0302, 0.0032], [0.0324, 0.0082], [0.033, 0.0135],
  [0.033, 0.0975], [0.0323, 0.1025], [0.0298, 0.1075], [0.0277, 0.1112], [0.0273, 0.1133], [0.0263, 0.115],
  [0.0249, 0.1137], [0.0243, 0.1102], [0.0225, 0.1098], [0.012, 0.1102], [0, 0.1104],
];
/** Straight wall (the part that buckles) and the printed area (wall + neck, like a real can). */
const CAN_BODY: [number, number] = [0.0135, 0.0975];
const CAN_PRINT: [number, number] = [0.011, 0.1065];

function canGeometry(variant: number, q: Quality): BufferGeometry {
  const segs = q === 'low' ? 16 : 24;
  const prof = refine(CAN_PROFILE, q === 'low' ? 0.012 : 0.007);
  const band = variant % CAN_BAND.count;
  const H = CAN_BAND.h * CAN_BAND.count;
  const [p0, p1] = CAN_PRINT;
  // v: label rows for the printed area, metal rows above/below (see CAN_BAND). Profile index i
  // runs along the profile, so the bottom dome (y rising again inside) is still "below" the print.
  const vOf = (_s: number, i: number) => {
    const y = prof[i][1];
    const inside = prof[i][0] < 0.026 && i > 4; // lid / countersink, not the wall
    const row = inside || y > p1
      ? CAN_BAND.labelTop * (1 - Math.min(1, Math.max(0, (y - p1) / (0.115 - p1))))
      : y < p0
        ? CAN_BAND.labelBottom + (CAN_BAND.h - CAN_BAND.labelBottom) * (1 - y / p0)
        : CAN_BAND.labelTop + (CAN_BAND.labelBottom - CAN_BAND.labelTop) * (1 - (y - p0) / (p1 - p0));
    return 1 - (band * CAN_BAND.h + Math.max(1, Math.min(CAN_BAND.h - 1, row))) / H;
  };
  const g = lathe(prof, segs, (sf, u, i) => [u, vOf(sf, i)]);
  const r = rng(1234 + variant * 77);
  const twist = (r() - 0.5) * 1.2;
  const lobes = 3 + (variant % 2);
  const pinchDir = r() * Math.PI;
  const dents = Array.from({ length: 4 }, () => ({ a: r() * Math.PI * 2, y: 0.02 + r() * 0.07, s: 0.004 + r() * 0.006, w: 0.012 + r() * 0.012 }));
  const squash = 0.72 + r() * 0.12; // axial crush (keeps most of the printed wall visible)
  deform(g, (p) => {
    const y0 = p.y;
    const t = Math.max(0, Math.min(1, (y0 - CAN_BODY[0]) / (CAN_BODY[1] - CAN_BODY[0]))); // 0..1 along the body
    const inBody = Math.sin(Math.PI * t);
    let a = Math.atan2(p.x, p.z);
    let rad = Math.hypot(p.x, p.z);
    // accordion folds from the axial crush: diamond buckling (lobes around × 2 rings along)
    const fold = Math.cos(lobes * a + twist * 6 * t + (t > 0.5 ? Math.PI / lobes : 0)) * Math.sin(Math.PI * 2 * t);
    rad *= 1 - 0.16 * inBody * (0.55 + 0.45 * fold);
    // sharp ridges: |sin| folds read as crisp creases under the sun
    rad *= 1 - 0.06 * inBody * Math.pow(Math.abs(Math.sin(lobes * 2 * a + t * 9 + twist * 4)), 0.35);
    // local dents
    for (const d of dents) {
      let da = Math.abs(a - d.a); if (da > Math.PI) da = Math.PI * 2 - da;
      const dist = Math.hypot(da * 0.033, y0 - d.y);
      rad -= d.s * Math.exp(-(dist * dist) / (d.w * d.w)) * (rad > 0.02 ? 1 : 0);
    }
    a += twist * t * 0.5;
    // squeeze across one direction (stepped on)
    let x = rad * Math.sin(a), z = rad * Math.cos(a);
    const ca = Math.cos(pinchDir), sa = Math.sin(pinchDir);
    const u = x * ca - z * sa, w = x * sa + z * ca;
    const k = 1 - 0.5 * Math.pow(inBody, 0.7); // flattened through the middle, ends stay round
    x = u * ca + w * k * sa; z = -u * sa + w * k * ca;
    // axial squash, ends barely move, body shortens with bulge folds
    const ny = y0 < CAN_BODY[0] ? y0 : y0 > CAN_BODY[1] ? y0 - (CAN_BODY[1] - CAN_BODY[0]) * (1 - squash) : CAN_BODY[0] + (y0 - CAN_BODY[0]) * squash;
    // top tilts
    const tilt = 0.08 * t * t;
    p.set(x + tilt * (ny - CAN_BODY[0]) * 0.8, ny, z);
  });
  const withN = withNormals(g, 55);
  const uvA = withN.getAttribute('uv') as BufferAttribute;
  paintFn(withN, (i, _p, l) => {
    const row = (1 - uvA.getY(i)) * H - band * CAN_BAND.h;
    const metal = row < CAN_BAND.labelTop + 1 || row > CAN_BAND.labelBottom - 1;
    // printed ink over aluminium: mostly dielectric so the flavour colour stays saturated
    l.r = metal ? 0.3 : 0.32;
    l.m = metal ? 1 : 0.22;
  }, true);
  // lie on its side, flattened side down, then rest on the ground (axis along X)
  const m = new Matrix4().makeRotationY(Math.PI / 2 - pinchDir).premultiply(new Matrix4().makeRotationZ(Math.PI / 2));
  m.premultiply(new Matrix4().makeRotationX(0.15 * (r() - 0.5)));
  restOnGround([withN], scaled(m, SCALE.can));
  return withN;
}

// ---------------------------------------------------------------------------------------------
// PET bottle: 1.5 L, Ø 90 mm × 330 mm with cap. The golden bottle is the same bottle, pristine.

const BOTTLE_PROFILE: Profile = [
  [0, 0.012], [0.012, 0.0095], [0.024, 0.005], [0.033, 0.0012], [0.038, 0.0], [0.0425, 0.004], [0.0448, 0.014],
  [0.045, 0.03], [0.045, 0.052], [0.0428, 0.058], [0.045, 0.064], [0.045, 0.07], [0.0428, 0.076], [0.045, 0.082],
  [0.045, 0.2], [0.0428, 0.206], [0.045, 0.212], [0.045, 0.222], [0.0443, 0.235], [0.0405, 0.25], [0.034, 0.264],
  [0.026, 0.277], [0.0188, 0.289], [0.0146, 0.297], [0.0146, 0.2995], [0.0178, 0.3005], [0.0178, 0.3025],
  [0.0146, 0.3035], [0.0142, 0.316], [0.0125, 0.3165], [0.0125, 0.312],
];
const LABEL_Y: [number, number] = [0.08, 0.215];

/** Shell (outer [+ inner] wall, painted with `shell`), label band and cap, not yet posed. */
function bottleParts(q: Quality, golden: boolean): { shell: BufferGeometry; label: BufferGeometry; cap: BufferGeometry } {
  const segs = q === 'low' ? 14 : 20;
  const prof = refine(BOTTLE_PROFILE, q === 'low' ? 0.035 : 0.022);
  const walls = [lathe(prof, segs)];
  if (!golden) {
    // inner wall: 0.5 mm inside, reversed winding (seen through the front wall)
    const innerProf: Profile = prof.map(([r, y]) => [Math.max(0, r - 0.0005), Math.min(0.312, Math.max(0.0015, y + 0.0004))]);
    walls.push(lathe(innerProf.reverse(), segs));
  }
  const [lt, lb] = golden ? BOTTLE_ATLAS.gold : BOTTLE_ATLAS.water;
  const label = lathe(refine([[0.0456, LABEL_Y[0]], [0.0456, LABEL_Y[1]]], 0.01), segs,
    (sf, u) => [u, 1 - lerp(lb, lt, sf) / BOTTLE_ATLAS.H]);
  // cap: ribbed, slightly oversized sports cap (reads as a bright dot from afar)
  const capProf: Profile = [[0.0172, 0.3015], [0.0182, 0.303], [0.0182, 0.3205], [0.017, 0.3224], [0.009, 0.3232], [0, 0.3234]];
  const cap = lathe(refine(capProf, 0.006), q === 'low' ? 16 : 32);
  deform(cap, (p) => {
    const a = Math.atan2(p.x, p.z), rr = Math.hypot(p.x, p.z);
    if (rr > 0.0175 && p.y < 0.3205) {
      const k = 1 + 0.035 * Math.max(0, Math.cos(a * 32));
      p.x *= k; p.z *= k;
    }
  });
  if (!golden) {
    const r = rng(99);
    const dents = Array.from({ length: 5 }, () => ({ a: r() * Math.PI * 2, y: 0.05 + r() * 0.2, s: 0.006 + r() * 0.008, w: 0.02 + r() * 0.02 }));
    const f = (p: Vector3) => {
      const t = smooth(0.02, 0.1, p.y) * (1 - smooth(0.2, 0.27, p.y));
      const a = Math.atan2(p.x, p.z);
      let rr = Math.hypot(p.x, p.z);
      for (const d of dents) {
        let da = Math.abs(a - d.a); if (da > Math.PI) da = Math.PI * 2 - da;
        const dist = Math.hypot(da * 0.045, p.y - d.y);
        rr -= d.s * Math.exp(-(dist * dist) / (d.w * d.w)) * t;
      }
      // buckles: 5 creases around the middle, deeper than a gentle squeeze so it reads as crushed
      rr *= 1 - 0.09 * t * (0.5 + 0.5 * Math.cos(5 * a + p.y * 40));
      const x = rr * Math.sin(a), z = rr * Math.cos(a);
      // squeezed flat in the middle (someone stepped on it)
      const k = 1 - 0.46 * t * (0.7 + 0.3 * Math.sin(p.y * 30));
      p.set(x * (1 + 0.25 * t), p.y - 0.018 * t, z * k);
    };
    [...walls, label, cap].forEach((g) => deform(g, f));
  }
  const wallsN = walls.map((g) => withNormals(g, 60));
  const shell = mergeParts(wallsN.map((g) => (golden
    ? paint(g, { color: 0xffb42e, rough: 0.12, metal: 1, emit: 0.3 })
    : paint(g, { color: 0xffffff, rough: 1 }))));
  const labelN = withNormals(label, 60);
  paintFn(labelN, (_i, _p, l) => { l.r = golden ? 0.22 : 0.4; l.m = golden ? 0.85 : 0; l.e = golden ? 0.15 : 0; }, true);
  const capN = paint(withNormals(cap, 60), golden
    ? { color: 0xffc85a, rough: 0.1, metal: 1, emit: 0.3 }
    : { color: 0x2f93ff, rough: 0.3, metal: 0, emit: 0.06 });
  return { shell, label: labelN, cap: capN };
}

// ---------------------------------------------------------------------------------------------
// Chips bag: 22 × 28 cm pillow, crumpled, lying flat with the front up.

function chipsGeometry(flavour: number, q: Quality): BufferGeometry {
  const NU = q === 'low' ? 12 : 16, NV = q === 'low' ? 14 : 22;
  const HW = 0.11, HH = 0.14, T = 0.034;
  const r = rng(300 + flavour * 17);
  const seed = r() * 100;
  const pos: number[] = [], uv: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[]) => {
    pos.push(...a.slice(0, 3), ...b.slice(0, 3), ...c.slice(0, 3), ...a.slice(0, 3), ...c.slice(0, 3), ...d.slice(0, 3));
    uv.push(a[3], a[4], b[3], b[4], c[3], c[4], a[3], a[4], c[3], c[4], d[3], d[4]);
  };
  const point = (i: number, j: number, side: 1 | -1): number[] => {
    const u = (i / NU) * 2 - 1, v = (j / NV) * 2 - 1; // -1..1
    const seal = 1 - 2 * CHIPS_SEAL;
    const vv = Math.min(1, Math.abs(v) / seal);
    const puff = Math.sqrt(Math.max(0, 1 - Math.pow(Math.abs(u), 2.4))) * Math.sqrt(Math.max(0, 1 - Math.pow(vv, 3)));
    // crumple: large folds + fine crinkles, both faces share the edge
    const n1 = fbm3(u * 1.6 + seed, v * 1.3, side * 0.7 + seed, 3) - 0.5;
    const n2 = noise3(u * 7 + seed, v * 6, side * 3.1) - 0.5;
    let z = side * T * puff * (0.75 + 0.5 * n1) + 0.012 * n2 * puff * side;
    // the whole bag curls a little
    z += 0.022 * v * v - 0.01 * u;
    let x = u * HW * (1 - 0.06 * puff) + 0.004 * n2;
    let y = v * HH * (1 - 0.04 * puff);
    // seals: flat with a slight wave
    if (Math.abs(v) > seal) z += 0.003 * Math.sin(u * 9 + seed);
    // dog-ear: the top right corner is bent back over the front face (low, not a fin)
    const fx = (u - 0.45) / 0.55, fy = (v - 0.55) / 0.45;
    if (fx > 0 && fy > 0 && fx + fy > 0.9) {
      const k = Math.min(1, (fx + fy - 0.9) * 1.8);
      z += 0.018 * Math.sin(k * 1.4);
      x -= 0.05 * k * k; y -= 0.05 * k * k;
    }
    const tu = side === 1 ? (u + 1) / 4 : 0.5 + (1 - u) / 4; // back face mirrored
    const tv = 1 - (flavour * 0.5 + (1 - (v + 1) / 2) * 0.5);
    return [x, y, z, tu, tv];
  };
  for (const side of [1, -1] as const) {
    for (let j = 0; j < NV; j++) {
      for (let i = 0; i < NU; i++) {
        const a = point(i, j, side), b = point(i + 1, j, side), c = point(i + 1, j + 1, side), d = point(i, j + 1, side);
        if (side === 1) quad(a, b, c, d);
        else quad(a, d, c, b);
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  const n = withNormals(g, 70);
  paintFn(n, (_i, _p, l) => { l.r = 0.42; l.m = 0.75; }, true);
  // flat, front up, long side along X
  const m = new Matrix4().makeRotationX(-Math.PI / 2).premultiply(new Matrix4().makeRotationY(Math.PI / 2));
  restOnGround([n], scaled(m, SCALE.chips));
  return n;
}

// ---------------------------------------------------------------------------------------------
// Plastic bag: a T-shirt bag 30 × 48 cm, gently inflated. The mouth is cut by the texture alpha.

const BAG_H = 0.48;

function bagGeometry(variant: number, q: Quality): BufferGeometry {
  const NU = q === 'low' ? 24 : 36, NV = q === 'low' ? 16 : 26;
  const r = rng(500 + variant);
  const seed = r() * 50;
  const pos: number[] = [], uv: number[] = [];
  const P = (i: number, j: number): number[] => {
    const u = i / NU, h = j / NV;
    const a = u * Math.PI * 2 - Math.PI / 2; // seam on the −x side (a handle), front (+z) at u = 0.25
    const half = 0.15 * (1 - 0.08 * Math.pow(2 * h - 1, 2)); // flat bag half-width
    const inflate = 0.09 * Math.pow(Math.sin(Math.PI * Math.min(1, h * 1.05)), 0.7) * (h > 0.62 ? 1 - smooth(0.62, 1, h) * 0.85 : 1);
    const n = fbm3(Math.cos(a) * 2 + seed, h * 5, Math.sin(a) * 2, 3) - 0.5;
    let x = half * Math.sin(a) * (1 + 0.06 * n);
    let z = inflate * Math.cos(a) * (1 + 0.5 * n);
    // handles lean outward a bit
    const hs = smooth(0.66, 1, h);
    x *= 1 + 0.08 * hs;
    z += 0.01 * n;
    const y = h * BAG_H + 0.015 * n;
    const tu = variant * 0.5 + u * 0.5; // variant half of the atlas
    return [x, y, z, tu, h];
  };
  for (let j = 0; j < NV; j++) {
    for (let i = 0; i < NU; i++) {
      // skip cells fully inside the mouth cut-out (alpha test handles the edges)
      const um = (i + 0.5) / NU, hm = (j + 0.5) / NV;
      const du = Math.min(Math.abs(um - 0.25), Math.abs(um - 0.75));
      if (du < BAG_MOUTH.halfWidth * 0.7 && hm > BAG_MOUTH.top + 0.03) continue;
      const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), d = P(i, j + 1);
      pos.push(...a.slice(0, 3), ...b.slice(0, 3), ...c.slice(0, 3), ...a.slice(0, 3), ...c.slice(0, 3), ...d.slice(0, 3));
      uv.push(a[3], a[4], b[3], b[4], c[3], c[4], a[3], a[4], c[3], c[4], d[3], d[4]);
    }
  }
  // (the bottom closes itself: `inflate` falls to 0 at h = 0)
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  const n = withNormals(g, 80);
  n.computeBoundingSphere();
  // the flutter can push vertices ~5 cm out: pad the culling sphere
  n.boundingSphere!.radius += 0.08;
  return n;
}

/** Wind flutter shared by the bag's colour and shadow materials. Object space, metres. Works
 *  on InstancedMeshes too (phase and wind frame then come from each instance). */
const BAG_VERTEX = /* glsl */ `
uniform float uTime;
uniform vec3 uWind;
${GLSL_NOISE}
vec3 prBag(vec3 p, vec3 n, out vec3 grad) {
#ifdef USE_INSTANCING
  mat4 prM = modelMatrix * instanceMatrix;
#else
  mat4 prM = modelMatrix;
#endif
  vec3 w = (vec4(uWind.x, 0.0, uWind.z, 0.0) * prM).xyz; // world wind in local space
  float ws = length(uWind.xz);
  float gust = uWind.y;
  float ph = dot(prM[3].xyz, vec3(0.61, 0.37, 0.43));
  float t = uTime;
  float amp = (0.004 + 0.0025 * ws) * (0.6 + gust);
  vec3 k1 = vec3(19.0, 29.0, 13.0), k2 = vec3(-23.0, 17.0, 21.0), k3 = vec3(11.0, -37.0, 27.0);
  float a1 = dot(k1, p) - t * (7.0 + ws) + ph;
  float a2 = dot(k2, p) - t * (9.3 + ws) + ph * 1.3;
  float a3 = dot(k3, p) + t * 5.1 + ph * 0.7;
  float f = amp * (sin(a1) + 0.7 * sin(a2) + 0.5 * sin(a3));
  grad = amp * (k1 * cos(a1) + 0.7 * k2 * cos(a2) + 0.5 * k3 * cos(a3));
  float h = clamp(p.y / ${BAG_H.toFixed(3)}, 0.0, 1.0);
  float breath = (0.01 + 0.004 * ws) * sin(t * 2.3 + ph) * sin(3.14159 * h);
  float hs = smoothstep(0.55, 1.0, h);
  vec3 flail = (w * 0.02 + vec3(sin(t * 7.0 + ph), 0.3 * sin(t * 5.0 + ph), cos(t * 6.1 + ph * 1.7)) * (0.02 + 0.006 * ws) * (0.4 + gust)) * hs * hs;
  return n * (f + breath) + flail;
}
`;

function bagMaterials(map: MeshStandardMaterial['map'], u: SharedUniforms): { color: MeshStandardMaterial; depth: MeshDepthMaterial } {
  const color = new MeshStandardMaterial({ map, roughness: 0.42, metalness: 0, side: DoubleSide, alphaTest: 0.5 });
  color.onBeforeCompile = (s) => {
    s.uniforms.uTime = u.uTime;
    s.uniforms.uWind = u.uWind;
    s.vertexShader = s.vertexShader
      .replace('#include <common>', `#include <common>\n${BAG_VERTEX}`)
      .replace('#include <beginnormal_vertex>', `vec3 prGrad; vec3 prOff = prBag(position, normal, prGrad);
        vec3 objectNormal = normalize(normal - (prGrad - dot(prGrad, normal) * normal));`)
      .replace('#include <begin_vertex>', 'vec3 transformed = position + prOff;');
    // thin plastic: sunlight shines through from behind
    s.fragmentShader = s.fragmentShader.replace(
      '#include <lights_fragment_end>',
      `#include <lights_fragment_end>
      #if NUM_SUN_LIGHTS > 0
        float prBack = max(0.0, dot(-normal, sunLights[0].direction));
        reflectedLight.directDiffuse += diffuseColor.rgb * sunLights[0].color * prBack * 0.45;
      #elif NUM_DIR_LIGHTS > 0
        float prBack = max(0.0, dot(-normal, directionalLights[0].direction));
        reflectedLight.directDiffuse += diffuseColor.rgb * directionalLights[0].color * prBack * 0.45;
      #endif`,
    );
  };
  color.customProgramCacheKey = () => 'prop-bag';
  const depth = new MeshDepthMaterial({ depthPacking: RGBADepthPacking, map, alphaTest: 0.5, side: DoubleSide });
  depth.onBeforeCompile = (s) => {
    s.uniforms.uTime = u.uTime;
    s.uniforms.uWind = u.uWind;
    s.vertexShader = s.vertexShader
      .replace('#include <common>', `#include <common>\n${BAG_VERTEX}`)
      .replace('#include <begin_vertex>', 'vec3 prGrad; vec3 transformed = position + prBag(position, normal, prGrad);');
  };
  depth.customProgramCacheKey = () => 'prop-bag-depth';
  return { color, depth };
}

/** The golden bottle: gold metal + clearcoat, a warm fresnel rim, a slow pulse and a shine band
 *  sweeping along it every ~3 s, so it reads as a prize even in the golden-hour glare. */
function goldMaterial(map: MeshStandardMaterial['map'], u: SharedUniforms): MeshPhysicalMaterial {
  const m = vertexPbr(new MeshPhysicalMaterial({ map, clearcoat: 1, clearcoatRoughness: 0.04 }), 'gold');
  const base = m.onBeforeCompile;
  m.onBeforeCompile = (s, r) => {
    base.call(m, s, r);
    s.uniforms.uTime = u.uTime;
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGold;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGold = position;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nvarying vec3 vGold;')
      .replace('#include <lights_fragment_begin>', `
        {
          float gPulse = 0.7 + 0.3 * sin(uTime * 3.0);
          float gRim = pow(1.0 - clamp(abs(dot(normal, normalize(vViewPosition))), 0.0, 1.0), 3.0);
          float gSweep = exp(-pow((vGold.x * 5.0 + vGold.y * 2.0) - (mod(uTime * 0.8, 3.0) * 4.0 - 4.0), 2.0) * 6.0);
          totalEmissiveRadiance = totalEmissiveRadiance * gPulse + vec3(1.0, 0.55, 0.12) * (gRim * 1.6 * gPulse + gSweep * 1.5);
        }
        #include <lights_fragment_begin>`);
  };
  m.customProgramCacheKey = () => 'prop-gold';
  return m;
}

// ---------------------------------------------------------------------------------------------
// Contact shadows: a soft dark stadium under each ground item (the sun's shadow map is far too
// coarse for 10 cm objects, and AO is off on low/medium).

function contactShadowGeometry(hx: number, hz: number): BufferGeometry {
  const rc = Math.min(hx, hz) * 0.9;
  const pad = 0.03 + 0.4 * Math.min(hx, hz);
  const X = hx + pad, Z = hz + pad;
  const NX = 16, NZ = 10;
  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  for (let j = 0; j <= NZ; j++) {
    for (let i = 0; i <= NX; i++) {
      // denser near the rim: cosine spacing
      const x = -X * Math.cos((Math.PI * i) / NX), z = -Z * Math.cos((Math.PI * j) / NZ);
      const qx = Math.abs(x) - (hx - rc), qz = Math.abs(z) - (hz - rc);
      const d = Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0) - rc; // < 0 inside
      const a = 0.7 * (1 - smooth(-0.8 * rc, pad, d));
      pos.push(x, 0.003, z);
      col.push(0, 0, 0, a * a * (3 - 2 * a)); // eased: dark core, long soft tail
    }
  }
  for (let j = 0; j < NZ; j++) {
    for (let i = 0; i < NX; i++) {
      const a = j * (NX + 1) + i, b = a + NX + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new Float32BufferAttribute(col, 4));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

// ---------------------------------------------------------------------------------------------

/** Collider shapes in the rest pose (origin at the bottom centre). */
export interface LitterShape {
  /** Capsule along local X centred at (0, radius, 0); halfLength = half its segment (0 = ball). */
  radius: number;
  halfLength: number;
  /** Rest-pose box half extents; a box collider sits centred at (0, half.y, 0) — best for chips. */
  half: { x: number; y: number; z: number };
}

export interface LitterLib {
  make(kind: LitterKind): Object3D;
  shape(kind: LitterKind): LitterShape;
}

function shapeOf(geos: BufferGeometry[]): LitterShape {
  const b = bounds(geos);
  const half = { x: (b.max.x - b.min.x) / 2, y: (b.max.y - b.min.y) / 2, z: (b.max.z - b.min.z) / 2 };
  const r = (n: number) => Math.round(n * 1000) / 1000;
  return { radius: r(half.y), halfLength: r(Math.max(0, half.x - half.y)), half: { x: r(half.x), y: r(half.y), z: r(half.z) } };
}

export function createLitter(renderer: WebGLRenderer, quality: Quality, uniforms: SharedUniforms, trash: Trash): LitterLib {
  const s = texScale(quality);
  const ultra = quality === 'ultra';
  const canTex = trash.add(canTexture(renderer, s));
  const bottleTex = trash.add(bottleTexture(renderer, s));
  const chipsTex = chipsTextures(renderer, s);
  trash.add(chipsTex.map); trash.add(chipsTex.data);
  const bagTex = trash.add(bagTexture(renderer, s));

  const canMat = trash.add(vertexPbr(new MeshStandardMaterial({ map: canTex }), 'can'));
  const labelMat = trash.add(vertexPbr(new MeshStandardMaterial({ map: bottleTex }), 'label'));
  const chipsMat = trash.add(vertexPbr(new MeshStandardMaterial({
    map: chipsTex.map, bumpMap: chipsTex.data, bumpScale: 2.5, roughnessMap: chipsTex.data, metalnessMap: chipsTex.data,
  }), 'chips'));
  // blue-tinted PET: physical transmission on ultra; elsewhere a cheaper blended plastic whose
  // reflections are not dimmed by its opacity (no extra render pass)
  const petMat = trash.add(ultra
    ? new MeshPhysicalMaterial({ color: new Color(0xbfe0fa), roughness: 0.06, ior: 1.57, transmission: 1, thickness: 0.0015, envMapIntensity: 1.6 })
    : glassify(new MeshPhysicalMaterial({ color: new Color(0x3f8fd0), roughness: 0.06, ior: 1.57, opacity: 0.3, envMapIntensity: 2.2 }), 'pet'));
  const goldMat = trash.add(goldMaterial(bottleTex, uniforms));
  const bagMats = bagMaterials(bagTex, uniforms);
  trash.add(bagMats.color); trash.add(bagMats.depth);
  const shadowMat = trash.add(new MeshBasicMaterial({
    color: 0xffffff, vertexColors: true, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  }));

  const cans = [0, 1, 2].map((v) => trash.add(canGeometry(v, quality)));
  const water = bottleParts(quality, false);
  const bottleOpaque = trash.add(mergeParts([water.label, water.cap]));
  const bottlePet = trash.add(water.shell);
  restOnGround([bottlePet, bottleOpaque], scaled(new Matrix4().makeRotationX(Math.PI / 2).multiply(new Matrix4().makeRotationZ(Math.PI / 2)), SCALE.bottle));
  const gold = bottleParts(quality, true);
  const golden = trash.add(mergeParts([gold.shell, gold.label, gold.cap]));
  restOnGround([golden], scaled(new Matrix4().makeRotationZ(Math.PI / 2), SCALE.golden)); // lying, label up
  const chips = [0, 1].map((f) => trash.add(chipsGeometry(f, quality)));
  const bags = [0, 1].map((v) => trash.add(bagGeometry(v, quality)));

  const shapes: Record<LitterKind, LitterShape> = {
    can: shapeOf(cans),
    bottle: shapeOf([bottlePet, bottleOpaque]),
    chips: shapeOf(chips),
    golden: shapeOf([golden]),
    // bags are caught, not kicked: a ball around the body
    bag: { ...shapeOf(bags), radius: 0.16, halfLength: 0 },
  };
  const blob = (k: LitterKind) => trash.add(contactShadowGeometry(shapes[k].half.x, shapes[k].half.z));
  const blobs: Partial<Record<LitterKind, BufferGeometry>> = { can: blob('can'), bottle: blob('bottle'), chips: blob('chips'), golden: blob('golden') };

  const counters: Record<LitterKind, number> = { can: 0, bottle: 0, chips: 0, bag: 0, golden: 0 };
  const mesh = (g: BufferGeometry, m: Material, shadow = true): Mesh => {
    const x = new Mesh(g, m);
    x.castShadow = shadow;
    x.receiveShadow = true;
    return x;
  };

  return {
    shape: (k) => shapes[k],
    make(kind) {
      const n = counters[kind]++;
      const root = new Group();
      root.name = `litter-${kind}`;
      switch (kind) {
        // ground litter casts no sun shadow (sub-texel in the shadow map): the contact shadow
        // grounds it instead; the flying bag keeps its shadow as a height cue
        case 'can':
          root.add(mesh(cans[n % cans.length], canMat, false));
          break;
        case 'bottle': {
          const p = mesh(bottlePet, petMat, false);
          p.renderOrder = 1;
          root.add(mesh(bottleOpaque, labelMat, false), p);
          break;
        }
        case 'golden':
          root.add(mesh(golden, goldMat, false));
          break;
        case 'chips':
          root.add(mesh(chips[n % chips.length], chipsMat, false));
          break;
        case 'bag': {
          const b = mesh(bags[n % bags.length], bagMats.color);
          b.customDepthMaterial = bagMats.depth;
          root.add(b);
          break;
        }
      }
      const bg = blobs[kind];
      if (bg) {
        const c = new Mesh(bg, shadowMat);
        c.name = 'contact-shadow';
        root.add(c);
      }
      return root;
    },
  };
}
