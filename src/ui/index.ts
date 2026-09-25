// All DOM screens (loading, name, menus, pause, game over) + the HUD, over the 3D canvas.
// Layers: HUD 30 · menus 50 · rotate-your-phone 90 · loading 100 (see docs/ARCHITECTURE.md).
// Flow ownership: the UI shows/hides its own screens in response to its buttons and then tells
// main.ts through `handlers`; main.ts drives the game and calls enterGame/showPause/showGameOver.
import './ui.css';
import type { Vector3 } from 'three';
import { loadFonts } from '../core/fonts';
import { CHECHIA_SCORE, MAGNET_RADIUS, MASHMOUM_TIME, POWERUPS, RULES, TEA_SPEED } from '../core/config';
import type { HudState, PowerUpKind, RunResult, ScoreEntry, Settings, UIController, UIHandlers } from '../core/types';
import { LEADERBOARD_SHOW, NAME_MAX, bestFor, createStore, nameLength, normalizeName, rankOf, validateName, STORAGE_PREFIX } from './storage';
import { CREDITS, CREDIT_GROUPS, DISCLAIMER, PROCEDURAL_NOTE } from './credits';
import { ICON, LITTER_ICON, LOGO, POWERUP_ICON, SVG_DEFS, ZELLIGE } from './icons';
import { createHud } from './hud';
import { append, button, el, fmtClock, fmtInt, icon, prefersReducedMotion, timed, uiSound } from './dom';

export { createProjector } from './hud';

export interface UIOptions {
  /** Storage key prefix. The dev page uses its own so it never touches the real game data. */
  storagePrefix?: string;
}

type HintId = 'move' | 'pickup' | 'deposit' | 'kick' | 'radar' | 'litterbug';
type ScreenId = 'name' | 'menu' | 'leaderboard' | 'rename' | 'settings' | 'howto' | 'credits' | 'pause' | 'gameover';

interface Screen {
  id: ScreenId;
  el: HTMLElement;
  /** Rebuild dynamic content right before showing. */
  enter?(): void;
  /** Esc / back button. */
  back?(): void;
  /** Element focused on show (defaults to the first focusable). */
  primary?(): HTMLElement | null;
  /** Screen-specific keys; return true when handled. */
  keys?(e: KeyboardEvent): boolean;
}

const TIPS = [
  `Chain pickups within ${RULES.comboWindow} seconds: ×5 combo means barcha points!`,
  'Taxis honk before they arrive. Rod belek, watch out!',
  `A full bag of ${RULES.bagMax} pays a ${RULES.bagMax ** 2 * RULES.depositBonusPerItemSquared} bonus, but a taxi hit spills half of it.`,
  'Kick a can into a bin for a GOOOAL: double points!',
  `Catch a litterbug red-handed within ${RULES.caughtWindow} s: +${RULES.caughtPoints}. Yaatik saha!`,
  "Labib's big ears hear pollution. Use the ear radar to see litter through walls.",
  'Mint tea for speed, bambalouni for a magnet, mashmoum for time, chéchia for ×2.',
  'Every item you bin adds time. Keep moving, ya batal!',
  `Flying plastic bags are worth ${RULES.points.bag}: jump to catch them in the wind.`,
];

const POWERUP_TEXT: Record<PowerUpKind, string> = {
  tea: `+${Math.round((TEA_SPEED - 1) * 100)}% speed for ${POWERUPS.tea.duration} s`,
  bambalouni: `Pulls litter within ${MAGNET_RADIUS} m to you for ${POWERUPS.bambalouni.duration} s`,
  mashmoum: `Jasmine bouquet: +${MASHMOUM_TIME} s on the clock`,
  chechia: `Score ×${CHECHIA_SCORE} for ${POWERUPS.chechia.duration} s`,
};

