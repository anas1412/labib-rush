// Tiny DOM helpers shared by the UI files. User-provided text always goes through textContent.

export type UiSound = 'click' | 'hover' | 'back';

/** Audio hooks into this: window 'ui:click' CustomEvent<{ kind }>. */
export function uiSound(kind: UiSound): void {
  dispatchEvent(new CustomEvent('ui:click', { detail: { kind } }));
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Wraps static, trusted SVG markup from icons.ts (never user data). */
export function icon(svg: string, cls = 'ui-ico'): HTMLSpanElement {
  const s = el('span', cls);
  s.innerHTML = svg;
  return s;
}

export function append<T extends HTMLElement>(parent: T, ...kids: (Node | string | null | false)[]): T {
  for (const k of kids) if (k) parent.append(k);
  return parent;
}

/** A button that plays the UI click (or back) sound, and the hover sound for mouse users. */
export function button(label: string, onClick: () => void, opts: { cls?: string; svg?: string; sound?: UiSound; hint?: string } = {}): HTMLButtonElement {
  const b = el('button', `ui-btn ${opts.cls ?? ''}`.trim());
  b.type = 'button';
  if (opts.svg) b.append(icon(opts.svg));
  b.append(el('span', 'ui-btn-label', label));
  if (opts.hint) b.append(el('kbd', 'ui-btn-kbd', opts.hint));
  b.addEventListener('click', () => {
    uiSound(opts.sound ?? 'click');
    onClick();
  });
  b.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') uiSound('hover'); });
  return b;
}

// One MediaQueryList for the page: calling matchMedia() per animation would allocate during play.
const reducedMotion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
export const prefersReducedMotion = () => !!reducedMotion?.matches;

/** Shows `e` (class ui-on) for a while. pause() hides it and keeps the time left for resume(), so a
 *  hint that was up when the game paused comes back instead of expiring unread behind the menu. */
export interface Timed { show(ms: number): void; hide(): void; pause(): void; resume(): void; readonly active: boolean }
export function timed(e: HTMLElement, onHide?: () => void): Timed {
  let timer = 0, left = 0, since = 0, held = false;
  const start = () => { since = performance.now(); e.classList.add('ui-on'); timer = window.setTimeout(hide, left); };
  function hide(): void {
    const was = held || e.classList.contains('ui-on');
    clearTimeout(timer);
    held = false;
    e.classList.remove('ui-on');
    if (was) onHide?.();
  }
  return {
    show(ms) { clearTimeout(timer); held = false; left = ms; start(); },
    hide,
    pause() {
      if (held || !e.classList.contains('ui-on')) return;
      clearTimeout(timer);
      left -= performance.now() - since;
      held = true;
      e.classList.remove('ui-on');
    },
    resume() {
      if (!held) return;
      if (left > 0) { held = false; start(); } else hide();
    },
    get active() { return held || e.classList.contains('ui-on'); },
  };
}

const nf = new Intl.NumberFormat('en-US');
export const fmtInt = (n: number) => nf.format(Math.round(n));
export const fmtClock = (sec: number) => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
