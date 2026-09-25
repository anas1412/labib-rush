// Birds of the avenue. Two draw calls:
//  • Pigeons: one InstancedMesh (≈1.1k-triangle flock budget). Wings flap and fold and heads peck
//    in the vertex shader (per-instance aAnim = open, phase, peck); the CPU only integrates
//    positions. Flocks peck on the central walk and the plazas, shuffle away from walkers, scatter
//    up and away when Labib runs within ~4 m, fly off along the open central walk and land at
//    another spot later.
//  • Starlings: an occasional murmuration over the ficus canopy — Points whose positions are
//    computed entirely in the vertex shader (a folding, breathing, twisting sheet), fading in,
//    swirling for ~40 s and drifting off.
import {
  BufferAttribute, BufferGeometry, CanvasTexture, Color, DynamicDrawUsage, Euler, Frustum, Group, IcosahedronGeometry,
  InstancedBufferAttribute, InstancedMesh, Matrix4, MeshStandardMaterial, Points, PointsMaterial, Quaternion, Sphere,
  Vector3, type Camera, type Object3D,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CURB, LANDMARKS, PLAZA_EAST, PLAZA_WEST, ROAD_X } from '../core/layout';
import type { Quality, SharedUniforms } from '../core/types';
import type { NavGrid } from './crowd/navgrid';

const COUNTS: Record<Quality, { groups: number; per: number; starlings: number }> = {
  low: { groups: 3, per: 7, starlings: 500 },
  medium: { groups: 4, per: 8, starlings: 900 },
  high: { groups: 5, per: 9, starlings: 1400 },
  ultra: { groups: 6, per: 10, starlings: 2000 },
};
const SCARE_RUN = 4; // m: Labib running closer than this scatters the flock
const SCARE_ANY = 1.4; // m: walking right into them does too
const RUN_SPEED = 3; // m/s counted as running

export interface Threat { x: number; y: number; z: number; speed: number }

export interface Birds {
  root: Object3D;
  /** avoid: xz pairs of walkers (pigeons shuffle away), n of them. */
  update(dt: number, camera: Camera, threat: Threat | null, avoid: Float32Array, nAvoid: number): void;
  reset(): void;
  /** Dev: start a murmuration now. */
  murmurate(): void;
  readonly stats: { pigeons: number; flying: number; murmuration: number };
  dispose(): void;
}

