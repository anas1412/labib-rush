// Downtown crowd: pedestrians on the sidewalks, promenade walks, crossings and plazas; café
// patrons; litterbugs; plus the pigeons and starlings (./birds.ts).
//
// Pedestrians come from a pool of Persons made once (seeds spread over 0–199) and are recycled
// within ~55 m of the camera, weighted toward what it looks at: they enter from alleys and cross-street sidewalks or
// appear out of sight, follow a walk network (./crowd/graph.ts), and leave the same way. Steering
// is a lateral "lane" search along the current edge against a clearance grid rasterised from the
// physics world (./crowd/navgrid.ts), so nobody walks through trunks, kiosks, benches, bins or café
// furniture, and nobody steps onto a lane except at a crossing (where they wait for taxis, see
// ./traffic/crossings.ts). Separation keeps them apart; Labib is steered around, and a sprint
// within 1.5 m startles people into a sidestep. Walkers within 25 m of Labib carry kinematic
// capsules (G.NPC) from a fixed pool so he bumps into them.
//
// Litterbugs (only while a run is on): a walker in view gets a warning marker for 1.2 s, throws
// (hooks.throwLitter at THROW_RELEASE_SEC; the session's hook emits 'litterThrown'), then walks on
// with a "catch me" marker whose ring drains over RULES.caughtWindow; touching them in that window
// → hooks.caught, and they walk to where it landed and kneel to pick it up.
import type RAPIER from '@dimforge/rapier3d-compat';
import { Frustum, Group, Matrix4, Sphere, Vector3 } from 'three';
import { RULES } from '../core/config';
import { CAFE_TERRACES, CROSS_STREETS, CURB, ROAD_X, Z } from '../core/layout';
import { G, groups } from '../core/physics';
import type { Crowd, GameContext, PeopleFactory, Person, PersonAnim, Quality, SessionHooks } from '../core/types';
import { createBirds, type Birds, type Threat } from './birds';
import { buildWalkGraph, WALK_R, type Edge } from './crowd/graph';
import { LitterIcons } from './crowd/icons';
import { NavGrid } from './crowd/navgrid';
import { THROW_RELEASE_SEC, handWorldPosition } from './people';
import { crossingAt, crossingBusy, crossingNear } from './traffic/crossings';

const COUNTS: Record<Quality, { walkers: number; patrons: number }> = {
  low: { walkers: 26, patrons: 16 },
  medium: { walkers: 36, patrons: 20 },
  high: { walkers: 38, patrons: 24 },
  ultra: { walkers: 44, patrons: 28 },
};
const BUBBLE_OUT = 55; // m from the camera: walkers beyond are recycled once out of view…
const BUBBLE_HARD = 90; // …and beyond this even in view
const FAR = 45; // m: beyond, walkers tick at 1/3 rate
const PATRON_HIDE = 80; // m: patrons beyond are hidden (a few pixels tall, in the haze)
const BODY_IN = 25, BODY_OUT = 28, BODIES = 14; // kinematic capsules near Labib
const CAPSULE_R = 0.26, CAPSULE_HALF = 0.6;
const STARTLE_DIST = 1.5;
const WARN_SEC = 1.2;
const TOUCH_DIST = 1.15; // Labib ↔ litterbug centre distance that counts as a catch
const PICKUP_SEC = 1.8;
const THROW_SEC = 1.1;
const ICONS = 3;

// walker modes
const OFF = 0, WALK = 1, WAIT = 2, BUSY = 3, LINGER = 4;
const TALK_P = 0.3; // chance two people meeting head-on stop for a chat
// litterbug states
const NONE = 0, WARN = 1, THROW = 2, CATCH = 3, PICK = 4, GOPICK = 5; // GOPICK: walking to the litter

interface Walker {
  p: Person;
  mode: number;
  modeT: number;
  x: number; z: number; y: number;
  yaw: number;
  speed: number; // actual, smoothed (m/s)
  cruise: number;
  edge: number; from: number; to: number;
  pendingEdge: number;
  lat: number; pref: number; planT: number;
  sx: number; sz: number; // sidestep velocity
  startleCd: number;
  stuckT: number;
  body: number;
  bug: number; bugT: number; bugCd: number; litterId: number; icon: number; released: boolean;
  landX: number; landZ: number;
  talkCd: number; talkT: number;
  grow: number; // 0→1 scale-in after an in-view spawn
  loop: PersonAnim;
  acc: number;
  tick: number;
  inView: boolean;
}

interface Patron { p: Person; chair: number; x: number; z: number; shown: boolean; acc: number; tick: number; startleCd: number }
interface Chair { x: number; y: number; z: number; yaw: number; terrace: number; owner: number }

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Road surface (y = 0) under a point? Everything else walkable is at CURB. */
function onRoad(x: number, z: number): boolean {
  const az = Math.abs(z);
  if (x > ROAD_X.min && x < ROAD_X.max && az > Z.southRoadInner && az < Z.southRoadOuter) return true;
  if (az >= Z.southRoadOuter) for (const c of CROSS_STREETS) if (Math.abs(x - c.x) < 4) return true;
  return false;
}

export interface CrowdDebug {
  grid: NavGrid;
  walkers: () => { x: number; z: number; mode: number; bug: number; clearance: number; visible: boolean }[];
  patrons: number;
  bodies: () => number;
  birds: Birds;
  /** Starts a litterbug on the walker nearest to (x, z) now, if one is free. */
  forceLitterbug(x: number, z: number): boolean;
  graph: { nodes: number; edges: number };
}

