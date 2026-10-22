// src/tts/text-cleaner.js
// Prepares assistant text for TTS: strips code fences (unless enabled),
// flattens markdown/tables, normalizes whitespace, and splits into
// sentence-respecting chunks so Piper never gets one massive request.
// Per spec §31/§32/§85/§86/§88.

/**
 * @typedef {Object} CleanOptions
 * @property {boolean} speakCode
 */

const CODE_FENCE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`([^`]+)`/g;
const HEADING_RE = /^#{1,6}\s+(.*)$/gm;
const BULLET_RE = /^[ \t]*[-*+][ \t]+/gm;
const HTML_TAG_RE = /<[^>]+>/g;
const URL_RE = /https?:\/\/\S+/g;
const MULTI_SPACE_RE = /[ \t]{2,}/g;
const MULTI_NEWLINE_RE = /\n{2,}/g;

/** Converts `| a | b |` markdown table rows into "a: value. b: value." style speech.
 * @param {string} text @returns {string} */
function flattenTables(text) {
  const lines = text.split('\n');
  const out = [];
  let header = null;

  for (const line of lines) {
    const trimmed = line.trim();
    const isRow = /^\|.*\|$/.test(trimmed);
    const isSeparator = /^\|?[\s:|-]+\|?$/.test(trimmed) && trimmed.includes('-');

    if (isRow && isSeparator) continue; // skip "---|---" separator rows

    if (isRow) {
      const cells = trimmed.slice(1, -1).split('|').map((c) => c.trim());
      if (!header) {
        header = cells;
        continue;
      }
      const spoken = cells.map((val, i) => `${header?.[i] ?? ''}: ${val}`).join('. ');
      out.push(spoken + '.');
      continue;
    }

    header = null;
    out.push(line);
  }
  return out.join('\n');
}

/** @param {string} url @returns {string} */
function friendlyUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * @param {string} raw
 * @param {CleanOptions} opts
 * @returns {string}
 */
export function cleanTextForSpeech(raw, opts) {
  let text = raw;

  if (!opts.speakCode) {
    text = text.replace(CODE_FENCE_RE, ' Code block omitted. ');
  } else {
    text = text.replace(CODE_FENCE_RE, (block) => block.replace(/```\w*\n?|```/g, ''));
  }

  text = flattenTables(text);
  text = text.replace(INLINE_CODE_RE, '$1');
  text = text.replace(HEADING_RE, '$1.');
  text = text.replace(BULLET_RE, '');
  text = text.replace(HTML_TAG_RE, '');
  text = text.replace(URL_RE, (m) => friendlyUrl(m));
  text = text.replace(MULTI_SPACE_RE, ' ');
  text = text.replace(MULTI_NEWLINE_RE, '\n');

  return text.trim();
}

// --- Language-aware, sentence-boundary chunking (2026-10-05, v2) -------------
//
// Pipeline (priority: natural boundary > reasonable duration > hard maximum):
//
//   raw text
//     1. sentence segmentation     Intl.Segmenter(locale, 'sentence')
//     2. sentence repair           merge across boundaries that fall inside a
//                                  URL/number span, and after known
//                                  abbreviations ("Dr.", "z. B.", "vs.", ...)
//     3. clause split              ONLY when a sentence > LATER_MAX_SEC
//     4. word split                ONLY when a clause > LATER_MAX_SEC
//                                  (Intl.Segmenter(locale, 'word'); CJK/Thai
//                                  need no whitespace; code-point fallback)
//     5. duration-guided grouping  greedy: first chunk ~FIRST_TARGET_SEC
//                                  (hard cap FIRST_MAX_SEC), later chunks
//                                  ~LATER_TARGET_SEC (hard cap LATER_MAX_SEC)
//
// Invariant (normalized partition): chunks are slices of the trimmed source,
// so normalizing whitespace of `chunks.join(' ')` equals normalizing the
// source — no loss, duplication, or reordering. A natural unit (sentence,
// clause, token) is NEVER split just to hit a target; only units longer than
// LATER_MAX_SEC are subdivided, and protected tokens (URLs, numbers, dates)
// are never cut.
const FIRST_TARGET_SEC = 1.0;
const FIRST_MAX_SEC = 1.8;
const LATER_TARGET_SEC = 2.2;
const LATER_MAX_SEC = 3.0;
// A single token longer than this is always kept whole (never hard-split),
// and it is emitted as its own chunk so it cannot drag a chunk huge.
const HARD_MAX_CHARS = 1200;

// Languages whose words are not separated by whitespace.
const NO_SPACE_LANGS = new Set(['ja', 'zh', 'ko', 'th']);

// Abbreviations whose trailing period must NOT end a sentence (verified
// against this runtime's ICU: it does split "Dr." / "Mr." / "vs." / "z.").
const ABBREVIATIONS = new Set([
  'dr.', 'mr.', 'mrs.', 'ms.', 'prof.', 'st.', 'vs.',
  'e.g.', 'i.e.', 'bzw.', 'z.',
]);

// Apostrophe-like connectors that join word segments into one token ("don't").
const APOSTROPHE_RE = /^['\u2018\u2019\u201C\u201D`´]+$/u;

