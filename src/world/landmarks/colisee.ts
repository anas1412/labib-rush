// Le Colisée (1931, Art Deco), south side of the avenue, facing −Z: a tall white block with
// vertical fins, balcony bands and roller-shutter windows over a ground-floor arcade (square
// pillars banded in black marble, shopfronts behind) with the entrance to the cinema gallery in
// the middle, the name in Latin and Arabic over it and a vertical cinema blade sign above.
import { Path, Shape, Vector2, type BufferGeometry, type Material, type Matrix4 } from 'three';
import { CURB, LANDMARKS } from '../../core/layout';
import { Bucket, T, box, extrude, mergeAll, molding, PROFILES, type Opening } from './kit';
import { facadeWall } from './facade';
import { fitFont, type Env, type Landmark } from './env';

const F = LANDMARKS.colisee;
const X0 = (F.xMin + F.xMax) / 2;
const W = F.xMax - F.xMin; // 40
const ZF = F.zMin + 0.3; // facade plane
const Y0 = CURB;
const GH = 6.4; // arcade height
const FH = 3.3; // storey height
const FLOORS = 6;
const BAY = 4;

export function buildColisee(env: Env): Landmark {
  const m = env.mats, signs = env.signs;
  const b = new Bucket();
  const add = (mat: Material, g: BufferGeometry, M: Matrix4) => b.add(mat, g.applyMatrix4(M));
  // local frame: x along the facade (world −X), +z toward the avenue (world −Z)
  const C = T(X0, Y0, ZF, Math.PI);
  const at = (x: number, y: number, z: number, ry = 0) => T(x, y, z, ry).premultiply(C);
  const nb = W / BAY;
  const depth = F.zMax - F.zMin - 0.3;
  const top = GH + 1.0 + FLOORS * FH;

  // ---------------------------------------------------------------------------------------------
  // Arcade: pillars, lintel beam, shopfronts set back, gallery entrance in the two middle bays.
  const SB = 4.6; // shopfront setback
  for (let i = 0; i <= nb; i++) {
    const x = -W / 2 + i * BAY + (i === 0 ? 0.45 : i === nb ? -0.45 : 0);
    add(m.plasterWhite, box(0.9, GH, 0.9), at(x, 0, -0.45));
    add(m.marbleBlack, box(0.96, 1.3, 0.96), at(x, 0, -0.45));
    for (const y of [1.55, 1.85, 2.15]) add(m.marbleBlack, box(0.95, 0.12, 0.95), at(x, y, -0.45));
    add(m.marbleBlack, box(1.0, 0.35, 1.0), at(x, GH - 0.95, -0.45));
  }
  add(m.plasterWhite, box(W, 1.0, 1.0), at(0, GH, -0.5)); // sign band / lintel
  add(m.ornament, molding(PROFILES.string(1.1), W), at(0, GH + 1.0, 0));
  add(m.plasterWhite, box(W, 0.3, SB), at(0, GH - 0.3, -SB / 2)); // gallery ceiling
  const shopNames: [string, string][] = [['CAFÉ', 'مقهى'], ['LIBRAIRIE', 'مكتبة'], ['PHARMACIE', 'صيدلية'], ['PÂTISSERIE', 'مرطبات']];
  const interiors = shopNames.map((_, k) => signs.draw(256, 308, (c, _p, W2, H2) => paintShop(c, W2, H2, k)));
  const gw = BAY * 2 - 0.9, gd = 9; // gallery passage width / depth
  const DB = 0.6; // display depth behind the shop wall
  const shops: Opening[] = [];
  for (let i = 0; i < nb; i++) {
    const cx = -W / 2 + (i + 0.5) * BAY;
    if (i === nb / 2 - 1 || i === nb / 2) continue; // gallery entrance
    const o: Opening = { cx, y0: 0.3, w: 3.0, spring: 3.9, kind: 'flat' };
    shops.push(o);
    // Art Deco stepped frame (black marble) around each shop window
    const fr = new Shape();
    fr.moveTo(-1.75, 0); fr.lineTo(1.75, 0); fr.lineTo(1.75, 4.6); fr.lineTo(1.35, 4.6); fr.lineTo(1.35, 5.0); fr.lineTo(0.8, 5.0); fr.lineTo(0.8, 5.35);
    fr.lineTo(-0.8, 5.35); fr.lineTo(-0.8, 5.0); fr.lineTo(-1.35, 5.0); fr.lineTo(-1.35, 4.6); fr.lineTo(-1.75, 4.6); fr.closePath();
    fr.holes.push(new Path([new Vector2(-1.5, 0.3), new Vector2(-1.5, 3.9), new Vector2(1.5, 3.9), new Vector2(1.5, 0.3)]));
    add(m.marbleBlack, extrude(fr, 0.12), at(cx, 0, -SB));
    // clear glazing in front of a shallow lit display: side/top/floor reveals and the interior card
    add(m.shopWindow, box(3.0, 3.6, 0.03), at(cx, 0.3, -SB + 0.08));
    add(m.iron, box(3.1, 0.08, 0.1), at(cx, 3.95, -SB + 0.14));
    for (const x of [-0.75, 0.75]) add(m.iron, box(0.06, 3.6, 0.1), at(cx + x, 0.3, -SB + 0.14));
    for (const s2 of [-1, 1]) add(m.plasterWhite, box(0.05, 3.6, DB), at(cx + s2 * 1.475, 0.3, -SB - 0.3 - DB / 2));
    for (const y of [0.25, 3.9]) add(m.plasterWhite, box(3.0, 0.05, DB), at(cx, y, -SB - 0.3 - DB / 2));
    add(signs.glow, signs.plane(interiors[i % interiors.length], 3.0, 3.6), at(cx, 0.3, -SB - 0.3 - DB + 0.01));
    const [fr1, ar] = shopNames[i % shopNames.length];
    const sign = signs.draw(280, 100, (c, p, W2, H2) => {
      c.fillStyle = '#16181b'; c.fillRect(0, 0, W2, H2);
      c.fillStyle = '#e9d9ae'; c.textAlign = 'center'; c.textBaseline = 'middle';
      fitFont(c, fr1, W2 * 0.88, 700, H2 * 0.3); c.fillText(fr1, W2 / 2, H2 * 0.3);
      c.direction = 'rtl'; fitFont(c, ar, W2 * 0.88, 700, H2 * 0.34); c.fillText(ar, W2 / 2, H2 * 0.7);
      p.fillStyle = 'rgb(0,60,0)'; p.fillRect(0, 0, W2, H2);
    });
    add(signs.material, signs.plane(sign, 2.3, 0.82), at(cx, 4.12, -SB + 0.14));
  }
  // shop wall with the window openings, in two halves either side of the gallery passage
  for (const s2 of [-1, 1]) {
    const x0 = s2 < 0 ? -W / 2 : gw / 2, w = W / 2 - gw / 2;
    facadeWall(b, m.plasterWhite, at(0, 0, -SB), w, GH, 0.3, shops.filter((o) => Math.sign(o.cx) === s2), x0);
  }
  add(m.plasterWhite, box(gw, 0.6, 0.3), at(0, GH - 0.6, -SB - 0.15)); // lintel over the passage
  // ground-floor mass behind the shops (left/right of the passage, and behind its end)
  const back = depth - SB - 1.3 - DB;
  for (const s2 of [-1, 1]) add(m.plasterWhite, box(W / 2 - BAY + 0.45, GH, back).translate(0, 0, -back / 2), at(s2 * (W / 4 + BAY / 2 - 0.22), 0, -SB - 0.3 - DB));
  // gallery passage: deep, marble-lined, glazed doors onto the lit cinema lobby at the end
  const backG = depth - SB - 1.3;
  add(m.plasterWhite, box(gw, GH, backG - gd).translate(0, 0, -(backG - gd) / 2), at(0, 0, -SB - gd - 0.3));
  for (const s2 of [-1, 1]) add(m.marbleBlack, box(0.3, GH - 0.3, gd), at(s2 * (gw / 2 + 0.15), 0, -SB - gd / 2));
  add(m.plasterWhite, box(gw, 0.3, gd), at(0, GH - 0.6, -SB - gd / 2));
  add(m.dark, box(gw, 0.05, gd), at(0, GH - 0.65, -SB - gd / 2));
  add(m.shopWindow, box(gw, GH - 0.6, 0.04), at(0, 0, -SB - gd + 0.05));
  for (let x = -gw / 2; x <= gw / 2 + 0.01; x += gw / 4) add(m.iron, box(0.08, GH - 0.6, 0.14), at(x, 0, -SB - gd + 0.1));
  const lobby = signs.draw(512, 418, (c, _p, W2, H2) => paintLobby(c, W2, H2));
  add(signs.glow, signs.plane(lobby, gw, GH - 0.6), at(0, 0, -SB - gd - 0.28));
  // stepped portal frame over the entrance
  const portal = new Shape();
  portal.moveTo(-gw / 2 - 0.6, 0); portal.lineTo(-gw / 2, 0); portal.lineTo(-gw / 2, 5.4); portal.lineTo(-gw / 2 + 0.8, 5.4); portal.lineTo(-gw / 2 + 0.8, 5.8);
  portal.lineTo(gw / 2 - 0.8, 5.8); portal.lineTo(gw / 2 - 0.8, 5.4); portal.lineTo(gw / 2, 5.4); portal.lineTo(gw / 2, 0); portal.lineTo(gw / 2 + 0.6, 0);
  portal.lineTo(gw / 2 + 0.6, 6.1); portal.lineTo(-gw / 2 - 0.6, 6.1); portal.closePath();
  add(m.marbleBlack, extrude(portal, 0.16), at(0, 0, -SB));

  // Name over the gallery (Latin + Arabic) on the sign band
  const name = signs.draw(1200, 152, (c, p, W2, H2) => {
    c.textBaseline = 'middle'; c.textAlign = 'center';
    c.fillStyle = '#c9a453';
    fitFont(c, 'LE  COLISÉE', W2 * 0.58, 800, H2 * 0.62);
    c.fillText('LE  COLISÉE', W2 * 0.32, H2 * 0.54);
    c.direction = 'rtl'; fitFont(c, 'الكوليزي', W2 * 0.34, 800, H2 * 0.66);
    c.fillText('الكوليزي', W2 * 0.8, H2 * 0.5);
    p.fillStyle = 'rgb(0,70,235)'; p.fillRect(0, 0, W2, H2);
  });
  add(signs.material, signs.plane(name, 10.5, 1.33), at(0, GH - 0.18, 0.04));

  // ---------------------------------------------------------------------------------------------
  // Upper floors: wall with window bands, fins, balconies, roller-shutter boxes.
  add(m.plasterWhite, box(W, top - GH, depth - 1).translate(0, 0, -(depth - 1) / 2), at(0, GH, 0.0));
  for (let f = 0; f < FLOORS; f++) {
    const y = GH + 1.0 + f * FH;
    for (let i = 0; i < nb; i++) {
      const cx = -W / 2 + (i + 0.5) * BAY;
      const centre = i === nb / 2 - 1 || i === nb / 2;
      const ww = centre ? 1.4 : 2.7;
      for (const dx of centre ? [-0.9, 0.9] : [0]) {
        add(m.glass, box(ww, 1.75, 0.05), at(cx + dx, y + 0.8, 0.02));
        // roller shutter pulled down by a random amount (lived-in facade)
        const hsh = Math.abs(Math.sin((f * 31 + i * 7 + dx) * 12.9898) * 43758.5453) % 1;
        const drop = hsh < 0.35 ? 0 : hsh < 0.6 ? 0.5 : hsh < 0.85 ? 1.1 : 1.75;
        if (drop > 0) add(m.plasterSand, box(ww - 0.04, drop, 0.04), at(cx + dx, y + 2.55 - drop, 0.06));
        add(m.plasterWhite, box(ww + 0.1, 0.32, 0.16), at(cx + dx, y + 2.55, 0.06)); // shutter box
        add(m.ornament, box(ww + 0.2, 0.08, 0.24), at(cx + dx, y + 0.72, 0.1)); // sill
        add(m.iron, box(0.05, 1.75, 0.08), at(cx + dx, y + 0.8, 0.05)); // mullion
      }
      // balconies on alternate floors in the outer bays, continuous thin slabs elsewhere
      if (!centre && (f % 2 === 0 || i === 0 || i === nb - 1)) {
        add(m.ornament, box(BAY - 0.5, 0.16, 1.05), at(cx, y + 0.02, 0.5));
        add(m.iron, balconyRail(BAY - 0.6, 1.0), at(cx, y + 0.18, 0.98));
      } else {
        add(m.ornament, box(BAY - 0.4, 0.12, 0.3), at(cx, y + 0.05, 0.14));
      }
    }
  }
  // vertical fins at every bay line, stepped at the top
  for (let i = 0; i <= nb; i++) {
    const x = -W / 2 + i * BAY + (i === 0 ? 0.2 : i === nb ? -0.2 : 0);
    const inner = i === nb / 2 - 1 || i === nb / 2 + 1;
    add(m.ornament, box(0.4, top - GH + (inner ? 2.6 : 0.4), 0.55), at(x, GH + 1.0, 0.27));
  }
  // central tower: taller, stepped Art Deco crown, vertical cinema sign
  const tw = BAY * 2 + 0.4;
  add(m.plasterWhite, box(tw, 4.2, depth * 0.5).translate(0, 0, -depth * 0.25), at(0, top, 0));
  add(m.ornament, box(tw - 1.2, 1.1, depth * 0.5 - 1).translate(0, 0, -depth * 0.25), at(0, top + 4.2, -0.3));
  add(m.ornament, box(tw - 3.0, 0.9, depth * 0.5 - 2).translate(0, 0, -depth * 0.25), at(0, top + 5.3, -0.6));
  // vertical blade sign, painted as a horizontal strip (read rotated by planeRotated)
  const blade = signs.draw(800, 136, (c, p, W2, H2) => {
    c.fillStyle = '#131417'; c.fillRect(0, 0, W2, H2);
    c.strokeStyle = '#c9a453'; c.lineWidth = 10; c.strokeRect(8, 8, W2 - 16, H2 - 16);
    c.fillStyle = '#f0dfa9'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.font = `800 ${H2 * 0.6}px Cairo`;
    const letters = 'COLISÉE';
    for (let k = 0; k < letters.length; k++) {
      c.save(); c.translate(70 + k * ((W2 - 140) / (letters.length - 1)), H2 / 2); c.rotate(-Math.PI / 2); c.fillText(letters[k], 0, 0); c.restore();
    }
    p.fillStyle = 'rgb(0,70,0)'; p.fillRect(0, 0, W2, H2);
    p.fillStyle = 'rgb(0,60,220)'; p.fillRect(8, 8, 10, H2 - 16); p.fillRect(W2 - 18, 8, 10, H2 - 16);
  });
  const bladeH = 9.5, bladeW = 1.6;
  add(m.marbleBlack, box(0.34, bladeH + 0.4, bladeW + 0.2), at(0, GH + 2.2, 1.05));
  for (const s of [-1, 1]) add(signs.material, signs.planeRotated(blade, bladeW, bladeH), at(s * 0.18, GH + 2.4, 1.05, s * Math.PI / 2));
  add(m.ornament, molding(PROFILES.cornice(1.1), W + 0.8), at(0, top - 0.5, 0));
  add(m.ornament, box(W, 0.9, 0.3), at(0, top, 0.1)); // parapet
  // plain flanks
  for (const s of [-1, 1]) add(m.ornament, box(0.35, top - GH, depth - 1).translate(0, 0, -(depth - 1) / 2), at(s * (W / 2 - 0.1), GH, 0));

  env.ground(b, F.xMin, F.xMax, F.zMin, F.zMax);
  const root = b.build('colisee');

  // Colliders: pillars, shopfront wall, gallery passage, building mass.
  for (let i = 0; i <= nb; i++) {
    const x = X0 - (-W / 2 + i * BAY + (i === 0 ? 0.45 : i === nb ? -0.45 : 0));
    env.aabb(x - 0.5, Y0, ZF - 0.05, x + 0.5, Y0 + GH, ZF + 0.95);
  }
  const zs = ZF + SB;
  env.aabb(X0 - W / 2, Y0, zs, X0 - gw / 2, Y0 + GH, F.zMax);
  env.aabb(X0 + gw / 2, Y0, zs, X0 + W / 2, Y0 + GH, F.zMax);
  env.aabb(X0 - gw / 2, Y0, zs + gd - 0.1, X0 + gw / 2, Y0 + GH, F.zMax);
  env.aabb(X0 - W / 2, Y0 + GH - 0.3, ZF - 1, X0 + W / 2, Y0 + top, F.zMax);
  return { root };
}

