// src/stt/rms.js
// Silence gate for STT (2026-10-06): computes the RMS level (dBFS) of a
// recorded WAV so VoiceService.transcribe() can skip Whisper entirely on
// silence. The RIFF/PCM16 parsing lives in src/shared/wav-pcm16.js (shared
// with the TTS WAV post-processing). A null result means "gate skipped" —
// unparseable audio is NEVER treated as silence.

import { parsePcm16Wav, pcm16RmsLinear } from '../shared/wav-pcm16.js';

export { parsePcm16Wav };

/**
 * RMS level of a PCM16 WAV buffer in dBFS (0 dBFS = full scale).
 * @param {Buffer} buffer
 * @returns {number|null} null when the buffer is not a parseable PCM16 WAV
 *                        (the caller must then skip the gate, not treat it
 *                        as silence).
 */
export function computeWavRmsDbfs(buffer) {
  const wav = parsePcm16Wav(buffer);
  if (!wav) return null;
  const rms = pcm16RmsLinear(wav.data, wav.channels);
  if (rms === 0) return -120; // full silence (below any sane threshold)
  return 20 * Math.log10(rms / 32768);
}
