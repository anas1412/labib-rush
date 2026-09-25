// Théâtre Municipal (1902, Art Nouveau), north side of the avenue, facing +Z. White stucco front:
// a curved crest between two corner turrets with bulbous caps, three arched doors under the
// French name, a balustraded balcony, a three-arched loggia, a sculpted group of rearing horses and
// allegories, the Arabic name under the crest; plainer side wings, auditorium and fly tower behind.
import { CatmullRomCurve3, QuadraticBezierCurve3, Shape, TubeGeometry, Vector3, Path, type BufferGeometry, type Material, type Matrix4 } from 'three';
import { CURB, LANDMARKS } from '../../core/layout';
import { Bucket, T, archOutline, balustrade, box, cyl, extrude, lathe, mergeAll, molding, PROFILES, type Opening } from './kit';
import { archRing, archWindow, column, facadeWall, fillOpenings, frame, sill } from './facade';
import { createFlag, flagPole } from './flag';
import { fitFont, type Env, type Landmark } from './env';

const F = LANDMARKS.theatre;
const X0 = (F.xMin + F.xMax) / 2;
const ZF = F.zMax - 4.6;
const Y0 = CURB;
const NSTEPS = 7, STEP = 0.15, TREAD = 0.6;
const YF = NSTEPS * STEP;
const CW = 7.8; // half-width of the curved central wall (between the turrets)

