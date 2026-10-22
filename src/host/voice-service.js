// src/host/voice-service.js
// Top-level host-side service: the thing the DSH adapter (dsh/adapter.js)
// talks to. It never leaks Whisper/Piper implementation details across the
// client/host boundary — the client only ever sees VoiceState/SpeakerState
// and text (spec §59/§113).

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { runWhisper } from '../stt/whisper.js';
import { computeWavRmsDbfs } from '../stt/rms.js';
import { applySttFilter } from '../stt/stt-filter.js';
import { checkVoiceEngineCompatibility } from '../shared/voice-compat.js';
import { runPiper } from '../tts/piper.js';
import { PiperWorker } from '../tts/piper-worker.js';
import { previewSentenceFor } from '../shared/preview-sentences.js';
import { cleanTextForSpeech, splitIntoSpeechChunks } from '../tts/text-cleaner.js';
import { applyTtsFilter } from '../tts/tts-filter.js';
import { postProcessTtsWav } from '../tts/wav-utils.js';
import { TtsQueue } from '../tts/queue.js';

/**
 * @typedef {Object} VoiceServiceDeps
 * @property {import('./runtime-manager.js').RuntimeManager} runtimeManager
 * @property {import('./model-manager.js').ModelManager} modelManager
 * @property {import('../models/piper-catalogue.js').PiperCatalogue} piperCatalogue
 * @property {string} piperVoicesDir
 * @property {string} voiceTempDir
 * @property {() => import('../shared/types.js').OSoundConfig} getConfig
 * @property {(wavPath: string, signal: AbortSignal, jobId: string) => Promise<void>} playWav - Plays one synthesized WAV chunk through the client's Web Audio playback. Implemented by the DSH adapter as a chunk hand-off: the host publishes the file, the browser fetches/acks it, and this promise resolves when playback of the chunk is complete or the job is aborted.
 * @property {(line: string) => void} log
 * @property {(chunk: string, opts: {signal: AbortSignal}) => Promise<string>} [synthesizeChunk] - Test seam: synthesizes one cleaned text chunk and resolves its WAV path. `opts.signal` is the job's AbortSignal so a real implementation can be cancelled like runPiper is. Defaults to runPiper with the installed runtime, the selected voice, and those scales/signal.
 * @property {(opts: object) => import('../tts/piper-worker.js').PiperWorker} [piperWorkerFactory] - Test seam: constructs the persistent Piper worker (defaults to `new PiperWorker(opts)`).
 * @property {(opts: object) => Promise<{text: string, durationMs: number}>} [runWhisper] - Test seam: runs Whisper on a recording (defaults to the real runWhisper with the installed runtime).
 */

export class WhisperNotReadyError extends Error {}
export class PiperNotReadyError extends Error {}

/** The bundled Piper runtime can't load this voice (shared/voice-compat.js). Refused before synthesis. */
export class PiperVoiceIncompatibleError extends PiperNotReadyError {}

// Pipeline depth (2026-09-26 spec): while chunk N is PLAYING, chunks N+1 and N+2 are
// already synthesized or synthesizing — three sequential chunks in the active pipeline,
// strictly sequential playback (N → N+1 → N+2), never parallel playback. See synthesizeAndPlay.
const PIPELINE_AHEAD = 2;

export class VoiceService {
  state = 'idle';

