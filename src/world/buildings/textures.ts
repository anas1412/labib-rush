// Texture set of the buildings module.
//  • Masonry texture ARRAYS (albedo + packed normal/roughness), one layer per surface type, so the
//    whole opaque facade of a chunk (plaster, stone, concrete, roofs, shutters, doors, AC units…)
//    renders in ONE draw call. Photo layers come from Poly Haven (CC0, see docs/credits/buildings.md),
//    the "misc" atlas layer and the far-LOD "impostor" layer are painted procedurally on canvas.
//  • Cutout atlas (RGBA canvas): wrought-iron railings, balustrades, foliage — alpha-tested.
//  • Flag texture (Tunisian flag).
//  • Weathering noise (256² RGBA, one tileable value-noise octave per channel) for the masonry.
import {
  CanvasTexture, DataArrayTexture, DataTexture, ImageLoader, LinearMipmapLinearFilter, LinearFilter, RepeatWrapping,
  RGBAFormat, SRGBColorSpace, ClampToEdgeWrapping, type Texture,
} from 'three';
import type { BuildContext } from '../../core/types';
import { rng } from './rng';

/** Layer indices of the masonry arrays. */
export const L = { PLASTER: 0, STUCCO: 1, STONE: 2, CONCRETE: 3, ROOF: 4, MISC: 5, IMPOSTOR: 6 } as const;
export const LAYER_COUNT = 7;

/** Per-layer shader params: uv scale (1/tile meters; 1 = uv already in atlas/tile units), normal strength, roughness mul. */
export const LAYER_PARAMS: [number, number, number][] = [
  [0.5, 1.0, 1.0], // plaster: 2 m tile
  [0.5, 0.9, 0.9], // stucco
  [1 / 3, 1.0, 1.0], // stone: 3 m tile
  [1 / 2.7, 0.8, 1.0], // concrete
  [0.5, 0.8, 1.0], // roof
  [1, 1.0, 1.0], // misc atlas
  [1, 0.8, 1.0], // impostor
];

const PHOTO = ['plaster', 'stucco', 'stone', 'concrete', 'roof'] as const;

/** Misc atlas regions in canvas pixels (1024², top-left origin). */
const MISC_PX = {
  shutter: [0, 0, 256, 512],
  door: [256, 0, 512, 512],
  ac: [512, 0, 768, 256],
  roll: [768, 0, 1024, 256],
  fabric: [512, 256, 768, 512],
  solar: [768, 256, 1024, 512],
  floral: [0, 512, 256, 768],
  deco: [256, 512, 512, 768],
  garland: [512, 512, 768, 768],
  zellige: [768, 512, 1024, 768],
  paint: [0, 768, 256, 1024],
  marble: [256, 768, 512, 1024],
  tiles: [512, 768, 768, 1024],
  tank: [768, 768, 1024, 1024],
} as const;
export type MiscRegion = keyof typeof MISC_PX;

/** UV rect [s0, t0, s1, t1] (v up) of a misc region, inset to avoid bleeding. */
export function miscUV(r: MiscRegion): [number, number, number, number] {
  const [x0, y0, x1, y1] = MISC_PX[r];
  const k = 3;
  return [(x0 + k) / 1024, 1 - (y1 - k) / 1024, (x1 - k) / 1024, 1 - (y0 + k) / 1024];
}

/** Cutout atlas strips (1024 × 256 px each in a 1024 × 2048 canvas). u tiles (1 = 2 m), v spans the strip. */
export const CUT = { haussmann: 0, nouveau: 1, deco: 2, bars: 3, balustrade: 4, foliage: 5, pots: 6, grille: 7 } as const;
export type CutStrip = keyof typeof CUT;
export const CUT_STRIP_METERS = 2; // one u repeat = 2 m
/** v range of a strip (v up). */
export function cutV(s: CutStrip): [number, number] {
  const i = CUT[s];
  const pad = 2 / 2048;
  return [1 - ((i + 1) * 256) / 2048 + pad, 1 - (i * 256) / 2048 - pad];
}

export interface BuildingTextures {
  albedo: DataArrayTexture;
  normal: DataArrayTexture;
  cutout: CanvasTexture;
  flag: CanvasTexture;
  noise: DataTexture;
  dispose(): void;
}

// ---------------------------------------------------------------------------------------------

function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const g = c.getContext('2d', { willReadFrequently: true });
  if (!g) throw new Error('2D canvas unavailable');
  return g;
}

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Copies an RGBA image into layer `layer` of `dst`, flipping rows so that canvas-top = v 1. */
function putLayer(dst: Uint8Array, size: number, layer: number, src: Uint8ClampedArray): void {
  const row = size * 4;
  const base = layer * size * row;
  for (let y = 0; y < size; y++) dst.set(src.subarray((size - 1 - y) * row, (size - y) * row), base + y * row);
}

/** Height (grayscale canvas) → tangent-space normal RG, roughness B. */
function heightToNormal(h: Uint8ClampedArray, rough: Uint8ClampedArray, size: number, strength: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(size * size * 4);
  const H = (x: number, y: number) => h[(((y + size) % size) * size + ((x + size) % size)) * 4] / 255;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const dx = (H(x + 1, y) - H(x - 1, y)) * strength;
      const dy = (H(x, y + 1) - H(x, y - 1)) * strength; // canvas y runs down, texture v up
      let nx = -dx, ny = dy, nz = 1; // n = (−∂h/∂u, −∂h/∂v, 1) with ∂/∂v = −∂/∂y
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      const i = (y * size + x) * 4;
      out[i] = (nx * 0.5 + 0.5) * 255;
      out[i + 1] = (ny * 0.5 + 0.5) * 255;
      out[i + 2] = rough[i];
      out[i + 3] = 255;
    }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Procedural misc atlas. Albedo is mostly light/neutral: surfaces are tinted by vertex colour.