// ---------------------------------------------------------------------------------------------
function pigeonGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const add = (g: BufferGeometry, color: number, part: number) => {
    const n = g.getAttribute('position').count;
    const c = new Color(color), col = new Float32Array(n * 3), prt = new Float32Array(n);
    for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; prt[i] = part; }
    g.setAttribute('color', new BufferAttribute(col, 3));
    g.setAttribute('aPart', new BufferAttribute(prt, 1));
    g.deleteAttribute('uv');
    parts.push(g.index ? g.toNonIndexed() : g);
  };
  // body (blue-grey), iridescent neck, head, beak, tail with dark band, wings with two dark bars
  add(new IcosahedronGeometry(1, 1).scale(0.075, 0.07, 0.14).rotateX(0.18).translate(0, 0.13, 0), 0x7d8594, 0);
  add(new IcosahedronGeometry(1, 1).scale(0.052, 0.06, 0.05).translate(0, 0.175, 0.095), 0x4f6b62, 0); // neck sheen
  add(new IcosahedronGeometry(1, 1).scale(0.036, 0.036, 0.042).translate(0, 0.215, 0.13), 0x6e7686, 1);
  add(new IcosahedronGeometry(1, 0).scale(0.01, 0.009, 0.024).translate(0, 0.207, 0.172), 0x2a2522, 1);
  add(new IcosahedronGeometry(1, 0).scale(0.055, 0.012, 0.1).rotateX(-0.25).translate(0, 0.14, -0.17), 0x3d4350, 0);
  for (const s of [-1, 1]) {
    // flat wing: shoulder at |x| 0.05 → tip at |x| 0.34, chord 0.14 → 0.05 (both faces)
    const P = [0.05, 0.155, 0.07, 0.05, 0.155, -0.07, 0.2, 0.155, -0.06, 0.2, 0.155, 0.04, 0.34, 0.15, -0.05, 0.34, 0.15, -0.01];
    const tri = [0, 1, 2, 0, 2, 3, 3, 2, 4, 3, 4, 5];
    const pos: number[] = [];
    for (const face of [0, 1]) for (let k = 0; k < tri.length; k += 3) {
      const o = face ? [tri[k], tri[k + 2], tri[k + 1]] : [tri[k], tri[k + 1], tri[k + 2]];
      for (const v of o) pos.push(P[v * 3] * s, P[v * 3 + 1], P[v * 3 + 2]);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    g.computeVertexNormals();
    const n = g.getAttribute('position').count, col = new Float32Array(n * 3), prt = new Float32Array(n).fill(2);
    const base = new Color(0x8a93a3), bar = new Color(0x33373f);
    for (let i = 0; i < n; i++) {
      const x = Math.abs(pos[i * 3]);
      const c = (x > 0.12 && x < 0.16) || x > 0.3 ? bar : base;
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new BufferAttribute(col, 3));
    g.setAttribute('aPart', new BufferAttribute(prt, 1));
    parts.push(g);
  }
  for (const s of [-1, 1]) add(new IcosahedronGeometry(1, 0).scale(0.008, 0.05, 0.008).translate(s * 0.025, 0.035, 0.01), 0xb5524a, 0);
  const g = mergeGeometries(parts)!;
  parts.forEach((p) => p.dispose());
  g.computeBoundingSphere();
  return g;
}

function pigeonMaterial(uniforms: SharedUniforms): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0 });
  m.onBeforeCompile = (s) => {
    s.uniforms.uTime = uniforms.uTime;
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nattribute float aPart;\nattribute vec3 aAnim;')
      .replace('#include <begin_vertex>', /* glsl */ `
        vec3 transformed = position;
        if (aPart > 1.5) {
          float side = sign(position.x);
          float span = abs(position.x) - 0.05;
          float beat = sin(uTime * 19.0 + aAnim.y);
          float ang = beat * 1.0 + 0.2;
          vec3 open = vec3(side * (0.05 + span * cos(ang)), position.y + span * sin(ang), position.z - 0.03 * beat * span);
          vec3 folded = vec3(side * (0.06 + span * 0.12), position.y - 0.012 + span * 0.05, position.z - span * 0.5);
          transformed = mix(folded, open, aAnim.x);
        } else if (aPart > 0.5) {
          vec3 pv = vec3(0.0, 0.16, 0.08);
          vec3 r = position - pv;
          float a = aAnim.z * 1.15;
          transformed = pv + vec3(r.x, r.y * cos(a) - r.z * sin(a), r.y * sin(a) + r.z * cos(a));
        }`);
  };
  m.customProgramCacheKey = () => 'npc-pigeon-v1';
  return m;
}

function dotTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.55, 'rgba(255,255,255,0.9)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 32, 32);
  return new CanvasTexture(c);
}

