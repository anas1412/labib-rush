// Procedural canvas textures for every prop (drawn once at load; fonts must be loaded first).
// Layout constants are shared with the geometry code that maps UVs into these atlases.
// Everything is generic: made-up names, no real brands or logos.
import type { CanvasTexture, WebGLRenderer } from 'three';
import { canvas, canvasTex, field, pixels, rng, whitePatch, type Ctx2D } from './util';

const BALOO = '800 {s}px "Baloo Bhaijaan 2", Cairo, sans-serif';
const CAIRO = '700 {s}px Cairo, sans-serif';
const CAIRO_X = '800 {s}px Cairo, sans-serif';

const font = (f: string, s: number) => f.replace('{s}', String(Math.round(s)));

function text(g: Ctx2D, t: string, x: number, y: number, f: string, size: number, fill: string, maxW = 1e9, align: CanvasTextAlign = 'center'): void {
  g.font = font(f, size);
  const w = g.measureText(t).width;
  if (w > maxW) g.font = font(f, (size * maxW) / w);
  g.textAlign = align;
  g.textBaseline = 'middle';
  g.fillStyle = fill;
  g.fillText(t, x, y);
}

function outlinedText(g: Ctx2D, t: string, x: number, y: number, f: string, size: number, fill: string, stroke: string, lw: number, maxW = 1e9): void {
  g.font = font(f, size);
  const w = g.measureText(t).width;
  if (w > maxW) g.font = font(f, (size * maxW) / w);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  g.lineWidth = lw;
  g.strokeStyle = stroke;
  g.strokeText(t, x, y);
  g.fillStyle = fill;
  g.fillText(t, x, y);
}

/** Canvas at logical size (w,h) × quality scale; the context is pre-scaled to logical units. */
function scaled(w: number, h: number, s: number): { c: HTMLCanvasElement; g: Ctx2D } {
  const r = canvas(Math.round(w * s), Math.round(h * s));
  r.g.scale(s, s);
  return r;
}

// ---------------------------------------------------------------------------------------------
// Soda cans: 3 flavour bands of 1024×512 stacked. Within a band (top→bottom of the canvas):
// rows 0..44 top lid metal, 44..468 printed label, 468..512 bottom metal. Two logos around.
export const CAN_BAND = { h: 512, labelTop: 44, labelBottom: 468, count: 3 } as const;

interface CanFlavour { top: string; bottom: string; ink: string; accent: string; name: string; ar: string; fruit: (g: Ctx2D, x: number, y: number, r: number) => void }

const orangeSlice = (g: Ctx2D, x: number, y: number, r: number) => {
  g.fillStyle = '#ffb000'; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#fff3c4'; g.beginPath(); g.arc(x, y, r * 0.86, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#ff9a00';
  for (let i = 0; i < 9; i++) {
    const a0 = (i / 9) * Math.PI * 2 + 0.06, a1 = ((i + 1) / 9) * Math.PI * 2 - 0.06;
    g.beginPath(); g.moveTo(x, y); g.arc(x, y, r * 0.8, a0, a1); g.closePath(); g.fill();
  }
};
const lemonSlice = (g: Ctx2D, x: number, y: number, r: number) => {
  g.fillStyle = '#f7e017'; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#fffbe0'; g.beginPath(); g.arc(x, y, r * 0.86, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#f2e44a';
  for (let i = 0; i < 8; i++) {
    const a0 = (i / 8) * Math.PI * 2 + 0.07, a1 = ((i + 1) / 8) * Math.PI * 2 - 0.07;
    g.beginPath(); g.moveTo(x, y); g.arc(x, y, r * 0.8, a0, a1); g.closePath(); g.fill();
  }
};
const pomegranate = (g: Ctx2D, x: number, y: number, r: number) => {
  g.fillStyle = '#c4123a'; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#e8315a'; g.beginPath(); g.arc(x - r * 0.25, y - r * 0.25, r * 0.55, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#7d0a26'; g.beginPath();
  g.moveTo(x - r * 0.25, y - r * 0.9); g.lineTo(x, y - r * 1.25); g.lineTo(x + r * 0.25, y - r * 0.9); g.fill();
  const rand = rng(7);
  g.fillStyle = '#ff5c7a';
  for (let i = 0; i < 12; i++) {
    const a = rand() * Math.PI * 2, d = rand() * r * 0.55;
    g.beginPath(); g.ellipse(x + r * 0.2 + Math.cos(a) * d, y + r * 0.2 + Math.sin(a) * d, r * 0.09, r * 0.12, a, 0, Math.PI * 2); g.fill();
  }
};

const FLAVOURS: CanFlavour[] = [
  { top: '#ff9d00', bottom: '#ff3b00', ink: '#ffffff', accent: '#8a1c00', name: 'orange', ar: 'برتقال', fruit: orangeSlice },
  { top: '#c5ec2a', bottom: '#189a4a', ink: '#ffffff', accent: '#0b5a2a', name: 'citron', ar: 'ليمون', fruit: lemonSlice },
  { top: '#e0186a', bottom: '#7a0a3a', ink: '#ffffff', accent: '#ffcf4a', name: 'grenade', ar: 'رمان', fruit: pomegranate },
];

function brushedMetal(g: Ctx2D, x: number, y: number, w: number, h: number, seed: number): void {
  const grd = g.createLinearGradient(0, y, 0, y + h);
  grd.addColorStop(0, '#d9dde1'); grd.addColorStop(0.5, '#aeb4ba'); grd.addColorStop(1, '#cfd3d8');
  g.fillStyle = grd;
  g.fillRect(x, y, w, h);
  const r = rng(seed);
  g.globalAlpha = 0.15;
  for (let i = 0; i < 60; i++) {
    g.fillStyle = r() > 0.5 ? '#ffffff' : '#6d737a';
    g.fillRect(x, y + r() * h, w, 0.6);
  }
  g.globalAlpha = 1;
}

