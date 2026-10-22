// Tests for client/icon-scope.js and client/icon-proximity.js (pure parts of the animated icons).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { scopeIconSvg } from '../src/client/icon-scope.js';
import { nearState, distanceToRect, isIconLive, NEAR_ENTER_PX, NEAR_LEAVE_PX } from '../src/client/icon-proximity.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const iconDir = path.join(here, '..', 'src', 'client', 'icons');
const load = (f) => readFileSync(path.join(iconDir, f), 'utf8');

describe('scopeIconSvg', () => {
  it('prefixes every class and keyframe, in markup and in the <style> block', () => {
    const out = scopeIconSvg(load('mic-idle.svg'), 'mic');
    expect(out).toContain('class="osi-mic-sa"');
    expect(out).toContain('.osi-mic-sa{animation:osi-mic-sonar-a 1.1s');
    expect(out).toContain('@keyframes osi-mic-sonar-a');
    expect(out).toContain('.osi-mic-sb{animation:osi-mic-sonar-b 1.1s .3s');
  });

  it('leaves no bare global class selector or keyframe name behind', () => {
    for (const f of ['mic-idle.svg', 'processing-stt.svg', 'play.svg', 'stop.svg', 'warning.svg']) {
      const out = scopeIconSvg(load(f), 'k');
      const style = out.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
      // every selector in the style must be scoped
      for (const sel of style.matchAll(/\.([\w-]+)\s*\{/g)) expect(sel[1].startsWith('osi-k-')).toBe(true);
      for (const kf of style.matchAll(/@keyframes\s+([\w-]+)/g)) expect(kf[1].startsWith('osi-k-')).toBe(true);
    }
  });

  it('does not touch numeric values that look like class selectors (e.g. scale(.82))', () => {
    const out = scopeIconSvg(load('stop.svg'), 'stop');
    expect(out).toContain('scale(.82)');
    expect(out).toContain('.osi-stop-sq{animation:osi-stop-sq-breath');
  });

  it('keeps the markup otherwise identical (same element count and paths)', () => {
    const src = load('processing-stt.svg');
    const out = scopeIconSvg(src, 'processing');
    expect((out.match(/<circle/g) ?? []).length).toBe((src.match(/<circle/g) ?? []).length);
    expect(out).toContain('stroke-dasharray="28 47"');
  });

  it('rejects an unsafe key', () => {
    expect(() => scopeIconSvg('<svg/>', 'bad key')).toThrow();
  });
});

describe('icon proximity', () => {
  it('enters inside the near radius and leaves only beyond the wider exit radius (hysteresis)', () => {
    expect(nearState(false, NEAR_ENTER_PX)).toBe(true);
    expect(nearState(false, NEAR_ENTER_PX + 1)).toBe(false);
    expect(nearState(true, NEAR_ENTER_PX + 10)).toBe(true); // still near: no flicker
    expect(nearState(true, NEAR_LEAVE_PX + 1)).toBe(false);
  });

  it('treats a non-finite distance (hidden / not laid out) as not near', () => {
    expect(nearState(true, Infinity)).toBe(false);
    expect(nearState(false, NaN)).toBe(false);
  });

  it('measures distance to the box edge, zero inside', () => {
    const r = { left: 100, top: 100, right: 120, bottom: 120 };
    expect(distanceToRect(r, 110, 110)).toBe(0);
    expect(distanceToRect(r, 90, 110)).toBe(10);
    expect(distanceToRect(r, 123, 124)).toBe(5);
  });

  it('animates when near OR forced by a busy job', () => {
    expect(isIconLive(false, false)).toBe(false);
    expect(isIconLive(true, false)).toBe(true);
    expect(isIconLive(false, true)).toBe(true);
  });
});