// Fallback (no Segmenter) sentence-ending punctuation. CJK/Devanagari/Armenian
// stops end a sentence regardless of the following character; the others need
// whitespace (or end-of-text) after them. ";" is a clause break, not a stop.
const SENTENCE_BREAK_RE = /[.!?…。！？।॥۔؟։]/gu;
const CJK_STOP_RE = /[。！？।॥։]/u;
// Clause punctuation. CJK/comma marks do not require following whitespace.
const CLAUSE_BREAK_RE = /[,;:、，؛،]/gu;
const CJK_CLAUSE_RE = /[、，؛،]/u;

/**
 * Normalizes a locale hint (e.g. `en_US`, `bn-BD`, `ja`, or junk) into a valid
 * canonical BCP-47 locale for Intl. Never throws.
 * @param {string} [locale]
 * @returns {string}
 */
export function normalizeLocale(locale = 'en') {
  const value = String(locale ?? '').trim().replace(/_/g, '-');
  if (!value) return 'en';
  try {
    return Intl.getCanonicalLocales(value)[0] || 'en';
  } catch {
    return value.split('-')[0] || 'en';
  }
}

/** @param {string} locale @returns {string} lower-cased primary language subtag */
export function languageOf(locale) {
  return normalizeLocale(locale).split('-')[0].toLowerCase();
}

/**
 * @param {string} locale
 * @param {'sentence'|'word'} granularity
 * @returns {Intl.Segmenter|null}
 */
function createSegmenter(locale, granularity) {
  if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') return null;
  try {
    return new Intl.Segmenter(normalizeLocale(locale), { granularity });
  } catch {
    return null;
  }
}

/**
 * @param {string} text
 * @param {string} locale
 * @param {'sentence'|'word'} granularity
 * @returns {Array<{text: string, start: number, end: number, isWordLike: boolean}>}
 */
function segmentText(text, locale, granularity) {
  const segmenter = createSegmenter(locale, granularity);
  if (!segmenter) return [];
  const out = [];
  for (const s of segmenter.segment(text)) {
    out.push({ text: s.segment, start: s.index, end: s.index + s.segment.length, isWordLike: s.isWordLike });
  }
  return out;
}

/**
 * Rough speech-time estimate (seconds). Isolated heuristic — measured per-voice
 * timing can replace this later without touching the chunking logic.
 * @param {string} text
 * @param {string} locale
 * @returns {number}
 */
function estimateSpeechSeconds(text, locale) {
  const lang = languageOf(locale);
  const compact = text.replace(/\s+/gu, '');
  if (lang === 'ja' || lang === 'zh' || lang === 'ko') return Array.from(compact).length / 4;
  if (lang === 'th') return Array.from(compact).length / 5;
  const words = text.trim().split(/\s+/u).filter(Boolean).length;
  return words / 2.5;
}

/**
 * Character ranges [start, end) that must never be cut: URLs and numbers
 * (including decimals, dates, and thousands separators).
 * @param {string} text
 * @returns {Array<[number, number]>}
 */