/** Thin Art Deco balcony rail: top tube, three horizontal bars, end posts. */
function balconyRail(len: number, h: number): BufferGeometry {
  const p: BufferGeometry[] = [box(len, 0.05, 0.05).translate(0, h - 0.05, 0)];
  for (const y of [0.2, 0.45, 0.7]) p.push(box(len, 0.025, 0.025).translate(0, y, 0));
  for (const x of [-len / 2, -len / 6, len / 6, len / 2]) p.push(box(0.04, h, 0.04).translate(x, 0, 0));
  return mergeAll(p);
}

/** Lit shop interior seen through the glazing: back-wall shelving stocked by trade (0 café,
 *  1 bookshop, 2 pharmacy, 3 pastry shop), a counter, ceiling lights. */
function paintShop(c: CanvasRenderingContext2D, W: number, H: number, kind: number): void {
  let seed = kind * 977 + 13;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const wall = c.createLinearGradient(0, 0, 0, H);
  wall.addColorStop(0, kind === 2 ? '#3d4644' : '#2c1e13'); wall.addColorStop(0.6, kind === 2 ? '#6d7a76' : '#5a3f26'); wall.addColorStop(1, '#1d150e');
  c.fillStyle = wall; c.fillRect(0, 0, W, H);
  const goods = [
    ['#5b2d14', '#c9a45a', '#2f5a3a', '#8a1f1f', '#d8d0c0', '#3a2a18'], // café: bottles, tins, cups
    ['#7a2121', '#1f3f6b', '#2e5b34', '#c9a64f', '#5a3a6b', '#d9cfb8', '#3b3b3b'], // book spines
    ['#eef3f4', '#ffffff', '#3c9a5a', '#bcd4e0', '#f0e0c0', '#d33c3c'], // boxed remedies
    ['#e6b35a', '#c7783a', '#f2d6a0', '#8a4a2a', '#f5efe0', '#d96a8a'], // pastries, sweets
  ][kind];
  for (let row = 0; row < 4; row++) {
    const y = H * (0.2 + row * 0.12);
    for (let x = W * 0.06; x < W * 0.92;) {
      const w = kind === 1 ? 4 + rnd() * 5 : 7 + rnd() * 10;
      const h = (kind === 0 ? 0.55 + rnd() * 0.45 : kind === 1 ? 0.6 + rnd() * 0.35 : 0.4 + rnd() * 0.4) * H * 0.1;
      c.fillStyle = goods[Math.floor(rnd() * goods.length)];
      if (kind === 3) { c.beginPath(); c.ellipse(x + w / 2, y - h / 3, w / 2, h / 3, 0, 0, Math.PI * 2); c.fill(); } else c.fillRect(x, y - h, w, h);
      x += w + (kind === 1 ? 0.8 : 2 + rnd() * 4);
    }
    c.fillStyle = '#1a120b'; c.fillRect(W * 0.04, y, W * 0.92, 4); // shelf board
    c.fillStyle = 'rgba(255,220,160,0.35)'; c.fillRect(W * 0.04, y, W * 0.92, 1);
  }
  if (kind === 2) { // green pharmacy cross
    c.fillStyle = '#35c46a'; c.fillRect(W * 0.46, H * 0.02, W * 0.08, H * 0.13); c.fillRect(W * 0.43, H * 0.065, W * 0.14, H * 0.045);
  }
  // counter (glass-topped display for the pastry shop)
  c.fillStyle = kind === 2 ? '#d8dcd8' : '#3a2616'; c.fillRect(0, H * 0.72, W, H * 0.28);
  c.fillStyle = 'rgba(255,235,190,0.4)'; c.fillRect(0, H * 0.72, W, 3);
  if (kind === 3) {
    c.fillStyle = 'rgba(200,220,230,0.25)'; c.fillRect(W * 0.05, H * 0.62, W * 0.9, H * 0.1);
    for (let x = W * 0.08; x < W * 0.9; x += 12 + rnd() * 6) { c.fillStyle = goods[Math.floor(rnd() * goods.length)]; c.beginPath(); c.ellipse(x, H * 0.7, 6, 3.5, 0, 0, Math.PI * 2); c.fill(); }
  }
  // warm ceiling lights and their pools
  for (const x of [0.25, 0.75]) {
    const g = c.createRadialGradient(W * x, H * 0.04, 0, W * x, H * 0.04, W * 0.42);
    g.addColorStop(0, 'rgba(255,232,185,0.95)'); g.addColorStop(0.25, 'rgba(255,215,150,0.35)'); g.addColorStop(1, 'rgba(255,215,150,0)');
    c.fillStyle = g; c.fillRect(0, 0, W, H);
  }
}

