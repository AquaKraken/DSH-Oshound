// src/client/icon-motion.js
// DOM side of the animated icons. One shared pointer listener (not one per icon) tells
// each registered icon whether the pointer is near it; a busy job can force it live.
// Lifecycle follows the plugin-builder rule: every listener added in attach() is removed
// in detach(), and detach() runs when the last icon unregisters — nothing is left behind.
import { nearState, distanceToRect, isIconLive } from './icon-proximity.js';
import { ensureOsoundStyles } from './styles.js';

const LIVE = 'osound-live';
const entries = new Set(); // { el, near, forced }
let pointer = null;
let frame = 0;
let attached = false;

const schedule = (fn) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 16));
const cancel = (id) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id));

function paint(e) {
  e.el.classList.toggle(LIVE, isIconLive(e.near, e.forced));
}

function flush() {
  frame = 0;
  for (const e of entries) {
    if (!e.el.isConnected) continue;
    const d = pointer ? distanceToRect(e.el.getBoundingClientRect(), pointer.x, pointer.y) : Infinity;
    const near = nearState(e.near, d);
    if (near !== e.near) {
      e.near = near;
      paint(e);
    }
  }
}

function queue() {
  if (!frame) frame = schedule(flush);
}

const onMove = (ev) => {
  pointer = { x: ev.clientX, y: ev.clientY };
  queue();
};
const onGone = () => {
  pointer = null;
  queue();
};

function attach() {
  if (attached || typeof window === 'undefined' || typeof document === 'undefined') return;
  attached = true;
  window.addEventListener('pointermove', onMove, { passive: true });
  document.documentElement.addEventListener('pointerleave', onGone);
  window.addEventListener('blur', onGone);
}

function detach() {
  if (!attached) return;
  attached = false;
  window.removeEventListener('pointermove', onMove);
  document.documentElement.removeEventListener('pointerleave', onGone);
  window.removeEventListener('blur', onGone);
  if (frame) {
    cancel(frame);
    frame = 0;
  }
  pointer = null;
}

/**
 * Registers one icon element. Returns handle: setForced(bool) and dispose().
 * @param {HTMLElement} el
 */
export function registerIcon(el) {
  ensureOsoundStyles();
  const initialNear =
    pointer && el && typeof el.getBoundingClientRect === 'function'
      ? nearState(false, distanceToRect(el.getBoundingClientRect(), pointer.x, pointer.y))
      : false;
  const e = { el, near: initialNear, forced: false };
  entries.add(e);
  attach();
  paint(e);
  return {
    setForced(on) {
      const v = Boolean(on);
      if (e.forced !== v) {
        e.forced = v;
        paint(e);
      }
    },
    dispose() {
      entries.delete(e);
      el.classList.remove(LIVE);
      if (entries.size === 0) detach();
    },
  };
}

/** Test/diagnostic hook: how many icons are currently registered. */
export function registeredIconCount() {
  return entries.size;
}
