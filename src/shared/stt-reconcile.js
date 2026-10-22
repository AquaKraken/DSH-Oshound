// src/shared/stt-reconcile.js
// Pure transcript reconciliation for the incremental STT window pipeline.
//
// The Const-me Whisper CLI (1.12.0) is batch-only (verified against the live
// binary: `main.exe [options] file0.wav ...` — no streaming/incremental input,
// and every invocation reloads the model). So O-Sound does NOT do true
// streaming Whisper inference; it runs an INCREMENTAL OVERLAPPING BATCH
// pipeline that behaves like real-time transcription:
//
//   * while the user speaks, the client transcribes the trailing STT_WINDOW_SEC
//     of audio in short windows (stride STT_STRIDE_SEC, i.e. consecutive
//     windows overlap) via the existing stateless POST /stt;
//   * each window's raw transcript is folded into a live partial transcript by
//     reconcileWindow() — the overlap region is matched and NOT re-appended,
//     so repeated windows never duplicate already-transcribed words;
//   * when recording stops, one FINAL transcription of the entire recording
//     (the existing /stt flow) is authoritative and replaces the partial
//     (finalizeTranscript()), which is what guarantees a clean, duplication-
//     free final result even if a window hallucinated or missed words.
//
// This module is DOM-free on purpose: it is imported by the browser bundle
// (MicButton.jsx) and unit-tested in Node (tests/stt-reconcile.test.js).

/**
 * Normalizes text into comparable word tokens: lowercase, every run of
 * non-alphanumerics collapsed to a separator (punctuation AND apostrophes are
 * dropped, so "don't"/"dont" and "hello,"/ "hello" compare equal).
 * @param {string} text
 * @returns {string[]}
 */
export function normalizeWords(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/['’]/g, '') // "don't" -> "dont" (contractions compare equal across windows)
    .replace(/[^0-9a-z]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 0);
}

/**
 * Finds the largest k (0 <= k <= min(len(a), len(w))) such that the LAST k
 * words of `a` match the FIRST k words of `w` position-by-position with at
 * least `minScore` agreement. Scans k from largest down, so the biggest
 * overlap that clears the bar wins; a score bar (not exact equality) absorbs
 * Whisper's occasional word-level flip inside the overlap region.
 * @param {string[]} a - words of the accumulated transcript
 * @param {string[]} w - words of the new window transcript
 * @param {{minScore?: number}} [opts]
 * @returns {number} k — how many leading words of `w` are already covered
 */
export function findOverlap(a, w, opts = {}) {
  const minScore = opts.minScore ?? 0.75;
  const maxK = Math.min(a.length, w.length);
  for (let k = maxK; k >= 1; k -= 1) {
    let matches = 0;
    for (let i = 0; i < k; i += 1) {
      if (a[a.length - k + i] === w[i]) matches += 1;
    }
    if (matches / k >= minScore) return k;
  }
  return 0;
}

/**
 * Cuts the ORIGINAL text (preserving case/punctuation) so only the words from
 * index `k` onward remain. Word boundaries MUST match normalizeWords(): an
 * apostrophe-joined run ("don't") is ONE word, so the run pattern includes
 * optional apostrophe continuations.
 * @param {string} text
 * @param {number} k - number of leading words to drop
 * @returns {string}
 */
export function sliceFromWord(text, k) {
  const re = /[0-9a-zA-Z]+(?:['’][0-9a-zA-Z]+)*/g;
  let m;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (i === k) return text.slice(m.index).trim(); // keep from the START of word k onward
    i += 1;
  }
  return '';
}

/**
 * Folds one window transcript into the accumulated partial transcript.
 * The overlap (words of the window that re-cover the tail of the accumulated
 * text) is matched and dropped; only the genuinely new tail is appended.
 *
 * Guarantees:
 *   * an empty window (silence) leaves the accumulated text unchanged;
 *   * a window whose words are FULLY covered by the accumulated tail appends
 *     nothing (idempotent re-transcription of the same audio cannot grow
 *     the text — this is the core no-duplication guarantee);
 *   * with no overlap (e.g. the window covered brand-new speech) the whole
 *     window is appended;
 *   * a near-overlap (one flipped word inside the overlap region) still
 *     deduplicates, losing at most that one word (the final pass repairs it).
 *
 * @param {string} accumulated - current partial transcript
 * @param {string} windowText  - raw transcript of the newest window
 * @param {{minScore?: number}} [opts]
 * @returns {string} the new accumulated transcript
 */
export function reconcileWindow(accumulated, windowText, opts = {}) {
  const acc = String(accumulated ?? '').trim();
  const win = String(windowText ?? '').trim();
  if (!win) return acc; // silence window: no change
  if (!acc) return win; // first window: take it as-is
  const aWords = normalizeWords(acc);
  const wWords = normalizeWords(win);
  if (aWords.length === 0 || wWords.length === 0) return `${acc} ${win}`;
  const k = findOverlap(aWords, wWords, opts);
  if (k >= wWords.length) return acc; // fully covered — append nothing
  const tail = sliceFromWord(win, k);
  return tail ? `${acc} ${tail}` : acc;
}

/**
 * Chooses the final transcript when recording stops: the full-recording
 * transcription is authoritative; only when it is empty/failed does the
 * incremental partial survive as the best-effort result.
 * @param {string} partialText - accumulated incremental transcript
 * @param {string} finalText   - transcription of the entire recording
 * @returns {string}
 */
export function finalizeTranscript(partialText, finalText) {
  const fin = String(finalText ?? '').trim();
  if (fin) return fin;
  return String(partialText ?? '').trim();
}
