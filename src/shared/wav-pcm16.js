// src/shared/wav-pcm16.js
// Minimal RIFF/PCM16 WAV helpers shared by the STT silence gate (src/stt/rms.js)
// and the TTS post-processing (src/tts/wav-utils.js). Parses the standard
// 44-byte-header layout the client writes (encode-wav.js) and Piper writes,
// but walks RIFF chunks properly so extra chunks don't break it. Anything it
// doesn't understand (non-PCM16, truncated, odd payload) → null / 0, and the
// callers treat that as "leave the file as-is", never as a failure.

/**
 * @typedef {Object} WavInfo
 * @property {number} sampleRate
 * @property {number} channels
 * @property {number} bitsPerSample
 * @property {Buffer} data - the raw 'data' chunk payload
 */

/**
 * Parses a PCM16 WAV buffer. @param {Buffer} buffer
 * @returns {WavInfo|null} null when the buffer is not a parseable PCM16 WAV.
 */
export function parsePcm16Wav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return null;

  let fmt = null;
  let data = null;
  let off = 12;
  while (off + 8 <= buffer.length) {
    const id = buffer.toString('ascii', off, off + 4);
    const size = buffer.readUInt32LE(off + 4);
    const body = off + 8;
    if (body + size > buffer.length) return null; // truncated chunk
    if (id === 'fmt ') {
      if (size < 16) return null;
      const audioFormat = buffer.readUInt16LE(body);
      const channels = buffer.readUInt16LE(body + 2);
      const sampleRate = buffer.readUInt32LE(body + 4);
      const bitsPerSample = buffer.readUInt16LE(body + 14);
      if (audioFormat !== 1 || bitsPerSample !== 16 || channels < 1 || channels > 2) return null; // PCM16 mono/stereo only
      fmt = { channels, sampleRate, bitsPerSample };
    } else if (id === 'data') {
      data = buffer.subarray(body, body + size);
    }
    off = body + size + (size % 2); // chunks are word-aligned
  }
  if (!fmt || !data || data.length === 0) return null;
  return { ...fmt, data };
}

/**
 * Rebuilds a standard 44-byte-header PCM16 WAV around a payload.
 * @param {{sampleRate: number, channels: number, data: Buffer}} wav
 * @returns {Buffer}
 */
export function rebuildPcm16Wav({ sampleRate, channels, data }) {
  const buf = Buffer.alloc(44 + data.length);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + data.length, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * 2, 28); // byte rate
  buf.writeUInt16LE(channels * 2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(data.length, 40);
  data.copy(buf, 44);
  return buf;
}

/**
 * Linear RMS of a PCM16 payload (per-frame, channels averaged).
 * @param {Buffer} data - raw payload (little-endian s16)
 * @param {number} channels
 * @returns {number} 0 for empty/odd payloads (treated as silence by callers).
 */
export function pcm16RmsLinear(data, channels) {
  const frames = (data.length >> 1) / channels;
  if (!Number.isInteger(frames) || frames === 0) return 0;

  let sumSquares = 0;
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) {
      acc += data.readInt16LE((i * channels + c) << 1);
    }
    const s = acc / channels;
    sumSquares += s * s;
  }
  return Math.sqrt(sumSquares / frames);
}