export function canTexture(renderer: WebGLRenderer, s: number): CanvasTexture {
  const W = 1024, H = CAN_BAND.h * CAN_BAND.count;
  const { c, g } = scaled(W, H, s);
  FLAVOURS.forEach((f, i) => {
    const y0 = i * CAN_BAND.h;
    const lt = y0 + CAN_BAND.labelTop, lb = y0 + CAN_BAND.labelBottom, lh = lb - lt;
    brushedMetal(g, 0, y0, W, CAN_BAND.labelTop, 11 + i);
    brushedMetal(g, 0, lb, W, CAN_BAND.h - CAN_BAND.labelBottom, 21 + i);
    g.save();
    g.beginPath(); g.rect(0, lt, W, lh); g.clip();
    const grd = g.createLinearGradient(0, lt, 0, lb);
    grd.addColorStop(0, f.top); grd.addColorStop(1, f.bottom);
    g.fillStyle = grd; g.fillRect(0, lt, W, lh);
    // swooshes
    g.globalAlpha = 0.85;
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.moveTo(0, lt + lh * 0.73);
    for (let x = 0; x <= W; x += 8) g.lineTo(x, lt + lh * (0.72 + 0.05 * Math.sin((x / W) * Math.PI * 4)));
    for (let x = W; x >= 0; x -= 8) g.lineTo(x, lt + lh * (0.77 + 0.04 * Math.sin((x / W) * Math.PI * 4 + 0.8)));
    g.fill();
    g.globalAlpha = 0.14;
    g.beginPath();
    for (let x = 0; x <= W; x += 8) g.lineTo(x, lt + lh * (0.12 + 0.05 * Math.sin((x / W) * Math.PI * 4 + 2)));
    g.lineTo(W, lt); g.lineTo(0, lt); g.fill();
    // bubbles
    const r = rng(100 + i);
    for (let k = 0; k < 70; k++) {
      g.globalAlpha = 0.15 + r() * 0.35;
      g.strokeStyle = '#ffffff'; g.lineWidth = 2;
      g.beginPath(); g.arc(r() * W, lt + r() * lh, 3 + r() * 12, 0, Math.PI * 2); g.stroke();
    }
    g.globalAlpha = 1;
    // two logos around the can
    for (const cx of [256, 768]) {
      f.fruit(g, cx + 150, lt + lh * 0.42, 52);
      outlinedText(g, 'GAZOUZ', cx - 30, lt + lh * 0.36, BALOO, 118, f.ink, f.accent, 14, 330);
      outlinedText(g, 'قازوز', cx - 30, lt + lh * 0.6, BALOO, 70, f.ink, f.accent, 10, 260);
      text(g, `${f.name} · ${f.ar}`, cx - 30, lt + lh * 0.88, CAIRO_X, 34, f.name === 'grenade' ? '#ffcf4a' : f.accent, 300);
    }
    g.restore();
    // rims: thin dark lines where the label meets the metal
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.fillRect(0, lt, W, 2); g.fillRect(0, lb - 2, W, 2);
  });
  whitePatch(g);
  return canvasTex(c, renderer);
}

// ---------------------------------------------------------------------------------------------
// Bottles: 1024×1024. Water label band rows 32..512, golden label 528..1008 (the label is
// 0.29 m around × 0.135 m tall, so 480 rows keep the print unstretched).
export const BOTTLE_ATLAS = { W: 1024, H: 1024, water: [32, 512], gold: [528, 1008] } as const;

