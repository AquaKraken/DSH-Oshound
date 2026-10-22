// src/stt/stt-filter.js
// STT result filter + silence gate (2026-10-06, expanded in v0.5.1):
//   * applySttFilter — strips Whisper annotation tokens and non-speech tags
//     from the transcript BEFORE it reaches the chat input. Conservative on
//     purpose: the defaults target bracketed/parenthesized/asterisk non-speech
//     tags, musical notes, and unambiguous subtitle-credit watermarks — real
//     speech ("Thank you.", "I love music.") passes untouched.
//   * silence gate — a recording whose RMS level is below the threshold is
//     skipped entirely (Whisper is never spawned), so ambient noise or a
//     missed push-to-talk doesn't produce a garbage transcription.
//   * addWordsToSttRules / wordToSttTagRule — converts bare words or tags
//     typed by the user (e.g. "music", "(music), (noise)") into filter rules
//     matching all common Whisper tag wrappers ((word), [word], {word}, *word*,
//     （word）, 【word】) case-insensitively.

import { applyFilter, sanitizeFilter, copyFilter, escapeRegExp } from '../shared/text-filter.js';

/**
 * @typedef {import('../shared/text-filter.js').TextFilterRule} SttFilterRule
 * @typedef {import('../shared/text-filter.js').TextFilter} SttFilter
 */

/**
 * @typedef {Object} SttSilenceGate
 * @property {boolean} enabled
 * @property {number} thresholdDb - dBFS (0 = full scale). Recordings below this are treated as silence.
 */

/**
 * @typedef {Object} SttFilterFull
 * @property {boolean} enabled
 * @property {SttFilterRule[]} rules
 * @property {SttSilenceGate} silenceGate
 */

/**
 * Common English & multilingual Whisper non-speech tag stems (matched only
 * inside brackets/parentheses/asterisks/braces so normal spoken words like
 * "I love music." or "Thank you." are never stripped).
 */
export const COMMON_WHISPER_TAG_WORDS = [
  'blank_audio',
  'blank audio',
  'no_audio',
  'no audio',
  'no_speech',
  'no speech',
  'silence',
  'silent',
  'dead air',
  'pause',
  'long pause',
  'mute',
  'muted',
  'empty',
  'music',
  'music playing',
  'playing music',
  'background music',
  'upbeat music',
  'soft music',
  'sad music',
  'dramatic music',
  'gentle music',
  ' Somber music',
  'energetic music',
  'piano music',
  'guitar music',
  'rock music',
  'pop music',
  'jazz music',
  'classical music',
  'electronic music',
  'orchestral music',
  'cinematic music',
  'suspenseful music',
  'tense music',
  'happy music',
  'melancholy music',
  'acoustic music',
  'ambient music',
  'theme music',
  'intro music',
  'outro music',
  'music fades',
  'music swells',
  'music stops',
  'music ends',
  'music continues',
  'instrumental',
  'instrumental music',
  'singing',
  'sings',
  'song',
  'humming',
  'hums',
  'whistling',
  'whistles',
  'noise',
  'background noise',
  'ambient noise',
  'white noise',
  'static',
  'buzzing',
  'buzz',
  'hissing',
  'hiss',
  'hum',
  'rumble',
  'rumbling',
  'clicking',
  'click',
  'clicks',
  'ticking',
  'beep',
  'beeping',
  'beeps',
  'censor beep',
  'tone',
  'bell',
  'bell dings',
  'bell rings',
  'ding',
  'chime',
  'buzzer',
  'alarm',
  'siren',
  'horn',
  'car horn',
  'engine',
  'traffic',
  'wind',
  'wind blowing',
  'rain',
  'rain falling',
  'thunder',
  'water',
  'footsteps',
  'door',
  'door opens',
  'door closes',
  'door slams',
  'knocking',
  'typing',
  'keyboard',
  'rustling',
  'paper rustling',
  'camera shutter',
  'phone ringing',
  'ringing',
  'explosion',
  'gunshot',
  'crash',
  'bang',
  'thud',
  'pop',
  'crackling',
  'fire',
  'dog barking',
  'barking',
  'birds chirping',
  'chirping',
  'sound',
  'sounds',
  'sound effect',
  'sfx',
  'audio',
  'microphone',
  'applause',
  'audience applause',
  'clapping',
  'claps',
  'cheering',
  'cheers',
  'crowd cheering',
  'crowd',
  'booing',
  'laughter',
  'audience laughter',
  'laughing',
  'laughs',
  'laugh',
  'chuckle',
  'chuckles',
  'chuckling',
  'giggle',
  'giggles',
  'giggling',
  'snicker',
  'snickers',
  'cackle',
  'sigh',
  'sighs',
  'sighing',
  'gasp',
  'gasps',
  'gasping',
  'groan',
  'groans',
  'groaning',
  'moan',
  'moans',
  'grunt',
  'grunts',
  'yawn',
  'yawns',
  'yawning',
  'cough',
  'coughs',
  'coughing',
  'throat clearing',
  'clearing throat',
  'clears throat',
  'clear throat',
  'sniff',
  'sniffs',
  'sniffing',
  'snuffle',
  'snort',
  'snorts',
  'sneeze',
  'sneezes',
  'sneezing',
  'hiccup',
  'hiccups',
  'burp',
  'belch',
  'breath',
  'breathes',
  'breathing',
  'heavy breathing',
  'deep breath',
  'inhales',
  'inhale',
  'exhales',
  'exhale',
  'panting',
  'pants',
  'wheezing',
  'crying',
  'cries',
  'sobbing',
  'sobs',
  'sob',
  'weeping',
  'screaming',
  'screams',
  'scream',
  'shouting',
  'shouts',
  'yelling',
  'yells',
  'whisper',
  'whispers',
  'whispering',
  'mumbling',
  'mumbles',
  'muttering',
  'mutters',
  'stammers',
  'stutters',
  'hesitates',
  'chews',
  'chewing',
  'slurping',
  'gulps',
  'swallows',
  'kiss',
  'shush',
  'shh',
  'hmm',
  'uh',
  'um',
  'inaudible',
  'unintelligible',
  'indistinct',
  'indiscernible',
  'incomprehensible',
  'garbled',
  'muffled',
  'faint',
  'crosstalk',
  'overlapping speech',
  'speaking simultaneously',
  'multiple speakers',
  'speaking foreign language',
  'foreign language',
  'speaking in foreign language',
  'non-english speech',
  'foreign speech',
  'translated',
  'interpreter',
  'narrator',
  'announcer',
  'voiceover',
  'captions',
  'subtitles',
  'end of transcript',
  'recording ends',
  'audio cuts out',
].map((s) => s.trim());