  /** @param {VoiceServiceDeps} deps */
  constructor(deps) {
    this.deps = deps;
    this.ttsQueue = new TtsQueue((job, control) => this.synthesizeAndPlay(job.text, control, job.id));
    // Factory seam (tests inject a PiperWorker with a fake child process).
    this._piperWorkerFactory = deps.piperWorkerFactory ?? ((opts) => new PiperWorker(opts));
    // Persistent Piper worker state (config.ttsPersistentWorker; default OFF):
    // one long-lived piper.exe per (model, scales) — the model loads once and
    // every chunk is a warm job. A dead/wedged worker is replaced lazily; a
    // circuit breaker (_workerDisabledUntil) stops retrying a repeatedly
    // crashing worker for a cooldown window instead of paying its cost per chunk.
    /** @type {PiperWorker | null} */
    this._piperWorker = null;
    /** @type {string | null} identity (model + scales) the current worker is bound to */
    this._piperWorkerKey = null;
    /** @type {Promise<PiperWorker> | null} in-flight start() — shared by CONCURRENT first kicks
     * (PIPELINE_AHEAD=2 starts 3 chunks at once; without this they each spawned their own worker). */
    this._piperWorkerPending = null;
    /** @type {string | null} identity the pending start is for */
    this._piperWorkerPendingKey = null;
    /** @type {PiperWorker | null} the pending worker (reachable before start() resolves, so stop can kill it) */
    this._piperWorkerPendingWorker = null;
    /** @type {number} epoch ms until which the worker is circuit-broken */
    this._workerDisabledUntil = 0;
  }

  getState() {
    return this.state;
  }

  /**
   * Scans piperVoicesDir and returns the keys of voices that are fully
   * installed (both `<key>.onnx` and `<key>.onnx.json` present on disk).
   * A missing directory yields an empty list (nothing installed), never a throw.
   * @returns {Promise<string[]>}
   */
  async listInstalledVoiceKeys() {
    let entries;
    try {
      entries = await readdir(this.deps.piperVoicesDir);
    } catch {
      return [];
    }
    const keys = [];
    for (const name of entries) {
      const onnxOk = await this._fileExists(path.join(this.deps.piperVoicesDir, name, `${name}.onnx`));
      const jsonOk = await this._fileExists(path.join(this.deps.piperVoicesDir, name, `${name}.onnx.json`));
      if (onnxOk && jsonOk) keys.push(name);
    }
    return keys.sort();
  }

  /** @param {string} p @returns {Promise<boolean>} */
  async _fileExists(p) {
    try {
      const s = await stat(p);
      return s.isFile();
    } catch {
      return false;
    }
  }

  /**
   * Resolves which Piper voice to actually synthesize with, reconciling the
   * configured selection against what is genuinely installed on disk.
   *
   * This prevents the classic failure where config.piperVoiceKey names a voice
   * that was never downloaded (e.g. the first-run default), so runPiper died
   * with a confusing "Piper voice model not found: <default>.onnx".
   *
   * Resolution order:
   *   1. The configured voice, if it is installed.
   *   2. The single installed voice (the common "I downloaded one" case).
   *   3. The catalogue default voice, if it happens to be installed.
   *   4. The first installed voice (stable order).
   *   5. Nothing installed → throw an actionable PiperNotReadyError.
   *
   * @param {import('../shared/types.js').OSoundConfig} config
   * @returns {Promise<{voice: import('../shared/types.js').PiperVoiceDescriptor}>}
   */
  async resolveVoice(config) {
    const catalogue = this.deps.piperCatalogue;
    const installedKeys = await this.listInstalledVoiceKeys();
    const installedSet = new Set(installedKeys);

    const configured = config.piperVoiceKey ? catalogue.getVoice(config.piperVoiceKey) : null;

    let key = null;
    if (configured && installedSet.has(configured.key)) {
      key = configured.key; // 1. configured voice is installed
    } else if (installedKeys.length === 1) {
      key = installedKeys[0]; // 2. exactly one installed — just use it
    } else {
      const def = catalogue.pickDefaultVoice(); // 3./4. prefer the default if installed, else the first
      if (def && installedSet.has(def.key)) key = def.key;
      else if (installedKeys.length > 0) key = installedKeys[0];
    }

    if (!key) {
      const why = config.piperVoiceKey
        ? ` The selected voice "${config.piperVoiceKey}" is not downloaded.`
        : '';
      throw new PiperNotReadyError(`No Piper voice is installed yet. Download a voice in Settings → Voice, then try again.${why}`);
    }

    const voice = catalogue.getVoice(key);
    if (!voice) {
      throw new PiperNotReadyError(`Installed voice "${key}" is not in the current catalogue — refresh the catalogue in Settings → Voice.`);
    }
    if (voice.key !== config.piperVoiceKey) {
      this.deps.log(`[TTS] selected voice "${config.piperVoiceKey || '(none)'}" not installed — using installed voice "${voice.key}" instead`);
    }
    return { voice };
  }

