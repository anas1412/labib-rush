// Clock Tower of Place du 14 Janvier 2011 (38 m): a square obelisk clad in gilded metal lattice
// panels (tapering base, shoulder with corner lanterns, tall shaft), a clock box with four white
// dials whose hands show the real local time (Africa/Tunis), and a gilded pyramid. It stands on a
// stepped plinth in a round flower bed (the street module paves the island around it).
import {
  CanvasTexture, InstancedMesh, Matrix4, MeshStandardMaterial, Object3D, Quaternion, RepeatWrapping, SRGBColorSpace, Vector3,
  type BufferGeometry, type Material,
} from 'three';
import { CURB, LANDMARKS } from '../../core/layout';
import { Bucket, T, box, flat, lathe, mergeAll, molding, PROFILES } from './kit';
import type { Env, Landmark } from './env';
import { crossCards } from './plants';

const { x: X0, z: Z0 } = LANDMARKS.clockTower;
const Y0 = CURB;
const R_ISLAND = 6.8;
const B0 = 6.4, B1 = 4.9; // frustum base / top width
const S0 = 1.0, S1 = 13.8; // frustum from / to height (above the plinth top)
const SH0 = 4.75, SH1 = 4.55; // shaft width bottom / top
const CLOCK0 = 28.6, CLOCK1 = 32.9; // clock box (heights above Y0)
const TOP = 38;

const TUNIS_FMT = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Tunis', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

/** Hours/minutes/seconds of the current time in Tunis. */
function tunisTime(d = new Date()): { h: number; m: number; s: number } {
  const parts = TUNIS_FMT.formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { h: get('hour') % 24, m: get('minute'), s: get('second') };
}

