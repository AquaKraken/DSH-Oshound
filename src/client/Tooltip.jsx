// src/client/Tooltip.jsx
// Replica of DSH's DEFAULT tooltip (from @deepseek-ai/dsh-client-ui-primitives
// Tooltip.module.css) so O-Sound's icon buttons match the host's own hover
// tooltips in both STYLE and POSITION: a fixed-position bubble, JS-measured to
// the anchor's right/top/bottom with an 8px gap, using DSH's own design tokens
// (tooltip background, bluish text, small radius) and the same 150ms fade-in.
//
// The plugin can't import the host's component into the browser bundle (react is
// the only external; host client-ui packages aren't resolvable client-side), so
// this re-implements it with the identical tokens. `side` mirrors the host API
// ('right' is DSH's default; 'top'/'bottom' also supported).
import React, { useCallback, useEffect, useRef, useState } from 'react';

let keyframesInjected = false;
function ensureKeyframes() {
  if (keyframesInjected || typeof document === 'undefined') return;
  keyframesInjected = true;
  const el = document.createElement('style');
  el.textContent = '@keyframes dsh-osound-tooltip-in{from{opacity:0}to{opacity:1}}';
  (document.head || document.documentElement).appendChild(el);
}

// DSH Tooltip.module.css .bubble — tokens kept, with safe fallbacks so the
// bubble degrades to a readable dark pill on any DSH build/skin missing a token.
const BUBBLE = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  position: 'fixed',
  zIndex: 100,
  width: 'max-content',
  maxWidth: '50vw',
  padding: '3px 7px',
  borderRadius: 'var(--dsw-radius-sm, 6px)',
  background: 'var(--dsw-alias-tooltip-bg, rgba(24,24,24,0.96))',
  color: 'var(--dsw-static-neutral-bluish-00, #e6e9ef)',
  fontSize: 13,
  lineHeight: '20px',
  whiteSpace: 'pre-line',
  overflowWrap: 'break-word',
  pointerEvents: 'none',
  margin: 0,
};

export function Tooltip({ label, side = 'right', delayMs = 0, children }) {
  const anchorRef = useRef(null);
  const [pos, setPos] = useState(null);
  const [show, setShow] = useState(false);
  const timer = useRef(null);

  const compute = useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const gap = 8;
    let left, top, transform;
    if (side === 'top') {
      left = r.left + r.width / 2; top = r.top - gap; transform = 'translate(-50%, -100%)';
    } else if (side === 'bottom') {
      left = r.left + r.width / 2; top = r.bottom + gap; transform = 'translateX(-50%)';
    } else {
      // 'right' — DSH default: vertically centered, to the right of the anchor.
      left = r.right + gap; top = r.top + r.height / 2; transform = 'translateY(-50%)';
    }
    setPos({ left, top, transform });
  }, [side]);

  const open = useCallback(() => {
    if (!label) return;
    ensureKeyframes();
    const run = () => { compute(); setShow(true); };
    if (delayMs > 0) timer.current = setTimeout(run, delayMs);
    else run();
  }, [label, delayMs, compute]);

  const close = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    setShow(false);
  }, []);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  // Keep the bubble tracking the anchor while open (scroll / resize / reflow).
  useEffect(() => {
    if (!show) return undefined;
    const onScroll = () => compute();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [show, compute]);

  if (!label) return children;

  return (
    <span
      ref={anchorRef}
      style={{ display: 'inline-flex' }}
      onMouseEnter={open}
      onMouseLeave={close}
      onFocus={open}
      onBlur={close}
    >
      {children}
      {show && pos ? (
        <span
          role="tooltip"
          style={{ ...BUBBLE, left: pos.left, top: pos.top, transform: pos.transform, animation: 'dsh-osound-tooltip-in 150ms ease-in-out' }}
        >
          <span style={{ minWidth: 0 }}>{label}</span>
        </span>
      ) : null}
    </span>
  );
}