function drawMisc(size: number): { alb: Uint8ClampedArray; nrm: Uint8ClampedArray } {
  const S = 1024;
  const ca = canvas(S, S), ch = canvas(S, S), cr = canvas(S, S);
  const a = ctx2d(ca), h = ctx2d(ch), r = ctx2d(cr);
  a.fillStyle = '#e6e6e6'; a.fillRect(0, 0, S, S);
  h.fillStyle = '#808080'; h.fillRect(0, 0, S, S);
  r.fillStyle = '#909090'; r.fillRect(0, 0, S, S);
  const R = rng(1234);
  const region = (k: MiscRegion, rough: number, fn: (x: number, y: number, w: number, hh: number) => void) => {
    const [x0, y0, x1, y1] = MISC_PX[k];
    for (const g of [a, h, r]) { g.save(); g.beginPath(); g.rect(x0, y0, x1 - x0, y1 - y0); g.clip(); }
    const v = Math.round(rough * 255);
    r.fillStyle = `rgb(${v},${v},${v})`; r.fillRect(x0, y0, x1 - x0, y1 - y0);
    fn(x0, y0, x1 - x0, y1 - y0);
    for (const g of [a, h, r]) g.restore();
  };
  const gray = (v: number) => `rgb(${v},${v},${v})`;

  // Louvred shutter (persienne): stiles, rails and ~40 slats
  region('shutter', 0.55, (x, y, w, hh) => {
    a.fillStyle = gray(228); a.fillRect(x, y, w, hh);
    h.fillStyle = gray(200); h.fillRect(x, y, w, hh);
    const st = w * 0.11, top = hh * 0.05, bot = hh * 0.07, mid = hh * 0.47, midH = hh * 0.035;
    const slats = (ya: number, yb: number) => {
      const n = Math.round((yb - ya) / 12.5);
      const p = (yb - ya) / n;
      for (let i = 0; i < n; i++) {
        const sy = ya + i * p;
        const gA = a.createLinearGradient(0, sy, 0, sy + p);
        gA.addColorStop(0, gray(250)); gA.addColorStop(0.7, gray(205)); gA.addColorStop(0.86, gray(120)); gA.addColorStop(1, gray(70));
        a.fillStyle = gA; a.fillRect(x + st, sy, w - 2 * st, p);
        const gH = h.createLinearGradient(0, sy, 0, sy + p);
        gH.addColorStop(0, gray(150)); gH.addColorStop(0.85, gray(40)); gH.addColorStop(1, gray(10));
        h.fillStyle = gH; h.fillRect(x + st, sy, w - 2 * st, p);
      }
    };
    slats(y + top, y + mid);
    slats(y + mid + midH, y + hh - bot);
    // frame bevel
    h.fillStyle = gray(215);
    h.fillRect(x, y, st, hh); h.fillRect(x + w - st, y, st, hh);
    h.fillRect(x, y, w, top); h.fillRect(x, y + mid, w, midH); h.fillRect(x, y + hh - bot, w, bot);
    a.fillStyle = 'rgba(0,0,0,0.18)';
    a.fillRect(x + st - 2, y, 2, hh); a.fillRect(x + w - st, y, 2, hh);
  });

  // Double entrance door with raised panels (wood tinted by vertex colour)
  region('door', 0.5, (x, y, w, hh) => {
    a.fillStyle = gray(200); a.fillRect(x, y, w, hh);
    for (let i = 0; i < 260; i++) {
      a.fillStyle = `rgba(${R() < 0.5 ? '0,0,0' : '255,255,255'},${0.03 + R() * 0.04})`;
      a.fillRect(x + R() * w, y, 1 + R() * 2, hh);
    }
    h.fillStyle = gray(170); h.fillRect(x, y, w, hh);
    const leaf = w / 2;
    for (let l = 0; l < 2; l++) {
      const lx = x + l * leaf;
      const m = leaf * 0.14;
      const panels = [[0.05, 0.22], [0.27, 0.62], [0.67, 0.95]];
      for (const [p0, p1] of panels) {
        const px = lx + m, py = y + hh * p0, pw = leaf - 2 * m, ph = hh * (p1 - p0);
        h.fillStyle = gray(110); h.fillRect(px, py, pw, ph);
        h.fillStyle = gray(150); h.fillRect(px + 6, py + 6, pw - 12, ph - 12);
        h.fillStyle = gray(185); h.fillRect(px + 12, py + 12, pw - 24, ph - 24);
        a.fillStyle = 'rgba(0,0,0,0.22)'; a.fillRect(px, py, pw, 4); a.fillRect(px, py, 4, ph);
        a.fillStyle = 'rgba(255,255,255,0.18)'; a.fillRect(px, py + ph - 4, pw, 4); a.fillRect(px + pw - 4, py, 4, ph);
      }
      a.fillStyle = 'rgba(0,0,0,0.5)'; a.fillRect(lx + (l ? 0 : leaf - 2), y, 2, hh);
    }
    // brass knobs
    a.fillStyle = '#b8932e'; a.beginPath(); a.arc(x + leaf - 10, y + hh * 0.5, 5, 0, 7); a.arc(x + leaf + 10, y + hh * 0.5, 5, 0, 7); a.fill();
    h.fillStyle = gray(255); h.beginPath(); h.arc(x + leaf - 10, y + hh * 0.5, 5, 0, 7); h.arc(x + leaf + 10, y + hh * 0.5, 5, 0, 7); h.fill();
  });

  // Split-AC outdoor unit: casing + round fan grille + side fins
  region('ac', 0.5, (x, y, w, hh) => {
    a.fillStyle = gray(232); a.fillRect(x, y, w, hh);
    h.fillStyle = gray(180); h.fillRect(x, y, w, hh);
    const cx = x + w * 0.38, cy = y + hh * 0.5, rr = hh * 0.36;
    a.fillStyle = gray(40); a.beginPath(); a.arc(cx, cy, rr, 0, 7); a.fill();
    h.fillStyle = gray(60); h.beginPath(); h.arc(cx, cy, rr, 0, 7); h.fill();
    a.strokeStyle = gray(150); a.lineWidth = 2; h.strokeStyle = gray(200); h.lineWidth = 2;
    for (let k = 1; k <= 6; k++) for (const g of [a, h]) { g.beginPath(); g.arc(cx, cy, (rr * k) / 6.2, 0, 7); g.stroke(); }
    for (let k = 0; k < 8; k++) {
      const an = (k / 8) * Math.PI * 2;
      for (const g of [a, h]) { g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(an) * rr, cy + Math.sin(an) * rr); g.stroke(); }
    }
    for (let k = 0; k < 16; k++) {
      const fy = y + hh * 0.14 + k * hh * 0.045;
      a.fillStyle = gray(160); a.fillRect(x + w * 0.76, fy, w * 0.18, 3);
      h.fillStyle = gray(120); h.fillRect(x + w * 0.76, fy, w * 0.18, 3);
    }
    a.fillStyle = 'rgba(80,70,50,0.18)'; a.fillRect(x, y + hh * 0.85, w, hh * 0.15);
  });

  // Rolling steel shutter (rideau métallique)
  region('roll', 0.45, (x, y, w, hh) => {
    for (let yy = 0; yy < hh; yy++) {
      const s = Math.sin((yy / 9) * Math.PI * 2);
      a.fillStyle = gray(Math.round(170 + s * 28)); a.fillRect(x, y + yy, w, 1);
      h.fillStyle = gray(Math.round(128 + s * 90)); h.fillRect(x, y + yy, w, 1);
    }
    for (let i = 0; i < 40; i++) {
      a.fillStyle = `rgba(90,75,55,${0.05 + R() * 0.08})`;
      a.fillRect(x + R() * w, y + hh * (0.6 + R() * 0.4), 4 + R() * 30, 2 + R() * 20);
    }
  });

  // Awning fabric: fine canvas weave + soft wrinkles (low contrast, tinted per stripe)
  region('fabric', 0.9, (x, y, w, hh) => {
    a.fillStyle = gray(232); a.fillRect(x, y, w, hh);
    for (let i = 0; i < 18; i++) {
      const gy = y + R() * hh, gw = 12 + R() * 40;
      const gr = a.createLinearGradient(0, gy - gw, 0, gy + gw);
      gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(0.5, `rgba(0,0,0,${0.04 + R() * 0.05})`); gr.addColorStop(1, 'rgba(0,0,0,0)');
      a.fillStyle = gr; a.fillRect(x, gy - gw, w, gw * 2);
    }
    h.fillStyle = gray(128); h.fillRect(x, y, w, hh);
    for (let yy = 0; yy < hh; yy += 2) { h.fillStyle = gray(yy % 4 ? 136 : 120); h.fillRect(x, y + yy, w, 1); }
    for (let xx = 0; xx < w; xx += 2) { h.fillStyle = 'rgba(255,255,255,0.06)'; h.fillRect(x + xx, y, 1, hh); }
  });

  // Solar water-heater collector
  region('solar', 0.18, (x, y, w, hh) => {
    a.fillStyle = '#1d2b44'; a.fillRect(x, y, w, hh);
    a.fillStyle = '#9aa3ad'; a.fillRect(x, y, w, 10); a.fillRect(x, y + hh - 10, w, 10); a.fillRect(x, y, 10, hh); a.fillRect(x + w - 10, y, 10, hh);
    h.fillStyle = gray(200); h.fillRect(x, y, w, 10); h.fillRect(x, y + hh - 10, w, 10); h.fillRect(x, y, 10, hh); h.fillRect(x + w - 10, y, 10, hh);
    a.fillStyle = 'rgba(160,180,200,0.35)';
    for (let k = 1; k < 10; k++) a.fillRect(x + (k * w) / 10, y + 10, 2, hh - 20);
  });

  // Reliefs: drawn as height (white = raised) with soft edges; albedo = light stone with baked AO.
  const relief = (k: MiscRegion, draw: (g: CanvasRenderingContext2D, x: number, y: number, w: number, hh: number) => void) =>
    region(k, 0.85, (x, y, w, hh) => {
      a.fillStyle = gray(232); a.fillRect(x, y, w, hh);
      h.fillStyle = gray(60); h.fillRect(x, y, w, hh);
      h.save(); h.filter = 'blur(2.5px)'; h.fillStyle = gray(235); h.strokeStyle = gray(235);
      draw(h, x, y, w, hh);
      h.restore();
      a.save(); a.globalAlpha = 0.18; a.fillStyle = gray(90); a.strokeStyle = gray(90); a.filter = 'blur(5px)';
      a.translate(3, 4); draw(a, x, y, w, hh);
      a.restore();
    });

  relief('floral', (g, x, y, w, hh) => {
    // Art Nouveau: symmetric whiplash stems with leaves and a central flower
    g.lineCap = 'round';
    const cx = x + w / 2, by = y + hh * 0.92;
    for (const sgn of [-1, 1]) {
      g.lineWidth = 9;
      g.beginPath(); g.moveTo(cx, by);
      g.bezierCurveTo(cx + sgn * w * 0.05, y + hh * 0.55, cx + sgn * w * 0.5, y + hh * 0.75, cx + sgn * w * 0.42, y + hh * 0.35);
      g.bezierCurveTo(cx + sgn * w * 0.36, y + hh * 0.15, cx + sgn * w * 0.18, y + hh * 0.2, cx + sgn * w * 0.2, y + hh * 0.32);
      g.stroke();
      for (let i = 0; i < 4; i++) {
        const lx = cx + sgn * w * (0.12 + i * 0.08), ly = y + hh * (0.72 - i * 0.1);
        g.beginPath(); g.ellipse(lx, ly, w * 0.07, w * 0.028, sgn * (0.6 + i * 0.3), 0, 7); g.fill();
      }
    }
    g.beginPath(); g.arc(cx, y + hh * 0.3, w * 0.09, 0, 7); g.fill();
    for (let i = 0; i < 6; i++) {
      const an = (i / 6) * Math.PI * 2;
      g.beginPath(); g.ellipse(cx + Math.cos(an) * w * 0.12, y + hh * 0.3 + Math.sin(an) * w * 0.12, w * 0.06, w * 0.035, an, 0, 7); g.fill();
    }
  });

  relief('deco', (g, x, y, w, hh) => {
    // Art Deco sunburst over stepped base
    const cx = x + w / 2, by = y + hh * 0.8;
    for (let i = 0; i <= 10; i++) {
      const an = Math.PI + (i / 10) * Math.PI;
      g.beginPath(); g.moveTo(cx, by);
      g.lineTo(cx + Math.cos(an - 0.07) * w * 0.46, by + Math.sin(an - 0.07) * hh * 0.7);
      g.lineTo(cx + Math.cos(an + 0.07) * w * 0.46, by + Math.sin(an + 0.07) * hh * 0.7);
      g.closePath(); g.fill();
    }
    g.fillRect(x + w * 0.08, by, w * 0.84, hh * 0.06);
    g.fillRect(x + w * 0.16, by + hh * 0.08, w * 0.68, hh * 0.06);
    g.beginPath(); g.arc(cx, by, w * 0.1, Math.PI, 0); g.fill();
  });

  relief('garland', (g, x, y, w, hh) => {
    // Haussmann cartouche with swags
    const cx = x + w / 2, cy = y + hh * 0.45;
    g.lineWidth = 10;
    g.beginPath(); g.ellipse(cx, cy, w * 0.16, hh * 0.24, 0, 0, 7); g.stroke();
    g.beginPath(); g.ellipse(cx, cy, w * 0.1, hh * 0.16, 0, 0, 7); g.fill();
    g.lineWidth = 14;
    for (const sgn of [-1, 1]) {
      g.beginPath(); g.moveTo(cx + sgn * w * 0.17, cy - hh * 0.1);
      g.quadraticCurveTo(cx + sgn * w * 0.33, cy + hh * 0.3, cx + sgn * w * 0.47, cy - hh * 0.18); g.stroke();
      g.beginPath(); g.arc(cx + sgn * w * 0.46, cy - hh * 0.2, 10, 0, 7); g.fill();
    }
    g.beginPath(); g.moveTo(cx - 20, cy - hh * 0.27); g.lineTo(cx, cy - hh * 0.4); g.lineTo(cx + 20, cy - hh * 0.27); g.fill();
  });

  // Zellige tile panel (shop stall risers / entrances)
  region('zellige', 0.22, (x, y, w) => {
    const cols = ['#1f5f8b', '#2f8a6b', '#e8e2d0', '#c4862f', '#1a3a5c', '#e8e2d0'];
    const n = 8, t = w / n;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        const px = x + i * t, py = y + j * t;
        a.fillStyle = '#e9e4d6'; a.fillRect(px, py, t, t);
        a.fillStyle = cols[(i + j * 3) % cols.length];
        a.beginPath();
        const c = t / 2;
        for (let k = 0; k < 8; k++) {
          const an = (k / 8) * Math.PI * 2 + Math.PI / 8, rr = k % 2 ? t * 0.3 : t * 0.46;
          a.lineTo(px + c + Math.cos(an) * rr, py + c + Math.sin(an) * rr);
        }
        a.fill();
        h.fillStyle = gray(200); h.fillRect(px + 1, py + 1, t - 2, t - 2);
        h.fillStyle = gray(90); h.fillRect(px, py, t, 1); h.fillRect(px, py, 1, t);
      }
  });

  region('paint', 0.4, (x, y, w, hh) => {
    a.fillStyle = gray(236); a.fillRect(x, y, w, hh);
    h.fillStyle = gray(128); h.fillRect(x, y, w, hh);
  });

  region('marble', 0.18, (x, y, w, hh) => {
    a.fillStyle = gray(205); a.fillRect(x, y, w, hh);
    a.strokeStyle = 'rgba(80,80,80,0.35)';
    for (let i = 0; i < 18; i++) {
      a.lineWidth = 0.5 + R() * 2;
      a.beginPath();
      let px = x + R() * w, py = y;
      a.moveTo(px, py);
      while (py < y + hh) { px += (R() - 0.5) * 30; py += 10 + R() * 20; a.lineTo(px, py); }
      a.stroke();
    }
    h.fillStyle = gray(128); h.fillRect(x, y, w, hh);
    h.fillStyle = gray(70); h.fillRect(x, y + hh / 2, w, 2); h.fillRect(x + w / 2, y, 2, hh);
  });

  region('tiles', 0.3, (x, y, w, hh) => {
    const n = 16, t = w / n;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        const v = 0.85 + R() * 0.3;
        a.fillStyle = `rgb(${Math.round(60 * v)},${Math.round(110 * v)},${Math.round(160 * v)})`;
        a.fillRect(x + i * t, y + j * t, t, t);
        h.fillStyle = gray(200); h.fillRect(x + i * t + 1, y + j * t + 1, t - 2, t - 2);
      }
    a.fillStyle = 'rgba(230,230,230,0.9)';
    for (let i = 0; i <= n; i++) { a.fillRect(x + i * t - 1, y, 2, hh); a.fillRect(x, y + i * t - 1, w, 2); }
  });

  region('tank', 0.6, (x, y, w, hh) => {
    a.fillStyle = gray(200); a.fillRect(x, y, w, hh);
    for (let yy = 0; yy < hh; yy += 32) {
      h.fillStyle = gray(200); h.fillRect(x, y + yy, w, 24);
      h.fillStyle = gray(90); h.fillRect(x, y + yy + 24, w, 8);
      a.fillStyle = 'rgba(0,0,0,0.12)'; a.fillRect(x, y + yy + 24, w, 8);
    }
  });

  const scaled = (c: HTMLCanvasElement) => {
    if (size === S) return ctx2d(c).getImageData(0, 0, S, S).data;
    const d = canvas(size, size);
    const g = ctx2d(d);
    g.drawImage(c, 0, 0, size, size);
    return g.getImageData(0, 0, size, size).data;
  };
  const hd = scaled(ch), rd = scaled(cr);
  return { alb: scaled(ca), nrm: heightToNormal(hd, rd, size, 6 * (size / S)) };
}

