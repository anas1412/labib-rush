// Café terraces on the sidewalks (CAFE_TERRACES): marble bistro tables, rattan chairs, square
// parasols and glass windbreaks carrying generic bilingual café names (Arabic + French, canvas
// text in Cairo). Everything but the glass goes into the per-chunk StaticBatch (one atlas material).
import * as THREE from 'three';
import type { BuildContext } from '../../core/types';
import { G } from '../../core/physics';
import { CURB, CAFE_TERRACES, Z } from '../../core/layout';
import { Owned, Space, StaticBatch, bake, cylCollider, lathe, makeRng, obbCollider, paint, range, tube, xf, type Place } from './common';
import { canvas2d, canvasTexture } from './canvas';

type Cell = [number, number, number, number];
const D = 1024; // atlas design space
const cell = (x: number, y: number, w: number, h: number): Cell => [x / D, 1 - (y + h) / D, (x + w) / D, 1 - y / D];
const C = {
  name: (i: number) => cell(0, i * 76, 1024, 72),
  fabric: (i: number) => cell(i * 128, 464, 128, 128),
  metal: cell(776, 472, 48, 48),
  marble: cell(840, 472, 112, 112),
  rattan: cell(968, 472, 48, 48),
  seat: cell(8, 608, 112, 112),
  wood: cell(136, 608, 48, 48),
  terracotta: cell(200, 608, 48, 48),
  soil: cell(264, 608, 48, 48),
  menu: cell(320, 600, 256, 384),
};

/** Generic names (no real businesses). */
const CAFES = [
  { fr: 'Café El Yasmine', ar: 'مقهى الياسمين', fabric: '#1f5f4a', text: '#f3ecd8' },
  { fr: "Café de l'Avenue", ar: 'مقهى الشارع', fabric: '#8c1c22', text: '#f6eedc' },
  { fr: 'Salon de Thé Zitouna', ar: 'صالون شاي الزيتونة', fabric: '#e6dcc4', text: '#2d4a3a' },
  { fr: 'Café Carthage', ar: 'مقهى قرطاج', fabric: '#1c3f6e', text: '#f4efe2' },
  { fr: 'Café El Medina', ar: 'مقهى المدينة', fabric: '#c49a3c', text: '#3a2412' },
  { fr: 'Café El Bahira', ar: 'مقهى البحيرة', fabric: '#2f6f8f', text: '#f6f2e6' },
];

function cafeAtlas(ctx: BuildContext): THREE.CanvasTexture {
  const size = ctx.quality === 'ultra' ? 2048 : 1024;
  const { c, g } = canvas2d(size, size);
  g.scale(size / D, size / D);
  const r = makeRng(313);
  g.fillStyle = '#777';
  g.fillRect(0, 0, D, D);
  CAFES.forEach((cf, i) => {
    const y = i * 76;
    g.fillStyle = cf.fabric;
    g.fillRect(0, y, D, 72);
    g.fillStyle = cf.text;
    g.fillRect(0, y + 5, D, 3);
    g.fillRect(0, y + 64, D, 3);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '700 40px Cairo';
    const ar = cf.ar, fr = cf.fr;
    // Arabic on the right, French on the left, a small star between
    g.direction = 'rtl';
    g.fillText(ar, D * 0.73, y + 38, D * 0.44);
    g.direction = 'ltr';
    g.font = '700 38px Cairo';
    g.fillText(fr, D * 0.27, y + 38, D * 0.44);
    g.fillText('✦', D / 2, y + 37);
    // fabric swatch with a faint weave
    const fx = i * 128;
    g.fillStyle = cf.fabric;
    g.fillRect(fx, 464, 128, 128);
    for (let k = 0; k < 128; k += 4) {
      g.fillStyle = 'rgba(255,255,255,0.05)';
      g.fillRect(fx + k, 464, 2, 128);
      g.fillStyle = 'rgba(0,0,0,0.05)';
      g.fillRect(fx, 464 + k, 128, 2);
    }
  });
  const flat = (x: number, y: number, w: number, h: number, col: string) => {
    g.fillStyle = col;
    g.fillRect(x, y, w, h);
  };
  flat(768, 464, 64, 64, '#262a28');
  // marble with veins
  flat(832, 464, 128, 128, '#ece9e2');
  g.strokeStyle = 'rgba(120,120,125,0.35)';
  g.lineWidth = 1.5;
  for (let k = 0; k < 7; k++) {
    g.beginPath();
    let x = 832 + r() * 128, y = 464 + r() * 128;
    g.moveTo(x, y);
    for (let s = 0; s < 6; s++) g.lineTo((x += range(r, -25, 25)), (y += range(r, -25, 25)));
    g.stroke();
  }
  // rattan frame: honey brown with dark bands
  flat(960, 464, 64, 64, '#a8773f');
  for (let k = 0; k < 64; k += 8) flat(960, 464 + k, 64, 2, '#6b4520');
  // woven seat: red / cream Parisian weave
  for (let y = 0; y < 128; y += 16) {
    for (let x = 0; x < 128; x += 16) flat(x, 600 + y, 16, 16, (x + y) / 16 % 2 ? '#b8242a' : '#efe4cc');
  }
  flat(128, 600, 64, 64, '#7a5232');
  flat(192, 600, 64, 64, '#b35f38');
  flat(256, 600, 64, 64, '#2e2218');
  // A-frame chalk menu
  {
    const x = 320, y = 600;
    flat(x, y, 256, 384, '#1f2a24');
    g.strokeStyle = '#6d4f2e';
    g.lineWidth = 10;
    g.strokeRect(x + 5, y + 5, 246, 374);
    g.fillStyle = '#f2efe6';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const rows: [string, number][] = [['قهوة • Café', 52], ['كابوسان', 108], ['Capucin', 144], ['تاي • Thé', 200], ['عصير • Jus', 256], ['شيشة • Chicha', 312]];
    rows.forEach(([t, yy], k) => {
      g.font = k === 0 ? '800 34px Cairo' : '600 28px Cairo';
      g.fillText(t, x + 128, y + yy, 230);
    });
  }
  return canvasTexture(c, true, ctx.renderer);
}

