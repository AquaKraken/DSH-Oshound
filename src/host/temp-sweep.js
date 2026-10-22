// src/host/temp-sweep.js
// Removes stale temporary audio files from the voice temp directory.
// Why: interrupted TTS chunks (client vanished mid-publish, watchdog
// abandonment, host restart) and zero-byte recordings (mic stopped before
// any data) leave orphan WAVs behind — observed live 2026-09-21: five
// stale files in %USERPROFILE%\.dsh\voice\temp, two of them zero bytes,
// none of them cleaned up by anything. The sweep runs once at plugin
// startup and is conservative on purpose:
//   - only TOP-LEVEL regular files (never subdirectories, never trees),
//   - only files older than the threshold (an in-flight job's files are
//     minutes old at most),
//   - per-file failures are counted and skipped, never thrown,
//   - a missing/unreadable directory is a no-op, not an error.

import path from 'node:path';
import { readdir, rm, stat } from 'node:fs/promises';

/**
 * @typedef {Object} SweepResult
 * @property {number} deleted - files removed
 * @property {number} failed - files that could not be removed (skipped)
 */

/**
 * Deletes top-level files in `dir` whose mtime is older than `olderThanMs`.
 * @param {string} dir
 * @param {number} olderThanMs
 * @param {number} [now] - injectable clock for tests
 * @returns {Promise<SweepResult>}
 */
export async function sweepStaleTempFiles(dir, olderThanMs, now = Date.now()) {
  const result = { deleted: 0, failed: 0 };
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return result; // missing or unreadable dir: nothing to do, never throw
  }
  for (const name of entries) {
    const p = path.join(dir, name);
    try {
      const s = await stat(p);
      if (!s.isFile()) continue; // subdirectories are kept — this sweep never deletes trees
      if (now - s.mtimeMs <= olderThanMs) continue; // fresh: an in-flight job may still own it
      await rm(p, { force: true });
      result.deleted += 1;
    } catch {
      result.failed += 1; // per-file failure (locked, vanished, permission): skip, never throw
    }
  }
  return result;
}