  /**
   * Synthesizes a short preview WAV for ONE specific installed voice — independent
   * of the currently selected voice — and returns its path. The Settings UI "▶"
   * button uses this to audition a voice WITHOUT changing the selection.
   *
   * The sentence is in the voice's OWN language (Piper voices are language-specific,
   * so English text on a de_DE voice sounds wrong). It is a few words and is never
   * chunked. This method never touches the persisted config / selection.
   *
   * The caller owns the returned file and must delete it.
   *
   * @param {string} voiceKey - an installed Piper voice key
   * @param {string} [text] - explicit preview text; a short native sentence if omitted
   * @returns {Promise<string>} path to the generated preview WAV
   */
  async synthesizePreview(voiceKey, text) {
    const piperRuntime = await this.deps.runtimeManager.checkPiper();
    if (piperRuntime.state !== 'installed') throw new PiperNotReadyError(`Piper runtime is not installed (missing: ${piperRuntime.missing.join(', ')}).`);

    const voice = this.deps.piperCatalogue.getVoice(voiceKey);
    if (!voice) throw new PiperNotReadyError(`Unknown Piper voice: ${voiceKey}`);
    const voiceDir = path.join(this.deps.piperVoicesDir, voice.key);
    const modelPath = path.join(voiceDir, `${voice.key}.onnx`);
    const configPath = path.join(voiceDir, `${voice.key}.onnx.json`);
    if (!(await this._fileExists(modelPath)) || !(await this._fileExists(configPath))) {
      throw new PiperNotReadyError(`Voice "${voice.key}" is not installed.`);
    }
    await this._assertVoiceCompatible(voice.key, configPath);

    const sentence = text && text.trim() ? text : previewSentenceFor(voice);
    await mkdir(this.deps.voiceTempDir, { recursive: true });
    const outPath = path.join(this.deps.voiceTempDir, `preview-${randomUUID()}.wav`);
    const synthesizeWav = this.deps.synthesizePreviewWav ?? ((o) => runPiper(o)); // test seam
    const result = await synthesizeWav({
      exePath: this.deps.runtimeManager.getPiperExePath(),
      modelPath,
      configPath,
      text: sentence,
      outputWavPath: outPath,
      timeoutMs: 20_000,
    });
    return result.wavPath;
  }

