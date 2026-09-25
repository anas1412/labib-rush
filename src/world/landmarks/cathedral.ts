// Cathedral of St Vincent de Paul (1897), north side of Place de l'Indépendance, facing the avenue
// (+Z). Neo-Romanesque/Byzantine: twin square bell towers (white stone quoins, ochre rendered
// panels, twin louvred belfry openings, corner pinnacles, egg-shaped white domes with Lorraine
// crosses) flanking a central front with a triple-arched porch, a blind arcade gallery, a gold
// mosaic band and a great arch framing the rose window, under a gable. Nave, aisles, transept,
// crossing dome and apse behind. Steps down to the plaza.
import { Shape, Path, type Material, type Matrix4, type BufferGeometry } from 'three';
import { CURB, LANDMARKS } from '../../core/layout';
import { Bucket, T, arcTube, archOutline, archivolt, box, cyl, extrude, flat, lathe, molding, PROFILES, type Opening } from './kit';
import { archRing, archWindow, blindArcade, column, facadeWall, fillOpenings, frame, ring } from './facade';
import type { Env, Landmark } from './env';

const F = LANDMARKS.cathedral;
const X0 = (F.xMin + F.xMax) / 2;
const ZF = F.zMax - 5.4; // facade plane (steps occupy the 5.4 m in front, inside the footprint)
const Y0 = CURB;
const STEP = 0.15, NSTEPS = 8, TREAD = 0.62;
const YF = NSTEPS * STEP; // porch floor above the plaza

const TW = 8.8; // tower width/depth
const TX = 7.2 + TW / 2; // tower centre offset from the axis
const H1 = 24.5; // top of the tower shaft
const H2 = 32.6; // top of the belfry stage