function protectedRanges(text) {
  const ranges = [];
  const tokenRe = /\S+/gu;
  let m;
  while ((m = tokenRe.exec(text)) !== null) {
    const tok = m[0];
    const isNumber = /^[\d][\d.,:%/-]*$/.test(tok);
    const isUrl =
      /:\/\//.test(tok) ||
      /^www\./.test(tok) ||
      /@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(tok) ||
      (!isNumber && /[A-Za-z]/.test(tok) && /\.[A-Za-z]{2,}/.test(tok));
    if (isUrl || isNumber) ranges.push([m.index, m.index + tok.length]);
  }
  return ranges;
}

/** @param {number} pos @param {Array<[number, number]>} ranges @returns {boolean} */
function inProtected(pos, ranges) {
  for (const [a, b] of ranges) if (pos > a && pos < b) return true;
  return false;
}

/** @param {string} piece @returns {string} lower-cased final whitespace-separated word */
function lastWord(piece) {
  const words = piece.trim().split(/\s+/u).filter(Boolean);
  return words.length > 0 ? words[words.length - 1].toLowerCase() : '';
}

/** @param {string} piece @returns {boolean} */
function endsWithAbbreviation(piece) {
  return ABBREVIATIONS.has(lastWord(piece));
}

/**
 * Sentence units (contiguous slices of `raw`) via Intl.Segmenter, with repair:
 * a boundary is DROPPED (segments merged) when it falls inside a protected
 * URL/number span — ICU's sentence rules split URLs at "?" (verified) — or
 * when the left segment ends in a known abbreviation ("Dr.", "z.", "vs.").
 * @param {string} raw
 * @param {string} locale
 */
function getSentenceUnits(raw, locale) {
  const segs = segmentText(raw, locale, 'sentence');
  if (segs.length === 0) return fallbackSentenceUnits(raw);
  const ranges = protectedRanges(raw);
  const units = [];
  for (const seg of segs) {
    if (units.length > 0) {
      const prev = units[units.length - 1];
      // A segment that IS an abbreviation ("Ms. ") can never be a whole
      // sentence, so it always merges with the previous unit — this keeps
      // "Mr. Jones and Ms. Lee met." intact even when the unit so far does
      // not itself end in an abbreviation.
      const isPureAbbreviation = ABBREVIATIONS.has(seg.text.trim().toLowerCase());
      const badBoundary =
        inProtected(prev.end, ranges) || endsWithAbbreviation(prev.text) || isPureAbbreviation;
      if (badBoundary) {
        prev.text = raw.slice(prev.start, seg.end);
        prev.end = seg.end;
        continue;
      }
    }
    units.push({ ...seg });
  }
  return units;
}

/**
 * Fallback sentence units when Intl.Segmenter is unavailable: punctuation scan
 * with the same protections (numbers/URLs, digit-dot, abbreviations) plus a
 * newline as a boundary.
 * @param {string} raw
 */
function fallbackSentenceUnits(raw) {
  const ranges = protectedRanges(raw);
  const cutEnds = new Set();
  let m;
  SENTENCE_BREAK_RE.lastIndex = 0;
  while ((m = SENTENCE_BREAK_RE.exec(raw)) !== null) {
    const p = m.index;
    if (inProtected(p, ranges)) continue;
    const ch = m[0];
    if (ch === '.' && /\d/.test(raw[p - 1] ?? '') && /\d/.test(raw[p + 1] ?? '')) continue;
    const next = raw[p + 1];
    if (!CJK_STOP_RE.test(ch) && next !== undefined && !/\s/u.test(next)) continue;
    let end = p + 1;
    while (end < raw.length && /\s/u.test(raw[end])) end += 1;
    if (end < raw.length) cutEnds.add(end);
  }
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] !== '\n') continue;
    let end = i + 1;
    while (end < raw.length && /\s/u.test(raw[end])) end += 1;
    if (end < raw.length) cutEnds.add(end);
  }
  const cuts = [...cutEnds].sort((a, b) => a - b);
  const units = [];
  let start = 0;
  for (const end of cuts) {
    if (end <= start) continue;
    if (endsWithAbbreviation(raw.slice(start, end))) continue; // no cut: merge with the next
    units.push({ text: raw.slice(start, end), start, end, isWordLike: true });
    start = end;
  }
  if (start < raw.length) units.push({ text: raw.slice(start), start, end: raw.length, isWordLike: true });
  return units;
}