  /**
   * Called by the host adapter once it has a finished 16kHz mono PCM/WAV recording.
   * @param {string} audioPath
   * @param {{language?: string, task?: import('../shared/types.js').WhisperTask, model?: string}} [overrides] - Per-request overrides (the incremental STT windows use `model` to run a smaller/faster model for the live partial when configured).
   * @returns {Promise<string>}
   */
  async transcribe(audioPath, overrides) {
    const config = this.deps.getConfig();
    const whisperRuntime = await this.deps.runtimeManager.checkWhisper();
    if (whisperRuntime.state !== 'installed') throw new WhisperNotReadyError(`Whisper runtime is not installed (missing: ${whisperRuntime.missing.join(', ')}).`);
    // Resolve the model: per-request override (incremental STT windows) else the
    // configured main model. The override is validated host-side by the adapter
    // (unknown ids are dropped before they reach here).
    const modelId = overrides?.model ?? config.whisperModel;
    const modelState = await this.deps.modelManager.isInstalled(modelId);
    if (modelState !== 'installed') throw new WhisperNotReadyError(`Whisper model is not installed: ${modelId}.`);

    this.state = 'processing';
    try {
      // Silence gate (2026-10-06): skip Whisper entirely on silence. A
      // null RMS (unparseable audio) SKIPS the gate — it never blocks STT.
      const gate = config.sttFilter?.silenceGate;
      if (gate?.enabled) {
        const dbfs = computeWavRmsDbfs(await readFile(audioPath));
        if (dbfs !== null && dbfs < gate.thresholdDb) {
          this.deps.log(`[STT] silence gate: ${dbfs.toFixed(1)} dBFS < ${gate.thresholdDb} dBFS — skipped Whisper`);
          this.state = 'success';
          return '';
        }
      }

      const result = await (this.deps.runWhisper ?? runWhisper)({
        exePath: this.deps.runtimeManager.getWhisperExePath(),
        modelPath: this.deps.modelManager.modelPath(modelId),
        audioPath,
        language: overrides?.language ?? config.whisperLanguage,
        task: overrides?.task ?? config.whisperTask,
      });
      this.state = 'success';
      this.deps.log(`[Whisper] transcription completed in ${result.durationMs}ms`);
      // STT filter (2026-10-06): strip annotation tokens from the transcript
      // before it reaches the chat input.
      return applySttFilter(result.text, config.sttFilter).trim();
    } catch (err) {
      this.state = 'error';
      throw err;
    } finally {
      await rm(audioPath, { force: true }).catch(() => {});
    }
  }

  /** Debug-only lifecycle log (gated by config.debugLogging): source text and
   * per-chunk enqueue/synthesize/publish/play/ack transitions for TTS tracing. */
  _dbg(message) {
    if (this.deps.getConfig().debugLogging) this.deps.log(message);
  }

  /** Short one-line preview for logs. @param {string} text @returns {string} */
  _preview(text) {
    const t = String(text).replace(/\s+/g, ' ').trim();
    return `"${t.slice(0, 40)}${t.length > 40 ? '…' : ''}"`;
  }

  /** Enqueues assistant text for speaking. Respects speakThinking/speakToolOutput/speakCode flags upstream.
   * @param {string} text @returns {string} */
  speak(text) {
    const id = this.ttsQueue.enqueue(text);
    this._dbg(`[TTS] enqueue job=${id} text=${text.length} chars ${this._preview(text)}`);
    return id;
  }

  /** @param {string} id */
  pause(id) {
    this.ttsQueue.pause(id);
  }

  /** @param {string} id */
  resume(id) {
    this.ttsQueue.resume(id);
  }

  /** @param {string} id */
  stop(id) {
    this.ttsQueue.stop(id);
  }

  stopAll() {
    this.ttsQueue.stopAll();
    this._stopPiperWorker(); // the persistent worker must not outlive the jobs
  }

  /**
   * Refuses a voice the bundled Piper runtime cannot load (shared/voice-compat.js).
   * An unreadable voice config is left to the runtime to report with its own error.
   * @param {string} voiceKey
   * @param {string} configPath - <voice>.onnx.json
   */
  async _assertVoiceCompatible(voiceKey, configPath) {
    let voiceJson;
    try {
      voiceJson = JSON.parse(await readFile(configPath, 'utf8'));
    } catch {
      return;
    }
    const compat = checkVoiceEngineCompatibility(voiceJson, voiceKey);
    if (!compat.ok) throw new PiperVoiceIncompatibleError(compat.message);
  }

