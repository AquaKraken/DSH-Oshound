// src/host/runtime-manager.js
// Detects (and can install) the Const-me Whisper and Piper runtimes.
//
// RESOLVED AGAINST THE REAL RELEASES (2026-09-13, both installed and
// verified end-to-end on this machine):
//
//   Whisper — Const-me/Whisper 1.12.0, asset `cli.zip` from
//     https://github.com/Const-me/Whisper/releases/tag/1.12.0
//     The zip is a self-contained CLI (CPU + GPU auto-select) and ships
//     THREE files that must all live together in runtime\whisper\ :
//       main.exe, Whisper.dll, lz4.txt
//     main.exe without Whisper.dll next to it will not start.
//
//   Piper — legacy rhasspy/piper 2023.11.14-2 (NOT the piper1-gpl fork;
//     the user explicitly chose the legacy binary), asset
//     `piper_windows_amd64.zip` — the only Windows release in that repo's
//     history, from
//     https://github.com/rhasspy/piper/releases/tag/2023.11.14-2
//     The zip's whole folder must land in runtime\piper\ : piper.exe plus
//     espeak-ng.dll, onnxruntime*.dll, piper_phonemize.dll,
//     libtashkeel_model.ort AND the 360-file espeak-ng-data\ tree.

import { spawn } from 'node:child_process';
import { rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { downloadFile, DownloadQueue } from '../models/downloader.js';

/**
 * @typedef {Object} RuntimePaths
 * @property {string} whisperExe - e.g. %USERPROFILE%\.dsh\runtime\whisper\main.exe
 * @property {string} whisperDll - Whisper.dll, must sit next to main.exe
 * @property {string} piperExe - e.g. %USERPROFILE%\.dsh\runtime\piper\piper.exe
 * @property {string} piperPhontab - espeak-ng-data\phontab: marker for a COMPLETE Piper folder (see SILENT-COPY LESSON)
 */

/** Pinned release URLs (tag pages) + the exact asset name to fetch from each. */
export const RUNTIME_RELEASE_URLS = {
  whisper: {
    page: 'https://github.com/Const-me/Whisper/releases/tag/1.12.0',
    asset: 'cli.zip',
    url: 'https://github.com/Const-me/Whisper/releases/download/1.12.0/cli.zip',
  },
  piper: {
    page: 'https://github.com/rhasspy/piper/releases/tag/2023.11.14-2',
    asset: 'piper_windows_amd64.zip',
    url: 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip',
  },
};

/** @param {string} p @returns {Promise<boolean>} */
async function fileExists(p) {
  try {
    const s = await stat(p);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

/** Escapes single quotes for PowerShell single-quoted string literals (`'` -> `''`). */
function psEscapeLiteralPath(p) {
  return String(p).replace(/'/g, "''");
}

export class RuntimeManager {
  activeDownloads = new Map();

  /**
   * @param {RuntimePaths} paths
   * @param {DownloadQueue} [downloadQueue]
   */
  constructor(paths, downloadQueue = new DownloadQueue()) {
    this.paths = paths;
    this.downloadQueue = downloadQueue;
  }

  /**
   * @returns {Promise<{state: import('../shared/types.js').InstallState, missing: string[]}>}
   */
  async checkWhisper() {
    const missing = [];
    if (!(await fileExists(this.paths.whisperExe))) missing.push('main.exe');
    if (!(await fileExists(this.paths.whisperDll))) missing.push('Whisper.dll');
    const dlState = this.getDownloadState('whisper');
    return { state: missing.length === 0 ? 'installed' : 'not-installed', missing, downloadState: dlState };
  }

  /**
   * @returns {Promise<{state: import('../shared/types.js').InstallState, missing: string[]}>}
   */
  async checkPiper() {
    const missing = [];
    if (!(await fileExists(this.paths.piperExe))) missing.push('piper.exe');
    if (!(await fileExists(this.paths.piperPhontab))) missing.push('espeak-ng-data\\ (incomplete copy — use robocopy src dst /E to reinstall)');
    const dlState = this.getDownloadState('piper');
    return { state: missing.length === 0 ? 'installed' : 'not-installed', missing, downloadState: dlState };
  }

  /**
   * Returns 'downloading', 'queued', or null for a runtime ('whisper' | 'piper').
   * @param {'whisper'|'piper'} kind
   * @returns {'downloading'|'queued'|null}
   */
  getDownloadState(kind) {
    const qState = this.downloadQueue.getState(`runtime:${kind}`);
    if (qState) return qState;
    return this.activeDownloads.has(kind) ? 'downloading' : null;
  }

  /**
   * Backward-compatible shape for diagnostics (state only, per runtime).
   * @returns {Promise<{whisper: import('../shared/types.js').InstallState, piper: import('../shared/types.js').InstallState}>}
   */
  async checkAll() {
    const [whisper, piper] = await Promise.all([this.checkWhisper(), this.checkPiper()]);
    return { whisper: whisper.state, piper: piper.state };
  }

  getWhisperExePath() {
    return this.paths.whisperExe;
  }

  getPiperExePath() {
    return this.paths.piperExe;
  }

  /**
   * Downloads and extracts one runtime in place via the capped DownloadQueue.
   * Windows-only by design (this plugin targets Windows).
   * @param {'whisper'|'piper'} kind
   * @param {(p: import('../shared/types.js').DownloadProgress) => void} [onProgress]
   * @returns {Promise<void>}
   */
  async installRuntime(kind, onProgress) {
    const release = RUNTIME_RELEASE_URLS[kind];
    if (!release) throw new Error(`Unknown runtime kind: ${kind}`);
    const dir = kind === 'whisper' ? path.dirname(this.paths.whisperExe) : path.dirname(this.paths.piperExe);
    const zipPath = path.join(dir, release.asset);
    const queueKey = `runtime:${kind}`;

    return this.downloadQueue.enqueue(queueKey, async (signal, reportProgress) => {
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
      this.activeDownloads.set(kind, controller);

      try {
        await downloadFile({
          id: `runtime-${kind}`,
          url: release.url,
          destDir: dir,
          destFilename: release.asset,
          onProgress: (p) => {
            reportProgress(p);
            onProgress?.(p);
          },
          signal: controller.signal,
        });

        try {
          await this._extract(zipPath, dir, controller.signal);
        } finally {
          await rm(zipPath, { force: true }).catch(() => {});
        }
      } finally {
        signal.removeEventListener('abort', onAbort);
        this.activeDownloads.delete(kind);
      }
    });
  }

  /**
   * Cancels an in-flight or queued runtime install.
   * @param {'whisper'|'piper'} kind
   */
  cancelInstall(kind) {
    this.downloadQueue.cancel(`runtime:${kind}`);
    this.activeDownloads.get(kind)?.abort();
  }

  /** @param {string} zipPath @param {string} destDir @param {AbortSignal} [signal] */
  _extract(zipPath, destDir, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error(`Runtime extraction cancelled`));
        return;
      }
      const safeZip = psEscapeLiteralPath(zipPath);
      const safeDest = psEscapeLiteralPath(destDir);
      const ps = spawn(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
          `Expand-Archive -LiteralPath '${safeZip}' -DestinationPath '${safeDest}' -Force`],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stderr = '';
      let aborted = false;
      const onAbort = () => {
        aborted = true;
        try { ps.kill(); } catch { /* already gone */ }
      };
      const timeout = setTimeout(() => {
        try { ps.kill(); } catch { /* already gone */ }
        reject(new Error('Expand-Archive timed out after 180s'));
      }, 180_000);
      timeout.unref?.();
      signal?.addEventListener('abort', onAbort, { once: true });

      ps.stderr.on('data', (d) => (stderr += d.toString('utf8')));
      ps.on('error', (err) => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        reject(new Error(`Failed to launch PowerShell: ${err.message}`));
      });
      ps.on('close', (code) => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        if (aborted) reject(new Error('Runtime extraction cancelled'));
        else if (code !== 0) reject(new Error(`Expand-Archive failed (exit ${code}): ${stderr.trim()}`));
        else resolve();
      });
    });
  }

  /** @param {string} dshHome @returns {RuntimePaths} */
  static defaultPaths(dshHome) {
    return {
      whisperExe: path.join(dshHome, 'runtime', 'whisper', 'main.exe'),
      whisperDll: path.join(dshHome, 'runtime', 'whisper', 'Whisper.dll'),
      piperExe: path.join(dshHome, 'runtime', 'piper', 'piper.exe'),
      piperPhontab: path.join(dshHome, 'runtime', 'piper', 'espeak-ng-data', 'phontab'),
    };
  }
}