// ---------------------------------------------------------------------------------------------
// Impostor layer: 4 bays × (ground row + 3 upper floors) of a generic cream facade, used for
// hinterland blocks and the far LOD of backdrops. Canvas rows: y 0..768 = floors 3..1, 768..1024 = ground.

function drawImpostor(size: number): { alb: Uint8ClampedArray; nrm: Uint8ClampedArray } {
  const S = 1024;
  const ca = canvas(S, S), ch = canvas(S, S), cr = canvas(S, S);
  const a = ctx2d(ca), h = ctx2d(ch), r = ctx2d(cr);
  const R = rng(99);
  a.fillStyle = '#ebe6dc'; a.fillRect(0, 0, S, S);
  h.fillStyle = '#909090'; h.fillRect(0, 0, S, S);
  r.fillStyle = '#e0e0e0'; r.fillRect(0, 0, S, S);
  const shutters = ['#6f8270', '#7a5a3e', '#e2dccd', '#6c7c88', '#3f6f93'];
  for (let f = 0; f < 3; f++) {
    const fy = f * 256; // top of the floor row (floor 3 at f = 0)
    // string course at the bottom of each floor row
    a.fillStyle = '#f4f0e8'; a.fillRect(0, fy + 238, S, 12);
    a.fillStyle = 'rgba(60,50,40,0.25)'; a.fillRect(0, fy + 250, S, 6);
    h.fillStyle = '#d0d0d0'; h.fillRect(0, fy + 238, S, 12);
    for (let b = 0; b < 4; b++) {
      const cx = b * 256 + 128, ww = 92, wh = 170, wx = cx - ww / 2, wy = fy + 238 - wh;
      // surround
      a.fillStyle = '#f6f2ea'; a.fillRect(wx - 12, wy - 16, ww + 24, wh + 16);
      h.fillStyle = '#b0b0b0'; h.fillRect(wx - 12, wy - 16, ww + 24, wh + 16);
      // glass with sky reflection + dark interior
      const g = a.createLinearGradient(0, wy, 0, wy + wh);
      g.addColorStop(0, '#6d7f93'); g.addColorStop(0.5, '#2f3740'); g.addColorStop(1, '#1d2126');
      a.fillStyle = g; a.fillRect(wx, wy, ww, wh);
      h.fillStyle = '#303030'; h.fillRect(wx, wy, ww, wh);
      r.fillStyle = '#202020'; r.fillRect(wx, wy, ww, wh);
      a.fillStyle = '#e8e4dc'; a.fillRect(cx - 2, wy, 4, wh); a.fillRect(wx, wy + 40, ww, 4);
      const col = shutters[Math.floor(R() * shutters.length)];
      const state = R();
      a.fillStyle = col;
      if (state < 0.35) {
        a.fillRect(wx, wy, ww, wh); // closed
        a.fillStyle = 'rgba(0,0,0,0.25)';
        for (let k = 0; k < wh; k += 6) a.fillRect(wx, wy + k, ww, 2);
        a.fillRect(cx - 1, wy, 2, wh);
        h.fillStyle = '#707070'; h.fillRect(wx, wy, ww, wh);
      } else if (state < 0.8) {
        a.fillRect(wx - ww / 2 - 14, wy, ww / 2, wh); a.fillRect(wx + ww + 14, wy, ww / 2, wh); // open
        a.fillStyle = 'rgba(0,0,0,0.22)';
        for (let k = 0; k < wh; k += 6) { a.fillRect(wx - ww / 2 - 14, wy + k, ww / 2, 2); a.fillRect(wx + ww + 14, wy + k, ww / 2, 2); }
      } else {
        a.fillRect(wx, wy, ww * 0.25, wh); a.fillRect(wx + ww * 0.75, wy, ww * 0.25, wh); // half
      }
      // balconette railing
      a.fillStyle = '#1b1b1b';
      a.fillRect(wx - 6, wy + wh - 62, ww + 12, 4);
      for (let k = 0; k < ww + 12; k += 7) a.fillRect(wx - 6 + k, wy + wh - 62, 2, 62);
      // AC units now and then
      if (R() < 0.25) { a.fillStyle = '#dcdcd6'; a.fillRect(wx + ww + 20, wy + wh - 50, 48, 34); a.fillStyle = '#555'; a.beginPath(); a.arc(wx + ww + 38, wy + wh - 33, 11, 0, 7); a.fill(); }
      // grime under the sill
      const gg = a.createLinearGradient(0, fy + 250, 0, fy + 256 + 60);
      gg.addColorStop(0, 'rgba(90,75,55,0.22)'); gg.addColorStop(1, 'rgba(90,75,55,0)');
      a.fillStyle = gg; a.fillRect(wx, fy + 250, ww, 60);
    }
  }
  // ground row: shopfronts with signs and a couple of awnings
  const gy = 768;
  a.fillStyle = '#d9cfbd'; a.fillRect(0, gy, S, 256);
  for (let b = 0; b < 4; b++) {
    const x0 = b * 256 + 22, w = 212;
    a.fillStyle = ['#2e4d3a', '#6a2a2a', '#1f3552', '#e8e0cc'][b]; a.fillRect(x0, gy + 40, w, 34);
    a.fillStyle = 'rgba(255,255,255,0.8)'; a.fillRect(x0 + 30, gy + 52, w - 60, 10);
    const g = a.createLinearGradient(0, gy + 80, 0, gy + 250);
    g.addColorStop(0, '#3b3b38'); g.addColorStop(1, '#6b6358');
    a.fillStyle = g; a.fillRect(x0, gy + 80, w, 176);
    h.fillStyle = '#404040'; h.fillRect(x0, gy + 80, w, 176);
    r.fillStyle = '#303030'; r.fillRect(x0, gy + 80, w, 176);
    if (b % 2 === 0) {
      for (let k = 0; k < 8; k++) { a.fillStyle = k % 2 ? '#f0ece4' : ['#8a2b2b', '#2d6a4a'][b / 2]; a.fillRect(x0 + (k * w) / 8, gy + 80, w / 8, 30); }
    }
  }
  const scaled = (c: HTMLCanvasElement) => {
    if (size === S) return ctx2d(c).getImageData(0, 0, S, S).data;
    const d = canvas(size, size);
    const g = ctx2d(d);
    g.drawImage(c, 0, 0, size, size);
    return g.getImageData(0, 0, size, size).data;
  };
  return { alb: scaled(ca), nrm: heightToNormal(scaled(ch), scaled(cr), size, 4 * (size / S)) };
}

