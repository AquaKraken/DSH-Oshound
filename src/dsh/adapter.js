// src/dsh/adapter.js
// DSH host entry — RESOLVED against the live DSH plugin API (2026-09-13),
// verified from the installed reference plugins (dsh-done-sound, dsh-evolve)
// in the web profile rather than guessed.

import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';

import { OSoundConfigSchema, DEFAULT_CONFIG, sanitizeConfig } from '../host/config.js';
import { VoiceService, WhisperNotReadyError, PiperNotReadyError } from '../host/voice-service.js';
import { RuntimeManager } from '../host/runtime-manager.js';
import { ModelManager } from '../host/model-manager.js';
import { sweepStaleTempFiles } from '../host/temp-sweep.js';
import { PiperCatalogue } from '../models/piper-catalogue.js';
import { downloadFile, DownloadQueue, filesExist, DEFAULT_MAX_CONCURRENT_DOWNLOADS } from '../models/downloader.js';
import { buildDiagnosticsReport } from '../host/diagnostics.js';
import { PLUGIN_ID, PLUGIN_NAME, PATHS } from '../shared/constants.js';
import { assertSafeId, ValidationError } from '../shared/validation.js';

export const name = PLUGIN_ID;
export const inject = ['settings', 'webServer'];
export const Config = OSoundConfigSchema;

const API_PREFIX = `/${PLUGIN_ID}/api`;
const SETTINGS_NAMESPACE = PLUGIN_ID;
const STT_MAX_BYTES = 32 * 1024 * 1024; // ~17 min of 16 kHz mono PCM16

/**
 * Bounded, sequence-based hand-off between the host's TTS loop and the
 * browser's playback (2026-10-05 rewrite of the old single-slot version).
 */
export class ChunkHandoff {
  constructor(hasJob, ackTimeoutMs = 60_000, onAbandon = null, maxAhead = 2) {
    this.hasJob = hasJob;
    this.ackTimeoutMs = ackTimeoutMs;
    this.onAbandon = onAbandon;
    this.maxAhead = Math.max(1, maxAhead);
    /** @type {Map<string, {queue: object[], nextSeq: number, waiters: Set<() => void>, slotWaiters: Set<() => void>, aborted: boolean}>} */
    this.jobs = new Map();
    /** First unacked chunk of any job (backward-compatible accessor). */
    this.current = null;
  }

  _jobState(jobId) {
    let s = this.jobs.get(jobId);
    if (!s) {
      s = { queue: [], nextSeq: 0, waiters: new Set(), slotWaiters: new Set(), aborted: false };
      this.jobs.set(jobId, s);
    }
    return s;
  }

  _undelivered(s) {
    return s.queue.find((c) => !c.delivered) ?? null;
  }

  _anyUnacked() {
    for (const s of this.jobs.values()) {
      const c = s.queue.find((x) => !x.acked);
      if (c) return c;
    }
    return null;
  }

  _dropIfIdle(jobId) {
    const s = this.jobs.get(jobId);
    if (s && s.queue.length === 0 && s.waiters.size === 0 && s.slotWaiters.size === 0 && !this.hasJob(jobId)) {
      this.jobs.delete(jobId);
    }
  }

  publish(jobId, wavPath) {
    const s = this._jobState(jobId);
    if (s.aborted) return Promise.resolve();
    const pushChunk = () => {
      const chunk = { jobId, seq: s.nextSeq++, wavPath, delivered: false, acked: false, ack: null, timer: null };
      const ackPromise = new Promise((resolve) => {
        chunk.ack = resolve;
      });
      s.queue.push(chunk);
      this.current = chunk;
      chunk.timer = setTimeout(() => {
        if (s.aborted || chunk.acked) return;
        try {
          this.onAbandon?.(jobId);
        } catch {
          /* swallow: watchdog path stays functional */
        }
        this._settle(jobId, chunk);
      }, this.ackTimeoutMs);
      chunk.timer.unref?.();
      this._notify(jobId);
      return ackPromise;
    };
    if (s.queue.length < this.maxAhead) return pushChunk();
    return new Promise((resolve) => s.slotWaiters.add(resolve)).then(() =>
      s.aborted ? undefined : pushChunk(),
    );
  }

