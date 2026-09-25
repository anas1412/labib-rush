// Street furniture: benches, double-headed lamp posts, bollards, planters (hedge + flowers),
// Tunisian flags (flutter shader), street signs, and the barriers / construction fences that
// close the map. Props are merged per material per chunk (StaticBatch); flags are instanced.
import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { BuildContext } from '../../core/types';
import { G } from '../../core/physics';
import {
  CURB, X_MIN, X_MAX, Z, ROAD_X, TREE_ROWS_Z, ALLEYS, CROSS_STREETS, AVENUE_DE_FRANCE, EAST_BACKDROP,
} from '../../core/layout';
import {
  Owned, Space, StaticBatch, bake, cylCollider, instanced, lathe, makeRng, metricBox, obbCollider, range, tube, xf,
  type Place, type Rng,
} from './common';
import { SIGN_CELLS, fenceMeshTexture, flagTexture, flowerStripTexture, signAtlas, type SignCell } from './canvas';
import type { StreetMaterials } from './materials';
import { CROSSINGS_NORTH, CROSSINGS_SOUTH, CROSSING_HALF, ISLANDS, QUAY_X } from './ground';

export interface FurnitureResult {
  meshes: THREE.Object3D[];
  benches: THREE.Vector3[];
  planters: THREE.Vector3[];
}

const PLANTER_RIM = 0.57; // top of the stone rim ledge above the pavement
const FENCE_H = 2.3; // construction fence top above the pavement
const TARP_BOTTOM = 0.22, TARP_TOP = 1.42;

// ---------------------------------------------------------------------------------------------
// Geometry (local: origin on the ground, front toward +Z)

function benchGeometry(woodTile: number): { wood: THREE.BufferGeometry; iron: THREE.BufferGeometry } {
  const wood: THREE.BufferGeometry[] = [];
  for (const z of [0.17, 0.075, -0.02, -0.115]) wood.push(xf(metricBox(1.8, 0.032, 0.082, woodTile, true), { p: [0, 0.452, z] }));
  for (const [y, z] of [[0.585, -0.2], [0.69, -0.228], [0.795, -0.256]]) wood.push(xf(metricBox(1.8, 0.085, 0.03, woodTile, true), { p: [0, y, z], r: [-0.26, 0, 0] }));
  const iron: THREE.BufferGeometry[] = [];
  for (const sx of [-0.8, 0, 0.8]) {
    const arm = sx !== 0;
    iron.push(tube([[sx, 0.0, 0.25], [sx, 0.22, 0.25], [sx, 0.42, 0.21], [sx, 0.435, 0.02], [sx, 0.445, -0.15], [sx, 0.62, -0.215], [sx, 0.86, -0.285]], 0.022, 9, 4));
    iron.push(tube([[sx, 0.43, -0.1], [sx, 0.22, -0.2], [sx, 0.0, -0.27]], 0.022, 3, 4));
    if (arm) {
      iron.push(tube([[sx, 0.43, 0.2], [sx, 0.58, 0.25], [sx, 0.645, 0.12], [sx, 0.64, -0.05], [sx, 0.63, -0.2]], 0.02, 6, 4));
      iron.push(xf(new THREE.TorusGeometry(0.075, 0.012, 3, 10), { p: [sx, 0.27, 0.02], r: [0, Math.PI / 2, 0] }));
    }
    for (const z of [0.25, -0.27]) iron.push(xf(new THREE.BoxGeometry(0.07, 0.02, 0.09), { p: [sx, 0.01, z] }));
  }
  return { wood: bake(wood), iron: bake(iron) };
}

