// src/host/diagnostics.js
// Builds the Settings -> Voice -> Diagnostics report (spec §64).

import { filesExist } from '../models/downloader.js';
import path from 'node:path';

/**
 * @typedef {Object} DiagnosticsDeps
 * @property {import('./runtime-manager.js').RuntimeManager} runtimeManager
 * @property {import('./model-manager.js').ModelManager} modelManager
 * @property {import('../models/piper-catalogue.js').PiperCatalogue} piperCatalogue
 * @property {string} piperVoicesDir
 * @property {import('../shared/types.js').OSoundConfig} config
 * @property {() => Promise<boolean>} microphoneAvailable
 * @property {() => Promise<boolean>} audioOutputAvailable
 */

/**
 * @param {DiagnosticsDeps} deps
 * @returns {Promise<import('../shared/types.js').DiagnosticsReport>}
 */
export async function buildDiagnosticsReport(deps) {
  const { runtimeManager, modelManager, piperCatalogue, piperVoicesDir, config } = deps;
  const details = {};

  const runtimes = await runtimeManager.checkAll();

  // config.whisperModel is a free-form string in the schema (see
  // host/config.js) — sanitizeConfig now rejects unknown ids on the way
  // in, but diagnostics must stay defensive regardless: its entire job is
  // to report health without ever being the thing that crashes the host.
  // modelManager.getModel()/isInstalled() throw for an unknown id, so both
  // calls are guarded here rather than trusting the caller's config.
  let whisperModel = 'error';
  let whisperModelName = `Unknown model id: ${config.whisperModel}`;
  try {
    whisperModel = await modelManager.isInstalled(config.whisperModel);
    whisperModelName = modelManager.getModel(config.whisperModel).displayName;
  } catch (err) {
    details.whisperModelError = err.message;
  }

  const voice = piperCatalogue.getVoice(config.piperVoiceKey);
  let piperVoiceState = 'not-installed';
  if (voice) {
    const dir = path.join(piperVoicesDir, voice.key);
    const installed = await filesExist([path.join(dir, `${voice.key}.onnx`), path.join(dir, `${voice.key}.onnx.json`)]);
    piperVoiceState = installed ? 'installed' : 'not-installed';
    details.piperVoice = `${voice.language} / ${voice.region} / ${voice.name} / ${voice.quality}`;
  } else {
    details.piperVoice = 'No voice selected';
  }

  const micOk = await deps.microphoneAvailable().catch(() => false);
  const outOk = await deps.audioOutputAvailable().catch(() => false);
  const catalogueOk = piperCatalogue.all().length > 0;

  details.whisperModel = whisperModelName;
  details.catalogueVoiceCount = String(piperCatalogue.all().length);
  details.catalogueLastRefreshed = piperCatalogue.getLastRefreshed()
    ? new Date(piperCatalogue.getLastRefreshed()).toISOString()
    : 'never (using bundled/cached data)';

  return {
    dshIntegration: 'installed', // if this code is running inside a loaded Cordis context, integration succeeded
    platform: process.platform === 'win32' ? 'installed' : 'error',
    whisperRuntime: runtimes.whisper,
    whisperModel,
    piperRuntime: runtimes.piper,
    piperVoice: piperVoiceState,
    microphone: micOk ? 'installed' : 'error',
    audioOutput: outOk ? 'installed' : 'error',
    catalogue: catalogueOk ? 'installed' : 'error',
    details,
  };
}