/**
 * Splits one sentence unit into clause units at , ; : 、 ， ، ؛ — never inside
 * a protected token ("1,200", URLs with commas), and for space-separated
 * scripts only when the mark ends a token. Returns [piece] when no valid cut
 * exists. Units are contiguous slices with absolute offsets into `piece.start`.
 * @param {{text: string, start: number, end: number}} piece
 * @param {string} locale
 */
function splitIntoClauses(piece, locale) {
  const local = piece.text;
  const ranges = protectedRanges(local);
  const cutStarts = [0];
  let m;
  CLAUSE_BREAK_RE.lastIndex = 0;
  while ((m = CLAUSE_BREAK_RE.exec(local)) !== null) {
    const p = m.index;
    if (inProtected(p, ranges)) continue;
    const next = local[p + 1];
    if (!CJK_CLAUSE_RE.test(m[0]) && next !== undefined && !/\s/u.test(next)) continue;
    cutStarts.push(p + 1);
  }
  cutStarts.push(local.length);
  const units = [];
  for (let i = 0; i + 1 < cutStarts.length; i += 1) {
    const s = cutStarts[i];
    const e = cutStarts[i + 1];
    if (e === s) continue;
    units.push({ text: local.slice(s, e), start: piece.start + s, end: piece.start + e, isWordLike: true });
  }
  return units.length >= 2 ? units : [piece];
}

/**
 * Splits one piece into word units (contiguous-ish slices, absolute offsets):
 * Intl.Segmenter word mode (correct for Japanese/Chinese/Thai without any
 * whitespace), attaching trailing punctuation and apostrophe-joined parts
 * ("Hello,", "don't", "world.") so tokens keep their punctuation. Fallbacks:
 * whitespace tokens for space-separated scripts, code-point characters
 * (Array.from, never UTF-16 indexing) for no-space scripts. Units that
 * together form one protected token (URL, "2026-09-26") are re-merged.
 * @param {{text: string, start: number, end: number}} piece
 * @param {string} locale
 */
function splitIntoWordUnits(piece, locale) {
  const local = piece.text;
  const units = [];
  const segs = segmentText(local, locale, 'word');
  if (segs.length > 0) {
    for (let i = 0; i < segs.length; i += 1) {
      const s = segs[i];
      if (s.text.trim() === '') continue; // whitespace-only segment
      let end = s.end;
      let sawConnector = false;
      let j = i + 1;
      while (j < segs.length) {
        const seg = segs[j];
        if (seg.text.trim() === '') break; // whitespace ends the token
        if (!seg.isWordLike) {
          sawConnector = APOSTROPHE_RE.test(seg.text) ? true : sawConnector;
          end = seg.end; // trailing punctuation ("Hello,"), or part of a number ("2026-")
          j += 1;
          continue;
        }
        if (sawConnector) { end = seg.end; j += 1; sawConnector = false; continue; } // "don't"
        break;
      }
      i = j - 1;
      units.push({ text: local.slice(s.start, end), start: piece.start + s.start, end: piece.start + end, isWordLike: true });
    }
  } else if (!NO_SPACE_LANGS.has(languageOf(locale))) {
    const tokenRe = /\S+/gu;
    let m;
    while ((m = tokenRe.exec(local)) !== null) {
      units.push({ text: m[0], start: piece.start + m.index, end: piece.start + m.index + m[0].length, isWordLike: true });
    }
  } else {
    let pos = 0;
    for (const ch of Array.from(local)) {
      const len = ch.length;
      if (ch.trim() !== '') units.push({ text: ch, start: piece.start + pos, end: piece.start + pos + len, isWordLike: true });
      pos += len;
    }
  }
  const ranges = protectedRanges(local).map(([a, b]) => [piece.start + a, piece.start + b]);
  return mergeProtectedUnits(local, units, ranges);
}

