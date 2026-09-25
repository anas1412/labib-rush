// Deterministic "who is this person" from a seed: body, face, hair, outfit, carried items and
// motion style for a downtown-Tunis crowd. Pure data — geometry is built from it in ./body.ts.
import { Color } from 'three';

export type RGB = readonly [number, number, number];
export type Rng = () => number;

/** Linear-space RGB from an sRGB hex colour (vertex colours are linear). */
export const rgb = (hex: number): RGB => {
  const c = new Color(hex);
  return [c.r, c.g, c.b];
};
export const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const mul = (a: RGB, k: number): RGB => [a[0] * k, a[1] * k, a[2] * k];

/** mulberry32 over a hashed seed, so neighbouring seeds (0, 1, 2…) give unrelated people. */
export function rng(seed: number): Rng {
  let a = Math.imul((seed | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ 0xc2b2ae35;
  a = Math.imul(a ^ (a >>> 13), 0x27d4eb2f);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(r: Rng, a: readonly T[]): T => a[Math.floor(r() * a.length) % a.length];
const range = (r: Rng, lo: number, hi: number) => lo + (hi - lo) * r();
const chance = (r: Rng, p: number) => r() < p;
/** Weighted pick: [[weight, value], …]. */
function wpick<T>(r: Rng, a: readonly (readonly [number, T])[]): T {
  let s = 0;
  for (const [w] of a) s += w;
  let x = r() * s;
  for (const [w, v] of a) if ((x -= w) <= 0) return v;
  return a[a.length - 1][1];
}
/** Slight per-person dye/lighting variation of a palette colour. */
const vary = (r: Rng, c: RGB, amt = 0.08): RGB => mul(c, 1 + (r() * 2 - 1) * amt);

// ---------------------------------------------------------------------------------------------
// Palettes (sRGB hex). Chosen from street photos of downtown Tunis: muted, sun-faded, practical.
const SKIN = [0xefd0b4, 0xe3bc98, 0xd6a982, 0xc79671, 0xb7825c, 0x9c6a48, 0x7c5136, 0x5e3b27];
const SKIN_W: readonly (readonly [number, number])[] = [[1, 0], [3, 1], [4, 2], [4, 3], [3, 4], [2, 5], [1, 6], [0.6, 7]];
const HAIR_DARK = [0x16110e, 0x1f1712, 0x2b1d14, 0x3a271a];
const HAIR_LIGHT = [0x523622, 0x6b4a2f, 0x7a3b22 /* henna */, 0x9a7650 /* dyed */];
const HAIR_GREY = [0x6f6b67, 0x8e8a85, 0xb3aea7, 0xd4d0c8];

const JEANS = [0x2d4466, 0x3a5680, 0x22324c, 0x5873a0, 0x2b2b31, 0x4a5f7e];
const CHINOS = [0xc4ad86, 0x8f7c5c, 0x394155, 0x5b6447, 0x4a4541, 0x8a6a4e, 0xd6ccb8];
const SUITS = [0x22252d, 0x2b2f38, 0x3b3e46, 0x1c2130, 0x4a4239, 0x565a60];
const SHIRTS = [0xf1efe9, 0xc9d7e8, 0xe8dcc7, 0x9fb5cc, 0xd9cad9, 0xbac8a9, 0xe6bba9, 0xffffff];
const TEES = [0xc93434, 0x2e5b87, 0xe8e4dc, 0x383838, 0x6a8d4d, 0xd99a2b, 0x7a3b5e, 0x468787, 0xeeeeea, 0x9a9a96, 0x1d2a44];
const JACKETS = [0x26221f, 0x573826, 0x39495a, 0x55603f, 0x8a7a67, 0x46668c, 0x2d2d33, 0x6e2c2c];
const HOODIES = [0x6a6a70, 0x28385a, 0x842a2a, 0x3a5a41, 0xd8d0c3, 0x1f1f23, 0xb56a2c];
const DRESSES = [0x872a3a, 0x2a4a6a, 0xc5a577, 0x333336, 0x6a8a5a, 0xd4875a, 0x5a4a7a, 0x2f6b67, 0xa33b30];
const BLOUSES = [0xf3eee6, 0xe9c9c2, 0xbfd3e3, 0xe8dba8, 0xd2e0cf, 0xc9b2d6, 0xf1d9b8, 0x9a3a3a];
const HIJABS = [0xe7d7c5, 0x29292b, 0x8a5a6a, 0x4a6a8a, 0xc9a9a1, 0x6a7a5a, 0xf1ede5, 0x7a3838, 0xb08a5a, 0x3e5a6e];
const JEBBA = [0xf2ede2, 0xe3d9c6, 0xcdc4b3, 0xa99f8e, 0xece4d2];
const SAFSARI = 0xf1eadb;
const CHECHIA = 0x9b1a1c;
/** Flat caps (casquettes): tweed browns, greys, navy. */
const CAPS = [0x4a3b2e, 0x5c5248, 0x2e3440, 0x6b5a45, 0x3a3a38, 0x7a6a58];
const BACKPACKS = [0x2a2e38, 0x8a2a2a, 0x3a5a7a, 0x5a5a3a, 0xd08a30, 0x1c1c1f, 0x6a4a7a];
const BAGS = [0xb88f5f /* kraft */, 0xe9e9e4 /* white plastic */, 0xc53a3a, 0x3a6aa0, 0x2f2f33, 0xd9c7a0];
const HANDBAGS = [0x4a2e1c, 0x1c1a18, 0x8a5a40, 0xb08a60, 0x6e2a2e];

export type Age = 'young' | 'adult' | 'senior';
export type HairStyle = 'short' | 'buzz' | 'curly' | 'receding' | 'bald' | 'long' | 'ponytail' | 'bun' | 'bob' | 'covered';
export type Beard = 'none' | 'stubble' | 'short' | 'moustache';
export type Headwear = 'none' | 'hijab' | 'chechia' | 'safsari' | 'cap';
export type TopKind = 'tshirt' | 'polo' | 'shirt' | 'blouse' | 'sweater' | 'hoodie' | 'tunic' | 'robe' | 'dress';
export type JacketKind = 'suit' | 'blazer' | 'leather' | 'bomber' | 'cardigan' | 'denim';
export type BottomKind = 'jeans' | 'chinos' | 'suit' | 'skirt' | 'dress' | 'longskirt' | 'robe';
export type ShoeKind = 'sneaker' | 'leather' | 'flat' | 'slipper';
export type CarryKind = 'shopping' | 'paper' | 'briefcase' | 'handbag';
export type IdleStyle = 'relaxed' | 'behind' | 'pockets' | 'crossed' | 'clasped';

export interface Traits {
  seed: number;
  female: boolean;
  age: Age;
  /** Standing height to the top of the skull, m. */
  H: number;
  /** Horizontal build factor (0.9 slim … 1.15 heavy) and extra belly / bust volume 0..1. */
  width: number;
  belly: number;
  bust: number;
  skin: RGB;
  hair: RGB;
  hairStyle: HairStyle;
  beard: Beard;
  headwear: Headwear;
  headwearColor: RGB;
  top: { kind: TopKind; color: RGB; longSleeves: boolean; tucked: boolean; collar: boolean; vneck: boolean };
  jacket: { kind: JacketKind; color: RGB; open: boolean } | null;
  tie: RGB | null;
  bottom: { kind: BottomKind; color: RGB; hem: number /* fraction of H */ };
  legs: RGB; // bare legs / tights below skirts
  shoes: { kind: ShoeKind; color: RGB; sole: RGB };
  belt: RGB | null;
  backpack: RGB | null;
  carry: { kind: CarryKind; color: RGB } | null;
  glasses: 'none' | 'clear' | 'sun';
  /** Motion personality. */
  style: {
    stride: number; // stride length multiplier
    armSwing: number;
    stoop: number; // forward spine bend, rad
    sway: number; // hip sway multiplier
    energy: number; // gesture amplitude
    idle: IdleStyle;
    cheer: 0 | 1; // 0 = clapper, 1 = arms-up
    phase: number; // desynchronises idle loops
  };
}

export function makeTraits(seed: number): Traits {
  const r = rng(seed);
  const female = chance(r, 0.42); // downtown street crowds skew male
  const age: Age = wpick(r, [[0.4, 'young'], [0.4, 'adult'], [0.2, 'senior']] as const);
  const senior = age === 'senior';

  // body
  const baseH = female ? 1.63 : 1.75;
  const H = baseH + (r() + r() + r() - 1.5) * 0.09 - (senior ? 0.03 : 0) - (age === 'young' ? 0 : 0.005);
  const build = wpick(r, [[0.3, 0], [0.45, 1], [0.25, 2]] as const); // slim / average / heavy
  const width = [0.92, 1.0, 1.12][build] + range(r, -0.03, 0.03);
  const belly = build === 2 ? range(r, 0.4, 1) * (female ? 0.6 : 1) : age === 'adult' && !female ? range(r, 0, 0.3) : senior ? range(r, 0.1, 0.5) : 0;
  const bust = female ? range(r, 0.35, 1) : 0;

  // face / hair colours
  const skinBase = rgb(SKIN[wpick(r, SKIN_W)]);
  const skin = vary(r, skinBase, 0.05);
  const hair = rgb(senior ? pick(r, HAIR_GREY) : female && chance(r, 0.3) ? pick(r, HAIR_LIGHT) : chance(r, 0.12) ? HAIR_LIGHT[0] : pick(r, HAIR_DARK));

  const t: Traits = {
    seed, female, age, H, width, belly, bust, skin, hair,
    hairStyle: 'short', beard: 'none', headwear: 'none', headwearColor: [1, 1, 1],
    top: { kind: 'tshirt', color: [1, 1, 1], longSleeves: false, tucked: false, collar: false, vneck: false },
    jacket: null, tie: null,
    bottom: { kind: 'jeans', color: [0, 0, 0], hem: 0.035 },
    legs: skin,
    shoes: { kind: 'sneaker', color: [1, 1, 1], sole: [1, 1, 1] },
    belt: null, backpack: null, carry: null, glasses: 'none',
    style: {
      stride: range(r, 0.92, 1.08) * (senior ? 0.8 : 1), armSwing: range(r, 0.7, 1.2) * (senior ? 0.6 : 1),
      stoop: senior ? range(r, 0.08, 0.2) : range(r, -0.02, 0.05), sway: female ? range(r, 1.1, 1.5) : range(r, 0.7, 1),
      energy: range(r, 0.6, 1.2), idle: 'relaxed', cheer: chance(r, 0.5) ? 1 : 0, phase: r() * 100,
    },
  };
  const c = (hex: number) => vary(r, rgb(hex));

  if (female) dressWoman(t, r, c);
  else dressMan(t, r, c);

  // shoes default by outfit
  if (t.shoes.kind === 'sneaker') t.shoes.sole = rgb(chance(r, 0.8) ? 0xf0efeb : 0x2a2a2a);
  t.glasses = chance(r, 0.12) ? 'sun' : chance(r, senior ? 0.45 : 0.12) ? 'clear' : 'none';
  if (t.headwear === 'hijab' || t.headwear === 'safsari') t.hairStyle = 'covered';
  if (t.style.idle === 'relaxed' && !t.carry) {
    t.style.idle = senior && !female && chance(r, 0.7) ? 'behind'
      : wpick(r, [[5, 'relaxed'], [!female && t.bottom.kind !== 'robe' ? 3 : female && t.bottom.kind === 'jeans' ? 1 : 0, 'pockets'], [2, 'crossed'], [female || senior ? 2 : 0.5, 'clasped']] as const);
  }
  return t;
}

type Col = (hex: number) => RGB;

function dressMan(t: Traits, r: Rng, c: Col): void {
  const senior = t.age === 'senior';
  t.hairStyle = senior ? wpick(r, [[3, 'receding'], [2, 'bald'], [2, 'short']] as const)
    : wpick(r, [[4, 'short'], [2, 'buzz'], [2, 'curly'], [1, t.age === 'adult' ? 'receding' : 'short']] as const);
  t.beard = wpick(r, [[4, 'none'], [3, 'stubble'], [2, 'short'], [senior ? 2 : 1, 'moustache']] as const);
  const kind = senior ? wpick(r, [[3, 'jebba'], [2, 'casual'], [1, 'business']] as const)
    : t.age === 'young' ? wpick(r, [[3, 'student'], [3, 'casual'], [1, 'business']] as const)
      : wpick(r, [[4, 'casual'], [3, 'business']] as const);

  if (kind === 'jebba') {
    const robe = c(pick(r, JEBBA));
    t.top = { kind: 'robe', color: robe, longSleeves: true, tucked: false, collar: false, vneck: true };
    t.bottom = { kind: 'robe', color: robe, hem: range(r, 0.055, 0.08) };
    t.shoes = { kind: 'slipper', color: c(chance(r, 0.6) ? 0xd9bf85 : 0x4a2e1c), sole: rgb(0x3a2a1c) };
    if (chance(r, 0.8)) { t.headwear = 'chechia'; t.headwearColor = c(CHECHIA); }
    else if (chance(r, 0.6)) { t.headwear = 'cap'; t.headwearColor = c(pick(r, CAPS)); }
    if (t.hairStyle === 'short') t.hairStyle = 'receding';
    t.style.idle = 'behind';
    return;
  }
  if (kind === 'business') {
    const suit = c(pick(r, SUITS));
    t.top = { kind: 'shirt', color: c(pick(r, SHIRTS.slice(0, 5))), longSleeves: true, tucked: true, collar: true, vneck: false };
    t.jacket = { kind: 'suit', color: suit, open: chance(r, 0.35) };
    t.tie = chance(r, 0.7) ? c(pick(r, [0x7a1f2b, 0x1f2f55, 0x3a3a3a, 0x5a4a2a, 0x2f5a6a, 0x6a2a5a])) : null;
    t.bottom = { kind: 'suit', color: suit, hem: 0.03 };
    t.shoes = { kind: 'leather', color: c(chance(r, 0.6) ? 0x1c1a18 : 0x4a2e1c), sole: rgb(0x16120f) };
    t.belt = rgb(0x1a1612);
    if (chance(r, 0.45)) t.carry = { kind: 'briefcase', color: c(pick(r, [0x1c1a18, 0x4a2e1c, 0x2a2a2e])) };
    return;
  }
  if (t.age !== 'young' && chance(r, senior ? 0.45 : 0.08)) { t.headwear = 'cap'; t.headwearColor = c(pick(r, CAPS)); }
  else if (senior && chance(r, 0.15)) { t.headwear = 'chechia'; t.headwearColor = c(CHECHIA); }
  // casual / student
  const student = kind === 'student';
  t.bottom = { kind: chance(r, student ? 0.8 : 0.55) ? 'jeans' : 'chinos', color: [0, 0, 0], hem: range(r, 0.03, 0.042) };
  t.bottom.color = c(t.bottom.kind === 'jeans' ? pick(r, JEANS) : pick(r, CHINOS));
  const top = student ? wpick(r, [[3, 'tshirt'], [3, 'hoodie'], [1, 'shirt'], [1, 'polo']] as const)
    : wpick(r, [[3, 'tshirt'], [3, 'shirt'], [2, 'polo'], [senior ? 3 : 1, 'sweater']] as const);
  t.top = {
    kind: top, color: c(top === 'shirt' ? pick(r, SHIRTS) : top === 'hoodie' ? pick(r, HOODIES) : top === 'sweater' ? pick(r, [0x5a4a3a, 0x3a4a5a, 0x7a6a55, 0x4a4a4a, 0x6a2a2a]) : pick(r, TEES)),
    longSleeves: top === 'hoodie' || top === 'sweater' || (top === 'shirt' && chance(r, 0.6)), tucked: top === 'shirt' && chance(r, senior ? 0.8 : 0.3),
    collar: top === 'shirt' || top === 'polo', vneck: top === 'shirt' || top === 'polo',
  };
  if (t.top.tucked || chance(r, 0.3)) t.belt = rgb(chance(r, 0.5) ? 0x2a1c12 : 0x1a1612);
  if (!student && top !== 'hoodie' && chance(r, 0.35)) {
    const jk = wpick(r, [[3, 'leather'], [2, 'bomber'], [senior ? 3 : 1, 'blazer'], [1, 'denim']] as const);
    t.jacket = { kind: jk, color: c(jk === 'denim' ? 0x4a6a90 : jk === 'leather' ? pick(r, [0x26221f, 0x573826, 0x2d2d33]) : pick(r, JACKETS)), open: chance(r, 0.7) };
  }
  t.shoes = chance(r, student ? 0.85 : 0.55)
    ? { kind: 'sneaker', color: c(pick(r, [0xf0efeb, 0xf0efeb, 0x2a2a2e, 0x8a8a8e, 0x2e4a7a, 0x9a2a2a])), sole: [1, 1, 1] }
    : { kind: 'leather', color: c(pick(r, [0x1c1a18, 0x4a2e1c, 0x6e4a2e])), sole: rgb(0x1e1812) };
  if (student) t.backpack = c(pick(r, BACKPACKS));
  else if (chance(r, 0.22)) t.carry = { kind: chance(r, 0.4) ? 'paper' : 'shopping', color: c(pick(r, BAGS)) };
}

function dressWoman(t: Traits, r: Rng, c: Col): void {
  const senior = t.age === 'senior';
  const covered = chance(r, senior ? 0.55 : 0.35);
  if (senior && covered && chance(r, 0.45)) {
    // safsari: the traditional cream silk wrap worn over head and body
    t.headwear = 'safsari';
    t.headwearColor = rgb(SAFSARI);
    t.top = { kind: 'robe', color: rgb(SAFSARI), longSleeves: true, tucked: false, collar: false, vneck: false };
    t.bottom = { kind: 'robe', color: rgb(SAFSARI), hem: 0.05 };
    t.shoes = { kind: 'flat', color: c(0x2a2220), sole: rgb(0x1e1812) };
    if (chance(r, 0.5)) t.carry = { kind: chance(r, 0.5) ? 'shopping' : 'handbag', color: c(pick(r, BAGS)) };
    return;
  }
  if (covered) { t.headwear = 'hijab'; t.headwearColor = c(pick(r, HIJABS)); }
  t.hairStyle = wpick(r, [[3, 'long'], [2, 'ponytail'], [2, 'bun'], [2, 'bob'], [1, 'curly']] as const);
  if (senior && !covered) t.hairStyle = chance(r, 0.6) ? 'bob' : 'bun';

  const kind = t.age === 'young' ? wpick(r, [[3, 'casual'], [2, 'student'], [2, 'dress'], [covered ? 3 : 1, 'modest']] as const)
    : wpick(r, [[3, 'casual'], [2, 'office'], [2, 'dress'], [covered ? 3 : 1, 'modest']] as const);

  const flats = () => ({ kind: 'flat' as const, color: c(pick(r, [0x2a2020, 0x1c1a18, 0x8a5a40, 0xc9a07a, 0x6e2a2e])), sole: rgb(0x2a2018) });
  const sneakers = () => ({ kind: 'sneaker' as const, color: c(pick(r, [0xf0efeb, 0xf0efeb, 0xe9d9d9, 0x2a2a2e])), sole: rgb(0xf0efeb) });

  if (kind === 'modest') {
    // long tunic over a long skirt or wide trousers
    t.top = { kind: 'tunic', color: c(pick(r, [...BLOUSES, ...DRESSES])), longSleeves: true, tucked: false, collar: false, vneck: false };
    t.bottom = chance(r, 0.6)
      ? { kind: 'longskirt', color: c(pick(r, [0x2b2b31, 0x3a4255, 0x5a4a3a, 0x22324c, 0x4a3a4a])), hem: range(r, 0.045, 0.07) }
      : { kind: 'chinos', color: c(pick(r, [0x2b2b31, 0x3a4255, 0x22324c, 0x5a4a3a])), hem: 0.032 };
    t.shoes = chance(r, 0.6) ? flats() : sneakers();
  } else if (kind === 'dress') {
    const col = c(pick(r, DRESSES));
    const long = covered || chance(r, 0.4);
    t.top = { kind: 'dress', color: col, longSleeves: covered || chance(r, 0.3), tucked: false, collar: false, vneck: !covered && chance(r, 0.5) };
    t.bottom = { kind: 'dress', color: col, hem: long ? range(r, 0.06, 0.13) : range(r, 0.25, 0.31) };
    if (chance(r, 0.35)) t.jacket = { kind: chance(r, 0.5) ? 'denim' : 'cardigan', color: c(chance(r, 0.5) ? 0x4a6a90 : pick(r, [0xe8e0d0, 0x2a2a2e, 0xc5a577, 0x8a7a67])), open: true };
    t.shoes = flats();
  } else if (kind === 'office') {
    const suit = c(pick(r, [...SUITS, 0x8a7a67, 0xc5b59a, 0x6a2a2a]));
    t.top = { kind: 'blouse', color: c(pick(r, BLOUSES)), longSleeves: true, tucked: true, collar: false, vneck: !covered };
    t.jacket = { kind: 'blazer', color: suit, open: true };
    t.bottom = chance(r, 0.5) ? { kind: 'skirt', color: suit, hem: covered ? 0.07 : range(r, 0.26, 0.3) } : { kind: 'suit', color: suit, hem: 0.03 };
    t.shoes = flats();
    t.carry = chance(r, 0.6) ? { kind: 'handbag', color: c(pick(r, HANDBAGS)) } : null;
  } else {
    // casual / student
    t.bottom = chance(r, kind === 'student' ? 0.8 : 0.6)
      ? { kind: 'jeans', color: c(pick(r, JEANS)), hem: range(r, 0.03, 0.045) }
      : { kind: covered ? 'longskirt' : 'skirt', color: c(pick(r, [...DRESSES, 0x2d4466, 0xc4ad86])), hem: covered ? 0.05 : range(r, 0.22, 0.3) };
    const top = kind === 'student' ? wpick(r, [[3, 'tshirt'], [2, 'hoodie'], [2, 'blouse']] as const) : wpick(r, [[3, 'blouse'], [2, 'tshirt'], [2, 'sweater']] as const);
    t.top = {
      kind: covered && top === 'tshirt' ? 'tunic' : top,
      color: c(top === 'hoodie' ? pick(r, HOODIES) : top === 'tshirt' ? pick(r, TEES) : pick(r, BLOUSES)),
      longSleeves: covered || top !== 'tshirt' || chance(r, 0.2), tucked: false, collar: false, vneck: !covered && top === 'blouse' && chance(r, 0.5),
    };
    if (kind !== 'student' && chance(r, 0.35)) t.jacket = { kind: chance(r, 0.5) ? 'leather' : 'denim', color: c(chance(r, 0.5) ? 0x26221f : 0x4a6a90), open: true };
    t.shoes = chance(r, 0.55) ? sneakers() : flats();
    if (kind === 'student') t.backpack = c(pick(r, BACKPACKS));
    else if (chance(r, 0.5)) t.carry = { kind: chance(r, 0.55) ? 'handbag' : chance(r, 0.5) ? 'shopping' : 'paper', color: c(chance(r, 0.5) ? pick(r, HANDBAGS) : pick(r, BAGS)) };
  }
  // bare legs or tights under skirts
  if (t.bottom.kind === 'skirt' || t.bottom.kind === 'dress') t.legs = chance(r, 0.5) ? mix(t.skin, [0.02, 0.02, 0.025], 0.55) : t.skin;
}