export function createUI(root: HTMLElement, handlers: UIHandlers, opts: UIOptions = {}): UIController {
  void loadFonts();
  const store = createStore(opts.storagePrefix ?? STORAGE_PREFIX);
  let settings = store.getSettings();
  let name = store.getName();

  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  let touch = coarse;
  const isTouch = () => touch;

  const ui = el('div', 'ui-root');
  ui.style.setProperty('--zellige', ZELLIGE);
  ui.insertAdjacentHTML('afterbegin', SVG_DEFS);
  root.append(ui);
  const setTouch = (on: boolean) => { touch = on; ui.classList.toggle('ui-touch', on); };
  setTouch(coarse);
  // Same rule as core/input.ts, so the HUD and the touch controls always agree: the last pointer
  // type picks the mode, and WASD / arrows during play switch a touchscreen laptop back to desktop.
  const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

  // ---- first user gesture (audio unlock) ------------------------------------------------------
  const gestureEvents = ['click', 'touchend', 'keydown'] as const;
  const onGesture = (e: Event) => {
    if (e instanceof KeyboardEvent && (e.key === 'Escape' || e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta')) return;
    gestureEvents.forEach((t) => removeEventListener(t, onGesture, true));
    handlers.onUserGesture();
  };
  gestureEvents.forEach((t) => addEventListener(t, onGesture, true));
  addEventListener('pointerdown', (e) => setTouch(e.pointerType !== 'mouse'), true);

  // ---- layers ---------------------------------------------------------------------------------
  const hud = createHud(() => handlers.onPause(), isTouch);
  const menus = el('div', 'ui-menus');
  const loading = el('div', 'ui-loading');
  const rotate = el('div', 'ui-rotate');
  append(rotate, icon(ICON.phone, 'ui-rotate-ico'), el('strong', '', 'Rotate your phone'), el('span', '', 'Labib needs the whole avenue: play in landscape.'));
  const notice = el('div', 'ui-notice', "Private browsing: scores won't be saved in this browser mode.");
  menus.append(notice);
  append(ui, hud.el, menus, rotate, loading);

  let inGame = false;
  let current: Screen | null = null;
  let playPending = false;
  const screens = new Map<ScreenId, Screen>();

  const focusables = (scope: HTMLElement) =>
    [...scope.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), a[href]')].filter((e) => e.offsetParent !== null);

  function show(id: ScreenId | null): void {
    current?.el.classList.remove('ui-on');
    current = id ? screens.get(id)! : null;
    menus.classList.toggle('ui-on', !!current);
    menus.dataset.screen = id ?? '';
    menus.classList.toggle('ui-over-game', inGame || id === 'gameover');
    notice.classList.toggle('ui-on', !store.persistent);
    playPending = false;
    if (inGame) { // a menu over the run freezes the timed hint and controls card; closing it resumes them
      hud.setPaused(!!current);
      if (current) controlsT.pause(); else controlsT.resume();
    }
    if (!current) return;
    current.enter?.();
    current.el.classList.add('ui-on');
    current.el.scrollTop = 0;
    const target = current.primary?.() ?? focusables(current.el)[0];
    if (target && (!touch || target.tagName === 'INPUT')) target.focus({ preventScroll: true });
  }

  function screen(id: ScreenId, cls: string, def: Omit<Screen, 'id' | 'el'> = {}): Screen & { el: HTMLElement } {
    const s: Screen = { id, el: el('section', `ui-screen ${cls}`), ...def };
    s.el.setAttribute('role', 'dialog');
    s.el.setAttribute('aria-modal', 'true');
    menus.append(s.el);
    screens.set(id, s);
    return s;
  }

  const panel = (cls = '') => el('div', `ui-panel ${cls}`.trim());
  const title = (text: string, sub?: string) => {
    const t = append(el('header', 'ui-title'), el('h2', '', text));
    if (sub) t.append(el('p', 'ui-sub', sub));
    return t;
  };
  const backBtn = (onBack: () => void, label = 'Back') => button(label, onBack, { cls: 'ui-btn-ghost ui-back', svg: ICON.back, sound: 'back' });
  const nameSpan = (n: string, cls = 'ui-name') => {
    const s = el('span', cls, n); // textContent only: names are user data
    s.dir = 'auto';
    return s;
  };
  const wordmark = (cls = '') => {
    const w = el('div', `ui-lockup ${cls}`.trim());
    w.innerHTML = LOGO;
    const text = append(el('div', 'ui-wordmark'), append(el('h1', ''), el('span', 'ui-wm-a', 'Labib'), el('span', 'ui-wm-b', 'Rush')));
    const tag = el('span', 'ui-wm-tag', 'لبيب');
    tag.lang = 'ar';
    tag.dir = 'rtl';
    text.append(tag);
    w.append(text);
    return w;
  };

  // ---- keyboard navigation ------------------------------------------------------------------
  addEventListener('keydown', (e) => {
    if (touch && inGame && !current && MOVE_KEYS.has(e.code)) setTouch(false);
    if (!current || loading.classList.contains('ui-on')) return;
    if (current.keys?.(e)) { e.preventDefault(); return; }
    const t = document.activeElement as HTMLElement | null;
    const inScreen = !!t && current.el.contains(t);
    const kind = t instanceof HTMLInputElement ? t.type : '';
    const move = (dir: number) => {
      const list = focusables(current!.el);
      if (!list.length) return;
      const i = inScreen ? list.indexOf(t!) : -1;
      const next = i < 0 ? list[dir > 0 ? 0 : list.length - 1] : list[(i + dir + list.length) % list.length];
      next.focus();
      next.scrollIntoView({ block: 'nearest' });
      uiSound('hover');
    };
    switch (e.key) {
      case 'ArrowDown': case 'ArrowUp':
        e.preventDefault();
        move(e.key === 'ArrowDown' ? 1 : -1);
        break;
      case 'ArrowLeft': case 'ArrowRight':
        if (kind === 'range' || kind === 'text') return;
        e.preventDefault();
        move(e.key === 'ArrowRight' ? 1 : -1);
        break;
      case 'Tab': // keep focus inside the open screen (it is a modal dialog)
        e.preventDefault();
        move(e.shiftKey ? -1 : 1);
        break;
      case 'Escape':
        if (e.repeat || !current.back) return;
        e.preventDefault();
        // Resuming re-enables game input synchronously; don't let input.ts see this Esc as "pause".
        e.stopImmediatePropagation();
        uiSound('back');
        current.back();
        break;
      case 'Enter':
        if (!inScreen && !e.repeat) {
          const p = current.primary?.();
          if (p) { e.preventDefault(); if (p instanceof HTMLInputElement) p.focus(); else p.click(); }
        }
        break;
    }
  });

  // ---- loading --------------------------------------------------------------------------------
  const progFill = el('div', 'ui-progress-fill');
  const progLabel = el('div', 'ui-load-label', 'Loading…');
  const progPct = el('span', 'ui-load-pct', '0%');
  const tip = el('p', 'ui-tip-text');
  const progress = append(el('div', 'ui-progress'), progFill);
  progress.setAttribute('role', 'progressbar');
  progress.setAttribute('aria-valuemin', '0');
  progress.setAttribute('aria-valuemax', '100');
  append(loading,
    append(el('div', 'ui-load-center'), wordmark('ui-lockup-xl'), el('p', 'ui-load-sub', 'Clean up Avenue Habib Bourguiba before the clock runs out'),
      append(el('div', 'ui-load-bar'), progress, append(el('div', 'ui-load-row'), progLabel, progPct))),
    append(el('div', 'ui-tip'), el('span', 'ui-tip-cap', 'Nasiha'), tip));
  loading.classList.add('ui-on');
  let tipIndex = Math.floor(Math.random() * TIPS.length);
  const nextTip = () => {
    tip.textContent = TIPS[tipIndex++ % TIPS.length];
    if (!prefersReducedMotion()) tip.animate([{ opacity: 0, transform: 'translateY(.4em)' }, { opacity: 1, transform: 'none' }], { duration: 450, easing: 'ease-out' });
  };
  nextTip();
  const tipTimer = window.setInterval(nextTip, 4200);

  // ---- name form (first visit + change name) --------------------------------------------------
  function nameForm(submitLabel: string, onSave: (n: string) => void) {
    const form = el('form', 'ui-nameform');
    form.noValidate = true;
    const input = el('input', 'ui-input');
    Object.assign(input, { type: 'text', autocomplete: 'nickname', spellcheck: false, maxLength: 64, placeholder: 'Your name', dir: 'auto' });
    input.setAttribute('autocapitalize', 'words');
    input.setAttribute('enterkeyhint', 'done');
    input.setAttribute('aria-label', 'Your name');
    const count = el('span', 'ui-count', `0/${NAME_MAX}`);
    const error = el('p', 'ui-error');
    error.setAttribute('aria-live', 'polite');
    const submit = button(submitLabel, () => form.requestSubmit(), { cls: 'ui-btn-primary', svg: ICON.play });
    let tried = false;
    const check = () => {
      const r = validateName(input.value);
      const len = nameLength(normalizeName(input.value));
      count.textContent = `${len}/${NAME_MAX}`;
      count.classList.toggle('ui-bad', len > NAME_MAX);
      // "Too short" waits for a submit attempt; too long / bad characters show right away.
      const say = !r.ok && (tried || r.problem === 'long' || r.problem === 'chars');
      error.textContent = say ? r.error : '';
      input.setAttribute('aria-invalid', String(say));
      return r;
    };
    input.addEventListener('input', check);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      tried = true;
      const r = check();
      if (!r.ok) {
        uiSound('back');
        if (!prefersReducedMotion()) input.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-.4em)' }, { transform: 'translateX(.4em)' }, { transform: 'translateX(0)' }], { duration: 240 });
        input.focus();
        return;
      }
      onSave(r.name);
    });
    append(form, append(el('div', 'ui-field'), input, count), error, submit);
    return {
      form, input, submit,
      reset(value: string) { input.value = value; tried = false; check(); error.textContent = ''; },
    };
  }

  function saveName(n: string): void {
    name = n;
    store.setName(n);
  }

  const nameScreen = screen('name', 'ui-center', { primary: () => nameF.input });
  const nameF = nameForm('Yalla!', (n) => { saveName(n); show('menu'); });
  append(nameScreen.el, append(panel('ui-name-panel'), wordmark('ui-lockup-sm'),
    title('Marhba! What’s your name?', 'It goes on the leaderboard of this device.'), nameF.form));

  const renameScreen = screen('rename', 'ui-center', {
    enter: () => renameF.reset(name),
    primary: () => renameF.input,
    back: () => show('menu'),
  });
  const renameF = nameForm('Save', (n) => { saveName(n); show('menu'); });
  append(renameScreen.el, append(panel('ui-name-panel'), title('Change name', 'New scores use the new name. Old scores keep theirs.'), renameF.form,
    backBtn(() => show('menu'), 'Cancel')));

  // ---- leaderboard rendering ------------------------------------------------------------------
  const dateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
  function row(e: ScoreEntry, rank: number, highlight: boolean, compact: boolean): HTMLLIElement {
    const li = el('li', `ui-row${rank <= 3 ? ` ui-row-${rank}` : ''}${highlight ? ' ui-row-me' : ''}`);
    const r = el('span', 'ui-rank');
    if (rank === 1) r.append(icon(ICON.crown, 'ui-crown'));
    else r.textContent = String(rank);
    const who = append(el('span', 'ui-who'), nameSpan(e.name, 'ui-rname'));
    if (compact) return append(li, r, who, el('span', 'ui-rscore', fmtInt(e.score)));
    // Narrow panels hide the stat columns and show them in the meta line instead (CSS container query).
    who.append(append(el('span', 'ui-rmeta', dateFmt.format(new Date(e.date))),
      el('span', 'ui-rmeta-x', ` · ${fmtInt(e.items)} items · ×${e.bestCombo}`)));
    return append(li, r, who, el('span', 'ui-rc', fmtInt(e.items)), el('span', 'ui-rc', `×${e.bestCombo}`),
      el('span', 'ui-rc ui-rc-time', fmtClock(e.durationSec)), el('span', 'ui-rscore', fmtInt(e.score)));
  }
  /** Top-10 list (`highlight` marks the player's row if it is in there). */
  function board(list: ScoreEntry[], compact: boolean, highlight?: ScoreEntry): HTMLElement {
    const ol = el('ol', `ui-board${compact ? ' ui-board-compact' : ' ui-board-full'}`);
    if (!list.length && !highlight) {
      ol.append(el('li', 'ui-empty', 'No scores yet. Be the first on the Avenue!'));
      return ol;
    }
    if (!compact) {
      ol.append(append(el('li', 'ui-row ui-row-head'), el('span', 'ui-rank', '#'), el('span', '', 'Player'), el('span', 'ui-rc', 'Items'),
        el('span', 'ui-rc', 'Combo'), el('span', 'ui-rc ui-rc-time', 'Time'), el('span', 'ui-rscore', 'Score')));
    }
    list.slice(0, LEADERBOARD_SHOW).forEach((e, i) => ol.append(row(e, i + 1, e === highlight, compact)));
    return ol;
  }
  /** The player's row when it ranks below the top 10: a separate list under the board, so it stays
   *  in view while the top 10 scroll on short screens. Empty when not needed. */
  function outsideRow(e: ScoreEntry | null | undefined, rank: number, compact: boolean): HTMLElement[] {
    if (!e || rank <= LEADERBOARD_SHOW) return [];
    const ol = el('ol', `ui-board ui-board-me${compact ? ' ui-board-compact' : ' ui-board-full'}`);
    ol.start = rank;
    return [append(ol, el('li', 'ui-gap', '• • •'), row(e, rank, true, compact))];
  }

  // ---- main menu ------------------------------------------------------------------------------
  const greetName = el('span', 'ui-greet-name');
  const pbEl = el('div', 'ui-pb');
  const menuBoard = el('div', 'ui-board-wrap');
  const playBtn = button('Play', () => requestPlay(), { cls: 'ui-btn-primary ui-btn-play', svg: ICON.play, hint: 'Enter' });
  const menu = screen('menu', 'ui-menu', {
    enter() {
      greetName.replaceChildren('Ahla bik, ', nameSpan(name), '!');
      const scores = store.getScores();
      const best = store.bestScore(name);
      pbEl.replaceChildren(icon(ICON.star), el('span', 'ui-pb-cap', 'Personal best'), el('strong', '', best !== null ? fmtInt(best) : '—'));
      menuBoard.replaceChildren(board(scores, true));
    },
    primary: () => playBtn,
  });
  append(menu.el,
    append(el('div', 'ui-menu-main'),
      wordmark(),
      append(el('div', 'ui-greet'), greetName, pbEl),
      playBtn,
      append(el('div', 'ui-menu-grid'),
        button('Leaderboard', () => show('leaderboard'), { svg: ICON.trophy }),
        button('How to play', () => show('howto'), { svg: ICON.book }),
        button('Settings', () => openSettings('menu'), { svg: ICON.gear }),
        button('Change name', () => show('rename'), { svg: ICON.pencil })),
      button('Credits', () => show('credits'), { cls: 'ui-btn-link', svg: ICON.heart })),
    append(panel('ui-menu-board'), append(el('header', 'ui-board-head'), icon(ICON.trophy), el('h3', '', 'Top 10'), el('span', 'ui-board-sub', 'on this device')), menuBoard));

  /** Play / Play again. Ignores repeats until main.ts reacts (enterGame) — guards double taps. */
  function requestPlay(): void {
    if (playPending) return;
    playPending = true;
    setTimeout(() => { playPending = false; }, 2000);
    handlers.onPlay();
  }

  // ---- leaderboard screen ---------------------------------------------------------------------
  const lbBody = el('div', 'ui-board-wrap');
  const lbYou = el('p', 'ui-lb-you');
  const lb = screen('leaderboard', 'ui-center', {
    enter() {
      const scores = store.getScores();
      const best = bestFor(scores, name);
      const rank = best ? rankOf(scores, best) : 0;
      const ever = store.bestScore(name); // may be older than the kept top 50
      lbBody.replaceChildren(board(scores, false, best ?? undefined), ...outsideRow(best, rank, false));
      lbYou.replaceChildren(...(best ? ['Your best: ', el('strong', '', `#${rank}`), ` with ${fmtInt(best.score)} points`]
        : ever !== null ? ['Your best: ', el('strong', '', fmtInt(ever)), ' points, outside the top 50'] : ['Play a run to get on the board.']));
    },
    back: () => show('menu'),
  });
  append(lb.el, append(panel('ui-wide ui-lb-panel'), title('Leaderboard', 'Top 10 on this device'), lbBody, lbYou, backBtn(() => show('menu'))));

  // ---- settings -------------------------------------------------------------------------------
  let settingsFrom: 'menu' | 'pause' = 'menu';
  function openSettings(from: 'menu' | 'pause'): void { settingsFrom = from; show('settings'); }
  function setSetting<K extends keyof Settings>(k: K, v: Settings[K]): void {
    settings = { ...settings, [k]: v };
    store.setSettings(settings);
    handlers.onSettingsChange({ ...settings });
    notice.classList.toggle('ui-on', !store.persistent);
  }
  const refreshers: (() => void)[] = [];
  const settingRow = (label: string, control: HTMLElement, id?: string) => {
    const l = el('label', 'ui-set-label', label);
    if (id) l.htmlFor = id;
    return append(el('div', 'ui-set-row'), l, control);
  };
  function segmented<K extends keyof Settings>(k: K, options: [Settings[K], string][]): HTMLElement {
    const g = el('div', 'ui-seg');
    g.setAttribute('role', 'group');
    const btns = options.map(([v, label]) => {
      const b = button(label, () => { setSetting(k, v); sync(); });
      b.dataset.v = String(v);
      return b;
    });
    const sync = () => btns.forEach((b, i) => b.setAttribute('aria-pressed', String(settings[k] === options[i][0])));
    refreshers.push(sync);
    g.append(...btns);
    return g;
  }
  function slider(k: 'musicVolume' | 'sfxVolume' | 'mouseSensitivity', min: number, max: number, step: number, fmt: (v: number) => string): HTMLElement {
    const input = el('input', 'ui-range');
    Object.assign(input, { type: 'range', min: String(min), max: String(max), step: String(step), id: `ui-set-${k}` });
    const out = el('output', 'ui-range-val');
    const paint = () => {
      const v = Number(input.value);
      input.style.setProperty('--v', String((v - min) / (max - min)));
      out.textContent = fmt(v);
    };
    input.addEventListener('input', () => { paint(); setSetting(k, Number(input.value)); });
    input.addEventListener('change', () => uiSound('click'));
    refreshers.push(() => { input.value = String(settings[k]); paint(); });
    return append(el('div', 'ui-slider'), input, out);
  }
  function toggle(k: 'muted' | 'invertY' | 'cameraShake', onLabel = 'On', offLabel = 'Off'): HTMLElement {
    const b = button('', () => { setSetting(k, !settings[k]); sync(); }, { cls: 'ui-switch' });
    b.setAttribute('role', 'switch');
    b.id = `ui-set-${k}`;
    const label = b.querySelector('.ui-btn-label')!;
    const sync = () => { b.setAttribute('aria-checked', String(settings[k])); label.textContent = settings[k] ? onLabel : offLabel; };
    refreshers.push(sync);
    return b;
  }
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const settingsScreen = screen('settings', 'ui-center', {
    enter: () => { settings = store.getSettings(); refreshers.forEach((f) => f()); },
    back: () => (settingsFrom === 'pause' ? show('pause') : show('menu')),
  });
  append(settingsScreen.el, append(panel('ui-wide ui-settings'), title('Settings'),
    append(el('div', 'ui-set-grid'),
      append(el('section', 'ui-set-group'), el('h3', '', 'Graphics'),
        settingRow('Quality', segmented('quality', [['auto', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra']]))),
      append(el('section', 'ui-set-group'), el('h3', '', 'Audio'),
        settingRow('Music', slider('musicVolume', 0, 1, 0.05, pct), 'ui-set-musicVolume'),
        settingRow('Sound effects', slider('sfxVolume', 0, 1, 0.05, pct), 'ui-set-sfxVolume'),
        settingRow('Mute all', toggle('muted'), 'ui-set-muted')),
      append(el('section', 'ui-set-group'), el('h3', '', 'Controls'),
        settingRow('Look sensitivity', slider('mouseSensitivity', 0.2, 3, 0.05, (v) => `×${v.toFixed(2)}`), 'ui-set-mouseSensitivity'),
        settingRow('Invert Y', toggle('invertY'), 'ui-set-invertY'),
        settingRow('Camera shake', toggle('cameraShake'), 'ui-set-cameraShake'))),
    backBtn(() => settingsScreen.back!())));

  // ---- how to play ----------------------------------------------------------------------------
  const keycaps = (...keys: string[]) => append(el('span', 'ui-keys'), ...keys.map((k) => el('kbd', '', k)));
  const ctrl = (keys: HTMLElement, what: string) => append(el('li', 'ui-ctrl'), keys, el('span', '', what));
  const iconCap = (svg: string) => append(el('span', 'ui-keys'), icon(svg, 'ui-ico ui-ico-cap'));
  const desktopControls = append(el('div', 'ui-ctrl-set'), append(el('ul', ''),
    ctrl(keycaps('W', 'A', 'S', 'D'), 'Move (or arrow keys)'),
    ctrl(iconCap(ICON.mouse), 'Look: click the game to capture the mouse'),
    ctrl(keycaps('Shift'), 'Sprint'),
    ctrl(keycaps('Space'), 'Jump'),
    ctrl(keycaps('F'), 'Kick (or left click)'),
    ctrl(keycaps('Q'), 'Ear radar'),
    ctrl(keycaps('Esc'), 'Pause')));
  const touchControls = append(el('div', 'ui-ctrl-set'), append(el('ul', ''),
    ctrl(iconCap(ICON.joystick), 'Left thumb: move. Push past the rim to sprint'),
    ctrl(iconCap(ICON.swipe), 'Drag on the right side: look around'),
    ctrl(keycaps('Jump', 'Kick'), 'Buttons at the bottom right'),
    ctrl(keycaps('Sprint', 'Radar'), 'Hold sprint, tap radar'),
    ctrl(iconCap(ICON.pause), 'Pause (top right)')));
  const ctrlWrap = el('div', 'ui-ctrl-wrap');
  const ctrlSets = [desktopControls, touchControls];
  const ctrlTabs = ['Keyboard & mouse', 'Touch'].map((label, i) => button(label, () => setCtrlTab(i)));
  const setCtrlTab = (i: number) => {
    ctrlWrap.replaceChildren(ctrlSets[i]);
    ctrlTabs.forEach((b, j) => b.setAttribute('aria-pressed', String(i === j)));
  };
  const P = RULES.points;
  const litter = (k: keyof typeof P, label: string) => append(el('li', 'ui-litter'), icon(LITTER_ICON[k], 'ui-litter-ico'), el('span', '', label), el('strong', '', `${P[k]}`));
  const howto = screen('howto', 'ui-center', {
    enter: () => setCtrlTab(touch ? 1 : 0),
    back: () => show('menu'),
  });
  append(howto.el, append(panel('ui-wide ui-howto'), title('How to play', 'Clean up the Avenue before the clock hits zero.'),
    append(el('div', 'ui-howto-grid'),
      append(el('section', ''), el('h3', '', 'Controls'), append(el('div', 'ui-seg ui-tabs'), ...ctrlTabs), ctrlWrap),
      append(el('section', ''), el('h3', '', 'Litter & rules'),
        append(el('ul', 'ui-litter-list'), litter('can', 'Can'), litter('bottle', 'Bottle'), litter('chips', 'Chips bag'), litter('bag', 'Flying bag: jump!'), litter('golden', 'Golden bottle')),
        append(el('ul', 'ui-rules'),
          el('li', '', `Pick up litter within ${RULES.comboWindow} s of the last one to build a combo: ×2, ×3, then ×5.`),
          el('li', '', `Your bag holds ${RULES.bagMax}. Bins pay items² × ${RULES.depositBonusPerItemSquared} and +${RULES.timePerDepositedItem} s per item.`),
          el('li', '', 'Kick cans and bottles into a bin: GOOOAL! Double points.'),
          el('li', '', `Touch a litterbug within ${RULES.caughtWindow} s of the throw: Caught! +${RULES.caughtPoints}.`),
          el('li', '', 'Taxis knock you down, spill half your bag and break the combo.'))),
      append(el('section', ''), el('h3', '', 'Power-ups'),
        append(el('ul', 'ui-power-list'), ...(['tea', 'bambalouni', 'mashmoum', 'chechia'] as const).map((k) =>
          append(el('li', 'ui-power'), icon(POWERUP_ICON[k], 'ui-power-ico'), append(el('div', ''), el('strong', '', POWERUPS[k].label), el('span', '', POWERUP_TEXT[k]))))))),
    backBtn(() => show('menu'))));

  // ---- credits --------------------------------------------------------------------------------
  const credits = screen('credits', 'ui-center', { back: () => show('menu') });
  const creditList = el('div', 'ui-credits');
  for (const group of CREDIT_GROUPS) {
    const items = CREDITS.filter((c) => c.group === group);
    if (!items.length) continue;
    const ul = el('ul', '');
    for (const c of items) {
      // The whole row is the link: a ≥ 44 px tap target on touch.
      const a = append(el('a', 'ui-credit'), el('span', 'ui-credit-what', c.what), el('span', 'ui-credit-meta', `${c.author} · ${c.license}`));
      a.href = c.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.addEventListener('click', () => uiSound('click'));
      ul.append(append(el('li', ''), a));
    }
    creditList.append(append(el('section', ''), el('h3', '', group), ul));
  }
  append(credits.el, append(panel('ui-wide ui-credits-panel'), title('Credits', 'Labib Rush is built with free and open assets. Choukran to their authors!'),
    append(el('p', 'ui-disclaimer'), icon(ICON.warn), el('span', '', DISCLAIMER)),
    creditList, el('p', 'ui-credit-note', PROCEDURAL_NOTE), backBtn(() => show('menu'))));

  // ---- pause ----------------------------------------------------------------------------------
  const resumeBtn = button('Resume', () => resume(), { cls: 'ui-btn-primary', svg: ICON.play, hint: 'Esc' });
  function resume(): void { show(null); handlers.onResume(); }
  const pause = screen('pause', 'ui-center', { back: () => resume(), primary: () => resumeBtn });
  append(pause.el, append(panel('ui-pause-panel'), title('Paused', 'Stanna chwaya… the Avenue will wait.'),
    append(el('div', 'ui-stack'), resumeBtn,
      button('Restart', () => { show(null); handlers.onRestart(); }, { svg: ICON.restart }),
      button('Settings', () => openSettings('pause'), { svg: ICON.gear }),
      button('Quit to menu', () => quitToMenu(), { svg: ICON.home, sound: 'back' }))));

  function quitToMenu(): void {
    inGame = false;
    hideControls();
    ui.classList.remove('ui-playing');
    show('menu');
    handlers.onQuitToMenu();
  }

  // ---- game over ------------------------------------------------------------------------------
  const goScore = el('div', 'ui-go-score', '0');
  const goRank = el('div', 'ui-go-rank');
  const goBadges = el('div', 'ui-go-badges');
  const goStats = el('div', 'ui-go-stats');
  const goBoard = el('div', 'ui-board-wrap');
  const goMe = el('div', 'ui-board-pin'); // never scrolls (see outsideRow)
  const confetti = el('div', 'ui-confetti');
  const againBtn = button('Play again', () => requestPlay(), { cls: 'ui-btn-primary ui-btn-play', svg: ICON.restart, hint: 'R' });
  let armedAt = 0;
  let countRaf = 0;
  const gameover = screen('gameover', 'ui-go', {
    primary: () => againBtn,
    back: () => quitToMenu(),
    keys(e) {
      const armed = performance.now() >= armedAt;
      if (e.key === 'Enter' || e.code === 'KeyR' || e.key === 'Escape' || e.key === ' ') {
        // Swallow keys still held from the run for a moment so nobody skips the results by accident.
        if (!armed || e.repeat) return true;
        if (e.code === 'KeyR') { againBtn.click(); return true; }
      }
      return false;
    },
  });
  append(gameover.el, confetti, append(el('div', 'ui-go-wrap'),
    append(panel('ui-go-main'),
      append(el('header', 'ui-title ui-go-head'), el('h2', '', 'Time’s up!'), el('p', 'ui-sub', 'Wfet el waqt. Yaatik saha, ya batal!')),
      goBadges, append(el('div', 'ui-go-scorebox'), el('span', 'ui-cap', 'Score'), goScore, goRank), goStats,
      append(el('div', 'ui-go-actions'), againBtn, button('Menu', () => quitToMenu(), { svg: ICON.home, sound: 'back' }))),
    append(panel('ui-go-board'), append(el('header', 'ui-board-head'), icon(ICON.trophy), el('h3', '', 'Leaderboard'), el('span', 'ui-board-sub', 'on this device')), goBoard, goMe)));

  const stat = (label: string, value: string, svg: string) =>
    append(el('div', 'ui-stat'), icon(svg), el('span', 'ui-stat-val', value), el('span', 'ui-stat-label', label));

  function showGameOver(r: RunResult): void {
    inGame = false;
    hideControls();
    ui.classList.remove('ui-playing');
    hud.hint(null);
    const entry: ScoreEntry = { name, score: r.score, items: r.items, bestCombo: r.bestCombo, durationSec: r.durationSec, date: new Date().toISOString() };
    const prevBest = store.bestScore(name);
    let list = store.getScores(), rank = rankOf(list, entry);
    if (name) ({ list, rank } = store.addScore(entry));
    const newBest = r.score > 0 && (prevBest === null || r.score > prevBest);
    const first = r.score > 0 && rank === 1;

    goBadges.replaceChildren(...[
      first ? append(el('span', 'ui-badge ui-badge-gold'), icon(ICON.crown), el('span', '', '#1 on this device!')) : null,
      newBest ? append(el('span', 'ui-badge'), icon(ICON.star), el('span', '', 'NEW BEST!')) : null,
    ].filter((x): x is HTMLSpanElement => !!x));
    goRank.replaceChildren('Rank ', el('strong', '', `#${rank}`), ' on this device');
    goStats.replaceChildren(
      stat('Litter binned', fmtInt(r.items), ICON.bin),
      stat('Pickups', fmtInt(r.pickups), ICON.bag),
      stat('Best combo', `×${r.bestCombo}`, ICON.flame),
      stat('Longest chain', fmtInt(r.longestChain), ICON.link),
      stat('GOOOALs', fmtInt(r.trickShots), ICON.ball),
      stat('Litterbugs caught', fmtInt(r.caught), ICON.warn),
      stat('Taxi hits', fmtInt(r.hits), ICON.car),
      stat('Run time', fmtClock(r.durationSec), ICON.clock));
    goBoard.replaceChildren(board(list, true, entry));
    goMe.replaceChildren(...outsideRow(entry, rank, true));

    const celebrate = newBest || first;
    gameover.el.classList.toggle('ui-celebrate', celebrate);
    confetti.replaceChildren();
    if (celebrate && !prefersReducedMotion()) {
      const colors = ['#E70013', '#FFFFFF', '#FFC940', '#1673C4', '#EBCB95'];
      for (let i = 0; i < 36; i++) {
        const c = el('i', '');
        c.style.cssText = `left:${Math.random() * 100}%;background:${colors[i % colors.length]};animation-delay:${(Math.random() * 1.2 + 0.6).toFixed(2)}s;animation-duration:${(2.4 + Math.random() * 1.8).toFixed(2)}s;--dx:${(Math.random() * 2 - 1) * 12}vw;--r:${Math.round(Math.random() * 720 - 360)}deg`;
        confetti.append(c);
      }
    }

    // Score count-up, then reveal the rank and badges.
    cancelAnimationFrame(countRaf);
    gameover.el.classList.remove('ui-revealed');
    const reveal = () => { goScore.textContent = fmtInt(r.score); gameover.el.classList.add('ui-revealed'); };
    if (prefersReducedMotion() || r.score === 0) reveal();
    else {
      const t0 = performance.now(), dur = Math.min(1600, 600 + r.score / 8);
      const stepFn = (now: number) => {
        const t = Math.min(1, (now - t0) / dur);
        goScore.textContent = fmtInt(r.score * (1 - Math.pow(1 - t, 3)));
        if (t < 1) countRaf = requestAnimationFrame(stepFn);
        else reveal();
      };
      countRaf = requestAnimationFrame(stepFn);
    }
    armedAt = performance.now() + 700;
    show('gameover');
    // Short landscape screens scroll the top 10 inside the board panel: bring the player's row into view
    // if it is in there (only that list, never the whole screen, so portrait players land on their
    // score). A row below the top 10 sits outside the scroller, so #1 and its crown stay visible.
    requestAnimationFrame(() => {
      const me = goBoard.querySelector<HTMLElement>('.ui-row-me');
      goBoard.scrollTop = me ? Math.max(0, me.offsetTop + me.offsetHeight - goBoard.clientHeight + 6) : 0;
    });
  }

  // ---- first-play controls card + hints -------------------------------------------------------
  const HINTS: Record<HintId, { desk: string; touch: string; svg: string }> = {
    move: { desk: 'WASD to run · Shift to sprint · Space to jump', touch: 'Left thumb to run · drag the right side to look', svg: ICON.joystick },
    pickup: { desk: 'Run over litter to grab it. Chain pickups for a combo!', touch: 'Run over litter to grab it. Chain pickups for a combo!', svg: ICON.star },
    deposit: { desk: 'Bag getting full? Follow the arrow to a bin to cash in.', touch: 'Bag getting full? Follow the arrow to a bin to cash in.', svg: ICON.bin },
    kick: { desk: 'F or click to kick cans. Land one in a bin: GOOOAL!', touch: 'Tap Kick near a can. Land it in a bin: GOOOAL!', svg: ICON.star },
    radar: { desk: 'Press Q: Labib’s ears reveal litter through walls.', touch: 'Tap Radar: Labib’s ears reveal litter through walls.', svg: ICON.ears },
    litterbug: { desk: 'See the ⚠ icon? Touch the litterbug fast: Caught!', touch: 'See the ⚠ icon? Touch the litterbug fast: Caught!', svg: ICON.warn },
  };
  const controlsCard = el('div', 'ui-controls-card');
  hud.el.insertBefore(controlsCard, hud.el.querySelector('.ui-callout')); // callouts + float texts draw on top
  let queuedHint: HintId | null = null; // a hint asked for while the controls card is up
  const controlsT = timed(controlsCard, () => {
    if (queuedHint && inGame) showHintNow(queuedHint);
    queuedHint = null;
  });
  const hideControls = () => controlsT.hide();
  function showHintNow(id: HintId): void {
    store.markHint(id);
    const h = HINTS[id];
    hud.hint(touch ? h.touch : h.desk, h.svg);
  }
  function showControlsOnce(): void {
    if (store.hintSeen('controls')) return;
    store.markHint('controls');
    store.markHint('move'); // the card already covers it
    controlsCard.replaceChildren(el('strong', 'ui-cc-title', 'Controls'), (touch ? touchControls : desktopControls).cloneNode(true));
    controlsT.show(9000);
  }

  // ---- rotate-your-phone: pause when a touch player turns the phone upright mid-run -----------
  // Phones only (same query as the CSS overlay): tablets are wide enough to play in portrait.
  const portrait = typeof matchMedia === 'function' ? matchMedia('(orientation: portrait) and (max-width: 600px)') : null;
  const checkPortrait = () => {
    if (portrait?.matches && touch && inGame && !current) handlers.onPause();
  };
  portrait?.addEventListener('change', checkPortrait);

  // ---- controller -----------------------------------------------------------------------------
  return {
    setLoading(p, label) {
      const v = Math.max(0, Math.min(1, p));
      progFill.style.transform = `scaleX(${v})`;
      progress.setAttribute('aria-valuenow', String(Math.round(v * 100)));
      progLabel.textContent = label;
      progPct.textContent = `${Math.round(v * 100)}%`;
    },

    finishLoading() {
      clearInterval(tipTimer);
      progFill.style.transform = 'scaleX(1)';
      show(name ? 'menu' : 'name');
      loading.classList.add('ui-leaving');
      setTimeout(() => loading.classList.remove('ui-on', 'ui-leaving'), prefersReducedMotion() ? 0 : 650);
    },

    enterGame() {
      inGame = true;
      show(null);
      ui.classList.add('ui-playing');
      hud.reset();
      showControlsOnce();
      setTimeout(checkPortrait, 0);
    },

    updateHud(h: HudState) { hud.update(h); },

    callout(text, kind = 'combo') { hud.callout(text, kind); },

    floatText(text: string, world: Vector3, kind = 'points') { hud.floatText(text, world, kind); },

    setProjector(fn) { hud.setProjector(fn); },

    setBinPointer(world) { hud.setBinPointer(world); },

    showHint(id) {
      if (!id) { hud.hint(null); queuedHint = null; return; }
      if (!inGame || current || store.hintSeen(id)) return; // never under the pause menu
      if (controlsT.active) queuedHint = id;
      else showHintNow(id);
    },

    showPause() { if (inGame) show('pause'); },

    hidePause() { if (current?.id === 'pause' || (current?.id === 'settings' && settingsFrom === 'pause')) show(null); },

    showGameOver,

    getSettings: () => ({ ...settings }),
    getPlayerName: () => name,
    isInGame: () => inGame,
  };
}