/** v range of the impostor rows (v up): ground row and the 3-floor band. */
export const IMPOSTOR_V = { ground: [0, 0.25] as [number, number], floors: [0.25, 1] as [number, number] };

// ---------------------------------------------------------------------------------------------
// Cutout atlas: ironwork, balustrades, foliage. 1024 × 2048 RGBA.

function drawCutout(): HTMLCanvasElement {
  const W = 1024, SH = 256;
  const c = canvas(W, SH * 8);
  const g = ctx2d(c);
  const R = rng(4321);
  const iron = '#1c1d1f';
  const strip = (s: CutStrip, fn: (y: number) => void) => {
    const y = CUT[s] * SH;
    g.save(); g.beginPath(); g.rect(0, y, W, SH); g.clip();
    fn(y);
    g.restore();
  };
  const rails = (y: number, top = 10, bot = 14) => {
    g.fillStyle = iron;
    g.fillRect(0, y + 2, W, top); // handrail
    g.fillRect(0, y + SH - bot - 2, W, bot); // bottom rail
  };
  g.lineCap = 'round';

  // 2 m repeat = 1024 px. Haussmann: balusters with scroll panels every 0.5 m
  strip('haussmann', (y) => {
    rails(y);
    g.fillStyle = iron; g.fillRect(0, y + 40, W, 6); g.fillRect(0, y + SH - 50, W, 6);
    g.strokeStyle = iron; g.lineWidth = 5;
    for (let x = 0; x < W; x += 32) { g.beginPath(); g.moveTo(x + 16, y + 46); g.lineTo(x + 16, y + SH - 50); g.stroke(); }
    // scroll panels
    for (let x = 0; x < W; x += 256) {
      g.clearRect(x + 60, y + 60, 136, 130);
      g.lineWidth = 6;
      g.strokeRect(x + 62, y + 62, 132, 126);
      const cx = x + 128, cy = y + 125;
      for (const s of [-1, 1]) {
        g.beginPath(); g.moveTo(cx, cy + 50);
        g.bezierCurveTo(cx + s * 10, cy, cx + s * 60, cy + 30, cx + s * 55, cy - 20);
        g.bezierCurveTo(cx + s * 50, cy - 50, cx + s * 20, cy - 40, cx + s * 25, cy - 20);
        g.stroke();
        g.beginPath(); g.arc(cx + s * 33, cy - 25, 9, 0, 7); g.stroke();
      }
      g.beginPath(); g.ellipse(cx, cy - 38, 10, 16, 0, 0, 7); g.stroke();
    }
    // top frieze of small circles
    g.lineWidth = 4;
    for (let x = 0; x < W; x += 32) { g.beginPath(); g.arc(x + 16, y + 28, 10, 0, 7); g.stroke(); }
  });

  // Art Nouveau whiplash ironwork
  strip('nouveau', (y) => {
    rails(y, 12, 12);
    g.strokeStyle = iron; g.lineWidth = 6;
    for (let x = -256; x < W + 256; x += 256) {
      const cx = x + 128;
      for (const s of [-1, 1]) {
        g.beginPath(); g.moveTo(cx, y + SH - 16);
        g.bezierCurveTo(cx + s * 20, y + 150, cx + s * 150, y + 190, cx + s * 120, y + 90);
        g.bezierCurveTo(cx + s * 100, y + 30, cx + s * 40, y + 50, cx + s * 55, y + 90);
        g.stroke();
        g.beginPath(); g.moveTo(cx + s * 128, y + 16);
        g.bezierCurveTo(cx + s * 100, y + 80, cx + s * 70, y + 110, cx + s * 30, y + 110);
        g.stroke();
      }
      g.beginPath(); g.moveTo(cx, y + 14); g.lineTo(cx, y + SH - 16); g.stroke();
      g.beginPath(); g.ellipse(cx, y + 70, 14, 26, 0, 0, 7); g.stroke();
    }
  });

  // Art Deco: vertical bars grouped with diamonds and a sunray panel
  strip('deco', (y) => {
    rails(y, 12, 12);
    g.strokeStyle = iron; g.lineWidth = 7;
    for (let x = 0; x < W; x += 128) {
      for (const dx of [8, 24, 104, 120]) { g.beginPath(); g.moveTo(x + dx, y + 14); g.lineTo(x + dx, y + SH - 16); g.stroke(); }
      g.beginPath(); g.moveTo(x + 64, y + 40); g.lineTo(x + 100, y + 128); g.lineTo(x + 64, y + 216); g.lineTo(x + 28, y + 128); g.closePath(); g.stroke();
      g.beginPath(); g.moveTo(x + 64, y + 80); g.lineTo(x + 82, y + 128); g.lineTo(x + 64, y + 176); g.lineTo(x + 46, y + 128); g.closePath(); g.stroke();
      g.fillStyle = iron; g.fillRect(x, y + 124, 32, 8); g.fillRect(x + 96, y + 124, 32, 8);
    }
  });

  // simple vertical bars (balconettes, modern)
  strip('bars', (y) => {
    rails(y, 10, 10);
    g.fillStyle = iron;
    for (let x = 0; x < W; x += 28) g.fillRect(x + 11, y + 10, 6, SH - 20);
    g.fillRect(0, y + SH * 0.55, W, 5);
  });

  // stone balustrade: coping, balusters, plinth (cream stone; vertex colour tints)
  strip('balustrade', (y) => {
    const stone = (x: number, yy: number, w: number, hh: number, v: number) => { g.fillStyle = `rgb(${v},${v - 6},${v - 18})`; g.fillRect(x, yy, w, hh); };
    stone(0, y, W, 40, 236); stone(0, y + 40, W, 8, 196);
    stone(0, y + SH - 36, W, 36, 226);
    for (let x = 0; x < W; x += 64) {
      const cx = x + 32;
      const gr = g.createLinearGradient(cx - 20, 0, cx + 20, 0);
      gr.addColorStop(0, '#bdb3a0'); gr.addColorStop(0.4, '#f2ece0'); gr.addColorStop(1, '#a89e8a');
      g.fillStyle = gr;
      g.beginPath();
      const top = y + 48, bot = y + SH - 36;
      g.moveTo(cx - 12, top); g.lineTo(cx + 12, top);
      g.bezierCurveTo(cx + 8, top + 30, cx + 24, bot - 70, cx + 22, bot - 30);
      g.lineTo(cx + 16, bot); g.lineTo(cx - 16, bot); g.lineTo(cx - 22, bot - 30);
      g.bezierCurveTo(cx - 24, bot - 70, cx - 8, top + 30, cx - 12, top);
      g.fill();
    }
  });

  // hanging bougainvillea: 4 clumps per strip (one per 0.5 m slot) with ragged, transparent sides,
  // so cards aligned to slot boundaries never show a straight cut edge.
  const leaf = (cx: number, cy: number, s: number, col: string) => {
    g.fillStyle = col;
    for (let k = 0; k < 9; k++) {
      const an = R() * Math.PI * 2, d = R() * s;
      g.beginPath();
      g.ellipse(cx + Math.cos(an) * d, cy + Math.sin(an) * d * 0.8, s * (0.35 + R() * 0.25), s * (0.2 + R() * 0.12), an, 0, 7);
      g.fill();
    }
  };
  strip('foliage', (y) => {
    for (let slot = 0; slot < 4; slot++) {
      const x0 = slot * 256, cx = x0 + 128;
      // clump silhouette: wide at the top (over the rail), hanging tongues below
      for (let i = 0; i < 260; i++) {
        const t = Math.pow(R(), 0.8);
        const yy = y + 10 + t * (SH - 26);
        const half = 110 * (1 - t * 0.65) * (0.7 + 0.3 * Math.sin(yy * 0.05 + slot));
        const x = cx + (R() * 2 - 1) * half;
        const v = 0.55 + R() * 0.5;
        leaf(x, yy, 8 + R() * 7, `rgb(${Math.round(46 * v)},${Math.round(86 * v)},${Math.round(34 * v)})`);
      }
      for (let i = 0; i < 80; i++) {
        const t = Math.pow(R(), 1.2);
        const yy = y + 14 + t * (SH - 60);
        const x = cx + (R() * 2 - 1) * 95 * (1 - t * 0.5);
        const v = 0.7 + R() * 0.35;
        g.fillStyle = `rgb(${Math.round(196 * v)},${Math.round(36 * v)},${Math.round(118 * v)})`;
        for (let k = 0; k < 7; k++) {
          const an = R() * Math.PI * 2, d = R() * 9;
          g.beginPath(); g.ellipse(x + Math.cos(an) * d, yy + Math.sin(an) * d, 5 + R() * 3, 3.5 + R() * 2, an, 0, 7); g.fill();
        }
      }
      g.strokeStyle = '#3d5a2a'; g.lineWidth = 3;
      for (let i = 0; i < 8; i++) {
        const x = cx + (R() - 0.5) * 150, y0 = y + SH * 0.45, l = 40 + R() * 80;
        g.beginPath(); g.moveTo(x, y0); g.quadraticCurveTo(x + (R() - 0.5) * 30, y0 + l * 0.5, x + (R() - 0.5) * 20, Math.min(y + SH - 6, y0 + l)); g.stroke();
        leaf(x, Math.min(y + SH - 12, y0 + l), 7, '#40632c');
      }
    }
  });

  // potted plants: one terracotta pot + plant per 0.5 m slot
  strip('pots', (y) => {
    for (let slot = 0; slot < 4; slot++) {
      const cx = slot * 256 + 128;
      const pw = 60 + R() * 40, ph = 50 + R() * 25, bot = y + SH - 4;
      const kind = slot % 4;
      for (let i = 0; i < 300; i++) {
        const an = -Math.PI * (0.05 + 0.9 * R()), rr = Math.pow(R(), 0.6) * (kind === 0 ? 120 : 85);
        const lx = cx + Math.cos(an) * rr * (kind === 0 ? 0.55 : 0.95), ly = bot - ph + Math.sin(an) * rr;
        const v = 0.55 + R() * 0.5;
        const fl = kind >= 2 && R() < 0.3;
        g.fillStyle = fl ? (kind === 2 ? `rgb(${Math.round(215 * v)},${Math.round(45 * v)},${Math.round(50 * v)})` : `rgb(${Math.round(240 * v)},${Math.round(240 * v)},${Math.round(230 * v)})`) : `rgb(${Math.round(58 * v)},${Math.round(108 * v)},${Math.round(44 * v)})`;
        g.beginPath();
        if (kind === 0) g.ellipse(lx, ly, 16, 3.5, an, 0, 7);
        else g.ellipse(lx, ly, 7, 4.5, R() * 3, 0, 7);
        g.fill();
      }
      const gr = g.createLinearGradient(cx - pw / 2, 0, cx + pw / 2, 0);
      gr.addColorStop(0, '#7e4226'); gr.addColorStop(0.45, '#c47550'); gr.addColorStop(1, '#6e3920');
      g.fillStyle = gr;
      g.beginPath(); g.moveTo(cx - pw / 2, bot - ph); g.lineTo(cx + pw / 2, bot - ph); g.lineTo(cx + pw * 0.36, bot); g.lineTo(cx - pw * 0.36, bot); g.fill();
      g.fillStyle = '#8a4a2c'; g.fillRect(cx - pw / 2 - 4, bot - ph - 6, pw + 8, 8);
    }
  });

  // window security grille (ground-floor windows)
  strip('grille', (y) => {
    g.strokeStyle = iron; g.lineWidth = 6;
    g.strokeRect(3, y + 3, W - 6, SH - 6);
    for (let x = 0; x < W; x += 36) { g.beginPath(); g.moveTo(x + 18, y); g.lineTo(x + 18, y + SH); g.stroke(); }
    for (const yy of [0.3, 0.7]) { g.beginPath(); g.moveTo(0, y + SH * yy); g.lineTo(W, y + SH * yy); g.stroke(); }
    g.lineWidth = 4;
    for (let x = 0; x < W; x += 72) { g.beginPath(); g.arc(x + 36, y + SH * 0.5, 16, 0, 7); g.stroke(); }
  });
  return c;
}

