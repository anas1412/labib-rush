// Persistence (localStorage, versioned keys) + leaderboard and name rules.
// Every storage access is wrapped: when storage is blocked (private mode, sandboxed iframe, quota)
// data lives in memory for the session and `persistent` turns false so the UI can say so.
import { DEFAULT_SETTINGS, type Quality, type ScoreEntry, type Settings } from '../core/types';

export const STORAGE_PREFIX = 'labibRush.v1.';
export const LEADERBOARD_KEEP = 50;
export const LEADERBOARD_SHOW = 10;
export const NAME_MIN = 2;
export const NAME_MAX = 16;

// ---- leaderboard (pure) ---------------------------------------------------------------------

const time = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Infinity : t;
};

/** Score desc; ties → earlier date first. Stable for identical rows. */
export function compareScores(a: ScoreEntry, b: ScoreEntry): number {
  return b.score - a.score || time(a.date) - time(b.date);
}

/** Inserts `entry`, returns the new top-50 list and the entry's 1-based rank (may be > 50: not kept). */
export function insertScore(list: readonly ScoreEntry[], entry: ScoreEntry): { list: ScoreEntry[]; rank: number } {
  const all = [...list, entry].sort(compareScores);
  return { list: all.slice(0, LEADERBOARD_KEEP), rank: all.indexOf(entry) + 1 };
}

/** 1-based rank of `entry` in a sorted list; if absent, the rank it would get. */
export function rankOf(list: readonly ScoreEntry[], entry: ScoreEntry): number {
  const i = list.indexOf(entry);
  if (i >= 0) return i + 1;
  const after = list.findIndex((e) => compareScores(entry, e) < 0);
  return (after < 0 ? list.length : after) + 1;
}

/** Same person? Names are compared case-insensitively after normalisation. */
const nameKey = (n: string) => normalizeName(n).toLocaleLowerCase();
const sameName = (a: string, b: string) => nameKey(a) === nameKey(b);

/** Best entry for a player in the list (sorted), or null. */
export function bestFor(list: readonly ScoreEntry[], name: string): ScoreEntry | null {
  return list.find((e) => sameName(e.name, name)) ?? null;
}

function isEntry(v: unknown): v is ScoreEntry {
  const e = v as ScoreEntry;
  return !!e && typeof e.name === 'string' && Number.isFinite(e.score) && Number.isFinite(e.items)
    && Number.isFinite(e.bestCombo) && Number.isFinite(e.durationSec) && typeof e.date === 'string';
}

// ---- names (pure) ---------------------------------------------------------------------------

/** NFC, trim, collapse whitespace runs to one space. */
export function normalizeName(raw: string): string {
  return raw.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

/** User-perceived characters (grapheme clusters), falling back to code points. */
export function nameLength(s: string): number {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)].length;
  }
  return [...s].length;
}

// Letters of the Arabic or Latin scripts (incl. accented letters and tatweel), their combining
// marks (harakat, accents), Western + Arabic-Indic digits, space, '-', '_', '.'.
const NAME_CHARS = /^(?:(?=\p{L})[\p{scx=Arabic}\p{scx=Latin}]|\p{M}|[0-9\u0660-\u0669\u06F0-\u06F9 ._-])+$/u;
const MARK_PILE = /\p{M}{3,}/u; // "Zalgo" stacks — real names use at most two marks per letter

export type NameProblem = 'empty' | 'short' | 'long' | 'chars';
export type NameCheck = { ok: true; name: string } | { ok: false; name: string; problem: NameProblem; error: string };

const NAME_ERRORS: Record<NameProblem, string> = {
  empty: 'Please enter a name.',
  short: `At least ${NAME_MIN} characters, please.`,
  long: `${NAME_MAX} characters max.`,
  chars: 'Only Arabic or Latin letters, digits, spaces and - _ . are allowed.',
};

export function validateName(raw: string): NameCheck {
  const name = normalizeName(raw);
  const len = nameLength(name);
  const fail = (problem: NameProblem): NameCheck => ({ ok: false, name, problem, error: NAME_ERRORS[problem] });
  if (len === 0) return fail('empty');
  if (len < NAME_MIN) return fail('short');
  if (len > NAME_MAX) return fail('long');
  if (!NAME_CHARS.test(name) || MARK_PILE.test(name) || !/[\p{L}0-9\u0660-\u0669\u06F0-\u06F9]/u.test(name)) return fail('chars');
  return { ok: true, name };
}

// ---- settings (pure) ------------------------------------------------------------------------

const QUALITIES: readonly (Quality | 'auto')[] = ['auto', 'low', 'medium', 'high', 'ultra'];
const clamp = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);