export function buildClockTower(env: Env): Landmark {
  const m = env.mats;
  const b = new Bucket();
  const add = (mat: Material, g: BufferGeometry, M: Matrix4) => b.add(mat, g.applyMatrix4(M));
  const lattice = latticeMaterial(env.ctx.quality === 'low' ? 512 : 1024);

  // ---------------------------------------------------------------------------------------------
  // Island planting: stone curb ring, lawn, clipped box hedge ring, flower clumps (instanced).
  add(m.stoneLight, lathe([[R_ISLAND - 0.32, 0], [R_ISLAND, 0], [R_ISLAND + 0.02, 0.3], [R_ISLAND - 0.05, 0.36], [R_ISLAND - 0.32, 0.36], [R_ISLAND - 0.32, 0]], 72), T(X0, Y0, Z0));
  add(m.grass, lathe([[R_ISLAND - 0.3, 0.26], [0, 0.26]], 72), T(X0, Y0, Z0));
  add(m.hedge, lathe([[R_ISLAND - 0.95, 0.26], [R_ISLAND - 0.95, 0.5], [R_ISLAND - 0.75, 0.68], [R_ISLAND - 0.5, 0.66], [R_ISLAND - 0.36, 0.5], [R_ISLAND - 0.36, 0.26]], 72), T(X0, Y0, Z0));
  b.setOptions(m.grass, { castShadow: false });
  b.setOptions(m.hedge, { castShadow: false }); // knee-high ring: shadow cost for no visible gain

  // Plinth: two dark-stone steps.
  const py = Y0 + 0.26;
  add(m.stoneWarm, box(7.6, 0.42, 7.6), T(X0, py, Z0));
  add(m.stoneWarm, box(7.0, 0.42, 7.0), T(X0, py + 0.42, Z0));
  const ty = py + 0.84; // tower base

  // ---------------------------------------------------------------------------------------------
  // Lattice skin: frustum + shaft (flat-shaded square lathes), panel ribs at the corners.
  const sq = (w0: number, w1: number, h: number) => flat(lathe([[w0 * Math.SQRT1_2, 0], [w1 * Math.SQRT1_2, h]], 4, Math.PI / 4));
  add(lattice, sq(B0 + 0.2, B0 + 0.2, S0), T(X0, ty, Z0));
  add(lattice, sq(B0, B1, S1 - S0), T(X0, ty + S0, Z0));
  add(m.gilt, cornerRibs(B0, B1, S1 - S0), T(X0, ty + S0, Z0));
  add(m.gilt, box(B1 + 0.5, 0.35, B1 + 0.5), T(X0, ty + S1, Z0));
  for (const s of [0, 1, 2, 3]) add(m.gilt, molding(PROFILES.string(1.0), B1 + 0.5), T(X0 + Math.sin(s * Math.PI / 2) * (B1 / 2 + 0.25), ty + S1 - 0.2, Z0 + Math.cos(s * Math.PI / 2) * (B1 / 2 + 0.25), s * Math.PI / 2));
  // corner lanterns on the shoulder
  for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const lx = X0 + dx * (B1 / 2 + 0.05), lz = Z0 + dz * (B1 / 2 + 0.05);
    add(m.gilt, lathe([[0.16, 0], [0.12, 0.2], [0.07, 0.9], [0.14, 1.0], [0.2, 1.25], [0.12, 1.45], [0.04, 1.6], [0, 1.65]], 10).scale(1.7, 1.7, 1.7), T(lx, ty + S1 + 0.35, lz));
  }
  const shaftY = ty + S1 + 0.35;
  add(lattice, sq(SH0, SH1, CLOCK0 - (shaftY - Y0)), T(X0, shaftY, Z0));
  add(m.gilt, cornerRibs(SH0, SH1, CLOCK0 - (shaftY - Y0)), T(X0, shaftY, Z0));

  // Clock box: gilded frame, four dials (atlas), cornice, pyramid, finial.
  const cy0 = Y0 + CLOCK0, ch = CLOCK1 - CLOCK0, cw = SH1 + 0.2;
  add(m.gilt, box(cw + 0.3, 0.3, cw + 0.3), T(X0, cy0 - 0.3, Z0));
  add(lattice, box(cw, ch, cw), T(X0, cy0, Z0));
  const dial = env.signs.draw(400, 400, paintDial);
  const dialS = cw - 0.5;
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2;
    const M = T(X0 + Math.sin(a) * (cw / 2 + 0.01), cy0 + (ch - dialS) / 2, Z0 + Math.cos(a) * (cw / 2 + 0.01), a);
    add(env.signs.material, env.signs.plane(dial, dialS, dialS), M);
    add(m.gilt, frameGeo(dialS + 0.1, 0.14, 0.1), T(0, -0.05, 0).premultiply(M));
  }
  add(m.gilt, box(cw + 0.5, 0.25, cw + 0.5), T(X0, cy0 + ch, Z0));
  for (const s of [0, 1, 2, 3]) add(m.gilt, molding(PROFILES.cornice(0.7), cw + 0.5), T(X0 + Math.sin(s * Math.PI / 2) * (cw / 2 + 0.25), cy0 + ch - 0.2, Z0 + Math.cos(s * Math.PI / 2) * (cw / 2 + 0.25), s * Math.PI / 2));
  const pyrY = cy0 + ch + 0.25, pyrH = Y0 + TOP - 0.7 - pyrY;
  add(m.gilt, flat(lathe([[(cw + 0.2) * Math.SQRT1_2, 0], [0.06, pyrH]], 4, Math.PI / 4)), T(X0, pyrY, Z0));
  add(m.gilt, lathe([[0.12, 0], [0.16, 0.12], [0.06, 0.2], [0.03, 0.7], [0, 0.72]], 8), T(X0, pyrY + pyrH - 0.02, Z0));

  // Flower clumps: crossed alpha cards (three colour mixes) in the bed between hedge and plinth.
  const spots = flowerSpots(env.ctx.quality === 'low' ? 120 : env.ctx.quality === 'medium' ? 200 : 300);
  const cells = env.plants.flowers;
  spots.forEach((M, i) => b.add(env.signs.material, crossCards(cells[i % cells.length], 0.62, 0.5, 2, i * 0.7), M));
  b.setOptions(env.signs.material, { castShadow: false });
  const root = b.build('clockTower');

  // ---------------------------------------------------------------------------------------------
  // Hands: one InstancedMesh (hour + minute per face), updated once per second.
  const handGeo = mergeAll([
    box(0.12, 1.0, 0.04).translate(0, -0.12, 0),
    flat(lathe([[0.1, 0], [0, 0.18]], 4, Math.PI / 4)).scale(1, 1, 0.3).translate(0, 0.88, 0),
    lathe([[0.1, 0], [0.1, 0.05], [0, 0.06]], 12).rotateX(Math.PI / 2),
  ]);
  const handMat = new MeshStandardMaterial({ name: 'clockHands', color: 0x1a1512, metalness: 0.6, roughness: 0.4 });
  const hands = new InstancedMesh(handGeo, handMat, 8);
  hands.name = 'clockTower:hands';
  hands.castShadow = false;
  const faces: Matrix4[] = [];
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2;
    faces.push(T(X0 + Math.sin(a) * (cw / 2 + 0.06), cy0 + ch / 2, Z0 + Math.cos(a) * (cw / 2 + 0.06), a));
  }
  const tmp = new Object3D();
  const R = dialS * 0.5;
  const setHands = () => {
    const { h, m: mi, s } = tunisTime();
    const aH = (((h % 12) + mi / 60) / 12) * Math.PI * 2;
    const aM = ((mi + s / 60) / 60) * Math.PI * 2;
    for (let k = 0; k < 4; k++) {
      for (const [i, ang, len, z] of [[0, aH, R * 0.5, 0.02], [1, aM, R * 0.78, 0.06]] as const) {
        tmp.position.set(0, 0, z);
        tmp.rotation.set(0, 0, -ang);
        tmp.scale.set(len > R * 0.6 ? 0.8 : 1.15, len, 1);
        tmp.updateMatrix();
        hands.setMatrixAt(k * 2 + i, tmp.matrix.premultiply(faces[k]));
      }
    }
    hands.instanceMatrix.needsUpdate = true;
    hands.computeBoundingSphere();
  };
  setHands();
  root.add(hands);

  // Colliders: planted island (steppable), plinth, tower.
  env.cylinder(X0, Y0, Z0, R_ISLAND, 0.3);
  env.aabb(X0 - 3.8, py, Z0 - 3.8, X0 + 3.8, ty, Z0 + 3.8);
  env.aabb(X0 - B0 / 2, ty, Z0 - B0 / 2, X0 + B0 / 2, ty + S1, Z0 + B0 / 2);
  env.aabb(X0 - SH0 / 2, ty + S1, Z0 - SH0 / 2, X0 + SH0 / 2, Y0 + TOP, Z0 + SH0 / 2);

  let acc = 1;
  return {
    root,
    update(dt) {
      acc += dt;
      if (acc >= 1) { acc = 0; setHands(); }
    },
    dispose() {
      hands.dispose(); handGeo.dispose(); handMat.dispose();
      lattice.map?.dispose(); lattice.bumpMap?.dispose(); lattice.roughnessMap?.dispose(); lattice.dispose();
    },
  };
}