/** Classic cast-iron post with a scrolled cross-arm carrying two lanterns. */
function lampGeometry(): { iron: THREE.BufferGeometry; glass: THREE.BufferGeometry } {
  const iron: THREE.BufferGeometry[] = [];
  iron.push(lathe([
    [0.25, 0], [0.25, 0.07], [0.2, 0.12], [0.2, 0.36], [0.23, 0.41], [0.15, 0.52], [0.1, 0.8], [0.085, 0.84],
    [0.085, 1.55], [0.1, 1.6], [0.075, 1.66], [0.068, 3.7], [0.085, 3.78], [0.062, 3.86], [0.055, 4.08], [0, 4.1],
  ], 8));
  iron.push(xf(new THREE.SphereGeometry(0.06, 6, 4), { p: [0, 4.14, 0] }));
  iron.push(xf(new THREE.ConeGeometry(0.02, 0.18, 5), { p: [0, 4.28, 0] }));
  const glass: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) {
    iron.push(tube([[0, 3.92, 0], [s * 0.3, 3.96, 0], [s * 0.58, 4.06, 0], [s * 0.72, 4.16, 0]], 0.028, 6, 4));
    // decorative scroll under the arm
    iron.push(tube([[s * 0.06, 3.7, 0], [s * 0.25, 3.72, 0], [s * 0.42, 3.86, 0], [s * 0.36, 3.95, 0], [s * 0.26, 3.9, 0]], 0.014, 7, 3));
    const lx = s * 0.72, ly = 4.16;
    iron.push(xf(lathe([[0.05, 0], [0.11, 0.05], [0.12, 0.09], [0, 0.09]], 6), { p: [lx, ly, 0] }));
    glass.push(xf(lathe([[0.1, 0], [0.17, 0.32], [0.19, 0.38], [0, 0.38]], 6), { p: [lx, ly + 0.09, 0] }));
    iron.push(xf(lathe([[0.21, 0], [0.22, 0.03], [0.12, 0.13], [0.04, 0.22], [0, 0.26]], 6), { p: [lx, ly + 0.46, 0] }));
    // lantern ribs
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + Math.PI / 8;
      iron.push(tube([[lx + Math.cos(a) * 0.105, ly + 0.09, Math.sin(a) * 0.105], [lx + Math.cos(a) * 0.195, ly + 0.47, Math.sin(a) * 0.195]], 0.008, 1, 3));
    }
  }
  return { iron: bake(iron), glass: bake(glass) };
}

function bollardGeometry(): THREE.BufferGeometry {
  return bake([
    lathe([[0.11, 0], [0.11, 0.05], [0.085, 0.09], [0.075, 0.66], [0.095, 0.69], [0.095, 0.74], [0.07, 0.77], [0, 0.77]], 10),
    xf(new THREE.SphereGeometry(0.07, 8, 6), { p: [0, 0.82, 0] }),
  ]);
}

/** Rounded, slightly lumpy clipped-hedge block with vertex AO (for the foliage core material). */
function hedgeGeometry(w: number, h: number, d: number, r: Rng): THREE.BufferGeometry {
  let g: THREE.BufferGeometry = new THREE.BoxGeometry(w, h, d, Math.round(w * 6), Math.round(h * 6), Math.round(d * 6));
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const half = new THREE.Vector3(w / 2, h / 2, d / 2), rad = 0.14, v = new THREE.Vector3(), c = new THREE.Vector3();
  const lump = Array.from({ length: 5 }, () => [range(r, 3, 7), range(r, 0, 6)]);
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    c.set(THREE.MathUtils.clamp(v.x, -half.x + rad, half.x - rad), THREE.MathUtils.clamp(v.y, -half.y + rad, half.y - rad), THREE.MathUtils.clamp(v.z, -half.z + rad, half.z - rad));
    const n = v.clone().sub(c);
    const len = n.length() || 1;
    let bump = 0;
    for (const [f, p] of lump) bump += Math.sin(v.x * f + p) * Math.sin(v.z * f * 1.3 + p) * Math.sin(v.y * f + p);
    v.copy(c).addScaledVector(n, (rad / len) * (1 + bump * 0.12));
    pos.setXYZ(i, v.x, v.y + h / 2, v.z);
  }
  g = mergeVertices(g); // weld box-face seams so the rounded hedge shades smoothly
  g.computeVertexNormals();
  const p2 = g.getAttribute('position') as THREE.BufferAttribute, n2 = g.getAttribute('normal') as THREE.BufferAttribute;
  const uv = new Float32Array(p2.count * 2), col = new Float32Array(p2.count * 3);
  for (let i = 0; i < p2.count; i++) {
    const nx = Math.abs(n2.getX(i)), ny = Math.abs(n2.getY(i));
    const [u, vv] = ny > 0.6 ? [p2.getX(i), p2.getZ(i)] : nx > 0.6 ? [p2.getZ(i), p2.getY(i)] : [p2.getX(i), p2.getY(i)];
    uv.set([u / 0.6, vv / 0.6], i * 2);
    const ao = 0.55 + 0.45 * THREE.MathUtils.clamp(p2.getY(i) / h, 0, 1);
    col.set([ao * 0.85, ao, ao * 0.7], i * 3);
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** Stone planter with a clipped hedge; `flowers` = one alpha-tested strip of blooms along each
 *  long side of the hedge (atlas row 0 or 1 of flowerStripTexture). */
function planterGeometry(tile: number, r: Rng, variant: number): { stone: THREE.BufferGeometry; hedge: THREE.BufferGeometry; flowers: THREE.BufferGeometry } {
  const stone = bake([
    xf(metricBox(2.2, 0.5, 0.9, tile), { p: [0, 0.25, 0] }),
    xf(metricBox(2.3, 0.07, 1.0, tile), { p: [0, 0.535, 0] }),
    xf(metricBox(2.26, 0.05, 0.96, tile), { p: [0, 0.025, 0] }),
  ]);
  const hedge = xf(hedgeGeometry(1.9, 0.5, 0.56, r), { p: [0, 0.55, 0] });
  const strips: THREE.BufferGeometry[] = [];
  for (const zs of [-1, 1]) {
    const g = new THREE.PlaneGeometry(1.86, 0.26);
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    const v0 = variant === 0 ? 0.5 : 0; // atlas row
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i), v0 + uv.getY(i) * 0.5);
    // lean the top out a little, just outside the hedge face, facing outward
    strips.push(xf(g, { p: [0, 0.69, zs * 0.305], r: [zs * 0.12, zs > 0 ? 0 : Math.PI, 0] }));
  }
  return { stone, hedge, flowers: bake(strips) };
}

function barrierGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const bar = (x0: number, y0: number, x1: number, y1: number, rad: number) => {
    const len = Math.hypot(x1 - x0, y1 - y0);
    parts.push(xf(new THREE.CylinderGeometry(rad, rad, len, 6), { p: [(x0 + x1) / 2, (y0 + y1) / 2, 0], r: [0, 0, Math.atan2(x0 - x1, y1 - y0)] }));
  };
  bar(-1, 0.06, -1, 1.1, 0.022);
  bar(1, 0.06, 1, 1.1, 0.022);
  bar(-1, 1.1, 1, 1.1, 0.022);
  bar(-1, 0.28, 1, 0.28, 0.018);
  for (let i = 0; i < 16; i++) {
    const x = -0.9 + (i * 1.8) / 15;
    bar(x, 0.28, x, 1.1, 0.008);
  }
  for (const x of [-1, 1]) {
    parts.push(xf(new THREE.BoxGeometry(0.05, 0.03, 0.62), { p: [x * 0.97, 0.015, 0] }));
    parts.push(xf(new THREE.BoxGeometry(0.05, 0.05, 0.05), { p: [x * 1.03, 1.02, 0] }));
  }
  return bake(parts);
}

function flagPoleGeometry(): THREE.BufferGeometry {
  return bake([
    lathe([[0, 0], [0.13, 0], [0.13, 0.06], [0.09, 0.12], [0.06, 0.2], [0.055, 4], [0.035, 8.1], [0, 8.1]], 12),
    xf(new THREE.SphereGeometry(0.075, 12, 8), { p: [0, 8.16, 0] }),
  ]);
}

// ---------------------------------------------------------------------------------------------