/**
 * Merges adjacent word units when a protected range (URL/number) straddles
 * their boundary — e.g. ICU word mode splits "2026-09-26" into
 * "2026" / "-" / "09" / "-" / "26".
 * @param {string} raw
 * @param {Array<{text: string, start: number, end: number}>} units
 * @param {Array<[number, number]>} ranges (absolute)
 */
function mergeProtectedUnits(raw, units, ranges) {
  if (units.length < 2) return units;
  const out = [units[0]];
  for (let i = 1; i < units.length; i += 1) {
    const prev = out[out.length - 1];
    const cur = units[i];
    const straddles = ranges.some(([a, b]) => a < cur.start && b > prev.end);
    if (straddles) {
      prev.text = raw.slice(prev.start, cur.end);
      prev.end = cur.end;
    } else {
      out.push(cur);
    }
  }
  return out;
}

/**
 * Greedy grouping of adjacent units into chunks. A unit is never split: the
 * first unit is always taken whole (even when it exceeds the first-chunk cap),
 * then more units are appended while the running slice stays within the cap,
 * stopping early once the target is reached. Always consumes ≥1 unit per chunk
 * (no infinite loops).
 * @param {string} raw
 * @param {Array<{text: string, start: number, end: number}>} units
 * @param {string} locale
 * @returns {string[]}
 */
function groupUnitsIntoChunks(raw, units, locale) {
  const chunks = [];
  let index = 0;
  let first = true;
  while (index < units.length) {
    const target = first ? FIRST_TARGET_SEC : LATER_TARGET_SEC;
    const max = first ? FIRST_MAX_SEC : LATER_MAX_SEC;
    const start = units[index].start;
    let end = units[index].end;
    index += 1;
    let giant = units[index - 1].text.length > HARD_MAX_CHARS;
    while (index < units.length && !giant) {
      const candidateEnd = units[index].end;
      const duration = estimateSpeechSeconds(raw.slice(start, candidateEnd), locale);
      if (duration > max) break;
      end = candidateEnd;
      index += 1;
      if (units[index - 1].text.length > HARD_MAX_CHARS) giant = true;
      if (duration >= target) break;
    }
    const chunk = raw.slice(start, end).trim();
    if (chunk.length > 0) chunks.push(chunk);
    first = false;
  }
  return chunks;
}

/**
 * Splits cleaned text into language-aware, sentence-boundary chunks sized to a
 * speech-time target (first ~1s, rest ~2-3s). Guarantees:
 *   - never splits a word, a number, or a URL;
 *   - normalized partition: `norm(chunks.join(' ')) === norm(text)` where
 *     norm collapses whitespace — nothing lost, duplicated, or reordered;
 *   - prefers sentence boundaries, then clause, then word boundaries;
 *   - a natural sentence ≤ LATER_MAX_SEC always stays intact.
 * @param {string} text
 * @param {string|{locale?: string, language?: string}} [options] locale hint
 *   (a bare string is accepted) for Intl.Segmenter, e.g. "en-US", "bn_BD".
 *   Optional — defaults to 'en'.
 * @returns {string[]}
 */
export function splitIntoSpeechChunks(text, options = {}) {
  const raw = String(text ?? '').trim();
  if (raw.length === 0) return [];
  const locale = normalizeLocale(
    typeof options === 'string' ? options : options.locale ?? options.language ?? 'en',
  );

  const units = [];
  for (const sentence of getSentenceUnits(raw, locale)) {
    if (estimateSpeechSeconds(sentence.text, locale) <= LATER_MAX_SEC) {
      units.push(sentence);
      continue;
    }
    const pieces = [];
    for (const clause of splitIntoClauses(sentence, locale)) {
      if (estimateSpeechSeconds(clause.text, locale) <= LATER_MAX_SEC) pieces.push(clause);
      else pieces.push(...splitIntoWordUnits(clause, locale));
    }
    units.push(...pieces);
  }
  return groupUnitsIntoChunks(raw, units, locale);
}