  waitForChunk(jobId, timeoutMs = 20000) {
    const s = this.jobs.get(jobId);
    const chunk = s ? this._undelivered(s) : null;
    if (chunk) {
      chunk.delivered = true;
      return Promise.resolve({ chunk: { jobId, ...chunk } });
    }
    if (!this.hasJob(jobId)) {
      return Promise.resolve({ gone: true });
    }
    const st = this._jobState(jobId);
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => settle(() => resolve({ timeout: true })), timeoutMs);
      timer.unref?.();
      const settle = (fn) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const js = this.jobs.get(jobId);
        if (js) js.waiters.delete(waiter);
        fn();
      };
      const waiter = () => {
        const js = this.jobs.get(jobId);
        const c = js ? this._undelivered(js) : null;
        if (c) {
          c.delivered = true;
          settle(() => resolve({ chunk: { jobId, ...c } }));
          return;
        }
        if (!this.hasJob(jobId)) {
          if (js && js.queue.length > 0) this.abort(jobId);
          settle(() => resolve({ gone: true }));
          return;
        }
      };
      st.waiters.add(waiter);
      waiter();
    });
  }

  ack(jobId) {
    const s = this.jobs.get(jobId);
    if (!s) return;
    const chunk = s.queue.find((c) => !c.acked);
    if (chunk) this._settle(jobId, chunk);
  }

  release(jobId) {
    const s = this.jobs.get(jobId);
    if (!s) return;
    const chunk = s.queue.find((c) => !c.acked);
    if (chunk) this._settle(jobId, chunk);
  }

  abort(jobId) {
    const s = this.jobs.get(jobId);
    if (!s) return;
    s.aborted = true;
    for (const chunk of s.queue) {
      if (chunk.timer) clearTimeout(chunk.timer);
      chunk.acked = true;
      chunk.ack?.();
    }
    s.queue = [];
    for (const w of [...s.slotWaiters]) {
      s.slotWaiters.delete(w);
      w();
    }
    this.current = this._anyUnacked();
    this._notify(jobId);
    this.jobs.delete(jobId);
  }

  abortAll() {
    for (const jobId of [...this.jobs.keys()]) this.abort(jobId);
    this.current = null;
  }

  _settle(jobId, chunk) {
    const s = this.jobs.get(jobId);
    if (!s || chunk.acked) return;
    chunk.acked = true;
    if (chunk.timer) clearTimeout(chunk.timer);
    const i = s.queue.indexOf(chunk);
    if (i !== -1) s.queue.splice(i, 1);
    if (this.current === chunk) this.current = this._anyUnacked();
    const slotW = s.slotWaiters.values().next().value;
    if (slotW) {
      s.slotWaiters.delete(slotW);
      slotW();
    }
    chunk.ack?.();
    this._notify(jobId);
    this._dropIfIdle(jobId);
  }

  notify() {
    for (const jobId of [...this.jobs.keys()]) this._notify(jobId);
  }

  _notify(jobId) {
    const s = this.jobs.get(jobId);
    if (!s) return;
    for (const w of [...s.waiters]) w();
  }
}