export function buildFurniture(
  ctx: BuildContext, o: Owned, M: StreetMaterials, space: Space, batch: StaticBatch, trees: THREE.Vector3[], hedgeMat: THREE.Material,
): FurnitureResult {
  const r = makeRng(2024);
  const benches: THREE.Vector3[] = [];
  const planters: THREE.Vector3[] = [];
  const P = {
    bench: [] as Place[], lamp: [] as Place[], bollard: [] as Place[], planter: [] as Place[], flag: [] as Place[],
    barrier: [] as Place[], signPole: [] as Place[],
  };
  const y0 = CURB;
  const std = (p: THREE.MeshStandardMaterialParameters) => o.add(new THREE.MeshStandardMaterial(p));

  // local → world offset helper for rotated colliders
  const rot = (lx: number, lz: number, ry: number): [number, number] => [lx * Math.cos(ry) + lz * Math.sin(ry), -lx * Math.sin(ry) + lz * Math.cos(ry)];

  const bench = (x: number, z: number, ry: number) => {
    if (!space.take(x, z, 1.0)) return;
    P.bench.push({ x, y: y0, z, ry });
    const [ox, oz] = rot(0, -0.25, ry);
    obbCollider(o, ctx, x, y0 + 0.23, z, 0.9, 0.23, 0.27, ry, G.LOW_PROP);
    obbCollider(o, ctx, x + ox, y0 + 0.64, z + oz, 0.9, 0.22, 0.05, ry, G.LOW_PROP);
    // litter spot on the ground just in front of the seat (under it is inside the collider)
    const [fx, fz] = rot(range(r, -0.6, 0.6), 0.6, ry);
    benches.push(new THREE.Vector3(x + fx, y0, z + fz));
  };
  const lamp = (x: number, z: number, ry = 0, collide = true, y = y0) => {
    if (collide && !space.take(x, z, 0.5)) return;
    P.lamp.push({ x, y, z, ry });
    if (collide) cylCollider(o, ctx, x, z, y, y + 4.3, 0.2, G.STATIC);
  };
  // bollards are placed deliberately at crossings / road ends (inside reserved zones): no free() test
  const bollard = (x: number, z: number) => {
    space.circle(x, z, 0.2);
    P.bollard.push({ x, y: y0, z, ry: r() * 6 });
    cylCollider(o, ctx, x, z, y0, y0 + 0.85, 0.1, G.LOW_PROP);
  };
  // Stone box up to the rim ledge + a separate hedge box, so the ledge on each long side is a
  // free surface for litter (anchors sit on it, clear of both boxes).
  const planter = (x: number, z: number, ry: number, anchors = true) => {
    if (!space.take(x, z, 1.15)) return;
    P.planter.push({ x, y: y0, z, ry });
    obbCollider(o, ctx, x, y0 + PLANTER_RIM / 2, z, 1.15, PLANTER_RIM / 2, 0.5, ry, G.LOW_PROP);
    obbCollider(o, ctx, x, y0 + 0.8, z, 0.95, 0.25, 0.29, ry, G.LOW_PROP);
    if (anchors) {
      for (const s of [-1, 1]) {
        const [ox, oz] = rot(range(r, -0.8, 0.8), s * 0.395, ry);
        planters.push(new THREE.Vector3(x + ox, y0 + PLANTER_RIM, z + oz));
      }
    }
  };

  // --- promenade: benches between the trees facing the central walk, planters in some gaps ---
  for (const tz of TREE_ROWS_Z) {
    const row = trees.filter((t) => t.z === tz && t.x <= ROAD_X.max).sort((a, b) => a.x - b.x);
    for (let i = 0; i + 1 < row.length; i++) {
      const x = (row[i].x + row[i + 1].x) / 2;
      if (i % 3 === 2) planter(x, tz, 0);
      else bench(x, tz + (tz < 0 ? 0.25 : -0.25), tz < 0 ? 0 : Math.PI);
    }
  }
  // plazas: benches facing each island, planters on the diagonals
  for (const isl of ISLANDS) {
    if (isl.x > ROAD_X.min && isl.x < ROAD_X.max) continue; // promenade statue: keep it clear
    const rb = isl.r + 6.2;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
      bench(isl.x + Math.cos(a) * rb, isl.z + Math.sin(a) * rb, Math.atan2(-Math.cos(a), -Math.sin(a)));
    }
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
      const rp = isl.r + 9.5;
      planter(isl.x + Math.cos(a) * rp, isl.z + Math.sin(a) * rp, -a + Math.PI / 2);
    }
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      lamp(isl.x + Math.cos(a) * (isl.r + 12.5), isl.z + Math.sin(a) * (isl.r + 12.5));
    }
  }
  // flank the alley entrances with planters against the facades
  for (const a of ALLEYS) {
    const z = a.side < 0 ? Z.northFacade + 0.8 : Z.southFacade - 0.8;
    for (const s of [-1, 1]) planter(a.x + s * (a.width / 2 + 1.6), z, 0);
  }

  // --- lamp posts: promenade edges, sidewalks, plazas, cross streets, backdrops ---------------
  for (const s of [-1, 1]) {
    for (let x = ROAD_X.min + 8 + (s > 0 ? 12 : 0); x < ROAD_X.max - 4; x += 24) lamp(x, s * 13.35, s < 0 ? 0 : Math.PI);
    for (let x = ROAD_X.min + 16 + (s > 0 ? 13 : 0); x < ROAD_X.max - 4; x += 26) lamp(x, s * 22.8, 0);
    for (let x = EAST_BACKDROP.xMin + 10; x < QUAY_X - 6; x += 24) {
      lamp(x, s * 13.35, 0, false);
      lamp(x + 12, s * 22.8, 0, false);
    }
    for (let x = AVENUE_DE_FRANCE.xMin + 6; x < X_MIN - 4; x += 24) lamp(x, s * 5.8, 0, false);
  }
  for (const cs of CROSS_STREETS) {
    for (const s of [-1, 1]) {
      lamp(cs.x - cs.width / 2 + 0.8, s * 40, Math.PI / 2);
      lamp(cs.x + cs.width / 2 - 0.8, s * 47, Math.PI / 2);
    }
  }

  // --- bollards: crossing landings and the road ends against the plazas ----------------------
  for (const [list, s] of [[CROSSINGS_NORTH, -1], [CROSSINGS_SOUTH, 1]] as const) {
    for (const c of list) {
      for (const dx of [-1, 1]) {
        bollard(c + dx * (CROSSING_HALF + 0.45), s * 13.55);
        bollard(c + dx * (CROSSING_HALF + 0.45), s * 22.45);
      }
    }
  }
  for (const x of [ROAD_X.min - 0.45, ROAD_X.max + 0.45]) {
    for (const zs of [-1, 1]) for (let k = 0; k < 5; k++) bollard(x, zs * (14.8 + k * 1.6));
  }

  // --- flags: behind Ibn Khaldoun, behind the clock tower, flanking the approach to the Bourguiba
  // statue on the open central walk (the tree rows' canopies start at |z| 5.6) ------------------
  const flagAt = (x: number, z: number) => {
    if (!space.take(x, z, 0.4)) return;
    P.flag.push({ x, y: y0, z });
    cylCollider(o, ctx, x, z, y0, y0 + 3, 0.1, G.STATIC);
  };
  for (const z of [-10, -3.5, 3.5, 10]) flagAt(X_MIN + 10, z);
  for (const z of [-12, -4, 4, 12]) flagAt(X_MAX - 8, z);
  for (const s of [-1, 1]) flagAt(ISLANDS[1].x - 8.5, s * 2.5);

  // --- map closures: construction fences (2.3 m, printed tarp) with barriers + planters as
  // dressing. The fence is the wall the player meets: its collider face sits just in front of the
  // fence plane and a jump from the ground (≤ 1.5 m) never clears the visible top.
  const fenceParts = { frame: [] as THREE.BufferGeometry[], mesh: [] as THREE.BufferGeometry[], tarp: [] as THREE.BufferGeometry[], feet: [] as THREE.BufferGeometry[] };
  const signParts: THREE.BufferGeometry[] = [];
  const plate = (cell: SignCell, w: number, h: number, t: { p: [number, number, number]; r?: [number, number, number] }) => {
    // front face shows the atlas cell, the rest plain metal
    const g = new THREE.BoxGeometry(w, h, 0.02);
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    const [u0, v0, u1, v1] = SIGN_CELLS[cell];
    const [m0, n0, m1, n1] = SIGN_CELLS.metal;
    for (let i = 0; i < uv.count; i++) {
      const front = i >= 16 && i < 20;
      const [a0, b0, a1, b1] = front ? [u0, v0, u1, v1] : [m0, n0, m1, n1];
      uv.setXY(i, a0 + uv.getX(i) * (a1 - a0), b0 + uv.getY(i) * (b1 - b0));
    }
    signParts.push(xf(g, t));
  };
  /** Fence of equal panels (≤ 3.6 m) from a to b along one axis; `face` = yaw whose +Z points
   *  toward the player. Barriers listed in `barriersAt` (along-line offsets) stand flush in front. */
  const fence = (ax: number, az: number, bx: number, bz: number, face: number, barriersAt: number[] = []) => {
    const len = Math.hypot(bx - ax, bz - az), n = Math.ceil(len / 3.6), W = len / n;
    const dx = (bx - ax) / len, dz = (bz - az) / len; // along the line
    const nx = Math.sin(face), nz = Math.cos(face); // toward the player
    for (let i = 0; i < n; i++) {
      const cx = ax + dx * W * (i + 0.5), cz = az + dz * W * (i + 0.5);
      const t = { p: [cx, y0, cz] as [number, number, number], r: [0, face, 0] as [number, number, number] };
      const w = W - 0.06; // clamps + a small gap between panels
      fenceParts.frame.push(xf(bake([
        xf(new THREE.CylinderGeometry(0.02, 0.02, FENCE_H - 0.12, 6), { p: [-w / 2, (FENCE_H + 0.12) / 2, 0] }),
        xf(new THREE.CylinderGeometry(0.02, 0.02, FENCE_H - 0.12, 6), { p: [w / 2, (FENCE_H + 0.12) / 2, 0] }),
        xf(new THREE.CylinderGeometry(0.02, 0.02, w, 6), { p: [0, FENCE_H, 0], r: [0, 0, Math.PI / 2] }),
        xf(new THREE.CylinderGeometry(0.02, 0.02, w, 6), { p: [0, 0.12, 0], r: [0, 0, Math.PI / 2] }),
      ]), t));
      const mesh = new THREE.PlaneGeometry(w, FENCE_H - 0.12);
      const muv = mesh.getAttribute('uv') as THREE.BufferAttribute;
      for (let k = 0; k < muv.count; k++) muv.setXY(k, muv.getX(k) * (w / 0.4), muv.getY(k) * ((FENCE_H - 0.12) / 0.4));
      fenceParts.mesh.push(xf(xf(mesh, { p: [0, (FENCE_H + 0.12) / 2, 0] }), t));
      // printed privacy tarp tied to the player side of the panel
      const tarp = new THREE.PlaneGeometry(w - 0.04, TARP_TOP - TARP_BOTTOM);
      const [u0, v0, u1, v1] = SIGN_CELLS.tarp;
      const tuv = tarp.getAttribute('uv') as THREE.BufferAttribute;
      for (let k = 0; k < tuv.count; k++) tuv.setXY(k, u0 + tuv.getX(k) * (u1 - u0), v0 + tuv.getY(k) * (v1 - v0));
      fenceParts.tarp.push(xf(xf(tarp, { p: [0, (TARP_TOP + TARP_BOTTOM) / 2, 0.025] }), t));
    }
    for (let i = 0; i <= n; i++) {
      fenceParts.feet.push(xf(xf(new THREE.BoxGeometry(0.2, 0.14, 0.62), { p: [0, 0.07, 0] }), { p: [ax + dx * W * i, y0, az + dz * W * i], r: [0, face, 0] }));
    }
    for (const u of barriersAt) P.barrier.push({ x: ax + dx * u + nx * 0.07, y: y0, z: az + dz * u + nz * 0.07, ry: face });
    // collider: face 0.1 m in front of the fence plane, 0.4 m deep behind it, well above any jump
    const cx = (ax + bx) / 2 + nx * (0.1 - 0.2), cz = (az + bz) / 2 + nz * (0.1 - 0.2);
    obbCollider(o, ctx, cx, 2.0, cz, len / 2, 2.5, 0.2, face, G.STATIC);
  };
  // X_MIN: across the Avenue de France opening (facades line it at |z| = 12)
  const fx0 = X_MIN + 0.5;
  fence(fx0, AVENUE_DE_FRANCE.zMax, fx0, AVENUE_DE_FRANCE.zMin, Math.PI / 2, [8.91, 10.97, 13.03, 15.09]);
  for (const z of [-8.2, 8.2]) planter(fx0 + 2.2, z, Math.PI / 2, false);
  // X_MAX: the whole plaza width; the avenue beyond is "under works" (visual backdrop)
  const fx1 = X_MAX - 0.5;
  fence(fx1, Z.northFacade, fx1, Z.southFacade, -Math.PI / 2, [3.2, 5.3, 28.97, 31.03, 54.7, 56.8]);
  for (const z of [-18, -7, 7, 18]) planter(fx1 - 2.2, z, Math.PI / 2, false);
  // alley ends: fence across the full width, 'Travaux' sign, two barriers
  for (const a of ALLEYS) {
    const zEnd = a.side < 0 ? Z.northFacade - a.depth + 1.2 : Z.southFacade + a.depth - 1.2;
    const face = a.side < 0 ? 0 : Math.PI; // toward the avenue
    const x0 = a.x - a.width / 2, x1 = a.x + a.width / 2;
    fence(face === 0 ? x0 : x1, zEnd, face === 0 ? x1 : x0, zEnd, face, [a.width / 2 - 2.2, a.width / 2 + 2.2]);
    plate('travaux', 0.9, 0.45, { p: [a.x + Math.sin(face) * 0.04, y0 + 1.72, zEnd + Math.cos(face) * 0.04], r: [0, face, 0] });
  }

  // --- street signs -----------------------------------------------------------------------
  const signPost = (x: number, z: number, ry: number, cell: SignCell, w: number, h: number, y: number) => {
    if (!space.take(x, z, 0.3)) return;
    P.signPole.push({ x, y: y0, z, s: [1, (y + h / 2 + 0.05) / 3, 1] });
    cylCollider(o, ctx, x, z, y0, y0 + 2.5, 0.06, G.STATIC);
    const ox = Math.sin(ry) * 0.05, oz = Math.cos(ry) * 0.05;
    plate(cell, w, h, { p: [x + ox, y0 + y, z + oz], r: [0, ry, 0] });
  };
  signPost(ROAD_X.min + 1.5, 12.2, Math.PI / 2, 'avenue', 0.95, 0.32, 2.55);
  signPost(ROAD_X.max - 1.5, -12.2, -Math.PI / 2, 'avenue', 0.95, 0.32, 2.55);
  signPost(ROAD_X.min - 2, -26.5, Math.PI / 2, 'indep', 0.95, 0.32, 2.55);
  signPost(ROAD_X.min - 2, 26.5, Math.PI / 2, 'indep', 0.95, 0.32, 2.55);
  signPost(ROAD_X.max + 2, -26.5, -Math.PI / 2, 'janvier', 0.95, 0.32, 2.55);
  signPost(ROAD_X.max + 2, 26.5, -Math.PI / 2, 'janvier', 0.95, 0.32, 2.55);
  signPost(X_MIN + 3, 13.5, Math.PI / 2, 'france', 0.95, 0.32, 2.55);
  for (const c of CROSSINGS_NORTH) signPost(c + CROSSING_HALF + 1.3, -13.45, Math.PI / 2, 'crossing', 0.6, 0.6, 2.3);
  for (const c of CROSSINGS_SOUTH) signPost(c - CROSSING_HALF - 1.3, 13.45, -Math.PI / 2, 'crossing', 0.6, 0.6, 2.3);

  // --- materials & meshes -------------------------------------------------------------------
  const flagTex = o.add(flagTexture(ctx.renderer));
  const cloth = std({ map: flagTex, color: 0xd9d9d9, side: THREE.DoubleSide, roughness: 0.78 }); // keeps the red out of the tone-mapper's shoulder in full sun
  cloth.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = ctx.uniforms.uTime;
    shader.uniforms.uWind = ctx.uniforms.uWind;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform vec3 uWind;\nvec3 stFlag;')
      .replace('#include <beginnormal_vertex>', /* glsl */ `
      // travelling wave from the pole (x = 0) to the fly (x = 2.4), grows toward the free edge;
      // the whole flag turns around the pole to stream downwind
      #ifdef USE_INSTANCING
        float stSeed = dot(instanceMatrix[3].xz, vec2(0.71, 0.37));
      #else
        float stSeed = 0.0;
      #endif
      float stWs = clamp(length(uWind.xz), 0.3, 6.0);
      float stU = position.x / 2.4;
      float stK = 2.6, stOm = 3.2 + stWs * 0.9;
      float stPh = stOm * uTime - stK * position.x + stSeed;
      float stA = (0.1 + 0.05 * stWs) * stU * (0.8 + 0.3 * sin(uTime * 0.7 + stSeed));
      float stDz = stA * sin(stPh) + 0.04 * stU * sin(stPh * 2.1 + position.y * 2.5);
      float stDzdx = -stA * stK * cos(stPh) + (0.1 + 0.05 * stWs) / 2.4 * sin(stPh);
      float stSag = (1.0 - clamp(stWs / 3.5, 0.0, 1.0)) * stU * stU * 0.45;
      float stYaw = atan(-uWind.z, uWind.x);
      mat2 stR = mat2(cos(stYaw), -sin(stYaw), sin(stYaw), cos(stYaw));
      stFlag = vec3(position.x, position.y - stSag, position.z + stDz);
      stFlag.xz = stR * stFlag.xz;
      vec3 objectNormal = normalize(vec3(-stDzdx, 0.0, 1.0));
      objectNormal.xz = stR * objectNormal.xz;
      #ifdef USE_TANGENT
        vec3 objectTangent = vec3( tangent.xyz );
      #endif`)
      .replace('#include <begin_vertex>', 'vec3 transformed = stFlag;');
  };
  cloth.customProgramCacheKey = () => 'st-flag';
  const flagGeo = new THREE.PlaneGeometry(2.4, 1.6, 24, 10).translate(1.2, -0.8, 0);
  const poleMat = std({ color: 0xe9e9e4, roughness: 0.3, metalness: 0.6 });

  const signTex = o.add(signAtlas(ctx.renderer));
  const signMat = std({ map: signTex, roughness: 0.4, metalness: 0.2 });
  const tarpMat = std({ map: signTex, roughness: 0.85 });
  // welded mesh: blended by its alpha so the thin wires fade into a grey veil at distance instead
  // of vanishing (alpha-tested mips drop below the threshold)
  const fenceTex = o.add(fenceMeshTexture(ctx.renderer));
  const fenceMat = std({
    color: 0xb4b8ba, alphaMap: fenceTex, transparent: true, depthWrite: false, side: THREE.DoubleSide, metalness: 0.8, roughness: 0.4,
  });
  const rubber = std({ color: 0x2b2b2b, roughness: 0.9 });
  const flowerTex = o.add(flowerStripTexture(ctx.renderer));
  const flowerMat = std({ map: flowerTex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.7 });

  const b = benchGeometry(M.tile.wood);
  const l = lampGeometry();
  const bol = bollardGeometry();
  const pl = [planterGeometry(M.tile.promenade, r, 0), planterGeometry(M.tile.promenade, r, 1)];
  const bar = barrierGeometry();
  const pole = new THREE.CylinderGeometry(0.04, 0.045, 3, 8).translate(0, 1.5, 0);
  batch.place(b.wood, M.wood, P.bench, 'street-wood', true);
  batch.place(b.iron, M.iron, P.bench, 'street-iron', true);
  batch.place(l.iron, M.iron, P.lamp, 'street-iron', true);
  batch.place(l.glass, M.lampGlass, P.lamp, 'street-lamp-glass', false);
  batch.place(bol, M.iron, P.bollard, 'street-iron', true);
  batch.place(pole, M.iron, P.signPole, 'street-iron', true);
  pl.forEach((g, v) => {
    const at = P.planter.filter((_, i) => i % 2 === v);
    batch.place(g.stone, M.promenade, at, 'street-planter-stone', true);
    batch.place(g.hedge, hedgeMat, at, 'street-hedges', true);
    batch.place(g.flowers, flowerMat, at, 'street-flowers', false);
  });
  batch.place(bar, M.galvanized, P.barrier, 'street-galvanized', true);
  for (const g of fenceParts.frame) batch.add(g, M.galvanized, 'street-galvanized', true);
  for (const g of [b.wood, b.iron, l.iron, l.glass, bol, bar, pole, ...pl.flatMap((g) => [g.stone, g.hedge, g.flowers])]) g.dispose();

  const meshes: THREE.Object3D[] = [
    instanced(o, flagPoleGeometry(), poleMat, P.flag, { cast: true, name: 'street-flag-poles' }),
    instanced(o, flagGeo, cloth, P.flag.map((p) => ({ ...p, y: p.y + 8.0 })), { name: 'street-flags' }),
  ];
  const merged = (parts: THREE.BufferGeometry[], mat: THREE.Material, name: string, cast: boolean) => {
    const m = new THREE.Mesh(o.add(bake(parts)), mat);
    m.name = name;
    m.castShadow = cast;
    m.receiveShadow = true;
    meshes.push(m);
  };
  merged(signParts, signMat, 'street-signs', true);
  merged(fenceParts.tarp, tarpMat, 'street-fence-tarps', true);
  merged(fenceParts.mesh, fenceMat, 'street-fence-mesh', false);
  merged(fenceParts.feet, rubber, 'street-fence-feet', false);
  return { meshes, benches, planters };
}
