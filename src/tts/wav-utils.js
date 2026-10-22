// src/tts/wav-utils.js
// Post-processing of synthesized chunk WAVs before playback (2026-10-06):
//   * level match — rescale the chunk's PCM so its RMS sits at a fixed target
//     level (reduces the loudness jumps between chunks of one response);
//   * trailing silence — append N ms of silence to every chunk except the
//     last (a natural breathing pause between sentence groups).
// Both are BEST-EFFORT: any problem (file missing, not PCM16, disk error)
// leaves the original file untouched and returns false — post-processing must
// never break the TTS pipeline.

import { readFile, writeFile } from 'node:fs/promises';
import { parsePcm16Wav, rebuildPcm16Wav, pcm16RmsLinear } from '../shared/wav-pcm16.js';

/** Target RMS for level match, in dBFS (-6 dB ≈ comfortably loud without clipping). */
export const LEVEL_MATCH_TARGET_DB = -6;
/** Max gain applied by level match (20 dB) — near-silent chunks are not amplified to pure noise. */
const MAX_LEVEL_GAIN = 10;

/**
 * @param {string} wavPath
 * @param {{levelMatch?: boolean, trailingSilenceMs?: number, targetDb?: number, log?: (m: string) => void}} opts
 * @returns {Promise<boolean>} true when the file was rewritten.
 */
export async function postProcessTtsWav(wavPath, { levelMatch = false, trailingSilenceMs = 0, targetDb = LEVEL_MATCH_TARGET_DB, log } = {}) {
  try {
    const buf = await readFile(wavPath);
    const wav = parsePcm16Wav(buf);
    if (!wav) return false; // not a PCM16 WAV Piper wrote — leave it alone

    let data = Buffer.from(wav.data); // copy: subarray must not alias the file buffer

    if (levelMatch) {
      const rms = pcm16RmsLinear(data, wav.channels);
      if (rms > 0) {
        const targetLinear = 32768 * 10 ** (targetDb / 20);
        const gain = Math.min(MAX_LEVEL_GAIN, targetLinear / rms);
        if (Math.abs(gain - 1) > 0.001) {
          const out = Buffer.alloc(data.length);
          for (let i = 0; i < data.length; i += 2) {
            const s = Math.max(-32768, Math.min(32767, Math.round(data.readInt16LE(i) * gain)));
            out.writeInt16LE(s, i);
          }
          data = out;
        }
      }
    }

    if (trailingSilenceMs > 0) {
      const samples = Math.floor((trailingSilenceMs / 1000) * wav.sampleRate) * wav.channels;
      if (samples > 0) {
        data = Buffer.concat([data, Buffer.alloc(samples * 2)]); // zeros = silence
      }
    }

    await writeFile(wavPath, rebuildPcm16Wav({ sampleRate: wav.sampleRate, channels: wav.channels, data }));
    return true;
  } catch (err) {
    log?.(`[TTS] WAV post-processing skipped for ${wavPath}: ${err.message}`);
    return false;
  }
}
