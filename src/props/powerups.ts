// Power-up display models (~0.5 m): a glass of Tunisian mint tea with pine nuts, a sugared
// bambalouni on greaseproof paper, a mashmoum jasmine bouquet and a red felt chéchia.
// Each is modelled at real size, then scaled up as a whole (origin at the bottom centre).
import {
  BufferGeometry, CatmullRomCurve3, Color, Float32BufferAttribute, Group, Matrix4, Mesh, MeshPhysicalMaterial,
  MeshStandardMaterial, Quaternion, SphereGeometry, TorusGeometry, TubeGeometry, Vector3, type Material,
  type Object3D, type WebGLRenderer,
} from 'three';
import type { PowerUpKind, Quality } from '../core/types';
import { BAMBA_ATLAS, bambalouniTextures, feltTexture } from './textures';
import {
  Trash, deform, fbm3, glassify, lathe, lerp, mergeParts, noise3, paint, paintFn, refine, rng, smooth, texScale, vertexPbr,
  withNormals, type PartLook, type Profile,
} from './util';

const sq = (x: number) => x * x;

/** Lathe with crease-aware normals. */
const slathe = (p: Profile, segs: number, crease = 50, uv?: (s: number, u: number) => [number, number]) =>
  withNormals(lathe(p, segs, uv), crease);

/**
 * Mint leaf: ovate, serrated, folded along the midrib, tip curling back. Base at the origin,
 * pointing +Y, face toward +Z. Vertex colours: lighter midrib, darker serrated edges.
 */