const TAG_STEM_PATTERN = COMMON_WHISPER_TAG_WORDS.map(escapeRegExp).join('|');

const CJK_TAG_PATTERN = [
  '音楽', '拍手', '笑い', '笑', 'ノイズ', '雑音', '無音', '沈黙', 'ため息', '咳', '歓声', '歌', 'BGM', '効果音',
  '박수', '음악', '웃음', '침묵', '소음', '한숨', '기침',
  '音乐', '掌声', '笑声', '噪音', '静音', '叹气', '咳嗽', '唱歌', '欢呼',
  'музыка', 'аплодисменты', 'смех', 'шум', 'тишина', 'вздох', 'кашель',
  'Musik', 'Applaus', 'Gelächter', 'Lachen', 'Stille', 'Rauschen',
  'musique', 'applaudissements', 'rires', 'bruit',
  'música', 'aplausos', 'risas', 'silencio', 'ruido',
].map(escapeRegExp).join('|');

/** Legacy v0.5.0 5-rule array signature — used by sanitizeSttFilter to auto-upgrade old persisted configs. */
const LEGACY_V050_RULE_VALUES = [
  '\\(\\s*(?:music|noise|silence|sound|applause)\\s*\\)',
  '（\\s*(?:音楽|music|noise)\\s*）',
  '\\[\\s*(?:BLANK_AUDIO|blank_audio|NOISE|noise|SILENCE|silence)\\s*\\]',
  '♪♪♪',
  '\\*(?:sighs?|laughs?|chuckles?|chews?|coughs?|hums?|breathes?|applause|clears?\\s+throat)\\*',
];

function isLegacyV050Rules(rules) {
  if (!Array.isArray(rules) || rules.length !== LEGACY_V050_RULE_VALUES.length) return false;
  return rules.every((r, i) => r && typeof r === 'object' && r.value === LEGACY_V050_RULE_VALUES[i]);
}

