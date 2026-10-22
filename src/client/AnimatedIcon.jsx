// src/client/AnimatedIcon.jsx
// An O-Sound icon from the v3 icon pack. It stays still until the pointer comes near it
// or `live` is true (a busy job: recording, transcribing, speaking, cancelled flash).
import React, { useEffect, useRef } from 'react';
import { ICON_SVG } from './icon-set.js';
import { registerIcon } from './icon-motion.js';

export function AnimatedIcon({ name, size = 16, live = false, title, style }) {
  const ref = useRef(null);
  const handle = useRef(null);

  // Register once per mounted icon; dispose on unmount (no leaked listeners).
  useEffect(() => {
    if (!ref.current) return undefined;
    const h = registerIcon(ref.current);
    handle.current = h;
    return () => {
      h.dispose();
      handle.current = null;
    };
  }, []);

  // Busy-state changes only touch the class list — no re-render, no animation reset.
  useEffect(() => {
    handle.current?.setForced(live);
  }, [live]);

  return (
    <span
      ref={ref}
      className="osound-icon"
      role={title ? 'img' : 'presentation'}
      aria-label={title}
      style={{ width: size, height: size, ...style }}
      dangerouslySetInnerHTML={{ __html: ICON_SVG[name] ?? '' }}
    />
  );
}