export function bottleTexture(renderer: WebGLRenderer, s: number): CanvasTexture {
  const { W, H } = BOTTLE_ATLAS;
  const { c, g } = scaled(W, H, s);
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
  // --- water label: saturated blue so a lying bottle reads as "water" from 8 m away
  {
    const [t, b] = BOTTLE_ATLAS.water, h = b - t;
    const grd = g.createLinearGradient(0, t, 0, b);
    grd.addColorStop(0, '#1d8ae6'); grd.addColorStop(0.6, '#0d5fc0'); grd.addColorStop(1, '#083f8c');
    g.fillStyle = grd; g.fillRect(0, t, W, h);
    // white top trim + light mountain range behind the name (all the way round)
    g.fillStyle = '#ffffff'; g.fillRect(0, t, W, h * 0.05);
    g.fillStyle = '#7cc4f4';
    g.beginPath(); g.moveTo(0, b);
    for (let x = 0; x <= W; x += 4) g.lineTo(x, t + h * (0.8 - 0.22 * Math.max(0, Math.sin((x / 512) * Math.PI)) * (0.7 + 0.3 * Math.sin(x * 0.05))));
    g.lineTo(W, b); g.fill();
    g.fillStyle = '#e8f6ff';
    for (const mx of [256, 768]) { g.beginPath(); g.moveTo(mx - 60, t + h * 0.63); g.lineTo(mx, t + h * 0.58); g.lineTo(mx + 60, t + h * 0.64); g.lineTo(mx + 14, t + h * 0.66); g.fill(); }
    g.fillStyle = '#ffffff';
    g.fillRect(0, b - h * 0.13, W, h * 0.13);
    // water drop emblem
    g.fillStyle = '#ffffff';
    g.beginPath(); g.moveTo(256, t + h * 0.09);
    g.bezierCurveTo(300, t + h * 0.2, 290, t + h * 0.29, 256, t + h * 0.29);
    g.bezierCurveTo(222, t + h * 0.29, 212, t + h * 0.2, 256, t + h * 0.09); g.fill();
    outlinedText(g, 'Nabaa', 256, t + h * 0.41, BALOO, 120, '#ffffff', '#083f8c', 10, 400);
    text(g, 'نبع', 256, t + h * 0.6, BALOO, 70, '#ffffff', 220);
    text(g, 'EAU MINÉRALE NATURELLE', 256, b - h * 0.065, CAIRO_X, 30, '#0d5fc0', 440);
    // back: composition table + Arabic text
    text(g, 'مياه معدنية طبيعية', 768, t + h * 0.14, CAIRO_X, 44, '#ffffff', 440);
    text(g, 'Composition moyenne en mg/L', 768, t + h * 0.26, CAIRO, 24, '#d8eeff', 440);
    const rows = [['Calcium', '68'], ['Magnésium', '21'], ['Sodium', '18'], ['Bicarbonates', '240'], ['Résidu sec à 180°C', '380']];
    rows.forEach(([k, v], i) => {
      text(g, k, 600, t + h * (0.34 + i * 0.066), CAIRO, 20, '#ffffff', 300, 'left');
      text(g, v, 930, t + h * (0.34 + i * 0.066), CAIRO, 20, '#ffffff', 100, 'right');
    });
    g.fillStyle = '#23384d';
    for (let i = 0; i < 34; i++) g.fillRect(620 + i * 6 + (i % 3), b - h * 0.12 + 4, i % 4 === 0 ? 3 : 1.5, h * 0.09);
    text(g, '1,5 L', 950, b - h * 0.065, CAIRO_X, 36, '#0d5fc0', 120);
    text(g, '1,5 L', 470, t + h * 0.14, CAIRO_X, 34, '#ffffff', 100);
  }
  // --- golden label: pale gold foil with a deep-gold star, so the whole bottle reads as gold
  {
    const [t, b] = BOTTLE_ATLAS.gold, h = b - t;
    const grd = g.createLinearGradient(0, t, 0, b);
    grd.addColorStop(0, '#fff0b8'); grd.addColorStop(0.5, '#ffd873'); grd.addColorStop(1, '#ffeaa6');
    g.fillStyle = grd; g.fillRect(0, t, W, h);
    g.fillStyle = '#b86a08';
    g.fillRect(0, t + 10, W, 12); g.fillRect(0, b - 22, W, 12);
    for (const cx of [256, 768]) {
      star(g, cx, t + h * 0.4, 96, 40, '#c46f04');
      star(g, cx, t + h * 0.4, 70, 29, '#fff3c4');
      text(g, 'ذهبية', cx, t + h * 0.72, BALOO, 64, '#7a3d00', 300);
      text(g, "BOUTEILLE D'OR", cx, t + h * 0.87, CAIRO_X, 28, '#7a3d00', 300);
    }
  }
  whitePatch(g);
  return canvasTex(c, renderer);
}

function star(g: Ctx2D, x: number, y: number, R: number, r: number, fill: string | CanvasGradient): void {
  g.fillStyle = fill;
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5, d = i % 2 ? r : R;
    g.lineTo(x + Math.cos(a) * d, y + Math.sin(a) * d);
  }
  g.closePath();
  g.fill();
}

// ---------------------------------------------------------------------------------------------
// Chips bags: 1024×1024, quadrants [flavour][front/back] of 512×512 (u across, v up the bag).
// Crimped seals occupy the top and bottom 11% of each face.
export const CHIPS_SEAL = 0.11;

