// Promenade kiosks (newspapers, flowers, snacks), each with a stack of crates so Labib can hop
// onto the roof (≈2.3 m). Magazine covers, newspapers, fascia signs, menu and snack bags are
// procedural (canvas atlas, generic words only — no real titles or brands).
import * as THREE from 'three';
import type { BuildContext } from '../../core/types';
import { G } from '../../core/physics';
import { CURB, KIOSKS } from '../../core/layout';
import { Owned, StaticBatch, bake, makeRng, metricBox, obbCollider, paint, range, uvScale, xf, type Place } from './common';
import { canvas2d, canvasTexture } from './canvas';
import type { StreetMaterials } from './materials';

const KIOSK_ROOF = 2.3; // roof top above the promenade
const HW = 1.5, HD = 1.2; // body half width (x) / depth (z)

type Cell = [number, number, number, number]; // u0 v0 u1 v1
const A = 2048; // atlas design space
const cell = (x: number, y: number, w: number, h: number): Cell => [x / A, 1 - (y + h) / A, (x + w) / A, 1 - y / A];
const CELLS = {
  cover: (i: number) => cell((i % 8) * 160, Math.floor(i / 8) * 213, 160, 213),
  paper: (i: number) => cell(1280 + i * 192, 0, 192, 256),
  fascia: (i: number) => cell(0, 1300 + i * 120, 2048, 120),
  menu: cell(0, 1664, 512, 384),
  awning: (i: number) => cell(512 + i * 256, 1664, 256, 256),
  chips: (i: number) => cell(1024 + i * 128, 1664, 128, 170),
  dark: cell(1296, 280, 96, 96),
  zinc: cell(1408, 280, 96, 96),
  cream: cell(1520, 280, 96, 96),
};

const TITLES = ['SPORT', 'CUISINE', 'VOYAGES', 'AUTO', 'MODE', 'SANTÉ', 'CINÉMA', 'MUSIQUE', 'MAISON', 'ENFANTS', 'SCIENCES', 'DÉCO', 'JEUX', 'NATURE',
  'رياضة', 'مطبخ', 'سفر', 'صحة', 'أطفال', 'فنون', 'موضة', 'علوم', 'سيارات', 'ديكور'];

