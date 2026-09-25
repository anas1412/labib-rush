// Yellow taxis on TAXI_ROUTES. Each taxi follows a precomputed path (uniformly resampled every
// 0.5 m): out of the cross-street arm in its right-hand lane, a 90° right turn into an avenue lane
// (radius picked so the car clears the curb corner), along the avenue with optional S-curve lane
// changes, a right turn into the exit arm, and a stop at the arm's end, where it is recycled out of
// sight. Speed follows the Intelligent Driver Model against the nearest obstacle on its own path
// (another taxi, a crossing with pedestrians on it, Labib when it decides to stop for him, the end
// of the arm) with a curvature speed limit for the turns.
//
// During a run: Labib in the lane ahead within ~18 m → honk (taxi.honk + 'honk' event) and either
// stop for him (held while he stays on its path) or ease off, honk again, then stop; overlapping his
// capsule while moving > 2 m/s → hooks.hitPlayer (pushed toward the nearer curb), 4 s per-taxi
// cooldown, then the taxi brakes hard and waits. Kinematic box colliders (G.VEHICLE, filter
// LITTER | PLAYER) let kicked litter bounce off the cars. In menus taxis keep driving but never honk or hit.
import type RAPIER from '@dimforge/rapier3d-compat';
import { Frustum, Matrix4, Mesh, Sphere, Vector3 } from 'three';
import { TAXI_ROUTES, Z } from '../core/layout';
import { G, groups } from '../core/physics';
import type { GameContext, PropFactory, SessionHooks, TaxiModel, Traffic } from '../core/types';
import { CROSSINGS, crossingBusy, crossingNear } from './traffic/crossings';

const POOL = 10;
const STEP = 0.5; // path sample spacing (m)
const MAX_SAMPLES = 1600;
const LANE_CHANGE_LEN = 24;
const A_LAT = 3.0; // m/s² lateral comfort in turns
const HALF_LEN = 2.17, HALF_W = 0.88, BOX_DZ = -0.07; // collider (props notes)
const WHEELBASE = 2.6;
// IDM
const IDM_A = 1.7, IDM_B = 3.2, IDM_T = 1.1, IDM_S0 = 2.6;
const HONK_DIST = 18, HONK_LAT = 1.7;
const PLAYER_R = 0.35;
const YIELD_CREEP = 1.8; // m/s: below the 2 m/s hit threshold

interface Path {
  x: Float32Array; z: Float32Array; h: Float32Array; k: Float32Array; vmax: Float32Array;
  n: number; len: number;
  sLane0: number; sLane1: number; // straight avenue portion
}

interface Car {
  m: TaxiModel;
  body: RAPIER.RigidBody;
  on: boolean;
  route: number;
  entry: number; // lane index into laneZ
  changes: { x: number; lane: number }[];
  path: Path;
  s: number; v: number; cruise: number;
  x: number; z: number; yaw: number;
  honkCd: number; hitCd: number; brakeT: number; slowT: number; yieldT: number; yieldAge: number; warned: boolean;
  laneCd: number;
  braking: boolean;
  parkT: number;
}

const rawX = new Float32Array(8192), rawZ = new Float32Array(8192);

export interface TrafficDebug {
  cars: () => { x: number; z: number; v: number; yaw: number; s: number; route: number }[];
  stats: { honks: number; hits: number; spawned: number; minGap: number; offRoad: number };
}

