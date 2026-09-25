// In-game HUD (z-index 30). updateHud() runs every frame, so everything here diffs against the
// last written value and only touches the DOM on change; floating texts are a fixed DOM pool.
// The top band holds all widgets; the bottom corners stay free for the touch controls.
import { Vector3, type Camera } from 'three';
import type { HudState, PowerUpKind, ScreenPoint } from '../core/types';
import { POWERUPS, RULES } from '../core/config';
import { append, button, el, fmtInt, icon, prefersReducedMotion, timed } from './dom';
import { ICON, POWERUP_ICON } from './icons';

export type CalloutKind = 'combo' | 'good' | 'bad' | 'info';
export type FloatKind = 'points' | 'time' | 'bad' | 'gold';

const FLOAT_POOL = 24;
const FLOAT_LIFE = 1.15; // s
const RING_C = 2 * Math.PI * 21; // combo ring circumference (r = 21 in a 48 viewBox)
const HINT_SECONDS = 6.5;
const CHIP_INDEX: Record<PowerUpKind, number> = { tea: 0, bambalouni: 1, chechia: 2, mashmoum: -1 }; // mashmoum is instant

export interface Hud {
  readonly el: HTMLElement;
  update(h: HudState): void;
  callout(text: string, kind: CalloutKind): void;
  floatText(text: string, world: Vector3, kind: FloatKind): void;
  setProjector(fn: (world: Vector3) => ScreenPoint): void;
  setBinPointer(world: Vector3 | null): void;
  /** Shows a hint pill (text already chosen for the device) or hides it with null. */
  hint(text: string | null, svg?: string): void;
  /** A menu covers the game: hide the hint and keep its remaining time until resumed. */
  setPaused(paused: boolean): void;
  /** Clears transient things between runs. */
  reset(): void;
}

/**
 * Projector for UIController.setProjector: world → CSS pixels of a full-window canvas.
 * For points behind the camera it returns visible=false with x/y pushed far off-screen in the
 * correct direction, so the bin pointer still points the right way. The result object is reused.
 */
export function createProjector(camera: Camera): (world: Vector3) => ScreenPoint {
  const v = new Vector3();
  const out: ScreenPoint = { x: 0, y: 0, visible: false };
  return (world) => {
    v.copy(world).applyMatrix4(camera.matrixWorldInverse);
    const behind = v.z > 0; // the camera looks down its local −Z
    v.applyMatrix4(camera.projectionMatrix);
    let x = v.x, y = v.y;
    if (behind) {
      const len = Math.hypot(x, y) || 1;
      x = (-x / len) * 1e3; y = (-y / len) * 1e3;
      if (x === 0 && y === 0) y = -1e3;
    }
    out.x = ((x + 1) / 2) * innerWidth;
    out.y = ((1 - y) / 2) * innerHeight;
    out.visible = !behind && Math.abs(x) <= 1 && Math.abs(y) <= 1;
    return out;
  };
}

interface FloatSlot { el: HTMLDivElement; world: Vector3; age: number; active: boolean }