function printAtlas(ctx: BuildContext): THREE.CanvasTexture {
  const size = ctx.quality === 'ultra' ? 2048 : 1024;
  const { c, g } = canvas2d(size, size);
  g.scale(size / A, size / A);
  const r = makeRng(808);
  g.fillStyle = '#222';
  g.fillRect(0, 0, A, A);
  const hsl = (h: number, s: number, l: number) => `hsl(${h},${s}%,${l}%)`;
  const lines = (x: number, y: number, w: number, n: number, col: string, gap = 12) => {
    g.fillStyle = col;
    for (let i = 0; i < n; i++) g.fillRect(x, y + i * gap, w * (0.6 + r() * 0.4), 5);
  };
  // magazine covers
  for (let i = 0; i < 48; i++) {
    const x = (i % 8) * 160, y = Math.floor(i / 8) * 213, W = 160, H = 213;
    const hue = r() * 360;
    const bg = g.createLinearGradient(x, y, x, y + H);
    bg.addColorStop(0, hsl(hue, 55 + r() * 30, 35 + r() * 30));
    bg.addColorStop(1, hsl(hue + r() * 60 - 30, 50 + r() * 30, 20 + r() * 25));
    g.fillStyle = bg;
    g.fillRect(x + 2, y + 2, W - 4, H - 4);
    // cover art: portrait / landscape / object
    const kind = Math.floor(r() * 3);
    if (kind === 0) {
      g.fillStyle = hsl(r() * 40 + 15, 40, 55 + r() * 20);
      g.beginPath();
      g.ellipse(x + W / 2, y + 102, 26, 32, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = hsl(r() * 360, 50, 30 + r() * 30);
      g.beginPath();
      g.ellipse(x + W / 2, y + 196, 62, 60, 0, Math.PI, 0);
      g.fill();
      g.fillStyle = hsl(20 + r() * 20, 30, 12 + r() * 20);
      g.beginPath();
      g.ellipse(x + W / 2, y + 82, 30, 18, 0, Math.PI, 0);
      g.fill();
    } else if (kind === 1) {
      g.fillStyle = hsl(200 + r() * 20, 60, 55);
      g.fillRect(x + 8, y + 60, W - 16, 60);
      g.fillStyle = hsl(195, 60, 35);
      g.fillRect(x + 8, y + 120, W - 16, 30);
      g.fillStyle = hsl(40, 55, 70);
      g.fillRect(x + 8, y + 150, W - 16, 40);
    } else {
      g.fillStyle = '#f2efe8';
      g.beginPath();
      g.arc(x + W / 2, y + 130, 48, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = hsl(r() * 60, 70, 45);
      g.beginPath();
      g.arc(x + W / 2, y + 130, 32, 0, Math.PI * 2);
      g.fill();
    }
    // masthead
    const title = TITLES[Math.floor(r() * TITLES.length)];
    const ar = /[\u0600-\u06ff]/.test(title);
    g.fillStyle = r() < 0.5 ? '#fff' : hsl(hue + 180, 80, 60);
    g.textAlign = 'center';
    g.textBaseline = 'top';
    g.font = ar ? '800 40px Cairo' : '800 34px Cairo';
    g.direction = ar ? 'rtl' : 'ltr';
    g.fillText(title, x + W / 2, y + 4, W - 14);
    g.direction = 'ltr';
    lines(x + 12, y + 160, 70, 3, 'rgba(255,255,255,0.85)', 11);
    g.fillStyle = r() < 0.5 ? '#ffd400' : '#e8173a';
    g.beginPath();
    g.arc(x + W - 30, y + 70, 16, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#fff';
    g.fillRect(x + W - 40, y + H - 30, 30, 20);
    g.fillStyle = '#000';
    for (let k = 0; k < 9; k++) g.fillRect(x + W - 38 + k * 3, y + H - 28, 1 + (k % 2), 16);
  }
  // newspaper fronts (generic 'Actualités / أخبار')
  for (let i = 0; i < 4; i++) {
    const x = 1280 + i * 192, W = 192, H = 256;
    g.fillStyle = '#ece8df';
    g.fillRect(x + 2, 2, W - 4, H - 4);
    g.fillStyle = i % 2 ? '#b01c1c' : '#1b2f5c';
    g.fillRect(x + 8, 8, W - 16, 34);
    g.fillStyle = '#fff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const ar = i % 2 === 1;
    g.direction = ar ? 'rtl' : 'ltr';
    g.font = '800 26px Cairo';
    g.fillText(ar ? 'أخبار' : 'ACTUALITÉS', x + W / 2, 26, W - 24);
    g.direction = 'ltr';
    g.fillStyle = '#1a1a1a';
    g.fillRect(x + 10, 50, W - 20, 14);
    g.fillRect(x + 10, 68, W - 50, 14);
    g.fillStyle = '#8c8c8c';
    g.fillRect(x + 10, 90, 100, 70);
    lines(x + 118, 92, 60, 6, '#555', 11);
    for (let col = 0; col < 3; col++) lines(x + 10 + col * 58, 170, 50, 7, '#666', 11);
  }
  // fascia bands
  const fascia = (i: number, text: string, bg: string, fg: string) => {
    const y = 1300 + i * 120;
    g.fillStyle = bg;
    g.fillRect(0, y, A, 120);
    g.fillStyle = fg;
    g.fillRect(0, y + 8, A, 4);
    g.fillRect(0, y + 108, A, 4);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '800 70px Cairo';
    g.fillText(text, A / 2, y + 62, A - 80);
  };
  fascia(0, 'JOURNAUX  •  جرائد  •  MAGAZINES  •  مجلات', '#15392c', '#f1e4c2');
  fascia(1, 'FLEURS  •  أزهار  •  JASMIN  •  مشموم', '#15392c', '#f1e4c2');
  fascia(2, 'CASSE-CROÛTE  •  كسكروت  •  CAFÉ  •  قهوة', '#7a1717', '#f7ecd3');
  // snack menu (chalkboard)
  {
    const x = 0, y = 1664;
    g.fillStyle = '#23302a';
    g.fillRect(x, y, 512, 384);
    g.strokeStyle = '#8a6a44';
    g.lineWidth = 14;
    g.strokeRect(x + 7, y + 7, 498, 370);
    g.fillStyle = '#f3f1e8';
    g.textBaseline = 'middle';
    g.font = '800 40px Cairo';
    g.textAlign = 'center';
    g.fillText('MENU  •  قائمة', x + 256, y + 44);
    const items: [string, string, string][] = [
      ['Casse-croûte thon', 'كسكروت تن', '3,500'], ['Fricassé', 'فريكاسي', '1,200'], ['Brik à l\'œuf', 'بريك', '2,000'],
      ['Café express', 'قهوة', '1,500'], ['Thé à la menthe', 'تاي بالنعناع', '1,200'], ['Jus d\'orange', 'عصير برتقال', '3,000'],
    ];
    items.forEach(([fr, ar, p], k) => {
      const yy = y + 100 + k * 46;
      g.font = '600 26px Cairo';
      g.textAlign = 'left';
      g.fillText(fr, x + 28, yy);
      g.textAlign = 'right';
      g.direction = 'rtl';
      g.fillText(ar, x + 380, yy);
      g.direction = 'ltr';
      g.textAlign = 'right';
      g.fillText(p, x + 490, yy);
    });
  }
  // awning stripes (green/white, red/white)
  for (let i = 0; i < 2; i++) {
    const x = 512 + i * 256, y = 1664;
    for (let k = 0; k < 8; k++) {
      g.fillStyle = k % 2 ? '#f3efe4' : i === 0 ? '#1d5a3c' : '#b3201e';
      g.fillRect(x + k * 32, y, 32, 256);
    }
    g.fillStyle = 'rgba(0,0,0,0.12)';
    g.fillRect(x, y + 200, 256, 56);
  }
  // snack bags (generic 'CHIPS' foil packets)
  for (let i = 0; i < 6; i++) {
    const x = 1024 + i * 128, y = 1664, hue = [48, 0, 210, 120, 28, 280][i];
    const gr = g.createLinearGradient(x, y, x + 128, y);
    gr.addColorStop(0, hsl(hue, 80, 35));
    gr.addColorStop(0.5, hsl(hue, 85, 55));
    gr.addColorStop(1, hsl(hue, 80, 38));
    g.fillStyle = gr;
    g.fillRect(x + 4, y + 4, 120, 162);
    g.fillStyle = '#f6d36b';
    g.beginPath();
    g.ellipse(x + 64, y + 110, 34, 22, 0.3, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#fff';
    g.font = '800 30px Cairo';
    g.textAlign = 'center';
    g.fillText('CHIPS', x + 64, y + 50, 110);
  }
  g.fillStyle = '#0f1310';
  g.fillRect(1296, 280, 96, 96);
  g.fillStyle = '#9aa0a3';
  g.fillRect(1408, 280, 96, 96);
  g.fillStyle = '#efe6d2';
  g.fillRect(1520, 280, 96, 96);
  return canvasTexture(c, true, ctx.renderer);
}

/** Painted sheet-metal panels (1 m × 2 m tile): seams, rivets, grime at the foot. Colour + bump. */
function panelTextures(ctx: BuildContext): { map: THREE.CanvasTexture; bump: THREE.CanvasTexture } {
  const W = 256, H = 512;
  const col = canvas2d(W, H), bmp = canvas2d(W, H);
  const r = makeRng(99);
  col.g.fillStyle = '#ffffff';
  col.g.fillRect(0, 0, W, H);
  bmp.g.fillStyle = '#808080';
  bmp.g.fillRect(0, 0, W, H);
  // grime rising from the pavement + faint vertical streaks
  const gr = col.g.createLinearGradient(0, H, 0, H * 0.72);
  gr.addColorStop(0, 'rgba(60,50,40,0.45)');
  gr.addColorStop(1, 'rgba(60,50,40,0)');
  col.g.fillStyle = gr;
  col.g.fillRect(0, 0, W, H);
  for (let i = 0; i < 40; i++) {
    col.g.fillStyle = `rgba(40,40,35,${0.03 + r() * 0.05})`;
    col.g.fillRect(r() * W, r() * H * 0.6, 1 + r() * 2, 20 + r() * 120);
  }
  for (const x of [0, W / 2]) {
    col.g.fillStyle = 'rgba(0,0,0,0.35)';
    col.g.fillRect(x, 0, 3, H);
    bmp.g.fillStyle = '#202020';
    bmp.g.fillRect(x, 0, 3, H);
    bmp.g.fillStyle = '#b0b0b0';
    bmp.g.fillRect(x + 3, 0, 3, H);
    for (let y = 12; y < H; y += 32) {
      bmp.g.fillStyle = '#e0e0e0';
      bmp.g.beginPath();
      bmp.g.arc(x + 12, y, 3, 0, Math.PI * 2);
      bmp.g.fill();
    }
  }
  col.g.fillStyle = 'rgba(0,0,0,0.3)';
  col.g.fillRect(0, H / 2, W, 3);
  bmp.g.fillStyle = '#202020';
  bmp.g.fillRect(0, H / 2, W, 3);
  const map = canvasTexture(col.c, true, ctx.renderer, true), bump = canvasTexture(bmp.c, false, ctx.renderer, true);
  return { map, bump };
}

/** Plane with atlas UVs, facing +Z. */
function card(w: number, h: number, c: Cell): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, c[0] + uv.getX(i) * (c[2] - c[0]), c[1] + uv.getY(i) * (c[3] - c[1]));
  return g;
}
/** Box whose every face samples one atlas cell. */
function cellBox(w: number, h: number, d: number, c: Cell): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, c[0] + uv.getX(i) * (c[2] - c[0]), c[1] + uv.getY(i) * (c[3] - c[1]));
  return g;
}