export function buildTheatre(env: Env, relief: BufferGeometry): Landmark {
  const m = env.mats;
  const b = new Bucket();
  const white = m.plasterWhite, orn = m.ornament;
  const add = (mat: Material, g: BufferGeometry, M: Matrix4) => b.add(mat, g.applyMatrix4(M));
  const C = T(X0, Y0, ZF);
  const at = (x: number, y: number, z: number, ry = 0) => T(x, y, z, ry).premultiply(C);

  // ---------------------------------------------------------------------------------------------
  // Central wall with a curved crest, doors and loggia arches cut through.
  const doors: Opening[] = [-5.0, 0, 5.0].map((u) => ({ cx: u, y0: YF, w: 2.9, spring: YF + 3.05 }));
  const loggia: Opening[] = [-4.7, 0, 4.7].map((u) => ({ cx: u, y0: 7.45, w: 3.3, spring: 11.4 }));
  const crest = (u: number) => 17.6 + 2.6 * (1 - (u / CW) ** 2);
  const wallShape = new Shape();
  wallShape.moveTo(-CW, 0); wallShape.lineTo(CW, 0); wallShape.lineTo(CW, crest(CW));
  wallShape.quadraticCurveTo(0, crest(0) * 2 - crest(CW), -CW, crest(-CW));
  wallShape.closePath();
  for (const o of [...doors, ...loggia]) wallShape.holes.push(new Path(archOutline(o.cx, o.y0, o.w, o.spring, 'round').reverse()));
  add(white, extrude(wallShape, 0.7, 24), at(0, 0, -0.7));
  // curved cornice + garland following the crest
  const crestCurve = new QuadraticBezierCurve3(new Vector3(-CW - 0.3, crest(CW), 0.25), new Vector3(0, crest(0) * 2 - crest(CW), 0.25), new Vector3(CW + 0.3, crest(CW), 0.25));
  add(orn, new TubeGeometry(crestCurve, 48, 0.32, 10, false), C);
  add(orn, new TubeGeometry(offsetCurve(crestCurve, -0.55, 0.12), 48, 0.16, 8, false), C);
  b.addDetail(orn, garland(offsetCurve(crestCurve, -1.05, 0.15), 0.2, 60), C);

  // doors: recessed cream leaves with raised panels, moulded surrounds, keystones
  for (const o of doors) {
    frame(b, orn, C, o, 0.32, 0.16);
    fillOpenings(b, m.doorCream, C, [o], 0.45);
    for (const s of [-1, 1]) {
      add(m.doorCream, box(o.w / 2 - 0.35, 2.2, 0.08), at(o.cx + s * o.w / 4, YF + 0.5, -0.42));
      // brass pull handle: a vertical bar on two stand-offs beside the meeting stiles
      add(m.gold, cyl(0.018, 0.018, 0.55, 8), at(o.cx + s * 0.13, YF + 0.85, -0.3));
      for (const y of [0.9, 1.35]) add(m.gold, cyl(0.012, 0.012, 0.13, 6).rotateX(Math.PI / 2).translate(0, 0, -0.13), at(o.cx + s * 0.13, YF + y, -0.3)); // back to the leaf
    }
    add(orn, box(0.5, 0.62, 0.28), at(o.cx, o.spring + o.w / 2 - 0.3, 0.05));
  }
  // playbills between the doors
  const playbills: [string, string, string, 'oud' | 'masks'][] = [
    ['MALOUF', 'المالوف', 'VEN. 12 · 20H30', 'oud'],
    ['LA SAISON', 'الموسم المسرحي', 'SAM. 13 · 19H00', 'masks'],
  ];
  playbills.forEach(([title, ar, date, emblem], k) => {
    const poster = env.signs.draw(200, 300, (c, _p, W, H) => paintPlaybill(c, W, H, title, ar, date, emblem, k));
    add(env.signs.material, env.signs.plane(poster, 0.8, 1.2), at(k ? 2.5 : -2.5, YF + 1.2, 0.03));
  });
  // French name on the frieze over the doors
  const nameFr = env.signs.draw(1200, 96, (c, p, W, H) => {
    c.fillStyle = '#b8964f'; fitFont(c, 'THÉÂTRE  MUNICIPAL', W * 0.94, 700, H * 0.78); c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText('THÉÂTRE  MUNICIPAL', W / 2, H * 0.56);
    p.fillStyle = 'rgb(0,90,230)'; p.fillRect(0, 0, W, H);
  });
  add(orn, molding(PROFILES.string(1.0), 2 * CW), at(0, 5.95, 0));
  add(env.signs.material, env.signs.plane(nameFr, 8.6, 0.68), at(0, 6.26, 0.03));

  // balcony on consoles
  add(orn, box(16.4, 0.28, 1.4), at(0, 7.05, 0.7));
  add(orn, balustrade(16.2, 1.0, 0.24), at(0, 7.33, 1.2));
  for (const u of [-7.4, -5.9, 5.9, 7.4]) add(orn, scrollConsole(0.95, 1.1, 0.34), at(u, 7.05 - 0.95, 0));

  // loggia: deep arches on engaged columns, arched windows at the back
  for (const o of loggia) {
    archRing(b, orn, C, o, 0.34, 0.2);
    add(orn, box(0.6, 0.9, 0.3), at(o.cx, o.spring + o.w / 2 - 0.35, 0.05));
    const win: Opening = { cx: o.cx, y0: 7.9, w: 2.5, spring: 10.9 };
    archWindow(b, orn, m.glass, T(0, 0, -2.2).premultiply(C), win, { band: 0.12, out: 0.08, inset: 0.05 });
    add(orn, box(0.08, 3.6, 0.1), at(o.cx, 7.9, -2.1));
    add(orn, box(2.5, 0.08, 0.1), at(o.cx, 10.0, -2.1));
  }
  add(white, box(2 * CW, 5.8, 0.3), at(0, 7.35, -2.45));
  add(white, box(2 * CW, 0.3, 2.3), at(0, 7.35, -1.3));
  add(white, box(2 * CW, 0.4, 2.3), at(0, 12.9, -1.3));
  for (const u of [-7.0, -2.35, 2.35, 7.0]) {
    add(orn, column(4.1, 0.24, 14), at(u, 7.45, 0.18));
    add(orn, lathe([[0.45, 0], [0.62, 0.3], [0.5, 0.55], [0, 0.6]], 12), at(u, 11.5, 0.18)); // capital scroll
  }

  // sculpted group over the loggia, cartouches and Arabic name under the crest
  b.addDetail(orn, relief.clone(), at(0, 13.25, 0.35));
  add(orn, box(10.6, 0.3, 0.9), at(0, 13.1, 0.2));
  const nameAr = env.signs.draw(800, 136, (c, p, W, H) => {
    c.fillStyle = '#6f6552'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.direction = 'rtl'; fitFont(c, 'المسرح البلدي', W * 0.92, 800, H * 0.72);
    c.fillText('المسرح البلدي', W / 2, H * 0.52);
    p.fillStyle = 'rgb(0,160,0)'; p.fillRect(0, 0, W, H);
  });
  add(env.signs.material, env.signs.plane(nameAr, 5.6, 0.95), at(0, 17.35, 0.04));
  for (const s of [-1, 1]) b.addDetail(orn, garland(new CatmullRomCurve3([new Vector3(s * 7.5, 17.9, 0.2), new Vector3(s * 6.6, 15.2, 0.3), new Vector3(s * 7.3, 12.0, 0.25), new Vector3(s * 7.4, 8.6, 0.2)]), 0.18, 40), C);

  // ---------------------------------------------------------------------------------------------
  // Corner turrets with bulbous caps
  for (const s of [-1, 1]) {
    const tx = s * (CW + 1.6);
    add(white, box(3.2, 19.2, 3.6), at(tx, 0, -1.2));
    add(orn, box(3.5, YF + 0.9, 3.9), at(tx, 0, -1.2));
    const tw: Opening = { cx: tx, y0: 9.2, w: 0.95, spring: 12.2 };
    archWindow(b, orn, m.glass, T(0, 0, 0.6).premultiply(C), tw, { band: 0.2, out: 0.1, inset: 0.3 });
    add(orn, box(1.9, 0.22, 0.9), at(tx, 8.95, 0.9));
    add(orn, balustrade(1.8, 0.9, 0.22), at(tx, 9.15, 1.2));
    add(orn, molding(PROFILES.cornice(1.0), 3.6), at(tx, 18.8, 0.6));
    b.addDetail(orn, garland(new CatmullRomCurve3([new Vector3(tx, 17.8, 0.7), new Vector3(tx + 0.3, 16.2, 0.72), new Vector3(tx, 14.5, 0.7), new Vector3(tx - 0.2, 13.2, 0.7)]), 0.14, 24), C);
    add(orn, cyl(1.45, 1.5, 1.0, 24), at(tx, 19.25, -1.2));
    add(orn, lathe([[1.7, 0], [1.75, 0.2], [1.6, 0.8], [1.3, 1.4], [0.8, 1.9], [0.35, 2.1], [0.2, 2.45], [0.28, 2.6], [0, 2.8]], 24), at(tx, 20.25, -1.2));
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      add(orn, garland(new CatmullRomCurve3([new Vector3(Math.sin(a) * 1.76, 0.3, Math.cos(a) * 1.76), new Vector3(Math.sin(a) * 1.45, 1.3, Math.cos(a) * 1.45), new Vector3(Math.sin(a) * 0.7, 2.0, Math.cos(a) * 0.7)]), 0.07, 12), at(tx, 20.25, -1.2));
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Side wings (set back), auditorium and fly tower.
  for (const s of [-1, 1]) {
    const wx = s * 14.2, WW = 5.6;
    const M = at(wx, 0, -1.4);
    const wins: Opening[] = [];
    for (const y of [2.2, 6.6, 10.8]) for (const u of [-1.3, 1.3]) wins.push({ cx: u, y0: y, w: 1.2, spring: y + 2.4, kind: y > 10 ? 'round' : 'flat' });
    facadeWall(b, white, M, WW, 16.2, 0.5, wins);
    for (const o of wins) { frame(b, orn, M, o, 0.16, 0.08); fillOpenings(b, m.glass, M, [o], 0.3); sill(b, orn, M, o, 0.16); }
    add(orn, box(WW, 0.2, 1.0), T(0, 6.3, 0.5).premultiply(M));
    add(m.iron, railing(WW - 0.2, 0.95), T(0, 6.5, 0.95).premultiply(M));
    add(orn, molding(PROFILES.cornice(1.0), WW + 0.8), T(0, 15.8, 0).premultiply(M));
    add(orn, balustrade(WW, 0.9, 0.26), T(0, 16.2, 0.1).premultiply(M));
    add(orn, box(WW + 0.3, 0.9, 0.3), T(0, 0, 0.1).premultiply(M));
  }
  add(white, box(34, 17.8, F.zMax - 4.6 - 3 - F.zMin), T(X0, Y0, (ZF - 3 + F.zMin) / 2));
  // auditorium flanks: pilaster strips, a string course and blind arched windows
  for (const s of [-1, 1]) {
    const len = ZF - 3 - F.zMin, M = T(X0 + s * 17, Y0, (ZF - 3 + F.zMin) / 2, s * Math.PI / 2);
    for (let i = 0; i <= 5; i++) add(orn, box(0.7, 17.4, 0.25), T(-len / 2 + (len * i) / 5, 0, 0).premultiply(M));
    add(orn, molding(PROFILES.string(1.2), len), T(0, 6.5, 0).premultiply(M));
    for (let i = 0; i < 5; i++) {
      const o: Opening = { cx: -len / 2 + (len * (i + 0.5)) / 5, y0: 9.5, w: 1.8, spring: 13.2 };
      frame(b, orn, M, o, 0.2, 0.1);
      fillOpenings(b, m.glass, M, [o], -0.02);
    }
  }
  add(orn, box(34.6, 0.5, F.zMax - 4.6 - 3 - F.zMin + 0.6), T(X0, Y0 + 17.8, (ZF - 3 + F.zMin) / 2));
  add(white, box(20, 24.5, 10), T(X0, Y0, F.zMin + 5.5));
  add(orn, box(20.5, 0.5, 10.5), T(X0, Y0 + 24.5, F.zMin + 5.5));
  add(m.iron, flagPole(5.0), T(X0, Y0 + 17.8, ZF - 4));

  // ---------------------------------------------------------------------------------------------
  // Steps and lamp columns
  for (let i = 0; i < NSTEPS; i++) {
    const d = (NSTEPS - i) * TREAD;
    add(m.stoneLight, box(2 * CW + 6.6 - i * 0.1, STEP, d + 0.6), T(X0, Y0 + i * STEP, ZF + d / 2 - 0.3));
  }
  for (const s of [-1, 1]) {
    const lx = X0 + s * (CW + 4.4), lz = ZF + 2.6;
    add(m.stoneLight, box(1.7, 1.2, 1.7), T(lx, Y0, lz));
    add(orn, lathe([[0.55, 0], [0.62, 0.2], [0.45, 0.4], [0.4, 2.4], [0.5, 2.6], [0.62, 2.8], [0.5, 3.0], [0, 3.0]], 16), T(lx, Y0 + 1.2, lz));
    add(m.iron, lathe([[0.12, 0], [0.09, 0.2], [0.06, 1.8], [0.1, 2.0], [0, 2.0]], 10), T(lx, Y0 + 4.2, lz));
    for (const [dx, dz] of [[0.45, 0], [-0.45, 0], [0, 0.45], [0, -0.45], [0, 0]]) {
      add(m.iron, lathe([[0.05, 0], [0.2, 0.08], [0.24, 0.1], [0, 0.12]], 10).rotateX(Math.PI), T(lx + dx, Y0 + 6.72 + (dx || dz ? 0 : 0.3), lz + dz));
      add(m.glass, lathe([[0.1, 0], [0.19, 0.12], [0.2, 0.36], [0.14, 0.48], [0, 0.5]], 10), T(lx + dx, Y0 + 6.1 + (dx || dz ? 0 : 0.3), lz + dz));
    }
    add(m.iron, box(1.0, 0.04, 0.04), T(lx, Y0 + 6.05, lz));
    add(m.iron, box(0.04, 0.04, 1.0), T(lx, Y0 + 6.05, lz));
  }

  env.ground(b, F.xMin, F.xMax, F.zMin, F.zMax);
  const root = b.build('theatre');
  const flag = createFlag('tn', 2.4, 1.6, 5.0, env.ctx.uniforms);
  flag.root.position.set(X0, Y0 + 17.8, ZF - 4);
  root.add(flag.root);

  // Colliders
  for (let i = 0; i < NSTEPS; i++) {
    const d = (NSTEPS - i) * TREAD;
    env.aabb(X0 - CW - 3.3, Y0 + i * STEP, ZF - 0.6, X0 + CW + 3.3, Y0 + (i + 1) * STEP, ZF + d);
  }
  env.aabb(X0 - 17, Y0, F.zMin, X0 + 17, Y0 + 18, ZF - 1.9); // main body
  env.aabb(X0 - CW, Y0, ZF - 3.2, X0 + CW, Y0 + 20, ZF + 0.2); // central front (door frames project 0.16)
  for (const s of [-1, 1]) {
    env.aabb(X0 + s * CW, Y0, ZF - 3.2, X0 + s * (CW + 3.35), Y0 + 20, ZF + 0.75); // turret + its base
    env.aabb(X0 + s * (CW + 3.35), Y0, ZF - 1.9, X0 + s * 17, Y0 + 17, ZF - 1.15); // side-wing front and plinth
  }
  for (const s of [-1, 1]) env.aabb(X0 + s * (CW + 4.4) - 0.85, Y0, ZF + 1.75, X0 + s * (CW + 4.4) + 0.85, Y0 + 4.2, ZF + 3.45);
  return { root, update: (dt) => flag.update(dt), dispose: () => flag.dispose() };
}

// ---------------------------------------------------------------------------------------------

/** Wrought-iron balcony railing along X: rails, bars and a scroll band, base centred. */
function railing(len: number, h: number): BufferGeometry {
  const parts: BufferGeometry[] = [box(len, 0.05, 0.05).translate(0, h - 0.05, 0), box(len, 0.04, 0.04).translate(0, 0.05, 0), box(len, 0.03, 0.03).translate(0, h * 0.72, 0)];
  for (let x = -len / 2 + 0.06; x <= len / 2; x += 0.12) parts.push(box(0.018, h, 0.018).translate(x, 0, 0));
  for (let x = -len / 2 + 0.25; x < len / 2 - 0.2; x += 0.5) parts.push(arcTubeXY(0.1, 0.012).translate(x, h * 0.84, 0));
  return mergeAll(parts);
}

function arcTubeXY(r: number, t: number): BufferGeometry {
  return new TubeGeometry(new CatmullRomCurve3(Array.from({ length: 13 }, (_, i) => new Vector3(Math.cos((i / 12) * Math.PI * 2) * r, Math.sin((i / 12) * Math.PI * 2) * r, 0)), true), 12, t, 4, true);
}

/** Curve offset in its (XY) plane: y shifted by dy and pulled out by dz (approximation for the
 *  gentle crest curve). */
function offsetCurve(c: QuadraticBezierCurve3, dy: number, dz: number): QuadraticBezierCurve3 {
  const o = new Vector3(0, dy, dz);
  return new QuadraticBezierCurve3(c.v0.clone().add(o), c.v1.clone().add(o), c.v2.clone().add(o));
}

/** Stucco garland: a tube whose radius swells into leaf/flower clusters along the path. */
function garland(curve: CatmullRomCurve3 | QuadraticBezierCurve3, r: number, clusters: number): BufferGeometry {
  const segs = clusters * 3, radial = 6;
  const g = new TubeGeometry(curve, segs, r, radial, false);
  const p = g.attributes.position, n = g.attributes.normal;
  for (let i = 0; i <= segs; i++) {
    const k = 0.7 + 0.45 * Math.abs(Math.sin((i / 3) * Math.PI));
    const c = curve.getPointAt(i / segs);
    for (let j = 0; j <= radial; j++) {
      const idx = i * (radial + 1) + j;
      const jitter = 1 + 0.08 * Math.sin(j * 2.3 + i * 1.7);
      p.setXYZ(idx, c.x + n.getX(idx) * r * k * jitter, c.y + n.getY(idx) * r * k * jitter, c.z + n.getZ(idx) * r * k * jitter);
    }
  }
  g.computeVertexNormals();
  return g;
}

/** Balcony console: an S-scroll profile (top arm under the slab, curving down to a volute at the
 *  wall) extruded `w` wide, with scroll eyes at both ends. Base on the origin, wall at z = 0. */
function scrollConsole(h: number, out: number, w: number): BufferGeometry {
  const sh = new Shape();
  sh.moveTo(0, 0); sh.lineTo(0, h); sh.lineTo(out, h); sh.lineTo(out, h - 0.12);
  sh.bezierCurveTo(out * 0.72, h - 0.14, out * 0.52, h * 0.72, out * 0.42, h * 0.45);
  sh.bezierCurveTo(out * 0.32, h * 0.18, out * 0.2, h * 0.06, 0.12, 0.02);
  sh.closePath();
  const g = extrude(sh, w, 16);
  // shape x = out → local +z, extrusion → x (same mapping as `molding`)
  g.rotateY(-Math.PI / 2).translate(w / 2, 0, 0);
  const eye = (r: number) => cyl(r, r, w + 0.04, 16).rotateZ(Math.PI / 2).translate(w / 2 + 0.02, 0, 0);
  return mergeAll([g, eye(0.1).translate(-w / 2 - 0.02, h - 0.1, out - 0.08), eye(0.075).translate(-w / 2 - 0.02, 0.1, 0.12)]);
}

/** Theatre playbill: coloured field, framed; title (Latin + Arabic), a simple emblem, the date. */
function paintPlaybill(c: CanvasRenderingContext2D, W: number, H: number, title: string, ar: string, date: string, emblem: 'oud' | 'masks', k: number): void {
  c.fillStyle = k ? '#1d3557' : '#9e1b22'; c.fillRect(0, 0, W, H);
  c.strokeStyle = '#e8d49a'; c.lineWidth = 6; c.strokeRect(8, 8, W - 16, H - 16);
  c.fillStyle = '#f3e6c4'; c.textAlign = 'center'; c.textBaseline = 'middle';
  fitFont(c, title, W * 0.8, 800, H * 0.1); c.fillText(title, W / 2, H * 0.14);
  c.direction = 'rtl'; fitFont(c, ar, W * 0.8, 700, H * 0.075); c.fillText(ar, W / 2, H * 0.25); c.direction = 'ltr';
  c.fillStyle = '#e8c97a'; c.strokeStyle = '#e8c97a'; c.lineWidth = 3;
  const cx = W / 2, cy = H * 0.56;
  if (emblem === 'oud') {
    c.beginPath(); c.ellipse(cx, cy + H * 0.06, W * 0.2, H * 0.12, 0, 0, Math.PI * 2); c.fill(); // bowl
    c.fillRect(cx - 5, cy - H * 0.22, 10, H * 0.2); // neck
    c.save(); c.translate(cx, cy - H * 0.22); c.rotate(-0.9); c.fillRect(-4, -H * 0.06, 8, H * 0.06); c.restore(); // pegbox
    c.fillStyle = c.strokeStyle = k ? '#1d3557' : '#9e1b22';
    c.beginPath(); c.arc(cx, cy + H * 0.02, W * 0.05, 0, Math.PI * 2); c.stroke(); // rosette
  } else {
    for (const [dx, rot, smile] of [[-W * 0.12, -0.25, 1], [W * 0.12, 0.25, -1]] as const) {
      c.save(); c.translate(cx + dx, cy); c.rotate(rot);
      c.fillStyle = '#e8c97a'; c.beginPath(); c.ellipse(0, 0, W * 0.14, H * 0.12, 0, 0, Math.PI * 2); c.fill();
      c.fillStyle = k ? '#1d3557' : '#9e1b22';
      for (const ex of [-W * 0.055, W * 0.055]) { c.beginPath(); c.ellipse(ex, -H * 0.03, W * 0.03, H * 0.018, 0, 0, Math.PI * 2); c.fill(); }
      c.lineWidth = 5; c.strokeStyle = c.fillStyle as string;
      c.beginPath(); c.arc(0, H * 0.05 - smile * H * 0.02, W * 0.06, smile > 0 ? 0.2 : Math.PI + 0.2, smile > 0 ? Math.PI - 0.2 : -0.2); c.stroke();
      c.restore();
    }
  }
  c.fillStyle = '#f3e6c4'; fitFont(c, date, W * 0.8, 700, H * 0.065); c.fillText(date, W / 2, H * 0.84);
  fitFont(c, 'THÉÂTRE MUNICIPAL DE TUNIS', W * 0.8, 600, H * 0.04); c.fillText('THÉÂTRE MUNICIPAL DE TUNIS', W / 2, H * 0.92);
}