/** Tileable value noise, smoothstep-interpolated lattice: r 8, g 32, b 64, a 16 cells per tile. */
function makeNoise(): DataTexture {
  const S = 256;
  const data = new Uint8Array(S * S * 4);
  const R = rng(9876);
  [8, 32, 64, 16].forEach((n, ch) => {
    const lat = Float32Array.from({ length: n * n }, () => R());
    const at = (i: number, j: number) => lat[(j % n) * n + (i % n)];
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const fx = (x / S) * n, fy = (y / S) * n;
        const ix = Math.floor(fx), iy = Math.floor(fy);
        const tx = (fx - ix) * (fx - ix) * (3 - 2 * (fx - ix)), ty = (fy - iy) * (fy - iy) * (3 - 2 * (fy - iy));
        const top = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * tx;
        const bot = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * tx;
        data[(y * S + x) * 4 + ch] = Math.round((top + (bot - top) * ty) * 255);
      }
  });
  const t = new DataTexture(data, S, S, RGBAFormat);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.magFilter = LinearFilter;
  t.minFilter = LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

function drawFlag(): HTMLCanvasElement {
  // Flag of Tunisia (2:3): red field, white disc, red crescent and star.
  const w = 384, h = 256;
  const c = canvas(w, h);
  const g = ctx2d(c);
  g.fillStyle = '#e70013'; g.fillRect(0, 0, w, h);
  const cx = w / 2, cy = h / 2, R0 = h / 4;
  g.fillStyle = '#ffffff'; g.beginPath(); g.arc(cx, cy, R0, 0, 7); g.fill();
  g.fillStyle = '#e70013'; g.beginPath(); g.arc(cx, cy, R0 * 0.75, 0, 7); g.fill();
  g.fillStyle = '#ffffff'; g.beginPath(); g.arc(cx + R0 * 0.2, cy, R0 * 0.6, 0, 7); g.fill();
  g.fillStyle = '#e70013';
  g.beginPath();
  const sx = cx + R0 * 0.22, sr = R0 * 0.45;
  for (let i = 0; i < 10; i++) {
    const an = Math.PI + (i * Math.PI) / 5; // first point toward the hoist
    const rr = i % 2 ? sr * 0.38 : sr;
    g.lineTo(sx + Math.cos(an) * rr, cy + Math.sin(an) * rr);
  }
  g.fill();
  return c;
}