function crateGeometry(tile: number): THREE.BufferGeometry {
  const W = 0.62, H = 0.5, D = 0.5, parts: THREE.BufferGeometry[] = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) parts.push(xf(metricBox(0.045, H, 0.045, tile), { p: [sx * (W / 2 - 0.022), H / 2, sz * (D / 2 - 0.022)] }));
  for (const y of [0.06, 0.24, 0.42]) {
    for (const sz of [-1, 1]) parts.push(xf(metricBox(W, 0.1, 0.016, tile, true), { p: [0, y + 0.05, sz * (D / 2 - 0.008)] }));
    for (const sx of [-1, 1]) parts.push(xf(metricBox(0.016, 0.1, D - 0.03, tile), { p: [sx * (W / 2 - 0.008), y + 0.05, 0] }));
  }
  for (const z of [-0.16, 0, 0.16]) parts.push(xf(metricBox(W - 0.03, 0.016, 0.1, tile, true), { p: [0, 0.03, z] }));
  parts.push(xf(metricBox(W - 0.04, 0.01, D - 0.04, tile, true), { p: [0, 0.035, 0] }));
  return bake(parts);
}

export interface KiosksResult {
  meshes: THREE.Object3D[];
  roofs: THREE.Vector3[];
}

export function buildKiosks(ctx: BuildContext, o: Owned, M: StreetMaterials, batch: StaticBatch): KiosksResult {
  const r = makeRng(1717);
  const atlasTex = o.add(printAtlas(ctx));
  const print = o.add(new THREE.MeshStandardMaterial({ map: atlasTex, roughness: 0.62, side: THREE.DoubleSide }));
  const panel = panelTextures(ctx);
  o.add(panel.map);
  o.add(panel.bump);
  const paintMat = o.add(new THREE.MeshStandardMaterial({ color: 0x1e4a3a, map: panel.map, bumpMap: panel.bump, bumpScale: 1.5, roughness: 0.42, metalness: 0.35 }));
  const glass = o.add(new THREE.MeshStandardMaterial({ color: 0xdfeeee, roughness: 0.05, metalness: 0, transparent: true, opacity: 0.22, depthWrite: false }));
  const parts = { paint: [] as THREE.BufferGeometry[], print: [] as THREE.BufferGeometry[], zinc: [] as THREE.BufferGeometry[], vc: [] as THREE.BufferGeometry[], glass: [] as THREE.BufferGeometry[] };
  const roofs: THREE.Vector3[] = [];
  const crates: Place[] = [];

  for (const k of KIOSKS) {
    const ry = k.z > 0 ? Math.PI : 0; // front faces the central walk
    const m = new THREE.Matrix4().makeRotationY(ry).setPosition(k.x, CURB, k.z);
    const P = (g: THREE.BufferGeometry, list: THREE.BufferGeometry[]) => list.push(g.applyMatrix4(m));
    // painted panels: metric UVs, one texture tile = 1 m wide × 2 m tall
    const box = (w: number, h: number, d: number, x: number, y: number, z: number) => P(xf(uvScale(metricBox(w, h, d, 1), 1, 0.5), { p: [x, y, z] }), parts.paint);

    // body shell, corner posts, roof tray with cornice
    box(HW * 2, 0.12, HD * 2, 0, 0.06, 0);
    box(HW * 2, 2.08, 0.06, 0, 1.16, -HD + 0.03);
    for (const s of [-1, 1]) box(0.06, 2.08, HD * 2, s * (HW - 0.03), 1.16, 0);
    box(HW * 2, 0.95, 0.06, 0, 0.595, HD - 0.03);
    box(HW * 2, 0.2, 0.06, 0, 2.1, HD - 0.03);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(0.1, 2.08, 0.1, sx * (HW - 0.02), 1.16, sz * (HD - 0.02));
    box(3.5, 0.1, 2.9, 0, KIOSK_ROOF - 0.05, 0); // top face = KIOSK_ROOF = collider top
    for (const s of [-1, 1]) {
      box(3.5, 0.07, 0.06, 0, KIOSK_ROOF - 0.035 + 0.01, s * 1.42);
      box(0.06, 0.07, 2.9, s * 1.72, KIOSK_ROOF - 0.035 + 0.01, 0);
    }
    P(xf(metricBox(3.2, 0.05, 0.5, M.tile.wood, true), { p: [0, 1.1, HD + 0.08] }), parts.paint); // counter
    // dark interior
    P(xf(card(2.9, 1.9, CELLS.dark), { p: [0, 1.1, -HD + 0.07] }), parts.print);
    P(xf(card(2.9, 2.3, CELLS.dark), { p: [0, 2.19, 0], r: [Math.PI / 2, 0, 0] }), parts.print);
    // fascia sign on the front and both sides, just under the roof
    const fi = k.kind === 'newspaper' ? 0 : k.kind === 'flowers' ? 1 : 2;
    const [f0, f1, f2, f3] = CELLS.fascia(fi);
    P(xf(card(3.5, 0.26, [f0, f1, f2, f3]), { p: [0, 2.05, 1.455] }), parts.print);
    for (const s of [-1, 1]) P(xf(card(2.9, 0.26, [f0, f1, f2, f3]), { p: [s * 1.755, 2.05, 0], r: [0, s * Math.PI / 2, 0] }), parts.print);
    box(3.52, 0.3, 0.03, 0, 2.05, 1.43);
    for (const s of [-1, 1]) box(0.03, 0.3, 2.9, s * 1.735, 2.05, 0);
    // striped awning over the window
    const aw = CELLS.awning(k.kind === 'snack' ? 1 : 0);
    const awning = card(3.0, 0.62, aw);
    P(xf(awning, { p: [0, 1.66, HD + 0.26], r: [-1.05, 0, 0] }), parts.print);
    P(xf(card(3.0, 0.14, [aw[0], aw[1], aw[2], aw[1] + (aw[3] - aw[1]) * 0.25]), { p: [0, 1.46, HD + 0.52] }), parts.print);

    // magazine racks (all kiosks show some press; the newspaper kiosk is covered in it)
    const mags = (n: number, w: number, x0: number, y: number, z: number, rotY: number, tilt: number) => {
      for (let i = 0; i < n; i++) {
        const g = card(0.2, 0.27, CELLS.cover(Math.floor(r() * 48)));
        P(xf(xf(g, { r: [tilt, 0, 0], p: [x0 + i * w + range(r, -0.01, 0.01), y, 0] }), { r: [0, rotY, 0], p: [0, 0, z] }), parts.print);
      }
    };
    const rackRows = k.kind === 'newspaper' ? [0.3, 0.6, 0.9] : [0.9];
    for (const y of rackRows) {
      mags(12, 0.235, -1.3, y, HD + 0.05, 0, -0.22);
      P(xf(new THREE.BoxGeometry(2.9, 0.012, 0.06), { p: [0, y - 0.14, HD + 0.08] }), parts.zinc);
    }
    if (k.kind === 'newspaper') {
      for (const s of [-1, 1]) {
        for (const y of [0.45, 0.8, 1.15, 1.5]) {
          const g: THREE.BufferGeometry[] = [];
          for (let i = 0; i < 8; i++) g.push(xf(card(0.2, 0.27, CELLS.cover(Math.floor(r() * 48))), { p: [-0.95 + i * 0.27, y, 0], r: [-0.18, 0, 0] }));
          const row = bake(g);
          P(xf(row, { r: [0, s * Math.PI / 2, 0], p: [s * (HW + 0.03), 0, 0] }), parts.print);
          P(xf(new THREE.BoxGeometry(0.05, 0.012, 2.2), { p: [s * (HW + 0.05), y - 0.14, 0] }), parts.zinc);
        }
      }
      // magazines hanging on lines inside the window + newspaper piles on the counter
      for (const y of [1.55, 1.85]) mags(10, 0.28, -1.26, y, 0.95, 0, 0);
      for (let i = 0; i < 4; i++) {
        const c = CELLS.paper(i);
        P(xf(cellBox(0.36, 0.06, 0.26, CELLS.cream), { p: [-1.1 + i * 0.5, 1.155, HD + 0.08] }), parts.print);
        P(xf(card(0.36, 0.26, c), { p: [-1.1 + i * 0.5, 1.187, HD + 0.08], r: [-Math.PI / 2, 0, 0] }), parts.print);
      }
    } else if (k.kind === 'flowers') {
      // three-tier stand of zinc buckets with bouquets in front, jasmine 'mashmoum' on the counter
      const palette = [0xc8102e, 0xf0e6e0, 0xf2c14e, 0xe56b9a, 0x9b3fb5, 0xff7f3f];
      for (let t = 0; t < 3; t++) {
        const y = 0.12 + t * 0.26, z = HD + 0.65 - t * 0.2;
        box(2.8, 0.05, 0.3, 0, y, z);
        for (let i = 0; i < 6; i++) {
          const x = -1.15 + i * 0.46;
          P(xf(new THREE.CylinderGeometry(0.13, 0.1, 0.26, 12, 1, true), { p: [x, y + 0.155, z] }), parts.zinc);
          const col = palette[Math.floor(r() * palette.length)];
          for (let b = 0; b < 16; b++) {
            const a = r() * Math.PI * 2, d = Math.sqrt(r()) * 0.14;
            P(paint(xf(new THREE.IcosahedronGeometry(range(r, 0.035, 0.05), 0), { p: [x + Math.cos(a) * d, y + 0.42 + range(r, 0, 0.12) - d * 0.4, z + Math.sin(a) * d] }), col), parts.vc);
          }
          for (let b = 0; b < 6; b++) {
            const a = r() * Math.PI * 2;
            P(paint(xf(new THREE.OctahedronGeometry(0.05, 0), { p: [x + Math.cos(a) * 0.12, y + 0.36, z + Math.sin(a) * 0.12], s: [1, 0.4, 1.6], r: [0, a, 0] }), 0x2f6b2a), parts.vc);
          }
        }
      }
      for (let i = 0; i < 9; i++) {
        const x = -1.2 + i * 0.3, z = HD + 0.06;
        P(paint(xf(new THREE.CylinderGeometry(0.006, 0.006, 0.22, 4), { p: [x, 1.24, z] }), 0x6b5a3a), parts.vc);
        for (let b = 0; b < 22; b++) {
          const a = r() * Math.PI * 2, e = r() * 1.2;
          P(paint(xf(new THREE.OctahedronGeometry(0.014, 0), { p: [x + Math.cos(a) * Math.cos(e) * 0.045, 1.37 + Math.sin(e) * 0.04, z + Math.sin(a) * Math.cos(e) * 0.045] }), 0xfbfaf4), parts.vc);
        }
      }
      obbCollider(o, ctx, k.x, CURB + 0.45, k.z + (k.z > 0 ? -1 : 1) * (HD + 0.45), 1.45, 0.45, 0.4, ry, G.LOW_PROP);
    } else {
      // snack: glass display on the counter, menu board on the side, bags in the window
      P(xf(new THREE.BoxGeometry(2.0, 0.34, 0.4), { p: [-0.3, 1.3, HD + 0.08] }), parts.glass);
      P(xf(new THREE.BoxGeometry(2.02, 0.02, 0.42), { p: [-0.3, 1.48, HD + 0.08] }), parts.zinc);
      for (let i = 0; i < 8; i++) {
        P(paint(xf(new THREE.CapsuleGeometry(0.035, 0.16, 3, 8), { p: [-1.15 + i * 0.24, 1.17, HD + 0.08], r: [0, 0, Math.PI / 2] }), 0xc8914f), parts.vc);
        if (i % 2) P(paint(xf(new THREE.ConeGeometry(0.07, 0.02, 3), { p: [-1.1 + i * 0.24, 1.2, HD + 0.16] }), 0xd9a55a), parts.vc);
      }
      for (let i = 0; i < 9; i++) P(xf(card(0.13, 0.17, CELLS.chips(i % 6)), { p: [-1.2 + i * 0.3, 1.8 + (i % 2) * 0.04, 0.95] }), parts.print);
      P(xf(card(0.85, 0.64, CELLS.menu), { p: [-HW - 0.045, 1.35, 0], r: [0, -Math.PI / 2, 0] }), parts.print);
      box(0.03, 0.7, 0.9, -HW - 0.02, 1.35, 0);
    }

    // colliders: body up to under the roof, roof slab to KIOSK_ROOF (standable)
    obbCollider(o, ctx, k.x, CURB + 1.08, k.z, HW, 1.08, HD, ry, G.STATIC);
    obbCollider(o, ctx, k.x, CURB + (2.16 + KIOSK_ROOF) / 2, k.z, 1.75, (KIOSK_ROOF - 2.16) / 2, 1.45, ry, G.STATIC);
    const w = (lx: number, lz: number) => new THREE.Vector3(lx, 0, lz).applyAxisAngle(new THREE.Vector3(0, 1, 0), ry).add(new THREE.Vector3(k.x, 0, k.z));
    for (const [lx, lz] of [[0, 0], [-1.1, -0.85], [1.1, -0.85], [-1.1, 0.85], [1.1, 0.85]]) roofs.push(w(lx, lz).setY(CURB + KIOSK_ROOF));

    // crate steps on the kiosk's +x side: single crate, then a stack of two against the kiosk
    // the stack stands clear of the roof overhang (1.75) so Labib fits on it before the last hop
    for (const [lx, lz, y] of [[2.22, 0.1, 0], [2.22, 0.1, 0.5], [2.9, 0.2, 0]]) {
      const p = w(lx, lz);
      const jitter = range(r, -0.08, 0.08);
      crates.push({ x: p.x, y: CURB + y, z: p.z, ry: ry + jitter });
      obbCollider(o, ctx, p.x, CURB + y + 0.25, p.z, 0.31, 0.25, 0.25, ry + jitter, G.LOW_PROP);
    }
  }

  const merged = (list: THREE.BufferGeometry[], mat: THREE.Material, name: string, cast: boolean) => {
    const mesh = new THREE.Mesh(o.add(bake(list)), mat);
    mesh.name = name;
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    return mesh;
  };
  const meshes: THREE.Object3D[] = [
    merged(parts.paint, paintMat, 'street-kiosk-body', true),
    merged(parts.print, print, 'street-kiosk-print', false),
    merged(parts.zinc, M.galvanized, 'street-kiosk-zinc', false),
    merged(parts.vc, M.vcolor, 'street-kiosk-goods', false),
    merged(parts.glass, glass, 'street-kiosk-glass', false),
  ];
  const crate = crateGeometry(M.tile.wood);
  batch.place(crate, M.wood, crates, 'street-wood', true);
  crate.dispose();
  return { meshes, roofs };
}

