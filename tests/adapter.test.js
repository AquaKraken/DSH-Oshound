import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { apply, inject, name } from '../src/dsh/adapter.js';

/**
 * Mock ctx shaped like the REAL DSH plugin API (verified from the installed
 * dsh-done-sound / dsh-evolve plugins):
 *   - ctx.logger: plain object with info/warn/error
 *   - ctx.settings.register(ns, schema, {base}) -> scope { get, update }
 *   - ctx.inject(['webServer'], (webCtx) => ...) with webServer.register/effect
 *   - ctx.effect(fn) runs fn and keeps the teardown
 */
function makeMockCtx() {
  const logs = { info: [], warn: [], error: [] };
  const settingsState = new Map();
  const registered = [];
  const routes = [];
  const logger = {
    info: (m) => logs.info.push(m),
    warn: (m) => logs.warn.push(m),
    error: (m) => logs.error.push(m),
  };
  return {
    logs,
    registered,
    routes,
    settingsState,
    ctx: {
      effect: (fn) => fn(),
      logger,
      settings: {
        register: (ns, schema, opts = {}) => {
          registered.push({ ns, opts });
          return {
            get: () => settingsState.get(ns),
            update: async (patch) => {
              // Mirrors the REAL dsh-settings update(): merge the patch into the
              // persisted user layer (confirmed from @deepseek-ai/dsh-settings source).
              settingsState.set(ns, { ...(settingsState.get(ns) ?? opts.base ?? {}), ...patch });
            },
          };
        },
      },
      inject: (serviceNames, fn) => {
        registered.push({ injected: serviceNames });
        fn({
          webServer: {
            register: (route) => {
              routes.push(route);
              return () => {};
            },
            effect: () => {},
          },
          effect: () => {},
        });
      },
    },
  };
}

/**
 * Invoke the plugin's registered HTTP handler the way DSH's webServer would:
 * real req (a Readable stream carrying the JSON body) + a minimal res.
 * `url` is the full request URL (pathname under /dsh-osound/api).
 */
function invokeRoute(routes, method, url, body) {
  const route = routes.find((r) => r.kind === 'prefix' && r.path === '/dsh-osound/api');
  if (typeof route?.handler !== 'function') throw new Error('no /dsh-osound/api route registered');
  return new Promise((resolve, reject) => {
    const req = new Readable({ read() {} });
    req.method = method;
    req.url = url;
    const res = {
      statusCode: null,
      body: '',
      writeHead(code) {
        this.statusCode = code;
      },
      end(chunk) {
        if (chunk) this.body += Buffer.from(chunk).toString('utf8');
        resolve({ statusCode: this.statusCode, body: this.body });
      },
    };
    Promise.resolve(route.handler(req, res)).catch(reject);
    if (body !== undefined) req.push(Buffer.from(JSON.stringify(body)));
    req.push(null);
  });
}

