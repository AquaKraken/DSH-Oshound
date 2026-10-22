// src/tts/piper-worker.js
// Persistent Piper worker: ONE long-lived piper.exe process per voice model,
// so the model is loaded exactly once and every chunk is a warm job.
//
// Job boundary (VERIFIED on the installed 2023.11.14 build, 2026-10-06,
// tmp/probe-jsonout.mjs — NOT timing/silence framing):
//   * spawn:  piper.exe --model M --config C --json-input
//             (NO --output_raw, NO --output_file on the command line)
//   * ready:  "Initialized piper" appears on stderr (spdlog)
//   * job:    write ONE JSON line to stdin:
//                {"text": "...", "output_file": "<abs path.wav>"}
//             Piper writes the COMPLETE WAV to that path, then echoes the
//             output path on its own line on stdout. That echo is the
//             completion signal (the file is closed before the echo).
//   * the process stays alive across jobs; a second job is warm.
//
// The scales (--length_scale/--noise_scale/--noise_w) are command-line
// arguments on this build, not per-line JSON fields, so the worker is
// BOUND to (model, scales) at start: the owner (VoiceService) restarts it
// when the voice or any scale changes.

import { spawn } from 'node:child_process';
import { rm, stat } from 'node:fs/promises';

/** Generic worker problem (busy, init failure). Caller falls back to one-shot Piper. */
export class PiperWorkerError extends Error {}
/** The worker process died or wedged. Caller falls back to one-shot Piper. */
export class PiperWorkerDeadError extends PiperWorkerError {
  constructor(message, stderrTail = '') {
    super(message);
    this.name = 'PiperWorkerDeadError';
    this.stderrTail = stderrTail;
  }
}

export class PiperWorker {
  /**
   * @param {object} opts
   * @param {string} opts.exePath - absolute path to piper.exe
   * @param {string} opts.modelPath - absolute path to <voice>.onnx
   * @param {string} opts.configPath - absolute path to <voice>.onnx.json
   * @param {number} opts.lengthScale
   * @param {number} opts.noiseScale
   * @param {number} opts.noiseWScale
   * @param {(message: string) => void} [opts.log]
   * @param {number} [opts.initTimeoutMs=30000] - max wait for the ready marker
   * @param {number} [opts.jobTimeoutMs=60000] - max wait for one chunk's path echo
   * @param {number} [opts.maxQueue=4] - bounded in-flight jobs before synthesize() rejects
   * @param {typeof spawn} [opts._spawn] - test seam
   */
  constructor(opts) {
    this.exePath = opts.exePath;
    this.modelPath = opts.modelPath;
    this.configPath = opts.configPath;
    this.lengthScale = opts.lengthScale;
    this.noiseScale = opts.noiseScale;
    this.noiseWScale = opts.noiseWScale;
    this.log = opts.log ?? (() => {});
    this.initTimeoutMs = opts.initTimeoutMs ?? 30_000;
    this.jobTimeoutMs = opts.jobTimeoutMs ?? 60_000;
    this.maxQueue = Math.max(1, opts.maxQueue ?? 4);
    this._spawn = opts._spawn ?? spawn;

    this.child = null;
    /** Set when the process died/wedged OR stop() was called. */
    this.dead = false;
    this.stopping = false;
    this.stderrTail = '';
    /** @type {Map<string, {resolve: Function, reject: Function, timer: any, cancelled: boolean, text: string}>} keyed by wavPath */
    this.pending = new Map();
  }

  /** True while the process is alive and usable. */
  get isAlive() {
    return this.child !== null && this.child.exitCode === null && !this.dead && !this.stopping;
  }

  /** Spawns piper and waits for the ready marker. Rejects on timeout/spawn error. */
  start() {
    if (this.child) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.dead = true;
        try { this.child?.kill(); } catch { /* already gone */ }
        this.child = null;
        reject(err);
      };
      const timer = setTimeout(() => {
        fail(new PiperWorkerError(`Piper worker did not become ready within ${this.initTimeoutMs}ms (stderr tail: ${this.stderrTail.slice(-200)})`));
      }, this.initTimeoutMs);
      timer.unref?.();