export function chipsTextures(renderer: WebGLRenderer, s: number): { map: CanvasTexture; data: CanvasTexture } {
  const { c, g } = scaled(1024, 1024, s);
  const flav = [
    { bg0: '#e3141b', bg1: '#8e0610', band: '#ffd000', name: 'Harissa', ar: 'هريسة' },
    { bg0: '#1b8fe0', bg1: '#0a3f86', band: '#ffffff', name: 'Nature', ar: 'بالملح' },
  ];
  flav.forEach((f, fi) => {
    for (let side = 0; side < 2; side++) {
      const x0 = side * 512, y0 = fi * 512;
      g.save();
      g.beginPath(); g.rect(x0, y0, 512, 512); g.clip();
      const grd = g.createRadialGradient(x0 + 256, y0 + 230, 20, x0 + 256, y0 + 256, 360);
      grd.addColorStop(0, f.bg0); grd.addColorStop(1, f.bg1);
      g.fillStyle = grd; g.fillRect(x0, y0, 512, 512);
      // sunburst
      g.globalAlpha = 0.12; g.fillStyle = '#ffffff';
      for (let i = 0; i < 18; i++) {
        const a = (i / 18) * Math.PI * 2;
        g.beginPath(); g.moveTo(x0 + 256, y0 + 250);
        g.arc(x0 + 256, y0 + 250, 420, a, a + 0.12); g.fill();
      }
      g.globalAlpha = 1;
      if (side === 0) {
        // pile of chips
        const r = rng(40 + fi);
        for (let k = 0; k < 16; k++) {
          const cx = x0 + 140 + r() * 240, cy = y0 + 330 + r() * 70;
          g.save(); g.translate(cx, cy); g.rotate(r() * 3);
          const cg = g.createLinearGradient(-40, -25, 40, 25);
          cg.addColorStop(0, '#ffe07a'); cg.addColorStop(1, '#d99a2b');
          g.fillStyle = cg;
          g.beginPath(); g.ellipse(0, 0, 42, 28, 0, 0, Math.PI * 2); g.fill();
          g.strokeStyle = 'rgba(150,90,20,0.5)'; g.lineWidth = 2;
          g.beginPath(); g.ellipse(0, 0, 30, 18, 0, 0.3, 2.5); g.stroke();
          g.restore();
        }
        if (fi === 0) {
          // chilli
          g.save(); g.translate(x0 + 400, y0 + 300); g.rotate(-0.6);
          g.fillStyle = '#c10d0d';
          g.beginPath(); g.moveTo(-10, -60); g.quadraticCurveTo(30, 0, 0, 70); g.quadraticCurveTo(-30, 0, -10, -60); g.fill();
          g.fillStyle = '#2f8a1f'; g.fillRect(-16, -72, 16, 16);
          g.restore();
        }
        outlinedText(g, 'CHIPS', x0 + 256, y0 + 150, BALOO, 150, '#ffffff', f.bg1, 16, 440);
        outlinedText(g, 'شيبس', x0 + 256, y0 + 240, BALOO, 84, f.band, f.bg1, 12, 300);
        g.fillStyle = f.band;
        g.beginPath(); g.roundRect(x0 + 96, y0 + 395, 320, 44, 22); g.fill();
        text(g, `${f.name} · ${f.ar}`, x0 + 256, y0 + 418, CAIRO_X, 30, f.bg1, 300);
      } else {
        text(g, 'شيبس', x0 + 256, y0 + 110, BALOO, 70, '#ffffff', 300);
        g.fillStyle = 'rgba(255,255,255,0.92)';
        g.beginPath(); g.roundRect(x0 + 70, y0 + 170, 372, 170, 14); g.fill();
        const lines = ['Ingrédients : pommes de terre,', 'huile végétale, sel, épices.', 'المكونات: بطاطا، زيت نباتي، ملح', 'Poids net 45 g'];
        lines.forEach((l, i) => text(g, l, x0 + 256, y0 + 200 + i * 38, CAIRO, 22, '#333333', 340));
        g.fillStyle = '#ffffff'; g.fillRect(x0 + 160, y0 + 360, 190, 70);
        g.fillStyle = '#111111';
        for (let i = 0; i < 40; i++) g.fillRect(x0 + 168 + i * 4.3, y0 + 366, i % 3 ? 1.6 : 2.8, 52);
      }
      // crimped seals (silver foil with teeth)
      for (const sy of [y0, y0 + 512 * (1 - CHIPS_SEAL)]) {
        const sg = g.createLinearGradient(0, sy, 0, sy + 512 * CHIPS_SEAL);
        sg.addColorStop(0, '#9aa0a8'); sg.addColorStop(0.5, '#e6e9ec'); sg.addColorStop(1, '#8a9098');
        g.fillStyle = sg; g.fillRect(x0, sy, 512, 512 * CHIPS_SEAL);
        g.fillStyle = 'rgba(0,0,0,0.18)';
        for (let x = 0; x < 512; x += 7) g.fillRect(x0 + x, sy, 2.5, 512 * CHIPS_SEAL);
      }
      g.restore();
    }
  });
  whitePatch(g);
  // data: R = bump (crinkle creases + crimp teeth), G = roughness, B = metalness
  const d = canvas(Math.round(256 * s), Math.round(256 * s));
  const DW = d.c.width;
  // creases rasterised once into a height buffer (each over its own bounding box)
  const crease = new Float32Array(DW * DW);
  const rr = rng(5);
  for (let i = 0; i < 70; i++) {
    const x = rr(), y = rr(), a = rr() * Math.PI, l = 0.05 + rr() * 0.25, sign = rr() > 0.5 ? 1 : -1;
    const dx = Math.cos(a) * l, dy = Math.sin(a) * l;
    const x0 = Math.max(0, Math.floor((Math.min(x, x + dx) - 0.02) * DW)), x1 = Math.min(DW - 1, Math.ceil((Math.max(x, x + dx) + 0.02) * DW));
    const y0 = Math.max(0, Math.floor((Math.min(y, y + dy) - 0.02) * DW)), y1 = Math.min(DW - 1, Math.ceil((Math.max(y, y + dy) + 0.02) * DW));
    for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) {
      const ux = px / DW - x, uy = py / DW - y;
      const t = Math.max(0, Math.min(1, (ux * dx + uy * dy) / (dx * dx + dy * dy)));
      const dist = Math.hypot(ux - dx * t, uy - dy * t);
      if (dist < 0.012) crease[py * DW + px] += (0.012 - dist) * 14 * sign;
    }
  }
  const crinkle = field(20, 20, 4, 1), grain = field(40, 40, 1, 3);
  pixels(d.g, 0, 0, DW, DW, (u, v, o) => {
    const vv = (v * 2) % 1; // two flavour rows share the pattern
    let h = 0.5 + 0.18 * (crinkle(u, vv) - 0.5) + crease[Math.floor(v * DW) * DW + Math.floor(u * DW)];
    const inSeal = vv < CHIPS_SEAL || vv > 1 - CHIPS_SEAL;
    if (inSeal) h = 0.5 + 0.35 * Math.sin(u * 512 * ((Math.PI * 2) / 7));
    o[0] = Math.max(0, Math.min(255, h * 255));
    o[1] = inSeal ? 90 : 120 + 40 * grain(u, vv); // roughness (×vertex rough)
    o[2] = inSeal ? 255 : 150; // metalness (×vertex metal)
  });
  return { map: canvasTex(c, renderer), data: canvasTex(d.c, renderer, false) };
}

