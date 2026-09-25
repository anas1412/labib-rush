// Core dev page: a playable graybox of the whole avenue (from layout.ts) running the real engine,
// input, player controller and camera rig. Dev-only placeholder avatar. NOT part of the game build.
// URL: ?q=low|medium|high|ultra  ?spawn=x,z,yawDeg  ?cam=x,y,z&target=x,y,z (fixed camera)  ?menu=1
// Keys (dev): 1-4 quality · M menu camera · T mint tea x1.4 · K knockback · G shake · R respawn
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Assets } from '../src/core/assets';
import { Emitter } from '../src/core/events';
import { ALL, FIXED_DT, G, groups, Physics } from '../src/core/physics';
import { TEA_SPEED } from '../src/core/config';
import * as L from '../src/core/layout';
import { DEFAULT_SETTINGS, type AvatarAction, type AvatarMotion, type GameEvents, type InputFrame, type LabibAvatar, type Quality } from '../src/core/types';
import { createEngine } from '../src/core/engine';
import { createInput } from '../src/core/input';
import { createPlayerController } from '../src/player/controller';
import { createCameraRig } from '../src/player/cameraRig';

const params = new URLSearchParams(location.search);
const vec3 = (s: string | null) => (s ? new THREE.Vector3(...(s.split(',').map(Number) as [number, number, number])) : null);
const C = L.CURB;

// ---------------------------------------------------------------------------------------------
// Graybox: boxes/cylinders merged per material per 60 m chunk (like the real world builders).
type MatKey = keyof typeof MAT_DEFS;
const MAT_DEFS = {
  asphalt: { color: 0x3d3e41, roughness: 0.93, cast: false },
  paving: { color: 0xb9ab95, roughness: 0.88, cast: false },
  plaza: { color: 0xc7b89f, roughness: 0.86, cast: false },
  curb: { color: 0xd9d3c7, roughness: 0.72, cast: false },
  facade: { color: 0xe6dac6, roughness: 0.9, cast: true },
  facadeAlt: { color: 0xdac7a8, roughness: 0.9, cast: true },
  shopfront: { color: 0x6a5c50, roughness: 0.6, cast: true },
  cornice: { color: 0xf1ebdf, roughness: 0.85, cast: true },
  ochre: { color: 0xc79a5e, roughness: 0.88, cast: true },
  white: { color: 0xf0ece3, roughness: 0.85, cast: true },
  stone: { color: 0xb9ae9b, roughness: 0.8, cast: true },
  bronze: { color: 0x4a3a28, roughness: 0.45, cast: true, metalness: 0.6 },
  trunk: { color: 0x5e4c3b, roughness: 0.95, cast: true },
  canopy: { color: 0x4f6d3b, roughness: 0.95, cast: true },
  kiosk: { color: 0x2d5a4d, roughness: 0.55, cast: true },
  wood: { color: 0x76573a, roughness: 0.8, cast: true },
  bin: { color: 0x2f8f3e, roughness: 0.5, cast: true },
  iron: { color: 0x26272a, roughness: 0.55, cast: true, metalness: 0.5 },
  barrier: { color: 0xc23a2c, roughness: 0.6, cast: true },
  table: { color: 0xe9e3d8, roughness: 0.6, cast: true },
  water: { color: 0x3a6e88, roughness: 0.08, cast: false },
} as const;

const CHUNK = 60;

