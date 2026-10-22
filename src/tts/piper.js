// src/tts/piper.js
// Invokes the Piper CLI (rhasspy/piper 2023.11.14-2) as a child process with an
// argument array. Text is passed over stdin, never interpolated into argv or a
// shell string.

import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { clampNumber } from '../shared/validation.js';

/**
 * @typedef {Object} PiperRunOptions
 * @property {string} exePath
 * @property {string} modelPath - .onnx
 * @property {string} configPath - .onnx.json
 * @property {string} text
 * @property {string} outputWavPath
 * @property {number} [lengthScale] - speed: lower = faster
 * @property {number} [noiseScale]
 * @property {number} [noiseWScale]
 * @property {number} [speakerId]
 * @property {number} [timeoutMs]
 * @property {AbortSignal} [signal] - Abort support (lookahead cancellation): if already
 * aborted, rejects immediately WITHOUT spawning; otherwise the child is killed on
 * abort and the promise rejects with "Piper synthesis aborted".
 */

export class PiperInvocationError extends Error {}

/** @param {string} filePath @param {string} label */
async function assertExists(filePath, label) {
  try {
    const s = await stat(filePath);
    if (!s.isFile()) throw new Error('not a file');
  } catch {
    throw new PiperInvocationError(`${label} not found: ${filePath}`);
  }
}

/** @param {PiperRunOptions} opts @returns {string[]} */
function buildPiperArgs(opts) {
  const args = ['--model', opts.modelPath, '--config', opts.configPath, '--output_file', opts.outputWavPath];
  if (opts.lengthScale !== undefined) args.push('--length_scale', String(clampNumber(opts.lengthScale, 0.3, 3.0, 'lengthScale')));
  if (opts.noiseScale !== undefined) args.push('--noise_scale', String(clampNumber(opts.noiseScale, 0, 1, 'noiseScale')));
  if (opts.noiseWScale !== undefined) args.push('--noise_w', String(clampNumber(opts.noiseWScale, 0, 1, 'noiseWScale')));
  if (opts.speakerId !== undefined) args.push('--speaker', String(Math.max(0, Math.floor(opts.speakerId))));
  return args;
}

/**
 * Synthesizes `opts.text` to a WAV file. Text is written to the child's stdin — never embedded in argv.
 * @param {PiperRunOptions} opts
 * @returns {Promise<{wavPath: string, durationMs: number}>}
 */
export async function runPiper(opts) {
  // Abort FIRST: a pre-aborted signal must reject without touching the disk or
  // spawning a process (lookahead cancellation of a chunk nobody will ever play).
  if (opts.signal?.aborted) throw new PiperInvocationError('Piper synthesis aborted');
  await assertExists(opts.exePath, 'Piper executable');
  await assertExists(opts.modelPath, 'Piper voice model');
  await assertExists(opts.configPath, 'Piper voice config');
  if (!opts.text.trim()) throw new PiperInvocationError('Refusing to synthesize empty text');

  const args = buildPiperArgs(opts);
  const start = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(opts.exePath, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    let aborted = false;
    const onAbort = () => {
      if (aborted) return;
      aborted = true;
      try {
        child.kill();
      } catch {
        /* already dead */
      }
    };
    const timeout = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already dead */
      }
      reject(new PiperInvocationError(`Piper timed out after ${opts.timeoutMs ?? 30_000}ms`));
    }, opts.timeoutMs ?? 30_000);
    timeout.unref?.();
    if (opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true });

    // Prevent unhandled EPIPE on stdin if piper.exe exits before stdin flush completes.
    child.stdin.on('error', () => {});
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    child.on('error', (err) => {
      clearTimeout(timeout);
      opts.signal?.removeEventListener('abort', onAbort);
      if (aborted) {
        reject(new PiperInvocationError('Piper synthesis aborted'));
        return;
      }
      reject(new PiperInvocationError(`Failed to launch Piper: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      opts.signal?.removeEventListener('abort', onAbort);
      if (aborted) {
        // kill() makes close() fire with a non-zero/null code — report the abort
        // specifically so the queue keeps the abandon message, not a raw exit code.
        reject(new PiperInvocationError('Piper synthesis aborted'));
        return;
      }
      if (code !== 0) {
        reject(new PiperInvocationError(`Piper exited with code ${code}: ${stderr.trim()}`));
        return;
      }
      resolve({ wavPath: opts.outputWavPath, durationMs: Date.now() - start });
    });

    child.stdin.write(opts.text, 'utf8');
    child.stdin.end();
  });
}