// ---------------------------------------------------------------------------------------------
// Plastic bags: 1024×512, two variants side by side (u around the bag, v up). Alpha cuts the
// mouth between the two handles. Front centre at u = 0.25, back at 0.75 (within a variant).
export const BAG_MOUTH = { halfWidth: 0.135, bottom: 0.66, top: 0.92 } as const;

export function bagTexture(renderer: WebGLRenderer, s: number): CanvasTexture {
  const { c, g } = scaled(1024, 512, s);
  const variants = [
    { base: '#f4f6f7', ink: '#1557b0' },
    { base: '#a9d3f2', ink: '#ffffff' },
  ];
  variants.forEach((vt, i) => {
    const x0 = i * 512;
    g.fillStyle = vt.base; g.fillRect(x0, 0, 512, 512);
    // stretch wrinkles (faint vertical streaks)
    const r = rng(60 + i);
    for (let k = 0; k < 90; k++) {
      g.globalAlpha = 0.05 + r() * 0.06;
      g.fillStyle = r() > 0.5 ? '#ffffff' : '#7a8a99';
      const x = x0 + r() * 512;
      g.fillRect(x, r() * 200, 1 + r() * 3, 150 + r() * 360);
    }
    g.globalAlpha = 1;
    for (const cu of [0.25, 0.75]) {
      const cx = x0 + cu * 512;
      g.save();
      g.translate(cx, 330); g.scale(0.5, 1); // u spans the full circumference: compress x
      text(g, 'MERCI', 0, -20, BALOO, 92, vt.ink, 360);
      text(g, 'شكرا', 0, 62, BALOO, 70, vt.ink, 300);
      star(g, -170, -70, 20, 8, vt.ink); star(g, 170, -70, 20, 8, vt.ink);
      g.restore();
    }
    // bottom seal line
    g.fillStyle = 'rgba(60,80,100,0.35)';
    g.fillRect(x0, 500, 512, 4);
    // mouth cut-out: erase between the handles above the U-shaped mouth line
    g.save();
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = '#000';
    for (const cu of [0.25, 0.75]) {
      g.beginPath();
      g.moveTo(x0 + (cu - BAG_MOUTH.halfWidth) * 512, -2);
      for (let k = 0; k <= 32; k++) {
        const t = (k / 32) * 2 - 1; // −1..1 across the mouth
        const vm = BAG_MOUTH.bottom + (BAG_MOUTH.top - BAG_MOUTH.bottom) * Math.pow(Math.abs(t), 3);
        g.lineTo(x0 + (cu + t * BAG_MOUTH.halfWidth) * 512, (1 - vm) * 512);
      }
      g.lineTo(x0 + (cu + BAG_MOUTH.halfWidth) * 512, -2);
      g.closePath();
      g.fill();
    }
    g.restore();
  });
  return canvasTex(c, renderer);
}

// ---------------------------------------------------------------------------------------------
// Recycling bin wrap: 1024×512 (u around the body, v up). Front (+Z) at u = 0.25, back 0.75.

/** Möbius-style recycling symbol: three folded arrows chasing around a triangle. */
export function recycleSymbol(g: Ctx2D, cx: number, cy: number, size: number, color: string): void {
  const R = size * 0.55; // circumradius of the triangle
  const corners = [0, 1, 2].map((i) => {
    const a = -Math.PI / 2 + (i * Math.PI * 2) / 3;
    return [cx + Math.cos(a) * R, cy + Math.sin(a) * R] as const;
  });
  const lw = size * 0.13;
  g.strokeStyle = color; g.fillStyle = color;
  g.lineWidth = lw; g.lineJoin = 'round'; g.lineCap = 'butt';
  for (let i = 0; i < 3; i++) {
    const A = corners[i], B = corners[(i + 1) % 3], P = corners[(i + 2) % 3];
    const lerp2 = (p: readonly [number, number], q: readonly [number, number], t: number) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
    const start = lerp2(A, P, 0.24), end = lerp2(A, B, 0.56);
    g.beginPath();
    g.moveTo(start[0], start[1]);
    g.lineTo(A[0], A[1]);
    g.lineTo(end[0], end[1]);
    g.stroke();
    // arrowhead toward B
    const dx = B[0] - A[0], dy = B[1] - A[1], L = Math.hypot(dx, dy);
    const ux = dx / L, uy = dy / L, nx = -uy, ny = ux;
    const hw = lw * 1.25, hl = lw * 1.7;
    g.beginPath();
    g.moveTo(end[0] + nx * hw, end[1] + ny * hw);
    g.lineTo(end[0] + ux * hl, end[1] + uy * hl);
    g.lineTo(end[0] - nx * hw, end[1] - ny * hw);
    g.closePath();
    g.fill();
  }
}

