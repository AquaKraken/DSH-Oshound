// src/client/icon-scope.js
// Namespaces one animated SVG icon so its inline <style> block cannot leak into
// DSH's own CSS. The icon pack defines bare global classes (.sa, .arc, .pr, .sq) and
// keyframe names (sonar-a, spin-bg, …); inline SVG <style> is document-wide, so two
// icons (or an icon and DSH) could clash. Every class and keyframe is rewritten to
// `osi-<key>-<name>`. Pure string transform — used at build time (scripts/build-icons.mjs).

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param {string} svg - raw SVG markup from the icon pack
 * @param {string} key - unique icon key (e.g. 'mic'); becomes part of every new name
 * @returns {string} SVG with scoped classes and keyframe names
 */
export function scopeIconSvg(svg, key) {
  if (!/^[A-Za-z][\w]*$/.test(key)) throw new Error(`scopeIconSvg: invalid key "${key}"`);
  const prefix = `osi-${key}-`;

  const classes = new Set();
  for (const m of svg.matchAll(/class="([^"]+)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c) classes.add(c);
  }
  const keyframes = new Set([...svg.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]));

  const out = svg.replace(/<style>([\s\S]*?)<\/style>/g, (_, css) => {
    let c = css;
    for (const k of keyframes) {
      c = c.replace(new RegExp(`@keyframes\\s+${esc(k)}(?![\\w-])`, 'g'), `@keyframes ${prefix}${k}`);
      c = c.replace(/animation:[^;}]*/g, (decl) =>
        decl.replace(new RegExp(`(^|[\\s,:])${esc(k)}(?![\\w-])`, 'g'), `$1${prefix}${k}`),
      );
    }
    for (const cl of classes) {
      c = c.replace(new RegExp(`\\.${esc(cl)}(?![\\w-])`, 'g'), `.${prefix}${cl}`);
    }
    return `<style>${c}</style>`;
  });

  return out.replace(/class="([^"]+)"/g, (_, list) =>
    `class="${list.split(/\s+/).filter(Boolean).map((c) => prefix + c).join(' ')}"`,
  );
}
