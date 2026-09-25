// French Embassy (south side of Place de l'Indépendance, facing the cathedral, −Z): a two-storey
// 19th-century classical palazzo (rusticated ground floor, pedimented centre, balustraded attic,
// hipped tile roof) set in a garden behind a stone-and-blue-iron railing with an ornate gilded
// gate; security barriers, razor wire and a guard booth outside; French tricolour on the roof.
import { BufferGeometry, CatmullRomCurve3, Shape, TubeGeometry, Vector3, type Material, type Matrix4 } from 'three';
import { CURB, LANDMARKS } from '../../core/layout';
import { G } from '../../core/physics';
import { Bucket, T, arcTube, balustrade, box, cyl, extrude, flat, hipRoof, lathe, mergeAll, molding, PROFILES, type Opening } from './kit';
import { archWindow, facadeWall, fillOpenings, frame, sill } from './facade';
import { createFlag, flagPole } from './flag';
import type { Env, Landmark } from './env';
import { palmCrown } from './plants';

const F = LANDMARKS.embassy;
const X0 = (F.xMin + F.xMax) / 2;
const ZFENCE = F.zMin + 2.2;
const ZB = F.zMin + 11; // building front
const BW = 36, BD = 18; // building footprint
const Y0 = CURB;

export function buildEmbassy(env: Env): Landmark {
  const m = env.mats;
  const b = new Bucket();
  const add = (mat: Material, g: BufferGeometry, M: Matrix4) => b.add(mat, g.applyMatrix4(M));

  // ---------------------------------------------------------------------------------------------
  // Building (faces −Z: local +z → world −Z, local x → world −X)
  const FM = T(X0, Y0, ZB, Math.PI);
  const bays = 9, bay = BW / bays;
  const gf: Opening[] = [], ff: Opening[] = [];
  for (let i = 0; i < bays; i++) {
    const u = -BW / 2 + bay * (i + 0.5);
    gf.push(i === 4 ? { cx: u, y0: 0.6, w: 2.1, spring: 3.4 } : { cx: u, y0: 1.2, w: 1.45, spring: 3.7 });
    ff.push({ cx: u, y0: 6.2, w: 1.4, spring: 9.0, kind: 'flat' });
  }
  add(m.stoneWarm, box(BW + 0.4, 0.6, BD + 0.4), T(X0, Y0, ZB + BD / 2));
  facadeWall(b, m.stoneWarm, FM, BW, 5.4, 0.5, gf.map((o) => ({ ...o, y0: o.y0 - 0.6, spring: o.spring - 0.6 })), -BW / 2, 0.6);
  // rustication grooves on the ground floor, broken where a window/door (with its frame) cuts in
  for (let y = 1.15; y < 5.4; y += 0.62) {
    const cuts = gf.filter((o) => y > o.y0 - 0.2 && y < o.spring + o.w / 2 + 0.25).map((o) => [o.cx - o.w / 2 - 0.24, o.cx + o.w / 2 + 0.24]);
    let x = -BW / 2;
    for (const [c0, c1] of [...cuts, [BW / 2, BW / 2]]) {
      if (c0 - x > 0.05) add(m.dark, box(c0 - x, 0.035, 0.02), T((x + c0) / 2, y, 0.005).premultiply(FM));
      x = c1;
    }
  }
  for (const o of gf) {
    archWindow(b, m.stoneLight, o.w > 2 ? m.wood : m.glass, FM, o, { band: 0.2, out: 0.1, inset: 0.35 });
    add(m.stoneLight, box(0.5, 0.75, 0.2), T(o.cx, o.spring + o.w / 2 - 0.35, 0.05).premultiply(FM)); // keystone
  }
  add(m.stoneLight, molding(PROFILES.string(1.2), BW + 0.3), T(0, 5.35, 0).premultiply(FM));
  facadeWall(b, m.plasterSand, FM, BW, 5.3, 0.5, ff.map((o) => ({ ...o, y0: o.y0 - 5.6, spring: o.spring - 5.6 })), -BW / 2, 5.6);
  for (const o of ff) {
    frame(b, m.stoneLight, FM, o, 0.2, 0.1);
    fillOpenings(b, m.glass, FM, [o], 0.3);
    add(m.stoneLight, molding(PROFILES.sill(1.4), o.w + 0.9), T(o.cx, 9.25, 0).premultiply(FM)); // hood
    add(m.stoneLight, box(o.w + 0.7, 0.12, 0.3), T(o.cx, 9.62, 0.1).premultiply(FM));
    sill(b, m.stoneLight, FM, o, 0.2);
  }
  // central avant-corps: quoins, balcony, pediment
  for (const s of [-1, 1]) {
    for (let y = 0.6; y < 10.4; y += 0.7) add(m.stoneLight, box(0.9, 0.62, 0.3), T(s * 5.9, y, 0.02).premultiply(FM));
    for (const e of [-1, 1]) for (let y = 0.6; y < 10.4; y += 0.7) add(m.stoneLight, box(0.8, 0.62, 0.3), T(e * (BW / 2 - 0.4), y, 0.02).premultiply(FM));
  }
  add(m.stoneLight, box(11.2, 0.25, 1.1), T(0, 5.75, 0.5).premultiply(FM));
  add(m.stoneLight, balustrade(11.2, 0.95, 0.26), T(0, 6.0, 0.9).premultiply(FM));
  for (let i = -2; i <= 2; i++) add(m.stoneLight, box(0.3, 0.5, 1.0), T(i * 2.6, 5.25, 0.5).premultiply(FM)); // consoles
  add(m.stoneLight, molding(PROFILES.cornice(1.3), BW + 1.2), T(0, 10.3, 0).premultiply(FM));
  add(m.stoneLight, balustrade(BW, 1.0, 0.3), T(0, 10.85, 0.3).premultiply(FM));
  const ped = new Shape(); ped.moveTo(-6.2, 0); ped.lineTo(6.2, 0); ped.lineTo(0, 2.6); ped.closePath();
  add(m.stoneLight, extrude(ped, 0.8), T(0, 10.85, -0.5).premultiply(FM));
  const slope = Math.atan2(2.6, 6.2), rl = Math.hypot(2.6, 6.2) + 0.4;
  for (const s of [-1, 1]) add(m.stoneLight, molding(PROFILES.cornice(0.6), rl).rotateZ(-s * slope), T(s * 3.1, 12.05, 0.3).premultiply(FM));
  add(m.plasterSand, lathe([[0.9, 0], [0, 0]], 20).rotateX(Math.PI / 2), T(0, 11.9, 0.32).premultiply(FM)); // oculus
  add(m.stoneLight, arcTube(0.95, 0.09, 0, Math.PI * 2, 24, 6), T(0, 11.9, 0.32).premultiply(FM));
  // side and back walls (plain), hipped roof
  for (const s of [-1, 1]) {
    const SM = T(X0 + s * BW / 2, Y0, ZB + BD / 2, s * Math.PI / 2);
    const side: Opening[] = [-5, 0, 5].map((u) => ({ cx: u, y0: 6.2, w: 1.4, spring: 9.0, kind: 'flat' as const }));
    facadeWall(b, m.plasterSand, SM, BD, 10.4, 0.5, side, -BD / 2, 0);
    for (const o of side) { frame(b, m.stoneLight, SM, o, 0.2, 0.1); fillOpenings(b, m.glass, SM, [o], 0.3); }
    add(m.stoneLight, molding(PROFILES.cornice(1.3), BD + 1.2), T(0, 10.3, 0).premultiply(SM));
  }
  add(m.plasterSand, box(BW, 10.4, 0.5), T(X0, Y0, ZB + BD - 0.25));
  add(m.plasterSand, box(BW - 1, 0.4, BD - 1), T(X0, Y0 + 10.4, ZB + BD / 2));
  add(m.roof, hipRoof(BW - 1.4, BD - 1.4, 4.2), T(X0, Y0 + 10.8, ZB + BD / 2));
  // chimneys at the ridge ends (roof surface ≈ Y0+14.8 there), pole on the front slope (≈ Y0+14.24)
  for (const s of [-1, 1]) {
    add(m.plasterSand, box(0.8, 2.0, 0.8), T(X0 + s * 9, Y0 + 14.4, ZB + BD / 2));
    add(m.stoneLight, box(1.0, 0.14, 1.0), T(X0 + s * 9, Y0 + 16.4, ZB + BD / 2));
  }
  add(m.iron, flagPole(5.5), T(X0, Y0 + 14.25, ZB + BD / 2 - 1.5));

  // ---------------------------------------------------------------------------------------------
  // Garden: lawns, drive, hedges, palms.
  const gz0 = ZFENCE + 0.4, gz1 = ZB - 0.6;
  add(m.stoneWarm, box(6.5, 0.06, gz1 - gz0), T(X0, Y0, (gz0 + gz1) / 2));
  for (const s of [-1, 1]) {
    add(m.grass, box(20, 0.08, gz1 - gz0 - 1.8), T(X0 + s * 13.8, Y0, (gz0 + gz1) / 2 + 0.6));
    add(m.hedge, box(19.5, 1.3, 1.1), T(X0 + s * 13.8, Y0, gz0 + 0.7));
  }
  b.setOptions(m.grass, { castShadow: false });
  b.setOptions(m.galvanised, { castShadow: false }); // thin barriers + razor wire: shadow cost, no gain
  for (const [px, pz, h, lean] of [[-286, 37.5, 10.5, 0.1], [-259, 36.8, 9.2, -0.08], [-279, 39.5, 12, 0.05]] as const) {
    palm(b, env, px, Y0, pz, h, lean);
  }

  // ---------------------------------------------------------------------------------------------
  // Railing on a stone plinth, pillars, ornate gate.
  const x0 = F.xMin, x1 = F.xMax, gate0 = X0 - 3.1, gate1 = X0 + 3.1;
  for (const [a, c] of [[x0, gate0 - 0.55], [gate1 + 0.55, x1]]) {
    const len = c - a, mid = (a + c) / 2;
    add(m.stoneLight, box(len, 0.75, 0.55), T(mid, Y0, ZFENCE));
    add(m.stoneLight, molding(PROFILES.sill(1.2), len), T(mid, Y0 + 0.75, ZFENCE - 0.27, Math.PI));
    const n = Math.max(1, Math.round(len / 5.4));
    for (let i = 0; i <= n; i++) {
      const px = a + (len * i) / n;
      add(m.stoneLight, box(0.75, 3.0, 0.75), T(px, Y0, ZFENCE));
      add(m.stoneLight, box(0.95, 0.2, 0.95), T(px, Y0 + 3.0, ZFENCE));
      add(m.stoneLight, flat(lathe([[0.35, 0], [0, 0.45]], 4, Math.PI / 4)), T(px, Y0 + 3.2, ZFENCE));
    }
    // bars + rails
    const bars: BufferGeometry[] = [];
    for (let x = a + 0.45; x < c - 0.4; x += 0.15) {
      bars.push(box(0.028, 2.1, 0.028).translate(x - mid, 0, 0));
      bars.push(lathe([[0.03, 0], [0.045, 0.02], [0, 0.16]], 4).translate(x - mid, 2.1, 0));
    }
    bars.push(box(len - 0.6, 0.05, 0.05).translate(0, 0.1, 0), box(len - 0.6, 0.05, 0.05).translate(0, 1.85, 0));
    add(m.blueIron, mergeAll(bars), T(mid, Y0 + 0.75, ZFENCE));
  }
  for (const s of [-1, 1]) {
    const px = X0 + s * 3.65;
    add(m.stoneLight, box(1.1, 4.2, 1.1), T(px, Y0, ZFENCE));
    add(m.stoneLight, molding(PROFILES.cornice(0.5), 1.3), T(px, Y0 + 3.95, ZFENCE - 0.55, Math.PI));
    add(m.stoneLight, box(1.3, 0.25, 1.3), T(px, Y0 + 4.2, ZFENCE));
    add(m.stoneLight, lathe([[0.3, 0], [0.34, 0.12], [0.18, 0.2], [0.42, 0.55], [0.45, 0.8], [0.3, 0.95], [0.1, 1.05], [0.12, 1.2], [0, 1.25]], 14), T(px, Y0 + 4.45, ZFENCE)); // urn
  }
  gateLeaves(b, m.blueIron, m.gold, X0, Y0, ZFENCE);
  // side walls to the neighbours
  for (const x of [x0 + 0.25, x1 - 0.25]) add(m.plasterSand, box(0.5, 3.2, ZB - ZFENCE), T(x, Y0, (ZB + ZFENCE) / 2));

  // ---------------------------------------------------------------------------------------------
  // Security outside the railing: crowd barriers, razor wire, guard booth.
  const zBar = F.zMin + 0.6;
  const barrier = vauban();
  for (let x = x0 + 1.5; x < x1 - 1.4; x += 2.05) {
    if (x > X0 + 4.4 && x < X0 + 8.6) continue; // opening beside the booth
    b.add(m.galvanised, barrier.clone(), T(x, Y0, zBar));
  }
  barrier.dispose();
  if (env.ctx.quality !== 'low') for (const [a, c] of [[x0 + 2, gate0 - 1.2], [gate1 + 3.4, x1 - 2]]) add(m.galvanised, razorWire(c - a), T((a + c) / 2, Y0, ZFENCE - 0.75));
  const bx = X0 + 6.3, bz = F.zMin + 1.25;
  add(m.plasterWhite, box(1.7, 1.0, 1.7), T(bx, Y0, bz));
  add(m.glass, box(1.62, 1.05, 1.62), T(bx, Y0 + 1.0, bz));
  for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) add(m.plasterWhite, box(0.12, 1.05, 0.12), T(bx + dx * 0.79, Y0 + 1.0, bz + dz * 0.79));
  add(m.plasterWhite, box(1.7, 0.45, 1.7), T(bx, Y0 + 2.05, bz));
  add(m.stoneLight, box(2.1, 0.14, 2.1), T(bx, Y0 + 2.5, bz));

  env.ground(b, F.xMin, F.xMax, F.zMin, F.zMax);
  const root = b.build('embassy');
  const flag = createFlag('fr', 2.7, 1.8, 5.5, env.ctx.uniforms);
  flag.root.position.set(X0, Y0 + 14.25, ZB + BD / 2 - 1.5);
  root.add(flag.root);

  // Colliders
  env.aabb(x0, Y0, ZFENCE - 0.4, x1, Y0 + 8, ZFENCE + 0.4); // taller than the railing: can't be hopped from the booth
  env.aabb(X0 - BW / 2, Y0, ZB, X0 + BW / 2, Y0 + 11, ZB + BD);
  for (const x of [x0 + 0.25, x1 - 0.25]) env.aabb(x - 0.25, Y0, ZFENCE, x + 0.25, Y0 + 3.2, ZB);
  env.aabb(bx - 0.9, Y0, bz - 0.9, bx + 0.9, Y0 + 2.6, bz + 0.9);
  env.aabb(x0 + 0.5, Y0, zBar - 0.25, X0 + 4.4, Y0 + 1.1, zBar + 0.25, G.LOW_PROP);
  env.aabb(X0 + 8.6, Y0, zBar - 0.25, x1 - 0.4, Y0 + 1.1, zBar + 0.25, G.LOW_PROP);
  return {
    root,
    update: (dt) => flag.update(dt),
    dispose: () => flag.dispose(),
  };
}