      let child;
      try {
        child = this._spawn(
          this.exePath,
          [
            '--model', this.modelPath,
            '--config', this.configPath,
            '--json-input',
            '--length_scale', String(this.lengthScale),
            '--noise_scale', String(this.noiseScale),
            '--noise_w', String(this.noiseWScale),
          ],
          { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
        );
      } catch (err) {
        fail(new PiperWorkerError(`Piper worker spawn failed: ${err.message}`));
        return;
      }
      this.child = child;
      this._attachIO();

      child.on('error', (err) => {
        fail(new PiperWorkerError(`Piper worker spawn error: ${err.message}`));
      });
      child.stderr?.on('data', (d) => {
        this.stderrTail = (this.stderrTail + d.toString('utf8')).slice(-2000);
        if (!settled && this.stderrTail.includes('Initialized piper')) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      });
      // The process must not die before it is ready (and while ready, _onExit handles it).
      child.on('exit', (code) => {
        if (!settled) fail(new PiperWorkerDeadError(`Piper worker exited before ready (code ${code}). stderr tail: ${this.stderrTail.slice(-200)}`, this.stderrTail));
        else this._onExit(code);
      });
    });
  }

  /**
   * Synthesizes one chunk into `wavPath`. Resolves with wavPath once the file
   * is complete (the path echo implies piper closed the file). Rejects with:
   *   PiperWorkerError        — worker not alive / stopping / queue full
   *   PiperWorkerDeadError    — process died or wedged mid-job
   *   Error (abort message)   — the job's AbortSignal fired while waiting
   *
   * @param {string} text
   * @param {string} wavPath
   * @param {{signal?: AbortSignal, timeoutMs?: number}} [opts]
   */
  synthesize(text, wavPath, opts = {}) {
    if (!this.isAlive) {
      return Promise.reject(new PiperWorkerDeadError(`Piper worker is not running (model ${this.modelPath.split(/[\\/]/).pop()}).`, this.stderrTail));
    }
    if (this.pending.size >= this.maxQueue) {
      return Promise.reject(new PiperWorkerError(`Piper worker queue full (${this.maxQueue} in flight).`));
    }
    const signal = opts.signal;
    const timeoutMs = opts.timeoutMs ?? this.jobTimeoutMs;

    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null, cancelled: false, text };
      this.pending.set(wavPath, entry);
      const settle = (fn) => {
        if (entry.cancelled) return;
        entry.cancelled = true;
        clearTimeout(entry.timer);
        this.pending.delete(wavPath);
        fn();
      };
      entry.timer = setTimeout(() => {
        // No path echo in time: the worker is wedged. Kill it so the owner
        // restarts (or falls back) instead of waiting on a dead pipe forever.
        this._killAll(`Piper worker job timed out after ${timeoutMs}ms (text: ${String(text).slice(0, 40)}).`);
      }, timeoutMs);
      entry.timer.unref?.();

      const onAbort = () => {
        // The owning job was stopped: stop waiting. Piper may still finish the
        // job and write the file — that echo is unmatched and ignored. Best-effort
        // delete the (possibly written) WAV so a stopped job leaves no orphan.
        settle(() => {
          rm(wavPath, { force: true }).catch(() => {});
          reject(new Error('aborted'));
        });
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      // Write the job. A stdin error (EPIPE) means the process is gone.
      try {
        this.child.stdin.write(JSON.stringify({ text, output_file: wavPath }) + '\n');
      } catch (err) {
        signal?.removeEventListener('abort', onAbort);
        this._killAll(`Piper worker stdin write failed: ${err.message}.`);
      }
    });
  }

  /** Kills the process and rejects every pending job (idempotent). */
  stop() {
    this.stopping = true;
    this._killAll('Piper worker stopped.');
  }

  /** Kills the child and settles all pending jobs as dead. @param {string} reason */
  _killAll(reason) {
    const err = new PiperWorkerDeadError(reason, this.stderrTail);
    for (const entry of this.pending.values()) {
      entry.cancelled = true;
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
    if (this.child) {
      this.dead = true;
      try { this.child.kill(); } catch { /* already gone */ }
      this.child = null;
    } else {
      this.dead = true;
    }
  }

  /** Handles an unexpected process exit (not a stop()). */
  _onExit(code) {
    if (this.dead || this.stopping) return;
    this.log?.(`[TTS] piper worker exited unexpectedly (code ${code}); pending jobs rejected. stderr tail: ${this.stderrTail.slice(-200)}`);
    this._killAll(`Piper worker exited (code ${code}).`);
  }

  /** Wires the stdout/stdin error handlers once (called from start()). */
  _attachIO() {
    const child = this.child;
    if (!child) return;
    let stdoutBuf = '';
    child.stdout?.on('data', (d) => {
      stdoutBuf += d.toString('utf8');
      let i;
      while ((i = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, i).replace(/\r$/, '').trim();
        stdoutBuf = stdoutBuf.slice(i + 1);
        if (!line) continue;
        // The path echo matches the job's wavPath (case-insensitively on Windows).
        const hit = [...this.pending.keys()].find((p) => p.toLowerCase() === line.toLowerCase());
        if (hit) {
          const entry = this.pending.get(hit);
          entry.cancelled = true;
          clearTimeout(entry.timer);
          this.pending.delete(hit);
          // Defensive: the echo implies the file is closed, but verify before
          // handing the path to the chunk hand-off.
          stat(hit).then(
            () => entry.resolve(hit),
            () => entry.reject(new PiperWorkerDeadError(`Piper echoed output ${hit} but the file does not exist.`, this.stderrTail)),
          );
        } else {
          this.log?.(`[TTS] piper worker: unmatched stdout line (ignored): ${line.slice(0, 120)}`);
        }
      }
    });
    child.stdin?.on('error', () => {
      // EPIPE: the process is gone mid-write.
      if (!this.dead && !this.stopping) this._killAll('Piper worker stdin pipe broken (process gone).');
    });
  }
}