// ---------------------------------------------------------------------------------------------

/** Thin gilded ribs on the four vertical edges of a square frustum (w0 → w1 over h). */
function cornerRibs(w0: number, w1: number, h: number): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const up = new Vector3(0, 1, 0), q = new Quaternion();
  for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const p0 = new Vector3((dx * w0) / 2, 0, (dz * w0) / 2), p1 = new Vector3((dx * w1) / 2, h, (dz * w1) / 2);
    const d = p1.clone().sub(p0);
    q.setFromUnitVectors(up, d.clone().normalize());
    parts.push(box(0.16, d.length(), 0.16).applyQuaternion(q).translate(p0.x, p0.y, p0.z));
  }
  return mergeAll(parts);
}

/** Square frame (border bars) of outer size s, bar width t, depth d, in XY centred at (0, s/2). */
function frameGeo(s: number, t: number, d: number): BufferGeometry {
  return mergeAll([
    box(s, t, d).translate(0, 0, 0), box(s, t, d).translate(0, s - t, 0),
    box(t, s, d).translate(-s / 2 + t / 2, 0, 0), box(t, s, d).translate(s / 2 - t / 2, 0, 0),
  ]);
}

/** White dial: bronze chapter ring, hour bars, minute ticks, sun-ray spokes to the square frame. */
function paintDial(c: CanvasRenderingContext2D, p: CanvasRenderingContext2D, W: number, H: number): void {
  const cx = W / 2, cy = H / 2, R = W * 0.4;
  c.fillStyle = '#f3f0e8'; c.fillRect(0, 0, W, H);
  c.strokeStyle = '#7b5a2c'; c.lineCap = 'round';
  c.lineWidth = 7;
  for (let i = 0; i < 12; i++) { // spokes from the ring to the frame
    const a = (i / 12) * Math.PI * 2;
    const r1 = R * 1.08, r2 = Math.min(W, H) * 0.5 / Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a))) - 6;
    c.beginPath(); c.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); c.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2); c.stroke();
    c.beginPath(); c.arc(cx + Math.cos(a) * R * 1.16, cy + Math.sin(a) * R * 1.16, 9, 0, Math.PI * 2); c.stroke();
  }
  c.lineWidth = 16; c.beginPath(); c.arc(cx, cy, R * 1.03, 0, Math.PI * 2); c.stroke();
  c.lineWidth = 4; c.beginPath(); c.arc(cx, cy, R * 0.8, 0, Math.PI * 2); c.stroke();
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2, big = i % 5 === 0;
    c.lineWidth = big ? 12 : 3;
    c.beginPath(); c.moveTo(cx + Math.cos(a) * R * (big ? 0.82 : 0.9), cy + Math.sin(a) * R * (big ? 0.82 : 0.9)); c.lineTo(cx + Math.cos(a) * R * 0.97, cy + Math.sin(a) * R * 0.97); c.stroke();
  }
  c.strokeStyle = '#8a6a36'; c.lineWidth = 10; c.strokeRect(5, 5, W - 10, H - 10);
  // enamel dial: smooth; bronze details: metallic
  p.fillStyle = 'rgb(0,90,0)'; p.fillRect(0, 0, W, H);
}