  /**
   * Gets (or lazily starts) the persistent Piper worker bound to
   * (modelPath, scales). A different model or different scales restarts the
   * worker (the scales are command-line args on this build, not per-line
   * fields). Throws when the worker cannot start — the caller falls back to
   * one-shot runPiper for the chunk.
   */
  async _getPiperWorker(modelPath, configPath, scales) {
    const key = [modelPath, scales.lengthScale, scales.noiseScale, scales.noiseWScale].join('|');
    if (this._piperWorker && this._piperWorkerKey === key && this._piperWorker.isAlive) {
      return this._piperWorker;
    }
    // Concurrent first kicks (job start launches 3 chunks at once) must share ONE start,
    // not spawn one worker each.
    if (this._piperWorkerPendingKey === key && this._piperWorkerPending) {
      return this._piperWorkerPending;
    }
    // Voice or scales changed (or the worker died): retire the old one (and any in-flight start).
    this._stopPiperWorker();
    const pending = (async () => {
      const worker = this._piperWorkerFactory({
        exePath: this.deps.runtimeManager.getPiperExePath(),
        modelPath,
        configPath,
        ...scales,
        log: (m) => this.deps.log(m),
      });
      this._piperWorkerPendingWorker = worker; // reachable so _stopPiperWorker can kill it mid-start
      await worker.start(); // init (model load) — warm jobs afterwards
      return worker;
    })();
    this._piperWorkerPendingKey = key;
    this._piperWorkerPending = pending;
    try {
      const worker = await pending;
      this._piperWorker = worker;
      this._piperWorkerKey = key;
      this._piperWorkerPending = null;
      this._piperWorkerPendingKey = null;
      this._piperWorkerPendingWorker = null;
      return worker;
    } catch (err) {
      this._piperWorkerPending = null;
      this._piperWorkerPendingKey = null;
      this._piperWorkerPendingWorker = null;
      throw err;
    }
  }

  /**
   * Synthesizes one chunk via the persistent worker. Circuit breaker: after a
   * hard failure (dead/wedged, not "busy"), the worker is disabled for a
   * cooldown window so a repeatedly crashing worker (e.g. a voice broken on
   * the legacy runtime) costs one detection, not one per chunk.
   */
  async _synthesizeViaWorker({ modelPath, configPath, chunk, wavPath, scales, signal }) {
    if (Date.now() < this._workerDisabledUntil) {
      throw new Error('persistent worker circuit-broken (recent failure)');
    }
    const worker = await this._getPiperWorker(modelPath, configPath, scales);
    try {
      return await worker.synthesize(chunk, wavPath, { signal });
    } catch (err) {
      // The worker died or wedged (or is gone): break the circuit for a window.
      // "aborted" is a normal job stop, not a worker failure — no breaker.
      if (!signal?.aborted) {
        this._workerDisabledUntil = Date.now() + 5 * 60_000;
        this._stopPiperWorker();
        this.deps.log(`[TTS] persistent Piper worker failed (${err.message}); disabled for 5 min — falling back to one-shot Piper`);
      }
      throw err;
    }
  }

  /** Retires the current worker AND any in-flight start (idempotent). */
  _stopPiperWorker() {
    if (this._piperWorker) {
      try { this._piperWorker.stop(); } catch { /* already gone */ }
      this._piperWorker = null;
      this._piperWorkerKey = null;
    }
    if (this._piperWorkerPendingWorker) {
      try { this._piperWorkerPendingWorker.stop(); } catch { /* already gone */ }
      this._piperWorkerPendingWorker = null;
    }
    this._piperWorkerPending = null;
    this._piperWorkerPendingKey = null;
  }

