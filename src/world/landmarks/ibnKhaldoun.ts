// Ibn Khaldoun statue (Place de l'Indépendance): bronze scholar in a burnous holding a book, on a
// white roughcast plinth with marble plaques, in a round raised lawn with a low green iron fence.
// Looks east (+X) down the avenue.
import { Group, type BufferGeometry } from 'three';
import { CURB, LANDMARKS } from '../../core/layout';
import { G } from '../../core/physics';
import { Bucket, T, arcTube, box, lathe, molding, PROFILES } from './kit';
import { fitFont, type Env, type Landmark } from './env';
import { statueLOD } from './statueMesh';
import { crossCards } from './plants';

export function buildIbnKhaldoun(env: Env, statue: BufferGeometry, far: BufferGeometry): Landmark {
  const { mats: m, signs } = env;
  const { x: X0, z: Z0 } = LANDMARKS.ibnKhaldoun;
  const b = new Bucket();
  const y0 = CURB;

  // Raised round lawn with a stone curb.
  const R = 6.4;
  b.add(m.stoneLight, lathe([[R - 0.3, 0], [R, 0], [R + 0.02, 0.28], [R - 0.04, 0.32], [R - 0.3, 0.32], [R - 0.3, 0]], 64), T(X0, y0, Z0));
  b.add(m.grass, lathe([[R - 0.3, 0.22], [0, 0.22]], 64), T(X0, y0, Z0));
  b.setOptions(m.grass, { castShadow: false });

  // Low shrubs ringing the plinth: a dark leafy core with crossed leaf cards for a ragged outline.
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2 + 0.2;
    const r = 2.6 + (i % 3) * 0.25;
    const s = 0.45 + ((i * 7) % 5) * 0.06;
    const M = T(X0 + Math.cos(a) * r, y0 + 0.2, Z0 + Math.sin(a) * r, a, 0, 0, [1, 0.8, 1.2]);
    b.add(m.hedge, lathe([[0, 0], [s * 0.62, 0.05], [s * 0.66, s * 0.34], [s * 0.42, s * 0.62], [0, s * 0.7]], 10), M);
    b.add(signs.material, crossCards(env.plants.shrub, s * 1.9, s * 1.3, 4, a), M);
  }

  // Fence: posts, two rails and hoop panels (green wrought iron), 0.85 m on the curb.
  const fr = R - 0.12, fy = y0 + 0.32;
  const posts = 48;
  const hoop = arcTube(0.16, 0.012, 0, Math.PI * 2, 24, 4);
  for (let i = 0; i < posts; i++) {
    const a = (i / posts) * Math.PI * 2;
    const px = X0 + Math.cos(a) * fr, pz = Z0 + Math.sin(a) * fr;
    b.add(m.greenIron, box(0.035, 0.85, 0.035), T(px, fy, pz, -a));
    b.add(m.greenIron, lathe([[0, 0], [0.04, 0], [0.03, 0.05], [0, 0.09]], 6), T(px, fy + 0.85, pz));
    const am = a + Math.PI / posts;
    b.add(m.greenIron, hoop.clone(), T(X0 + Math.cos(am) * fr, fy + 0.42, Z0 + Math.sin(am) * fr, -(Math.PI / 2 + am)));
  }
  hoop.dispose();
  for (const h of [0.12, 0.72]) b.add(m.greenIron, arcTubeRing(fr, 0.014), T(X0, fy + h, Z0));

  // Plinth: stone base course, roughcast block, projecting cap.
  const pw = 2.3, pd = 2.6, ph = 3.0;
  const py = y0 + 0.22;
  b.add(m.stoneLight, box(pw + 0.5, 0.35, pd + 0.5), T(X0, py, Z0));
  b.add(m.plasterWhite, box(pw, ph, pd), T(X0, py + 0.35, Z0));
  b.add(m.stoneLight, box(pw + 0.2, 0.28, pd + 0.2), T(X0, py + 0.35 + ph, Z0));
  b.add(m.stoneLight, box(pw - 0.2, 0.3, pd - 0.3), T(X0, py + 0.63 + ph, Z0));
  for (const [dx, dz, ry] of [[pw / 2, 0, Math.PI / 2], [-pw / 2, 0, -Math.PI / 2], [0, pd / 2, 0], [0, -pd / 2, Math.PI]] as const) {
    const len = ry === 0 || ry === Math.PI ? pw : pd;
    b.add(m.stoneLight, molding(PROFILES.base(0.5), len + 0.02), T(X0 + dx, py + 0.35, Z0 + dz, ry));
  }

  // Marble plaques on the east face (the statue's front).
  const plaque = (w: number, h: number, draw: (c: CanvasRenderingContext2D, W: number, H: number) => void) =>
    signs.draw(Math.round(w * 300), Math.round(h * 300), (c, p, W, H) => {
      const grd = c.createLinearGradient(0, 0, W, H);
      grd.addColorStop(0, '#f1eee8'); grd.addColorStop(0.5, '#e6e2da'); grd.addColorStop(1, '#efebe3');
      c.fillStyle = grd; c.fillRect(0, 0, W, H);
      c.strokeStyle = 'rgba(120,110,95,0.18)'; c.lineWidth = 2;
      for (let i = 0; i < 9; i++) { c.beginPath(); c.moveTo(((i * 0.37) % 1) * W, 0); c.bezierCurveTo(W * 0.3, H * 0.4, W * 0.7, H * 0.6, ((i * 0.61 + 0.2) % 1) * W, H); c.stroke(); } // marble veins
      c.strokeStyle = 'rgba(90,80,70,0.45)'; c.lineWidth = 6; c.strokeRect(3, 3, W - 6, H - 6);
      p.fillStyle = 'rgb(0,90,0)'; p.fillRect(0, 0, W, H);
      c.fillStyle = '#2f2a24'; c.textAlign = 'center'; c.textBaseline = 'middle';
      draw(c, W, H);
    });
  const face = X0 + pw / 2 + 0.012;
  // every line is fitted to 88 % of its plaque's width (the Arabic names are long)
  const line = (c: CanvasRenderingContext2D, t: string, W: number, x: number, y: number, weight: number, size: number) => {
    fitFont(c, t, W * 0.88, weight, size);
    c.fillText(t, x, y);
  };
  const top = plaque(1.9, 0.8, (c, W, H) => {
    c.direction = 'rtl';
    line(c, 'تكريما للمفكر العظيم', W, W / 2, H * 0.3, 600, H * 0.2);
    line(c, 'عبد الرحمن ابن خلدون', W, W / 2, H * 0.66, 700, H * 0.26);
  });
  const mid = plaque(1.0, 1.15, (c, W, H) => {
    c.direction = 'rtl';
    line(c, 'ولي الدين عبد الرحمن', W, W / 2, H * 0.16, 600, H * 0.085);
    line(c, 'ابن خلدون', W, W / 2, H * 0.42, 800, H * 0.2);
    line(c, 'ولد بهذه المدينة', W, W / 2, H * 0.64, 600, H * 0.08);
    c.direction = 'ltr';
    fitFont(c, '1406 - 1332', W * 0.4, 600, H * 0.07); c.fillText('808 - 732', W * 0.73, H * 0.85); c.fillText('1406 - 1332', W * 0.27, H * 0.85);
  });
  const low = plaque(1.0, 0.45, (c, W, H) => {
    c.direction = 'ltr';
    line(c, 'IBN KHALDOUN', W, W / 2, H * 0.25, 700, H * 0.2);
    line(c, '1332 - 1406', W, W / 2, H * 0.5, 600, H * 0.17);
    line(c, 'PHILOSOPHE, HISTORIEN ET SOCIOLOGUE', W, W / 2, H * 0.77, 600, H * 0.12);
  });
  // stacked from the base moulding (top at py + 0.63) to under the cap (py + 3.35)
  b.add(signs.material, signs.plane(top, 1.9, 0.8), T(face, py + 2.43, Z0, Math.PI / 2));
  b.add(signs.material, signs.plane(mid, 1.0, 1.15), T(face, py + 1.2, Z0, Math.PI / 2));
  b.add(signs.material, signs.plane(low, 1.0, 0.45), T(face, py + 0.7, Z0, Math.PI / 2));
  b.setOptions(signs.material, { castShadow: false });

  const root = b.build('ibnKhaldoun');
  // The bronze figure (own mesh: it is the only bronze in this part of the map).
  const fig = statueLOD('ibnKhaldoun:statue', statue, far, m.bronze);
  fig.position.set(X0, py + 0.93 + ph, Z0);
  fig.rotation.y = Math.PI / 2; // statue faces +Z → east (+X)
  const group = new Group();
  group.add(root, fig);

  // Colliders: lawn (steppable), fence ring (low), plinth + figure.
  env.cylinder(X0, y0, Z0, R, 0.3, G.STATIC);
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    env.box(X0 + Math.cos(a) * fr, fy + 0.45, Z0 + Math.sin(a) * fr, 0.05, 0.45, fr * Math.sin(Math.PI / 24) + 0.05, -a, G.LOW_PROP);
  }
  env.aabb(X0 - pw / 2 - 0.25, py, Z0 - pd / 2 - 0.25, X0 + pw / 2 + 0.25, py + ph + 0.95, Z0 + pd / 2 + 0.25);
  env.cylinder(X0, py + ph + 0.95, Z0, 0.9, 3.4);
  return { root: group };
}

/** Full horizontal ring tube (fence rail) in the XZ plane. */
function arcTubeRing(r: number, tr: number): BufferGeometry {
  return arcTube(r, tr, 0, Math.PI * 2, 96, 4).rotateX(Math.PI / 2);
}