export function buildCathedral(env: Env, angel: BufferGeometry): Landmark {
  const m = env.mats;
  const b = new Bucket();
  const stone = m.stoneLight, ochre = m.plasterOchre, glass = m.glass, dark = m.dark;
  const statues = env.ctx.quality !== 'low'; // facade angels (~9k triangles each)

  /** Frame for a vertical face centred at world (x, z), facing yaw `ry` (0 = +Z), base at y. */
  const face = (x: number, z: number, ry: number, y = Y0): Matrix4 => T(x, y, z, ry);
  const add = (mat: Material, g: BufferGeometry, M: Matrix4) => b.add(mat, g.applyMatrix4(M));

  /** Mouldings wrapped round a w×d rectangle centred at (x, z) at height y. */
  const wrap = (mat: Material, x: number, z: number, w: number, d: number, y: number, prof: [number, number][]) => {
    const out = Math.max(...prof.map((p) => p[0]));
    add(mat, molding(prof, w + 2 * out), face(x, z + d / 2, 0, y));
    add(mat, molding(prof, w + 2 * out), face(x, z - d / 2, Math.PI, y));
    add(mat, molding(prof, d), face(x + w / 2, z, Math.PI / 2, y));
    add(mat, molding(prof, d), face(x - w / 2, z, -Math.PI / 2, y));
  };

  // ---------------------------------------------------------------------------------------------
  // Towers
  for (const s of [-1, 1]) {
    const cx = X0 + s * TX, cz = ZF - TW / 2;
    add(stone, box(TW + 0.36, 1.3, TW + 0.36), face(cx, cz, 0));
    wrap(stone, cx, cz, TW + 0.36, TW + 0.36, 1.3, PROFILES.string(0.8));

    // Shaft walls (0.5 thick): front and outer side carry three arched windows; the rest is blind.
    const wins: Opening[] = [3.4, 9.8, 16.2].map((y) => ({ cx: 0, y0: y, w: 1.25, spring: y + 2.45 }));
    const faces: [number, number, number, boolean][] = [
      [cx, ZF, 0, true], // front
      [cx + s * TW / 2, cz, s * Math.PI / 2, true], // outer side
      [cx - s * TW / 2, cz, -s * Math.PI / 2, false], // inner side (hidden by the centre block)
      [cx, ZF - TW, Math.PI, false], // back
    ];
    for (const [fx, fz, ry, open] of faces) {
      const M = face(fx, fz, ry);
      facadeWall(b, ochre, M, TW, H1 - 1.3, 0.5, open ? wins.map((o) => ({ ...o, y0: o.y0 - 1.3, spring: o.spring - 1.3 })) : [], -TW / 2, 1.3);
      if (open) for (const o of wins) archWindow(b, stone, glass, M, o, { band: 0.26, out: 0.14, inset: 0.42 });
      // arcaded corbel frieze under the cornice
      blindArcade(b, stone, ochre, M, TW - 2.6, 1.5, 0.42, H1 - 1.9, 0.14);
    }
    // corner quoin piers
    for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      add(stone, box(1.55, H1 - 1.3, 1.55), face(cx + dx * (TW / 2 - 0.6), cz + dz * (TW / 2 - 0.6), 0, Y0 + 1.3));
    }
    for (const y of [8.1, 14.5, 20.9]) wrap(stone, cx, cz, TW + 0.2, TW + 0.2, y, PROFILES.string(1.0));
    wrap(stone, cx, cz, TW + 0.2, TW + 0.2, H1 - 0.3, PROFILES.cornice(1.25));
    add(stone, box(TW + 0.9, 0.3, TW + 0.9), face(cx, cz, 0, Y0 + H1 + 0.2));

    // Belfry stage: 7.6 m square, twin louvred openings on every face, corner pilasters.
    const BW = 7.6, by = H1 + 0.5, bh = H2 - by;
    const bells: Opening[] = [-1.2, 1.2].map((u) => ({ cx: u, y0: 1.3, w: 1.15, spring: 4.9 }));
    for (let k = 0; k < 4; k++) {
      const ry = (k * Math.PI) / 2;
      const fx = cx + Math.sin(ry) * BW / 2, fz = cz + Math.cos(ry) * BW / 2;
      const M = face(fx, fz, ry, Y0 + by);
      facadeWall(b, ochre, M, BW, bh, 0.45, bells);
      fillOpenings(b, dark, M, bells, 0.4);
      for (const o of bells) {
        archRing(b, stone, M, o, 0.18, 0.16);
        // louvre slats
        for (let y = o.y0 + 0.25; y < o.spring + 0.3; y += 0.34) add(m.wood, box(o.w, 0.05, 0.28).rotateX(-0.5), T(o.cx, y, -0.22).premultiply(M));
      }
      for (const u of [-1.86, -0.54, 0.54, 1.86]) add(stone, column(3.6, 0.13, 10), T(u, 1.3, 0.1).premultiply(M));
      add(stone, archivolt(2.25, 0.22, 0.2, 24), T(0, 4.9, 0).premultiply(M));
      add(stone, box(4.9, 0.14, 0.26), T(0, 1.16, 0.08).premultiply(M));
    }
    for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) add(stone, box(1.0, bh, 1.0), face(cx + dx * (BW / 2 - 0.38), cz + dz * (BW / 2 - 0.38), 0, Y0 + by));
    wrap(stone, cx, cz, BW + 0.1, BW + 0.1, H2 - 0.55, PROFILES.cornice(1.05));
    // corbels under the belfry cornice
    for (let k = 0; k < 4; k++) {
      const ry = (k * Math.PI) / 2;
      const M = face(cx + Math.sin(ry) * (BW / 2 + 0.05), cz + Math.cos(ry) * (BW / 2 + 0.05), ry, Y0 + H2 - 0.95);
      for (let u = -3.2; u <= 3.21; u += 0.58) add(stone, box(0.2, 0.4, 0.22), T(u, 0, 0.08).premultiply(M));
    }

    // Crown: platform, four corner pinnacles, arcaded drum, egg dome, lantern, Lorraine cross.
    const ty = Y0 + H2;
    add(stone, box(BW + 0.7, 0.35, BW + 0.7), face(cx, cz, 0, ty));
    add(stone, box(BW - 0.4, 1.0, BW - 0.4), face(cx, cz, 0, ty + 0.35));
    for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const px = cx + dx * (BW / 2 - 0.55), pz = cz + dz * (BW / 2 - 0.55);
      add(stone, flat(lathe([[0.62, 0], [0.62, 0.3], [0.52, 0.36], [0.52, 1.9], [0.62, 2.0], [0.62, 2.2], [0, 2.2]], 8, Math.PI / 8)), face(px, pz, 0, ty + 0.35));
      add(stone, lathe([[0.6, 0], [0.62, 0.12], [0.5, 0.45], [0.3, 0.75], [0.08, 0.95], [0.05, 1.25], [0, 1.3]], 12), face(px, pz, 0, ty + 2.55));
    }
    const dy = ty + 1.35;
    add(stone, cyl(2.75, 2.8, 2.5, 32), face(cx, cz, 0, dy));
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const M = T(cx + Math.sin(a) * 2.78, dy, cz + Math.cos(a) * 2.78, a);
      add(dark, extrude(new Shape(archOutline(0, 0.35, 0.62, 1.74, 'round')), 0.02), M);
      add(stone, column(1.95, 0.07, 8), T(0.42, 0.25, 0.05).premultiply(M));
    }
    add(stone, lathe([[3.05, 0], [3.12, 0.14], [3.05, 0.3], [2.95, 0.3]], 32), face(cx, cz, 0, dy + 2.45));
    // egg-shaped dome with horizontal bands (limestone courses)
    const dome: [number, number][] = [];
    for (let i = 0; i <= 18; i++) {
      const t = (i / 18) * (Math.PI / 2);
      dome.push([3.0 * Math.pow(Math.cos(t), 0.72) * (1 + 0.06 * Math.sin(t * 2)), 5.6 * Math.pow(Math.sin(t), 1.1)]);
    }
    add(stone, lathe(dome, 40), face(cx, cz, 0, dy + 2.7));
    for (const t of [0.28, 0.5, 0.68]) {
      const a = t * (Math.PI / 2) * 1.2;
      const r = 3.0 * Math.pow(Math.cos(a), 0.72) * (1 + 0.06 * Math.sin(a * 2)) + 0.03, y = 5.6 * Math.pow(Math.sin(a), 1.1);
      add(stone, arcTube(r, 0.06, 0, Math.PI * 2, 48, 5).rotateX(Math.PI / 2), face(cx, cz, 0, dy + 2.7 + y));
    }
    add(stone, lathe([[0.42, 0], [0.42, 0.55], [0.55, 0.65], [0.3, 0.8], [0.2, 1.1], [0, 1.15]], 12), face(cx, cz, 0, dy + 8.2));
    lorraineCross(b, m.iron, cx, dy + 9.3, cz, 2.1);
  }

  // ---------------------------------------------------------------------------------------------
  // Central front
  const C = face(X0, ZF, 0);
  // piers flanking the great arch
  for (const s of [-1, 1]) {
    add(stone, box(1.5, 21.5, 1.2), face(X0 + s * 6.45, ZF - 0.25, 0));
    for (const y of [8.4, 13.6]) add(stone, molding(PROFILES.string(1.0), 1.5), face(X0 + s * 6.45, ZF + 0.35, 0, Y0 + y));
    // corbel, angel statue and canopy
    add(stone, box(1.1, 0.5, 0.7), face(X0 + s * 6.45, ZF + 0.65, 0, Y0 + 14.2));
    if (statues) b.addDetail(stone, angel.clone().applyMatrix4(T(X0 + s * 6.45, Y0 + 14.7, ZF + 0.7, -s * 0.25)));
    add(stone, flat(lathe([[0.7, 0], [0.7, 0.15], [0, 0.9]], 4, Math.PI / 4)), T(X0 + s * 6.45, Y0 + 17.8, ZF + 0.6, 0, 0, 0, [1.1, 1, 0.6]));
    // angels on corbels at the towers' outer front corners
    const ax = X0 + s * (TX + TW / 2 - 0.2);
    add(stone, box(1.2, 0.45, 1.0), face(ax, ZF + 0.35, 0, Y0 + 13.3));
    if (statues) b.addDetail(stone, angel.clone().applyMatrix4(T(ax, Y0 + 13.75, ZF + 0.45, -s * 0.5)));
  }

  // Porch: three round arches on paired columns, iron gates, doors in the recess.
  const arches: Opening[] = [-3.5, 0, 3.5].map((u) => ({ cx: u, y0: YF, w: 2.9, spring: YF + 5.1 }));
  facadeWall(b, stone, C, 11.4, 8.4, 0.9, arches);
  for (const o of arches) {
    archRing(b, stone, C, o, 0.34, 0.22);
    gate(b, m.iron, C, o);
  }
  for (const u of [-5.35, -1.75, 1.75, 5.35]) {
    for (const du of u === -5.35 ? [0.18] : u === 5.35 ? [-0.18] : [-0.2, 0.2]) {
      add(stone, column(5.1, 0.17, 12), T(u + du, YF, 0.28).premultiply(C));
    }
  }
  add(stone, box(11.4, 0.3, 3.6), T(0, YF - 0.3, -1.8).premultiply(C)); // porch floor
  add(stone, box(11.4, 0.35, 3.3), T(0, 8.05, -2.1).premultiply(C)); // porch ceiling
  const doors: Opening[] = arches.map((o) => ({ ...o, w: 2.1, spring: YF + 3.9 }));
  const back = T(0, 0, -3.3).premultiply(C);
  facadeWall(b, ochre, back, 11.4, 8.4, 0.4, doors);
  fillOpenings(b, m.wood, back, doors, 0.25);
  for (const o of doors) frame(b, stone, back, o, 0.22, 0.1);
  for (const s of [-1, 1]) add(ochre, box(0.4, 8.4, 3.3), T(s * 5.5, 0, -1.65).premultiply(C));

  // Lozenge band, blind arcade gallery, gold mosaic band.
  const loz = env.signs.draw(1024, 96, (c, p, W, H) => {
    c.fillStyle = '#9b4a32'; c.fillRect(0, 0, W, H);
    const n = 28, dw = W / n;
    for (let i = 0; i < n; i++) {
      c.fillStyle = i % 2 ? '#e9dcc0' : '#2f4a6b';
      c.beginPath(); c.moveTo(i * dw + dw / 2, 8); c.lineTo(i * dw + dw - 4, H / 2); c.lineTo(i * dw + dw / 2, H - 8); c.lineTo(i * dw + 4, H / 2); c.closePath(); c.fill();
      c.fillStyle = '#d8b25a'; c.beginPath(); c.arc(i * dw + dw / 2, H / 2, 5, 0, Math.PI * 2); c.fill();
    }
    c.strokeStyle = '#e9dcc0'; c.lineWidth = 6; c.strokeRect(0, 3, W, H - 6);
    p.fillStyle = 'rgb(0,150,0)'; p.fillRect(0, 0, W, H);
  });
  add(env.signs.material, env.signs.plane(loz, 11.4, 0.95), T(0, 8.42, 0.02).premultiply(C));
  add(stone, molding(PROFILES.sill(1.2), 11.4), T(0, 9.35, 0).premultiply(C));
  blindArcade(b, stone, dark, C, 11.2, 2.3, 0.5, 9.45, 0.35);
  for (let i = 0; i < 14; i++) add(stone, column(1.75, 0.055, 6), T(-5.6 + (i + 0.5) * 0.8, 9.5, 0.02).premultiply(C));
  const mosaic = env.signs.draw(1024, 150, (c, p, W, H) => paintMosaic(c, p, W, H));
  add(stone, molding(PROFILES.sill(1.0), 11.4), T(0, 11.72, 0).premultiply(C));
  add(env.signs.material, env.signs.plane(mosaic, 10.6, 1.55), T(0, 11.9, -0.06).premultiply(C));
  facadeWall(b, ochre, C, 11.4, 1.75, 0.2, [{ cx: 0, y0: 0.1, w: 10.6, spring: 1.65, kind: 'flat' }], -5.7, 11.8);

  // Great arch with the rose window in its recessed tympanum; spandrels above.
  const AY = 13.7, AR = 4.9, AB = 0.6;
  add(stone, molding(PROFILES.string(1.1), 11.4), T(0, AY - 0.25, 0.02).premultiply(C));
  const sp = new Shape();
  sp.moveTo(-5.7, 0); sp.lineTo(-(AR + AB), 0); sp.absarc(0, 0, AR + AB, Math.PI, 0, true); sp.lineTo(5.7, 0); sp.lineTo(5.7, 7.8); sp.lineTo(-5.7, 7.8); sp.closePath();
  add(ochre, extrude(sp, 0.6), T(0, AY, -0.6).premultiply(C));
  add(stone, archivolt(AR, AB, 0.45, 40), T(0, AY, 0).premultiply(C));
  add(stone, archivolt(AR + AB, 0.18, 0.3, 40), T(0, AY, 0).premultiply(C));
  add(ochre, lathe([[AR, 1.25], [AR, 0]], 40, -Math.PI / 2, Math.PI).rotateX(-Math.PI / 2), T(0, AY, 0).premultiply(C)); // soffit (faces the axis)
  const RY = 2.55, RR = 2.2;
  const ty = new Shape();
  ty.moveTo(-AR, 0); ty.lineTo(AR, 0); ty.absarc(0, 0, AR, 0, Math.PI, false); ty.closePath();
  const hole = new Path(); hole.absarc(0, RY, RR, 0, Math.PI * 2, true); ty.holes.push(hole);
  const tymp = T(0, AY, -1.25).premultiply(C);
  add(stone, extrude(ty, 0.3), T(0, 0, -0.3).premultiply(tymp));
  add(glass, lathe([[RR, 0], [0, 0]], 32).rotateX(Math.PI / 2), T(0, RY, -0.25).premultiply(tymp));
  add(stone, ring(RR - 0.28, RR + 0.05, 0.35, 40), T(0, RY, -0.05).premultiply(tymp));
  add(stone, ring(0.5, 0.72, 0.3, 24), T(0, RY, -0.05).premultiply(tymp));
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    add(stone, ring(0.34, 0.46, 0.26, 18), T(Math.cos(a) * 1.35, RY + Math.sin(a) * 1.35, -0.05).premultiply(tymp));
    add(stone, box(0.09, 0.62, 0.22).translate(0, 0.72, 0).rotateZ(a - Math.PI / 2), T(0, RY, -0.05).premultiply(tymp));
  }
  add(stone, box(0.26, 2.9, 0.34), T(0, RY - 1.45, 0).premultiply(tymp)); // cross in the rose
  add(stone, box(1.9, 0.26, 0.34), T(0, RY + 0.35, 0).premultiply(tymp));

  // Gable with raking cornices, arcaded parapet behind, cross on the apex.
  const GY = 21.5, GH = 4.2;
  const gs = new Shape(); gs.moveTo(-7.2, 0); gs.lineTo(7.2, 0); gs.lineTo(0, GH); gs.closePath();
  add(stone, extrude(gs, 0.9), T(0, GY, -0.6).premultiply(C));
  const slope = Math.atan2(GH, 7.2), rl = Math.hypot(GH, 7.2) + 0.5;
  for (const s of [-1, 1]) add(stone, molding(PROFILES.cornice(0.8), rl).rotateZ(-s * slope), T(s * 3.6, GY + GH / 2 - 0.1, 0.3).premultiply(C));
  add(stone, molding(PROFILES.string(1), 14.4), T(0, GY - 0.2, 0.3).premultiply(C));
  blindArcade(b, stone, ochre, T(0, 0, -2.2).premultiply(C), 14.4, 2.4, 0.46, GY + 1.2, 0.2);
  add(stone, box(14.4, 0.3, 0.7), T(0, GY + 3.6, -2.4).premultiply(C));
  add(stone, box(0.9, 1.4, 0.8), T(0, GY + GH - 0.3, -0.2).premultiply(C));
  lorraineCross(b, stone, X0, Y0 + GY + GH + 1.1, ZF - 0.2, 1.6, 0.18);

  // Steps across the centre, and a stone plinth under the whole front.
  for (let i = 0; i < NSTEPS; i++) {
    const d = (NSTEPS - i) * TREAD;
    add(stone, box(17.6 - i * 0.1, STEP, d), face(X0, ZF + d / 2, 0, Y0 + i * STEP));
  }

  // ---------------------------------------------------------------------------------------------
  // Body: nave, aisles, transept, crossing dome, apse (all behind the front, inside the footprint).
  const nz0 = ZF - TW, nz1 = -66, NH = 20.5;
  bodyBlock(b, m, X0, (nz0 + nz1) / 2, 14.4, nz0 - nz1, NH, 4.6);
  for (const s of [-1, 1]) bodyBlock(b, m, X0 + s * 10.8, (nz0 + nz1) / 2, 7.2, nz0 - nz1, 11.5, 4.6);
  const tz = -62, tw = 8.5;
  bodyBlock(b, m, X0, tz, 35, tw, NH, 4.2);
  // lean-to aisle roofs and gable roofs
  roofGable(b, m.roof, X0, (nz0 + nz1) / 2, 15.2, nz0 - nz1 + 0.6, Y0 + NH, 4.2, 'z');
  roofGable(b, m.roof, X0, tz, 35.8, tw + 0.8, Y0 + NH, 4.2, 'x');
  for (const s of [-1, 1]) {
    const g = new Shape(); g.moveTo(0, 0); g.lineTo(s * 7.7, 0); g.lineTo(0, 3.0); g.closePath(); // lean-to
    add(m.roof, extrude(g, nz0 - nz1 - 0.2).translate(0, 0, -(nz0 - nz1 - 0.2) / 2), T(X0 + s * 7.2, Y0 + 11.5, (nz0 + nz1) / 2));
  }
  // apse: half-round, half-cone roof
  add(ochre, lathe([[7.1, 0], [7.1, 16.5]], 28, Math.PI / 2, Math.PI), face(X0, nz1, 0));
  add(stone, lathe([[7.45, 0], [7.45, 1.2], [7.2, 1.3]], 28, Math.PI / 2, Math.PI), face(X0, nz1, 0));
  add(stone, lathe([[7.2, 0], [7.6, 0.35], [7.6, 0.5], [7.1, 0.55]], 28, Math.PI / 2, Math.PI), face(X0, nz1, 0, Y0 + 16.3));
  add(m.roof, lathe([[7.6, 0], [0, 4.6]], 28, Math.PI / 2, Math.PI), face(X0, nz1, 0, Y0 + 16.8));
  for (let i = 0; i < 5; i++) {
    const a = Math.PI / 2 + ((i + 0.5) / 5) * Math.PI;
    const M = T(X0 + Math.sin(a) * 7.1, Y0, nz1 + Math.cos(a) * 7.1, a);
    archWindow(b, stone, glass, M, { cx: 0, y0: 8, w: 1.2, spring: 11 }, { band: 0.22, out: 0.12, inset: -0.05 });
  }
  // crossing dome: tall drum with windows rising clear of the roofs, ribbed dome, lantern
  const dz = tz, db = Y0 + NH + 0.6, DH = 5.8, DR = 5.2;
  add(ochre, cyl(DR, DR, DH, 36), face(X0, dz, 0, db));
  add(stone, lathe([[DR + 0.3, 0], [DR + 0.4, 0.2], [DR + 0.2, 0.45], [DR, 0.45]], 36), face(X0, dz, 0, db + DH - 0.45));
  add(stone, lathe([[DR + 0.15, 0], [DR + 0.15, 0.3], [DR, 0.35]], 36), face(X0, dz, 0, db + 3.6));
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    archWindow(b, stone, glass, T(X0 + Math.sin(a) * DR, db, dz + Math.cos(a) * DR, a), { cx: 0, y0: 4.0, w: 0.8, spring: 5.0 }, { band: 0.14, out: 0.1, inset: -0.05 });
  }
  const dp: [number, number][] = [];
  for (let i = 0; i <= 14; i++) { const t = (i / 14) * (Math.PI / 2); dp.push([(DR + 0.1) * Math.cos(t), 4.8 * Math.sin(t)]); }
  add(m.roof, lathe(dp, 40), face(X0, dz, 0, db + DH));
  for (let i = 0; i < 12; i++) add(stone, arcTube(DR + 0.12, 0.09, 0, Math.PI / 2, 14, 5).scale(1, 4.8 / (DR + 0.12), 1).rotateY((i / 12) * Math.PI * 2), face(X0, dz, 0, db + DH));
  add(stone, lathe([[0.9, 0], [0.9, 1.4], [1.05, 1.5], [0.5, 1.9], [0, 2.3]], 16), face(X0, dz, 0, db + DH + 4.6));
  lorraineCross(b, m.iron, X0, db + DH + 6.8, dz, 1.6);

  env.ground(b, F.xMin, F.xMax, F.zMin, F.zMax);
  const root = b.build('cathedral');

  // Colliders
  for (const s of [-1, 1]) env.aabb(X0 + s * TX - TW / 2 - 0.2, Y0, ZF - TW, X0 + s * TX + TW / 2 + 0.2, Y0 + H2, ZF + 0.2);
  for (let i = 0; i < NSTEPS; i++) {
    const d = (NSTEPS - i) * TREAD;
    env.aabb(X0 - 8.8, Y0 + i * STEP, ZF, X0 + 8.8, Y0 + (i + 1) * STEP, ZF + d);
  }
  env.aabb(X0 - 5.7, Y0, ZF - 3.3, X0 + 5.7, Y0 + YF, ZF);
  env.aabb(X0 - 5.7, Y0, ZF - 3.9, X0 + 5.7, Y0 + 8.4, ZF - 3.3); // porch back wall / doors
  for (const u of [-5.5, -1.75, 1.75, 5.5]) env.aabb(X0 + u - 0.35, Y0, ZF - 0.9, X0 + u + 0.35, Y0 + 8.4, ZF + 0.5);
  for (const u of [-5.2, 5.2]) env.aabb(X0 + u - 0.5, Y0, ZF - 0.9, X0 + u + 0.5, Y0 + 8.4, ZF + 0.5);
  // piers flanking the great arch: close the slot between the porch and the towers
  for (const s of [-1, 1]) env.aabb(X0 + s * 5.7, Y0, ZF - 8.8, X0 + s * 7.2, Y0 + 21.5, ZF + 0.35);
  // the closed iron gates in the three porch arches
  for (const o of arches) env.aabb(X0 + o.cx - o.w / 2, Y0 + YF, ZF - 0.5, X0 + o.cx + o.w / 2, Y0 + YF + 5.6, ZF - 0.4);
  env.aabb(X0 - 14.4, Y0, nz1, X0 + 14.4, Y0 + NH, nz0);
  env.aabb(X0 - 17.5, Y0, tz - tw / 2, X0 + 17.5, Y0 + NH, tz + tw / 2);
  env.aabb(X0 - 7.1, Y0, nz1 - 7.1, X0 + 7.1, Y0 + 16.5, nz1);
  return { root };
}

