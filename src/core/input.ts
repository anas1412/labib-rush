// Keyboard / mouse (pointer lock) / touch input, polled once per rendered frame.
// Conventions: move.y = forward, move.x = right; lookDX > 0 = turn right, lookDY > 0 = look down
// (camera rises). Touch controls live in #touch (z-index 20), classes prefixed `tc-`. The overlay
// itself is click-through (only its buttons take pointers); the stick and look drags start on the
// canvas. Touch vs mouse/keyboard mode follows the last device used (touchscreen laptops).
import type { Input, InputFrame, Settings } from './types';

const MOUSE_RAD_PER_PX = 0.0022;
const TOUCH_RAD_PER_PX = 0.0055;
const STICK_RADIUS = 56; // px the knob can travel
const STICK_DEADZONE = 0.12;
const STICK_SPRINT_AT = 1.3; // dragging the thumb this far past the rim sprints (one-thumb sprint)
const MAX_MOUSE_STEP = 250; // px per event; Chrome sometimes reports a huge first delta on lock

type Btn = 'jump' | 'kick' | 'sprint' | 'radar';

const ICONS: Record<Btn, string> = {
  jump: '<path d="M12 5l-7 7h4.5v7h5v-7H19z"/>',
  kick: '<circle cx="12" cy="12" r="7.2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 8.2l3.3 2.4-1.3 3.9h-4l-1.3-3.9z"/>',
  sprint: '<path d="M13.5 3L6 13.5h5L9.5 21 18 10h-5.2z"/>',
  radar: '<path d="M6.5 4.5c-1.9 3.2-1.9 11.8 0 15M17.5 4.5c1.9 3.2 1.9 11.8 0 15M9.6 7.5c-1 2.3-1 6.7 0 9M14.4 7.5c1 2.3 1 6.7 0 9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="12" r="1.8"/>',
};
const LABELS: Record<Btn, string> = { jump: 'Jump', kick: 'Kick', sprint: 'Sprint', radar: 'Radar' };

