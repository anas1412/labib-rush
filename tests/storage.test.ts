import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type ScoreEntry } from '../src/core/types';
import {
  LEADERBOARD_KEEP, STORAGE_PREFIX, bestFor, createStore, insertScore, nameLength, rankOf, sanitizeSettings,
  validateName,
} from '../src/ui/storage';

const entry = (score: number, date = '2026-09-25T10:00:00.000Z', name = 'Anas'): ScoreEntry =>
  ({ name, score, items: 3, bestCombo: 2, durationSec: 95, date });

/** Minimal in-memory Storage. */
class MemStorage implements Storage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  clear() { this.m.clear(); }
  getItem(k: string) { return this.m.get(k) ?? null; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  removeItem(k: string) { this.m.delete(k); }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
}

/** Storage that throws on every access, like Safari private mode or a sandboxed iframe. */
class ThrowingStorage extends MemStorage {
  getItem(): string | null { throw new DOMException('denied', 'SecurityError'); }
  setItem(): void { throw new DOMException('quota', 'QuotaExceededError'); }
}

describe('leaderboard', () => {
  it('sorts by score desc, ties → earlier date first', () => {
    let list: ScoreEntry[] = [];
    const late = entry(500, '2026-09-25T12:00:00.000Z', 'Late');
    const early = entry(500, '2026-09-24T12:00:00.000Z', 'Early');
    for (const e of [entry(100), late, entry(900), early]) list = insertScore(list, e).list;
    expect(list.map((e) => e.score)).toEqual([900, 500, 500, 100]);
    expect(list[1]).toBe(early);
    expect(list[2]).toBe(late);
  });

  it('keeps the top 50 and still reports the rank of an entry that did not make it', () => {
    let list: ScoreEntry[] = [];
    for (let i = 0; i < 60; i++) list = insertScore(list, entry(1000 + i * 10, `2026-09-${String(1 + (i % 28)).padStart(2, '0')}T00:00:00.000Z`)).list;
    expect(list).toHaveLength(LEADERBOARD_KEEP);
    expect(list[0].score).toBe(1590);
    const low = insertScore(list, entry(5));
    expect(low.rank).toBe(LEADERBOARD_KEEP + 1);
    expect(low.list).toHaveLength(LEADERBOARD_KEEP);
    const mid = insertScore(list, entry(1555));
    expect(mid.rank).toBe(5); // 1590, 1580, 1570, 1560, [1555]
    expect(mid.list[4].score).toBe(1555);
  });

  it('a new entry tied with an older one ranks after it', () => {
    const old = entry(300, '2026-01-01T00:00:00.000Z');
    const r = insertScore([old], entry(300, '2026-09-01T00:00:00.000Z'));
    expect(r.rank).toBe(2);
  });

  it('looks up ranks outside the top 10 and for absent entries', () => {
    let list: ScoreEntry[] = [];
    for (let i = 0; i < 20; i++) list = insertScore(list, entry(2000 - i * 50)).list;
    expect(rankOf(list, list[13])).toBe(14);
    expect(rankOf(list, entry(1375))).toBe(14); // between 1400 (#13) and 1350 (#14)
    expect(rankOf(list, entry(1))).toBe(21);
    expect(rankOf([], entry(1))).toBe(1);
  });

  it("finds a player's personal best case-insensitively", () => {
    const list = [entry(900, undefined, 'Salma'), entry(700, undefined, 'anas'), entry(400, undefined, 'Anas')];
    expect(bestFor(list, 'ANAS')?.score).toBe(700);
    expect(bestFor(list, 'Nobody')).toBeNull();
  });
});

describe('name validation', () => {
  it('trims and collapses spaces', () => {
    expect(validateName('   Mehdi    Ben   Ali  ')).toEqual({ ok: true, name: 'Mehdi Ben Ali' });
  });

  it('accepts Arabic, accented Latin, digits and - _ .', () => {
    for (const n of ['لبيب', 'ياسمين', 'أمين_07', 'Salma.B', 'Zoé-Chérif', 'Ümit', 'Rami ٢٠٢٦', 'مُحَمَّد', 'علـــي']) {
      expect(validateName(n), n).toMatchObject({ ok: true, name: n });
    }
  });

  it('counts user-perceived characters, not UTF-16 units', () => {
    expect(nameLength('مُحَمَّد')).toBe(4); // letters with harakat
    expect(nameLength('Zoé')).toBe(3);
    expect(nameLength('e\u0301')).toBe(1); // decomposed accent
    expect(validateName('𝒜𝒜')).toMatchObject({ ok: false }); // math script: not Latin letters
    // 16 Arabic letters with a fatha each = 32 UTF-16 units, still valid
    expect(validateName('بَ'.repeat(16))).toMatchObject({ ok: true });
    expect(validateName('بَ'.repeat(17))).toMatchObject({ ok: false });
  });

  it('enforces 2–16 characters after trimming', () => {
    expect(validateName('')).toMatchObject({ ok: false, problem: 'empty' });
    expect(validateName('   ')).toMatchObject({ ok: false, problem: 'empty' });
    expect(validateName(' A ')).toMatchObject({ ok: false, problem: 'short' });
    expect(validateName('Anas!')).toMatchObject({ ok: false, problem: 'chars' });
    expect(validateName('Ab')).toMatchObject({ ok: true });
    expect(validateName('a'.repeat(16))).toMatchObject({ ok: true });
    expect(validateName('a'.repeat(17))).toMatchObject({ ok: false, problem: 'long' });
  });

  it('rejects other scripts, symbols, emoji, markup and mark piles', () => {
    for (const n of ['<b>hi</b>', 'Anas!', 'Ab😀', 'Привет', '日本語', 'a@b', '...', '- _', 'Z\u0300\u0301\u0302oe', 'tab\u200bname']) {
      expect(validateName(n), n).toMatchObject({ ok: false });
    }
  });
});