// ---------------------------------------------------------------------------------------------
export function createBirds(grid: NavGrid, quality: Quality, uniforms: SharedUniforms, rand: () => number = Math.random): Birds {
  const Q = COUNTS[quality];
  const root = new Group();
  root.name = 'birds';

  // --- flock spots: open paving on the central walk and the plazas -----------------------------
  const spots: { x: number; z: number }[] = [];
  const trySpot = (x: number, z: number) => { if (grid.free(x, z, 1.4)) spots.push({ x, z }); };
  for (let x = ROAD_X.min + 14; x < ROAD_X.max - 10; x += 26) trySpot(x, (spots.length % 2 ? 1 : -1) * 1.2);
  for (const [cx, x0, x1] of [[LANDMARKS.ibnKhaldoun.x, PLAZA_WEST.xMin + 8, PLAZA_WEST.xMax - 4], [LANDMARKS.clockTower.x, PLAZA_EAST.xMin + 4, PLAZA_EAST.xMax - 8]]) {
    for (const z of [-19, 19]) for (const x of [x0 + 6, cx, x1 - 6]) trySpot(x, z);
  }

  // --- pigeons --------------------------------------------------------------------------------
  const N = Q.groups * Q.per;
  const geo = pigeonGeometry();
  const anim = new InstancedBufferAttribute(new Float32Array(N * 3), 3);
  anim.setUsage(DynamicDrawUsage);
  geo.setAttribute('aAnim', anim);
  const mat = pigeonMaterial(uniforms);
  const mesh = new InstancedMesh(geo, mat, N);
  mesh.name = 'pigeons';
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.frustumCulled = false; // instances spread over the map; bounds change every frame
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  root.add(mesh);

  const px = new Float32Array(N), py = new Float32Array(N), pz = new Float32Array(N);
  const vx = new Float32Array(N), vy = new Float32Array(N), vz = new Float32Array(N);
  const yaw = new Float32Array(N), open = new Float32Array(N), peck = new Float32Array(N), size = new Float32Array(N);
  const state = new Uint8Array(N); // 0 ground, 1 airborne (take-off / cruise / landing), 2 hop
  const timer = new Float32Array(N), delay = new Float32Array(N);
  const tx = new Float32Array(N), tz = new Float32Array(N), phase = new Float32Array(N);
  const groupSpot = new Int16Array(Q.groups).fill(-1);
  const groupFlying = new Uint8Array(Q.groups);
  const fleeX = new Float32Array(Q.groups), fleeZ = new Float32Array(Q.groups); // where the scare came from
  for (let i = 0; i < N; i++) { size[i] = 0.88 + rand() * 0.24; phase[i] = rand() * 6.28; }

  const place = (i: number, spot: number) => {
    const s = spots[spot];
    for (let k = 0; k < 12; k++) {
      const a = rand() * Math.PI * 2, r = Math.sqrt(rand()) * 2.4;
      const x = s.x + Math.cos(a) * r, z = s.z + Math.sin(a) * r;
      if (grid.free(x, z, 0.2) || k === 11) { px[i] = x; pz[i] = z; break; }
    }
    py[i] = CURB; vx[i] = vy[i] = vz[i] = 0; state[i] = 0; open[i] = 0; yaw[i] = rand() * 6.28;
    tx[i] = px[i]; tz[i] = pz[i]; timer[i] = rand() * 3;
  };
  const spotTaken = (s: number) => { for (let g = 0; g < Q.groups; g++) if (groupSpot[g] === s) return true; return false; };
  /** Free spots sorted by distance to (x, z), skipping `not`; picks among the nearest few. */
  const pickSpot = (x: number, z: number, not: number, minD: number): number => {
    let best = -1, bd = 1e12;
    for (let s = 0; s < spots.length; s++) {
      if (s === not || spotTaken(s)) continue;
      const d = (spots[s].x - x) ** 2 + (spots[s].z - z) ** 2;
      if (d < minD * minD) continue;
      const score = d * (0.6 + rand() * 0.8);
      if (score < bd) { bd = score; best = s; }
    }
    return best;
  };
  const settleGroup = (g: number, spot: number) => {
    groupSpot[g] = spot;
    groupFlying[g] = 0;
    for (let i = g * Q.per; i < (g + 1) * Q.per; i++) place(i, spot);
  };

  // --- starlings --------------------------------------------------------------------------------
  const M = Q.starlings;
  const seeds = new Float32Array(M * 3);
  for (let i = 0; i < M; i++) {
    // denser core, ragged edges: a gaussian-ish sheet
    const r = Math.pow(rand(), 0.7), a = rand() * Math.PI * 2;
    seeds[i * 3] = Math.cos(a) * r;
    seeds[i * 3 + 1] = Math.sin(a) * r;
    seeds[i * 3 + 2] = rand() * 2 - 1;
  }
  const sGeo = new BufferGeometry();
  sGeo.setAttribute('position', new BufferAttribute(seeds, 3));
  sGeo.boundingSphere = new Sphere(new Vector3(), 1e5);
  const dot = dotTexture();
  const sMat = new PointsMaterial({ color: 0x15161b, size: 0.32, sizeAttenuation: true, map: dot, transparent: true, depthWrite: false, opacity: 0 });
  const sU = { uT: { value: 0 }, uCenter: { value: new Vector3() } };
  sMat.onBeforeCompile = (s) => {
    s.uniforms.uT = sU.uT;
    s.uniforms.uCenter = sU.uCenter;
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uT;\nuniform vec3 uCenter;')
      .replace('#include <begin_vertex>', /* glsl */ `
        vec3 sd = position;
        float t = uT;
        vec3 p = vec3(sd.x * 34.0, sd.z * 2.5, sd.y * 15.0);
        // travelling folds and a breathing, stretching sheet
        p.y += sin(p.x * 0.11 + t * 0.85) * 6.0 + sin(p.z * 0.23 - t * 0.63) * 3.0;
        p.z += sin(p.x * 0.07 - t * 0.55) * 7.0;
        p.x *= 0.7 + 0.3 * sin(t * 0.33 + sd.y * 1.7);
        p.z *= 0.75 + 0.35 * sin(t * 0.27 + sd.x * 2.1);
        // a wave of density rolling through: points bunch toward a wandering attractor
        vec3 att = vec3(sin(t * 0.41) * 20.0, cos(t * 0.37) * 5.0, cos(t * 0.29) * 10.0);
        float pull = 0.2 + 0.18 * sin(t * 0.7 + dot(sd, vec3(2.3, 1.7, 3.1)));
        p = mix(p, att, pull);
        float ang = t * 0.19 + sin(t * 0.13) * 1.4 + p.y * 0.025;
        float ca = cos(ang), sa = sin(ang);
        p.xz = vec2(ca * p.x - sa * p.z, sa * p.x + ca * p.z);
        vec3 transformed = uCenter + p;`)
      .replace('gl_PointSize = size;', 'gl_PointSize = size * (0.75 + 0.35 * sin(uT * 27.0 + position.z * 40.0));')
      .replace('#include <fog_vertex>', '#include <fog_vertex>\ngl_PointSize = max(gl_PointSize, 1.5);');
  };
  sMat.customProgramCacheKey = () => 'npc-starlings-v1';
  const starlings = new Points(sGeo, sMat);
  starlings.name = 'starlings';
  starlings.frustumCulled = false;
  starlings.visible = false;
  starlings.renderOrder = 3;
  root.add(starlings);
  // murmuration schedule
  let murT = 0, murNext = 18 + rand() * 12, murActive = false, murDur = 42;
  const murFrom = new Vector3(), murMid = new Vector3(), murTo = new Vector3();
  let murTime0 = 0;
  // Placed well ahead along the camera's horizontal forward, low over the avenue's sky gap, so the
  // gameplay camera (looking slightly down the street) actually frames it; it keeps station ahead
  // of the camera while it swirls, then streams off along the avenue.
  const murAhead = (camera: Camera, dist: number, out: Vector3) => {
    const e = camera.matrixWorld.elements; // camera looks down -Z
    let fx = -e[8], fz = -e[10];
    const l = Math.hypot(fx, fz) || 1; fx /= l; fz /= l;
    const x = Math.max(ROAD_X.min, Math.min(ROAD_X.max, camera.position.x + fx * dist));
    const z = Math.max(-18, Math.min(18, camera.position.z + fz * dist)); // over the roads/promenade, not the roofs
    return out.set(x, 15 + Math.sin(time * 0.1) * 1.5, z);
  };
  let murDir = 1;
  const startMurmuration = (camera: Camera) => {
    murActive = true; murT = 0; murDur = 38 + rand() * 12;
    murAhead(camera, 65 + rand() * 20, murMid);
    murDir = murMid.x >= camera.position.x ? 1 : -1;
    murFrom.set(murMid.x + murDir * 140, 40, murMid.z + 20 * (rand() - 0.5));
    murTo.set(murMid.x + murDir * 160, 45, murMid.z + 30 * (rand() - 0.5));
    murTime0 = rand() * 100;
    starlings.visible = true;
  };
  const murGoal = new Vector3();

  // --- per-frame scratch --------------------------------------------------------------------------
  const m4 = new Matrix4(), qt = new Quaternion(), eu = new Euler(0, 0, 0, 'YXZ'), pos = new Vector3(), scl = new Vector3();
  const frustum = new Frustum(), pv = new Matrix4(), sph = new Sphere();
  const stats = { pigeons: N, flying: 0, murmuration: 0 };
  let seeded = false;
  let time = 0;

  const takeOff = (i: number, fx: number, fz: number) => {
    const dx = px[i] - fx, dz = pz[i] - fz, d = Math.hypot(dx, dz) || 1;
    const sp = 3 + rand() * 2;
    vx[i] = (dx / d) * sp + (rand() - 0.5) * 1.5;
    vz[i] = (dz / d) * sp + (rand() - 0.5) * 1.5;
    vy[i] = 3.2 + rand() * 1.4;
    state[i] = 1; timer[i] = 0;
  };

  function update(dt: number, camera: Camera, threat: Threat | null, avoid: Float32Array, nAvoid: number): void {
    time += dt;
    const cam = camera.position;
    pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(pv);
    if (!seeded) { seeded = true; reseat(cam.x, cam.z); }

    // groups: settle far-away flocks near the camera (only when neither spot is on screen)
    for (let g = 0; g < Q.groups; g++) {
      if (groupFlying[g] || groupSpot[g] < 0) continue;
      const s = spots[groupSpot[g]];
      if ((s.x - cam.x) ** 2 + (s.z - cam.z) ** 2 < 110 * 110) continue;
      if (frustum.intersectsSphere(sph.set(pos.set(s.x, 0.5, s.z), 3))) continue;
      const ns = pickSpot(cam.x, cam.z, groupSpot[g], 18);
      if (ns >= 0 && !frustum.intersectsSphere(sph.set(pos.set(spots[ns].x, 0.5, spots[ns].z), 3))) settleGroup(g, ns);
    }

    let flying = 0;
    for (let g = 0; g < Q.groups; g++) {
      let airborne = 0;
      for (let i = g * Q.per; i < (g + 1) * Q.per; i++) {
        if (state[i] === 1) {
          airborne++;
          timer[i] += dt;
          // after the burst: head for the group's new spot, cruise ~7 m up, glide down to land
          if (timer[i] > 0.9) {
            const dx = tx[i] - px[i], dz = tz[i] - pz[i], d = Math.hypot(dx, dz);
            const cruise = d > 14 ? 7 : CURB + (d / 14) * 6.8;
            const sp = Math.min(7.5, 1.2 + d * 0.9);
            const k = 1 - Math.exp(-2.2 * dt);
            vx[i] += ((dx / (d || 1)) * sp - vx[i]) * k;
            vz[i] += ((dz / (d || 1)) * sp - vz[i]) * k;
            vy[i] += ((cruise - py[i]) * 1.4 - vy[i]) * k;
            if (d < 0.35 && py[i] < CURB + 0.08) { state[i] = 0; py[i] = CURB; vx[i] = vy[i] = vz[i] = 0; timer[i] = rand() * 2; }
          } else vy[i] -= 2.5 * dt;
          px[i] += vx[i] * dt; py[i] += vy[i] * dt; pz[i] += vz[i] * dt;
          if (py[i] < CURB) py[i] = CURB;
          const hs = Math.hypot(vx[i], vz[i]);
          if (hs > 0.3) yaw[i] = Math.atan2(vx[i], vz[i]);
          const target = timer[i] > 0.9 && py[i] < CURB + 0.6 && Math.hypot(tx[i] - px[i], tz[i] - pz[i]) < 1.5 ? 0.55 : 1;
          open[i] += (target - open[i]) * Math.min(1, dt * 8);
          peck[i] = 0;
          continue;
        }
        if (state[i] === 2) { // short hop away from a walker
          timer[i] += dt;
          px[i] += vx[i] * dt; pz[i] += vz[i] * dt;
          py[i] = CURB + Math.sin(Math.min(1, timer[i] / 0.35) * Math.PI) * 0.18;
          open[i] = Math.sin(Math.min(1, timer[i] / 0.35) * Math.PI) * 0.9;
          if (timer[i] >= 0.35) { state[i] = 0; py[i] = CURB; open[i] = 0; timer[i] = 0.5 + rand() * 2; }
          continue;
        }
        // on the ground
        if (delay[i] > 0) {
          delay[i] -= dt;
          if (delay[i] <= 0) takeOff(i, fleeX[g], fleeZ[g]);
          continue;
        }
        if (threat) {
          const d2 = (px[i] - threat.x) ** 2 + (pz[i] - threat.z) ** 2;
          if ((threat.speed > RUN_SPEED && d2 < SCARE_RUN * SCARE_RUN) || d2 < SCARE_ANY * SCARE_ANY) {
            // the whole flock goes, nearest first
            const ns = pickSpot(px[i], pz[i], groupSpot[g], 25);
            if (ns >= 0) {
              groupSpot[g] = ns;
              groupFlying[g] = 1;
              fleeX[g] = threat.x; fleeZ[g] = threat.z;
              const s = spots[ns];
              for (let j = g * Q.per; j < (g + 1) * Q.per; j++) {
                const a = rand() * Math.PI * 2, r = Math.sqrt(rand()) * 2.4;
                let lx = s.x + Math.cos(a) * r, lz = s.z + Math.sin(a) * r;
                if (!grid.free(lx, lz, 0.2)) { lx = s.x; lz = s.z; }
                tx[j] = lx; tz[j] = lz;
                if (state[j] !== 0) continue;
                const dj = Math.sqrt((px[j] - threat.x) ** 2 + (pz[j] - threat.z) ** 2);
                delay[j] = j === i ? 0 : 0.05 + dj * 0.06 + rand() * 0.12;
                if (j === i) takeOff(j, threat.x, threat.z);
              }
              continue;
            }
          }
        }
        // shuffle away from walkers' feet
        let hopped = false;
        for (let k = 0; k < nAvoid; k++) {
          const ax = avoid[k * 2], az = avoid[k * 2 + 1];
          const dx = px[i] - ax, dz = pz[i] - az, d2 = dx * dx + dz * dz;
          if (d2 < 0.75 * 0.75) {
            const d = Math.sqrt(d2) || 1;
            const nxp = px[i] + (dx / d) * 0.55, nzp = pz[i] + (dz / d) * 0.55;
            if (grid.free(nxp, nzp, 0.15)) {
              vx[i] = (dx / d) * 1.6; vz[i] = (dz / d) * 1.6;
              yaw[i] = Math.atan2(dx, dz);
              state[i] = 2; timer[i] = 0; hopped = true;
            }
            break;
          }
        }
        if (hopped) continue;
        // idle: potter about the spot, bobbing and pecking
        timer[i] -= dt;
        const dx = tx[i] - px[i], dz = tz[i] - pz[i], d = Math.hypot(dx, dz);
        if (timer[i] <= 0) {
          timer[i] = 1.5 + rand() * 4;
          const s = spots[groupSpot[g]];
          if (s) {
            const a = rand() * Math.PI * 2, r = Math.sqrt(rand()) * 2.4;
            const nx2 = s.x + Math.cos(a) * r, nz2 = s.z + Math.sin(a) * r;
            if (grid.free(nx2, nz2, 0.2)) { tx[i] = nx2; tz[i] = nz2; }
          }
        }
        if (d > 0.05) {
          const sp = Math.min(0.28, d);
          const nx2 = px[i] + (dx / d) * sp * dt, nz2 = pz[i] + (dz / d) * sp * dt;
          if (grid.free(nx2, nz2, 0.12)) { px[i] = nx2; pz[i] = nz2; }
          else { tx[i] = px[i]; tz[i] = pz[i]; }
          const ty = Math.atan2(dx, dz);
          let dy = ty - yaw[i];
          dy = Math.atan2(Math.sin(dy), Math.cos(dy));
          yaw[i] += dy * Math.min(1, dt * 6);
          peck[i] = 0.25 * Math.max(0, Math.sin(time * 9 + phase[i])); // head bob while walking
        } else {
          const cyc = Math.sin(time * 1.3 + phase[i]);
          peck[i] = cyc > 0.2 ? 0.55 + 0.45 * Math.max(0, Math.sin(time * 13 + phase[i])) : 0;
        }
        open[i] = Math.max(0, open[i] - dt * 3);
        py[i] = CURB;
      }
      if (groupFlying[g] && airborne === 0) {
        let waiting = 0;
        for (let i = g * Q.per; i < (g + 1) * Q.per; i++) if (delay[i] > 0) waiting++;
        if (!waiting) groupFlying[g] = 0;
      }
      flying += airborne;
    }
    stats.flying = flying;

    // write instances
    for (let i = 0; i < N; i++) {
      const air = state[i] === 1;
      eu.set(air ? Math.max(-0.5, Math.min(0.5, -vy[i] * 0.08)) : 0, yaw[i], 0);
      qt.setFromEuler(eu);
      m4.compose(pos.set(px[i], py[i], pz[i]), qt, scl.setScalar(size[i]));
      mesh.setMatrixAt(i, m4);
      anim.setXYZ(i, open[i], phase[i], peck[i]);
    }
    mesh.instanceMatrix.needsUpdate = true;
    anim.needsUpdate = true;

    // starlings
    if (!murActive) {
      murNext -= dt;
      if (murNext <= 0) startMurmuration(camera);
    } else {
      murT += dt;
      const u = murT / murDur;
      const e = (x: number) => x * x * (3 - 2 * x);
      if (u < 0.25) sU.uCenter.value.lerpVectors(murFrom, murMid, e(u / 0.25));
      else if (u < 0.75) {
        // keep station ~70 m ahead of the camera (eases, so a turn of the camera doesn't whip it)
        murMid.lerp(murAhead(camera, 70, murGoal), Math.min(1, dt * 0.35));
        sU.uCenter.value.copy(murMid).add(pos.set(Math.sin(murT * 0.15) * 12, Math.sin(murT * 0.21) * 3, Math.cos(murT * 0.12) * 5));
      } else {
        if (murT - dt < murDur * 0.75) murTo.set(murMid.x + murDir * 160, 45, murMid.z + 30 * (rand() - 0.5));
        sU.uCenter.value.lerpVectors(murMid, murTo, e((u - 0.75) / 0.25));
      }
      sU.uT.value = murTime0 + murT;
      sMat.opacity = Math.min(1, murT / 5, (murDur - murT) / 5) * 0.92;
      stats.murmuration = sMat.opacity;
      if (murT >= murDur) { murActive = false; starlings.visible = false; murNext = 70 + rand() * 60; stats.murmuration = 0; }
    }
  }

  function reseat(x: number, z: number): void {
    groupSpot.fill(-1);
    for (let g = 0; g < Q.groups; g++) {
      const s = pickSpot(x, z, -1, 6);
      if (s >= 0) settleGroup(g, s);
      else for (let i = g * Q.per; i < (g + 1) * Q.per; i++) { px[i] = 0; py[i] = -50; pz[i] = 0; }
    }
    delay.fill(0);
  }

  return {
    root,
    update,
    reset() { seeded = false; },
    murmurate() { murNext = 0; },
    stats,
    dispose() {
      root.removeFromParent();
      geo.dispose(); mat.dispose(); mesh.dispose();
      sGeo.dispose(); sMat.dispose(); dot.dispose();
    },
  };
}