// ---------------------------------------------------------------------------------------------

/** Patriarchal (Lorraine) cross: shaft + two bars (upper shorter), standing on (x, y, z). */
function lorraineCross(b: Bucket, mat: Material, x: number, y: number, z: number, h: number, t = 0.12): void {
  b.add(mat, box(t, h, t), T(x, y, z));
  b.add(mat, box(h * 0.36, t, t), T(x, y + h * 0.78, z));
  b.add(mat, box(h * 0.52, t, t), T(x, y + h * 0.56, z));
  b.add(mat, lathe([[t * 1.3, 0], [t * 1.3, 0.12], [t * 0.8, 0.2], [0, 0.22]], 8), T(x, y - 0.2, z));
}

/** Iron gate filling the lower part of an arch: vertical bars, rails, arched top bars. */
function gate(b: Bucket, iron: Material, M: Matrix4, o: Opening): void {
  const r = o.w / 2, top = o.spring;
  for (let x = -r + 0.12; x < r - 0.06; x += 0.14) {
    const h = top - o.y0 + Math.sqrt(Math.max(0, r * r - x * x)) * 0.92;
    b.add(iron, box(0.025, h, 0.025), T(o.cx + x, o.y0, -0.45).premultiply(M));
  }
  for (const y of [0.15, 1.1, 2.9]) b.add(iron, box(o.w, 0.06, 0.05), T(o.cx, o.y0 + y, -0.45).premultiply(M));
  b.add(iron, arcTube(r * 0.94, 0.03, 0, Math.PI, 16, 4), T(o.cx, top, -0.45).premultiply(M));
}

