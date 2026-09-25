// Procedural canvas / data textures for the street (no downloads, no credits needed):
// ficus leaf atlas, road-paint wear, cast-iron covers, tree grates, water ripples.
import * as THREE from 'three';
import { makeRng, type Rng } from './common';

export function canvas2d(w: number, h: number): { c: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d', { willReadFrequently: false });
  if (!g) throw new Error('street: 2D canvas unavailable');
  return { c, g };
}

export function canvasTexture(c: HTMLCanvasElement, srgb: boolean, renderer: THREE.WebGLRenderer, repeat = false): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.needsUpdate = true;
  return t;
}

/** Seamlessly tiling value noise in [0,1], `period` lattice cells across the texture. */
export function tileNoise(size: number, period: number, octaves: number, seed: number): Float32Array {
  const out = new Float32Array(size * size);
  let amp = 1, norm = 0, p = period;
  for (let o = 0; o < octaves; o++) {
    const r = makeRng(seed + o * 101);
    const lat = new Float32Array(p * p).map(() => r());
    for (let y = 0; y < size; y++) {
      const fy = (y / size) * p, iy = Math.floor(fy), ty = fy - iy, sy = ty * ty * (3 - 2 * ty);
      for (let x = 0; x < size; x++) {
        const fx = (x / size) * p, ix = Math.floor(fx), tx = fx - ix, sx = tx * tx * (3 - 2 * tx);
        const a = lat[(iy % p) * p + (ix % p)], b = lat[(iy % p) * p + ((ix + 1) % p)];
        const c = lat[((iy + 1) % p) * p + (ix % p)], d = lat[((iy + 1) % p) * p + ((ix + 1) % p)];
        out[y * size + x] += amp * ((a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy);
      }
    }
    norm += amp;
    amp *= 0.5;
    p *= 2;
  }
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

/** Road paint coverage (alpha): scuffed, speckled, tyre-worn. Tiles every 4 m of world UV. */
export function paintWearTexture(renderer: THREE.WebGLRenderer): THREE.CanvasTexture {
  const S = 512;
  const { c, g } = canvas2d(S, S);
  const img = g.createImageData(S, S);
  const n = tileNoise(S, 6, 5, 11);
  const fine = tileNoise(S, 64, 2, 23);
  for (let i = 0; i < S * S; i++) {
    // worn patches where broad noise is low; aggregate speckles everywhere
    let a = THREE.MathUtils.smoothstep(n[i], 0.2, 0.42) * (0.7 + 0.3 * THREE.MathUtils.smoothstep(fine[i], 0.2, 0.55));
    a = Math.min(1, a * 1.15);
    const v = Math.round(a * 255);
    img.data.set([v, v, v, 255], i * 4);
  }
  g.putImageData(img, 0, 0);
  // random chips
  const r = makeRng(5);
  g.fillStyle = '#000';
  for (let i = 0; i < 260; i++) {
    g.globalAlpha = 0.3 + r() * 0.5;
    g.beginPath();
    g.arc(r() * S, r() * S, 0.5 + r() * 1.3, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;
  return canvasTexture(c, false, renderer, true);
}

/**
 * Cast-iron covers atlas (512×256): left = round manhole (alpha outside the disc), right = gutter
 * drain grate. Returns colour and a bump (height) map.
 */
export function coversTextures(renderer: THREE.WebGLRenderer): { map: THREE.CanvasTexture; bump: THREE.CanvasTexture } {
  const W = 512, H = 256;
  const col = canvas2d(W, H), bump = canvas2d(W, H);
  const r = makeRng(77);
  for (const { g, isBump } of [{ g: col.g, isBump: false }, { g: bump.g, isBump: true }]) {
    g.clearRect(0, 0, W, H);
    // manhole
    const cx = 128, cy = 128, R = 122;
    g.save();
    g.beginPath();
    g.arc(cx, cy, R, 0, Math.PI * 2);
    g.clip();
    g.fillStyle = isBump ? '#606060' : '#2b2a28';
    g.fillRect(0, 0, 256, 256);
    // concentric rings + cross-hatch studs
    g.strokeStyle = isBump ? '#b0b0b0' : '#4a4743';
    g.lineWidth = 5;
    for (const rr of [118, 96, 40]) {
      g.beginPath();
      g.arc(cx, cy, rr, 0, Math.PI * 2);
      g.stroke();
    }
    g.fillStyle = isBump ? '#c8c8c8' : '#55514b';
    for (let y = -96; y <= 96; y += 12) {
      for (let x = -96; x <= 96; x += 12) {
        const d = Math.hypot(x, y);
        if (d < 44 || d > 90) continue;
        g.save();
        g.translate(cx + x, cy + y);
        g.rotate(Math.PI / 4);
        g.fillRect(-3.2, -3.2, 6.4, 6.4);
        g.restore();
      }
    }
    // central plate with a lifting slot
    g.fillStyle = isBump ? '#9a9a9a' : '#3a3834';
    g.beginPath();
    g.arc(cx, cy, 36, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = isBump ? '#202020' : '#141312';
    g.fillRect(cx - 14, cy - 3, 28, 6);
    if (!isBump) {
      // rust + grime
      for (let i = 0; i < 260; i++) {
        g.fillStyle = r() < 0.5 ? 'rgba(92,58,34,0.18)' : 'rgba(20,18,16,0.25)';
        g.beginPath();
        g.arc(r() * 256, r() * 256, 2 + r() * 10, 0, Math.PI * 2);
        g.fill();
      }
    }
    g.restore();
    // drain grate (right half): frame + slots
    const gx = 256, gw = 256;
    g.fillStyle = isBump ? '#707070' : '#2e2c29';
    g.fillRect(gx, 0, gw, H);
    g.fillStyle = isBump ? '#000' : '#0a0908';
    for (let i = 0; i < 9; i++) g.fillRect(gx + 22 + i * 24, 26, 12, H - 52);
    if (!isBump) {
      for (let i = 0; i < 160; i++) {
        g.fillStyle = r() < 0.5 ? 'rgba(96,62,38,0.2)' : 'rgba(0,0,0,0.25)';
        g.beginPath();
        g.arc(gx + r() * gw, r() * H, 2 + r() * 8, 0, Math.PI * 2);
        g.fill();
      }
    }
  }
  return { map: canvasTexture(col.c, true, renderer), bump: canvasTexture(bump.c, false, renderer) };
}

/** Square cast-iron tree grate (radial slots over dark soil), colour + bump. */
export function grateTextures(renderer: THREE.WebGLRenderer): { map: THREE.CanvasTexture; bump: THREE.CanvasTexture } {
  const S = 512;
  const out: THREE.CanvasTexture[] = [];
  const r = makeRng(31);
  for (const isBump of [false, true]) {
    const { c, g } = canvas2d(S, S);
    const iron = isBump ? '#a0a0a0' : '#2a2b27';
    const soil = isBump ? '#000' : '#1b1510';
    g.fillStyle = soil;
    g.fillRect(0, 0, S, S);
    if (!isBump) {
      for (let i = 0; i < 1500; i++) {
        g.fillStyle = `rgba(${60 + r() * 40},${48 + r() * 30},${36 + r() * 20},${0.35 + r() * 0.4})`;
        g.fillRect(r() * S, r() * S, 2 + r() * 3, 2 + r() * 3);
      }
    }
    g.strokeStyle = iron;
    g.fillStyle = iron;
    g.lineWidth = 22;
    g.strokeRect(11, 11, S - 22, S - 22); // outer frame
    const cx = S / 2;
    g.lineWidth = 10;
    for (const rr of [70, 120, 170, 215]) {
      g.beginPath();
      g.arc(cx, cx, rr, 0, Math.PI * 2);
      g.stroke();
    }
    g.lineWidth = 9;
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * 70, cx + Math.sin(a) * 70);
      g.lineTo(cx + Math.cos(a) * 400, cx + Math.sin(a) * 400);
      g.stroke();
    }
    g.lineWidth = 22;
    g.strokeRect(11, 11, S - 22, S - 22);
    // hole for the trunk
    g.fillStyle = soil;
    g.beginPath();
    g.arc(cx, cx, 58, 0, Math.PI * 2);
    g.fill();
    out.push(canvasTexture(c, !isBump, renderer));
  }
  return { map: out[0], bump: out[1] };
}

/** Draws one small glossy Ficus microcarpa leaf (folded along a pale midrib) into colour + normal. */
function drawLeaf(col: CanvasRenderingContext2D, nor: CanvasRenderingContext2D, r: Rng, x: number, y: number, ang: number, len: number, shade: number): void {
  const w = len * 0.42;
  const young = r() < 0.1;
  const h = young ? 80 + r() * 10 : 96 + r() * 16;
  const s = young ? 42 + r() * 14 : 34 + r() * 16;
  const l = (young ? 32 : 15 + r() * 10) * shade;
  const tiltX = (r() - 0.5) * 0.9, tiltY = (r() - 0.5) * 0.9, fold = 0.35 + r() * 0.25;
  const nc = (nx: number, ny: number, nz: number) => {
    const k = Math.hypot(nx, ny, nz);
    return `rgb(${Math.round((nx / k) * 127 + 128)},${Math.round((ny / k) * 127 + 128)},${Math.round((nz / k) * 127 + 128)})`;
  };
  for (const [g, isN] of [[col, false], [nor, true]] as const) {
    g.save();
    g.translate(x, y);
    g.rotate(ang);
    for (const side of [-1, 1]) {
      g.beginPath();
      g.moveTo(0, -len / 2);
      g.bezierCurveTo(side * w * 0.95, -len * 0.3, side * w * 0.85, len * 0.3, 0, len / 2);
      g.closePath();
      g.fillStyle = isN ? nc(tiltX + side * fold, tiltY, 1) : `hsl(${h}, ${s}%, ${l + (side > 0 ? 3 : 0)}%)`;
      g.fill();
    }
    if (!isN) {
      g.strokeStyle = `hsla(${h - 10}, 30%, ${l + 15}%, 0.75)`;
      g.lineWidth = Math.max(1, len * 0.045);
      g.beginPath();
      g.moveTo(0, -len * 0.48);
      g.lineTo(0, len * 0.45);
      g.stroke();
    }
    g.restore();
  }
}

export interface FoliageTextures {
  /** Leaf-card atlas (2×2 open sprig clusters); alpha = coverage. */
  cardMap: THREE.CanvasTexture;
  cardNormal: THREE.CanvasTexture;
  /** Seamless dense-leaf tile for the opaque canopy core. */
  tileMap: THREE.CanvasTexture;
  tileNormal: THREE.CanvasTexture;
  /** Seamless mask with small round holes: sun flecks in the core's shadow. */
  tileHoles: THREE.CanvasTexture;
}

export function foliageTextures(renderer: THREE.WebGLRenderer, size: number): FoliageTextures {
  const rng = makeRng(1234);
  // --- card atlas -------------------------------------------------------------------------
  const col = canvas2d(size, size), nor = canvas2d(size, size);
  const cell = size / 2;
  nor.g.fillStyle = 'rgb(128,128,255)';
  nor.g.fillRect(0, 0, size, size);
  for (let ci = 0; ci < 4; ci++) {
    const ox = (ci % 2) * cell, oy = Math.floor(ci / 2) * cell;
    const cx = ox + cell / 2, cy = oy + cell / 2, R = cell * 0.46;
    for (const g of [col.g, nor.g]) {
      g.save();
      g.beginPath();
      g.rect(ox + 2, oy + 2, cell - 4, cell - 4);
      g.clip();
    }
    const leafLen = cell * 0.075;
    // dense middle, sprigs breaking the outline
    for (let i = 0; i < 260; i++) {
      const a = rng() * Math.PI * 2, d = Math.sqrt(rng()) * R * 0.62;
      drawLeaf(col.g, nor.g, rng, cx + Math.cos(a) * d, cy + Math.sin(a) * d, rng() * Math.PI * 2, leafLen * (0.8 + rng() * 0.4), 0.8 + rng() * 0.35);
    }
    const sprigs = 9;
    for (let k = 0; k < sprigs; k++) {
      const a = (k / sprigs) * Math.PI * 2 + rng() * 0.5;
      const L = R * (0.8 + rng() * 0.2);
      col.g.strokeStyle = '#4b4236';
      col.g.lineWidth = cell * 0.007;
      col.g.beginPath();
      col.g.moveTo(cx + Math.cos(a) * R * 0.4, cy + Math.sin(a) * R * 0.4);
      col.g.lineTo(cx + Math.cos(a) * L * 0.92, cy + Math.sin(a) * L * 0.92);
      col.g.stroke();
      for (let i = 0; i < 18; i++) {
        const t = 0.45 + (i / 18) * 0.55, side = i % 2 ? 1 : -1;
        const len = leafLen * (0.75 + rng() * 0.4);
        const dir = a + side * (0.5 + rng() * 0.6);
        drawLeaf(col.g, nor.g, rng, cx + Math.cos(a) * L * t + Math.cos(dir) * len * 0.5, cy + Math.sin(a) * L * t + Math.sin(dir) * len * 0.5, dir - Math.PI / 2, len, 0.9 + rng() * 0.3);
      }
    }
    col.g.restore();
    nor.g.restore();
  }
  bleedColour(col.g, size, [34, 52, 26]);

  // --- seamless dense tile (leaves wrap around the edges) -----------------------------------
  const T = size / 2;
  const tcol = canvas2d(T, T), tnor = canvas2d(T, T), holes = canvas2d(T, T);
  tcol.g.fillStyle = '#16230f';
  tcol.g.fillRect(0, 0, T, T);
  tnor.g.fillStyle = 'rgb(128,128,255)';
  tnor.g.fillRect(0, 0, T, T);
  const tLen = T * 0.07;
  for (let i = 0; i < 1100; i++) {
    const x = rng() * T, y = rng() * T, ang = rng() * Math.PI * 2, len = tLen * (0.8 + rng() * 0.45), sh = 0.7 + rng() * 0.45;
    const seed = Math.floor(rng() * 1e9);
    for (const dx of [-T, 0, T]) {
      for (const dy of [-T, 0, T]) {
        if (x + dx < -tLen || x + dx > T + tLen || y + dy < -tLen || y + dy > T + tLen) continue;
        drawLeaf(tcol.g, tnor.g, makeRng(seed), x + dx, y + dy, ang, len, sh);
      }
    }
  }
  holes.g.fillStyle = '#fff';
  holes.g.fillRect(0, 0, T, T);
  holes.g.fillStyle = '#000';
  for (let i = 0; i < 16; i++) {
    const x = rng() * T, y = rng() * T, rr = T * (0.04 + rng() * 0.06);
    for (const dx of [-T, 0, T]) for (const dy of [-T, 0, T]) {
      holes.g.beginPath();
      holes.g.arc(x + dx, y + dy, rr, 0, Math.PI * 2);
      holes.g.fill();
    }
  }
  return {
    cardMap: canvasTexture(col.c, true, renderer),
    cardNormal: canvasTexture(nor.c, false, renderer),
    tileMap: canvasTexture(tcol.c, true, renderer, true),
    tileNormal: canvasTexture(tnor.c, false, renderer, true),
    tileHoles: canvasTexture(holes.c, false, renderer, true),
  };
}

/** Mipmaps average transparent black into card edges: bleed leaf colour into the background so
 *  distant canopies stay green instead of darkening at the card edges. */
function bleedColour(g: CanvasRenderingContext2D, size: number, fill: [number, number, number], height = size): void {
  const img = g.getImageData(0, 0, size, height);
  const d = img.data;
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < size - 1; x++) {
        const i = (y * size + x) * 4;
        if (d[i + 3] > 0) continue;
        for (const o of [-4, 4, -size * 4, size * 4]) {
          const j = i + o;
          if (d[j + 3] > 1 || (pass > 0 && d[j + 3] === 1)) {
            d[i] = d[j]; d[i + 1] = d[j + 1]; d[i + 2] = d[j + 2]; d[i + 3] = 1;
            break;
          }
        }
      }
    }
  }
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 1) d[i + 3] = 0;
    else if (d[i + 3] === 0) d.set([fill[0], fill[1], fill[2], 0], i);
  }
  g.putImageData(img, 0, 0);
}

