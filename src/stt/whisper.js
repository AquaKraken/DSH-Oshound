// src/stt/whisper.js
// Invokes the Const-me Whisper CLI (https://github.com/Const-me/Whisper)
// as a child process with an argument array — never a shell string.
//
// RESOLVED AGAINST THE REAL RELEASE (2026-09-13): flags below were confirmed
// by running `main.exe --help` from the 1.12.0 `cli.zip` release asset, and
// verified end-to-end (Piper-synthesized WAV in, correct transcript out,
// `--output-txt` writing `<audio-basename>.txt` next to the audio file).

import { spawn } from 'node:child_process';
import { stat, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { safeJoin } from '../shared/validation.js';
import { WHISPER_LANGUAGE_CODES } from './languages.js';

/**
 * @typedef {Object} WhisperRunOptions
 * @property {string} exePath
 * @property {string} modelPath
 * @property {string} audioPath
 * @property {string} language - 'auto' (engine default: English) or a code from WHISPER_LANGUAGE_CODES
 * @property {import('../shared/types.js').WhisperTask} task
 * @property {number} [timeoutMs]
 */

/**
 * @typedef {Object} WhisperResult
 * @property {string} text
 * @property {string} [language]
 * @property {number} durationMs
 */

export class WhisperInvocationError extends Error {}

/**
 * Builds the exact argv for the Const-me/Whisper 1.12.0 CLI.
 * Flags confirmed via `main.exe --help` (see file header).
 * @param {WhisperRunOptions} opts @returns {string[]}
 */
export function buildWhisperArgs(opts) {
  const args = [
    '--model', opts.modelPath,
    '--file', opts.audioPath,
    '--output-txt',
    '--no-colors',
    '--no-timestamps',
  ];
  if (opts.language !== 'auto') {
    if (!WHISPER_LANGUAGE_CODES.has(opts.language)) {
      throw new WhisperInvocationError(`Unknown Whisper language code: ${opts.language}`);
    }
    args.push('--language', opts.language);
  }
  if (opts.task === 'translate') args.push('--translate');
  return args;
}

/** @param {string} filePath @param {string} label */
async function assertExists(filePath, label) {
  try {
    const s = await stat(filePath);
    if (!s.isFile()) throw new Error('not a file');
  } catch {
    throw new WhisperInvocationError(`${label} not found: ${filePath}`);
  }
}

/** Path of the `--output-txt` transcript file next to `audioPath`. */
function transcriptFilePath(audioPath) {
  const base = path.basename(audioPath).replace(/\.[^.]+$/, '');
  return path.join(path.dirname(audioPath), `${base}.txt`);
}

/**
 * Reads the transcript from `--output-txt`'s output file (next to the audio
 * file, named `<basename>.txt` — verified empirically on 1.12.0). Returns
 * the text, or null when the file is missing/empty so the caller can fall
 * back to console parsing.
 * @param {string} audioPath
 * @returns {Promise<string|null>}
 */
async function readTranscriptFile(audioPath) {
  const txtPath = transcriptFilePath(audioPath);
  try {
    const text = (await readFile(txtPath, 'utf8')).trim();
    await rm(txtPath, { force: true }).catch(() => {});
    return text.length > 0 ? text : null;
  } catch {
    await rm(txtPath, { force: true }).catch(() => {});
    return null;
  }
}

/** Last non-empty line of console output, as a transcript fallback. */
function lastNonEmptyLine(stdout) {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  return lines.length > 0 ? lines[lines.length - 1] : '';
}

/**
 * Runs one transcription. V1 launches Whisper per-request (per spec §71/§113
 * this is an accepted trade-off; a persistent worker is a documented V2
 * extension point once perf data justifies it).
 * @param {WhisperRunOptions} opts
 * @returns {Promise<WhisperResult>}
 */
export async function runWhisper(opts) {
  await assertExists(opts.exePath, 'Whisper executable');
  await assertExists(opts.modelPath, 'Whisper model');
  await assertExists(opts.audioPath, 'Audio file');

  const args = buildWhisperArgs(opts);
  const start = Date.now();
  const txtPath = transcriptFilePath(opts.audioPath);

  return new Promise((resolve, reject) => {
    const child = spawn(opts.exePath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      rm(txtPath, { force: true }).catch(() => {});
      reject(new WhisperInvocationError(`Whisper timed out after ${opts.timeoutMs ?? 60_000}ms`));
    }, opts.timeoutMs ?? 60_000);
    timeout.unref?.();

    child.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    child.on('error', (err) => {
      clearTimeout(timeout);
      rm(txtPath, { force: true }).catch(() => {});
      reject(new WhisperInvocationError(`Failed to launch Whisper: ${err.message}`));
    });
    child.on('close', async (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        await rm(txtPath, { force: true }).catch(() => {});
        reject(new WhisperInvocationError(`Whisper exited with code ${code}: ${stderr.trim() || stdout.trim()}`));
        return;
      }
      const fromFile = await readTranscriptFile(opts.audioPath);
      const text = fromFile ?? lastNonEmptyLine(stdout);
      resolve({ text, durationMs: Date.now() - start });
    });
  });
}

/**
 * Resolves and validates an audio/model path against the expected voice-temp / models directory.
 * @param {string} baseDir
 * @param {string} filename
 * @returns {string}
 */
export function resolveVoiceFile(baseDir, filename) {
  return safeJoin(baseDir, filename);
}
