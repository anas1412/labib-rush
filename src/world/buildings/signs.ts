// Bilingual (French / Arabic) shop signs painted on one canvas atlas with the self-hosted fonts.
// Generic names only — no real brands. Each sign occupies a 1024 × 128 slot of a 2048² atlas;
// a second, half-resolution canvas holds what glows (pharmacy crosses, light-box signs).
import { CanvasTexture, SRGBColorSpace } from 'three';
import { loadFonts } from '../../core/fonts';

export type ShopKind =
  | 'cafe' | 'patisserie' | 'pharmacie' | 'librairie' | 'boutique' | 'banque' | 'voyage' | 'optique'
  | 'bijouterie' | 'parfumerie' | 'restaurant' | 'chaussures' | 'journaux' | 'assurance' | 'photo'
  | 'glacier' | 'taxiphone' | 'hotel';

interface SignDef {
  id: string;
  kind: ShopKind;
  fr: string;
  ar: string;
  bg: string;
  fg: string;
  /** light-box sign: text glows a little */
  glow?: boolean;
  serif?: boolean;
  /** awning colour of the shop (cafés match their terrace parasols) */
  fabric?: string;
}

export const SIGNS: SignDef[] = [
  // café names match the terrace furniture of the street module (same index as CAFE_TERRACES)
  { id: 'cafe1', kind: 'cafe', fr: 'Café El Yasmine', ar: 'مقهى الياسمين', bg: '#1f5f4a', fg: '#f3ecd8', fabric: '#1f5f4a' },
  { id: 'cafe2', kind: 'cafe', fr: "Café de l'Avenue", ar: 'مقهى الشارع', bg: '#8c1c22', fg: '#f6eedc', serif: true, fabric: '#8c1c22' },
  { id: 'cafe3', kind: 'cafe', fr: 'Salon de Thé Zitouna', ar: 'صالون شاي الزيتونة', bg: '#e6dcc4', fg: '#2d4a3a', fabric: '#2d4a3a' },
  { id: 'cafe4', kind: 'cafe', fr: 'Café Carthage', ar: 'مقهى قرطاج', bg: '#1c3f6e', fg: '#f4efe2', serif: true, fabric: '#1c3f6e' },
  { id: 'cafe5', kind: 'cafe', fr: 'Café El Medina', ar: 'مقهى المدينة', bg: '#c49a3c', fg: '#3a2412', fabric: '#c49a3c' },
  { id: 'cafe6', kind: 'cafe', fr: 'Café El Bahira', ar: 'مقهى البحيرة', bg: '#2f6f8f', fg: '#f6f2e6', fabric: '#2f6f8f' },
  { id: 'pat1', kind: 'patisserie', fr: 'Pâtisserie El Warda', ar: 'حلويات الوردة', bg: '#f3dcd8', fg: '#7a1f35', serif: true },
  { id: 'pat2', kind: 'patisserie', fr: 'Pâtisserie Chahia', ar: 'حلويات شهية', bg: '#5a2b1b', fg: '#f6e3b4' },
  { id: 'pha1', kind: 'pharmacie', fr: 'Pharmacie El Amal', ar: 'صيدلية الأمل', bg: '#f7f7f2', fg: '#11803c', glow: true },
  { id: 'pha2', kind: 'pharmacie', fr: "Pharmacie de l'Avenue", ar: 'صيدلية الشارع', bg: '#0f7a3a', fg: '#ffffff', glow: true },
  { id: 'lib1', kind: 'librairie', fr: 'Librairie Al Maarifa', ar: 'مكتبة المعرفة', bg: '#1b2f5a', fg: '#f2efe6', serif: true },
  { id: 'lib2', kind: 'librairie', fr: 'Librairie Nouvelle', ar: 'المكتبة الجديدة', bg: '#e8e1cf', fg: '#1d2a44' },
  { id: 'bou1', kind: 'boutique', fr: 'Boutique Yasmine', ar: 'بوتيك ياسمين', bg: '#111111', fg: '#f1f1f1', serif: true },
  { id: 'bou2', kind: 'boutique', fr: 'Prêt-à-porter Sarra', ar: 'ملابس سارة', bg: '#b8423a', fg: '#ffffff' },
  { id: 'cha1', kind: 'chaussures', fr: 'Chaussures Élégance', ar: 'أحذية الأناقة', bg: '#3b2a20', fg: '#e8c27a' },
  { id: 'ban1', kind: 'banque', fr: "Banque de l'Union", ar: 'بنك الاتحاد', bg: '#dcdcd8', fg: '#16305e', serif: true },
  { id: 'ban2', kind: 'banque', fr: 'Banque du Littoral', ar: 'بنك الساحل', bg: '#0e4c6e', fg: '#ffffff', glow: true },
  { id: 'voy1', kind: 'voyage', fr: 'Agence de Voyages Sindbad', ar: 'وكالة أسفار السندباد', bg: '#2a8bc4', fg: '#ffffff' },
  { id: 'opt1', kind: 'optique', fr: 'Optique Nour', ar: 'بصريات النور', bg: '#f4f4f4', fg: '#1a1a1a' },
  { id: 'bij1', kind: 'bijouterie', fr: 'Bijouterie El Ferdaous', ar: 'مجوهرات الفردوس', bg: '#101010', fg: '#d4af37', serif: true },
  { id: 'par1', kind: 'parfumerie', fr: 'Parfumerie Ambre', ar: 'عطور العنبر', bg: '#4b2a4f', fg: '#f3e6f5', serif: true },
  { id: 'res1', kind: 'restaurant', fr: 'Restaurant La Médina', ar: 'مطعم المدينة', bg: '#7c2d12', fg: '#fde8c8' },
  { id: 'jou1', kind: 'journaux', fr: 'Journaux · Revues', ar: 'جرائد · مجلات', bg: '#c1272d', fg: '#ffffff' },
  { id: 'ass1', kind: 'assurance', fr: 'Assurances Hannibal', ar: 'تأمينات حنبعل', bg: '#23395d', fg: '#ffffff', glow: true },
  { id: 'pho1', kind: 'photo', fr: 'Studio Photo Lumière', ar: 'استوديو الأضواء', bg: '#e9e4d8', fg: '#8b1d1d' },
  { id: 'gla1', kind: 'glacier', fr: 'Glacier Belvédère', ar: 'مثلجات البلفدير', bg: '#8fd0d8', fg: '#1a3d5c' },
  { id: 'tax1', kind: 'taxiphone', fr: 'Taxiphone · Publinet', ar: 'تاكسيفون · أنترنات', bg: '#f2c230', fg: '#1a1a1a', glow: true },
  { id: 'hot1', kind: 'hotel', fr: "Hôtel de l'Avenue", ar: 'نزل الشارع', bg: '#1a1a1a', fg: '#f3e2b0', glow: true },
];