describe('settings', () => {
  it('fills defaults and clamps bad values', () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings({ quality: 'epic', musicVolume: 7, sfxVolume: -1, mouseSensitivity: 0, invertY: 'yes', cameraShake: false }))
      .toEqual({ ...DEFAULT_SETTINGS, musicVolume: 1, sfxVolume: 0, mouseSensitivity: 0.2, cameraShake: false });
  });
});

describe('store', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('persists name, scores, settings and hints under versioned keys', () => {
    const ls = new MemStorage();
    const s = createStore(STORAGE_PREFIX, ls);
    expect(s.persistent).toBe(true);
    expect(s.getName()).toBe('');
    s.setName('  Labib  Fan ');
    s.addScore(entry(120));
    s.setSettings({ ...DEFAULT_SETTINGS, invertY: true });
    s.markHint('move');
    expect(Object.keys(Object.fromEntries([...Array(ls.length)].map((_, i) => [ls.key(i), 1]))).sort())
      .toEqual(['labibRush.v1.best', 'labibRush.v1.hints', 'labibRush.v1.name', 'labibRush.v1.scores', 'labibRush.v1.settings']);

    const again = createStore(STORAGE_PREFIX, ls);
    expect(again.getName()).toBe('Labib Fan');
    expect(again.getScores().map((e) => e.score)).toEqual([120]);
    expect(again.getSettings().invertY).toBe(true);
    expect(again.hintSeen('move')).toBe(true);
    expect(again.hintSeen('kick')).toBe(false);
  });

  it("remembers a player's best after it drops out of the kept top 50", () => {
    const s = createStore(STORAGE_PREFIX, new MemStorage());
    expect(s.bestScore('Anas')).toBeNull();
    s.addScore(entry(300, undefined, 'anas'));
    s.addScore(entry(200, undefined, 'Anas'));
    for (let i = 0; i < LEADERBOARD_KEEP; i++) s.addScore(entry(1000 + i, undefined, 'Salma'));
    expect(bestFor(s.getScores(), 'Anas')).toBeNull(); // pushed out of the list
    expect(s.bestScore('ANAS ')).toBe(300);
    s.addScore(entry(250, undefined, 'Anas'));
    expect(s.bestScore('Anas')).toBe(300);
    expect(s.bestScore('Salma')).toBe(1000 + LEADERBOARD_KEEP - 1);
    expect(s.bestScore('__proto__')).toBeNull();
    s.addScore(entry(40, undefined, '__proto__'));
    expect(s.bestScore('__proto__')).toBe(40);
  });

  it('ignores corrupted or tampered data', () => {
    const ls = new MemStorage();
    ls.setItem('labibRush.v1.scores', '{not json');
    ls.setItem('labibRush.v1.name', '<img src=x>');
    ls.setItem('labibRush.v1.settings', '"nope"');
    ls.setItem('labibRush.v1.best', '{"anas":"lots","x":null}');
    const s = createStore(STORAGE_PREFIX, ls);
    expect(s.getScores()).toEqual([]);
    expect(s.getName()).toBe('');
    expect(s.getSettings()).toEqual(DEFAULT_SETTINGS);
    expect(s.bestScore('Anas')).toBeNull();
    ls.setItem('labibRush.v1.scores', JSON.stringify([entry(5), { name: 'x', score: 'lots' }, null]));
    expect(createStore(STORAGE_PREFIX, ls).getScores()).toHaveLength(1);
  });

  it('separate prefixes never touch each other (dev page vs game)', () => {
    const ls = new MemStorage();
    createStore('labibRush.dev.', ls).addScore(entry(999));
    expect(createStore(STORAGE_PREFIX, ls).getScores()).toEqual([]);
  });

  it('falls back to memory when localStorage throws', () => {
    vi.stubGlobal('localStorage', new ThrowingStorage());
    const s = createStore();
    expect(s.persistent).toBe(false);
    s.setName('Yasmine');
    const r = s.addScore(entry(300, undefined, 'Yasmine'));
    s.addScore(entry(100, undefined, 'Yasmine'));
    s.setSettings({ ...DEFAULT_SETTINGS, muted: true });
    s.markHint('radar');
    expect(r.rank).toBe(1);
    expect(s.getName()).toBe('Yasmine');
    expect(s.getScores().map((e) => e.score)).toEqual([300, 100]);
    expect(s.getSettings().muted).toBe(true);
    expect(s.hintSeen('radar')).toBe(true);
  });

  it('falls back when localStorage itself is inaccessible', () => {
    vi.stubGlobal('localStorage', undefined);
    Object.defineProperty(globalThis, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); }, configurable: true });
    const s = createStore();
    expect(s.persistent).toBe(false);
    s.setName('Ab');
    expect(s.getName()).toBe('Ab');
  });

  it('turns non-persistent when a write fails mid-session but keeps the data', () => {
    const ls = new MemStorage();
    const s = createStore(STORAGE_PREFIX, ls);
    ls.setItem = () => { throw new DOMException('quota', 'QuotaExceededError'); };
    s.addScore(entry(50));
    expect(s.persistent).toBe(false);
    expect(s.getScores()).toHaveLength(1);
  });
});