const CSS = `
#touch{position:fixed;inset:0;z-index:20;display:none;pointer-events:none;touch-action:none;user-select:none;-webkit-user-select:none;
  -webkit-touch-callout:none;-webkit-tap-highlight-color:transparent;overflow:hidden;font-family:Cairo,system-ui,sans-serif}
#touch.tc-show{display:block}
.tc-stick{position:absolute;left:0;top:0;width:${STICK_RADIUS * 2 + 20}px;height:${STICK_RADIUS * 2 + 20}px;
  margin:-${STICK_RADIUS + 10}px 0 0 -${STICK_RADIUS + 10}px;border-radius:50%;pointer-events:none;opacity:.38;
  background:radial-gradient(circle,rgba(255,255,255,.06) 0 45%,rgba(255,255,255,.16) 70%,rgba(255,255,255,.26) 100%);
  border:1.5px solid rgba(255,255,255,.5);box-shadow:0 8px 28px rgba(0,0,0,.22),inset 0 0 22px rgba(255,255,255,.12);
  -webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);transition:opacity .18s ease}
.tc-stick.tc-on{opacity:1;transition:none}
.tc-knob{position:absolute;left:50%;top:50%;width:58px;height:58px;margin:-29px 0 0 -29px;border-radius:50%;
  background:radial-gradient(circle at 35% 30%,#fff 0,rgba(255,255,255,.92) 40%,rgba(236,226,210,.85) 100%);
  box-shadow:0 4px 14px rgba(0,0,0,.3),inset 0 -3px 6px rgba(0,0,0,.08)}
.tc-btn{position:absolute;display:grid;place-items:center;border-radius:50%;color:#fff;pointer-events:auto;touch-action:none;
  background:linear-gradient(160deg,rgba(255,255,255,.26),rgba(255,255,255,.08));border:1.5px solid rgba(255,255,255,.55);
  box-shadow:0 8px 24px rgba(0,0,0,.25),inset 0 1px 0 rgba(255,255,255,.45);
  -webkit-backdrop-filter:blur(6px) saturate(1.3);backdrop-filter:blur(6px) saturate(1.3);transition:transform .08s ease,background .08s ease}
.tc-btn svg{width:46%;height:46%;fill:currentColor;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35));margin-top:-8%}
.tc-btn span{position:absolute;bottom:12%;font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;
  text-shadow:0 1px 2px rgba(0,0,0,.45);opacity:.92}
.tc-btn.tc-on{transform:scale(.9);background:linear-gradient(160deg,rgba(255,255,255,.55),rgba(255,255,255,.3))}
.tc-jump{width:clamp(70px,19vmin,92px);height:clamp(70px,19vmin,92px);right:calc(22px + env(safe-area-inset-right));bottom:calc(24px + env(safe-area-inset-bottom))}
.tc-jump{background:linear-gradient(160deg,rgba(231,0,19,.55),rgba(160,0,14,.35))}
.tc-jump.tc-on{background:linear-gradient(160deg,rgba(255,70,80,.8),rgba(200,0,20,.6))}
.tc-kick{width:clamp(58px,15vmin,72px);height:clamp(58px,15vmin,72px);right:calc(22px + clamp(82px,22vmin,106px) + env(safe-area-inset-right));bottom:calc(18px + env(safe-area-inset-bottom))}
.tc-radar{width:clamp(50px,13vmin,62px);height:clamp(50px,13vmin,62px);right:calc(28px + env(safe-area-inset-right));bottom:calc(30px + clamp(82px,22vmin,106px) + env(safe-area-inset-bottom))}
.tc-sprint{width:clamp(52px,14vmin,66px);height:clamp(52px,14vmin,66px);right:calc(18px + clamp(78px,21vmin,100px) + env(safe-area-inset-right));bottom:calc(14px + clamp(80px,21vmin,102px) + env(safe-area-inset-bottom))}
`;

const isCoarse = () =>
  typeof matchMedia === 'function' && (matchMedia('(pointer: coarse)').matches || (navigator.maxTouchPoints > 0 && !matchMedia('(pointer: fine)').matches));