/** @returns {Promise<Buffer>} raw request body (size-capped). */
function readBodyBuffer(req, maxBytes = STT_MAX_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new ValidationError(`Request body too large (>${maxBytes} bytes)`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** @returns {Promise<object>} JSON request body. */
async function readJson(req) {
  const buf = await readBodyBuffer(req);
  if (buf.length === 0) return {};
  return JSON.parse(buf.toString('utf8'));
}

export async function apply(ctx, entryConfig = {}) {
  const rawLogger = ctx.logger;
  const logger =
    typeof rawLogger === 'function'
      ? rawLogger.call(ctx, PLUGIN_ID)
      : rawLogger ?? { info: () => {}, warn: () => {}, error: () => {} };
  const log = {
    info: (m) => logger.info?.(`[${PLUGIN_NAME}] ${m}`),
    warn: (m) => logger.warn?.(`[${PLUGIN_NAME}] ${m}`),
    error: (m) => logger.error?.(`[${PLUGIN_NAME}] ${m}`),
  };

  const dshHome = path.join(os.homedir(), '.dsh');
  const piperVoicesDir = path.join(dshHome, PATHS.piperVoices);
  const voiceTempDir = path.join(dshHome, PATHS.voiceTemp);
  await mkdir(voiceTempDir, { recursive: true });
  await mkdir(piperVoicesDir, { recursive: true });

  // --- Config -----------------------------------------------------------------
  const entrySanitized = sanitizeConfig(entryConfig ?? {});
  for (const e of entrySanitized.errors) log.warn(`config: dropping invalid entry value — ${e}`);

  let memoryConfig = { ...DEFAULT_CONFIG, ...entrySanitized.config };
  let configScope = null;
  if (typeof ctx.settings?.register === 'function') {
    configScope = ctx.settings.register(SETTINGS_NAMESPACE, OSoundConfigSchema, { base: entrySanitized.config });
  }

  const getConfig = () => {
    if (configScope) {
      try {
        const resolved = configScope.get();
        if (resolved) {
          const s = sanitizeConfig(resolved);
          memoryConfig = s.config;
          return s.config;
        }
      } catch (err) {
        log.warn(`settings.get failed, using in-memory config: ${err?.message ?? err}`);
      }
    }
    return memoryConfig;
  };

  const setConfig = async (patch) => {
    const candidate = { ...getConfig(), ...patch };
    const s = sanitizeConfig(candidate);
    for (const e of s.errors) log.warn(`config: dropping invalid value — ${e}`);
    const updatePatch = {};
    for (const key of Object.keys(patch)) {
      if (Object.prototype.hasOwnProperty.call(s.config, key)) updatePatch[key] = s.config[key];
    }
    memoryConfig = s.config;
    if (configScope && Object.keys(updatePatch).length > 0) {
      await configScope.update(updatePatch).catch((err) => log.warn(`settings.update failed: ${err?.message ?? err}`));
    }
    return { config: memoryConfig, errors: s.errors };
  };

  // --- Shared Capped Download Queue & Managers ---------------------------------
  const downloadQueue = new DownloadQueue(DEFAULT_MAX_CONCURRENT_DOWNLOADS);
  const runtimeManager = new RuntimeManager(RuntimeManager.defaultPaths(dshHome), downloadQueue);
  const modelManager = new ModelManager(path.join(dshHome, PATHS.whisperModels), downloadQueue);

  const catalogueCachePath = path.join(dshHome, PATHS.piperCatalogueCache);
  const piperCatalogue = new PiperCatalogue({
    fetchJson: async () => {
      const res = await fetch(PiperCatalogue.VOICES_JSON_URL, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`Catalogue fetch failed: HTTP ${res.status}`);
      return res.json();
    },
    loadCache: async () => {
      try {
        return JSON.parse(await readFile(catalogueCachePath, 'utf8'));
      } catch {
        return null;
      }
    },
    saveCache: async (voices) => {
      await mkdir(path.dirname(catalogueCachePath), { recursive: true });
      await writeFile(catalogueCachePath, JSON.stringify(voices));
    },
  });

  // --- TTS chunk hand-off -------------------------------------------------------
  let ttsQueueRef = null;
  const handoff = new ChunkHandoff(
    (jobId) => ttsQueueRef?.list().some((j) => j.id === jobId && j.state !== 'error') ?? false,
    60_000,
    (jobId) => {
      log.warn(`[TTS] job=${jobId} abandoned: no client ack within 60s (tab closed or connection lost)`);
      ttsQueueRef?.abandon(jobId, 'Playback abandoned: the client did not confirm the chunk within 60s (tab closed or connection lost).');
    },
  );

  const playWav = async (wavPath, signal, jobId) => {
    const acked = handoff.publish(jobId, wavPath);
    await new Promise((resolve) => {
      const onAbort = () => {
        handoff.release(jobId);
        resolve();
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      acked.then(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      });
    });
  };

  const voiceService = new VoiceService({
    runtimeManager,
    modelManager,
    piperCatalogue,
    piperVoicesDir,
    voiceTempDir,
    getConfig,
    playWav,
    log: (line) => log.info(line),
  });
  ttsQueueRef = voiceService.ttsQueue;
  voiceService.ttsQueue.onChange(() => handoff.notify());

  /** @param {string} jobId @returns {import('../shared/types.js').TtsQueueJob | undefined} */
  const findFailedJob = (jobId) =>
    voiceService.ttsQueue.list().find((j) => j.id === jobId && j.state === 'error');

  // --- Piper voice helpers --------------------------------------------------------
  const voiceFiles = (key) => {
    const dir = path.join(piperVoicesDir, key);
    return [path.join(dir, `${key}.onnx`), path.join(dir, `${key}.onnx.json`)];
  };

  const voiceInstalled = async (key) => filesExist(voiceFiles(key));

  const listInstalledVoiceKeys = async () => {
    let entries;
    try {
      entries = await readdir(piperVoicesDir);
    } catch {
      return [];
    }
    const keys = [];
    for (const name of entries) {
      if (await voiceInstalled(name)) keys.push(name);
    }
    return keys.sort();
  };

  const getVoiceDownloadState = (key) => downloadQueue.getState(`piper-voice:${key}`);

  const downloadVoice = async (key) => {
    assertSafeId(key, 'piper voice');
    const voice = piperCatalogue.getVoice(key);
    if (!voice) throw new ValidationError(`Unknown piper voice key: ${key}`);
    const dir = path.join(piperVoicesDir, key);
    return downloadQueue.enqueue(`piper-voice:${key}`, async (signal, reportProgress) => {
      for (const [url, filename] of [
        [voice.onnxUrl, `${key}.onnx`],
        [voice.onnxConfigUrl, `${key}.onnx.json`],
      ]) {
        await downloadFile({
          id: `voice-${key}`,
          url,
          destDir: dir,
          destFilename: filename,
          signal,
          onProgress: reportProgress,
        });
      }
    });
  };

  const cancelVoiceDownload = (key) => {
    assertSafeId(key, 'piper voice');
    return downloadQueue.cancel(`piper-voice:${key}`);
  };

  // --- Diagnostics -----------------------------------------------------------------
  const diagnostics = async (micProbe, outProbe) =>
    buildDiagnosticsReport({
      runtimeManager,
      modelManager,
      piperCatalogue,
      piperVoicesDir,
      config: getConfig(),
      microphoneAvailable: async () => micProbe === true,
      audioOutputAvailable: async () => outProbe === true,
    });

  // --- HTTP routes --------------------------------------------------------------------
  const sendJson = (res, code, payload) => {
    const body = JSON.stringify(payload);
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  };
  const sendError = (res, code, err) => sendJson(res, code, { ok: false, error: err instanceof Error ? err.message : String(err) });

  const statusPayload = async () => {
    const config = getConfig();
    const [whisper, piper, whisperModel] = await Promise.all([
      runtimeManager.checkWhisper(),
      runtimeManager.checkPiper(),
      modelManager.isInstalled(config.whisperModel).catch(() => 'error'),
    ]);
    return {
      ok: true,
      name: PLUGIN_NAME,
      id: PLUGIN_ID,
      runtimes: {
        whisper: whisper.state,
        piper: piper.state,
        whisperMissing: whisper.missing,
        piperMissing: piper.missing,
        whisperDownloading: whisper.downloadState !== null,
        piperDownloading: piper.downloadState !== null,
        whisperDownloadState: whisper.downloadState ?? null,
        piperDownloadState: piper.downloadState ?? null,
      },
      whisperModel: { id: config.whisperModel, installed: whisperModel },
      piperVoice: { key: config.piperVoiceKey, installed: config.piperVoiceKey ? await voiceInstalled(config.piperVoiceKey) : false },
      catalogue: { count: piperCatalogue.all().length, lastRefreshed: piperCatalogue.getLastRefreshed() },
      ttsJobs: voiceService.ttsQueue.list().map((j) => ({ id: j.id, state: j.state, textPreview: j.text.slice(0, 80) })),
      downloads: downloadQueue.snapshot(),
    };
  };

  const handler = async (req, res) => {
    let pathname = '/';
    let query = new URLSearchParams();
    try {
      const u = new URL(req.url ?? '/', 'http://localhost');
      pathname = u.pathname;
      query = u.searchParams;
    } catch {
      pathname = '/';
    }
    const method = (req.method ?? 'GET').toUpperCase();
    const rel = pathname.startsWith(API_PREFIX) ? pathname.slice(API_PREFIX.length) : null;
    if (rel === null) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const route = rel.replace(/\/+$/, '') || '/';

    try {
      switch (`${method} ${route}`) {
        case 'GET /status':
          sendJson(res, 200, await statusPayload());
          return;

        case 'GET /config':
          sendJson(res, 200, { ok: true, config: getConfig() });
          return;

        case 'POST /config': {
          const body = await readJson(req);
          const result = await setConfig(typeof body === 'object' && body !== null ? body : {});
          sendJson(res, 200, { ok: true, config: result.config, errors: result.errors });
          return;
        }

        // --- STT ----------------------------------------------------------------
        case 'POST /stt': {
          const buf = await readBodyBuffer(req);
          if (buf.length < 1000) throw new ValidationError('Audio payload too small');
          if (getConfig().debugLogging) log.info(`[STT] request ${buf.length} bytes`);
          const audioPath = path.join(voiceTempDir, `stt-${randomUUID()}.wav`);
          await writeFile(audioPath, buf);
          const modelParam = query.get('model') ?? undefined;
          const model = modelParam && modelManager.listModels().some((m) => m.id === modelParam) ? modelParam : undefined;
          const text = await voiceService.transcribe(audioPath, {
            language: query.get('language') ?? undefined,
            task: query.get('task') ?? undefined,
            model,
          });
          if (getConfig().debugLogging) log.info(`[STT] response: ${text.length} chars — "${text.slice(0, 80)}"`);
          sendJson(res, 200, { ok: true, text });
          return;
        }

        // --- TTS ----------------------------------------------------------------
        case 'POST /tts': {
          const body = await readJson(req);
          if (typeof body.text !== 'string' || body.text.trim().length === 0) throw new ValidationError('text is required');
          const jobId = voiceService.speak(body.text);
          sendJson(res, 200, { ok: true, jobId });
          return;
        }

        case 'POST /tts/control': {
          const body = await readJson(req);
          const { jobId, action } = body;
          if (action === 'stopAll') {
            voiceService.stopAll();
            handoff.abortAll();
            sendJson(res, 200, { ok: true });
            return;
          }
          if (!jobId || !['pause', 'resume', 'stop'].includes(action)) throw new ValidationError("jobId + action(pause|resume|stop) required, or action 'stopAll'");
          voiceService[action](jobId);
          if (action === 'stop') handoff.abort(jobId);
          sendJson(res, 200, { ok: true });
          return;
        }

        case 'GET /tts/chunk': {
          const jobId = query.get('jobId');
          if (!jobId) throw new ValidationError('jobId query param required');
          const failed = findFailedJob(jobId);
          if (failed) {
            sendError(res, 502, new Error(failed.error ?? 'TTS synthesis failed'));
            return;
          }
          const r = await handoff.waitForChunk(jobId, 20_000);
          if (r.chunk) {
            const buf = await readFile(r.chunk.wavPath);
            res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
            res.end(buf);
            return;
          }
          if (r.gone) {
            const failedNow = findFailedJob(jobId);
            if (failedNow) {
              sendError(res, 502, new Error(failedNow.error ?? 'TTS synthesis failed'));
              return;
            }
            res.writeHead(204);
            res.end();
            return;
          }
          sendJson(res, 203, { ok: true, waiting: true });
          return;
        }

        case 'POST /tts/chunk-done': {
          const body = await readJson(req);
          handoff.ack(body.jobId);
          if (getConfig().debugLogging) log.info(`[TTS] job=${body.jobId} chunk acked by client`);
          sendJson(res, 200, { ok: true });
          return;
        }

        // --- Whisper models -------------------------------------------------------
        case 'GET /models/whisper': {
          const rows = await Promise.all(
            modelManager.listModels().map(async (m) => {
              const dlState = modelManager.getDownloadState(m.id);
              return {
                id: m.id,
                displayName: m.displayName,
                approxSizeMB: Math.round(m.approxSizeBytes / (1024 * 1024)),
                installed: (await modelManager.isInstalled(m.id)) === 'installed',
                downloading: dlState !== null,
                downloadState: dlState,
              };
            }),
          );
          sendJson(res, 200, { ok: true, models: rows, selected: getConfig().whisperModel });
          return;
        }

        case 'POST /models/whisper/download': {
          const body = await readJson(req);
          await modelManager.download(body.id);
          sendJson(res, 200, { ok: true });
          return;
        }

        case 'POST /models/whisper/cancel': {
          const body = await readJson(req);
          modelManager.cancelDownload(body.id);
          sendJson(res, 200, { ok: true });
          return;
        }

        case 'POST /models/whisper/remove': {
          const body = await readJson(req);
          await modelManager.remove(body.id);
          sendJson(res, 200, { ok: true });
          return;
        }

        case 'POST /models/whisper/select': {
          const body = await readJson(req);
          const result = await setConfig({ whisperModel: body.id });
          sendJson(res, 200, { ok: true, config: result.config, errors: result.errors });
          return;
        }

        // --- Piper voices -----------------------------------------------------------
        case 'GET /models/piper': {
          const language = query.get('language') ?? getConfig().piperLanguageCode;
          const voices = piperCatalogue
            .all()
            .filter((v) => v.languageCode === language)
            .map((v) => {
              const dlState = getVoiceDownloadState(v.key);
              return {
                key: v.key,
                locale: v.locale,
                name: v.name,
                quality: v.quality,
                region: v.region,
                language: v.language,
                numSpeakers: v.numSpeakers,
                onnxSizeBytes: v.onnxSizeBytes,
                downloading: dlState !== null,
                downloadState: dlState,
              };
            });
          sendJson(res, 200, {
            ok: true,
            languages: piperCatalogue.listLanguages(),
            regions: piperCatalogue.listRegions(language),
            voices,
            installed: await Promise.all(voices.map(async (v) => ({ key: v.key, installed: await voiceInstalled(v.key) }))),
            selected: getConfig().piperVoiceKey,
            lastRefreshed: piperCatalogue.getLastRefreshed(),
          });
          return;
        }

        case 'POST /models/piper/refresh':
          await piperCatalogue.refresh();
          sendJson(res, 200, { ok: true, count: piperCatalogue.all().length });
          return;

        case 'POST /models/piper/download': {
          const body = await readJson(req);
          await downloadVoice(body.key);
          const cfg = getConfig();
          const currentUsable = cfg.piperVoiceKey !== '' && (await voiceInstalled(cfg.piperVoiceKey));
          if (!currentUsable) {
            const voice = piperCatalogue.getVoice(body.key);
            if (voice) {
              await setConfig({ piperVoiceKey: voice.key, piperLanguageCode: voice.languageCode, piperLocale: voice.locale, piperQuality: voice.quality });
            }
          }
          sendJson(res, 200, { ok: true });
          return;
        }

        case 'POST /models/piper/cancel': {
          const body = await readJson(req);
          cancelVoiceDownload(body.key);
          sendJson(res, 200, { ok: true });
          return;
        }

        case 'POST /models/piper/remove': {
          const body = await readJson(req);
          assertSafeId(body.key, 'piper voice');
          await rm(path.join(piperVoicesDir, body.key), { recursive: true, force: true });
          sendJson(res, 200, { ok: true, wasSelected: getConfig().piperVoiceKey === body.key });
          return;
        }

        case 'POST /models/piper/select': {
          const body = await readJson(req);
          assertSafeId(body.key, 'piper voice');
          const voice = piperCatalogue.getVoice(body.key);
          if (!voice) throw new ValidationError(`Unknown piper voice key: ${body.key}`);
          const result = await setConfig({
            piperVoiceKey: body.key,
            piperLanguageCode: voice.languageCode,
            piperLocale: voice.locale,
            piperQuality: voice.quality,
          });
          sendJson(res, 200, { ok: true, config: result.config, errors: result.errors });
          return;
        }

        case 'POST /models/piper/preview': {
          const body = await readJson(req);
          assertSafeId(body.key, 'piper voice');
          let wavPath = null;
          try {
            wavPath = await voiceService.synthesizePreview(body.key);
            const buf = await readFile(wavPath);
            res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
            res.end(buf);
          } finally {
            if (wavPath) await rm(wavPath, { force: true }).catch(() => {});
          }
          return;
        }

        // --- Diagnostics / runtime ----------------------------------------------------
        case 'GET /diagnostics':
          sendJson(res, 200, { ok: true, report: await diagnostics(query.get('mic') === '1', query.get('out') === '1') });
          return;

        case 'POST /runtime/install': {
          const body = await readJson(req);
          if (!['whisper', 'piper'].includes(body.kind)) throw new ValidationError("kind must be 'whisper' or 'piper'");
          await runtimeManager.installRuntime(body.kind);
          sendJson(res, 200, { ok: true });
          return;
        }

        case 'POST /runtime/cancel': {
          const body = await readJson(req);
          if (!['whisper', 'piper'].includes(body.kind)) throw new ValidationError("kind must be 'whisper' or 'piper'");
          runtimeManager.cancelInstall(body.kind);
          sendJson(res, 200, { ok: true });
          return;
        }

        default:
          sendError(res, 404, new Error(`Unknown route: ${method} ${route}`));
          return;
      }
    } catch (err) {
      if (err instanceof ValidationError) return sendError(res, 400, err);
      if (err instanceof WhisperNotReadyError) return sendError(res, 409, err);
      if (err instanceof PiperNotReadyError) return sendError(res, 409, err);
      log.error(`api ${method} ${route} failed: ${err?.message ?? err}`);
      sendError(res, 500, err);
    }
  };

  // --- Registration ----------------------------------------------------------------
  if (ctx.inject) {
    ctx.inject(['webServer'], (webCtx) => {
      const dispose = webCtx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler });
      webCtx.effect(() => dispose);
    });
  }

  // Teardown: stop any in-flight TTS and release chunk state.
  if (ctx.effect) {
    ctx.effect(() => {
      log.info('loaded');
      return () => {
        voiceService.stopAll();
        handoff.abortAll();
        log.info('unloaded');
      };
    });
  }

  // --- Startup work (fire-and-forget, each individually caught) ----------------------
  void (async () => {
    try {
      const sweep = await sweepStaleTempFiles(voiceTempDir, 5 * 60 * 1000);
      if (sweep.deleted > 0) log.info(`temp sweep: removed ${sweep.deleted} stale file(s)`);
      if (sweep.failed > 0) log.warn(`temp sweep: ${sweep.failed} file(s) could not be removed`);
    } catch (err) {
      log.warn(`temp sweep failed: ${err?.message ?? err}`);
    }
    try {
      await piperCatalogue.initialize();
    } catch (err) {
      log.warn(`catalogue init failed: ${err?.message ?? err}`);
    }
    try {
      if (getConfig().piperVoiceKey === '') {
        const installed = await listInstalledVoiceKeys();
        const def = piperCatalogue.pickDefaultVoice();
        let chosen = null;
        if (def && installed.includes(def.key)) chosen = def;
        else if (installed.length > 0) chosen = piperCatalogue.getVoice(installed[0]) ?? null;
        if (chosen) await setConfig({ piperVoiceKey: chosen.key, piperLanguageCode: chosen.languageCode, piperLocale: chosen.locale, piperQuality: chosen.quality });
      }
    } catch (err) {
      log.warn(`default voice selection failed: ${err?.message ?? err}`);
    }
    try {
      const report = await diagnostics(false, false);
      log.info(`diagnostics: whisper=${report.whisperRuntime}/${report.whisperModel} piper=${report.piperRuntime}/${report.piperVoice}`);
    } catch (err) {
      log.error(`diagnostics failed: ${err?.message ?? err}`);
    }
  })();
}