export const SIGN_W_PX = 1024;
export const SIGN_H_PX = 128;
const ATLAS = 2048;

/** Special slots after the regular signs. */
const SLOT_CROSS = 30; // pharmacy green cross (square in the slot's left 128 px)
const SLOT_ROOF = 31; // hotel rooftop sign "HÔTEL نزل"

export interface SignAtlas {
  map: CanvasTexture;
  emissive: CanvasTexture;
  /** uv rect [s0, t0, s1, t1] of a sign id, or of 'cross' / 'roof'. */
  uv(id: string): [number, number, number, number];
  byKind(kind: ShopKind): SignDef[];
  /** awning fabric colour of a sign's shop, if it has one */
  fabric(id: string): string | undefined;
  dispose(): void;
}

function slotRect(i: number): [number, number, number, number] {
  const col = i % 2, row = Math.floor(i / 2);
  return [col * SIGN_W_PX, row * SIGN_H_PX, SIGN_W_PX, SIGN_H_PX];
}

function fitFont(g: CanvasRenderingContext2D, text: string, family: string, weight: number, maxPx: number, maxW: number): void {
  let px = maxPx;
  g.font = `${weight} ${px}px ${family}`;
  while (px > 16 && g.measureText(text).width > maxW) {
    px -= 2;
    g.font = `${weight} ${px}px ${family}`;
  }
}

function drawCross(g: CanvasRenderingContext2D, cx: number, cy: number, s: number, col: string): void {
  g.fillStyle = col;
  const a = s * 0.34, b = s;
  g.fillRect(cx - a / 2, cy - b / 2, a, b);
  g.fillRect(cx - b / 2, cy - a / 2, b, a);
}