export function binTexture(renderer: WebGLRenderer, s: number): CanvasTexture {
  const { c, g } = scaled(1024, 512, s);
  // powder-coated green with subtle mottling, darker grime toward the base
  const cw = c.width, ch = c.height;
  const mottle = field(40, 20, 4, 2), smear = field(12, 6, 4, 9);
  pixels(g, 0, 0, cw, ch, (u, v, o) => {
    const n = mottle(u, v) - 0.5;
    const grime = Math.pow(v, 6) * 0.35 + Math.max(0, smear(u, v) - 0.62) * 0.8 * v;
    const k = 1 + n * 0.12 - grime;
    o[0] = 24 * k; o[1] = 118 * k; o[2] = 62 * k;
  }, 0.5);
  // white bands near the top and bottom
  g.fillStyle = '#f2f2ee';
  g.fillRect(0, 34, 1024, 10);
  g.fillRect(0, 440, 1024, 6);
  for (const cu of [0.25, 0.75]) {
    const cx = cu * 1024;
    g.save();
    g.translate(cx, 0); g.scale(0.62, 1); // the squircle circumference is ~2.2 m vs 0.95 m high
    recycleSymbol(g, 0, 170, 180, '#ffffff');
    text(g, 'Recyclage', 0, 305, CAIRO_X, 70, '#ffffff', 420);
    text(g, 'رسكلة', 0, 378, CAIRO_X, 72, '#ffffff', 360);
    g.restore();
    // pictograms either side of the mark: a bottle and a can, outlined (x squeezed like the mark)
    g.strokeStyle = '#ffffff'; g.fillStyle = '#ffffff'; g.lineWidth = 5; g.lineJoin = 'round';
    for (const [dx, kind] of [[-118, 0], [118, 1]] as const) {
      g.save();
      g.translate(cx + dx, 176); g.scale(0.8, 1);
      if (kind === 0) {
        // PET bottle: cap, neck, shoulders, ribbed body
        g.fillRect(-9, -52, 18, 11);
        g.beginPath();
        g.moveTo(-7, -41); g.lineTo(-7, -33); g.quadraticCurveTo(-20, -24, -20, -8); g.lineTo(-20, 38);
        g.quadraticCurveTo(-20, 44, -14, 44); g.lineTo(14, 44); g.quadraticCurveTo(20, 44, 20, 38); g.lineTo(20, -8);
        g.quadraticCurveTo(20, -24, 7, -33); g.lineTo(7, -41);
        g.stroke();
        g.beginPath(); g.moveTo(-20, 4); g.lineTo(20, 4); g.moveTo(-20, 26); g.lineTo(20, 26); g.stroke();
      } else {
        // drink can: tapered lid, straight body, pull tab
        g.beginPath();
        g.moveTo(-14, -40); g.lineTo(14, -40); g.lineTo(19, -32); g.lineTo(19, 36); g.lineTo(15, 42);
        g.lineTo(-15, 42); g.lineTo(-19, 36); g.lineTo(-19, -32); g.closePath();
        g.stroke();
        g.fillRect(-6, -48, 12, 5);
        g.beginPath(); g.moveTo(-19, -24); g.lineTo(19, -24); g.moveTo(-19, 28); g.lineTo(19, 28); g.stroke();
      }
      g.restore();
    }
  }
  whitePatch(g);
  return canvasTex(c, renderer);
}

// ---------------------------------------------------------------------------------------------
// Taxi atlas (1024×1024) + emission mask (same layout at half resolution).
export const TAXI_ATLAS = {
  sign: (variant: number, back: boolean) => [back ? 528 : 32, 32 + variant * 192, 464, 160] as const,
  head: [32, 620, 460, 180] as const,
  tail: [528, 620, 460, 180] as const,
  grille: [32, 816, 460, 96] as const,
  /** One plate per variant (0.5 × 0.11 m on the car). */
  plate: (variant: number) => [528, 816 + variant * 66, 300, 64] as const,
  lower: [32, 928, 460, 80] as const,
};
const PLATES = [['218', '4917'], ['194', '7352'], ['231', '1086']] as const;
export const SIGN_STYLES = [
  { bg: '#fbfbf6', ink: '#111111', glow: '#fff6dc', accent: '#c8102e' },
  { bg: '#ffd21a', ink: '#141414', glow: '#ffd75a', accent: '#141414' },
  { bg: '#fbfbf6', ink: '#c8102e', glow: '#fff1e6', accent: '#111111' },
] as const;