/** Remaps a primitive's 0..1 UVs into an atlas cell. */
function inCell(g: THREE.BufferGeometry, c: Cell): THREE.BufferGeometry {
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    const u = THREE.MathUtils.clamp(uv.getX(i), 0, 1), v = THREE.MathUtils.clamp(uv.getY(i), 0, 1);
    uv.setXY(i, c[0] + u * (c[2] - c[0]), c[1] + v * (c[3] - c[1]));
  }
  return g;
}

function tableGeometry(): THREE.BufferGeometry {
  return bake([
    inCell(xf(new THREE.CylinderGeometry(0.3, 0.3, 0.03, 20), { p: [0, 0.74, 0] }), C.marble),
    inCell(xf(new THREE.CylinderGeometry(0.028, 0.034, 0.66, 6, 1, true), { p: [0, 0.39, 0] }), C.metal),
    inCell(lathe([[0.25, 0], [0.24, 0.03], [0.12, 0.06], [0.05, 0.1], [0.035, 0.14]], 12), C.metal),
  ]);
}

function chairGeometry(): THREE.BufferGeometry {
  const rt = (pts: [number, number, number][], rad: number) => inCell(tube(pts, rad, pts.length > 3 ? 3 : pts.length > 2 ? 2 : 1, 3), C.rattan);
  const parts: THREE.BufferGeometry[] = [inCell(xf(new THREE.BoxGeometry(0.42, 0.035, 0.4), { p: [0, 0.46, 0] }), C.seat)];
  for (const s of [-1, 1]) {
    parts.push(rt([[s * 0.19, 0.46, 0.18], [s * 0.2, 0.2, 0.2], [s * 0.21, 0, 0.22]], 0.014));
    parts.push(rt([[s * 0.21, 0, -0.22], [s * 0.19, 0.3, -0.19], [s * 0.18, 0.6, -0.21], [s * 0.17, 0.87, -0.25]], 0.014));
    parts.push(rt([[s * 0.21, 0.46, 0.2], [s * 0.21, 0.46, -0.2]], 0.016));
  }
  parts.push(rt([[-0.21, 0.46, 0.2], [0.21, 0.46, 0.2]], 0.016));
  parts.push(rt([[-0.2, 0.18, 0.2], [0.2, 0.18, 0.2]], 0.01));
  parts.push(rt([[-0.2, 0.18, -0.2], [0.2, 0.18, -0.2]], 0.01));
  for (const y of [0.72, 0.87]) parts.push(rt([[-0.17, y - 0.02, -0.24], [0, y + 0.01, -0.29], [0.17, y - 0.02, -0.24]], 0.016));
  for (const x of [-0.07, 0.07]) parts.push(rt([[x, 0.47, -0.2], [x, 0.72, -0.265]], 0.009));
  return bake(parts);
}

export interface CafesResult {
  meshes: THREE.Object3D[];
  tables: THREE.Vector3[];
  chairs: THREE.Vector3[];
}