/** Comprehensive defaults: all common Whisper non-speech tags (case-insensitive)
 *  plus musical symbols, special tokens, and subtitle-credit watermarks.
 *  Closed vocabularies inside delimiters — real words ("Thank you.", "I love music.") survive. */
export const DEFAULT_STT_FILTER = {
  enabled: true,
  rules: [
    {
      kind: 'regex',
      value: `\\(\\s*(?:${TAG_STEM_PATTERN}|[a-z]+\\s+(?:music|noise|applause|laughter|breathing|speech))\\s*\\)`,
      replacement: '',
      ignoreCase: true,
    },
    {
      kind: 'regex',
      value: `[（【]\\s*(?:${CJK_TAG_PATTERN}|${TAG_STEM_PATTERN})\\s*[）】]`,
      replacement: '',
      ignoreCase: true,
    },
    {
      kind: 'regex',
      value: `[\\[{]\\s*(?:${TAG_STEM_PATTERN}|${CJK_TAG_PATTERN}|[a-z]+\\s+(?:music|noise|applause|laughter|breathing|speech))\\s*[\\]}]`,
      replacement: '',
      ignoreCase: true,
    },
    {
      kind: 'regex',
      value: '[♪♫♬♩🎵🎶]+',
      replacement: '',
    },
    {
      kind: 'regex',
      value: `\\*\\s*(?:${TAG_STEM_PATTERN}|${CJK_TAG_PATTERN})\\s*\\*`,
      replacement: '',
      ignoreCase: true,
    },
    {
      kind: 'regex',
      value: '<\\|(?:nospeech|endoftext|startoftranscript|transcribe|translate|notimestamps)\\|>',
      replacement: '',
      ignoreCase: true,
    },
    {
      kind: 'regex',
      value: '(?:Subtitles\\s+by\\s+the\\s+Amara\\.org\\s+community|Subtitles\\s+made\\s+by\\s+the\\s+community\\s+of\\s+Amara\\.org|Sottotitoli\\s+creati\\s+dalla\\s+comunit[àa]\\s+Amara\\.org|Sous-titres\\s+r[ée]alis[ée]s\\s+para\\s+la\\s+communaut[ée]\\s+d\'Amara\\.org|Subt[íi]tulos\\s+realizados\\s+por\\s+la\\s+comunidad\\s+de\\s+Amara\\.org|Legendas\\s+pela\\s+comunidade\\s+Amara\\.org|Transcribed\\s+by\\s+https?://otter\\.ai|Untertitelung\\s+des\\s+ZDF\\s+f[üu]r\\s+funk,\\s*\\d{4}|Untertitelung\\s+des\\s+ZDF\\s+f[üu]r\\s+funk|Untertitelung\\s+des\\s+ZDF|Tekstet\\s+av\\s+Nicolai\\s+Winther|ترجمة\\s+نانسي\\s+قنقر)\\.?',
      replacement: '',
      ignoreCase: true,
    },
  ],
};

export const DEFAULT_SILENCE_GATE = Object.freeze({ enabled: true, thresholdDb: -45 });

/** @returns {SttFilterFull} a fresh deep copy of the default STT filter */
export function defaultSttFilter() {
  return { ...copyFilter(DEFAULT_STT_FILTER), silenceGate: { ...DEFAULT_SILENCE_GATE } };
}

/**
 * Normalizes a user-typed word or tag (e.g. "music", "(music)", "[noise]", "*cough*")
 * into its inner stem and returns a case-insensitive regex rule that strips all
 * common Whisper tag wrappers around that word: (word), [word], {word}, *word*,
 * （word）, 【word】.
 * @param {string} rawWord
 * @returns {SttFilterRule | null}
 */
export function wordToSttTagRule(rawWord) {
  const cleaned = String(rawWord ?? '')
    .trim()
    .replace(/^[([{\uff08\u3010*<]+|[)\]}\uff09\u3011*>]+$/g, '')
    .trim();
  if (!cleaned) return null;
  const escaped = escapeRegExp(cleaned).replace(/\s+/g, '\\s+');
  return {
    kind: 'regex',
    value: `(?:\\(|\\[|\\{|\\*|（|【)\\s*${escaped}\\s*(?:\\)|\\]|\\}|\\*|）|】)`,
    replacement: '',
    ignoreCase: true,
  };
}

