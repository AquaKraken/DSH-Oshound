// src/host/model-manager.js
// ModelManager for Whisper models — the conceptual API from spec §110,
// wired to the real registry (models/whisper-models.js), downloader
// (models/downloader.js), and capped DownloadQueue (v0.5.1).

import { rm } from 'node:fs/promises';
import path from 'node:path';
import { downloadFile, DownloadQueue, filesExist } from '../models/downloader.js';
import { getWhisperModel, listWhisperModels } from '../models/whisper-models.js';
import { assertSafeId } from '../shared/validation.js';

export class ModelManager {
  activeDownloads = new Map();

  /**
   * @param {string} whisperModelsDir
   * @param {DownloadQueue} [downloadQueue]
   */
  constructor(whisperModelsDir, downloadQueue = new DownloadQueue()) {
    this.whisperModelsDir = whisperModelsDir;
    this.downloadQueue = downloadQueue;
  }

  listModels() {
    return listWhisperModels();
  }

  /** @param {string} id */
  getModel(id) {
    return getWhisperModel(assertSafeId(id, 'whisper model'));
  }

  /** @param {string} id */
  modelPath(id) {
    return path.join(this.whisperModelsDir, this.getModel(id).filename);
  }

  /** @param {string} id @returns {Promise<import('../shared/types.js').InstallState>} */
  async isInstalled(id) {
    const installed = await filesExist([this.modelPath(id)]);
    return installed ? 'installed' : 'not-installed';
  }

  /**
   * Returns 'downloading', 'queued', or null for the given model id.
   * @param {string} id
   * @returns {'downloading'|'queued'|null}
   */
  getDownloadState(id) {
    const qState = this.downloadQueue.getState(`whisper-model:${id}`);
    if (qState) return qState;
    return this.activeDownloads.has(id) ? 'downloading' : null;
  }

  /**
   * @param {string} id
   * @param {(p: import('../shared/types.js').DownloadProgress) => void} [onProgress]
   */
  async download(id, onProgress) {
    const model = this.getModel(id);
    const queueKey = `whisper-model:${id}`;
    return this.downloadQueue.enqueue(queueKey, async (signal, reportProgress) => {
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
      this.activeDownloads.set(id, controller);
      try {
        await downloadFile({
          id,
          url: model.url,
          destDir: this.whisperModelsDir,
          destFilename: model.filename,
          sha256: model.sha256,
          onProgress: (p) => {
            reportProgress(p);
            onProgress?.(p);
          },
          signal: controller.signal,
        });
      } finally {
        signal.removeEventListener('abort', onAbort);
        this.activeDownloads.delete(id);
      }
    });
  }

  /** @param {string} id */
  cancelDownload(id) {
    this.downloadQueue.cancel(`whisper-model:${id}`);
    this.activeDownloads.get(id)?.abort();
  }

  /** @param {string} id */
  async remove(id) {
    await rm(this.modelPath(id), { force: true });
  }

  /** @param {string} id */
  async verify(id) {
    return filesExist([this.modelPath(id)]);
  }
}