  /**
   * The speak handler the TtsQueue runs per job.
   *
   * 3-chunk pipeline (2026-09-26 spec): while chunk N is PLAYING, chunks N+1 and N+2 are
   * already synthesized or synthesizing (PIPELINE_AHEAD=2). So the moment chunk N's
   * playback ack arrives, chunk N+1 — usually already READY — is published with near-zero
   * gap, and N+3 is kicked to keep the pipeline full. Playback stays strictly sequential
   * (N → N+1 → N+2) through the single-slot ChunkHandoff; only synthesis runs ahead.
   * Each chunk is synthesized at most once (kick() is idempotent per index) and played
   * exactly once (the handoff's exactly-once delivery). At most two Piper processes run
   * in parallel in steady state (N+1 and N+2), plus a 3-way burst at job start.
   *
   * Failure semantics: a real synthesis failure of chunk i fails the job when i's turn
   * comes (the promise rejection is re-thrown); a failure of an AHEAD chunk is remembered
   * (ready marker) and surfaces the same way at its own turn. If the job ends (finished,
   * stopped, abandoned) with work still in flight, every in-flight promise is detached
   * (never rejects unhandled) and every synthesized-but-unplayed WAV is deleted
   * best-effort.
   *
   * @param {string} text
   * @param {import('../tts/queue.js').SpeakControl} control
   * @param {string} jobId
   */
  async synthesizeAndPlay(text, control, jobId) {
    const { signal } = control;
    const config = this.deps.getConfig();
    const piperRuntime = await this.deps.runtimeManager.checkPiper();
    if (piperRuntime.state !== 'installed') throw new PiperNotReadyError(`Piper runtime is not installed (missing: ${piperRuntime.missing.join(', ')}).`);

    const { voice } = await this.resolveVoice(config);
    const voiceDir = path.join(this.deps.piperVoicesDir, voice.key);
    const modelPath = path.join(voiceDir, `${voice.key}.onnx`);
    const configPath = path.join(voiceDir, `${voice.key}.onnx.json`);

    await this._assertVoiceCompatible(voice.key, configPath);

    const cleaned = cleanTextForSpeech(text, { speakCode: config.speakCode });
    // User-configurable filter (2026-10-06): affects the Piper input ONLY —
    // the displayed text (job.text) is never touched.
    const speakable = applyTtsFilter(cleaned, config.ttsFilter);
    const chunks = splitIntoSpeechChunks(speakable, { locale: voice.locale ?? voice.languageCode ?? 'en' });
    if (chunks.length === 0) return;
    this._dbg(`[TTS] job=${jobId} ${chunks.length} chunk(s) for ${speakable.length} chars of speakable text`);

    await mkdir(this.deps.voiceTempDir, { recursive: true });

    // Scales are derived once per job (config can only change between jobs here).
    const lengthScale = (1 / Math.max(0.1, config.ttsSpeed)) * config.ttsLengthScale;
    const scales = { lengthScale, noiseScale: config.ttsNoiseScale, noiseWScale: config.ttsNoiseWScale };

    // Default synthesizer = the real Piper; deps.synthesizeChunk is the test seam.
    // With config.ttsPersistentWorker ON, chunks go through the shared persistent
    // worker (one process, model loaded once); ANY worker problem (not started,
    // dead, wedged, busy, circuit-broken) falls back to one-shot runPiper for
    // that chunk — one retry per chunk, never a job failure from the worker itself.
    const oneShot = (chunk, wavPath, sig) =>
      runPiper({
        exePath: this.deps.runtimeManager.getPiperExePath(),
        modelPath,
        configPath,
        text: chunk,
        outputWavPath: wavPath,
        ...scales,
        signal: sig,
      }).then((r) => r.wavPath);

    const synthesize = this.deps.synthesizeChunk ?? ((chunk, { signal: jobSignal }) => {
      const wavPath = path.join(this.deps.voiceTempDir, `tts-${randomUUID()}.wav`);
      if (!config.ttsPersistentWorker) return oneShot(chunk, wavPath, jobSignal);
      return this._synthesizeViaWorker({ modelPath, configPath, chunk, wavPath, scales, signal: jobSignal })
        .catch((err) => {
          if (jobSignal.aborted) throw err; // the job is already stopped — no wasted fallback spawn
          this._dbg(`[TTS] job=${jobId} persistent worker unavailable (${err.message}) — one-shot Piper fallback for this chunk`);
          return oneShot(chunk, wavPath, jobSignal);
        });
    });

    // 3-chunk pipeline state (see the method docstring):
    //   ready    — index -> wavPath (synthesis done, not yet played) | null (synthesis FAILED)
    //   inflight — index -> Promise<string> (synthesis running)
    // kick() starts a chunk's synthesis exactly once (idempotent per index), so no chunk is
    // ever synthesized twice; playback order is still the for-loop below (strictly sequential).
    const ready = new Map(); // index -> wavPath | null (synthesis FAILED)
    const inflight = new Map(); // index -> Promise<string>
    const failed = new Map(); // index -> Error (kept so the job fails with the ORIGINAL error)

    const kick = (j) => {
      if (j >= chunks.length || inflight.has(j) || ready.has(j)) return;
      this._dbg(`[TTS] job=${jobId} chunk ${j + 1}/${chunks.length} synth start ${this._preview(chunks[j])}`);
      const p = synthesize(chunks[j], { signal })
        .then((wav) => {
          ready.set(j, wav);
          return wav;
        })
        .catch((err) => {
          ready.set(j, null); // remember the failure; the job fails when index j's turn comes
          failed.set(j, err);
          throw err;
        });
      inflight.set(j, p);
      p.catch(() => {}); // keep-alive: rejection is consumed at iteration j or detached in finally
    };

    try {
      for (let i = 0; i < chunks.length; i += 1) {
        if (signal.aborted) return;
        // Let a pause() called while the previous chunk was playing take effect now, before we
        // spend time synthesizing the next one — without this, "paused" was a label with no effect.
        await control.waitIfPaused();
        if (signal.aborted) return;

        // Keep N, N+1, N+2 in the pipeline: kick the current chunk (its turn is now) plus the
        // two after it. Steady state while chunk i plays: i+1 ready, i+2 synthesizing.
        for (let j = i; j <= i + PIPELINE_AHEAD; j += 1) kick(j);

        let wavPath = ready.get(i);
        if (wavPath === undefined) wavPath = await inflight.get(i); // throws on a real failure
        if (wavPath === null) throw failed.get(i) ?? new Error(`Piper synthesis failed for chunk ${i + 1}/${chunks.length}`);
        if (signal.aborted) return;
        this._dbg(`[TTS] job=${jobId} chunk ${i + 1}/${chunks.length} synth ready`);

        // Post-process the chunk WAV before playback (2026-10-06), both best-effort
        // (any problem leaves the original file and continues the job):
        //   * ttsLevelMatch — level-match this chunk's RMS to a fixed target
        //   * pauseBetweenSentences — trailing silence on every chunk but the last
        if (config.ttsLevelMatch || (config.pauseBetweenSentences > 0 && i < chunks.length - 1)) {
          await postProcessTtsWav(wavPath, {
            levelMatch: config.ttsLevelMatch,
            trailingSilenceMs: i < chunks.length - 1 ? config.pauseBetweenSentences : 0,
            log: (m) => this.deps.log(m),
          });
        }

        // Synthesis for this chunk is done — actual audio playback starts now, so this is the
        // point the job should show as 🔉 playing rather than ⏳ generating (see tts/queue.js).
        control.markPlaying();
        this._dbg(`[TTS] job=${jobId} chunk ${i + 1}/${chunks.length} published (waiting for client ack)`);
        try {
          if (!signal.aborted) await this.deps.playWav(wavPath, signal, jobId);
        } finally {
          ready.delete(i);
          await rm(wavPath, { force: true }).catch(() => {});
        }
        this._dbg(`[TTS] job=${jobId} chunk ${i + 1}/${chunks.length} play end (acked or released)`);
      }
    } finally {
      // Job ending (finished, stopped, or abandoned): detach every in-flight synthesis (never
      // allowed to reject unhandled), delete its WAV best-effort, and clean up any
      // synthesized-but-not-yet-played WAVs.
      for (const p of inflight.values()) {
        p.catch(() => {})
          .then((wav) => {
            if (typeof wav === 'string') rm(wav, { force: true }).catch(() => {});
          }, () => {});
      }
      for (const wav of ready.values()) {
        if (typeof wav === 'string') rm(wav, { force: true }).catch(() => {});
      }
      inflight.clear();
      ready.clear();
    }
  }
}
