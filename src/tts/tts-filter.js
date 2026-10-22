// src/tts/tts-filter.js
// TTS text filter (2026-10-06): strips annotation-style tokens from assistant
// text BEFORE Piper speaks it. Applied after cleanTextForSpeech and before
// chunking — it affects only the Piper input, never the text the user sees.
//
// The generic mechanism (compile guard, ReDoS heuristic, match cap, length
// guard, never-throw application) lives in src/shared/text-filter.js — this
// module only carries the TTS defaults and the field-named wrappers.

import {
  applyFilter,
  compileFilterRegex,
  MAX_RULE_MATCHES,
  sanitizeFilter,
  copyFilter,
} from '../shared/text-filter.js';

/**
 * @typedef {import('../shared/text-filter.js').TextFilterRule} TtsFilterRule
 * @typedef {import('../shared/text-filter.js').TextFilter} TtsFilter
 */

/** Built-in defaults: strip stray markdown emphasis asterisks and heading/hash
 *  markers that cleanTextForSpeech doesn't cover (inline **bold**, #hashtag). */
export const DEFAULT_TTS_FILTER = {
  enabled: true,
  rules: [
    { kind: 'literal', value: '*', replacement: '' },
    { kind: 'literal', value: '#', replacement: '' },
  ],
};

/** @returns {TtsFilter} a fresh deep copy of the default filter */
export function defaultTtsFilter() {
  return copyFilter(DEFAULT_TTS_FILTER);
}

/** Alias kept for the TTS-side API. */
export const compileTtsRegex = compileFilterRegex;
export { MAX_RULE_MATCHES };

/**
 * Pure sanitizer for the `ttsFilter` config field.
 * Never throws. @param {unknown} raw @returns {{value: TtsFilter, errors: string[]}}
 */
export function sanitizeTtsFilter(raw) {
  return sanitizeFilter(raw, { defaultFilter: DEFAULT_TTS_FILTER, field: 'ttsFilter' });
}

/**
 * Pure application of a sanitized TTS filter. Never throws.
 * @param {string} text
 * @param {TtsFilter|unknown} filter
 * @returns {string}
 */
export function applyTtsFilter(text, filter) {
  return applyFilter(text, filter);
}