/** Gilded lattice skin: 8-point star rosettes on a square grid, gold strapwork over a dark
 *  bronze backing, with panel seams; bump + metal/rough maps painted on matching canvases. */
function latticeMaterial(size: number): MeshStandardMaterial {
  const mk = () => { const c = document.createElement('canvas'); c.width = c.height = size; return c; };
  const col = mk(), hgt = mk(), pbr = mk();
  const C = col.getContext('2d')!, Hc = hgt.getContext('2d')!, P = pbr.getContext('2d')!;
  C.fillStyle = '#3b2416'; C.fillRect(0, 0, size, size);
  Hc.fillStyle = '#000'; Hc.fillRect(0, 0, size, size);
  P.fillStyle = 'rgb(0,170,60)'; P.fillRect(0, 0, size, size);
  const cells = 2, S = size / cells;
  const strap = (g: CanvasRenderingContext2D, style: string, w: number) => {
    g.strokeStyle = style; g.lineWidth = w; g.lineJoin = 'round';
    for (let i = 0; i < cells; i++) {
      for (let j = 0; j < cells; j++) {
        const cx = (i + 0.5) * S, cy = (j + 0.5) * S, r = S * 0.36;
        for (const rot of [0, Math.PI / 4]) { // octagram = two squares
          g.beginPath();
          for (let k = 0; k < 4; k++) { const a = rot + (k * Math.PI) / 2 + Math.PI / 4; g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); }
          g.closePath(); g.stroke();
        }
        g.beginPath(); g.arc(cx, cy, S * 0.15, 0, Math.PI * 2); g.stroke();
        for (let k = 0; k < 4; k++) { // diagonals to the cell corners
          const a = Math.PI / 4 + (k * Math.PI) / 2;
          g.beginPath(); g.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); g.lineTo(cx + Math.cos(a) * S * 0.71, cy + Math.sin(a) * S * 0.71); g.stroke();
        }
        for (let k = 0; k < 4; k++) { // small rosettes between cells
          const a = (k * Math.PI) / 2;
          g.beginPath(); g.arc(cx + Math.cos(a) * S * 0.5, cy + Math.sin(a) * S * 0.5, S * 0.07, 0, Math.PI * 2); g.stroke();
        }
      }
    }
    g.lineWidth = w * 1.8; g.strokeRect(0, 0, size, size); // panel seam frame
  };
  strap(C, '#c89a4e', size * 0.022);
  strap(Hc, '#fff', size * 0.022);
  strap(P, 'rgb(0,90,255)', size * 0.022);
  // subtle rust/verdigris in the backing
  for (let i = 0; i < 300; i++) {
    const x = (Math.sin(i * 12.9898) * 43758.5453 % 1 + 1) % 1 * size, y = (Math.sin(i * 78.233) * 12345.678 % 1 + 1) % 1 * size;
    C.fillStyle = `rgba(${90 + (i % 5) * 10},${50 + (i % 3) * 10},30,0.25)`;
    C.beginPath(); C.arc(x, y, 4 + (i % 7), 0, Math.PI * 2); C.fill();
  }
  const map = new CanvasTexture(col); map.colorSpace = SRGBColorSpace; map.anisotropy = 8;
  const bump = new CanvasTexture(hgt); bump.anisotropy = 8;
  const pb = new CanvasTexture(pbr); pb.anisotropy = 8;
  for (const t of [map, bump, pb]) { t.wrapS = t.wrapT = RepeatWrapping; t.needsUpdate = true; }
  const mat = new MeshStandardMaterial({
    name: 'lattice', map, bumpMap: bump, bumpScale: 4, roughnessMap: pb, metalnessMap: pb, roughness: 1, metalness: 1,
  });
  mat.userData.tile = 2.4;
  return mat;
}

/** Deterministic flower-clump placements in the bed between the hedge ring and the plinth. */
function flowerSpots(n: number): Matrix4[] {
  const out: Matrix4[] = [];
  const t = new Object3D();
  for (let i = 0; out.length < n && i < n * 6; i++) {
    const h1 = Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1, h2 = Math.abs(Math.sin(i * 78.233) * 24634.6345) % 1;
    const r = 3.9 + h1 * (R_ISLAND - 1.4 - 3.9), a = h2 * Math.PI * 2; // cards (≤ 0.45 m half-width) stay inside the hedge ring
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (Math.max(Math.abs(x), Math.abs(z)) < 3.95) continue; // keep off the plinth
    t.position.set(X0 + x, Y0 + 0.26, Z0 + z);
    t.rotation.set(0, h1 * 6.28, 0);
    const s = 0.8 + h2 * 0.6;
    t.scale.set(s, s * (0.9 + h1 * 0.4), s);
    t.updateMatrix();
    out.push(t.matrix.clone());
  }
  return out;
}
