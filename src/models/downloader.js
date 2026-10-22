// src/models/downloader.js
// Shared download engine and capped download queue for Whisper models, Piper
// voice files, and runtimes.
// Flow (per spec §5/§23/§92): metadata -> temp file -> progress -> verify
// (when a checksum is known) -> atomic rename into place -> installed.
// Never marks anything installed until the final file(s) exist and, when a
// checksum was provided, verifies.

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ALLOWED_DOWNLOAD_HOSTS, assertHttpsUrl, safeJoin } from '../shared/validation.js';

/**
 * @typedef {Object} DownloadRequest
 * @property {string} id
 * @property {string} url
 * @property {string} destDir
 * @property {string} destFilename
 * @property {string} [sha256]
 * @property {(p: import('../shared/types.js').DownloadProgress) => void} [onProgress]
 * @property {AbortSignal} [signal]
 * @property {number} [stallTimeoutMs]
 */

export class DownloadCancelledError extends Error {}
export class DownloadIntegrityError extends Error {}
export class DownloadStallError extends Error {}

/** Default max concurrent downloads across the plugin. */
export const DEFAULT_MAX_CONCURRENT_DOWNLOADS = 2;
/** Default stall timeout (ms without receiving any data before aborting). */
export const DEFAULT_STALL_TIMEOUT_MS = 60_000;

/**
 * Capped concurrent download queue (v0.5.1):
 * Allows up to `maxConcurrent` downloads to run in parallel while queueing
 * additional downloads in FIFO order. Supports deduplicating identical `id`s,
 * querying per-item state ('downloading' | 'queued'), and cancelling both
 * active ('downloading') and waiting ('queued') tasks.
 */
export class DownloadQueue {
  /**
   * @param {number} [maxConcurrent=DEFAULT_MAX_CONCURRENT_DOWNLOADS]
   */
  constructor(maxConcurrent = DEFAULT_MAX_CONCURRENT_DOWNLOADS) {
    this.maxConcurrent = Math.max(1, maxConcurrent);
    /** @type {Map<string, { id: string, controller: AbortController, progress: object|null, promise: Promise<any> }>} */
    this.active = new Map();
    /** @type {Array<{ id: string, controller: AbortController, run: (signal: AbortSignal, onProgress: (p: any) => void) => Promise<any>, resolve: Function, reject: Function, promise: Promise<any> }>} */
    this.waiting = [];
  }

  /**
   * Enqueues a download task identified by `id`. If `id` is already active or
   * queued, returns the existing promise instead of starting a duplicate.
   * @template T
   * @param {string} id
   * @param {(signal: AbortSignal, onProgress: (p: any) => void) => Promise<T>} run
   * @returns {Promise<T>}
   */
  enqueue(id, run) {
    const existingActive = this.active.get(id);
    if (existingActive) return existingActive.promise;
    const existingWaiting = this.waiting.find((w) => w.id === id);
    if (existingWaiting) return existingWaiting.promise;

    const controller = new AbortController();
    let resolveOuter, rejectOuter;
    const promise = new Promise((resolve, reject) => {
      resolveOuter = resolve;
      rejectOuter = reject;
    });

    const item = {
      id,
      controller,
      run,
      resolve: resolveOuter,
      reject: rejectOuter,
      promise,
    };
    this.waiting.push(item);
    this._pump();
    return promise;
  }

  _pump() {
    while (this.active.size < this.maxConcurrent && this.waiting.length > 0) {
      const item = this.waiting.shift();
      if (!item) break;
      if (item.controller.signal.aborted) {
        item.reject(new DownloadCancelledError(`Download cancelled: ${item.id}`));
        continue;
      }
      const activeEntry = {
        id: item.id,
        controller: item.controller,
        progress: { id: item.id, downloadedBytes: 0, totalBytes: 0, percent: 0, state: 'downloading' },
        promise: item.promise,
      };
      this.active.set(item.id, activeEntry);

      void (async () => {
        try {
          const result = await item.run(item.controller.signal, (p) => {
            activeEntry.progress = { ...activeEntry.progress, ...p };
          });
          item.resolve(result);
        } catch (err) {
          item.reject(err);
        } finally {
          this.active.delete(item.id);
          this._pump();
        }
      })();
    }
  }

  /**
   * Cancels a download by `id` whether it is currently queued or actively downloading.
   * @param {string} id
   * @returns {boolean} true if found and cancelled
   */
  cancel(id) {
    const qIdx = this.waiting.findIndex((w) => w.id === id);
    if (qIdx !== -1) {
      const [item] = this.waiting.splice(qIdx, 1);
      item.controller.abort();
      item.reject(new DownloadCancelledError(`Download cancelled: ${id}`));
      return true;
    }
    const act = this.active.get(id);
    if (act) {
      act.controller.abort();
      return true;
    }
    return false;
  }

  /**
   * @param {string} id
   * @returns {'downloading'|'queued'|null}
   */
  getState(id) {
    if (this.active.has(id)) return 'downloading';
    if (this.waiting.some((w) => w.id === id)) return 'queued';
    return null;
  }