export function buildCafes(ctx: BuildContext, o: Owned, space: Space, batch: StaticBatch, foliage: THREE.Material): CafesResult {
  const r = makeRng(5150);
  const tex = o.add(cafeAtlas(ctx));
  const atlas = o.add(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.62 }));
  const glass = o.add(new THREE.MeshStandardMaterial({ color: 0xe4f0f0, roughness: 0.04, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide }));
  const tables: Place[] = [], chairs: Place[] = [];
  const merged = { atlas: [] as THREE.BufferGeometry[], glass: [] as THREE.BufferGeometry[], shrubs: [] as THREE.BufferGeometry[] };
  const tableAnchors: THREE.Vector3[] = [], chairAnchors: THREE.Vector3[] = [];

  CAFE_TERRACES.forEach((t, ci) => {
    const side = t.side;
    const zAt = (d: number) => side * (Z.southFacade - d); // d = distance from the facade line
    const toward = side > 0 ? Math.PI : 0; // yaw that faces the road (away from the facade)
    space.rect(t.xMin - 0.3, t.xMax + 0.3, zAt(0), zAt(5.4));
    const name = C.name(ci), fabric = C.fabric(ci);

    // tables in two rows, chairs facing each other across each table (+ one street-side chair)
    let n = 0;
    for (const d of [1.35, 3.3]) {
      for (let x = t.xMin + 1.3 + (d > 2 ? 1.15 : 0); x < t.xMax - 1.0; x += 2.3) {
        const tx = x + range(r, -0.1, 0.1), tz = zAt(d) + range(r, -0.08, 0.08);
        tables.push({ x: tx, y: CURB, z: tz, ry: r() * Math.PI });
        tableAnchors.push(new THREE.Vector3(tx, CURB + 0.757, tz));
        cylCollider(o, ctx, tx, tz, CURB, CURB + 0.76, 0.3, G.LOW_PROP);
        const seats: [number, number, number][] = [[-0.55, 0, Math.PI / 2], [0.55, 0, -Math.PI / 2]];
        if (d > 2 && n++ % 2 === 0) seats.push([0, -side * 0.58, toward + Math.PI]);
        for (const [dx, dz, ry] of seats) {
          const cx = tx + dx + range(r, -0.04, 0.04), cz = tz + dz + range(r, -0.04, 0.04), cry = ry + range(r, -0.25, 0.25);
          chairs.push({ x: cx, y: CURB, z: cz, ry: cry });
          chairAnchors.push(new THREE.Vector3(cx, CURB + 0.46, cz));
          obbCollider(o, ctx, cx, CURB + 0.45, cz, 0.21, 0.45, 0.21, cry, G.LOW_PROP);
        }
      }
    }

    // square parasols with the café name on the valance
    for (let x = t.xMin + 2.4; x < t.xMax - 1.4; x += 4.6) {
      const pz = zAt(2.33);
      const at = (g: THREE.BufferGeometry) => merged.atlas.push(xf(g, { p: [x, CURB, pz] }));
      at(inCell(new THREE.CylinderGeometry(0.024, 0.024, 2.78, 6).translate(0, 1.39, 0), C.metal));
      at(inCell(new THREE.BoxGeometry(0.46, 0.09, 0.46).translate(0, 0.045, 0), C.metal));
      const H0 = 2.78, H1 = 2.25, R = 1.5;
      const cn: [number, number][] = [[-R, -R], [R, -R], [R, R], [-R, R]];
      for (let k = 0; k < 4; k++) {
        const [ax, az] = cn[k], [bx, bz] = cn[(k + 1) % 4];
        // canopy panel: top face + underside (the atlas material is single-sided)
        const cu = (fabric[0] + fabric[2]) / 2, cv = (fabric[1] + fabric[3]) / 2;
        for (const [p, uvs] of [
          [[0, H0, 0, bx, H1, bz, ax, H1, az], [cu, cv, fabric[2], fabric[1], fabric[0], fabric[1]]],
          [[0, H0 - 0.01, 0, ax, H1 - 0.01, az, bx, H1 - 0.01, bz], [cu, cv, fabric[0], fabric[1], fabric[2], fabric[1]]],
        ]) {
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
          g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
          g.computeVertexNormals();
          at(g);
        }
        // valance hanging from this edge: printed outside, plain fabric inside
        const mx = (ax + bx) / 2, mz = (az + bz) / 2, len = Math.hypot(bx - ax, bz - az), yaw = Math.atan2(mx, mz);
        at(inCell(xf(new THREE.PlaneGeometry(len, 0.22), { p: [mx, H1 - 0.11, mz], r: [0, yaw, 0] }), name));
        at(inCell(xf(new THREE.PlaneGeometry(len, 0.22), { p: [mx * 0.998, H1 - 0.11, mz * 0.998], r: [0, yaw + Math.PI, 0] }), fabric));
        at(inCell(tube([[0, H0 - 0.03, 0], [ax * 0.5, (H0 + H1) / 2 - 0.05, az * 0.5], [ax * 0.98, H1 - 0.02, az * 0.98]], 0.012, 6, 4), C.metal));
      }
      cylCollider(o, ctx, x, pz, CURB, CURB + 2.2, 0.05, G.LOW_PROP);
    }

    // glass windbreak along the walkway edge, with an entrance gap and a menu board
    const zs = zAt(4.6), mid = (t.xMin + t.xMax) / 2;
    const screen = (x0: number, x1: number) => {
      const w = x1 - x0, cx = (x0 + x1) / 2;
      const at = (g: THREE.BufferGeometry) => merged.atlas.push(xf(g, { p: [cx, CURB, zs] }));
      for (const px of [-w / 2, w / 2]) at(inCell(new THREE.BoxGeometry(0.06, 1.2, 0.06).translate(px, 0.6, 0), C.wood));
      at(inCell(new THREE.BoxGeometry(w, 0.05, 0.06).translate(0, 1.2, 0), C.wood));
      at(inCell(new THREE.BoxGeometry(w - 0.06, 0.28, 0.035).translate(0, 0.19, 0), name));
      merged.glass.push(xf(new THREE.PlaneGeometry(w - 0.06, 0.83).translate(0, 0.745, 0), { p: [cx, CURB, zs] }));
      obbCollider(o, ctx, cx, CURB + 0.6, zs, w / 2, 0.6, 0.05, 0, G.LOW_PROP);
    };
    const seg = (a: number, b: number) => {
      const count = Math.max(1, Math.round((b - a) / 1.9));
      for (let k = 0; k < count; k++) screen(a + ((b - a) * k) / count + 0.02, a + ((b - a) * (k + 1)) / count - 0.02);
    };
    seg(t.xMin, mid - 0.9);
    seg(mid + 0.9, t.xMax);
    // A-frame menu board just outside the entrance
    {
      const bx = mid + 1.25, bz = zAt(5.05);
      const board = inCell(new THREE.PlaneGeometry(0.52, 0.78), C.menu);
      // two boards leaning together at the top, each facing outward
      for (const turn of [0, Math.PI]) {
        merged.atlas.push(xf(xf(board.clone(), { r: [-0.2, 0, 0], p: [0, 0.4, 0.08] }), { p: [bx, CURB, bz], r: [0, toward + turn, 0] }));
      }
      board.dispose();
      obbCollider(o, ctx, bx, CURB + 0.4, bz, 0.28, 0.4, 0.18, 0, G.LOW_PROP);
    }
    // potted shrubs at both ends of the windbreak
    for (const px of [t.xMin + 0.35, t.xMax - 0.35]) {
      merged.atlas.push(xf(inCell(lathe([[0, 0], [0.2, 0], [0.26, 0.5], [0.29, 0.52], [0.29, 0.56], [0, 0.56]], 14), C.terracotta), { p: [px, CURB, zAt(4.95)] }));
      const shrub = new THREE.IcosahedronGeometry(0.36, 2);
      const pos = shrub.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) pos.setY(i, pos.getY(i) * 1.25);
      shrub.computeVertexNormals();
      merged.shrubs.push(paint(xf(shrub, { p: [px, CURB + 0.95, zAt(4.95)] }), 0x9ab27a));
      cylCollider(o, ctx, px, zAt(4.95), CURB, CURB + 1.3, 0.3, G.LOW_PROP);
    }
  });

  const table = tableGeometry(), chair = chairGeometry();
  batch.place(table, atlas, tables, 'street-cafe', true);
  batch.place(chair, atlas, chairs, 'street-cafe', true);
  table.dispose();
  chair.dispose();
  for (const g of merged.atlas) batch.add(g, atlas, 'street-cafe', true);
  for (const g of merged.shrubs) batch.add(g, foliage, 'street-hedges', true);
  const glassMesh = new THREE.Mesh(o.add(bake(merged.glass)), glass);
  glassMesh.name = 'street-cafe-glass';
  return { meshes: [glassMesh], tables: tableAnchors, chairs: chairAnchors };
}