// ---------------------------------------------------------------------------------------------

export async function loadBuildingTextures(ctx: BuildContext): Promise<BuildingTextures> {
  const size = ctx.quality === 'low' ? 512 : 1024;
  const loader = new ImageLoader(ctx.assets.manager);
  const urls = PHOTO.flatMap((n) => [`/textures/buildings/${n}_c.webp`, `/textures/buildings/${n}_n.webp`]);
  const imgs = await Promise.all(urls.map((u) => loader.loadAsync(u)));

  const alb = new Uint8Array(size * size * 4 * LAYER_COUNT);
  const nrm = new Uint8Array(size * size * 4 * LAYER_COUNT);
  const scratch = canvas(size, size);
  const sg = ctx2d(scratch);
  const read = (img: HTMLImageElement) => {
    sg.clearRect(0, 0, size, size);
    sg.drawImage(img, 0, 0, size, size);
    return sg.getImageData(0, 0, size, size).data;
  };
  PHOTO.forEach((_, i) => {
    putLayer(alb, size, i, read(imgs[i * 2]));
    putLayer(nrm, size, i, read(imgs[i * 2 + 1]));
  });
  const misc = drawMisc(size);
  putLayer(alb, size, L.MISC, misc.alb);
  putLayer(nrm, size, L.MISC, misc.nrm);
  const imp = drawImpostor(size);
  putLayer(alb, size, L.IMPOSTOR, imp.alb);
  putLayer(nrm, size, L.IMPOSTOR, imp.nrm);

  // Street walls are mostly seen at grazing angles, where every anisotropic probe costs a trilinear
  // fetch: plaster albedo gets 4× (8× on ultra), the normal map (faded beyond 45 m anyway) 2×.
  const maxAniso = ctx.renderer.capabilities.getMaxAnisotropy();
  const mk = (data: Uint8Array, srgb: boolean, aniso: number) => {
    const t = new DataArrayTexture(data, size, size, LAYER_COUNT);
    t.wrapS = t.wrapT = RepeatWrapping;
    t.magFilter = LinearFilter;
    t.minFilter = LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = Math.min(aniso, maxAniso);
    if (srgb) t.colorSpace = SRGBColorSpace;
    t.needsUpdate = true;
    // drop the 28 MB CPU copy once it lives on the GPU
    t.onUpdate = () => {
      (t.image as { data: Uint8Array | null }).data = null;
    };
    return t;
  };
  const ultra = ctx.quality === 'ultra';
  const albedo = mk(alb, true, ultra ? 8 : 4);
  const normal = mk(nrm, false, ultra ? 4 : 2);

  const cutout = new CanvasTexture(drawCutout());
  cutout.colorSpace = SRGBColorSpace;
  cutout.wrapS = RepeatWrapping;
  cutout.wrapT = ClampToEdgeWrapping;
  cutout.anisotropy = albedo.anisotropy;
  const flag = new CanvasTexture(drawFlag());
  flag.colorSpace = SRGBColorSpace;
  flag.anisotropy = 4;

  const noise = makeNoise();
  const all: Texture[] = [albedo, normal, cutout, flag, noise];
  return { albedo, normal, cutout, flag, noise, dispose: () => all.forEach((t) => t.dispose()) };
}