/** Rendered masonry block with a plinth, cornice and round-headed windows on its long sides. */
function bodyBlock(b: Bucket, m: Env['mats'], x: number, z: number, w: number, d: number, h: number, bay: number): void {
  b.add(m.plasterOchre, box(w, h, d), T(x, CURB, z));
  b.add(m.stoneLight, box(w + 0.3, 1.1, d + 0.3), T(x, CURB, z));
  b.add(m.stoneLight, box(w + 0.8, 0.45, d + 0.8), T(x, CURB + h - 0.45, z));
  const long = w > d ? 'x' : 'z';
  const len = long === 'x' ? w : d, n = Math.floor((len - 2) / bay);
  for (const s of [-1, 1]) {
    for (let i = 0; i < n; i++) {
      const t = -len / 2 + (len - n * bay) / 2 + (i + 0.5) * bay;
      const M = long === 'x' ? T(x + t, CURB, z + s * d / 2, s > 0 ? 0 : Math.PI) : T(x + s * w / 2, CURB, z + t, s * Math.PI / 2);
      const o: Opening = h > 15 ? { cx: 0, y0: h - 5.6, w: 1.4, spring: h - 2.6 } : { cx: 0, y0: h - 7.4, w: 1.5, spring: h - 3.6 };
      archWindow(b, m.stoneLight, m.glass, M, o, { band: 0.25, out: 0.12, inset: -0.03 });
    }
  }
}