  /**
   * @param {string} id
   * @returns {boolean}
   */
  has(id) {
    return this.getState(id) !== null;
  }

  /**
   * Snapshot of all active and queued downloads for `/status` and UI polling.
   */
  snapshot() {
    const items = {};
    for (const [id, entry] of this.active.entries()) {
      items[id] = {
        state: 'downloading',
        percent: entry.progress?.percent ?? 0,
        downloadedBytes: entry.progress?.downloadedBytes ?? 0,
        totalBytes: entry.progress?.totalBytes ?? 0,
      };
    }
    for (const w of this.waiting) {
      items[w.id] = {
        state: 'queued',
        percent: 0,
        downloadedBytes: 0,
        totalBytes: 0,
      };
    }
    return {
      maxConcurrent: this.maxConcurrent,
      activeCount: this.active.size,
      queuedCount: this.waiting.length,
      items,
    };
  }
}

/**
 * Downloads `url` to a `.part` temp file under `destDir`, optionally
 * verifies its sha256, then atomically renames it to `destFilename`.
 * Throws (and cleans up the partial file) on any failure, stall, or cancellation.
 * @param {DownloadRequest} req
 * @returns {Promise<string>}
 */
export async function downloadFile(req) {
  assertHttpsUrl(req.url, ALLOWED_DOWNLOAD_HOSTS);
  await mkdir(req.destDir, { recursive: true });
  const finalPath = safeJoin(req.destDir, req.destFilename);
  const tempPath = `${finalPath}.part`;

  const emit = (partial) => req.onProgress?.({ id: req.id, ...partial });

  const stallMs = req.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
  const stallController = new AbortController();
  let stalled = false;
  let stallTimer = null;

  const resetStallTimer = () => {
    if (stallTimer) clearTimeout(stallTimer);
    if (stallMs > 0) {
      stallTimer = setTimeout(() => {
        stalled = true;
        stallController.abort();
      }, stallMs);
      stallTimer.unref?.();
    }
  };

  const onCallerAbort = () => stallController.abort();
  if (req.signal) {
    if (req.signal.aborted) stallController.abort();
    else req.signal.addEventListener('abort', onCallerAbort, { once: true });
  }

  try {
    resetStallTimer();
    const response = await fetch(req.url, { signal: stallController.signal });
    if (!response.ok || !response.body) {
      throw new Error(`Download failed: HTTP ${response.status}`);
    }
    const totalBytes = Number(response.headers.get('content-length') ?? 0);
    let downloadedBytes = 0;
    const hash = createHash('sha256');

    const nodeReadable = Readable.fromWeb(response.body);
    const writeStream = createWriteStream(tempPath);

    nodeReadable.on('data', (chunk) => {
      resetStallTimer();
      downloadedBytes += chunk.length;
      hash.update(chunk);
      emit({
        downloadedBytes,
        totalBytes,
        percent: totalBytes ? Math.round((downloadedBytes / totalBytes) * 100) : 0,
        state: 'downloading',
      });
    });

    await pipeline(nodeReadable, writeStream, { signal: stallController.signal });
    if (stallTimer) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }

    if (req.sha256) {
      emit({ downloadedBytes, totalBytes, percent: 100, state: 'verifying' });
      const digest = hash.digest('hex');
      if (digest.toLowerCase() !== req.sha256.toLowerCase()) {
        throw new DownloadIntegrityError(`Checksum mismatch for ${req.destFilename}`);
      }
    }

    const fileStat = await stat(tempPath);
    if (fileStat.size === 0) {
      throw new Error(`Downloaded file is empty: ${req.destFilename}`);
    }

    await rename(tempPath, finalPath);
    emit({ downloadedBytes, totalBytes, percent: 100, state: 'done' });
    return finalPath;
  } catch (err) {
    if (stallTimer) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
    await rm(tempPath, { force: true }).catch(() => {});
    if (req.signal?.aborted) {
      emit({ downloadedBytes: 0, totalBytes: 0, percent: 0, state: 'cancelled' });
      throw new DownloadCancelledError(`Download cancelled: ${req.destFilename}`);
    }
    if (stalled) {
      const stallErr = new DownloadStallError(`Download stalled (no data for ${Math.round(stallMs / 1000)}s): ${req.destFilename}`);
      emit({ downloadedBytes: 0, totalBytes: 0, percent: 0, state: 'error', error: stallErr.message });
      throw stallErr;
    }
    emit({ downloadedBytes: 0, totalBytes: 0, percent: 0, state: 'error', error: err.message });
    throw err;
  } finally {
    req.signal?.removeEventListener('abort', onCallerAbort);
  }
}

/**
 * True only if every required file exists on disk. Never trust a cached boolean flag instead.
 * @param {string[]} paths
 * @returns {Promise<boolean>}
 */
export async function filesExist(paths) {
  for (const p of paths) {
    try {
      const s = await stat(p);
      if (!s.isFile() || s.size === 0) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * @param {string} baseDir
 * @param {...string} segments
 * @returns {string}
 */
export function joinModelPath(baseDir, ...segments) {
  return path.join(baseDir, ...segments);
}