export async function buildSignAtlas(): Promise<SignAtlas> {
  await loadFonts();
  const c = document.createElement('canvas');
  c.width = c.height = ATLAS;
  const e = document.createElement('canvas');
  e.width = e.height = ATLAS / 2;
  const g = c.getContext('2d')!;
  const ge = e.getContext('2d')!;
  g.fillStyle = '#202020';
  g.fillRect(0, 0, ATLAS, ATLAS);
  ge.fillStyle = '#000';
  ge.fillRect(0, 0, ATLAS / 2, ATLAS / 2);
  ge.scale(0.5, 0.5);

  const index = new Map<string, number>();
  SIGNS.forEach((s, i) => {
    index.set(s.id, i);
    const [x, y, w, h] = slotRect(i);
    // board with a subtle vertical gradient and a thin inset frame
    const grd = g.createLinearGradient(0, y, 0, y + h);
    grd.addColorStop(0, s.bg);
    grd.addColorStop(1, shade(s.bg, -0.18));
    g.fillStyle = grd;
    g.fillRect(x, y, w, h);
    g.strokeStyle = shade(s.fg, -0.1);
    g.globalAlpha = 0.55;
    g.lineWidth = 3;
    g.strokeRect(x + 8, y + 8, w - 16, h - 16);
    g.globalAlpha = 1;
    const fam = s.serif ? '"Baloo Bhaijaan 2", Cairo, serif' : 'Cairo, sans-serif';
    const icon = s.kind === 'pharmacie' ? 90 : 0;
    const half = (w - 80 - icon) / 2;
    for (const ctx of s.glow ? [g, ge] : [g]) {
      ctx.fillStyle = s.fg;
      ctx.textBaseline = 'middle';
      // French: left block
      ctx.direction = 'ltr';
      ctx.textAlign = 'left';
      fitFont(ctx, s.fr, fam, 800, 62, half);
      ctx.fillText(s.fr, x + 34, y + h / 2 + 4);
      // Arabic: right block
      ctx.direction = 'rtl';
      ctx.textAlign = 'right';
      fitFont(ctx, s.ar, 'Cairo, sans-serif', 800, 72, half);
      ctx.fillText(s.ar, x + w - 34, y + h / 2 + 2);
      ctx.direction = 'ltr';
    }
    if (icon) {
      drawCross(g, x + w / 2, y + h / 2, 70, s.fg);
      drawCross(ge, x + w / 2, y + h / 2, 70, '#2bd66a');
    }
  });

  // pharmacy blade: green neon cross on dark
  {
    const [x, y] = slotRect(SLOT_CROSS);
    g.fillStyle = '#0c1a10';
    g.fillRect(x, y, 128, 128);
    drawCross(g, x + 64, y + 64, 108, '#26c25e');
    drawCross(ge, x + 64, y + 64, 108, '#39ff7e');
  }
  // hotel rooftop sign
  {
    const [x, y, w, h] = slotRect(SLOT_ROOF);
    g.fillStyle = '#161616';
    g.fillRect(x, y, w, h);
    for (const ctx of [g, ge]) {
      ctx.fillStyle = '#f5e7c0';
      ctx.textBaseline = 'middle';
      ctx.direction = 'ltr';
      ctx.textAlign = 'left';
      ctx.font = '800 96px Cairo, sans-serif';
      ctx.fillText('HÔTEL', x + 60, y + h / 2 + 6);
      ctx.direction = 'rtl';
      ctx.textAlign = 'right';
      ctx.font = '800 100px Cairo, sans-serif';
      ctx.fillText('نزل', x + w - 60, y + h / 2);
      ctx.direction = 'ltr';
    }
  }

  const map = new CanvasTexture(c);
  map.colorSpace = SRGBColorSpace;
  map.anisotropy = 8;
  const emissive = new CanvasTexture(e);
  emissive.colorSpace = SRGBColorSpace;

  const uvOf = (slot: number, wPx = SIGN_W_PX): [number, number, number, number] => {
    const [x, y, , h] = slotRect(slot);
    return [(x + 2) / ATLAS, 1 - (y + h - 2) / ATLAS, (x + wPx - 2) / ATLAS, 1 - (y + 2) / ATLAS];
  };
  return {
    map,
    emissive,
    uv(id) {
      if (id === 'cross') return uvOf(SLOT_CROSS, 128);
      if (id === 'roof') return uvOf(SLOT_ROOF);
      const i = index.get(id);
      if (i === undefined) throw new Error(`unknown sign ${id}`);
      return uvOf(i);
    },
    byKind: (kind) => SIGNS.filter((s) => s.kind === kind),
    fabric: (id) => SIGNS.find((s) => s.id === id)?.fabric,
    dispose() {
      map.dispose();
      emissive.dispose();
    },
  };
}

/** Lighten (k > 0) or darken (k < 0) a #rrggbb colour. */
function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.round(Math.min(255, Math.max(0, k < 0 ? v * (1 + k) : v + (255 - v) * k)));
  const r = f(n >> 16), gg = f((n >> 8) & 255), b = f(n & 255);
  return `rgb(${r},${gg},${b})`;
}
