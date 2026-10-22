import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DownloadQueue, DownloadCancelledError } from '../src/models/downloader.js';
import { ICON_SVG } from '../src/client/icon-set.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('DownloadQueue (v0.5.1 capped concurrent download queue)', () => {
  it('runs up to maxConcurrent downloads in parallel and queues excess items in FIFO order', async () => {
    const q = new DownloadQueue(2);
    const resolvers = [];
    const makeTask = (id) =>
      q.enqueue(id, () => new Promise((resolve) => resolvers.push({ id, resolve })));

    const p1 = makeTask('dl-1');
    const p2 = makeTask('dl-2');
    const p3 = makeTask('dl-3');

    expect(q.getState('dl-1')).toBe('downloading');
    expect(q.getState('dl-2')).toBe('downloading');
    expect(q.getState('dl-3')).toBe('queued');
    expect(q.snapshot().activeCount).toBe(2);
    expect(q.snapshot().queuedCount).toBe(1);

    // Finish dl-1 -> dl-3 automatically starts downloading
    resolvers[0].resolve('done-1');
    expect(await p1).toBe('done-1');
    await sleep(10);
    expect(q.getState('dl-3')).toBe('downloading');
    expect(q.snapshot().activeCount).toBe(2);
    expect(q.snapshot().queuedCount).toBe(0);

    resolvers[1].resolve('done-2');
    resolvers[2].resolve('done-3');
    expect(await Promise.all([p2, p3])).toEqual(['done-2', 'done-3']);
    expect(q.snapshot().activeCount).toBe(0);
  });

  it('deduplicates concurrent enqueue calls for the same id', async () => {
    const q = new DownloadQueue(2);
    let runs = 0;
    const fn = async () => {
      runs += 1;
      await sleep(20);
      return 'ok';
    };
    const [a, b] = await Promise.all([q.enqueue('same-id', fn), q.enqueue('same-id', fn)]);
    expect(a).toBe('ok');
    expect(b).toBe('ok');
    expect(runs).toBe(1);
  });

  it('cancels a queued item immediately with DownloadCancelledError', async () => {
    const q = new DownloadQueue(1);
    let releaseFirst;
    const p1 = q.enqueue('first', () => new Promise((r) => { releaseFirst = r; }));
    const p2 = q.enqueue('second', async () => 'should-not-run');

    expect(q.getState('second')).toBe('queued');
    expect(q.cancel('second')).toBe(true);
    await expect(p2).rejects.toThrow(DownloadCancelledError);
    expect(q.getState('second')).toBeNull();

    releaseFirst('done');
    await p1;
  });

  it('cancels an active item by aborting its signal', async () => {
    const q = new DownloadQueue(2);
    const p = q.enqueue('active-item', (signal) =>
      new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new DownloadCancelledError('aborted')));
      }),
    );
    expect(q.getState('active-item')).toBe('downloading');
    expect(q.cancel('active-item')).toBe(true);
    await expect(p).rejects.toThrow(DownloadCancelledError);
  });
});

describe('v0.5.1 client bundle & icon set integrity', () => {
  it('includes all 28 scoped icons including switch.svg', () => {
    expect(Object.keys(ICON_SVG)).toHaveLength(28);
    expect(ICON_SVG.switch).toContain('osi-switch-');
    expect(ICON_SVG.mute).toContain('stroke-dashoffset:0');
    expect(ICON_SVG.unmute).toContain('opacity:1');
  });

  it('lib/client.js loads cleanly into window.__ModuleLoader__ and registers all 4 DSH UI slots', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const bundleCode = readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8');
    let loaded = null;
    const fakeWindow = {
      __ModuleLoader__: {
        load(def) {
          loaded = def;
        },
      },
    };
    const fn = new Function('window', bundleCode);
    fn(fakeWindow);
    expect(loaded).toBeTruthy();
    expect(loaded.id).toBe('dsh-osound');

    const fakeReact = {
      createElement: (type, props, ...children) => ({ type, props, children }),
      Fragment: 'Fragment',
      useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
      useEffect: () => {},
      useCallback: (cb) => cb,
      useRef: (val) => ({ current: val }),
    };
    const plugin = loaded.factory((mod) => {
      if (mod === 'react') return fakeReact;
      throw new Error('Unexpected module: ' + mod);
    });
    expect(plugin.name).toBe('dsh-osound');
    expect(plugin.inject).toEqual(['slots']);

    const registeredSlots = [];
    plugin.apply({
      slots: {
        inject: (_slotName, cb) => cb(),
        register: (meta, renderFn) => registeredSlots.push({ meta, renderFn }),
      },
      effect: () => {},
    });
    expect(registeredSlots.map((s) => s.meta.name)).toEqual([
      'conversation.input.left',
      'conversation.chat.assistant-actions',
      'conversation.session.header.utilities',
      'settings.section',
    ]);
  });
});