function buildGraybox(physics: Physics) {
  const root = new THREE.Group();
  root.name = 'graybox';
  const mats = new Map<MatKey, THREE.MeshStandardMaterial>();
  const parts = new Map<string, THREE.BufferGeometry[]>();
  const geos: THREE.BufferGeometry[] = [];
  const mat = (k: MatKey) => {
    let m = mats.get(k);
    if (!m) {
      const d = MAT_DEFS[k];
      m = new THREE.MeshStandardMaterial({ color: d.color, roughness: d.roughness, metalness: 'metalness' in d ? d.metalness : 0 });
      mats.set(k, m);
    }
    return m;
  };
  const push = (k: MatKey, g: THREE.BufferGeometry, x: number) => {
    const key = `${k}|${Math.floor(x / CHUNK)}`;
    let list = parts.get(key);
    if (!list) parts.set(key, (list = []));
    list.push(g);
  };

  /** Axis-aligned box from min/max corners. group null = visual only. */
  function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, k: MatKey, group: number | null = G.STATIC): void {
    const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
    g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    push(k, g, (x0 + x1) / 2);
    if (group !== null) physics.addBox(new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), new THREE.Vector3((x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2), 0, group);
  }
  function cyl(x: number, z: number, y0: number, h: number, r: number, k: MatKey, group: number | null = G.STATIC, r2 = r, seg = 14): void {
    const g = new THREE.CylinderGeometry(r2, r, h, seg);
    g.translate(x, y0 + h / 2, z);
    push(k, g, x);
    if (group !== null) physics.addCylinder(new THREE.Vector3(x, y0 + h / 2, z), Math.max(r, r2), h / 2, group);
  }
  /** Barrier: a 1.1 m tall visual fence with a 2.4 m collider (can't be jumped). */
  function barrier(x0: number, x1: number, z0: number, z1: number): void {
    box(x0, x1, C, C + 1.1, z0, z1, 'barrier', null);
    physics.addBox(new THREE.Vector3((x0 + x1) / 2, C + 1.2, (z0 + z1) / 2), new THREE.Vector3((x1 - x0) / 2, 1.2, (z1 - z0) / 2), 0, G.STATIC);
  }

  // deterministic pseudo random
  let seed = 1337;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

  // ---- ground & walkable surfaces ----
  box(-470, 460, -1, 0, -110, 110, 'asphalt');
  box(L.ROAD_X.min, L.ROAD_X.max, 0, C, -13.7, 13.7, 'paving'); // promenade
  for (const s of [-1, 1]) {
    box(L.ROAD_X.min, L.ROAD_X.max, 0, C, s < 0 ? -14 : 13.7, s < 0 ? -13.7 : 14, 'curb'); // promenade curbs
    // sidewalks between the cross streets, with curb strips on the road side
    box(-228, 246, 0, C, s < 0 ? -30 : 22.3, s < 0 ? -22.3 : 30, 'paving');
    box(-228, 246, 0, C, s < 0 ? -22.3 : 22, s < 0 ? -22 : 22.3, 'curb');
    // cross-street arms: road at 0, 2 m sidewalks at curb height, closed by a building
    for (const cs of L.CROSS_STREETS) {
      const zIn = 30 * s, zOut = (30 + cs.depth) * s;
      const [za, zb] = s < 0 ? [zOut, zIn] : [zIn, zOut];
      box(cs.x - cs.width / 2 - 2, cs.x - cs.width / 2, 0, C, za, zb, 'paving');
      box(cs.x + cs.width / 2, cs.x + cs.width / 2 + 2, 0, C, za, zb, 'paving');
      const zEnd0 = zOut, zEnd1 = zOut + 14 * s;
      box(cs.x - 14, cs.x + 14, 0, 16, Math.min(zEnd0, zEnd1), Math.max(zEnd0, zEnd1), 'facadeAlt');
    }
  }
  box(L.PLAZA_WEST.xMin, L.PLAZA_WEST.xMax, 0, C, -30, 30, 'plaza');
  box(L.PLAZA_EAST.xMin, L.PLAZA_EAST.xMax, 0, C, -30, 30, 'plaza');
  // plaza curbs facing the road ends
  for (const z0 of [-22, 14]) {
    box(L.PLAZA_WEST.xMax - 0.3, L.PLAZA_WEST.xMax, 0, C + 0.001, z0, z0 + 8, 'curb', null);
    box(L.PLAZA_EAST.xMin, L.PLAZA_EAST.xMin + 0.3, 0, C + 0.001, z0, z0 + 8, 'curb', null);
  }

  // ---- facade rows (holes for landmarks, cross streets, alleys) ----
  const holes = (side: -1 | 1): [number, number][] => {
    const h: [number, number][] = [];
    for (const cs of L.CROSS_STREETS) h.push([cs.x - cs.width / 2 - 2, cs.x + cs.width / 2 + 2]);
    for (const a of L.ALLEYS) if (a.side === side) h.push([a.x - a.width / 2, a.x + a.width / 2]);
    if (side < 0) h.push([L.LANDMARKS.cathedral.xMin, L.LANDMARKS.cathedral.xMax], [L.LANDMARKS.theatre.xMin, L.LANDMARKS.theatre.xMax]);
    else h.push([L.LANDMARKS.embassy.xMin, L.LANDMARKS.embassy.xMax], [L.LANDMARKS.colisee.xMin, L.LANDMARKS.colisee.xMax]);
    return h.sort((a, b) => a[0] - b[0]);
  };
  const DEPTH = 26;
  function building(x0: number, x1: number, side: -1 | 1): void {
    const h = 15 + Math.floor(rnd() * 4) * 3 + rnd() * 1.5;
    const f = side * 30, b = side * (30 + DEPTH);
    const [z0, z1] = side < 0 ? [b, f] : [f, b];
    const k: MatKey = rnd() < 0.5 ? 'facade' : 'facadeAlt';
    box(x0, x1, 0, 4.6, z0, z1, 'shopfront');
    box(x0, x1, 4.6, h, z0, z1, k, null);
    physics.addBox(new THREE.Vector3((x0 + x1) / 2, (4.6 + h) / 2, (z0 + z1) / 2), new THREE.Vector3((x1 - x0) / 2, (h - 4.6) / 2, (z1 - z0) / 2));
    // cornice + two balcony bands: cheap relief that shows off the long golden-hour shadows
    const out = (d: number) => (side < 0 ? [f, f + d] : [f - d, f]) as [number, number];
    box(x0 - 0.2, x1 + 0.2, h - 0.7, h, ...out(0.45), 'cornice', null);
    box(x0 + 0.6, x1 - 0.6, 4.6, 5.0, ...out(0.35), 'cornice', null);
    for (const y of [8.2, 11.6]) if (y < h - 2) box(x0 + 1.2, x1 - 1.2, y, y + 0.18, ...out(0.9), 'iron', null);
  }
  for (const side of [-1, 1] as const) {
    let x = L.X_MIN;
    const hs = holes(side);
    const segs: [number, number][] = [];
    for (const [a, b] of hs) { if (a > x) segs.push([x, a]); x = Math.max(x, b); }
    if (x < L.EAST_BACKDROP.xMax) segs.push([x, L.EAST_BACKDROP.xMax]);
    for (const [a, b] of segs) {
      let s = a;
      while (b - s > 0.5) {
        const w = b - s < 30 ? b - s : 12 + rnd() * 12;
        building(s, s + w, side);
        s += w;
      }
    }
    // alleys: paved floor, barrier + back wall at the dead end
    for (const al of L.ALLEYS) if (al.side === side) {
      const zIn = 30 * side, zEnd = (30 + al.depth) * side;
      box(al.x - al.width / 2, al.x + al.width / 2, 0, C, Math.min(zIn, zEnd), Math.max(zIn, zEnd), 'paving');
      barrier(al.x - al.width / 2, al.x + al.width / 2, Math.min(zEnd, zEnd - 0.2 * side), Math.max(zEnd, zEnd - 0.2 * side));
      const zb = (30 + DEPTH) * side;
      box(al.x - al.width / 2, al.x + al.width / 2, 0, 14, Math.min(zEnd, zb), Math.max(zEnd, zb), 'facadeAlt');
    }
  }
  // west: buildings close the plaza corners, Avenue de France (visual) beyond the barrier
  for (const s of [-1, 1]) {
    box(L.AVENUE_DE_FRANCE.xMin, L.X_MIN, 0, 18, s < 0 ? -30 : 12, s < 0 ? -12 : 30, 'facade');
    box(L.AVENUE_DE_FRANCE.xMin, L.X_MIN, 0, C, s < 0 ? -12 : 9, s < 0 ? -9 : 12, 'paving', null);
  }
  barrier(L.X_MIN - 0.3, L.X_MIN, -12, 12);
  // Porte de France: two piers and an arch block
  const pf = L.LANDMARKS.porteDeFrance;
  box(pf.x - 3, pf.x + 3, 0, 9, pf.z - 7, pf.z - 3, 'stone', null);
  box(pf.x - 3, pf.x + 3, 0, 9, pf.z + 3, pf.z + 7, 'stone', null);
  box(pf.x - 3, pf.x + 3, 6.5, 11, pf.z - 3, pf.z + 3, 'stone', null);
  // east: barrier across the plaza end, avenue continues visually to the lake
  barrier(L.X_MAX, L.X_MAX + 0.3, -30, 30);
  box(L.LAKE_X, 460, 0, 0.02, -110, 110, 'water', null);

  // ---- landmarks (footprint massing) ----
  const cat = L.LANDMARKS.cathedral;
  box(cat.xMin + 4, cat.xMax - 4, 0, 24, cat.zMin + 4, cat.zMax - 4, 'ochre');
  box(cat.xMin + 4, cat.xMin + 11, 0, 40, cat.zMax - 11, cat.zMax - 4, 'ochre');
  box(cat.xMax - 11, cat.xMax - 4, 0, 40, cat.zMax - 11, cat.zMax - 4, 'ochre');
  const dome = new THREE.SphereGeometry(8, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2);
  dome.translate((cat.xMin + cat.xMax) / 2, 24, (cat.zMin + cat.zMax) / 2 + 4);
  push('ochre', dome, cat.xMin);
  const emb = L.LANDMARKS.embassy;
  box(emb.xMin, emb.xMax, 0, 2.2, 30, 30.25, 'iron');
  box(emb.xMin + 4, emb.xMax - 4, 0, 14, 38, emb.zMax - 2, 'white');
  const th = L.LANDMARKS.theatre;
  box(th.xMin + 2, th.xMax - 2, 0, 20, th.zMin, th.zMax - 3, 'white');
  box(th.xMin + 8, th.xMax - 8, 0, 12, th.zMax - 3, th.zMax, 'white');
  const col = L.LANDMARKS.colisee;
  box(col.xMin, col.xMax, 0, 26, col.zMin + 2, col.zMax, 'facade');
  box(col.xMin + 12, col.xMax - 12, 0, 8, col.zMin, col.zMin + 2, 'shopfront');
  const ik = L.LANDMARKS.ibnKhaldoun;
  cyl(ik.x, ik.z, C, 3.2, 1.7, 'stone');
  cyl(ik.x, ik.z, C + 3.2, 2.3, 0.45, 'bronze', null, 0.3);
  const bs = L.LANDMARKS.bourguibaStatue;
  box(bs.x - 3, bs.x + 3, C, C + 3, bs.z - 1.8, bs.z + 1.8, 'stone');
  box(bs.x - 1.7, bs.x + 1.7, C + 4.2, C + 5.6, bs.z - 0.45, bs.z + 0.45, 'bronze', null);
  cyl(bs.x - 1.2, bs.z, C + 3, 1.6, 0.14, 'bronze', null);
  cyl(bs.x + 1.2, bs.z, C + 3, 1.6, 0.14, 'bronze', null);
  cyl(bs.x - 0.3, bs.z, C + 5.6, 1.3, 0.28, 'bronze', null, 0.2);
  const ct = L.LANDMARKS.clockTower;
  box(ct.x - 4, ct.x + 4, C, C + 1.6, ct.z - 4, ct.z + 4, 'stone');
  box(ct.x - 2.4, ct.x + 2.4, C, 34, ct.z - 2.4, ct.z + 2.4, 'stone');
  const spire = new THREE.ConeGeometry(2.6, 5, 4);
  spire.rotateY(Math.PI / 4);
  spire.translate(ct.x, 36.5, ct.z);
  push('bronze', spire, ct.x);

  // ---- promenade furniture ----
  const avoid = (x: number, z: number, r: number) =>
    L.KIOSKS.some((k) => Math.abs(k.x - x) < 3 + r && Math.abs(k.z - z) < 2.5 + r) ||
    L.BINS.some((b) => Math.hypot(b.x - x, b.z - z) < 1.5 + r) ||
    Math.hypot(L.LANDMARKS.bourguibaStatue.x - x, L.LANDMARKS.bourguibaStatue.z - z) < 5 + r;
  const trees: THREE.Vector3[] = [];
  for (const z of L.TREE_ROWS_Z) {
    for (let x = L.TREE_X.min; x <= L.TREE_X.max; x += L.TREE_X.spacing) {
      trees.push(new THREE.Vector3(x, C, z));
      physics.addCylinder(new THREE.Vector3(x, C + 1.6, z), 0.3, 1.6);
    }
  }
  let n = 0;
  for (let x = L.TREE_X.min + L.TREE_X.spacing / 2; x < L.TREE_X.max; x += L.TREE_X.spacing, n++) {
    for (const s of [-1, 1]) {
      const z = s * 7.7;
      if (n % 2 === 0 && !avoid(x, z, 1)) {
        box(x - 0.9, x + 0.9, C + 0.38, C + 0.46, z - 0.25, z + 0.25, 'wood', null);
        const b0 = z + 0.2 * s, b1 = z + 0.27 * s; // backrest on the tree side
        box(x - 0.9, x + 0.9, C + 0.46, C + 0.9, Math.min(b0, b1), Math.max(b0, b1), 'wood', null);
        box(x - 0.8, x - 0.7, C, C + 0.38, z - 0.2, z + 0.2, 'iron', null);
        box(x + 0.7, x + 0.8, C, C + 0.38, z - 0.2, z + 0.2, 'iron', null);
        physics.addBox(new THREE.Vector3(x, C + 0.3, z), new THREE.Vector3(0.9, 0.3, 0.28), 0, G.LOW_PROP);
      }
      if (n % 4 === 1 && !avoid(x, s * 11.6, 0.3)) {
        cyl(x, s * 11.6, C, 5.2, 0.09, 'iron', G.STATIC, 0.06, 8);
        box(x - 0.25, x + 0.25, C + 5.2, C + 5.6, s * 11.6 - 0.25, s * 11.6 + 0.25, 'iron', null);
      }
    }
  }
  for (const k of L.KIOSKS) {
    box(k.x - 1.5, k.x + 1.5, C, C + 2.3, k.z - 1.2, k.z + 1.2, 'kiosk');
    box(k.x - 1.75, k.x + 1.75, C + 2.3, C + 2.42, k.z - 1.45, k.z + 1.45, 'iron', null);
    box(k.x + 1.6, k.x + 2.6, C, C + 1.0, k.z - 0.5, k.z + 0.5, 'wood'); // crate to hop onto the roof
  }
  for (const b of L.BINS) cyl(b.x, b.z, C, 1.05, 0.42, 'bin');
  for (const t of L.CAFE_TERRACES) {
    for (let x = t.xMin + 1.5; x < t.xMax; x += 2.8) {
      for (const zz of [27.6, 25]) {
        const z = zz * t.side;
        cyl(x, z, C, 0.74, 0.36, 'table', G.LOW_PROP, 0.36, 12);
      }
    }
  }
  // sidewalk lamps
  for (let x = -220; x < 245; x += 30) for (const s of [-1, 1]) cyl(x, s * 22.9, C, 5.6, 0.09, 'iron', G.STATIC, 0.06, 8);

  // ---- merge ----
  for (const [key, list] of parts) {
    const k = key.split('|')[0] as MatKey;
    const g = mergeGeometries(list, false);
    list.forEach((x) => x.dispose());
    geos.push(g);
    const mesh = new THREE.Mesh(g, mat(k));
    mesh.castShadow = MAT_DEFS[k].cast;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    root.add(mesh);
  }
  // trees: instanced trunks + clipped-ficus canopies
  const trunkG = new THREE.CylinderGeometry(0.2, 0.28, 3.4, 10).translate(0, 1.7, 0);
  const canG = new THREE.IcosahedronGeometry(1, 3).scale(3.1, 2.3, 3.1).translate(0, 5.3, 0);
  geos.push(trunkG, canG);
  const trunks = new THREE.InstancedMesh(trunkG, mat('trunk'), trees.length);
  const canopies = new THREE.InstancedMesh(canG, mat('canopy'), trees.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
  trees.forEach((p, i) => {
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * Math.PI);
    sc.setScalar(0.9 + rnd() * 0.2);
    trunks.setMatrixAt(i, m4.compose(p, q, sc));
    canopies.setMatrixAt(i, m4.compose(p, q, sc));
  });
  for (const im of [trunks, canopies]) {
    im.castShadow = true;
    im.receiveShadow = true;
    im.computeBoundingSphere();
    root.add(im);
  }
  root.updateMatrixWorld(true);

  return {
    root,
    dispose() {
      geos.forEach((g) => g.dispose());
      mats.forEach((m) => m.dispose());
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Dev-only placeholder avatar: a sandy capsule with a nose and ears, squash & stretch + lean.
function createDevAvatar(): LabibAvatar & { geos: THREE.BufferGeometry[]; mats: THREE.Material[] } {
  const root = new THREE.Group();
  const fur = new THREE.MeshStandardMaterial({ color: 0xd9b37c, roughness: 0.75 });
  const cream = new THREE.MeshStandardMaterial({ color: 0xf2e3c8, roughness: 0.8 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1b1714, roughness: 0.4 });
  const body = new THREE.Group();
  root.add(body);
  const add = (g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(g, m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    body.add(mesh);
    return mesh;
  };
  const capsule = new THREE.CapsuleGeometry(0.35, 0.6, 8, 20);
  const muzzle = new THREE.SphereGeometry(0.17, 16, 12);
  const nose = new THREE.SphereGeometry(0.065, 12, 8);
  const eye = new THREE.SphereGeometry(0.045, 10, 8);
  const ear = new THREE.ConeGeometry(0.14, 0.46, 12);
  add(capsule, fur, 0, 0.65, 0);
  add(muzzle, cream, 0, 0.98, 0.25).scale.set(1, 0.8, 1.1);
  add(nose, dark, 0, 1.01, 0.43);
  add(eye, dark, -0.13, 1.12, 0.3);
  add(eye, dark, 0.13, 1.12, 0.3);
  add(ear, fur, -0.2, 1.42, 0).rotation.z = 0.4;
  add(ear, fur, 0.2, 1.42, 0).rotation.z = -0.4;
  let squash = 0, squashV = 0;
  return {
    root, height: 1.3,
    geos: [capsule, muzzle, nose, eye, ear], mats: [fur, cream, dark],
    update(dt: number, m: AvatarMotion) {
      // damped spring for squash & stretch
      squashV += (-squash * 160 - squashV * 14) * dt;
      squash += squashV * dt;
      const air = m.grounded ? 0 : THREE.MathUtils.clamp(m.verticalVelocity * 0.015, -0.08, 0.1);
      const sy = 1 + squash + air;
      body.scale.set(1 / Math.sqrt(sy), sy, 1 / Math.sqrt(sy));
      body.rotation.z = THREE.MathUtils.clamp(-m.turnRate * 0.035, -0.25, 0.25) * Math.min(1, m.speed / 6);
      body.rotation.x = Math.min(0.18, m.speed * 0.02);
      body.position.y = m.grounded && m.speed > 0.5 ? Math.abs(Math.sin(performance.now() * 0.001 * m.speed * 2.2)) * 0.05 : 0;
    },
    trigger(a: AvatarAction) {
      if (a === 'land') squash = -0.22;
      else if (a === 'jump') squash = 0.18;
      else if (a === 'hit') squash = -0.3;
      else if (a === 'kick') squashV += 2;
    },
    setChechia() {}, setRadarGlow() {}, setSprintTrail() {},
    dispose() {},
  };
}

// ---------------------------------------------------------------------------------------------
/** GPU frame time via EXT_disjoint_timer_query_webgl2 (immune to CPU contention on this box). */
function createGpuTimer(gl: WebGL2RenderingContext) {
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  const pool: WebGLQuery[] = [], pending: WebGLQuery[] = [];
  let ms = 0, samples = 0;
  return {
    get ms() { return ms; },
    get available() { return !!ext; },
    reset() { samples = 0; },
    begin() { if (!ext) return; const q = pool.pop() ?? gl.createQuery()!; gl.beginQuery(ext.TIME_ELAPSED_EXT, q); pending.push(q); },
    end() { if (ext) gl.endQuery(ext.TIME_ELAPSED_EXT); },
    poll() {
      if (!ext) return;
      while (pending.length && gl.getQueryParameter(pending[0], gl.QUERY_RESULT_AVAILABLE)) {
        const q = pending.shift()!;
        const v = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
        pool.push(q);
        if (gl.getParameter(ext.GPU_DISJOINT_EXT)) continue;
        samples++;
        ms += (v - ms) * Math.max(0.05, 1 / samples); // running mean, then EMA
      }
    },
  };
}

async function main(): Promise<void> {
  const engine = createEngine(document.getElementById('app')!);
  const q0 = (params.get('q') as Quality | null) ?? 'high';
  engine.setQuality(q0);
  const assets = new Assets(engine.renderer);
  await engine.initLighting(assets);

  const physics = await Physics.create();
  const gray = buildGraybox(physics);
  engine.scene.add(gray.root);
  physics.step(); // build the broad phase before the first character query

  const settings = { ...DEFAULT_SETTINGS };
  const events = new Emitter<GameEvents>();
  const input = createInput(engine.renderer.domElement, settings);
  const avatar = createDevAvatar();
  engine.scene.add(avatar.root);
  const player = createPlayerController(physics, avatar, events);
  const rig = createCameraRig(engine.camera, physics, settings);

  const spawn = params.get('spawn')?.split(',').map(Number);
  const respawn = () => {
    const yaw = spawn ? THREE.MathUtils.degToRad(spawn[2] ?? 90) : L.PLAYER_SPAWN_YAW;
    player.reset(spawn ? new THREE.Vector3(spawn[0], C + 0.02, spawn[1]) : L.PLAYER_SPAWN, yaw);
    rig.reset(yaw);
  };
  respawn();

  const fixedCam = vec3(params.get('cam'));
  const fixedTarget = vec3(params.get('target')) ?? new THREE.Vector3(0, 1.5, 0);
  if (params.has('fov')) { engine.camera.fov = Number(params.get('fov')); engine.camera.updateProjectionMatrix(); }
  let menu = params.get('menu') === '1';
  rig.setMenuMode(menu);

  events.on('land', (e) => rig.shake(Math.min(0.45, e.impact / 30), 0.3));
  let tea = false;
  let paused = false;
  const pauseEl = document.getElementById('dev-pause')!;
  const setPaused = (p: boolean) => {
    paused = p;
    input.setEnabled(!p && !menu);
    pauseEl.classList.toggle('on', p);
    if (!p) input.requestPointerLock();
  };
  pauseEl.addEventListener('click', () => setPaused(false));
  input.setEnabled(!menu);

  addEventListener('keydown', (e) => {
    const qs: Record<string, Quality> = { Digit1: 'low', Digit2: 'medium', Digit3: 'high', Digit4: 'ultra' };
    if (qs[e.code]) engine.setQuality(qs[e.code]);
    else if (e.code === 'KeyM') { menu = !menu; rig.setMenuMode(menu); input.setEnabled(!menu && !paused); }
    else if (e.code === 'KeyT') { tea = !tea; player.setSpeedMultiplier(tea ? TEA_SPEED : 1); }
    else if (e.code === 'KeyK') { player.knockback(new THREE.Vector3(-Math.sin(player.yaw), 0, -Math.cos(player.yaw)), 9, 1); rig.shake(0.7); }
    else if (e.code === 'KeyG') rig.shake(0.8, 0.6);
    else if (e.code === 'KeyR') respawn();
  });

  const debug = { raw: false }; // raw = skip the post chain (perf comparisons)
  const gpu = createGpuTimer(engine.renderer.getContext() as WebGL2RenderingContext);
  const hud = document.getElementById('dev-hud')!;
  const stats = { fps: 0, calls: 0, triangles: 0 };
  (window as unknown as { __stats: typeof stats }).__stats = stats;
  let hudT = 0, acc = 0, last = performance.now();
  engine.renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const f = input.poll();
    if (f.pausePressed && !paused) setPaused(true);
    if (!paused) {
      player.update(dt, f, rig.yaw);
      acc += dt;
      for (let i = 0; acc >= FIXED_DT && i < 5; i++) { physics.step(); acc -= FIXED_DT; }
      acc = Math.min(acc, FIXED_DT);
    }
    if (fixedCam) { engine.camera.position.copy(fixedCam); engine.camera.lookAt(fixedTarget); }
    else rig.update(paused ? 0 : dt, f, player);
    engine.setFocus(player.position);
    gpu.poll();
    gpu.begin();
    if (debug.raw) { engine.renderer.info.reset(); engine.renderer.render(engine.scene, engine.camera); }
    else engine.render(dt);
    gpu.end();

    hudT += dt;
    if (hudT > 0.25) {
      hudT = 0;
      const info = engine.renderer.info.render;
      stats.fps = Math.round(engine.fps); stats.calls = info.calls; stats.triangles = info.triangles;
      const p = player.position, v = player.velocity;
      hud.textContent =
        `core dev · ${engine.quality}  res ×${engine.resolutionScale.toFixed(2)}  pr ${engine.pixelRatio.toFixed(2)}\n` +
        `fps ${engine.fps.toFixed(0)}  gpu ${gpu.ms.toFixed(1)} ms  calls ${info.calls}  tris ${(info.triangles / 1000).toFixed(0)}k\n` +
        `pos ${p.x.toFixed(1)} ${p.y.toFixed(2)} ${p.z.toFixed(1)}  v ${Math.hypot(v.x, v.z).toFixed(2)} m/s ${player.grounded ? 'ground' : 'air'}${player.stunned ? ' STUN' : ''}${tea ? ' TEA' : ''}\n` +
        `WASD/Shift/Space/F · 1-4 quality · M menu · T tea · K hit · G shake · R respawn`;
    }
  });

  /** Distance from the camera to the nearest static surface (negative = inside). */
  const cameraClearance = () => {
    const c = engine.camera.position;
    const hit = physics.world.projectPoint(c, true, undefined, groups(ALL, G.STATIC));
    if (!hit) return 99;
    const d = Math.hypot(hit.point.x - c.x, hit.point.y - c.y, hit.point.z - c.z);
    return hit.isInside ? -d : d;
  };

  // hooks for scripts/core-*.mjs
  Object.assign(window, {
    __core: {
      engine, player, rig, input, physics, events, THREE, debug, gpu, cameraClearance,
      setQuality: (q: Quality) => engine.setQuality(q),
      teleport: (x: number, z: number, yawDeg: number, y = C + 0.02) => { const yaw = THREE.MathUtils.degToRad(yawDeg); player.reset(new THREE.Vector3(x, y, z), yaw); rig.reset(yaw); },
      /** Deterministic fixed-dt run of controller + physics + camera rig with a constant input
       *  (no rAF, no real devices). lookDX is added every frame (tiny = "the player is steering the
       *  camera", which suppresses auto-recentre); jumpFrames = jump pressed on frame 0 and held
       *  that long. Returns one sample per frame. */
      sim: (frames: number, moveX: number, moveY: number, opt: { sprint?: boolean; lookDX?: number; jumpFrames?: number } = {}) => {
        const f: InputFrame = { move: { x: moveX, y: moveY }, lookDX: opt.lookDX ?? 0, lookDY: 0, sprint: !!opt.sprint, jumpPressed: false, jumpHeld: false, kickPressed: false, radarPressed: false, pausePressed: false };
        const out: { t: number; x: number; y: number; z: number; vx: number; vz: number; g: boolean; yaw: number; arm: number; clear: number; avatar: boolean }[] = [];
        for (let i = 0; i < frames; i++) {
          f.jumpPressed = i === 0 && (opt.jumpFrames ?? 0) > 0;
          f.jumpHeld = i < (opt.jumpFrames ?? 0);
          player.update(FIXED_DT, f, rig.yaw);
          physics.step();
          rig.update(FIXED_DT, f, player);
          const c = engine.camera.position, p = player.position, v = player.velocity;
          out.push({ t: i * FIXED_DT, x: p.x, y: p.y, z: p.z, vx: v.x, vz: v.z, g: player.grounded, yaw: rig.yaw, arm: Math.hypot(c.x - p.x, c.y - p.y - 1.3, c.z - p.z), clear: cameraClearance(), avatar: avatar.root.visible });
        }
        return out;
      },
    },
  });
  (window as unknown as { __ready: boolean }).__ready = true;
}

main();
