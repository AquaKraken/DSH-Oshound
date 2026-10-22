// src/client/encode-wav.js
// Decodes a MediaRecorder blob (webm/opus in Chrome/Edge) and re-renders it
// as a 16 kHz mono PCM16 WAV — the format the host's Whisper CLI ingests
// directly (its Media Foundation input path handles WAV unambiguously,
// where webm/opus container support is driver-dependent).
//
// Two entry points:
//   * encodeWav16kMono(blob) — the WHOLE recording (the final STT pass).
//   * encodeWav16kMonoFromBuffer(decoded, fromSec, toSec) — a TIME RANGE of
//     an already-decoded buffer (the incremental STT windows: the client
//     decodes the accumulating recording once per window and renders only the
//     trailing window slice, so a 3-second window costs 3 seconds of WAV,
//     not the whole recording).

const TARGET_RATE = 16000;

/**
 * Decodes a browser-audio blob (webm/opus, mp4, ...) to an AudioBuffer at its
 * native sample rate. The AudioContext is throwaway (created + closed here).
 * @param {Blob} blob
 * @returns {Promise<AudioBuffer>}
 */
export async function decodeBlobToAudioBuffer(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  const decodeCtx = new AC();
  let decoded;
  try {
    decoded = await decodeCtx.decodeAudioData(arrayBuffer);
  } finally {
    decodeCtx.close().catch(() => {});
  }
  return decoded;
}

/** Builds the 44-byte-header 16 kHz mono PCM16 WAV around a Float32 channel.
 * @param {Float32Array} mono @returns {ArrayBuffer}
 */
function buildWav16kMono(mono) {
  const buf = new ArrayBuffer(44 + mono.length * 2);
  const dv = new DataView(buf);
  const ws = (off, s) => {
    for (let i = 0; i < s.length; i += 1) dv.setUint8(off + i, s.charCodeAt(i));
  };
  ws(0, 'RIFF');
  dv.setUint32(4, 36 + mono.length * 2, true);
  ws(8, 'WAVE');
  ws(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, TARGET_RATE, true);
  dv.setUint32(28, TARGET_RATE * 2, true); // byte rate
  dv.setUint16(32, 2, true); // block align
  dv.setUint16(34, 16, true); // bits per sample
  ws(36, 'data');
  dv.setUint32(40, mono.length * 2, true);
  for (let i = 0; i < mono.length; i += 1) {
    const s = Math.max(-1, Math.min(1, mono[i]));
    dv.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

/**
 * Renders the range [fromSec, toSec) of a decoded AudioBuffer as 16 kHz mono
 * PCM16 WAV (resampling happens in the OfflineAudioContext). Clamps to the
 * buffer's actual extent.
 * @param {AudioBuffer} decoded
 * @param {number} [fromSec]
 * @param {number} [toSec] - defaults to the full duration
 * @returns {Promise<ArrayBuffer>}
 */
export async function encodeWav16kMonoFromBuffer(decoded, fromSec = 0, toSec = decoded.duration) {
  const start = Math.max(0, fromSec);
  const end = Math.min(decoded.duration, toSec);
  const length = Math.max(1, Math.ceil((end - start) * TARGET_RATE));
  const offline = new OfflineAudioContext(1, length, TARGET_RATE);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start(0, start, end - start);
  const rendered = await offline.startRendering();
  return buildWav16kMono(rendered.getChannelData(0));
}

/** @param {Blob} blob @returns {Promise<ArrayBuffer>} 44-byte-header WAV of the whole blob */
export async function encodeWav16kMono(blob) {
  const decoded = await decodeBlobToAudioBuffer(blob);
  return encodeWav16kMonoFromBuffer(decoded, 0, decoded.duration);
}

/** Pick the best MediaRecorder mime type the browser supports. */
export function pickMimeType() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  for (const t of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}