// ---------------------------------------------------------------------------------------------

/** Two gate leaves: framed bars, a gilded medallion band and an arched crest with finials. */
function gateLeaves(b: Bucket, iron: Material, gold: Material, x: number, y: number, z: number): void {
  const W = 6.1, H = 3.6;
  const it: BufferGeometry[] = [], gd: BufferGeometry[] = [];
  for (const s of [-1, 1]) {
    const cx = (s * W) / 4;
    it.push(box(W / 2 - 0.06, 0.1, 0.08).translate(cx, 0.1, 0), box(W / 2 - 0.06, 0.1, 0.08).translate(cx, H - 0.1, 0));
    it.push(box(0.1, H, 0.08).translate(cx - s * (W / 4 - 0.08), 0, 0), box(0.1, H, 0.08).translate(cx + s * (W / 4 - 0.08), 0, 0));
    for (let u = -W / 4 + 0.2; u < W / 4 - 0.15; u += 0.13) it.push(box(0.03, H - 0.2, 0.03).translate(cx + u, 0.1, 0));
    it.push(box(W / 2 - 0.1, 0.08, 0.08).translate(cx, 1.25, 0), box(W / 2 - 0.1, 0.08, 0.08).translate(cx, 2.2, 0));
    for (let k = -1; k <= 1; k++) {
      gd.push(arcTube(0.32, 0.04, 0, Math.PI * 2, 20, 5).translate(cx + k * 0.85, 1.72, 0.04));
      gd.push(lathe([[0.12, 0], [0, 0.06]], 10).rotateX(Math.PI / 2).translate(cx + k * 0.85, 1.72, 0.04));
    }
    gd.push(box(W / 2 - 0.3, 0.05, 0.1).translate(cx, 2.5, 0));
  }
  // crest over both leaves
  it.push(arcTube(W / 2, 0.06, 0.25, Math.PI - 0.25, 30, 5).scale(1, 0.28, 1).translate(0, H - 0.2, 0));
  for (let u = -W / 2 + 0.3; u < W / 2 - 0.2; u += 0.26) {
    const top = H - 0.2 + Math.sqrt(Math.max(0, 1 - (u / (W / 2)) ** 2)) * (W / 2) * 0.28;
    it.push(box(0.03, top - H + 0.25, 0.03).translate(u, H - 0.1, 0));
    gd.push(lathe([[0.035, 0], [0.06, 0.03], [0, 0.18]], 6).translate(u, top + 0.02, 0));
  }
  gd.push(lathe([[0.25, 0], [0.26, 0.1], [0.12, 0.3], [0.2, 0.5], [0, 0.72]], 12).translate(0, H + 0.62, 0));
  b.add(iron, mergeAll(it), T(x, y, z));
  b.add(gold, mergeAll(gd), T(x, y, z));
}