export function taxiTextures(renderer: WebGLRenderer, s: number): { map: CanvasTexture; emit: CanvasTexture } {
  const { c, g } = scaled(1024, 1024, s);
  const e = scaled(1024, 1024, s * 0.5);
  g.fillStyle = '#808080'; g.fillRect(0, 0, 1024, 1024);
  e.g.fillStyle = '#000000'; e.g.fillRect(0, 0, 1024, 1024);
  // roof sign faces
  SIGN_STYLES.forEach((st, v) => {
    for (const back of [false, true]) {
      const [x, y, w, h] = TAXI_ATLAS.sign(v, back);
      for (const k of [g, e.g]) {
        const glow = k === e.g;
        k.fillStyle = glow ? st.glow : st.bg;
        k.fillRect(x, y, w, h);
        if (!glow) {
          const sh = k.createLinearGradient(0, y, 0, y + h);
          sh.addColorStop(0, 'rgba(255,255,255,0.35)'); sh.addColorStop(0.5, 'rgba(255,255,255,0)'); sh.addColorStop(1, 'rgba(0,0,0,0.12)');
          k.fillStyle = sh; k.fillRect(x, y, w, h);
        }
        const ink = glow ? '#000000' : st.ink;
        const acc = glow ? '#000000' : st.accent;
        if (!back) {
          text(k, 'TAXI', x + w / 2, y + h * 0.4, CAIRO_X, 104, ink, w * 0.86);
          text(k, 'تاكسي', x + w / 2, y + h * 0.82, CAIRO_X, 44, acc, w * 0.6);
        } else {
          text(k, 'تاكسي', x + w / 2, y + h * 0.42, CAIRO_X, 96, ink, w * 0.8);
          text(k, 'TAXI', x + w / 2, y + h * 0.85, CAIRO_X, 36, acc, w * 0.5);
        }
      }
    }
  });
  // headlight: chrome reflector, projector lens, LED strip, amber indicator
  {
    const [x, y, w, h] = TAXI_ATLAS.head;
    const grd = g.createLinearGradient(0, y, 0, y + h);
    grd.addColorStop(0, '#f4f6f8'); grd.addColorStop(0.5, '#9aa3ab'); grd.addColorStop(1, '#dfe4e8');
    g.fillStyle = grd; g.fillRect(x, y, w, h);
    g.fillStyle = '#20252a'; g.fillRect(x, y + h - 26, w, 26);
    for (const [cx, r] of [[x + w * 0.36, h * 0.3], [x + w * 0.7, h * 0.26]] as const) {
      const lg = g.createRadialGradient(cx - r * 0.3, y + h * 0.45 - r * 0.3, 2, cx, y + h * 0.45, r);
      lg.addColorStop(0, '#ffffff'); lg.addColorStop(0.5, '#cfd8e0'); lg.addColorStop(1, '#5b646c');
      g.fillStyle = lg; g.beginPath(); g.arc(cx, y + h * 0.45, r, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#3a4046'; g.lineWidth = 5; g.stroke();
      e.g.fillStyle = '#fff6e8'; e.g.beginPath(); e.g.arc(cx, y + h * 0.45, r * 0.85, 0, Math.PI * 2); e.g.fill();
    }
    g.fillStyle = '#ff9c1a'; g.fillRect(x + w * 0.88, y + 20, w * 0.1, h - 50);
    g.fillStyle = '#ffffff'; g.fillRect(x + w * 0.08, y + h * 0.82, w * 0.8, 8);
    e.g.fillStyle = '#ffffff'; e.g.fillRect(x + w * 0.08, y + h * 0.82, w * 0.8, 8);
    e.g.fillStyle = 'rgba(255,240,220,0.25)'; e.g.fillRect(x, y, w * 0.86, h - 26);
  }
  // taillight: red segments with a clear reverse lamp and dark bezel
  {
    const [x, y, w, h] = TAXI_ATLAS.tail;
    g.fillStyle = '#2a0508'; g.fillRect(x, y, w, h);
    const rg = g.createLinearGradient(0, y, 0, y + h);
    rg.addColorStop(0, '#d8101c'); rg.addColorStop(0.5, '#7c0008'); rg.addColorStop(1, '#b8000e');
    g.fillStyle = rg; g.fillRect(x + 8, y + 8, w * 0.62, h - 16);
    g.fillStyle = '#e8e8ea'; g.fillRect(x + w * 0.66, y + 8, w * 0.14, h - 16);
    g.fillStyle = '#ff7a00'; g.fillRect(x + w * 0.82, y + 8, w * 0.16, h - 16);
    g.strokeStyle = 'rgba(255,255,255,0.25)'; g.lineWidth = 3;
    for (let i = 1; i < 6; i++) { g.beginPath(); g.moveTo(x + 8, y + (h * i) / 6); g.lineTo(x + w * 0.64, y + (h * i) / 6); g.stroke(); }
    e.g.fillStyle = '#ff0600'; e.g.fillRect(x + 8, y + 8, w * 0.62, h - 16);
  }
  // grille: black honeycomb
  const honey = (x: number, y: number, w: number, h: number, cell: number) => {
    g.fillStyle = '#0c0d0f'; g.fillRect(x, y, w, h);
    g.strokeStyle = '#34383d'; g.lineWidth = 2;
    for (let yy = 0; yy < h + cell; yy += cell * 0.87) {
      for (let xx = 0; xx < w + cell; xx += cell) {
        const ox = ((yy / (cell * 0.87)) % 2) * cell * 0.5;
        g.beginPath();
        for (let k = 0; k < 6; k++) {
          const a = (k / 6) * Math.PI * 2 + Math.PI / 6;
          g.lineTo(x + xx + ox + Math.cos(a) * cell * 0.45, y + yy + Math.sin(a) * cell * 0.45);
        }
        g.closePath(); g.stroke();
      }
    }
  };
  {
    const [x, y, w, h] = TAXI_ATLAS.grille;
    g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip();
    honey(x, y, w, h, 18);
    g.fillStyle = '#b8bec4'; g.fillRect(x, y, w, 6); g.fillRect(x, y + h - 6, w, 6); // chrome strips
    g.restore();
  }
  {
    const [x, y, w, h] = TAXI_ATLAS.lower;
    g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip();
    honey(x, y, w, h, 14);
    g.restore();
  }
  // plates: black with a white border and "NNN تونس NNNN" (Tunisian layout), one per variant
  PLATES.forEach(([a, b], i) => {
    const [x, y, w, h] = TAXI_ATLAS.plate(i);
    g.fillStyle = '#0b0b0c'; g.fillRect(x, y, w, h);
    g.strokeStyle = '#f2f2f2'; g.lineWidth = 3.5; g.strokeRect(x + 4.5, y + 4.5, w - 9, h - 9);
    text(g, a, x + w * 0.2, y + h * 0.54, CAIRO_X, 40, '#f2f2f2', w * 0.28);
    text(g, 'تونس', x + w * 0.5, y + h * 0.5, CAIRO_X, 33, '#f2f2f2', w * 0.26);
    text(g, b, x + w * 0.8, y + h * 0.54, CAIRO_X, 40, '#f2f2f2', w * 0.3);
  });
  whitePatch(g);
  return { map: canvasTex(c, renderer), emit: canvasTex(e.c, renderer) };
}

// ---------------------------------------------------------------------------------------------
// Bambalouni: 1024×768. Doughnut (torus u = around the ring, v = around the tube) in rows
// 0..256; greaseproof paper in 0..512 × 256..768. data: R bump, G roughness.
export const BAMBA_ATLAS = { W: 1024, H: 768, ring: [0, 0, 1024, 256], paper: [0, 256, 512, 512] } as const;

export function bambalouniTextures(renderer: WebGLRenderer, s: number): { map: CanvasTexture; data: CanvasTexture } {
  const W = Math.round(1024 * s), H = Math.round(768 * s);
  const m = canvas(W, H), d = canvas(W, H);
  const ringH = Math.round(256 * s);
  // doughnut (torus uv): v = 0 outer equator, 0.25 top, 0.5 inner (hole), 0.75 bottom
  const topOf = (tv: number) => Math.cos((tv - 0.25) * Math.PI * 2); // 1 at the top
  const fry = field(60, 16, 4, 4), dust = field(90, 30, 3, 7), clump = field(24, 8, 3, 13), crust = field(120, 30, 3, 1), gloss = field(80, 20, 1, 2);
  const paperN = field(18, 18, 4, 5), oilN = field(8, 8, 3, 8), paperB = field(9, 9, 4, 11), paperF = field(60, 60, 1, 3);
  pixels(m.g, 0, 0, W, ringH, (u, v, o) => {
    const tv = 1 - v;
    const top = topOf(tv);
    const outerBand = Math.exp(-Math.pow(Math.min(tv, 1 - tv) / 0.06, 2)); // pale ring where it floated
    const n = fry(u, tv);
    // oily golden crust, deeper where it touched the hot oil longest (top and bottom)
    const fried = Math.max(0, top) * 0.9 + Math.max(0, -top) * 0.75;
    let r = 230 - 36 * fried - 36 * (n - 0.5), gg = 168 - 58 * fried - 36 * (n - 0.5), b = 80 - 46 * fried - 24 * (n - 0.5);
    r = r * (1 - outerBand) + 240 * outerBand; gg = gg * (1 - outerBand) + 200 * outerBand; b = b * (1 - outerBand) + 128 * outerBand;
    // sugar: a fine white dusting on top, thicker in clumps
    const sd = Math.pow(Math.max(0, top), 0.7) * (0.05 + 0.5 * dust(u, tv) * (0.15 + Math.max(0, clump(u, tv) - 0.45) * 3));
    const k = Math.min(0.9, sd);
    o[0] = r + (255 - r) * k; o[1] = gg + (255 - gg) * k; o[2] = b + (252 - b) * k;
  }, 0.5);
  pixels(d.g, 0, 0, W, ringH, (u, v, o) => {
    const tv = 1 - v;
    o[0] = 110 + 90 * crust(u, tv); // bumpy crust
    o[1] = 95 + 70 * gloss(u, tv) + 90 * Math.max(0, topOf(tv)) * dust(u, tv); // oily sheen, matte where sugared
    o[2] = 0;
  }, 0.5);
  // sugar crystals: fine, dense, bright grains on top, sparse underneath
  const sr = rng(3);
  const grains = Math.round(W * ringH * 0.08);
  const gs = Math.max(0.6, s);
  for (let i = 0; i < grains; i++) {
    const u = sr(), tv = sr();
    if (sr() > Math.max(0.04, topOf(tv) * 0.9)) continue;
    const x = u * W, y = (1 - tv) * ringH, sz = (0.5 + sr() * 0.8) * gs;
    m.g.fillStyle = `rgba(255,255,253,${0.5 + sr() * 0.5})`;
    m.g.fillRect(x, y, sz, sz);
    d.g.fillStyle = 'rgb(175,215,0)';
    d.g.fillRect(x, y, sz, sz);
  }
  // paper: off-white greaseproof with oil stains
  const pTop = ringH, pW = Math.round(512 * s), pH = Math.round(512 * s);
  pixels(m.g, 0, pTop, pW, pH, (u, v, o) => {
    const n = paperN(u, v);
    const oil = Math.max(0, 1 - Math.hypot(u - 0.5, v - 0.52) / 0.32) * (0.6 + 0.4 * oilN(u, v));
    const k = 243 - 18 * n - 55 * oil;
    o[0] = k; o[1] = k - 6 - 25 * oil; o[2] = k - 16 - 60 * oil;
  }, 0.5);
  pixels(d.g, 0, pTop, pW, pH, (u, v, o) => {
    o[0] = 128 + 100 * (paperB(u, v) - 0.5) + 40 * (paperF(u, v) - 0.5);
    const oil = Math.max(0, 1 - Math.hypot(u - 0.5, v - 0.52) / 0.32);
    o[1] = 230 - 120 * oil;
    o[2] = 0;
  }, 0.5);
  return { map: canvasTex(m.c, renderer), data: canvasTex(d.c, renderer, false) };
}

// ---------------------------------------------------------------------------------------------
// Felt for the chéchia: tiling data texture (R = fibre bump, G = roughness).
export function feltTexture(renderer: WebGLRenderer, s: number): CanvasTexture {
  const N = Math.round(256 * s);
  const { c, g } = canvas(N, N);
  const fibres = field(16, 16, 5, 12), fine = field(128, 128, 1, 6);
  pixels(g, 0, 0, N, N, (u, v, o) => {
    o[0] = 90 + 110 * fibres(u, v) + 55 * fine(u, v);
    o[1] = 230 + 25 * fine(u, v);
    o[2] = 0;
  });
  return canvasTex(c, renderer, false, true);
}