/** Gable roof over a w×d block (ridge along `axis`), eaves at y. */
function roofGable(b: Bucket, mat: Material, x: number, z: number, w: number, d: number, y: number, rise: number, axis: 'x' | 'z'): void {
  const span = axis === 'z' ? w : d, len = axis === 'z' ? d : w;
  const s = new Shape(); s.moveTo(-span / 2, 0); s.lineTo(span / 2, 0); s.lineTo(0, rise); s.closePath();
  const g = extrude(s, len).translate(0, 0, -len / 2);
  b.add(mat, g, T(x, y, z, axis === 'z' ? 0 : Math.PI / 2));
}

/** Gold mosaic band: gold tesserae, a central blue roundel with a cross, flanking scroll work. */
function paintMosaic(c: CanvasRenderingContext2D, p: CanvasRenderingContext2D, W: number, H: number): void {
  const t = 8;
  for (let y = 0; y < H; y += t) {
    for (let x = 0; x < W; x += t) {
      const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
      const k = n - Math.floor(n);
      c.fillStyle = `rgb(${200 + k * 45 | 0},${150 + k * 40 | 0},${60 + k * 30 | 0})`;
      c.fillRect(x, y, t - 1, t - 1);
    }
  }
  c.fillStyle = 'rgba(60,40,20,0.9)'; c.fillRect(0, 0, W, 5); c.fillRect(0, H - 5, W, 5);
  // two flying angels facing the central roundel (robe, wings, haloed head, trumpet)
  for (const d of [-1, 1]) {
    c.save();
    c.translate(W / 2 + d * W * 0.24, H * 0.52);
    c.scale(-d, 1);
    c.fillStyle = '#7b2a22';
    c.beginPath(); c.moveTo(-10, -8); c.quadraticCurveTo(40, -70, 120, -46); c.quadraticCurveTo(60, -30, 20, 4); c.fill(); // wing
    c.fillStyle = '#e8e2d2';
    c.beginPath(); c.moveTo(-120, 22); c.quadraticCurveTo(-60, -6, 0, -14); c.quadraticCurveTo(30, -10, 36, 6); c.quadraticCurveTo(-30, 30, -120, 22); c.fill(); // robe
    c.fillStyle = '#2d4f86'; c.fillRect(-70, 10, 60, 6);
    c.fillStyle = '#f1d489'; c.beginPath(); c.arc(50, -12, 17, 0, Math.PI * 2); c.fill(); // halo
    c.fillStyle = '#c79a78'; c.beginPath(); c.arc(50, -12, 11, 0, Math.PI * 2); c.fill(); // head
    c.strokeStyle = '#6b4a1e'; c.lineWidth = 5; c.beginPath(); c.moveTo(58, -6); c.lineTo(110, 10); c.stroke(); // trumpet
    c.restore();
  }
  c.fillStyle = '#1f3d6e'; c.beginPath(); c.arc(W / 2, H / 2, H * 0.42, 0, Math.PI * 2); c.fill();
  c.strokeStyle = '#f1d489'; c.lineWidth = 6; c.stroke();
  c.fillStyle = '#f1d489'; c.fillRect(W / 2 - 6, H * 0.18, 12, H * 0.64); c.fillRect(W / 2 - 26, H * 0.36, 52, 12);
  // PBR: tesserae are gilded glass (smooth, metallic); the rest matte
  p.fillStyle = 'rgb(0,70,220)'; p.fillRect(0, 0, W, H);
}