/** The cinema gallery beyond the glazed doors: a lit arcade in one-point perspective, marble
 *  floor, posters on the side walls, a row of ceiling lamps. */
function paintLobby(c: CanvasRenderingContext2D, W: number, H: number): void {
  const vx = W / 2, x0 = vx - W * 0.16, x1 = vx + W * 0.16, y0 = H * 0.3, y1 = H * 0.66;
  const quad = (pts: [number, number][], fill: string | CanvasGradient) => {
    c.fillStyle = fill; c.beginPath(); pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); c.closePath(); c.fill();
  };
  quad([[0, 0], [W, 0], [x1, y0], [x0, y0]], '#e2cfa6'); // ceiling
  quad([[0, 0], [x0, y0], [x0, y1], [0, H]], '#9c7c55'); // left wall
  quad([[W, 0], [x1, y0], [x1, y1], [W, H]], '#8e704b'); // right wall
  quad([[0, H], [W, H], [x1, y1], [x0, y1]], '#6a5a4a'); // floor
  c.fillStyle = '#3b2a1a'; c.fillRect(x0, y0, x1 - x0, y1 - y0); // far end
  c.fillStyle = '#f3d9a0'; c.fillRect(vx - W * 0.06, y0 + (y1 - y0) * 0.3, W * 0.12, (y1 - y0) * 0.7); // lit doorway
  // marble floor bands converging on the far end
  c.strokeStyle = 'rgba(30,24,18,0.5)'; c.lineWidth = 2;
  for (let k = -6; k <= 6; k++) { c.beginPath(); c.moveTo(vx + (k / 6) * W * 0.9, H); c.lineTo(vx + (k / 6) * (x1 - vx), y1); c.stroke(); }
  for (let k = 1; k < 7; k++) { const t = Math.pow(k / 7, 1.8), y = y1 + (H - y1) * t; c.beginPath(); c.moveTo(x0 - (x0 * t), y); c.lineTo(x1 + (W - x1) * t, y); c.stroke(); }
  // posters and shop windows along the walls: point on a side wall at depth t (0 near → 1 far)
  // and height f (0 ceiling → 1 floor)
  const cols = ['#b3121b', '#1f3f6b', '#d9a21b', '#2e5b34', '#c7783a'];
  for (const side of [0, 1]) {
    const P = (t: number, f: number): [number, number] => {
      const top = y0 * t, bot = H + (y1 - H) * t;
      return [side ? W + (x1 - W) * t : x0 * t, top + (bot - top) * f];
    };
    for (let k = 0; k < 4; k++) {
      const t0 = 0.1 + k * 0.2, t1 = t0 + 0.11;
      quad([P(t0, 0.3), P(t1, 0.3), P(t1, 0.62), P(t0, 0.62)], cols[(k * 2 + side) % cols.length]);
    }
  }
  // ceiling lamps
  for (let k = 0; k < 6; k++) {
    const t = Math.pow(k / 6, 1.4), y = y0 * t + 4 * (1 - t) + 6, r = 14 * (1 - t) + 3;
    const g = c.createRadialGradient(vx, y, 0, vx, y, r * 4);
    g.addColorStop(0, 'rgba(255,240,200,1)'); g.addColorStop(0.3, 'rgba(255,220,160,0.5)'); g.addColorStop(1, 'rgba(255,220,160,0)');
    c.fillStyle = g; c.fillRect(vx - r * 4, y - r * 4, r * 8, r * 8);
  }
}