/** Tiling ripple normal map for the lake (from a sum of noise octaves). */
export function waterNormalTexture(): THREE.DataTexture {
  const S = 256;
  const h = tileNoise(S, 8, 4, 91);
  const data = new Uint8Array(S * S * 4);
  const k = 5.0;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = h[y * S + ((x + 1) % S)] - h[y * S + ((x - 1 + S) % S)];
      const dy = h[((y + 1) % S) * S + x] - h[((y - 1 + S) % S) * S + x];
      const nx = -dx * k, ny = -dy * k, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      data.set([(nx / l) * 127 + 128, (ny / l) * 127 + 128, (nz / l) * 127 + 128, 255], (y * S + x) * 4);
    }
  }
  const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/** Tunisian flag (3:2): red field, white disc, red crescent and five-pointed star. */
export function flagTexture(renderer: THREE.WebGLRenderer): THREE.CanvasTexture {
  const W = 768, H = 512;
  const { c, g } = canvas2d(W, H);
  g.fillStyle = '#e70013';
  g.fillRect(0, 0, W, H);
  const cx = W / 2, cy = H / 2, R = H / 4;
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.arc(cx, cy, R, 0, Math.PI * 2);
  g.fill();
  // crescent: red disc minus an offset white disc, opening toward the fly
  g.fillStyle = '#e70013';
  g.beginPath();
  g.arc(cx - R * 0.06, cy, R * 0.75, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.arc(cx + R * 0.13, cy, R * 0.6, 0, Math.PI * 2);
  g.fill();
  // star inside the crescent, one point toward the hoist
  g.fillStyle = '#e70013';
  g.beginPath();
  const sx = cx + R * 0.2, ro = R * 0.42, ri = ro * 0.382;
  for (let i = 0; i < 10; i++) {
    const a = Math.PI + (i * Math.PI) / 5, rr = i % 2 ? ri : ro;
    g.lineTo(sx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  g.closePath();
  g.fill();
  // fabric weave shading
  const r = makeRng(3);
  for (let i = 0; i < 1400; i++) {
    g.fillStyle = r() < 0.5 ? 'rgba(0,0,0,0.035)' : 'rgba(255,255,255,0.035)';
    g.fillRect(r() * W, 0, 1, H);
  }
  return canvasTexture(c, true, renderer);
}

/** Atlas cells (u0, v0, u1, v1) of the sign atlas, in UV space (v up). */
export const SIGN_CELLS = {
  avenue: [0, 1 - 170 / 1024, 0.5, 1],
  indep: [0.5, 1 - 170 / 1024, 1, 1],
  janvier: [0, 1 - 340 / 1024, 0.5, 1 - 170 / 1024],
  france: [0.5, 1 - 340 / 1024, 1, 1 - 170 / 1024],
  crossing: [0, 1 - 680 / 1024, 340 / 1024, 1 - 340 / 1024],
  travaux: [340 / 1024, 1 - 680 / 1024, 1, 1 - 340 / 1024],
  tarp: [0, 1 - 1008 / 1024, 1, 1 - 688 / 1024],
  metal: [0.02, 1 - 686 / 1024, 0.2, 1 - 682 / 1024],
} as const;
export type SignCell = keyof typeof SIGN_CELLS;

/** Street name plates (Arabic + French), pedestrian-crossing sign, bilingual 'Travaux' sign. */
export function signAtlas(renderer: THREE.WebGLRenderer): THREE.CanvasTexture {
  const S = 1024;
  const { c, g } = canvas2d(S, S);
  g.fillStyle = '#9aa0a3';
  g.fillRect(0, 0, S, S);
  const plate = (x: number, y: number, ar: string, fr: string) => {
    g.fillStyle = '#1d4f91';
    g.fillRect(x, y, 512, 170);
    g.strokeStyle = '#f4f4f0';
    g.lineWidth = 7;
    g.strokeRect(x + 12, y + 12, 488, 146);
    g.fillStyle = '#f4f4f0';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '700 50px Cairo';
    g.direction = 'rtl';
    g.fillText(ar, x + 256, y + 62, 460);
    g.direction = 'ltr';
    g.font = '600 38px Cairo';
    g.fillText(fr, x + 256, y + 122, 460);
  };
  plate(0, 0, 'شارع الحبيب بورقيبة', 'Avenue Habib Bourguiba');
  plate(512, 0, 'ساحة الاستقلال', "Place de l'Indépendance");
  plate(0, 170, 'ساحة 14 جانفي 2011', 'Place du 14 Janvier 2011');
  plate(512, 170, 'شارع فرنسا', 'Avenue de France');
  // pedestrian crossing (blue square, white triangle, walking figure)
  {
    const x = 0, y = 340, s = 340;
    g.fillStyle = '#1d5fb0';
    g.fillRect(x, y, s, s);
    g.strokeStyle = '#fff';
    g.lineWidth = 8;
    g.strokeRect(x + 10, y + 10, s - 20, s - 20);
    g.fillStyle = '#fff';
    g.beginPath();
    g.moveTo(x + s / 2, y + 40);
    g.lineTo(x + s - 40, y + s - 50);
    g.lineTo(x + 40, y + s - 50);
    g.closePath();
    g.fill();
    g.fillStyle = '#111';
    for (let i = 0; i < 4; i++) g.fillRect(x + 92 + i * 42, y + s - 92, 26, 22);
    g.lineCap = 'round';
    g.strokeStyle = '#111';
    g.lineWidth = 16;
    const px = x + s / 2, py = y + 150;
    g.beginPath();
    g.arc(px + 4, py - 30, 16, 0, Math.PI * 2);
    g.fill();
    g.beginPath();
    g.moveTo(px, py - 8); g.lineTo(px - 8, py + 50); // body
    g.moveTo(px - 8, py + 50); g.lineTo(px - 34, py + 92); // back leg
    g.moveTo(px - 8, py + 50); g.lineTo(px + 22, py + 90); // front leg
    g.moveTo(px - 2, py + 6); g.lineTo(px - 32, py + 40); // arm
    g.moveTo(px - 2, py + 6); g.lineTo(px + 28, py + 30);
    g.stroke();
  }
  // 'Travaux' works sign
  {
    const x = 340, y = 340, w = 684, h = 340;
    g.fillStyle = '#f2c200';
    g.fillRect(x, y, w, h);
    g.strokeStyle = '#111';
    g.lineWidth = 14;
    g.strokeRect(x + 14, y + 14, w - 28, h - 28);
    g.save();
    g.beginPath();
    g.rect(x + 21, y + h - 88, w - 42, 67);
    g.clip();
    for (let i = -10; i < 30; i++) {
      g.fillStyle = i % 2 ? '#d11a1a' : '#fafafa';
      g.beginPath();
      g.moveTo(x + i * 48, y + h);
      g.lineTo(x + i * 48 + 48, y + h);
      g.lineTo(x + i * 48 + 118, y + h - 100);
      g.lineTo(x + i * 48 + 70, y + h - 100);
      g.fill();
    }
    g.restore();
    g.fillStyle = '#111';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '800 92px Cairo';
    g.fillText('TRAVAUX', x + w / 2, y + 88, w - 60);
    g.direction = 'rtl';
    g.font = '800 84px Cairo';
    g.fillText('أشغال', x + w / 2, y + 186, w - 60);
    g.direction = 'ltr';
  }
  // construction-fence privacy tarp (one panel ≈ 3.4 × 1.2 m): green mesh fabric, eyelets, a white
  // band with the bilingual works notice
  {
    const x = 0, y = 688, w = 1024, h = 320;
    g.fillStyle = '#1f4a37';
    g.fillRect(x, y, w, h);
    const r = makeRng(41);
    for (let i = 0; i < w; i += 3) {
      g.fillStyle = 'rgba(0,0,0,0.10)';
      g.fillRect(x + i, y, 1, h);
    }
    for (let j = 0; j < h; j += 3) {
      g.fillStyle = 'rgba(255,255,255,0.04)';
      g.fillRect(x, y + j, w, 1);
    }
    for (let i = 0; i < 90; i++) {
      g.fillStyle = `rgba(20,16,10,${0.05 + r() * 0.08})`;
      g.fillRect(x + r() * w, y + h * (0.55 + r() * 0.45), 2 + r() * 30, 1 + r() * 3); // dust splashes
    }
    g.fillStyle = '#e9ece6';
    g.fillRect(x, y + 10, w, 6);
    g.fillRect(x, y + h - 16, w, 6);
    for (let i = 24; i < w; i += 96) {
      for (const yy of [y + 26, y + h - 26]) {
        g.beginPath();
        g.arc(x + i, yy, 7, 0, Math.PI * 2);
        g.fillStyle = '#c9ccc6';
        g.fill();
        g.beginPath();
        g.arc(x + i, yy, 3, 0, Math.PI * 2);
        g.fillStyle = '#12261c';
        g.fill();
      }
    }
    g.fillStyle = '#f2f3ee';
    g.fillRect(x + 40, y + 64, w - 80, 136);
    g.fillStyle = '#1f4a37';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '800 92px Cairo';
    g.fillText('TRAVAUX', x + w * 0.3, y + 134, w * 0.5);
    g.direction = 'rtl';
    g.font = '800 96px Cairo';
    g.fillText('أشغال', x + w * 0.76, y + 128, w * 0.36);
    g.direction = 'ltr';
    g.fillStyle = '#e9ece6';
    g.font = '700 38px Cairo';
    g.fillText('CHANTIER  —  ACCÈS INTERDIT', x + w * 0.3, y + 250, w * 0.52);
    g.direction = 'rtl';
    g.font = '700 42px Cairo';
    g.fillText('ممنوع الدخول', x + w * 0.76, y + 248, w * 0.36);
    g.direction = 'ltr';
  }
  return canvasTexture(c, true, renderer);
}

/** Galvanised welded-mesh fence panel (alpha grid, one tile = 0.4 m: 0.1 × 0.2 m cells). The
 *  wires are drawn thicker than real (1.2 cm) so the mesh still reads from across the plaza. */
export function fenceMeshTexture(renderer: THREE.WebGLRenderer): THREE.CanvasTexture {
  const S = 128;
  const { c, g } = canvas2d(S, S);
  g.fillStyle = '#000';
  g.fillRect(0, 0, S, S);
  g.fillStyle = '#fff';
  for (let i = 0; i < 4; i++) g.fillRect(i * 32 - 2, 0, 4, S);
  for (let i = 0; i < 2; i++) g.fillRect(0, i * 64 - 2, S, 4);
  g.fillRect(S - 2, 0, 2, S);
  g.fillRect(0, S - 2, S, 2);
  return canvasTexture(c, false, renderer, true);
}

/** Two rows (512 × 128 each) of bedding-plant strips for the planters: leaves along the bottom,
 *  five-petal blooms above (row 0 geraniums / petunias, row 1 pansies), alpha = coverage. */
export function flowerStripTexture(renderer: THREE.WebGLRenderer): THREE.CanvasTexture {
  const W = 512, H = 256, RH = 128;
  const { c, g } = canvas2d(W, H);
  g.clearRect(0, 0, W, H);
  const r = makeRng(606);
  const palettes = [['#c8102e', '#e0245e', '#f26b8a', '#f7f1ea', '#d42a4a'], ['#6a2c91', '#f3eee6', '#f2c230', '#8e44ad', '#c0392b']];
  for (let row = 0; row < 2; row++) {
    const y0 = row * RH;
    g.save();
    g.beginPath();
    g.rect(0, y0 + 1, W, RH - 2);
    g.clip();
    // foliage mound
    for (let i = 0; i < 420; i++) {
      const x = r() * W, y = y0 + RH * (0.45 + r() * 0.55);
      g.fillStyle = `hsl(${95 + r() * 30}, ${35 + r() * 25}%, ${16 + r() * 16}%)`;
      g.beginPath();
      g.ellipse(x, y, 5 + r() * 6, 3 + r() * 3, r() * Math.PI, 0, Math.PI * 2);
      g.fill();
    }
    // blooms
    const pal = palettes[row];
    for (let i = 0; i < 150; i++) {
      const x = r() * W, y = y0 + RH * (0.12 + r() * 0.55), R = 4.5 + r() * 4.5;
      const col = pal[Math.floor(r() * pal.length)];
      const rot = r() * Math.PI;
      g.fillStyle = col;
      for (let k = 0; k < 5; k++) {
        const a = rot + (k / 5) * Math.PI * 2;
        g.beginPath();
        g.ellipse(x + Math.cos(a) * R * 0.55, y + Math.sin(a) * R * 0.55, R * 0.55, R * 0.4, a, 0, Math.PI * 2);
        g.fill();
      }
      g.fillStyle = 'rgba(0,0,0,0.18)';
      g.beginPath();
      g.arc(x, y, R * 0.45, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = row === 1 ? '#f5d142' : '#f0e2a0';
      g.beginPath();
      g.arc(x, y, R * 0.22, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
  }
  bleedColour(g, W, [40, 60, 30], H);
  return canvasTexture(c, true, renderer);
}