/** Galvanised "Vauban" crowd barrier, 2 m long, base centred on the origin. */
function vauban(): BufferGeometry {
  const p: BufferGeometry[] = [];
  p.push(cyl(0.025, 0.025, 2.0, 6).rotateZ(Math.PI / 2).translate(1.0, 1.05, 0));
  p.push(cyl(0.025, 0.025, 2.0, 6).rotateZ(Math.PI / 2).translate(1.0, 0.2, 0));
  for (const s of [-1, 1]) p.push(cyl(0.025, 0.025, 1.0, 6).translate(s * 0.98, 0.15, 0));
  for (let x = -0.85; x <= 0.86; x += 0.125) p.push(cyl(0.01, 0.01, 0.85, 4).translate(x, 0.2, 0));
  for (const s of [-1, 1]) p.push(box(0.05, 0.03, 0.62).translate(s * 0.8, 0, 0), box(0.05, 0.2, 0.03).translate(s * 0.8, 0.02, 0));
  return mergeAll(p);
}

/** Coil of concertina razor wire along X, centred, length `len`. */
function razorWire(len: number): BufferGeometry {
  const pts: Vector3[] = [];
  const turns = Math.round(len * 3.2), per = 14;
  for (let i = 0; i <= turns * per; i++) {
    const t = i / per, a = t * Math.PI * 2;
    pts.push(new Vector3(-len / 2 + (t / turns) * len, 0.42 + Math.sin(a) * 0.4, Math.cos(a) * 0.4));
  }
  return new TubeGeometry(new CatmullRomCurve3(pts), turns * per, 0.009, 3, false);
}

/** Date palm: a ringed (old leaf bases), tapering, slightly leaning trunk and a crown of arching
 *  pinnate fronds (alpha-tested cards). */
function palm(b: Bucket, env: Env, x: number, y: number, z: number, h: number, lean: number): void {
  const trunk: [number, number][] = [];
  const rings = Math.round(h / 0.24);
  for (let i = 0; i <= rings; i++) {
    const t = i / rings, r = 0.3 - 0.09 * t;
    trunk.push([r * 1.08, t * h], [r * 0.9, t * h + 0.1]); // sawtooth: each ring overhangs the next
  }
  trunk.push([0.12, h + 0.35], [0, h + 0.45]);
  const tg = lathe(trunk, 12);
  const p = tg.attributes.position;
  for (let i = 0; i < p.count; i++) p.setX(i, p.getX(i) + lean * (p.getY(i) ** 2) / h); // lean: shear x with height
  tg.computeVertexNormals();
  b.add(env.mats.bark, tg, T(x, y, z));
  const top = new Vector3(x + lean * h, y + h + 0.1, z);
  b.add(env.signs.material, palmCrown(env.plants.frond, 18, 3.9, 1.7), T(top.x, top.y, top.z));
}