function mintLeaf(len: number, wid: number, curl: number, seed: number, coarse = false): BufferGeometry {
  const NS = coarse ? 6 : 9, NW = coarse ? 2 : 3;
  const r = rng(seed);
  const pos: number[] = [];
  const cols: number[] = [];
  const P = (i: number, k: number): [number, number, number] => {
    const s = i / NS;
    // broad ovate blade: rounded base (widest ~40 % up), pointed tip
    const half = (wid / 2) * Math.sqrt(Math.max(0, 1 - sq(2 * Math.pow(s, 0.75) - 1)));
    const tooth = 1 + 0.08 * Math.abs(Math.sin(s * Math.PI * 9 + r() * 0.3));
    const x = (k / NW) * half * tooth;
    const y = s * len;
    const z = Math.abs(x) * 0.2 - curl * s * s * len + 0.04 * len * Math.sin(s * Math.PI * 3) * Math.abs(k / NW);
    return [x, y, z];
  };
  const C = (k: number, s: number) => {
    const t = Math.abs(k) / NW;
    const c = new Color().setRGB(lerp(0.2, 0.1, t), lerp(0.52, 0.34, t) * (1 - 0.15 * s), lerp(0.16, 0.08, t));
    return [c.r, c.g, c.b];
  };
  for (let i = 0; i < NS; i++) {
    for (let k = -NW; k < NW; k++) {
      const a = P(i, k), b = P(i, k + 1), c = P(i + 1, k + 1), d = P(i + 1, k);
      pos.push(...a, ...b, ...c, ...a, ...c, ...d);
      const ca = C(k, i / NS), cb = C(k + 1, i / NS), cc = C(k + 1, (i + 1) / NS), cd = C(k, (i + 1) / NS);
      cols.push(...ca, ...cb, ...cc, ...ca, ...cc, ...cd);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  const n = withNormals(g, 70);
  paintFn(n, (i, _p, l) => { l.c.setRGB(cols[i * 3], cols[i * 3 + 1], cols[i * 3 + 2]); l.r = 0.62; });
  return n;
}

/** Places a leaf (built along +Y) at `at`, pointing along `dir`, rolled by `roll`. */
function placeLeaf(g: BufferGeometry, at: Vector3, dir: Vector3, roll: number): BufferGeometry {
  const up = new Vector3(0, 1, 0);
  const m = new Matrix4().makeRotationY(roll);
  const q = new Matrix4().lookAt(new Vector3(), dir, up.clone().cross(dir).lengthSq() < 1e-6 ? new Vector3(1, 0, 0) : up);
  // lookAt aims −Z at dir; our leaf points +Y: rotate +Y → −Z first
  const align = new Matrix4().makeRotationX(-Math.PI / 2);
  g.applyMatrix4(m).applyMatrix4(align).applyMatrix4(q).translate(at.x, at.y, at.z);
  return g;
}

function tube(points: Vector3[], radius: number, segs: number, look: PartLook): BufferGeometry {
  const g = new TubeGeometry(new CatmullRomCurve3(points), segs, radius, 6, false);
  return paint(g, look);
}

// ---------------------------------------------------------------------------------------------

export interface PowerupLib { make(kind: PowerUpKind): Object3D }

export function createPowerups(renderer: WebGLRenderer, quality: Quality, trash: Trash): PowerupLib {
  const lo = quality === 'low';
  const ultra = quality === 'ultra';
  const s = texScale(quality);
  const plain = trash.add(vertexPbr(new MeshStandardMaterial(), 'plain'));

  // --- mint tea ---------------------------------------------------------------------------
  // A gilded Tunisian tea glass on a small brass saucer: dark amber tea with a caramel froth,
  // pine nuts, and a generous bunch of mint spilling over the rim (the cue that sells "tea").
  const TEA_SCALE = 3.6;
  const LIFT = 0.003; // the glass stands in the saucer's centre dip
  const glassProf: Profile = [
    [0, 0], [0.019, 0], [0.0215, 0.0015], [0.0226, 0.006], [0.0232, 0.013], [0.0276, 0.087], [0.0279, 0.0888],
    [0.0274, 0.0898], [0.0266, 0.0893], [0.0262, 0.087], [0.0219, 0.015], [0.0195, 0.0118], [0.012, 0.0108], [0, 0.0105],
  ];
  const wallR = (y: number) => lerp(0.0232, 0.0276, (y - 0.013) / 0.074); // outer wall radius at y
  const teaGlass = trash.add(mergeParts([paint(slathe(glassProf, lo ? 24 : 48, 45), { color: 0xffffff, rough: 1 }).translate(0, LIFT, 0)]));
  const glassMat = trash.add(ultra
    ? new MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.02, transmission: 1, thickness: 0.004, ior: 1.5 })
    : glassify(new MeshPhysicalMaterial({ color: 0x0a0f12, roughness: 0.02, metalness: 0, opacity: 0.14, ior: 1.5, envMapIntensity: 2.4 }), 'tea', 0.6));
  // contents: tea channel 1 gets an amber rim glow (light passing through the edge of the tea)
  const teaMat = trash.add(vertexPbr(new MeshStandardMaterial(), 'tea'));
  {
    const base = teaMat.onBeforeCompile;
    teaMat.onBeforeCompile = (sh, r) => {
      base.call(teaMat, sh, r);
      sh.fragmentShader = sh.fragmentShader.replace('#include <lights_fragment_begin>', `
        if (vPbr.w > 0.5) {
          float tRim = pow(1.0 - clamp(abs(dot(normal, normalize(vViewPosition))), 0.0, 1.0), 2.5);
          totalEmissiveRadiance += vec3(0.7, 0.18, 0.025) * (0.07 + 0.55 * tRim);
        }
        #include <lights_fragment_begin>`);
    };
  }
  const teaParts: BufferGeometry[] = [];
  const fill = 0.062;
  {
    const tea = slathe(refine([[0, 0.0108], [0.0193, 0.0118], [0.0218, 0.016], [wallR(fill) - 0.0012, fill], [0, fill]], 0.008), lo ? 24 : 40, 40);
    const nrm = tea.getAttribute('normal');
    teaParts.push(paintFn(tea, (i, p, l) => {
      const top = nrm.getY(i) > 0.7 && p.y > fill - 0.001; // froth surface only (rim verts are split)
      const r = Math.hypot(p.x, p.z);
      const froth = top ? 0.6 + 0.4 * noise3(p.x * 900, p.z * 900, 1) : 0;
      if (top) l.c.setRGB(lerp(0.42, 0.66, froth), lerp(0.2, 0.4, froth), lerp(0.07, 0.2, froth));
      else l.c.setRGB(0.025, 0.0035, 0.001).multiplyScalar(0.6 + 0.4 * smooth(0.012, fill, p.y)); // deep red-brown tea, darkest at the bottom
      l.r = top ? 0.55 - 0.2 * (r / 0.025) : 0.06;
      l.e = top ? 0 : 0.6;
      l.ch = top ? 0 : 1;
    }));
  }
  // bubbles around the rim of the froth
  const br = rng(21);
  for (let i = 0; i < (lo ? 10 : 26); i++) {
    const a = br() * Math.PI * 2, rr = 0.0185 + br() * 0.0055, sz = 0.0008 + br() * 0.0012;
    const b = new SphereGeometry(sz, 6, 4);
    b.translate(Math.cos(a) * rr, fill + sz * 0.3, Math.sin(a) * rr);
    teaParts.push(paint(b, { color: 0xe6c79a, rough: 0.2 }));
  }
  // pine nuts: floating on the froth, and a few stuck to the glass at the froth line
  const pn = rng(8);
  const pineNut = (at: Vector3, yaw: number, pitch = 0) => {
    const g = new SphereGeometry(0.005, 8, 6);
    g.scale(0.5, 0.4, 1.2);
    g.applyMatrix4(new Matrix4().makeRotationX(pitch)).applyMatrix4(new Matrix4().makeRotationY(yaw));
    g.translate(at.x, at.y, at.z);
    teaParts.push(paintFn(g, (_i, p, l) => {
      const t = smooth(-0.005, 0.005, (p.x - at.x) * Math.cos(yaw) - (p.z - at.z) * Math.sin(yaw));
      l.c.setRGB(0.94, lerp(0.86, 0.76, t), lerp(0.66, 0.5, t));
      l.r = 0.45;
    }));
  };
  for (let i = 0; i < 12; i++) {
    const a = pn() * Math.PI * 2, rr = Math.sqrt(pn()) * 0.017;
    pineNut(new Vector3(Math.cos(a) * rr, fill + 0.0012, Math.sin(a) * rr), pn() * Math.PI);
  }
  for (let i = 0; i < 5; i++) {
    const a = 0.6 + i * 1.25 + pn() * 0.4, y = fill + 0.001 + pn() * 0.004, rr = wallR(y) - 0.0036;
    pineNut(new Vector3(Math.sin(a) * rr, y, Math.cos(a) * rr), a + Math.PI / 2, 1.2 + pn() * 0.5);
  }
  // gilded decoration on the glass: a broad band under the rim, a thin one below, a foot band
  const goldLook = { color: 0xe8b64a, rough: 0.22, metal: 1 };
  for (const [y0, y1] of [[0.0795, 0.0858], [0.0712, 0.0736], [0.0142, 0.0188]] as const) {
    teaParts.push(paint(slathe([[wallR(y0) + 0.0004, y0], [wallR(y1) + 0.0004, y1]], lo ? 24 : 48), goldLook));
  }
  // gilded lip on the rim: frames the glass so it reads as glass from afar
  teaParts.push(paint(slathe([[0.027, 0.0882], [0.0284, 0.0888], [0.0282, 0.0898], [0.0267, 0.0902]], lo ? 24 : 48), goldLook));
  // little gold diamonds between the bands
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2, y = 0.0765;
    const r0 = wallR(y) + 0.0004;
    const d = new SphereGeometry(0.0026, 4, 2);
    d.scale(0.35, 1, 0.12);
    d.applyMatrix4(new Matrix4().makeRotationY(a));
    d.translate(Math.sin(a) * r0, y, Math.cos(a) * r0);
    teaParts.push(paint(d, goldLook));
  }
  // mint: a bunch of sprigs pushed into the glass; broad leaves in crowded opposite pairs just
  // above the rim (the lower ones drooping over it), a tender cluster at each tip
  const sprig = (pts: Vector3[], big: number, seed: number) => {
    teaParts.push(tube(pts, 0.0009, 12, { color: 0x5f8a36, rough: 0.6 }));
    const stem = new CatmullRomCurve3(pts);
    const nodes = [0.5, 0.62, 0.73, 0.83, 0.92];
    nodes.forEach((t, ni) => {
      const at = stem.getPointAt(t);
      const f = ni / (nodes.length - 1);
      const size = big * lerp(1, 0.55, f);
      for (const side of [-1, 1]) {
        const ang = side * (Math.PI / 2) + ni * (Math.PI / 2) + seed; // decussate pairs
        const dir = new Vector3(Math.cos(ang), lerp(-0.15, 0.75, f), Math.sin(ang)).normalize();
        // rolled about the midrib so the blades face outward, not edge-on to a side view
        teaParts.push(placeLeaf(mintLeaf(size, size * 0.72, 0.18, seed * 10 + ni * 2 + side, lo), at, dir, side * 0.9));
      }
    });
    const tip = stem.getPointAt(1);
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + seed;
      teaParts.push(placeLeaf(mintLeaf(big * 0.5, big * 0.42, 0.12, seed * 10 + 20 + k, lo), tip, new Vector3(Math.cos(a) * 0.6, 1, Math.sin(a) * 0.6).normalize(), a + 0.8));
    }
  };
  const V = (x: number, y: number, z: number) => new Vector3(x, y, z);
  sprig([V(0.003, 0.05, -0.002), V(0.006, 0.09, -0.004), V(0.01, 0.106, -0.008), V(0.012, 0.118, -0.01)], 0.036, 3);
  sprig([V(-0.004, 0.05, 0.002), V(-0.009, 0.089, 0.004), V(-0.017, 0.101, 0.008), V(-0.022, 0.107, 0.011)], 0.034, 7);
  sprig([V(0.002, 0.05, 0.004), V(0.004, 0.09, 0.009), V(0.009, 0.1, 0.017), V(0.012, 0.104, 0.024)], 0.034, 11);
  sprig([V(-0.002, 0.05, -0.004), V(-0.005, 0.09, -0.008), V(-0.01, 0.108, -0.012), V(-0.011, 0.116, -0.016)], 0.032, 5);
  if (!lo) sprig([V(0.004, 0.05, 0.001), V(0.009, 0.089, 0.002), V(0.018, 0.1, 0.001), V(0.024, 0.104, 0.0)], 0.032, 9);
  // a couple of leaves steeping in the tea
  teaParts.push(placeLeaf(mintLeaf(0.024, 0.014, 0.05, 71), new Vector3(-0.012, fill + 0.0004, 0.006), new Vector3(1, 0.05, 0.4).normalize(), 1.5));
  teaParts.push(placeLeaf(mintLeaf(0.02, 0.012, 0.05, 72), new Vector3(0.01, fill + 0.0004, 0.01), new Vector3(-0.3, 0.05, -1).normalize(), 1.4));
  teaParts.forEach((g) => g.translate(0, LIFT, 0));
  // engraved brass saucer
  {
    const saucer = slathe([...refine([[0, 0.003], [0.022, 0.0031], [0.045, 0.0045]], 0.0022), [0.0505, 0.0068], [0.0515, 0.0062], [0.05, 0.0055], [0.046, 0.002], [0.04, 0], [0, 0]], lo ? 28 : 44, 40);
    teaParts.push(paintFn(saucer, (_i, p, l) => {
      const r = Math.hypot(p.x, p.z), a = Math.atan2(p.x, p.z);
      const engraved = p.y > 0.0025 && r > 0.024 && r < 0.044 && Math.sin(r * 1400 + Math.sin(a * 12) * 2) > 0.55;
      l.c.setRGB(engraved ? 0.34 : 0.82, engraved ? 0.2 : 0.56, engraved ? 0.05 : 0.2);
      l.r = engraved ? 0.5 : 0.3;
      l.m = 0.9;
    }));
  }
  const teaGeo = trash.add(mergeParts(teaParts));

  // --- bambalouni -------------------------------------------------------------------------
  const BAMBA_SCALE = 3.1;
  const bt = bambalouniTextures(renderer, s);
  trash.add(bt.map); trash.add(bt.data);
  const bambaMat = trash.add(vertexPbr(new MeshStandardMaterial({ map: bt.map, bumpMap: bt.data, bumpScale: 3, roughnessMap: bt.data }), 'bambalouni'));
  const [, , rw, rh] = BAMBA_ATLAS.ring;
  const ring = new TorusGeometry(0.052, 0.022, lo ? 16 : 28, lo ? 40 : 72);
  {
    const uv = ring.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * rw) / BAMBA_ATLAS.W, 1 - ((1 - uv.getY(i)) * rh) / BAMBA_ATLAS.H);
  }
  ring.rotateX(-Math.PI / 2);
  const ringG = ring.toNonIndexed();
  ring.dispose();
  const rr = rng(13);
  const lumpSeed = rr() * 10;
  deform(ringG, (p) => {
    // hand-shaped dough: flat, lumpy, out of round, the tube fatter on one side
    const a = Math.atan2(p.z, p.x);
    const rad = Math.hypot(p.x, p.z);
    const lump = fbm3(Math.cos(a) * 2 + lumpSeed, Math.sin(a) * 2, p.y * 30, 3) - 0.5;
    const centre = 0.052 * (1 + 0.14 * lump + 0.06 * Math.sin(a * 2 + 1) + 0.03 * Math.sin(a * 3 + 2));
    const fat = 1 + 0.18 * Math.sin(a + 0.6);
    const r2 = centre + (rad - 0.052) * fat; // (rad − R) runs across the tube
    p.x = Math.cos(a) * r2;
    p.z = Math.sin(a) * r2 * 0.95;
    p.y = p.y * (0.5 + 0.12 * lump) * fat + 0.015 + 0.002 * Math.sin(a * 3);
  });
  const ringN = withNormals(ringG, 80);
  paintFn(ringN, (_i, _p, l) => { l.r = 0.75; l.m = 0; }, true); // × roughness map: oil sheen on the crust
  // greaseproof paper: 21 cm square, crinkled, corners lifting
  const NP = lo ? 10 : 20;
  const paperPos: number[] = [], paperUv: number[] = [];
  const [, py, pw, ph] = BAMBA_ATLAS.paper;
  const PP = (i: number, j: number) => {
    const u = i / NP, v = j / NP;
    const x = (u - 0.5) * 0.21, z = (v - 0.5) * 0.21;
    const edge = Math.max(Math.abs(u - 0.5), Math.abs(v - 0.5)) * 2;
    const y = 0.0015 + 0.02 * Math.pow(Math.max(0, edge - 0.55) / 0.45, 2) * (0.6 + 0.4 * noise3(u * 3, v * 3, 2))
      + 0.003 * (fbm3(u * 6, v * 6, 4) - 0.5);
    return { p: [x, y, z], t: [(u * pw) / BAMBA_ATLAS.W, 1 - (py + (1 - v) * ph) / BAMBA_ATLAS.H] };
  };
  for (let j = 0; j < NP; j++) for (let i = 0; i < NP; i++) {
    const a = PP(i, j), b = PP(i + 1, j), c = PP(i + 1, j + 1), d = PP(i, j + 1);
    // face up (+Y): a → d → c
    for (const q of [a, d, c, a, c, b]) { paperPos.push(...q.p); paperUv.push(...q.t); }
    // underside
    for (const q of [a, c, d, a, b, c]) { paperPos.push(q.p[0], q.p[1] - 0.0004, q.p[2]); paperUv.push(...q.t); }
  }
  const paperG = new BufferGeometry();
  paperG.setAttribute('position', new Float32BufferAttribute(paperPos, 3));
  paperG.setAttribute('uv', new Float32BufferAttribute(paperUv, 2));
  const paperN = withNormals(paperG, 60);
  paintFn(paperN, (_i, _p, l) => { l.r = 1; }, true);
  const bambaGeo = trash.add(mergeParts([ringN, paperN]));

  // --- mashmoum ---------------------------------------------------------------------------
  const MASH_SCALE = 3.1;
  const mParts: BufferGeometry[] = [];
  // stick (a peeled twig), then the stalks the buds are threaded on, gathered into a slim bundle
  // tightly bound with red thread, flaring out just under the flower dome
  mParts.push(tube([new Vector3(0, 0, 0), new Vector3(0.001, 0.05, 0), new Vector3(0, 0.09, 0.001), new Vector3(0, 0.105, 0)], 0.0022, 10, { color: 0xb89a6a, rough: 0.8 }));
  const bundle = slathe(refine([[0.0026, 0.095], [0.0042, 0.105], [0.0055, 0.125], [0.009, 0.14], [0.017, 0.152], [0.022, 0.158]], 0.004), lo ? 12 : 20, 60);
  mParts.push(paintFn(bundle, (_i, p, l) => {
    const a = Math.atan2(p.x, p.z);
    const stripe = 0.5 + 0.5 * Math.sin(a * 18);
    l.c.setRGB(lerp(0.3, 0.42, stripe), lerp(0.42, 0.5, stripe), lerp(0.14, 0.2, stripe));
    l.r = 0.7;
  }));
  const thread: Vector3[] = [];
  for (let i = 0; i <= 50; i++) {
    const t = i / 50, y = lerp(0.1, 0.128, t), rad = lerp(0.0036, 0.006, t) + 0.0009;
    const a = t * Math.PI * 2 * 9;
    thread.push(new Vector3(Math.sin(a) * rad, y, Math.cos(a) * rad));
  }
  mParts.push(paint(new TubeGeometry(new CatmullRomCurve3(thread), lo ? 60 : 110, 0.0008, 3, false), { color: 0xc8102e, rough: 0.55 }));
  // a few green sepals under the dome
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + 0.3;
    mParts.push(placeLeaf(mintLeaf(0.02, 0.009, 0.1, 90 + k), new Vector3(Math.cos(a) * 0.012, 0.15, Math.sin(a) * 0.012), new Vector3(Math.cos(a), -0.35, Math.sin(a)).normalize(), a));
  }
  // dome of jasmine buds (fibonacci cap): buds point outward, blush-pink tips, cream bases
  const nBuds = lo ? 70 : 150;
  const cap = new Vector3(0, 0.166, 0);
  const budR = 0.036;
  const bud = paintFn(new SphereGeometry(1, lo ? 5 : 6, lo ? 3 : 4).translate(0, 1, 0).scale(0.0042, 0.0058, 0.0042),
    (_i, p, l) => {
      const t = p.y / 0.0116;
      l.c.setRGB(lerp(0.9, 0.98, smooth(0, 0.3, t)), lerp(0.88, 0.97, smooth(0, 0.3, t)) - 0.12 * smooth(0.75, 1, t), lerp(0.72, 0.94, smooth(0, 0.3, t)) - 0.05 * smooth(0.75, 1, t));
      l.r = 0.55;
    });
  const Y = new Vector3(0, 1, 0);
  const qb = new Quaternion();
  const golden = Math.PI * (3 - Math.sqrt(5));
  const jr = rng(17);
  const orient = (g: BufferGeometry, dir: Vector3, at: Vector3, spin = 0) =>
    g.applyMatrix4(new Matrix4().makeRotationY(spin)).applyMatrix4(new Matrix4().makeRotationFromQuaternion(qb.setFromUnitVectors(Y, dir))).translate(at.x, at.y, at.z);
  for (let i = 0; i < nBuds; i++) {
    const y = 1 - ((i + 0.5) / nBuds) * 1.3; // wraps under the equator toward the bundle
    const rad = Math.sqrt(Math.max(0, 1 - y * y));
    const a = i * golden;
    const n = new Vector3(Math.cos(a) * rad, y, Math.sin(a) * rad);
    const at = cap.clone().addScaledVector(n, budR * (0.86 + jr() * 0.08));
    const dir = n.clone().add(new Vector3((jr() - 0.5) * 0.2, 0.1, (jr() - 0.5) * 0.2)).normalize();
    mParts.push(orient(bud.clone(), dir, at));
  }
  // a few open blossoms: five soft petals around a yellow-green eye
  const petal = paintFn(new SphereGeometry(1, 6, 4).scale(0.0042, 0.0009, 0.0024).translate(0.0045, 0, 0), (_i, _p, l) => { l.c.setRGB(0.99, 0.985, 0.96); l.r = 0.5; });
  const eye = paint(new SphereGeometry(0.0013, 6, 4), { color: 0xd8d27a, rough: 0.6 });
  for (let k = 0; k < 7; k++) {
    const a = k * 2.3 + 0.4, y = 0.35 + 0.5 * ((k * 37) % 7) / 7;
    const rad = Math.sqrt(1 - y * y);
    const n = new Vector3(Math.cos(a) * rad, y, Math.sin(a) * rad);
    const at = cap.clone().addScaledVector(n, budR * 1.12);
    for (let p = 0; p < 5; p++) {
      // petals lie in the plane perpendicular to n
      const g = petal.clone().applyMatrix4(new Matrix4().makeRotationY((p / 5) * Math.PI * 2 + k));
      mParts.push(orient(g, n, at));
    }
    mParts.push(orient(eye.clone(), n, at.clone().addScaledVector(n, 0.0008)));
  }
  bud.dispose(); petal.dispose(); eye.dispose();
  const mashGeo = trash.add(mergeParts(mParts));

  // --- chechia ----------------------------------------------------------------------------
  const CHE_SCALE = 2.4;
  const felt = trash.add(feltTexture(renderer, s));
  felt.repeat.set(4, 2);
  const feltMat = trash.add(vertexPbr(new MeshPhysicalMaterial({
    bumpMap: felt, bumpScale: 0.55, roughnessMap: felt, sheen: 0.18, sheenRoughness: 0.5, sheenColor: new Color(0xffffff),
  }), 'chechia'));
  {
    // sheen tinted by the albedo: crimson on the felt (not peach), grey on the black silk tassel
    const base = feltMat.onBeforeCompile;
    feltMat.onBeforeCompile = (sh, r) => {
      base.call(feltMat, sh, r);
      sh.fragmentShader = sh.fragmentShader.replace('material.sheenColor = sheenColor;', 'material.sheenColor = sheenColor * (0.05 + diffuseColor.rgb * 1.2);');
    };
  }
  const cheProf: Profile = refine([
    [0, 0.1065], [0.045, 0.1045], [0.066, 0.0995], [0.0765, 0.092], [0.0825, 0.08], [0.0855, 0.064], [0.0875, 0.03], [0.0885, 0.002],
    [0.09, -0.0005], [0.0915, 0.0015], [0.0905, 0.03], [0.088, 0.065], [0.085, 0.082], [0.079, 0.095], [0.068, 0.103], [0.045, 0.108], [0.02, 0.1095], [0, 0.11],
  ], 0.008);
  const cheSeed = 4.2;
  const cheBody = deform(slathe(cheProf, lo ? 24 : 44, 60, (sf, u) => [u, sf]), (p) => {
    // soft felt: a little out of round, the crown slightly dented
    const a = Math.atan2(p.x, p.z);
    const k = 1 + 0.018 * Math.sin(a * 2 + 0.7) + 0.01 * (fbm3(Math.cos(a) * 2, p.y * 20, cheSeed, 3) - 0.5);
    p.x *= k; p.z *= k;
    if (p.y > 0.095) p.y -= 0.004 * Math.exp(-(p.x * p.x + (p.z - 0.02) * (p.z - 0.02)) / 0.0012);
  });
  const cheN = withNormals(cheBody, 60);
  {
    // inside faces (lining) look toward the axis or downward: darker, worn felt
    const nrm = cheN.getAttribute('normal');
    paintFn(cheN, (i, p, l) => {
      const r = Math.hypot(p.x, p.z) || 1;
      const radial = (nrm.getX(i) * p.x + nrm.getZ(i) * p.z) / r;
      const inside = radial < -0.3 || nrm.getY(i) < -0.5;
      l.c.set(inside ? 0x3a0508 : 0x6e0614);
      l.r = 1;
    }, true);
  }
  // tassel: black silk strands from a button at the crown, draped over the +x edge
  const cParts: BufferGeometry[] = [cheN];
  const tr = rng(77);
  const nStrands = lo ? 16 : 30;
  for (let i = 0; i < nStrands; i++) {
    const spread = (tr() - 0.5) * 0.4 + 0.25;
    const d = new Vector3(Math.cos(spread), 0, Math.sin(spread));
    const len = 0.075 + tr() * 0.03;
    const out = (r: number, y: number) => new Vector3(d.x * r, y, d.z * r);
    const pts = [out(0, 0.1125), out(0.04, 0.111), out(0.066, 0.1055), out(0.08, 0.098), out(0.089, 0.085),
      out(0.093 + tr() * 0.004, 0.085 - len * 0.55), out(0.096 + tr() * 0.01, 0.085 - len)];
    cParts.push(new TubeGeometry(new CatmullRomCurve3(pts), lo ? 6 : 10, 0.0015, 3, false));
    paint(cParts[cParts.length - 1], { color: 0x0b0a0a, rough: 0.38 });
  }
  const button = new SphereGeometry(0.0055, 10, 6).scale(1, 0.6, 1).translate(0, 0.1115, 0);
  cParts.push(paint(button, { color: 0x0b0a0a, rough: 0.35 }));
  const cheGeo = trash.add(mergeParts(cParts));

  const make = (geo: BufferGeometry, mat: Material, scale: number, shadow = true): Mesh => {
    const m = new Mesh(geo, mat);
    m.scale.setScalar(scale);
    m.castShadow = shadow;
    m.receiveShadow = true;
    return m;
  };

  return {
    make(kind) {
      const root = new Group();
      root.name = `powerup-${kind}`;
      switch (kind) {
        case 'tea': {
          // slimmer + taller than life so the glass silhouette reads at gameplay distance
          const glass = make(teaGlass, glassMat, TEA_SCALE, false);
          const tea = make(teaGeo, teaMat, TEA_SCALE);
          glass.scale.set(TEA_SCALE * 0.9, TEA_SCALE * 1.15, TEA_SCALE * 0.9);
          tea.scale.copy(glass.scale);
          glass.renderOrder = 1;
          root.add(tea, glass);
          break;
        }
        case 'bambalouni': {
          const m = make(bambaGeo, bambaMat, BAMBA_SCALE);
          m.rotation.x = 0.35;
          m.position.y = 0.04;
          root.add(m);
          break;
        }
        case 'mashmoum':
          root.add(make(mashGeo, plain, MASH_SCALE));
          break;
        case 'chechia':
          const m = make(cheGeo, feltMat, CHE_SCALE);
          m.rotation.set(0.2, 0, -0.08); // tipped toward the viewer so crown + tassel read
          m.position.y = 0.03;
          root.add(m);
          break;
      }
      return root;
    },
  };
}