export function createInput(canvas: HTMLElement, settings: Settings): Input {
  let cfg = settings;
  let enabled = false;
  let touchMode = isCoarse();
  const keys = new Set<string>();
  const frame: InputFrame = { move: { x: 0, y: 0 }, lookDX: 0, lookDY: 0, sprint: false, jumpPressed: false, jumpHeld: false, kickPressed: false, radarPressed: false, pausePressed: false };
  let lookDX = 0, lookDY = 0;
  let jumpEdge = false, kickEdge = false, radarEdge = false, pauseEdge = false;
  let releasingLock = false; // we asked for the unlock ourselves → not a pause

  // touch state
  const stick = { id: -1, ox: 0, oy: 0, x: 0, y: 0, sprint: false };
  let lookId = -1, lookX = 0, lookY = 0;
  const btnDown: Record<Btn, number> = { jump: -1, kick: -1, sprint: -1, radar: -1 }; // pointerId or -1

  // ---- DOM ----------------------------------------------------------------------------------
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  const root = document.createElement('div');
  root.id = 'touch';
  const stickEl = document.createElement('div');
  stickEl.className = 'tc-stick';
  const knobEl = document.createElement('div');
  knobEl.className = 'tc-knob';
  stickEl.appendChild(knobEl);
  root.appendChild(stickEl);
  const btnEls = {} as Record<Btn, HTMLDivElement>;
  for (const b of ['jump', 'kick', 'sprint', 'radar'] as Btn[]) {
    const el = document.createElement('div');
    el.className = `tc-btn tc-${b}`;
    el.dataset.btn = b;
    el.setAttribute('aria-label', LABELS[b]);
    el.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[b]}</svg><span>${LABELS[b]}</span>`;
    root.appendChild(el);
    btnEls[b] = el;
  }
  document.body.appendChild(root);

  function placeStickIdle(): void {
    const r = root.getBoundingClientRect();
    stickEl.style.transform = `translate(${Math.max(110, r.width * 0.12)}px, ${r.height - Math.max(120, r.height * 0.22)}px)`;
    knobEl.style.transform = '';
  }

  function refreshVisibility(): void {
    root.classList.toggle('tc-show', enabled && touchMode);
    if (enabled && touchMode) placeStickIdle();
  }

  // ---- helpers ------------------------------------------------------------------------------
  const locked = () => document.pointerLockElement === canvas;
  const typingTarget = (e: Event) => {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  };

  function clearTouch(): void {
    stick.id = -1; stick.x = stick.y = 0; stick.sprint = false;
    lookId = -1;
    for (const b of Object.keys(btnDown) as Btn[]) { btnDown[b] = -1; btnEls[b].classList.remove('tc-on'); }
    stickEl.classList.remove('tc-on');
  }
  /** Drops edges, deltas and touch state (not held keys: see onKeyDown). */
  function clearAll(): void {
    lookDX = lookDY = 0;
    jumpEdge = kickEdge = radarEdge = pauseEdge = false;
    clearTouch();
  }

  function lockPointer(): void {
    if (touchMode || locked()) return;
    try {
      const p = (canvas.requestPointerLock as () => Promise<void> | void).call(canvas);
      if (p && typeof p.catch === 'function') p.catch(() => undefined); // e.g. too soon after Esc
    } catch { /* not allowed right now */ }
  }

  // ---- keyboard -----------------------------------------------------------------------------
  const GAME_KEYS = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
  const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
  function onKeyDown(e: KeyboardEvent): void {
    if (typingTarget(e)) return;
    // Held keys are tracked even while disabled, so W/Shift held through a countdown or Resume
    // work at once (a held key sends no new keydown until it auto-repeats).
    keys.add(e.code);
    if (!enabled) return;
    if (GAME_KEYS.has(e.code)) e.preventDefault(); // no page scroll
    if (touchMode && MOVE_KEYS.has(e.code)) setTouchMode(false);
    if (e.repeat) return;
    switch (e.code) {
      case 'Space': jumpEdge = true; break;
      case 'KeyF': kickEdge = true; break;
      // Physical keys: on AZERTY the KeyQ position is the letter A (kick), radar moves to E.
      case 'KeyQ': if (cfg.keyboard === 'azerty') kickEdge = true; else radarEdge = true; break;
      case 'KeyE': radarEdge = true; break;
      case 'Escape': case 'KeyP': pauseEdge = true; break;
    }
  }
  function onKeyUp(e: KeyboardEvent): void { keys.delete(e.code); }
  function onBlur(): void { keys.clear(); }

  // ---- mouse --------------------------------------------------------------------------------
  function onCanvasClick(): void { if (enabled && !touchMode) lockPointer(); }
  function onMouseDown(e: MouseEvent): void { if (enabled && locked() && e.button === 0) kickEdge = true; }
  function onMouseMove(e: MouseEvent): void {
    if (!enabled || !locked()) return;
    const k = MOUSE_RAD_PER_PX * cfg.mouseSensitivity;
    const clamp = (v: number) => Math.max(-MAX_MOUSE_STEP, Math.min(MAX_MOUSE_STEP, v));
    lookDX += clamp(e.movementX) * k;
    lookDY += clamp(e.movementY) * k * (cfg.invertY ? -1 : 1);
  }
  function onLockChange(): void {
    if (!locked() && enabled && !releasingLock) pauseEdge = true; // the browser ate Esc / focus lost
    releasingLock = false;
  }

  // ---- touch (pointer events, multi-touch by pointerId) ---------------------------------------
  function setBtn(b: Btn, id: number): void {
    btnDown[b] = id;
    btnEls[b].classList.toggle('tc-on', id !== -1);
  }
  function setTouchMode(on: boolean): void {
    if (on === touchMode) return;
    touchMode = on;
    clearTouch();
    refreshVisibility();
  }
  // The last pointer type used picks the mode: a touch shows the touch controls, a real mouse
  // (pointer events are never synthesised from touches) hides them again.
  function onAnyPointerDown(e: PointerEvent): void {
    setTouchMode(e.pointerType !== 'mouse');
  }
  const capture = (e: PointerEvent) => { try { (e.target as Element).setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ } };
  function onButtonDown(e: PointerEvent): void {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.tc-btn')?.dataset.btn as Btn | undefined;
    if (!enabled || !touchMode || !btn) return;
    e.preventDefault();
    capture(e);
    setBtn(btn, e.pointerId);
    if (btn === 'jump') jumpEdge = true;
    else if (btn === 'kick') kickEdge = true;
    else if (btn === 'radar') radarEdge = true;
  }
  /** Touches on the canvas: left part = floating stick, right part = look drag. */
  function onCanvasPointerDown(e: PointerEvent): void {
    if (!enabled || !touchMode || e.pointerType === 'mouse') return;
    e.preventDefault();
    capture(e);
    const r = root.getBoundingClientRect();
    if (e.clientX - r.left < r.width * 0.45) {
      if (stick.id !== -1) return;
      stick.id = e.pointerId;
      stick.ox = e.clientX - r.left; stick.oy = e.clientY - r.top;
      stick.x = stick.y = 0;
      stickEl.style.transform = `translate(${stick.ox}px, ${stick.oy}px)`;
      knobEl.style.transform = '';
      stickEl.classList.add('tc-on');
    } else if (lookId === -1) {
      lookId = e.pointerId; lookX = e.clientX; lookY = e.clientY;
    }
  }
  function onPointerMove(e: PointerEvent): void {
    if (!enabled || !touchMode) return;
    if (e.pointerId === stick.id) {
      const r = root.getBoundingClientRect();
      const dx = e.clientX - r.left - stick.ox, dy = e.clientY - r.top - stick.oy;
      const len = Math.hypot(dx, dy);
      const k = len > STICK_RADIUS ? STICK_RADIUS / len : 1;
      knobEl.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
      const m = Math.min(1, len / STICK_RADIUS);
      const mag = m < STICK_DEADZONE ? 0 : (m - STICK_DEADZONE) / (1 - STICK_DEADZONE);
      stick.x = len > 0 ? (dx / len) * mag : 0;
      stick.y = len > 0 ? (-dy / len) * mag : 0;
      stick.sprint = len > STICK_RADIUS * STICK_SPRINT_AT;
    } else if (e.pointerId === lookId) {
      const k = TOUCH_RAD_PER_PX * cfg.mouseSensitivity;
      lookDX += (e.clientX - lookX) * k;
      lookDY += (e.clientY - lookY) * k * (cfg.invertY ? -1 : 1);
      lookX = e.clientX; lookY = e.clientY;
    }
  }
  function onPointerUp(e: PointerEvent): void {
    if (e.pointerId === stick.id) {
      stick.id = -1; stick.x = stick.y = 0; stick.sprint = false;
      stickEl.classList.remove('tc-on');
      placeStickIdle();
    }
    if (e.pointerId === lookId) lookId = -1;
    for (const b of Object.keys(btnDown) as Btn[]) if (btnDown[b] === e.pointerId) setBtn(b, -1);
  }
  const prevent = (e: Event) => { if (enabled && touchMode) e.preventDefault(); };

  // ---- wiring -------------------------------------------------------------------------------
  const opts: AddEventListenerOptions = { passive: false };
  addEventListener('keydown', onKeyDown, opts);
  addEventListener('keyup', onKeyUp);
  addEventListener('blur', onBlur);
  canvas.addEventListener('click', onCanvasClick);
  addEventListener('mousedown', onMouseDown);
  addEventListener('mousemove', onMouseMove);
  document.addEventListener('pointerlockchange', onLockChange);
  addEventListener('pointerdown', onAnyPointerDown, true);
  root.addEventListener('pointerdown', onButtonDown, opts);
  canvas.addEventListener('pointerdown', onCanvasPointerDown, opts);
  addEventListener('pointermove', onPointerMove);
  addEventListener('pointerup', onPointerUp);
  addEventListener('pointercancel', onPointerUp);
  document.addEventListener('touchmove', prevent, opts); // no page scroll / pull-to-refresh
  document.addEventListener('gesturestart', prevent, opts); // iOS pinch zoom
  root.addEventListener('contextmenu', prevent);
  canvas.addEventListener('contextmenu', prevent);
  const onResize = () => { if (stick.id === -1 && enabled && touchMode) placeStickIdle(); };
  addEventListener('resize', onResize);

  return {
    get isTouch() { return touchMode; },

    poll(): InputFrame {
      const f = frame;
      if (!enabled) {
        f.move.x = f.move.y = f.lookDX = f.lookDY = 0;
        f.sprint = f.jumpPressed = f.jumpHeld = f.kickPressed = f.radarPressed = f.pausePressed = false;
        lookDX = lookDY = 0;
        jumpEdge = kickEdge = radarEdge = pauseEdge = false;
        return f;
      }
      let x = 0, y = 0;
      if (keys.has('KeyD') || keys.has('ArrowRight')) x += 1;
      if (keys.has('KeyA') || keys.has('ArrowLeft')) x -= 1;
      if (keys.has('KeyW') || keys.has('ArrowUp')) y += 1;
      if (keys.has('KeyS') || keys.has('ArrowDown')) y -= 1;
      x += stick.x; y += stick.y;
      const len = Math.hypot(x, y);
      if (len > 1) { x /= len; y /= len; }
      f.move.x = x; f.move.y = y;
      f.lookDX = lookDX; f.lookDY = lookDY;
      f.sprint = keys.has('ShiftLeft') || keys.has('ShiftRight') || btnDown.sprint !== -1 || stick.sprint;
      f.jumpPressed = jumpEdge;
      f.jumpHeld = keys.has('Space') || btnDown.jump !== -1;
      f.kickPressed = kickEdge;
      f.radarPressed = radarEdge;
      f.pausePressed = pauseEdge;
      lookDX = lookDY = 0;
      jumpEdge = kickEdge = radarEdge = pauseEdge = false;
      return f;
    },

    setEnabled(on: boolean): void {
      if (on === enabled) return;
      enabled = on;
      clearAll();
      if (!on && locked()) { releasingLock = true; document.exitPointerLock(); }
      refreshVisibility();
    },

    setSettings(s: Settings): void { cfg = s; },

    requestPointerLock(): void { if (enabled) lockPointer(); },

    dispose(): void {
      if (locked()) { releasingLock = true; document.exitPointerLock(); }
      removeEventListener('keydown', onKeyDown, opts);
      removeEventListener('keyup', onKeyUp);
      removeEventListener('blur', onBlur);
      canvas.removeEventListener('click', onCanvasClick);
      removeEventListener('mousedown', onMouseDown);
      removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('pointerlockchange', onLockChange);
      removeEventListener('pointerdown', onAnyPointerDown, true);
      canvas.removeEventListener('pointerdown', onCanvasPointerDown, opts);
      canvas.removeEventListener('contextmenu', prevent);
      removeEventListener('pointermove', onPointerMove);
      removeEventListener('pointerup', onPointerUp);
      removeEventListener('pointercancel', onPointerUp);
      document.removeEventListener('touchmove', prevent, opts);
      document.removeEventListener('gesturestart', prevent, opts);
      removeEventListener('resize', onResize);
      root.remove();
      style.remove();
    },
  };
}