export function createTraffic(ctx: GameContext, props: PropFactory, hooks: SessionHooks): Traffic & { debug: TrafficDebug } {
  const { engine, physics } = ctx;
  const camera = engine.camera;
  const R = physics.R;
  const lowQ = engine.quality === 'low';
  const baseCount = lowQ ? 3 : 4, maxCount = lowQ ? 7 : POOL;
  let difficulty = 0;
  const rand = Math.random;

  const cars: Car[] = [];
  for (let i = 0; i < POOL; i++) {
    const m = props.taxi(i % 3);
    // shadows: the body silhouette is enough (wheels hide under it) — keeps a taxi at 6 + 2 calls
    let big: Mesh | null = null;
    m.root.traverse((o) => { if ((o as Mesh).isMesh) { const me = o as Mesh; me.geometry.computeBoundingSphere(); if (!big || me.geometry.boundingSphere!.radius > big.geometry.boundingSphere!.radius) big = me; } });
    m.root.traverse((o) => { if ((o as Mesh).isMesh && o !== big) o.castShadow = false; });
    m.root.visible = false;
    engine.scene.add(m.root);
    const body = physics.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -200 - i * 5, 0));
    physics.world.createCollider(
      R.ColliderDesc.cuboid(HALF_W, 0.72, HALF_LEN).setTranslation(0, 0.72, BOX_DZ).setCollisionGroups(groups(G.VEHICLE, G.LITTER | G.PLAYER)).setFriction(0.4),
      body,
    );
    const path: Path = {
      x: new Float32Array(MAX_SAMPLES), z: new Float32Array(MAX_SAMPLES), h: new Float32Array(MAX_SAMPLES),
      k: new Float32Array(MAX_SAMPLES), vmax: new Float32Array(MAX_SAMPLES), n: 0, len: 0, sLane0: 0, sLane1: 0,
    };
    cars.push({
      m, body, on: false, route: 0, entry: 0, changes: [], path, s: 0, v: 0, cruise: 10, x: 0, z: 0, yaw: 0,
      honkCd: 0, hitCd: 0, brakeT: 0, slowT: 0, yieldT: 0, yieldAge: 0, warned: false, laneCd: 0, braking: false, parkT: 0,
    });
  }

  // --- path construction --------------------------------------------------------------------------
  const turnR = (laneZ: number) => (Math.abs(laneZ) > 18 ? 4.2 : 7); // curb-side lane turns tighter

  function buildPath(c: Car): void {
    const rt = TAXI_ROUTES[c.route];
    const dir = rt.dir;
    const hz = -Math.sign(rt.spawn.z), hzE = Math.sign(rt.exit.z);
    const xin = rt.spawn.x - 2 * hz, xout = rt.exit.x - 2 * hzE;
    const lanes = rt.laneZ;
    let n = 0;
    const push = (x: number, z: number) => { if (n < rawX.length) { rawX[n] = x; rawZ[n] = z; n++; } };
    const line = (x0: number, z0: number, x1: number, z1: number) => {
      const L = Math.hypot(x1 - x0, z1 - z0), m = Math.max(1, Math.ceil(L / 0.25));
      for (let i = 1; i <= m; i++) push(x0 + ((x1 - x0) * i) / m, z0 + ((z1 - z0) * i) / m);
    };
    const arc = (cx: number, cz: number, r: number, a0: number, a1: number) => {
      const m = Math.max(4, Math.ceil(Math.abs(a1 - a0) / 0.04));
      for (let i = 1; i <= m; i++) { const a = a0 + ((a1 - a0) * i) / m; push(cx + Math.cos(a) * r, cz + Math.sin(a) * r); }
    };
    // 1. out of the arm
    const z0 = lanes[c.entry], r0 = turnR(z0);
    const szTurn = z0 - hz * r0;
    push(xin, rt.spawn.z);
    line(xin, rt.spawn.z, xin, szTurn);
    // 2. right turn into the lane: centre = start + right·R, right of heading (0,hz) = (-hz, 0)
    {
      const cx = xin - hz * r0, cz = szTurn;
      const a0 = Math.atan2(szTurn - cz, xin - cx), a1 = Math.atan2(z0 - cz, xin - hz * r0 - cx);
      arc(cx, cz, r0, a0, a0 + wrap(a1 - a0));
    }
    const laneStartX = xin - hz * r0;
    const iLane0 = n;
    // 3. the avenue, with lane changes
    let lane = c.entry, x = laneStartX, z = z0;
    for (const ch of c.changes) {
      line(x, z, ch.x, z);
      const zt = lanes[ch.lane], m = Math.ceil(LANE_CHANGE_LEN / 0.25);
      for (let i = 1; i <= m; i++) {
        const u = i / m, e = u * u * (3 - 2 * u);
        push(ch.x + dir * LANE_CHANGE_LEN * u, z + (zt - z) * e);
      }
      x = ch.x + dir * LANE_CHANGE_LEN; z = zt; lane = ch.lane;
    }
    const r1 = turnR(lanes[lane]);
    const xTurn = xout - dir * r1;
    line(x, z, xTurn, z);
    const iLane1 = n;
    // 4. right turn into the exit arm: right of heading (dir, 0) = (0, dir)
    {
      const cx = xTurn, cz = z + dir * r1;
      const a0 = Math.atan2(z - cz, xTurn - cx), a1 = Math.atan2(z + dir * r1 - cz, xout - cx);
      arc(cx, cz, r1, a0, a0 + wrap(a1 - a0));
    }
    // 5. up the exit arm to its end
    line(xout, z + dir * r1, xout, rt.exit.z);

    // resample uniformly
    const P = c.path;
    let acc = 0, j = 0, out = 0;
    P.x[0] = rawX[0]; P.z[0] = rawZ[0]; out = 1;
    let sLane0 = 0, sLane1 = 0;
    for (j = 1; j < n && out < MAX_SAMPLES; j++) {
      const seg = Math.hypot(rawX[j] - rawX[j - 1], rawZ[j] - rawZ[j - 1]);
      if (j === iLane0) sLane0 = acc + seg;
      if (j === iLane1) sLane1 = acc + seg;
      while (acc + seg >= out * STEP && out < MAX_SAMPLES) {
        const t = seg > 0 ? (out * STEP - acc) / seg : 0;
        P.x[out] = rawX[j - 1] + (rawX[j] - rawX[j - 1]) * t;
        P.z[out] = rawZ[j - 1] + (rawZ[j] - rawZ[j - 1]) * t;
        out++;
      }
      acc += seg;
    }
    P.n = out; P.len = (out - 1) * STEP; P.sLane0 = sLane0; P.sLane1 = sLane1;
    for (let i = 0; i < out; i++) {
      const a = Math.max(0, i - 1), b = Math.min(out - 1, i + 1);
      P.h[i] = Math.atan2(P.x[b] - P.x[a], P.z[b] - P.z[a]);
    }
    for (let i = 0; i < out; i++) {
      const a = Math.max(0, i - 2), b = Math.min(out - 1, i + 2);
      const kk = b > a ? wrap(P.h[b] - P.h[a]) / ((b - a) * STEP) : 0;
      P.k[i] = kk;
      P.vmax[i] = Math.min(20, Math.sqrt(A_LAT / Math.max(Math.abs(kk), 1e-4)));
    }
  }

  const sampleAt = (P: Path, s: number, outV: { x: number; z: number; h: number; k: number }) => {
    const f = Math.max(0, Math.min(P.n - 1.001, s / STEP)), i = Math.floor(f), t = f - i;
    outV.x = P.x[i] + (P.x[i + 1] - P.x[i]) * t;
    outV.z = P.z[i] + (P.z[i + 1] - P.z[i]) * t;
    outV.h = P.h[i] + wrap(P.h[i + 1] - P.h[i]) * t;
    outV.k = P.k[i] + (P.k[i + 1] - P.k[i]) * t;
  };

  // --- spawning -----------------------------------------------------------------------------------
  const frustum = new Frustum(), pv = new Matrix4(), sph = new Sphere(), tmp = new Vector3(), dirV = new Vector3();
  const pose = { x: 0, z: 0, h: 0, k: 0 };
  const stats = { honks: 0, hits: 0, spawned: 0, minGap: 1e9, offRoad: 0 };
  let spawnT = 0, nextRoute = 0;

  const laneOf = (c: Car) => {
    const lanes = TAXI_ROUTES[c.route].laneZ;
    return Math.abs(c.z - lanes[0]) < Math.abs(c.z - lanes[1]) ? 0 : 1;
  };
  /** Is `lane` of route free between x-behind and x-ahead (along travel) of x? */
  function laneClear(route: number, lane: number, x: number, behind: number, ahead: number, self: Car | null): boolean {
    const rt = TAXI_ROUTES[route], zL = rt.laneZ[lane];
    for (const o of cars) {
      if (!o.on || o === self || o.route !== route) continue;
      if (Math.abs(o.z - zL) > 2.2) continue;
      const d = (o.x - x) * rt.dir;
      if (d > -behind && d < ahead) return false;
    }
    return true;
  }

  function planRoute(c: Car, route: number, entry: number): void {
    const rt = TAXI_ROUTES[route];
    c.route = route; c.entry = entry; c.changes.length = 0;
    const exit = rand() < 0.5 ? entry : 1 - entry;
    const x0 = rt.spawn.x, span = Math.abs(rt.exit.x - x0);
    if (exit !== entry) c.changes.push({ x: x0 + rt.dir * span * (0.15 + rand() * 0.6), lane: exit });
    buildPath(c);
    c.cruise = Math.min(13.5, 8 + rand() * 4 + difficulty * 0.25);
    c.honkCd = 0; c.hitCd = 0; c.brakeT = 0; c.slowT = 0; c.yieldT = 0; c.yieldAge = 0; c.warned = false; c.laneCd = 4 + rand() * 6;
  }

  function show(c: Car): void {
    c.on = true;
    c.m.root.visible = true;
    sampleAt(c.path, c.s, pose);
    c.x = pose.x; c.z = pose.z; c.yaw = pose.h;
    placeBody(c, true);
    stats.spawned++;
  }
  function hide(c: Car, i: number): void {
    c.on = false;
    c.m.root.visible = false;
    c.m.setBraking(false);
    c.body.setTranslation({ x: 0, y: -200 - i * 5, z: 0 }, false);
  }
  const qy = { x: 0, y: 0, z: 0, w: 1 }, tv = { x: 0, y: 0, z: 0 };
  function placeBody(c: Car, teleport: boolean): void {
    qy.y = Math.sin(c.yaw / 2); qy.w = Math.cos(c.yaw / 2);
    tv.x = c.x; tv.y = 0; tv.z = c.z;
    if (teleport) { c.body.setTranslation(tv, true); c.body.setRotation(qy, true); }
    else { c.body.setNextKinematicTranslation(tv); c.body.setNextKinematicRotation(qy); }
  }

  /** Out of the camera's sight: outside the frustum, far away, or behind a facade (ray vs STATIC). */
  const rayDir = new Vector3();
  function unseen(x: number, y: number, z: number, r: number): boolean {
    const cam = camera.position;
    const d = Math.hypot(x - cam.x, y - cam.y, z - cam.z);
    if (d > 160 || !frustum.intersectsSphere(sph.set(tmp.set(x, y, z), r))) return true;
    rayDir.set(x - cam.x, y - cam.y, z - cam.z).divideScalar(d);
    return !!physics.raycast(cam, rayDir, d - r - 0.5, G.STATIC);
  }

  function trySpawn(): boolean {
    const c = cars.find((o) => !o.on);
    if (!c) return false;
    for (let k = 0; k < TAXI_ROUTES.length; k++) {
      const route = (nextRoute + k) % TAXI_ROUTES.length;
      const rt = TAXI_ROUTES[route];
      const sp = rt.spawn;
      if (!unseen(sp.x - 2 * -Math.sign(sp.z), 1, sp.z, 3)) continue;
      // arm start clear
      let blocked = false;
      for (const o of cars) if (o.on && o.route === route && o.s < 16) blocked = true;
      if (blocked) continue;
      // merge into whichever lane has room at the turn
      const hz = -Math.sign(sp.z), mx = sp.x - 2 * hz;
      const ok0 = laneClear(route, 0, mx, 25, 12, null), ok1 = laneClear(route, 1, mx, 25, 12, null);
      if (!ok0 && !ok1) continue;
      const entry = ok0 && ok1 ? (rand() < 0.5 ? 0 : 1) : ok0 ? 0 : 1;
      planRoute(c, route, entry);
      c.s = 0; c.v = 5;
      show(c);
      nextRoute = route + 1;
      return true;
    }
    return false;
  }

  function target(): number { return Math.min(maxCount, baseCount + Math.floor(difficulty)); }

  /** Scatter taxis along the avenue portion of the routes (new run / startup). */
  function scatter(): void {
    cars.forEach((c, i) => { if (c.on) hide(c, i); });
    const n = target();
    for (let i = 0, guard = 0; i < n && guard < 60; guard++) {
      const c = cars[i];
      const route = i % TAXI_ROUTES.length;
      planRoute(c, route, rand() < 0.5 ? 0 : 1);
      const P = c.path;
      const s = P.sLane0 + 5 + rand() * Math.max(1, P.sLane1 - P.sLane0 - 60);
      sampleAt(P, s, pose);
      let clash = false;
      for (let j = 0; j < i; j++) { const o = cars[j]; if (o.on && (o.x - pose.x) ** 2 + (o.z - pose.z) ** 2 < 30 * 30) clash = true; }
      if (clash) continue;
      c.s = s; c.v = c.cruise * 0.8;
      show(c);
      i++;
    }
    spawnT = 2;
  }

  function honk(c: Car): void {
    c.m.honk();
    ctx.events.emit('honk', { position: new Vector3(c.x, 1.1, c.z) }); // rare; listeners may keep it
    stats.honks++;
    c.honkCd = 3.5;
  }

  // --- per-frame -----------------------------------------------------------------------------------
  const ahead = { gap: 1e9, vl: 0 };
  function update(dt: number): void {
    dt = Math.min(dt, 0.1);
    pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(pv);
    const playing = hooks.isPlaying();
    const pl = hooks.player();
    const lx = pl.position.x, ly = pl.position.y, lz = pl.position.z;
    crossingNear.fill(0);

    let active = 0; // taxis parked at an arm end waiting to vanish don't count
    for (const c of cars) if (c.on && c.s < c.path.len - HALF_LEN - 4) active++;
    spawnT -= dt;
    if (active < target() && spawnT <= 0) { trySpawn(); spawnT = 1.2 + rand() * 1.5; }

    let minGap = 1e9;
    for (let ci = 0; ci < cars.length; ci++) {
      const c = cars[ci];
      if (!c.on) continue;
      const P = c.path;
      c.honkCd -= dt; c.hitCd -= dt; c.brakeT -= dt; c.slowT -= dt; c.yieldT -= dt; c.laneCd -= dt;
      const look = Math.max(14, c.v * 3.5 + 10);
      const i0 = Math.floor(c.s / STEP), i1 = Math.min(P.n - 1, Math.ceil((c.s + look) / STEP));
      ahead.gap = P.len + IDM_S0 - c.s - HALF_LEN - 0.5; ahead.vl = 0; // the arm end (stop with the bumper at it)
      // other taxis on my path
      for (const o of cars) {
        if (o === c || !o.on) continue;
        const d2 = (o.x - c.x) ** 2 + (o.z - c.z) ** 2;
        if (d2 < minGap) minGap = d2;
        if (d2 > (look + 6) ** 2) continue;
        for (let i = i0 + 2; i <= i1; i += 2) {
          if ((P.x[i] - o.x) ** 2 + (P.z[i] - o.z) ** 2 < 1.8 * 1.8) {
            const gap = i * STEP - c.s - 2 * HALF_LEN - 0.3;
            if (gap < ahead.gap) { ahead.gap = gap; ahead.vl = o.v; }
            break;
          }
        }
      }
      // crossings: stop for people on them, tell people when we are coming
      const nearTo = Math.min(P.n - 1, Math.ceil((c.s + Math.max(12, c.v * 4)) / STEP));
      for (let k = 0; k < CROSSINGS.length; k++) {
        const r = CROSSINGS[k];
        const iStart = Math.max(0, Math.floor((c.s - HALF_LEN) / STEP));
        for (let i = iStart; i <= Math.max(nearTo, i1); i += 2) {
          const x = P.x[i], z = P.z[i];
          if (x < r.x0 - 0.8 || x > r.x1 + 0.8 || z < r.z0 - 0.8 || z > r.z1 + 0.8) continue;
          if (i <= nearTo) crossingNear[k] = 1;
          if (crossingBusy[k] > 0 && i * STEP > c.s + HALF_LEN - 0.5) {
            const gap = i * STEP - c.s - HALF_LEN - 0.8;
            if (gap < ahead.gap) { ahead.gap = gap; ahead.vl = 0; }
          }
          break;
        }
      }
      // Labib in the lane ahead. First honk: 60% stop for him, 40% only ease off (a second honk
      // when that runs out; if he is still there, it stops). A yielding taxi keeps yielding while he
      // stays on its path (re-honking every ~5 s) and never rolls faster than YIELD_CREEP near him,
      // so a car that stopped can never register a hit.
      let labibD = -1;
      if (playing && Math.abs(ly) < 2.5) {
        const dl2 = (lx - c.x) ** 2 + (lz - c.z) ** 2;
        if (dl2 < (HONK_DIST + 4) ** 2) {
          const iH = Math.min(P.n - 1, Math.ceil((c.s + HONK_DIST) / STEP));
          for (let i = i0 + 1; i <= iH; i++) {
            if ((P.x[i] - lx) ** 2 + (P.z[i] - lz) ** 2 < HONK_LAT * HONK_LAT) { labibD = i * STEP - c.s; break; }
          }
        }
      }
      if (labibD >= 0) {
        const d = labibD;
        if (c.yieldT > 0) {
          c.yieldAge += dt;
          c.yieldT = Math.max(c.yieldT, 0.8); // refreshed while he stays on the path
          if (c.yieldAge > 5 && c.honkCd <= 0) honk(c);
        } else if (c.honkCd <= 0 && d > HALF_LEN && (c.v > 3 || c.warned)) {
          honk(c);
          if (c.warned || rand() < 0.6) { c.yieldT = 2.5; c.yieldAge = 0; c.slowT = 0; }
          else { c.slowT = 2; c.honkCd = 2; c.warned = true; }
        }
        if (c.yieldT > 0) {
          const gap = d - HALF_LEN - 1.2;
          if (gap < ahead.gap) { ahead.gap = gap; ahead.vl = 0; }
        }
      } else if (c.slowT <= 0 && c.yieldT <= 0) c.warned = false;
      // desired speed: cruise, the curvature limit ahead (brake in time for turns), easing off
      let v0 = c.cruise;
      if (c.slowT > 0) v0 = Math.min(v0, 4.5);
      for (let i = i0; i <= i1; i += 2) {
        const d = Math.max(0, i * STEP - c.s);
        const vAllowed = Math.sqrt(P.vmax[i] * P.vmax[i] + 2 * 2.2 * d);
        if (vAllowed < v0) v0 = vAllowed;
      }
      v0 = Math.max(0.5, v0);
      // IDM
      const v = c.v;
      const sStar = IDM_S0 + v * IDM_T + (v * (v - ahead.vl)) / (2 * Math.sqrt(IDM_A * IDM_B));
      let a = IDM_A * (1 - (v / v0) ** 4);
      if (ahead.gap < 1e8) a -= IDM_A * (sStar / Math.max(0.1, ahead.gap)) ** 2;
      if (c.brakeT > 0) a = -9;
      a = Math.max(-9, Math.min(IDM_A, a));
      c.v = Math.max(0, v + a * dt);
      if (ahead.gap < 0.3 && c.v > 0) c.v = Math.min(c.v, 0.5); // never shove into the car ahead
      if (c.yieldT > 0 && labibD >= 0 && labibD < HALF_LEN + 6) c.v = Math.min(c.v, YIELD_CREEP);
      const dist = c.v * dt;
      c.s = Math.min(P.len, c.s + dist);
      sampleAt(P, c.s, pose);
      c.x = pose.x; c.z = pose.z; c.yaw = pose.h;
      const braking = a < -1.2 || (c.v < 0.4 && ahead.gap < 10);
      if (braking !== c.braking) { c.braking = braking; c.m.setBraking(braking); }
      const r = c.m.root;
      r.position.set(c.x, 0, c.z);
      r.rotation.y = c.yaw;
      c.m.update(dt, dist, Math.atan(WHEELBASE * pose.k));
      placeBody(c, false);
      r.visible = (c.x - camera.position.x) ** 2 + (c.z - camera.position.z) ** 2 < 230 * 230;
      if (Math.abs(c.z) < 13.9 && c.x > -238 && c.x < 258) stats.offRoad++;

      // opportunistic lane change (overtake a slow taxi / now and then)
      const dirX = TAXI_ROUTES[c.route].dir;
      let changing = false; // an S-curve still under way or planned just ahead
      for (const ch of c.changes) if ((ch.x + dirX * LANE_CHANGE_LEN - c.x) * dirX > -2 && (ch.x - c.x) * dirX < 30) changing = true;
      if (!changing && c.laneCd <= 0 && c.s > P.sLane0 + 4 && c.s < P.sLane1 - LANE_CHANGE_LEN - 45 && c.changes.length < 3) {
        c.laneCd = 5 + rand() * 6;
        const stuckBehind = ahead.gap < 25 && ahead.vl < c.cruise - 2;
        if (stuckBehind || rand() < 0.2) {
          const cur = laneOf(c), to = 1 - cur;
          const rt = TAXI_ROUTES[c.route];
          const startX = c.x + rt.dir * 3;
          if (laneClear(c.route, to, c.x, 14, LANE_CHANGE_LEN + 12, c)) {
            // drop planned changes still ahead, then change now
            c.changes = c.changes.filter((ch) => (ch.x - c.x) * rt.dir < 0);
            c.changes.push({ x: startX, lane: to });
            buildPath(c);
          }
        }
      }

      // hitting Labib
      if (playing && c.hitCd <= 0 && c.v > 2 && ly < 1.45) {
        const fx = Math.sin(c.yaw), fz = Math.cos(c.yaw);
        const ox = lx - c.x, oz = lz - c.z;
        const lf = ox * fx + oz * fz - BOX_DZ, lr = ox * -fz + oz * fx; // along, right
        if (Math.abs(lf) < HALF_LEN + PLAYER_R && Math.abs(lr) < HALF_W + PLAYER_R) {
          // push him out of the lane: toward the nearer curb on the avenue, else off the car's side
          if (Math.abs(fx) > 0.7) {
            const az = Math.abs(lz), sz = Math.sign(lz) || 1;
            dirV.set(fx * 0.3, 0, az < (Z.southRoadInner + Z.southRoadOuter) / 2 ? -sz : sz);
          } else {
            const side = lr >= 0 ? 1 : -1;
            dirV.set(-fz * side + fx * 0.3, 0, fx * side + fz * 0.3);
          }
          dirV.normalize();
          hooks.hitPlayer(dirV, c.v);
          stats.hits++;
          c.hitCd = 4;
          c.brakeT = 1.2;
          c.yieldT = 2.5; c.yieldAge = 0; // then wait until he is out of the path
          c.honkCd = Math.max(c.honkCd, 2);
        }
      }

      // arrived at the arm end: recycle once nobody can see it
      // well into the exit arm: vanish as soon as nobody can see it (else it parks at the end)
      if (c.s > P.sLane1 + 16) {
        c.parkT += dt;
        if (c.parkT > 0.4) { c.parkT = 0; if (unseen(c.x, 1, c.z, 3)) hide(c, ci); }
      }
    }
    stats.minGap = Math.sqrt(minGap);
  }

  scatter();
  let disposed = false;

  return {
    update(dt: number, _time: number): void { if (!disposed) update(dt); },
    setDifficulty(level: number): void { difficulty = Math.max(0, level); },
    reset(): void { difficulty = 0; scatter(); },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const c of cars) {
        c.m.root.removeFromParent();
        physics.world.removeRigidBody(c.body);
      }
      cars.length = 0;
      crossingNear.fill(0);
    },
    debug: {
      cars: () => cars.filter((c) => c.on).map((c) => ({ x: c.x, z: c.z, v: c.v, yaw: c.yaw, s: c.s, route: c.route })),
      stats,
    },
  };
}

function wrap(a: number): number { return Math.atan2(Math.sin(a), Math.cos(a)); }
