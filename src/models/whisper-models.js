// src/models/whisper-models.js
// Single registry for all downloadable Whisper models. Per spec §4/§6,
// the ggerganov/whisper.cpp Hugging Face repo is the official source, and
// the default model MUST be the multilingual Base model (ggml-base.bin,
// NOT ggml-base.en.bin).

import { ValidationError } from '../shared/validation.js';

const HF_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

function mb(n) {
  return n * 1024 * 1024;
}

/**
 * NOTE: approxSizeBytes values are the commonly published approximate sizes
 * for these ggml models; sha256 is left undefined here and SHOULD be
 * populated from Hugging Face's file metadata at build/release time (the
 * downloader treats a missing sha256 as "integrity check skipped", never as
 * "verified" — see models/downloader.ts).
 *
 * IMPORTANT — f16 models only: the bundled runtime is Const-me/Whisper
 * (DirectCompute GPGPU), whose Readme states "Mixed F16 / F32 precision" —
 * it has NO support for the q5_0/q5_1/q8_0 ggml quantizations. Verified
 * live with the installed 1.12.0 binary (2026-09-16): a byte-complete
 * ggml-tiny-q5_1.bin fails with "failed to load the model: Reached the end
 * of the file." and ggml-tiny-q8_0.bin with "The parameter is incorrect."
 * The 10 quantized variants that used to be listed here (tiny-q5, tiny-q8,
 * base-q5, base-q8, small-q5, small-q8, medium-q5, medium-q8, large-q5,
 * large-q8) were REMOVED rather than kept as non-working list items: they
 * would download fine, report "installed", and then fail every transcription
 * with an opaque runtime error. If the runtime ever gains quantized support,
 * re-add them here (and the UI/API pick them up automatically).
 */
/** @type {readonly import('../shared/types.js').WhisperModelDescriptor[]} */
export const WHISPER_MODELS = [
  { id: 'tiny', filename: 'ggml-tiny.bin', displayName: 'Whisper Tiny — Multilingual', languageMode: 'multilingual', url: `${HF_BASE}/ggml-tiny.bin`, approxSizeBytes: mb(75), officialSource: HF_BASE },

  { id: 'base', filename: 'ggml-base.bin', displayName: 'Whisper Base — Multilingual', languageMode: 'multilingual', url: `${HF_BASE}/ggml-base.bin`, approxSizeBytes: mb(148), officialSource: HF_BASE },

  { id: 'small', filename: 'ggml-small.bin', displayName: 'Whisper Small — Multilingual', languageMode: 'multilingual', url: `${HF_BASE}/ggml-small.bin`, approxSizeBytes: mb(488), officialSource: HF_BASE },

  { id: 'medium', filename: 'ggml-medium.bin', displayName: 'Whisper Medium — Multilingual', languageMode: 'multilingual', url: `${HF_BASE}/ggml-medium.bin`, approxSizeBytes: mb(1533), officialSource: HF_BASE },

  { id: 'large', filename: 'ggml-large-v3.bin', displayName: 'Whisper Large — Multilingual', languageMode: 'multilingual', url: `${HF_BASE}/ggml-large-v3.bin`, approxSizeBytes: mb(3094), officialSource: HF_BASE },
];

export const DEFAULT_WHISPER_MODEL_ID = 'base';

/**
 * @param {string} id
 * @returns {import('../shared/types.js').WhisperModelDescriptor}
 */
export function getWhisperModel(id) {
  const found = WHISPER_MODELS.find((m) => m.id === id);
  // ValidationError (not a bare Error) so HTTP callers surface a 400 with this
  // message instead of an opaque 500 — e.g. a removed quantized id from a
  // stale client or config.
  if (!found) throw new ValidationError(`Unknown Whisper model id: ${id}`);
  return found;
}

/** @returns {readonly import('../shared/types.js').WhisperModelDescriptor[]} */
export function listWhisperModels() {
  return WHISPER_MODELS;
}
