// Porte de France / Bab el Bhar (visual backdrop at the end of Avenue de France, facing east +X):
// a massive ashlar gate block with a great horseshoe arch in a pale marble frame, an inscription
// plaque, a crenellated top of capped merlons and a Tunisian flag; open wooden doors in the
// passage; a whitewashed medina street beyond. No colliders (outside the playable area).
import { type BufferGeometry, type Material, type Matrix4 } from 'three';
import { AVENUE_DE_FRANCE, CURB, LANDMARKS } from '../../core/layout';
import { Bucket, T, archTop, box, lathe, molding, PROFILES, type Opening } from './kit';
import { facadeWall, frame } from './facade';
import { createFlag, flagPole } from './flag';
import type { Env, Landmark } from './env';

const { x: X0, z: Z0 } = LANDMARKS.porteDeFrance;
const Y0 = CURB;
const W = 12.8, D = 9, H = 11.2;

export function buildPorteDeFrance(env: Env): Landmark {
  const m = env.mats;
  const b = new Bucket();
  const add = (mat: Material, g: BufferGeometry, M: Matrix4) => b.add(mat, g.applyMatrix4(M));
  // local frame: x across the gate (world −Z), +z out of the east face (world +X)
  const F = T(X0 + D / 2, Y0, Z0, Math.PI / 2);
  const at = (x: number, y: number, z: number, ry = 0) => T(x, y, z, ry).premultiply(F);

  // Block with the horseshoe passage cut straight through (extruded over the full depth).
  const arch: Opening = { cx: 0, y0: 0, w: 5.2, spring: 5.6, kind: 'horseshoe' };
  facadeWall(b, m.porteStone, F, W, H, D, [arch]);
  const top = archTop(arch.w, arch.spring, 'horseshoe');
  // pale marble alfiz (rectangular frame) and voussoir band around the arch, on both faces
  for (const [ry, z] of [[0, 0], [Math.PI, -D]] as const) {
    const M = at(0, 0, z, ry);
    frame(b, m.stoneWarm, M, arch, 0.55, 0.1);
    const fw = arch.w + 2.6, fh = top + 1.1;
    for (const s of [-1, 1]) add(m.stoneWarm, box(0.7, fh, 0.14), T(s * (fw / 2 - 0.35), 0, 0.02).premultiply(M));
    add(m.stoneWarm, box(fw, 0.7, 0.14), T(0, fh - 0.7, 0.02).premultiply(M));
    add(m.stoneWarm, box(fw - 1.4, 0.18, 0.08), T(0, fh - 0.95, 0.02).premultiply(M));
  }
  // inscription plaque over the frame
  const plaque = env.signs.draw(420, 140, (c, p, w, h) => {
    c.fillStyle = '#e4dccd'; c.fillRect(0, 0, w, h);
    c.strokeStyle = '#6d6353'; c.lineWidth = 6; c.strokeRect(6, 6, w - 12, h - 12);
    c.fillStyle = '#3d362c'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.direction = 'rtl';
    c.font = `700 ${h * 0.34}px Cairo`; c.fillText('باب البحر', w / 2, h * 0.36);
    c.font = `600 ${h * 0.2}px Cairo`; c.fillText('أعيد بناؤه سنة 1848', w / 2, h * 0.72);
    p.fillStyle = 'rgb(0,110,0)'; p.fillRect(0, 0, w, h);
  });
  add(env.signs.material, env.signs.plane(plaque, 2.8, 0.93), at(0, top + 1.45, 0.03));
  // cornice all round + capped merlons along the parapet (0.3 m in from the edges)
  for (let k = 0; k < 4; k++) {
    const ry = (k * Math.PI) / 2, len = k % 2 ? D : W;
    const cx = k === 1 ? W / 2 : k === 3 ? -W / 2 : 0, cz = k === 0 ? 0 : k === 2 ? -D : -D / 2;
    add(m.porteStone, molding(PROFILES.cornice(0.7), len + 0.6), at(cx, H - 0.35, cz, ry));
  }
  const merlon = (x: number, z: number) => {
    add(m.porteStone, box(0.5, 0.75, 0.5), at(x, H, z));
    add(m.porteStone, lathe([[0.32, 0], [0.34, 0.08], [0.22, 0.2], [0.26, 0.32], [0.1, 0.5], [0, 0.58]], 8), at(x, H + 0.75, z));
  };
  const nx = 15, nz = 10, ex = W / 2 - 0.3, ez = D - 0.3;
  for (let i = 0; i < nx; i++) { const x = -ex + (2 * ex * i) / (nx - 1); merlon(x, -0.3); merlon(x, -ez); }
  for (let i = 1; i < nz - 1; i++) { const z = -0.3 - ((ez - 0.3) * i) / (nz - 1); merlon(-ex, z); merlon(ex, z); }
  add(m.porteStone, box(W - 0.6, 0.5, D - 0.6), at(0, H - 0.2, -D / 2)); // roof slab
  add(m.iron, flagPole(5.5), at(-3.5, H + 0.3, -D / 2));
  // passage floor and the two great doors, open against the passage walls
  add(m.stoneWarm, box(arch.w, 0.05, D + 0.6), at(0, 0, -D / 2));
  for (const s of [-1, 1]) {
    add(m.wood, box(0.16, 5.4, 2.55), at(s * (arch.w / 2 - 0.12), 0.05, -1.5));
    for (let y = 0.6; y < 5.3; y += 0.9) for (let z = -2.5; z < -0.5; z += 0.9) add(m.iron, lathe([[0.05, 0], [0.03, 0.03], [0, 0.04]], 6).rotateZ(s * Math.PI / 2), at(s * (arch.w / 2 - 0.2), y, z));
  }

  // Medina beyond: a lane of whitewashed houses continuing the passage axis.
  const houses: [number, number, number, number][] = [ // along-lane offset, side, width, height
    [2, -1, 6, 8.5], [8.5, -1, 7, 10.5], [15.5, -1, 6, 7.5], [2.5, 1, 7, 9.5], [9.5, 1, 5.5, 7], [15, 1, 7.5, 11],
    [21, -1, 8, 9], [21.5, 1, 7, 8],
  ];
  for (const [u, side, w, h] of houses) {
    const hx = X0 - D / 2 - 1 - u, hz = Z0 + side * (3.2 + 4);
    add(m.plasterWhite, box(w, h, 8), T(hx, Y0, hz, 0));
    add(m.plasterWhite, box(w + 0.3, 0.3, 8.3), T(hx, Y0 + h, hz));
    const fz = hz - side * 4.02;
    add(m.blueIron, box(1.3, 2.4, 0.08), T(hx, Y0, fz)); // studded door
    for (const wy of [h - 3.2]) add(m.dark, box(0.9, 1.1, 0.06), T(hx + 1.6, Y0 + wy, fz));
  }
  add(m.plasterWhite, box(6, 12, 6), T(X0 - D / 2 - 30, Y0, Z0)); // lane end

  env.ground(b, X0 - D / 2 - 36, AVENUE_DE_FRANCE.xMin, Z0 - 14, Z0 + 14, false); // medina lane beyond the avenue (visual only)
  const root = b.build('porteDeFrance');
  const flag = createFlag('tn', 2.2, 1.45, 5.5, env.ctx.uniforms);
  // at(-3.5, …, −D/2) in the local frame → world
  flag.root.position.set(X0, Y0 + H + 0.3, Z0 + 3.5);
  root.add(flag.root);
  return { root, update: (dt) => flag.update(dt), dispose: () => flag.dispose() };
}