export function createHud(onPause: () => void, isTouch: () => boolean): Hud {
  const root = el('div', 'ui-hud');
  const decorative = (e: HTMLElement) => { e.setAttribute('aria-hidden', 'true'); return e; }; // the pause button and hints stay exposed

  // ---- top-left: score, combo, bag, radar -------------------------------------------------
  const scoreVal = el('span', 'ui-score-val', '0');
  const score = append(el('div', 'ui-score'), el('span', 'ui-cap', 'Score'), scoreVal);

  const comboX = el('span', 'ui-combo-x', '×1');
  const combo = el('div', 'ui-combo');
  combo.innerHTML = `<svg viewBox="0 0 48 48" aria-hidden="true"><circle class="ui-ring-bg" cx="24" cy="24" r="21"/><circle class="ui-ring" cx="24" cy="24" r="21" stroke-dasharray="${RING_C}" stroke-dashoffset="${RING_C}"/></svg>`;
  combo.append(comboX);
  const ring = combo.querySelector<SVGCircleElement>('.ui-ring')!;

  const slots: HTMLSpanElement[] = [];
  const bagSlots = el('div', 'ui-slots');
  for (let i = 0; i < RULES.bagMax; i++) slots.push(bagSlots.appendChild(el('span', 'ui-slot')));
  const bagCount = el('span', 'ui-bag-count', `0/${RULES.bagMax}`);
  const bag = append(el('div', 'ui-bag'), icon(ICON.bag), bagSlots, bagCount);

  // Starts ready: the class must match last.radarReady below, or the first update never adds it.
  const radar = append(el('div', 'ui-radar ui-ready'), icon(ICON.ears), el('kbd', 'ui-radar-key', 'Q'));

  const tl = append(decorative(el('div', 'ui-hud-tl')), append(el('div', 'ui-hud-row'), score, combo), append(el('div', 'ui-hud-row'), bag, radar));

  // ---- top-centre: timer + power-up chips ---------------------------------------------------
  const timerVal = el('span', 'ui-timer-val', '01:30');
  const timer = append(el('div', 'ui-timer'), icon(ICON.clock), timerVal);
  const chipsRow = el('div', 'ui-chips');
  const chips = (['tea', 'bambalouni', 'chechia'] as const).map((kind) => {
    const sec = el('span', 'ui-chip-sec');
    const chip = append(el('div', `ui-chip ui-chip-${kind}`), icon(POWERUP_ICON[kind], 'ui-chip-ico'), sec);
    chip.title = POWERUPS[kind].label;
    chipsRow.append(chip);
    return { el: chip, sec, on: false, shown: false, p: -1, s: -1 };
  });
  const tc = append(decorative(el('div', 'ui-hud-tc')), timer, chipsRow);

  // ---- misc ---------------------------------------------------------------------------------
  const pauseBtn = button('Pause', onPause, { cls: 'ui-pausebtn', svg: ICON.pause });
  pauseBtn.setAttribute('aria-label', 'Pause');
  const calloutEl = decorative(el('div', 'ui-callout'));
  const hintEl = el('div', 'ui-hint');
  hintEl.setAttribute('role', 'status');
  const hintT = timed(hintEl);
  const binPtr = decorative(el('div', 'ui-binptr'));
  binPtr.append(icon(ICON.arrow, 'ui-binptr-arrow'), icon(ICON.bin, 'ui-binptr-bin'));
  const floatsEl = decorative(el('div', 'ui-floats'));
  append(root, tl, tc, pauseBtn, calloutEl, hintEl, binPtr, floatsEl);

  const pool: FloatSlot[] = [];
  for (let i = 0; i < FLOAT_POOL; i++) {
    const f = floatsEl.appendChild(el('div', 'ui-float'));
    pool.push({ el: f, world: new Vector3(), age: 0, active: false });
  }

  // ---- state --------------------------------------------------------------------------------
  let project: (w: Vector3) => ScreenPoint = () => ({ x: 0, y: 0, visible: false });
  const binWorld = new Vector3();
  let binOn = false;
  let binShown = false;
  let lastT = 0;
  let shownScore = 0, targetScore = 0, lastBump = 0;
  // Each boolean mirrors a CSS class on its element; they must start (and stay) in sync.
  const last = { sec: -1, urgent: false, time: -1, mult: -1, ring: -1, bag: -1, radar: -1, radarReady: true, bagFull: false, comboOn: false };

  const pop = (e: Element, scale = 1.18, ms = 220) => {
    if (prefersReducedMotion()) return;
    e.animate([{ transform: 'scale(1)' }, { transform: `scale(${scale})` }, { transform: 'scale(1)' }], { duration: ms, easing: 'cubic-bezier(.3,1.6,.5,1)' });
  };

  function updateFloats(dt: number): void {
    for (const f of pool) {
      if (!f.active) continue;
      f.age += dt;
      const t = f.age / FLOAT_LIFE;
      if (t >= 1) { f.active = false; f.el.style.opacity = '0'; continue; }
      const p = project(f.world);
      if (!p.visible) { f.el.style.opacity = '0'; continue; }
      const rise = 70 * (1 - (1 - t) * (1 - t));
      const s = t < 0.12 ? 0.6 + (t / 0.12) * 0.55 : t < 0.22 ? 1.15 - ((t - 0.12) / 0.1) * 0.15 : 1;
      f.el.style.opacity = String(t < 0.65 ? 1 : 1 - (t - 0.65) / 0.35);
      f.el.style.transform = `translate3d(${p.x.toFixed(1)}px,${(p.y - rise).toFixed(1)}px,0) translate(-50%,-50%) scale(${s.toFixed(3)})`;
    }
  }

  function updateBinPointer(): void {
    let show = false;
    if (binOn) {
      const p = project(binWorld);
      const w = innerWidth, h = innerHeight;
      const onScreen = p.visible && p.x > w * 0.04 && p.x < w * 0.96 && p.y > h * 0.06 && p.y < h * 0.94;
      if (!onScreen) {
        show = true;
        const cx = w / 2, cy = h / 2;
        let dx = p.x - cx, dy = p.y - cy;
        if (dx === 0 && dy === 0) dy = 1;
        // Keep clear of the HUD band at the top and (on touch) the control clusters at the bottom.
        const mx = Math.max(44, w * 0.06), top = Math.max(96, h * 0.2), bottom = isTouch() ? Math.max(120, h * 0.34) : Math.max(56, h * 0.1);
        const kx = dx !== 0 ? (dx > 0 ? w - mx - cx : cx - mx) / Math.abs(dx) : Infinity;
        const ky = dy !== 0 ? (dy > 0 ? h - bottom - cy : cy - top) / Math.abs(dy) : Infinity;
        const k = Math.min(kx, ky);
        const ang = Math.atan2(dy, dx) + Math.PI / 2;
        binPtr.style.transform = `translate3d(${(cx + dx * k).toFixed(1)}px,${(cy + dy * k).toFixed(1)}px,0) translate(-50%,-50%)`;
        binPtr.style.setProperty('--ang', `${ang.toFixed(3)}rad`);
      }
    }
    if (show !== binShown) { binShown = show; binPtr.classList.toggle('ui-on', show); }
  }

  return {
    el: root,

    update(h) {
      const now = performance.now();
      const dt = lastT ? Math.min(0.1, (now - lastT) / 1000) : 0;
      lastT = now;

      // score count-up
      if (h.score !== targetScore) {
        if (h.score > targetScore && now - lastBump > 140) { pop(score, 1.08, 200); lastBump = now; }
        targetScore = h.score;
      }
      if (shownScore !== targetScore) {
        const diff = targetScore - shownScore;
        shownScore = Math.abs(diff) < 1 ? targetScore : shownScore + diff * (1 - Math.exp(-dt * 12));
        scoreVal.textContent = fmtInt(shownScore);
      }

      // timer (shows ceil so "0:01" is the last second)
      const sec = Math.ceil(h.timeLeft - 1e-6);
      if (sec !== last.sec) {
        timerVal.textContent = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
        const urgent = sec <= RULES.warningSeconds;
        if (urgent !== last.urgent) { timer.classList.toggle('ui-urgent', urgent); last.urgent = urgent; }
        if (urgent && sec < last.sec && !prefersReducedMotion()) {
          timer.animate([{ transform: 'scale(1.28)' }, { transform: 'scale(1)' }], { duration: 420, easing: 'cubic-bezier(.2,.8,.3,1)' });
        }
        last.sec = sec;
      }
      if (last.time >= 0 && h.timeLeft > last.time + 0.05 && !prefersReducedMotion()) {
        timer.animate([{ boxShadow: '0 0 0 .25em rgba(40,220,140,.75)', filter: 'brightness(1.4)' }, { boxShadow: '0 0 0 0 rgba(40,220,140,0)', filter: 'none' }], { duration: 600 });
      }
      last.time = h.timeLeft;

      // combo multiplier + ring
      if (h.multiplier !== last.mult) {
        comboX.textContent = `×${h.multiplier}`;
        combo.dataset.m = String(h.multiplier);
        if (h.multiplier > last.mult && last.mult > 0) pop(combo, 1.35, 320);
        last.mult = h.multiplier;
      }
      const r = Math.round(h.comboProgress01 * 200) / 200;
      if (r !== last.ring) {
        ring.setAttribute('stroke-dashoffset', (RING_C * (1 - r)).toFixed(2));
        last.ring = r;
        const on = r > 0;
        if (on !== last.comboOn) { combo.classList.toggle('ui-live', on); last.comboOn = on; }
      }

      // bag
      if (h.bag !== last.bag) {
        for (let i = 0; i < slots.length; i++) slots[i].classList.toggle('ui-full', i < h.bag);
        if (h.bag > last.bag && last.bag >= 0 && h.bag > 0) pop(slots[h.bag - 1], 1.6, 260);
        bagCount.textContent = h.bag >= h.bagMax ? 'FULL' : `${h.bag}/${h.bagMax}`;
        const full = h.bag >= h.bagMax;
        if (full !== last.bagFull) { bag.classList.toggle('ui-bag-isfull', full); last.bagFull = full; }
        last.bag = h.bag;
      }

      // radar cooldown
      const rc = Math.round(h.radarCooldown01 * 100) / 100;
      if (rc !== last.radar) {
        radar.style.setProperty('--p', String(rc));
        const ready = rc <= 0;
        if (ready !== last.radarReady) {
          radar.classList.toggle('ui-ready', ready);
          if (ready) pop(radar, 1.25, 280);
          last.radarReady = ready;
        }
        last.radar = rc;
      }

      // power-up chips (index loops: no iterator allocation per frame)
      for (let i = 0; i < chips.length; i++) chips[i].on = false;
      for (let j = 0; j < h.powerups.length; j++) {
        const p = h.powerups[j];
        const c = chips[CHIP_INDEX[p.kind]];
        if (!c) continue;
        c.on = true;
        const frac = Math.round((p.duration > 0 ? p.remaining / p.duration : 0) * 100) / 100;
        if (frac !== c.p) { c.el.style.setProperty('--p', String(frac)); c.p = frac; }
        const s = Math.ceil(p.remaining);
        if (s !== c.s) { c.sec.textContent = `${s}s`; c.el.classList.toggle('ui-low', p.remaining < 2.5); c.s = s; }
      }
      for (let i = 0; i < chips.length; i++) {
        const c = chips[i];
        if (c.on === c.shown) continue;
        c.shown = c.on;
        c.el.classList.toggle('ui-on', c.on);
        if (c.on) pop(c.el, 1.3, 300); else c.p = c.s = -1;
      }

      updateFloats(dt);
      updateBinPointer();
    },

    callout(text, kind) {
      calloutEl.textContent = text;
      calloutEl.className = `ui-callout ui-c-${kind}`;
      calloutEl.getAnimations().forEach((a) => a.cancel());
      const still = prefersReducedMotion();
      calloutEl.animate(
        still
          ? [{ opacity: 0 }, { opacity: 1, offset: 0.1 }, { opacity: 1, offset: 0.75 }, { opacity: 0 }]
          : [
            { opacity: 0, transform: 'translate(-50%,-50%) scale(.35) rotate(-6deg)' },
            { opacity: 1, transform: 'translate(-50%,-50%) scale(1.18) rotate(2deg)', offset: 0.14 },
            { opacity: 1, transform: 'translate(-50%,-50%) scale(1) rotate(0)', offset: 0.24 },
            { opacity: 1, transform: 'translate(-50%,-50%) scale(1.03)', offset: 0.74 },
            { opacity: 0, transform: 'translate(-50%,-62%) scale(1.1)' },
          ],
        { duration: kind === 'info' ? 1500 : 1250, easing: 'ease-out', fill: 'both' },
      );
    },

    floatText(text, world, kind) {
      let slot = pool.find((f) => !f.active);
      if (!slot) slot = pool.reduce((a, b) => (a.age > b.age ? a : b)); // recycle the oldest
      slot.active = true;
      slot.age = 0;
      slot.world.copy(world);
      slot.el.textContent = text;
      slot.el.className = `ui-float ui-f-${kind}`;
      slot.el.style.opacity = '0';
    },

    setProjector(fn) { project = fn; },

    setBinPointer(world) {
      binOn = !!world;
      if (world) binWorld.copy(world);
    },

    hint(text, svg) {
      if (!text) { hintT.hide(); return; }
      hintEl.replaceChildren(...(svg ? [icon(svg)] : []), el('span', '', text));
      hintT.show(HINT_SECONDS * 1000);
    },

    setPaused(paused) {
      if (paused) hintT.pause(); else hintT.resume();
    },

    reset() {
      for (const f of pool) { f.active = false; f.el.style.opacity = '0'; }
      calloutEl.getAnimations().forEach((a) => a.cancel());
      calloutEl.textContent = '';
      hintT.hide();
      shownScore = targetScore = 0;
      scoreVal.textContent = '0';
      last.sec = last.mult = last.ring = last.bag = last.radar = last.time = -1;
      lastT = 0;
      binOn = false;
      updateBinPointer();
    },
  };
}