describe('adapter.apply()', () => {
  let unhandled;
  let tmpHome;
  let savedHome;
  let savedUserProfile;
  const onUnhandled = (err) => { unhandled = err; };

  beforeEach(async () => {
    // apply() resolves %USERPROFILE%/.dsh (or $HOME on non-Windows) and will
    // fire a real network fetch for the Piper catalogue plus write a cache
    // file there. Point it at a throwaway temp dir so these tests don't
    // touch the real home directory or depend on network being reachable.
    tmpHome = await mkdtemp(path.join(tmpdir(), 'osound-adapter-test-'));
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
  });

  afterEach(async () => {
    process.removeListener('unhandledRejection', onUnhandled);
    process.env.HOME = savedHome;
    process.env.USERPROFILE = savedUserProfile;
    await rm(tmpHome, { recursive: true, force: true });
  });

  it(
    'never produces an unhandled promise rejection, even with an invalid whisperModel id ' +
      '(regression: sanitizeConfig used to let an unknown-but-well-typed model id through, ' +
      'which made ModelManager.getModel() throw inside a fire-and-forget diagnostics call with no .catch())',
    async () => {
      unhandled = undefined;
      process.on('unhandledRejection', onUnhandled);

      const { ctx, logs } = makeMockCtx();
      await apply(ctx, { whisperModel: 'not-a-real-model-id' });

      await new Promise((r) => setTimeout(r, 150));

      expect(unhandled).toBeUndefined();
      // The invalid value should still be visibly rejected via sanitizeConfig...
      expect(logs.warn.some((m) => m.includes('whisperModel'))).toBe(true);
      // ...and the config actually used should have fallen back to the real default model,
      // so the diagnostics call below succeeds instead of needing its own catch to fire.
      expect(logs.error.some((m) => m.includes('diagnostics failed'))).toBe(false);
    },
  );

  it('does not crash when passed no config at all', async () => {
    unhandled = undefined;
    process.on('unhandledRejection', onUnhandled);

    const { ctx } = makeMockCtx();
    await apply(ctx);

    await new Promise((r) => setTimeout(r, 150));
    expect(unhandled).toBeUndefined();
  });

  it('does not crash when settings/inject are entirely absent from ctx (older or minimal host)', async () => {
    unhandled = undefined;
    process.on('unhandledRejection', onUnhandled);

    const logs = { info: [], warn: [], error: [] };
    const bareCtx = {
      effect: (fn) => fn(),
      logger: {
        info: (m) => logs.info.push(m),
        warn: (m) => logs.warn.push(m),
        error: (m) => logs.error.push(m),
      },
      // no webui, no settings, no inject
    };
    await apply(bareCtx, {});

    await new Promise((r) => setTimeout(r, 150));
    expect(unhandled).toBeUndefined();
  });

  it('registers the settings namespace, declares its inject array, and wires webServer', async () => {
    const mock = makeMockCtx();
    await apply(mock.ctx);

    expect(name).toBe('dsh-osound');
    expect(inject).toEqual(['settings', 'webServer']);
    expect(mock.registered.some((r) => r.ns === 'dsh-osound')).toBe(true);
    expect(mock.registered.some((r) => r.injected && r.injected.includes('webServer'))).toBe(true);
  });

  it('partial /config update preserves unrelated persisted fields ' +
    '(regression: setConfig used to send a DEFAULT_CONFIG-based full object to settings.update() — ' +
    'a POST /config {"ttsSpeed":1.15} wiped the persisted piperVoiceKey back to "" because the ' +
    'reconstructed object carried the default, not the real current value)', async () => {
    const mock = makeMockCtx();
    await apply(mock.ctx);

    // 1. Persist a voice selection, exactly like the real UI does when the
    //    user picks a voice (a few related fields arrive together).
    let r = await invokeRoute(mock.routes, 'POST', '/dsh-osound/api/config', {
      piperLanguageCode: 'en',
      piperLocale: 'en_US',
      piperVoiceKey: 'en_US-lessac-medium',
      piperQuality: 'medium',
    });
    expect(r.statusCode).toBe(200);
    let parsed = JSON.parse(r.body);
    expect(parsed.ok).toBe(true);
    expect(parsed.config.piperVoiceKey).toBe('en_US-lessac-medium');

    // 2. The exact bug-exposing sequence: an unrelated partial patch.
    r = await invokeRoute(mock.routes, 'POST', '/dsh-osound/api/config', { ttsSpeed: 1.15 });
    expect(r.statusCode).toBe(200);
    parsed = JSON.parse(r.body);
    expect(parsed.ok).toBe(true);
    expect(parsed.config.ttsSpeed).toBe(1.15);
    // The regression: the voice selection must survive an unrelated partial save.
    expect(parsed.config.piperVoiceKey).toBe('en_US-lessac-medium');

    // 3. The persisted user layer agrees — and only received the patched keys.
    const persisted = mock.settingsState.get('dsh-osound');
    expect(persisted.ttsSpeed).toBe(1.15);
    expect(persisted.piperVoiceKey).toBe('en_US-lessac-medium');

    // 4. GET /config (the endpoint the bug was first spotted through) agrees.
    r = await invokeRoute(mock.routes, 'GET', '/dsh-osound/api/config');
    expect(r.statusCode).toBe(200);
    parsed = JSON.parse(r.body);
    expect(parsed.config.piperVoiceKey).toBe('en_US-lessac-medium');
    expect(parsed.config.ttsSpeed).toBe(1.15);
  });

  it('whisper model API offers only the f16 models and rejects removed quantized ids with 400 ' +
    '(regression: quantized variants were downloadable but the bundled Const-me Whisper runtime — ' +
    'F16/F32 only — could never load them, so they were removed from the registry)', async () => {
    const mock = makeMockCtx();
    await apply(mock.ctx);

    let r = await invokeRoute(mock.routes, 'GET', '/dsh-osound/api/models/whisper');
    expect(r.statusCode).toBe(200);
    let parsed = JSON.parse(r.body);
    expect(parsed.ok).toBe(true);
    expect(parsed.models.map((m) => m.id)).toEqual(['tiny', 'base', 'small', 'medium', 'large']);

    r = await invokeRoute(mock.routes, 'POST', '/dsh-osound/api/models/whisper/download', { id: 'tiny-q5' });
    expect(r.statusCode).toBe(400);
    parsed = JSON.parse(r.body);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('tiny-q5');
  });

  it('POST /tts/control {action:"stopAll"} stops every job without a jobId ' +
    '(the mic uses this before recording when stopSpeechOnRecording is on)', async () => {
    const mock = makeMockCtx();
    await apply(mock.ctx); // temp HOME: no Piper runtime -> jobs fail fast and park at 'error'

    let r = await invokeRoute(mock.routes, 'POST', '/dsh-osound/api/tts', { text: 'first job' });
    expect(r.statusCode).toBe(200);
    const id1 = JSON.parse(r.body).jobId;
    r = await invokeRoute(mock.routes, 'POST', '/dsh-osound/api/tts', { text: 'second job' });
    expect(r.statusCode).toBe(200);
    const id2 = JSON.parse(r.body).jobId;
    expect(id1).not.toBe(id2);

    r = await invokeRoute(mock.routes, 'POST', '/dsh-osound/api/tts/control', { action: 'stopAll' });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).ok).toBe(true);

    // Both jobs are gone from the queue immediately after stopAll.
    const s = await invokeRoute(mock.routes, 'GET', '/dsh-osound/api/status');
    const jobs = JSON.parse(s.body).ttsJobs;
    expect(jobs.some((j) => j.id === id1)).toBe(false);
    expect(jobs.some((j) => j.id === id2)).toBe(false);

    // And the old contract is intact: a jobId action without a valid pair is still rejected.
    r = await invokeRoute(mock.routes, 'POST', '/dsh-osound/api/tts/control', { action: 'pause' });
    expect(r.statusCode).toBe(400);
  });

  it('GET /tts/chunk surfaces a failed job as a real HTTP error with the stored message ' +
    '(regression: with Piper missing, POST /tts returned 200+jobId, the job failed and was removed ' +
    'before the client could poll, and the client only ever saw a silent "job gone" 204 — ' +
    'missing-Piper silent failure, 2026-09-19)', async () => {
    const mock = makeMockCtx();
    await apply(mock.ctx); // temp HOME: no Piper runtime installed here, so speak() fails fast

    let r = await invokeRoute(mock.routes, 'POST', '/dsh-osound/api/tts', { text: 'hello world' });
    expect(r.statusCode).toBe(200);
    const { jobId } = JSON.parse(r.body);
    expect(jobId).toBeTruthy();

    // Wait (polling) until drain() has hit the missing Piper and parked the job in error state.
    let sawError = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 3000) {
      const s = await invokeRoute(mock.routes, 'GET', '/dsh-osound/api/status');
      const j = JSON.parse(s.body).ttsJobs.find((x) => x.id === jobId);
      if (j && j.state === 'error') {
        sawError = true;
        break;
      }
      await new Promise((res) => setTimeout(res, 50));
    }
    expect(sawError).toBe(true); // job preserved at state 'error' (not removed immediately)

    // The chunk route returns a genuine error (non-204/203) carrying the stored message —
    // the shape the client's existing non-OK branch in src/client/player.js renders.
    r = await invokeRoute(mock.routes, 'GET', `/dsh-osound/api/tts/chunk?jobId=${jobId}`);
    expect(r.statusCode).toBe(502);
    const parsed = JSON.parse(r.body);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('Piper runtime is not installed');
  });
});