/**
 * Parses comma/newline-separated words or tags typed by the user (e.g.
 * "music, noise" or "(music),(noise)") and appends corresponding tag rules
 * to `existingRules` (skipping duplicates).
 * @param {SttFilterRule[]} existingRules
 * @param {string} input
 * @param {'tag'|'literal'|'regex'} [mode='tag']
 * @param {string} [replacement='']
 * @returns {SttFilterRule[]}
 */
export function addWordsToFilterRules(existingRules, input, mode = 'tag', replacement = '') {
  const base = Array.isArray(existingRules) ? existingRules.map((r) => ({ ...r })) : [];
  const rawParts = mode === 'regex'
    ? [String(input ?? '').trim()].filter(Boolean)
    : String(input ?? '')
        .split(/[,;\n]+/)
        .map((s) => s.trim())
        .filter(Boolean);

  for (const part of rawParts) {
    let rule = null;
    if (mode === 'tag') {
      rule = wordToSttTagRule(part);
      if (rule && replacement) rule.replacement = replacement;
    } else if (mode === 'regex') {
      rule = { kind: 'regex', value: part, replacement, ignoreCase: true };
    } else {
      rule = { kind: 'literal', value: part, replacement };
    }
    if (!rule) continue;
    const exists = base.some(
      (r) => r.kind === rule.kind && r.value.toLowerCase() === rule.value.toLowerCase() && (r.replacement ?? '') === (rule.replacement ?? ''),
    );
    if (!exists) base.push(rule);
  }
  return base;
}

/**
 * Pure sanitizer for the `sttFilter.silenceGate` sub-object.
 * @param {unknown} raw
 * @returns {{value: SttSilenceGate, errors: string[]}}
 */
export function sanitizeSilenceGate(raw) {
  const def = DEFAULT_SILENCE_GATE;
  if (raw === undefined || raw === null) return { value: { ...def }, errors: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { value: { ...def }, errors: ['sttFilter.silenceGate: expected an object — using default'] };
  }
  const errors = [];
  const value = { enabled: def.enabled, thresholdDb: def.thresholdDb };
  if ('enabled' in raw) {
    if (typeof raw.enabled === 'boolean') value.enabled = raw.enabled;
    else errors.push('sttFilter.silenceGate.enabled: expected boolean — using default');
  }
  if ('thresholdDb' in raw) {
    if (typeof raw.thresholdDb === 'number' && Number.isFinite(raw.thresholdDb) && raw.thresholdDb >= -80 && raw.thresholdDb <= 0) {
      value.thresholdDb = raw.thresholdDb;
    } else {
      errors.push('sttFilter.silenceGate.thresholdDb: expected a finite number in [-80, 0] dBFS — using default');
    }
  }
  return { value, errors };
}

/**
 * Pure sanitizer for the `sttFilter` config field (adds silenceGate on top of
 * the generic shape, and auto-upgrades unmodified v0.5.0 legacy rules). Never throws.
 * @param {unknown} raw
 * @returns {{value: SttFilterFull, errors: string[]}}
 */
export function sanitizeSttFilter(raw) {
  if (raw === undefined || raw === null || typeof raw === 'boolean' || typeof raw !== 'object' || Array.isArray(raw)) {
    const base = sanitizeFilter(raw, { defaultFilter: DEFAULT_STT_FILTER, field: 'sttFilter' });
    return { value: { ...base.value, silenceGate: { ...DEFAULT_SILENCE_GATE } }, errors: base.errors };
  }
  const { silenceGate, ...rest } = /** @type {Record<string, unknown>} */ (raw);
  // Auto-upgrade unmodified v0.5.0 5-rule default to the comprehensive v0.5.1 rules.
  const upgradedRest = isLegacyV050Rules(rest.rules)
    ? { ...rest, rules: copyFilter(DEFAULT_STT_FILTER).rules }
    : rest;
  const base = sanitizeFilter(upgradedRest, { defaultFilter: DEFAULT_STT_FILTER, field: 'sttFilter' });
  const gate = sanitizeSilenceGate(silenceGate);
  return { value: { ...base.value, silenceGate: gate.value }, errors: [...base.errors, ...gate.errors] };
}

/**
 * Pure application of a sanitized STT filter. Never throws.
 * @param {string} text
 * @param {SttFilterFull|unknown} filter
 * @returns {string}
 */
export function applySttFilter(text, filter) {
  return applyFilter(text, filter);
}
