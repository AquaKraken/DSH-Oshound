// src/client/styles.js
// The plugin's own stylesheet, injected once. Kept tiny on purpose.
//  * Icons are still until they "play": a non-live icon has its animations switched off.
//    Live = pointer near/above it, or its job is busy (see icon-motion.js).
//  * The composer mic has NO border, outline or box-shadow, even when DSH's global button
//    or focus styles try to add one. Keyboard focus is shown as a soft background tint
//    instead of a border.
//  * SwitchToggle uses Switch.svg geometry with smooth knob & track transitions.
const STYLE_ID = 'osound-styles';
const CSS = `
.osound-icon{display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;overflow:visible;line-height:0;vertical-align:middle}
.osound-icon>svg{width:100%;height:100%;display:block;overflow:visible}
.osound-icon:not(.osound-live) [class*="osi-"]{animation:none !important}
.osound-mic-btn,.osound-mic-btn:hover,.osound-mic-btn:active,.osound-mic-btn:focus,.osound-mic-btn:focus-visible{border:0 !important;outline:0 !important;box-shadow:none !important;-webkit-appearance:none;appearance:none}
.osound-mic-btn:focus-visible{background:rgba(128,128,128,0.16) !important}
.osound-switch-btn{display:inline-flex;align-items:center;gap:8px;background:transparent;border:none;outline:none;padding:2px 0;color:inherit;cursor:pointer;font-size:12px;user-select:none;text-align:left}
.osound-switch-btn:disabled{opacity:0.5;cursor:default}
.osound-switch-svg{width:28px;height:20px;flex-shrink:0;overflow:visible;display:block;transition:color 160ms ease}
.osound-switch-svg .osound-sw-track{fill:currentColor;opacity:0;transition:opacity 180ms ease}
.osound-switch-svg .osound-sw-knob{transform:translateX(0);transition:transform 180ms cubic-bezier(.4,0,.2,1)}
.osound-switch-btn[aria-checked="true"] .osound-switch-svg{color:var(--dsw-alias-state-success-primary, #4caf7d)}
.osound-switch-btn[aria-checked="true"] .osound-switch-svg .osound-sw-track{opacity:0.24}
.osound-switch-btn[aria-checked="true"] .osound-switch-svg .osound-sw-knob{transform:translateX(9px)}
.osound-switch-btn:hover .osound-switch-svg .osound-sw-border{stroke-width:2}
`;

export function ensureOsoundStyles() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  (document.head || document.documentElement).appendChild(el);
}

export const OSOUND_CSS = CSS; // exported for tests