export function createCrowd(ctx: GameContext, people: PeopleFactory, hooks: SessionHooks): Crowd & { debug: CrowdDebug } {
  const { engine, physics } = ctx;
  const camera = engine.camera;
  const Q = COUNTS[engine.quality];
  const rand = mulberry(20260925);
  const root = new Group();
  root.name = 'crowd';
  engine.scene.add(root);

  const grid = new NavGrid(physics);
  const graph = buildWalkGraph(grid);
  const { nx, nz, sink, edges, adj } = graph;
  // spawn sampling: length-weighted over the edges near the camera (rebuilt when it moves 5 m)
  const localEdge = new Int32Array(edges.length), localCum = new Float32Array(edges.length);
  let localN = 0, localX = 1e9, localZ = 1e9;
  function localEdges(cx: number, cz: number): void {
    if ((cx - localX) ** 2 + (cz - localZ) ** 2 < 25) return;
    localX = cx; localZ = cz; localN = 0;
    let acc = 0;
    for (let i = 0; i < edges.length; i++) {
      const E = edges[i];
      if (E.crossing >= 0) continue;
      const mx = (nx[E.a] + nx[E.b]) / 2 - cx, mz = (nz[E.a] + nz[E.b]) / 2 - cz, r = 65 + E.len / 2;
      if (mx * mx + mz * mz > r * r) continue;
      acc += E.len; localEdge[localN] = i; localCum[localN++] = acc;
    }
  }
  const sinks: number[] = [];
  for (let i = 0; i < nx.length; i++) if (sink[i] && adj[i].length) sinks.push(i);

  // --- pool --------------------------------------------------------------------------------------
  const walkers: Walker[] = [];
  for (let i = 0; i < Q.walkers; i++) {
    const p = people.create((i * 37) % 200);
    p.setVisible(false);
    root.add(p.root);
    walkers.push({
      p, mode: OFF, modeT: 0, x: 0, z: 0, y: CURB, yaw: 0, speed: 0, cruise: 1.2, edge: 0, from: 0, to: 0, pendingEdge: -1,
      lat: 0, pref: 0, planT: 0, sx: 0, sz: 0, startleCd: 0, stuckT: 0, body: -1,
      bug: NONE, bugT: 0, bugCd: 0, litterId: -1, icon: -1, released: false, landX: 0, landZ: 0, talkCd: 0, talkT: 0, grow: 1,
      loop: 'idle', acc: 0, tick: i % 3, inView: false,
    });
  }
  const icons = new LitterIcons(root, ICONS);
  const iconOwner = new Int16Array(ICONS).fill(-1);

  // kinematic capsules
  const R = physics.R;
  const bodies: { body: RAPIER.RigidBody; owner: number }[] = [];
  for (let i = 0; i < BODIES; i++) {
    const body = physics.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -100 - i * 3, 0));
    physics.world.createCollider(R.ColliderDesc.capsule(CAPSULE_HALF, CAPSULE_R).setCollisionGroups(groups(G.NPC, G.PLAYER | G.LITTER)), body);
    bodies.push({ body, owner: -1 });
  }

  // --- café patrons ------------------------------------------------------------------------------
  // Seated at the cafeChairs of the 2–3 terraces nearest the camera (dense enough to read as busy);
  // patrons whose terrace falls far behind move, out of sight, to a terrace coming up.
  const chairs: Chair[] = [];
  {
    const { cafeChairs, cafeTables } = ctx.anchors;
    for (const c of cafeChairs) {
      let best = -1, bd = 1e9;
      cafeTables.forEach((t, ti) => { const d = (t.x - c.x) ** 2 + (t.z - c.z) ** 2; if (d < bd) { bd = d; best = ti; } });
      if (best < 0 || bd > 1.2) continue;
      const t = cafeTables[best];
      const k = CAFE_TERRACES.findIndex((tr) => t.x >= tr.xMin - 1 && t.x <= tr.xMax + 1 && Math.sign(t.z) === tr.side);
      if (k >= 0) chairs.push({ x: c.x, y: c.y, z: c.z, yaw: Math.atan2(t.x - c.x, t.z - c.z), terrace: k, owner: -1 });
    }
  }
  const PER_TERRACE = 11;
  const terraceCount = new Int16Array(CAFE_TERRACES.length);
  const terraceOrder = CAFE_TERRACES.map((_, i) => i);
  const terraceD2 = (k: number, x: number, z: number) => {
    const t = CAFE_TERRACES[k], tx = Math.max(t.xMin, Math.min(t.xMax, x)), tz = t.side * 26;
    return (tx - x) ** 2 + (tz - z) ** 2;
  };
  const patrons: Patron[] = [];
  for (let n = 0; n < Q.patrons; n++) {
    const p = people.create(((Q.walkers + n) * 37) % 200);
    root.add(p.root);
    patrons.push({ p, chair: -1, x: 0, z: 0, shown: true, acc: 0, tick: n % 3, startleCd: 0 });
  }
  function seat(pt: Patron, ci: number): void {
    if (pt.chair >= 0) { chairs[pt.chair].owner = -1; terraceCount[chairs[pt.chair].terrace]--; }
    const c = chairs[ci];
    c.owner = 1; terraceCount[c.terrace]++;
    pt.chair = ci; pt.x = c.x; pt.z = c.z;
    pt.p.root.position.set(c.x, c.y - 0.46, c.z);
    pt.p.root.rotation.y = c.yaw;
    pt.p.setAnim('sit');
  }
  /** A free chair on the nearest terrace with room, optionally only out of the camera's view. */
  function freeChair(cx: number, cz: number, hidden: boolean): number {
    terraceOrder.sort((a, b) => terraceD2(a, cx, cz) - terraceD2(b, cx, cz));
    for (const k of terraceOrder) {
      if (terraceCount[k] >= PER_TERRACE || terraceD2(k, cx, cz) > 75 * 75) continue;
      const start = Math.floor(rand() * chairs.length);
      for (let j = 0; j < chairs.length; j++) {
        const ci = (start + j) % chairs.length, c = chairs[ci];
        if (c.terrace !== k || c.owner >= 0) continue;
        if (hidden && visibleAt(c.x, c.y + 0.4, c.z, 1)) continue;
        return ci;
      }
    }
    return -1;
  }
  function seatAll(cx: number, cz: number): void {
    for (const pt of patrons) if (pt.chair >= 0) { chairs[pt.chair].owner = -1; pt.chair = -1; }
    terraceCount.fill(0);
    for (const pt of patrons) {
      const ci = freeChair(cx, cz, false);
      if (ci >= 0) { seat(pt, ci); pt.p.setVisible(true); pt.shown = true; }
      else { pt.p.setVisible(false); pt.shown = false; }
    }
  }
  let patronT = 0;

  const birds = createBirds(grid, engine.quality, ctx.uniforms, mulberry(77));
  root.add(birds.root);

  // --- state ---------------------------------------------------------------------------------------
  let difficulty = 0;
  let bugTimer = 4;
  let spawnT = 0;
  const lastCam = new Vector3(1e9, 0, 0);
  const frustum = new Frustum(), pv = new Matrix4(), sph = new Sphere(), tmp = new Vector3();
  const hand = new Vector3(), vel = new Vector3();
  const avoid = new Float32Array(Q.walkers * 2);
  const NB = 6;
  const nbr = new Int16Array(Q.walkers * NB), nbrN = new Uint8Array(Q.walkers);
  const threat: Threat = { x: 0, y: 0, z: 0, speed: 0 };
  let px = 0, py = 0, pz = 0, pvx = 0, pvz = 0, sprinting = false, camFx = 0, camFz = 1;
  let disposed = false;

  const visibleAt = (x: number, y: number, z: number, r: number) => frustum.intersectsSphere(sph.set(tmp.set(x, y, z), r));
  const setLoop = (w: Walker, a: PersonAnim) => { if (w.loop !== a) { w.loop = a; w.p.setAnim(a); } };

  function releaseBody(w: Walker): void {
    if (w.body < 0) return;
    const b = bodies[w.body];
    b.owner = -1;
    b.body.setTranslation({ x: 0, y: -100 - w.body * 3, z: 0 }, false);
    w.body = -1;
  }
  function freeIcon(w: Walker): void {
    if (w.icon < 0) return;
    icons.hide(w.icon);
    iconOwner[w.icon] = -1;
    w.icon = -1;
  }
  function deactivate(w: Walker): void {
    w.mode = OFF;
    w.p.setVisible(false);
    releaseBody(w);
    freeIcon(w);
    w.bug = NONE;
  }

  /** Put walker on edge e at distance s from node `from`, walking toward the other end. */
  function activate(w: Walker, e: number, from: number, s: number): void {
    const E = edges[e], to = E.a === from ? E.b : E.a;
    const ux = (nx[to] - nx[from]) / E.len, uz = (nz[to] - nz[from]) / E.len;
    w.edge = e; w.from = from; w.to = to; w.pendingEdge = -1;
    w.cruise = 1.05 + rand() * 0.45;
    w.pref = (0.25 + rand() * 0.9) * (rand() < 0.85 ? 1 : -1); // keep right, mostly
    w.lat = Math.max(-E.half, Math.min(E.half, w.pref));
    w.x = nx[from] + ux * s - uz * w.lat;
    w.z = nz[from] + uz * s + ux * w.lat;
    if (!grid.free(w.x, w.z, 0.3)) { w.x = nx[from] + ux * s; w.z = nz[from] + uz * s; w.lat = 0; }
    w.y = onRoad(w.x, w.z) ? 0 : CURB;
    w.yaw = Math.atan2(ux, uz);
    w.speed = w.cruise; w.sx = w.sz = 0; w.stuckT = 0; w.planT = 0; w.startleCd = 0;
    w.mode = WALK; w.modeT = 0; w.bug = NONE; w.bugCd = 5 + rand() * 10;
    w.p.setVisible(true);
    w.grow = 1; w.p.root.scale.setScalar(1);
    w.loop = 'idle';
    setLoop(w, 'walk');
    w.p.root.position.set(w.x, w.y, w.z);
    w.p.root.rotation.y = w.yaw;
  }

  function crowdedAt(x: number, z: number, r: number, self: Walker | null): boolean {
    for (const o of walkers) if (o !== self && o.mode !== OFF && (o.x - x) ** 2 + (o.z - z) ** 2 < r * r) return true;
    return (px - x) ** 2 + (pz - z) ** 2 < 9;
  }

  /** Try to spawn one walker: from a sink near the camera, or out of view on the network. */
  function spawnOne(cx: number, cz: number, anywhere: boolean): boolean {
    const w = walkers.find((o) => o.mode === OFF);
    if (!w) return false;
    for (let tries = 0; tries < 16; tries++) {
      if (!anywhere && rand() < 0.5 && sinks.length) {
        const n = sinks[Math.floor(rand() * sinks.length)];
        const d2 = (nx[n] - cx) ** 2 + (nz[n] - cz) ** 2;
        if (d2 < 10 * 10 || d2 > 48 * 48) continue;
        const e = adj[n][0];
        if (crowdedAt(nx[n], nz[n], 1.5, null)) continue;
        activate(w, e, n, 0.3);
        return true;
      }
      localEdges(cx, cz);
      if (!localN) return false;
      const r = rand() * localCum[localN - 1];
      let lo = 0, hi = localN - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (localCum[m] < r) lo = m + 1; else hi = m; }
      const ei = localEdge[lo];
      const E: Edge = edges[ei];
      const s = rand() * E.len;
      const x = nx[E.a] + ((nx[E.b] - nx[E.a]) * s) / E.len, z = nz[E.a] + ((nz[E.b] - nz[E.a]) * s) / E.len;
      const d2 = (x - cx) ** 2 + (z - cz) ** 2;
      // favour spots ahead of the camera: that is where the player looks and runs
      const behind = (x - cx) * camFx + (z - cz) * camFz < 0;
      if (behind && rand() < 0.85) continue;
      let grow = false;
      if (anywhere) { if (d2 > 55 * 55) continue; }
      else if (d2 < 16 * 16 || d2 > 60 * 60) continue;
      else if (visibleAt(x, 1, z, 1.2)) {
        // in view only far ahead (≈30 px tall), fading in by scale, to refill the street he runs into
        if (d2 < 40 * 40) continue;
        grow = true;
      } else if (d2 > 50 * 50) continue;
      if (!grid.free(x, z, WALK_R) || crowdedAt(x, z, 1.6, null)) continue;
      const from = rand() < 0.5 ? E.a : E.b;
      activate(w, ei, from, from === E.a ? s : E.len - s);
      if (grow) { w.grow = 0; w.p.root.scale.setScalar(0.05); }
      return true;
    }
    return false;
  }

  function scatter(cx: number, cz: number): void {
    for (const w of walkers) deactivate(w);
    for (let i = 0, guard = 0; i < Q.walkers && guard < Q.walkers * 6; guard++) if (spawnOne(cx, cz, true)) i++;
    lastCam.set(cx, 0, cz);
    seatAll(cx, cz);
  }

  /** Lateral offset (right of the edge direction) whose look-ahead is free of obstacles/people. */
  function planLateral(w: Walker, E: Edge, ax: number, az: number, ux: number, uz: number, s: number, wi: number): number {
    const rx = -uz, rz = ux;
    const half = E.half;
    const pref = Math.max(-half, Math.min(half, E.crossing >= 0 ? w.pref * 0.5 : w.pref));
    const nearLabib = (w.x - px) ** 2 + (w.z - pz) ** 2 < 36;
    let best = NaN, bestCost = 1e9;
    const steps = Math.ceil((half * 2) / 0.3) + 1;
    for (let k = 0; k <= steps * 2; k++) {
      const c = pref + (k & 1 ? 1 : -1) * Math.ceil(k / 2) * 0.3;
      if (c < -half || c > half) continue;
      const cost = Math.abs(c - pref) + 0.7 * Math.abs(c - w.lat);
      if (cost >= bestCost) continue;
      let ok = true;
      for (let li = 0; li < 3 && ok; li++) {
        const q = Math.min(s + (li === 0 ? 0.7 : li === 1 ? 1.6 : 2.8), E.len);
        const qx = ax + ux * q + rx * c, qz = az + uz * q + rz * c;
        if (grid.clearance(qx, qz) < WALK_R) { ok = false; break; }
        if (nearLabib && (qx - px) ** 2 + (qz - pz) ** 2 < 1.1 * 1.1) { ok = false; break; }
        for (let j = 0; j < nbrN[wi]; j++) {
          const o = walkers[nbr[wi * NB + j]];
          // people ahead coming the other way or standing: leave them room
          const ahead = (o.x - w.x) * ux + (o.z - w.z) * uz;
          if (ahead < 0.2) continue;
          const facing = Math.sin(o.yaw) * ux + Math.cos(o.yaw) * uz;
          if (facing > 0.5 && o.speed > w.speed * 0.8) continue;
          if ((qx - o.x) ** 2 + (qz - o.z) ** 2 < 0.62 * 0.62) { ok = false; break; }
        }
      }
      if (ok) { best = c; bestCost = cost; }
    }
    return Number.isNaN(best) ? w.lat : best;
  }

  /** Arrived at w.to: pick the next edge (keep heading, avoid U-turns), or leave at a sink. */
  function arrive(w: Walker, cx: number, cz: number): void {
    const B = w.to;
    if (sink[B] && w.bug === NONE) { w.mode = LINGER; w.modeT = 0; setLoop(w, 'idle'); return; }
    const list = adj[B];
    const hx = Math.sin(w.yaw), hz = Math.cos(w.yaw);
    const tcx = cx - nx[B], tcz = cz - nz[B], tcd = Math.hypot(tcx, tcz) || 1;
    const farOut = tcd > FAR;
    let total = 0;
    const W = weights;
    for (let k = 0; k < list.length; k++) {
      const e = list[k];
      if (e === w.edge && list.length > 1) { W[k] = 0; continue; }
      const E = edges[e], o = E.a === B ? E.b : E.a;
      const dx = (nx[o] - nx[B]) / E.len, dz = (nz[o] - nz[B]) / E.len;
      const dot = dx * hx + dz * hz;
      let wt = 0.35 + Math.max(0, dot) ** 2 * 3;
      if (sink[o]) wt *= w.bug === NONE ? 0.35 : 0;
      if (E.crossing >= 0) wt *= 0.7;
      if (farOut) wt *= 1 + 2 * Math.max(0, (dx * tcx + dz * tcz) / tcd);
      W[k] = wt;
      total += wt;
    }
    let pick = list[0];
    if (total > 0) {
      let r = rand() * total;
      for (let k = 0; k < list.length; k++) { r -= W[k]; if (r <= 0 && W[k] > 0) { pick = list[k]; break; } }
    }
    const E = edges[pick];
    if (E.crossing >= 0 && crossingNear[E.crossing]) {
      w.mode = WAIT; w.modeT = 0; w.pendingEdge = pick;
      setLoop(w, 'idle');
      return;
    }
    takeEdge(w, pick, B);
  }
  const weights = new Float32Array(16);

  function takeEdge(w: Walker, e: number, from: number): void {
    const E = edges[e];
    w.edge = e; w.from = from; w.to = E.a === from ? E.b : E.a; w.planT = 0; w.pendingEdge = -1;
    // lateral relative to the new edge = where we stand now
    const ux = (nx[w.to] - nx[from]) / E.len, uz = (nz[w.to] - nz[from]) / E.len;
    w.lat = Math.max(-E.half, Math.min(E.half, (w.x - nx[from]) * -uz + (w.z - nz[from]) * ux));
    w.mode = WALK; w.modeT = 0;
    setLoop(w, 'walk');
  }

  function startLitterbug(w: Walker): boolean {
    let slot = -1;
    for (let i = 0; i < ICONS; i++) if (iconOwner[i] < 0) { slot = i; break; }
    if (slot < 0) return false;
    iconOwner[slot] = walkers.indexOf(w);
    w.icon = slot;
    w.bug = WARN; w.bugT = 0; w.released = false; w.litterId = -1;
    return true;
  }

  function endLitterbug(w: Walker, cooldown: number): void {
    freeIcon(w);
    w.bug = NONE;
    w.bugCd = cooldown;
    if (w.mode === BUSY) { w.mode = WALK; setLoop(w, 'walk'); }
  }

  // --- per-frame -----------------------------------------------------------------------------------
  function update(dt: number): void {
    dt = Math.min(dt, 0.1);
    const cam = camera.position;
    pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(pv);
    const pl = hooks.player();
    px = pl.position.x; py = pl.position.y; pz = pl.position.z;
    pvx = pl.velocity.x; pvz = pl.velocity.z;
    sprinting = pl.sprinting;
    const playing = hooks.isPlaying();
    const cx = cam.x, cz = cam.z;
    camFx = -camera.matrixWorld.elements[8]; camFz = -camera.matrixWorld.elements[10];

    // the camera jumped (menu → run, respawn): re-seed around it
    if ((cx - lastCam.x) ** 2 + (cz - lastCam.z) ** 2 > 60 * 60) { scatter(cx, cz); birds.reset(); }
    lastCam.set(cx, 0, cz);

    // population: recycle far walkers, top up out of sight
    let active = 0;
    for (const w of walkers) {
      if (w.mode === OFF) continue;
      const dc2 = (w.x - cx) ** 2 + (w.z - cz) ** 2;
      // out of view: recycle beyond BUBBLE_OUT, or sooner once well behind the camera (the pool is
      // better spent ahead, where the player looks)
      const far = dc2 > BUBBLE_OUT * BUBBLE_OUT || (dc2 > 30 * 30 && (w.x - cx) * camFx + (w.z - cz) * camFz < 0);
      if (w.bug === NONE && (dc2 > BUBBLE_HARD * BUBBLE_HARD || (far && !visibleAt(w.x, w.y + 0.9, w.z, 1)))) { deactivate(w); continue; }
      active++;
    }
    spawnT -= dt;
    if (active < Q.walkers && spawnT <= 0) { spawnOne(cx, cz, false); spawnT = 0.15; }

    // neighbours (O(n²), n ≤ 40)
    nbrN.fill(0);
    for (let i = 0; i < walkers.length; i++) {
      const a = walkers[i];
      if (a.mode === OFF) continue;
      for (let j = i + 1; j < walkers.length; j++) {
        const b = walkers[j];
        if (b.mode === OFF) continue;
        const d2 = (a.x - b.x) ** 2 + (a.z - b.z) ** 2;
        if (d2 > 16) continue;
        if (nbrN[i] < NB) nbr[i * NB + nbrN[i]++] = j;
        if (nbrN[j] < NB) nbr[j * NB + nbrN[j]++] = i;
      }
    }

    // litterbug scheduler
    let bugs = 0;
    for (const w of walkers) if (w.bug !== NONE) bugs++;
    if (playing) {
      bugTimer -= dt;
      const maxBugs = difficulty < 2 ? 2 : 3;
      if (bugTimer <= 0 && bugs < maxBugs) {
        // readable and reachable: in view, ~8–18 m from Labib, near the middle of the screen
        let pick: Walker | null = null, best = 1e9;
        const fx = -camera.matrixWorld.elements[8], fz = -camera.matrixWorld.elements[10];
        for (const w of walkers) {
          if (w.mode !== WALK || w.bug !== NONE || w.bugCd > 0 || !w.inView || edges[w.edge].crossing >= 0) continue;
          const d = Math.sqrt((w.x - px) ** 2 + (w.z - pz) ** 2);
          if (d < 6 || d > 26) continue;
          const dc = Math.hypot(w.x - cx, w.z - cz) || 1;
          const centred = ((w.x - cx) * fx + (w.z - cz) * fz) / dc; // 1 = straight ahead
          const score = Math.abs(d - 12) / 6 + (1 - centred) * 3 + rand() * 0.8;
          if (score < best) { best = score; pick = w; }
        }
        if (pick && startLitterbug(pick)) bugTimer = Math.max(2.5, 8.5 - 1.3 * difficulty) * (0.75 + rand() * 0.5);
        else bugTimer = 0.5;
      }
    }

    // walkers
    crossingBusy.fill(0);
    let ai = 0;
    for (let wi = 0; wi < walkers.length; wi++) {
      const w = walkers[wi];
      if (w.mode === OFF) continue;
      avoid[ai * 2] = w.x; avoid[ai * 2 + 1] = w.z; ai++;
      const dCam2 = (w.x - cx) ** 2 + (w.z - cz) ** 2;
      w.inView = visibleAt(w.x, w.y + 0.9, w.z, 1);
      w.acc += dt;
      if (dCam2 > FAR * FAR && w.bug === NONE && ++w.tick % 3 !== 0) continue;
      const wdt = w.acc;
      w.acc = 0;
      stepWalker(w, wi, wdt, playing, cx, cz);
      // on a crossing = walking its edge and standing in its rect (not waiting at the curb nearby)
      const ce = w.mode === OFF ? -1 : edges[w.edge].crossing;
      if (ce >= 0 && w.mode !== WAIT && crossingAt(w.x, w.z, 0.3) === ce && crossingBusy[ce] < 255) crossingBusy[ce]++;
    }

    // capsules near Labib
    for (let wi = 0; wi < walkers.length; wi++) {
      const w = walkers[wi];
      const d2 = w.mode === OFF ? 1e9 : (w.x - px) ** 2 + (w.z - pz) ** 2;
      if (w.body >= 0 && d2 > BODY_OUT * BODY_OUT) releaseBody(w);
      if (w.body < 0 && d2 < BODY_IN * BODY_IN) {
        const k = bodies.findIndex((b) => b.owner < 0);
        if (k >= 0) {
          bodies[k].owner = wi;
          w.body = k;
          bodies[k].body.setTranslation({ x: w.x, y: w.y + CAPSULE_HALF + CAPSULE_R, z: w.z }, true);
        }
      }
      if (w.body >= 0) bodies[w.body].body.setNextKinematicTranslation({ x: w.x, y: w.y + CAPSULE_HALF + CAPSULE_R, z: w.z });
    }

    // patrons: every second, move one whose terrace fell far behind to a terrace near the camera
    patronT -= dt;
    if (patronT <= 0) {
      patronT = 1;
      for (const pt of patrons) {
        if (pt.chair >= 0 && ((pt.x - cx) ** 2 + (pt.z - cz) ** 2 < 85 * 85 || visibleAt(pt.x, 1, pt.z, 1))) continue;
        const ci = freeChair(cx, cz, true);
        if (ci >= 0 && (pt.chair < 0 || terraceD2(chairs[ci].terrace, cx, cz) < terraceD2(chairs[pt.chair].terrace, cx, cz))) {
          seat(pt, ci);
          break;
        }
      }
    }
    for (const pt of patrons) {
      if (pt.chair < 0) continue;
      const d2 = (pt.x - cx) ** 2 + (pt.z - cz) ** 2;
      const show = d2 < PATRON_HIDE * PATRON_HIDE;
      if (show !== pt.shown) { pt.shown = show; pt.p.setVisible(show); }
      if (!show) continue;
      pt.startleCd -= dt;
      if (sprinting && pt.startleCd <= 0 && (pt.x - px) ** 2 + (pt.z - pz) ** 2 < STARTLE_DIST * STARTLE_DIST) {
        pt.p.setAnim('startled');
        pt.startleCd = 4;
      }
      pt.acc += dt;
      if (d2 > 30 * 30 && ++pt.tick % 3 !== 0) continue;
      pt.p.update(pt.acc, 0);
      pt.acc = 0;
    }

    // birds: Labib is the threat
    threat.x = px; threat.y = py; threat.z = pz; threat.speed = Math.hypot(pvx, pvz);
    birds.update(dt, camera, threat, avoid, ai);
  }

  function stepWalker(w: Walker, wi: number, dt: number, playing: boolean, cx: number, cz: number): void {
    w.startleCd -= dt;
    w.bugCd -= dt;
    w.talkCd -= dt;
    w.modeT += dt;
    const dLab2 = (w.x - px) ** 2 + (w.z - pz) ** 2;

    // --- litterbug timeline ---
    if (w.bug !== NONE) {
      w.bugT += dt;
      if (!playing && w.bug !== THROW && w.bug !== PICK) endLitterbug(w, 10);
      else if (w.bug === WARN && w.bugT >= WARN_SEC) {
        w.bug = THROW; w.bugT = 0; w.mode = BUSY; w.released = false;
        w.p.setAnim('throw');
      } else if (w.bug === THROW) {
        if (!w.released && w.bugT >= THROW_RELEASE_SEC) {
          w.released = true;
          if (playing) {
            handWorldPosition(w.p, hand);
            const fx = Math.sin(w.yaw), fz = Math.cos(w.yaw);
            vel.set(fx * 2.5 - fz * 0.7, 1.7, fz * 2.5 + fx * 0.7);
            w.litterId = hooks.throwLitter(hand, vel);
            // landing estimate (arcade gravity 1.6 g) for the pick-up direction
            const g = 9.81 * 1.6, tFall = (vel.y + Math.sqrt(vel.y * vel.y + 2 * g * Math.max(0.3, hand.y - w.y))) / g;
            w.landX = hand.x + vel.x * tFall; w.landZ = hand.z + vel.z * tFall;
            w.bugT = 0;
            w.bug = CATCH;
          } else endLitterbug(w, 10);
        }
      } else if (w.bug === CATCH) {
        if (w.mode === BUSY && w.bugT >= THROW_SEC - THROW_RELEASE_SEC) { w.mode = WALK; setLoop(w, 'walk'); w.planT = 0; }
        if (dLab2 < TOUCH_DIST * TOUCH_DIST && Math.abs(py - w.y) < 1.2) {
          hooks.caught(tmp.set(w.x, w.y, w.z), w.litterId);
          freeIcon(w);
          w.bug = GOPICK; w.bugT = 0; w.mode = BUSY;
          setLoop(w, 'walk');
        } else if (w.bugT >= RULES.caughtWindow) endLitterbug(w, 20);
      } else if (w.bug === GOPICK) {
        // walk to where the litter landed (stops short if it is off the walkable area), then kneel
        const d = Math.hypot(w.landX - w.x, w.landZ - w.z);
        if (d < 0.45 || w.bugT > 3 || (w.bugT > 0.6 && w.speed < 0.15)) {
          w.bug = PICK; w.bugT = 0;
          if (d > 0.1) w.yaw = Math.atan2(w.landX - w.x, w.landZ - w.z);
          setLoop(w, 'idle');
          w.p.setAnim('pickUp');
        }
      } else if (w.bug === PICK && w.bugT >= PICKUP_SEC) endLitterbug(w, 30);
    }

    // --- reactions ---
    if (sprinting && w.startleCd <= 0 && w.bug !== THROW && w.bug !== PICK && dLab2 < STARTLE_DIST * STARTLE_DIST) {
      w.p.setAnim('startled');
      w.startleCd = 3;
      // sidestep perpendicular to Labib's run, to whichever side we are on
      const vl = Math.hypot(pvx, pvz) || 1;
      let sx = -pvz / vl, sz = pvx / vl;
      if ((w.x - px) * sx + (w.z - pz) * sz < 0) { sx = -sx; sz = -sz; }
      w.sx = sx * 1.9; w.sz = sz * 1.9;
    }

    let vx = 0, vz = 0;
    if (w.mode === LINGER) {
      const d2 = (w.x - cx) ** 2 + (w.z - cz) ** 2;
      if (!w.inView || d2 > 35 * 35 || w.modeT > 6) { deactivate(w); return; }
    } else if (w.mode === WAIT) {
      const E = edges[w.pendingEdge];
      if (!crossingNear[E.crossing] && w.modeT > 0.4) takeEdge(w, w.pendingEdge, w.to);
      else if (w.modeT > 25) { w.mode = WALK; arrive(w, cx, cz); } // give up: go another way
      else { const o = E.a === w.to ? E.b : E.a; w.yaw += wrapPi(Math.atan2(nx[o] - nx[w.to], nz[o] - nz[w.to]) - w.yaw) * Math.min(1, dt * 4); }
    } else if (w.mode === BUSY) {
      if (w.loop === 'cheer' && w.modeT > 2.6) { w.mode = WALK; setLoop(w, 'walk'); }
      else if (w.loop === 'talk' && w.modeT > w.talkT) { w.mode = WALK; setLoop(w, 'walk'); w.planT = 0; }
      else if (w.bug === GOPICK) {
        const dx = w.landX - w.x, dz = w.landZ - w.z, d = Math.hypot(dx, dz) || 1;
        vx = (dx / d) * 1.5; vz = (dz / d) * 1.5;
        w.yaw += wrapPi(Math.atan2(dx, dz) - w.yaw) * Math.min(1, dt * 8);
      }
    }
    if (w.mode === WALK) {
      const E = edges[w.edge];
      const ax = nx[w.from], az = nz[w.from];
      const ux = (nx[w.to] - ax) / E.len, uz = (nz[w.to] - az) / E.len;
      const s = (w.x - ax) * ux + (w.z - az) * uz;
      if (s >= E.len - 0.3) { arrive(w, cx, cz); }
      else {
        w.planT -= dt;
        if (w.planT <= 0) { w.planT = 0.22 + rand() * 0.1; w.lat = planLateral(w, E, ax, az, ux, uz, s, wi); }
        const q = Math.min(s + 1.6, E.len + 0.4);
        let dx = ax + ux * q - uz * w.lat - w.x, dz = az + uz * q + ux * w.lat - w.z;
        const dl = Math.hypot(dx, dz) || 1;
        let sp = w.cruise * (E.crossing >= 0 ? 1.2 : 1) * (w.bug === WARN ? 0.55 : w.bug === CATCH ? 1.15 : 1);
        // follow someone slower right ahead instead of pushing through
        for (let j = 0; j < nbrN[wi]; j++) {
          const o = walkers[nbr[wi * NB + j]];
          const ox = o.x - w.x, oz = o.z - w.z;
          const ahead = (ox * dx + oz * dz) / dl;
          if (ahead > 0 && ahead < 1.2 && Math.abs((ox * dz - oz * dx) / dl) < 0.55) sp = Math.min(sp, Math.max(0.2, o.speed));
          // two people meeting head-on sometimes stop for a chat
          if (w.talkCd <= 0 && o.talkCd <= 0 && o.mode === WALK && w.bug === NONE && o.bug === NONE && E.crossing < 0 &&
              ox * ox + oz * oz < 1.6 * 1.6 && Math.sin(o.yaw) * ux + Math.cos(o.yaw) * uz < -0.6 && ahead > 0) {
            w.talkCd = o.talkCd = 25 + rand() * 20;
            if (rand() < TALK_P && (w.x - px) ** 2 + (w.z - pz) ** 2 > 16) {
              w.talkT = o.talkT = 3 + rand() * 4;
              w.mode = o.mode = BUSY; w.modeT = o.modeT = 0; w.speed = o.speed = 0;
              setLoop(w, 'talk'); setLoop(o, 'talk');
              w.yaw = Math.atan2(o.x - w.x, o.z - w.z); o.yaw = Math.atan2(w.x - o.x, w.z - o.z);
            }
          }
        }
        vx = (dx / dl) * sp; vz = (dz / dl) * sp;
      }
    }
    // separation from people and from Labib (applies standing too, so nobody overlaps)
    for (let j = 0; j < nbrN[wi]; j++) {
      const o = walkers[nbr[wi * NB + j]];
      const ox = w.x - o.x, oz = w.z - o.z, d2 = ox * ox + oz * oz;
      if (d2 < 0.8 * 0.8 && d2 > 1e-6) { const d = Math.sqrt(d2), k = ((0.8 - d) / d) * 2.2; vx += ox * k; vz += oz * k; }
    }
    if (dLab2 < 1.5 * 1.5 && dLab2 > 1e-6 && w.bug !== PICK) {
      const d = Math.sqrt(dLab2), k = ((1.5 - d) / d) * 2.5;
      vx += (w.x - px) * k; vz += (w.z - pz) * k;
    }
    vx += w.sx; vz += w.sz;
    const decay = Math.exp(-3.5 * dt);
    w.sx *= decay; w.sz *= decay;
    const vl = Math.hypot(vx, vz);
    if (vl > 2.4) { vx *= 2.4 / vl; vz *= 2.4 / vl; }

    // integrate against the clearance grid (never into an obstacle / onto a lane)
    let nx2 = w.x + vx * dt, nz2 = w.z + vz * dt;
    const c0 = grid.clearance(w.x, w.z);
    const ok = (x: number, z: number) => { const c = grid.clearance(x, z); return c >= 0.27 || c > c0 + 1e-4; };
    if (!ok(nx2, nz2)) {
      if (ok(nx2, w.z)) nz2 = w.z;
      else if (ok(w.x, nz2)) nx2 = w.x;
      else { nx2 = w.x; nz2 = w.z; }
    }
    const moved = Math.hypot(nx2 - w.x, nz2 - w.z);
    w.x = nx2; w.z = nz2;
    const actual = dt > 0 ? moved / dt : 0;
    w.speed += (actual - w.speed) * Math.min(1, dt * 8);
    // stuck: replan to the other side, then turn around
    if (w.mode === WALK && actual < 0.25) {
      w.stuckT += dt;
      if (w.stuckT > 2) { w.pref = -w.pref; w.planT = 0; }
      if (w.stuckT > 5) { const f = w.from; w.from = w.to; w.to = f; w.stuckT = 0; }
    } else w.stuckT = Math.max(0, w.stuckT - dt);
    if (vl > 0.15 && w.mode === WALK) {
      const ty = Math.atan2(vx, vz);
      w.yaw += wrapPi(ty - w.yaw) * Math.min(1, dt * 6);
    }
    const gy = onRoad(w.x, w.z) ? 0 : CURB;
    w.y += (gy - w.y) * Math.min(1, dt * 14);
    const r = w.p.root;
    r.position.set(w.x, w.y, w.z);
    r.rotation.y = w.yaw;
    if (w.grow < 1) { w.grow = Math.min(1, w.grow + dt * 1.6); r.scale.setScalar(0.05 + 0.95 * w.grow * w.grow * (3 - 2 * w.grow)); }
    w.p.update(dt, w.mode === WALK ? w.speed : 0);

    // marker
    if (w.icon >= 0) {
      const t = w.bugT;
      if (w.bug === WARN || w.bug === THROW) icons.show(w.icon, w.x, w.y + w.p.height + 0.42 + Math.sin(t * 7) * 0.04, w.z, camera, 0, 1, 0.5 + 0.5 * Math.sin(t * 14));
      else if (w.bug === CATCH) {
        const left = 1 - t / RULES.caughtWindow;
        icons.show(w.icon, w.x, w.y + w.p.height + 0.42 + Math.sin(t * 5) * 0.05, w.z, camera, 1, Math.max(0, left), left < 0.3 ? 0.5 + 0.5 * Math.sin(t * 22) : 0);
      }
    }
  }

  // initial population around wherever the camera is
  scatter(camera.position.x, camera.position.z);

  const crowd = {
    update(dt: number, _time: number): void { if (!disposed) update(dt); },
    setDifficulty(level: number): void { difficulty = Math.max(0, level); },
    cheer(position: Vector3, radius: number): void {
      for (const w of walkers) {
        if (w.mode === OFF || w.bug !== NONE || w.mode === LINGER) continue;
        if ((w.x - position.x) ** 2 + (w.z - position.z) ** 2 > radius * radius) continue;
        if (w.mode === WAIT) w.pendingEdge = -1;
        w.mode = BUSY; w.modeT = rand() * 0.6;
        w.yaw = Math.atan2(position.x - w.x, position.z - w.z);
        setLoop(w, 'cheer');
      }
    },
    reset(): void {
      for (const w of walkers) { freeIcon(w); w.bug = NONE; }
      difficulty = 0;
      bugTimer = 4;
      const pl = hooks.player();
      scatter(pl.position.x, pl.position.z);
      lastCam.copy(camera.position);
      birds.reset();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const w of walkers) { releaseBody(w); w.p.dispose(); }
      for (const pt of patrons) pt.p.dispose();
      for (const b of bodies) physics.world.removeRigidBody(b.body);
      bodies.length = 0;
      icons.dispose();
      birds.dispose();
      root.removeFromParent();
      crossingBusy.fill(0);
    },
    debug: {
      grid,
      walkers: () => walkers.filter((w) => w.mode !== OFF).map((w) => ({ x: w.x, z: w.z, mode: w.mode, bug: w.bug, clearance: grid.clearance(w.x, w.z), visible: w.inView })),
      patrons: patrons.length,
      bodies: () => bodies.filter((b) => b.owner >= 0).length,
      birds,
      forceLitterbug(x: number, z: number): boolean {
        let best: Walker | null = null, bd = 1e9;
        for (const w of walkers) {
          if (w.mode !== WALK || w.bug !== NONE) continue;
          const d = (w.x - x) ** 2 + (w.z - z) ** 2;
          if (d < bd) { bd = d; best = w; }
        }
        return !!best && startLitterbug(best);
      },
      graph: { nodes: nx.length, edges: edges.length },
    } satisfies CrowdDebug,
  };
  return crowd;
}