/** Coerces anything (e.g. stale or hand-edited JSON) into valid Settings. */
export function sanitizeSettings(v: unknown): Settings {
  const s = (v && typeof v === 'object' ? v : {}) as Partial<Record<keyof Settings, unknown>>;
  const d = DEFAULT_SETTINGS;
  return {
    quality: QUALITIES.includes(s.quality as Quality) ? (s.quality as Settings['quality']) : d.quality,
    musicVolume: clamp(s.musicVolume, 0, 1, d.musicVolume),
    sfxVolume: clamp(s.sfxVolume, 0, 1, d.sfxVolume),
    muted: bool(s.muted, d.muted),
    mouseSensitivity: clamp(s.mouseSensitivity, 0.2, 3, d.mouseSensitivity),
    invertY: bool(s.invertY, d.invertY),
    cameraShake: bool(s.cameraShake, d.cameraShake),
    keyboard: s.keyboard === 'qwerty' || s.keyboard === 'azerty' ? s.keyboard : d.keyboard,
  };
}

// ---- store ----------------------------------------------------------------------------------

export interface GameStore {
  /** false when the browser refused storage: data is kept for this session only. */
  readonly persistent: boolean;
  getName(): string;
  setName(name: string): void;
  getScores(): ScoreEntry[];
  /** Saves a run; returns the entry's rank (1-based, may exceed the kept 50) and the new list. */
  addScore(entry: ScoreEntry): { rank: number; list: ScoreEntry[] };
  /** Player's best score ever on this device (kept even after it drops out of the top 50), or null. */
  bestScore(name: string): number | null;
  getSettings(): Settings;
  setSettings(s: Settings): void;
  hintSeen(id: string): boolean;
  markHint(id: string): void;
}

/** `prefix` lets the dev page use its own keys; `backend` is injectable for tests. */
export function createStore(prefix = STORAGE_PREFIX, backend?: Storage): GameStore {
  const mem = new Map<string, string>(); // write-through copy: survives storage failing mid-session
  let ls: Storage | null = null;
  let persistent = true;
  try {
    ls = backend ?? globalThis.localStorage;
    const probe = `${prefix}probe`;
    ls.setItem(probe, '1');
    ls.removeItem(probe);
  } catch {
    persistent = false;
  }

  const read = (key: string): string | null => {
    const k = prefix + key;
    if (mem.has(k)) return mem.get(k)!;
    try {
      return ls ? ls.getItem(k) : null;
    } catch {
      persistent = false;
      return null;
    }
  };
  const write = (key: string, value: string): void => {
    const k = prefix + key;
    mem.set(k, value);
    try {
      if (!ls) throw new Error('no storage');
      ls.setItem(k, value);
    } catch {
      persistent = false;
    }
  };
  const readJson = (key: string): unknown => {
    try {
      return JSON.parse(read(key) ?? 'null');
    } catch {
      return null; // corrupted value: start fresh
    }
  };

  const getScores = (): ScoreEntry[] => {
    const v = readJson('scores');
    return Array.isArray(v) ? v.filter(isEntry).sort(compareScores).slice(0, LEADERBOARD_KEEP) : [];
  };
  /** Per-player best, keyed by nameKey(): the leaderboard only keeps 50 rows. */
  const bests = (): Map<string, number> => {
    const v = readJson('best');
    const m = new Map<string, number>();
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k, n] of Object.entries(v)) if (typeof n === 'number' && Number.isFinite(n)) m.set(k, n);
    }
    return m;
  };
  const hints = (): string[] => {
    const v = readJson('hints');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  };

  return {
    get persistent() { return persistent; },
    getName() {
      const v = read('name');
      const check = validateName(v ?? '');
      return check.ok ? check.name : '';
    },
    setName(name) { write('name', normalizeName(name)); },
    getScores,
    addScore(entry) {
      const r = insertScore(getScores(), entry);
      write('scores', JSON.stringify(r.list));
      const b = bests(), k = nameKey(entry.name);
      if (!(entry.score <= (b.get(k) ?? -Infinity))) write('best', JSON.stringify(Object.fromEntries(b.set(k, entry.score))));
      return r;
    },
    bestScore(name) {
      // max() with the list also covers scores saved before the 'best' key existed
      const s = Math.max(bests().get(nameKey(name)) ?? -Infinity, bestFor(getScores(), name)?.score ?? -Infinity);
      return s === -Infinity ? null : s;
    },
    getSettings: () => sanitizeSettings(readJson('settings')),
    setSettings(s) { write('settings', JSON.stringify(sanitizeSettings(s))); },
    hintSeen: (id) => hints().includes(id),
    markHint(id) { if (!hints().includes(id)) write('hints', JSON.stringify([...hints(), id])); },
  };
}
