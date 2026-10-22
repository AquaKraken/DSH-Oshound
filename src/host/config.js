// src/host/config.js
// Persistent O-Sound configuration: schema, safe defaults, and runtime
// validation so a malformed value from the settings UI can never crash the
// host (per spec §61-§63). Built on Schemastery, which is the config
// validation library Cordis plugins conventionally use (see the DSH plugin
// tutorial's "insulation config (Config + Schemastery schema)" pattern) —
// confirm the exact import path against your installed @deepseek-ai/dsh
// version if it re-exports Schemastery under a different name.

import Schema from 'schemastery';
import { WHISPER_MODELS, DEFAULT_WHISPER_MODEL_ID } from '../models/whisper-models.js';
import { WHISPER_LANGUAGE_CODES } from '../stt/languages.js';
import { DEFAULT_TTS_FILTER, sanitizeTtsFilter } from '../tts/tts-filter.js';
import { DEFAULT_STT_FILTER, DEFAULT_SILENCE_GATE, sanitizeSttFilter } from '../stt/stt-filter.js';

const WHISPER_MODEL_IDS = new Set(WHISPER_MODELS.map((m) => m.id));

/** @type {import('../shared/types.js').OSoundConfig} */
export const DEFAULT_CONFIG = {
  whisperModel: DEFAULT_WHISPER_MODEL_ID,
  whisperLanguage: 'auto',
  whisperTask: 'transcribe',
  // Live-partial STT window model (2026-09-26): '' = use the main whisperModel for the
  // incremental windows too. A smaller model (e.g. 'tiny') makes live partials update
  // faster; the final full-recording pass ALWAYS uses the main model, so the delivered
  // transcript is never downgraded.
  sttWindowModel: '',
  microphoneDevice: 'default',
  inputMode: 'click',
  pushToTalkKey: 'Ctrl+Space',

  piperLanguageCode: 'en',
  piperLocale: 'en_US',
  piperVoiceKey: '', // resolved at first run via PiperCatalogue.pickDefaultVoice()
  piperQuality: 'medium',
  outputDevice: 'default',

  ttsSpeed: 1.0,
  ttsVolume: 1.0,
  ttsLengthScale: 1.0,
  ttsNoiseScale: 0.667,
  ttsNoiseWScale: 0.8,
  // Persistent Piper worker (2026-10-06): one long-lived piper.exe per voice — the model
  // loads once and every chunk is a warm job (no ~5s spawn+load per chunk). Default OFF
  // (conservative); any worker failure falls back to one-shot Piper per chunk, so ON is
  // safe on any voice that works with the legacy runtime.
  ttsPersistentWorker: false,
  // Level match (2026-10-06): rescale each chunk's RMS to a fixed target so
  // consecutive chunks don't jump in loudness. Basic per-chunk normalization
  // (the advanced cross-reference matching stays deferred).
  ttsLevelMatch: false,
  // Trailing silence appended to every chunk except the last (ms; 0 = off) —
  // a natural pause between sentence groups.
  pauseBetweenSentences: 0,
  // TTS text filter (2026-10-06): strips annotation-style tokens before Piper
  // speaks (affects the Piper input only, never displayed text). Schema.any()
  // on purpose — the pure sanitizer (sanitizeTtsFilter) is the enforcement
  // point: compile-guarded + ReDoS-guarded regex rules; a bad rule disables
  // only itself. Defaults: strip stray '*' and '#' markers.
  ttsFilter: { ...DEFAULT_TTS_FILTER, rules: DEFAULT_TTS_FILTER.rules.map((r) => ({ ...r })) },
  // STT result filter + silence gate (2026-10-06): strips Whisper annotation
  // tokens from transcripts; recordings below the RMS threshold skip Whisper
  // entirely. Same Schema.any() + pure-sanitizer enforcement as ttsFilter.
  sttFilter: {
    ...DEFAULT_STT_FILTER,
    rules: DEFAULT_STT_FILTER.rules.map((r) => ({ ...r })),
    silenceGate: { ...DEFAULT_SILENCE_GATE },
  },

  autoSpeak: true,
  autoSendTranscript: false,
  autoSendDelaySec: 4, // review window before an auto-sent transcription leaves the composer (2026-09-26); 0 = send immediately (legacy)

  speakThinking: false,
  speakToolOutput: false,
  speakCode: false,

  stopSpeechOnRecording: true,
  interruptBehavior: 'stop',

  debugLogging: false,
};

/**
 * Schemastery schema mirroring OSoundConfig. Used both to validate the
 * config object a Cordis plugin receives and (where the host DSH settings
 * UI supports it) to auto-render a settings form from schema metadata.
 */
export const OSoundConfigSchema = Schema.object({
  whisperModel: Schema.string().default(DEFAULT_CONFIG.whisperModel).description('🎙 Whisper model id'),
  whisperLanguage: Schema.string().default(DEFAULT_CONFIG.whisperLanguage).description('🌐 Whisper language code, or "auto"'),
  whisperTask: Schema.union(['transcribe', 'translate']).default(DEFAULT_CONFIG.whisperTask),
  sttWindowModel: Schema.string().default(DEFAULT_CONFIG.sttWindowModel).description('🎤 Whisper model for live STT windows ("" = same as main model)'),
  microphoneDevice: Schema.string().default(DEFAULT_CONFIG.microphoneDevice),
  inputMode: Schema.union(['click', 'toggle', 'push-to-talk']).default(DEFAULT_CONFIG.inputMode),
  pushToTalkKey: Schema.string().default(DEFAULT_CONFIG.pushToTalkKey),

  piperLanguageCode: Schema.string().default(DEFAULT_CONFIG.piperLanguageCode),
  piperLocale: Schema.string().default(DEFAULT_CONFIG.piperLocale),
  piperVoiceKey: Schema.string().default(DEFAULT_CONFIG.piperVoiceKey),
  piperQuality: Schema.union(['x_low', 'low', 'medium', 'high']).default(DEFAULT_CONFIG.piperQuality),
  outputDevice: Schema.string().default(DEFAULT_CONFIG.outputDevice),

  ttsSpeed: Schema.number().min(0.5).max(2.0).default(DEFAULT_CONFIG.ttsSpeed).description('🔊 Playback speed'),
  ttsVolume: Schema.number().min(0).max(1).default(DEFAULT_CONFIG.ttsVolume),
  ttsLengthScale: Schema.number().min(0.3).max(3.0).default(DEFAULT_CONFIG.ttsLengthScale),
  ttsNoiseScale: Schema.number().min(0).max(1).default(DEFAULT_CONFIG.ttsNoiseScale),
  ttsNoiseWScale: Schema.number().min(0).max(1).default(DEFAULT_CONFIG.ttsNoiseWScale),
  ttsPersistentWorker: Schema.boolean().default(DEFAULT_CONFIG.ttsPersistentWorker).description('⚡ Persistent Piper worker: one process per voice, model loaded once (faster chunks). Off = one Piper process per chunk.'),
  ttsLevelMatch: Schema.boolean().default(DEFAULT_CONFIG.ttsLevelMatch).description('📊 Level match: normalize each chunk\'s loudness to a fixed target (reduces volume jumps between chunks)'),
  pauseBetweenSentences: Schema.number().min(0).max(2000).default(DEFAULT_CONFIG.pauseBetweenSentences).description('⏸ Silence appended after each chunk (ms; 0 = off)'),
  // any(): the shape is {enabled, rules:[{kind,value,replacement}]} but it is
  // free-form by design — sanitizeTtsFilter() in sanitizeConfig() normalizes it.
  ttsFilter: Schema.any().default(DEFAULT_CONFIG.ttsFilter).description('✂️ TTS text filter rules (literal/regex) applied to the Piper input only'),
  sttFilter: Schema.any().default(DEFAULT_CONFIG.sttFilter).description('🎙 STT transcript filter (annotation tokens) + RMS silence gate (skips Whisper on silence)'),

  autoSpeak: Schema.boolean().default(DEFAULT_CONFIG.autoSpeak).description('🔊 Automatically speak assistant responses'),
  autoSendTranscript: Schema.boolean().default(DEFAULT_CONFIG.autoSendTranscript),
  autoSendDelaySec: Schema.number().min(0).max(30).default(DEFAULT_CONFIG.autoSendDelaySec).description('🎤 Seconds to review a transcription before it auto-sends (0 = immediately)'),

  speakThinking: Schema.boolean().default(DEFAULT_CONFIG.speakThinking),
  speakToolOutput: Schema.boolean().default(DEFAULT_CONFIG.speakToolOutput),
  speakCode: Schema.boolean().default(DEFAULT_CONFIG.speakCode),

  stopSpeechOnRecording: Schema.boolean().default(DEFAULT_CONFIG.stopSpeechOnRecording),
  interruptBehavior: Schema.union(['stop', 'continue', 'ask']).default(DEFAULT_CONFIG.interruptBehavior),

  debugLogging: Schema.boolean().default(DEFAULT_CONFIG.debugLogging),
}).default(DEFAULT_CONFIG);

/**
 * Extra semantic validation Schemastery's type-level schema can't express (e.g. cross-field checks).
 * @param {import('../shared/types.js').OSoundConfig} config
 * @returns {string[]}
 */
export function validateConfig(config) {
  const errors = [];
  if (!WHISPER_MODEL_IDS.has(config.whisperModel)) {
    // This one matters more than it looks: getWhisperModel() THROWS for an
    // unknown id, and both ModelManager and diagnostics.js call it directly.
    // An unvalidated bad id here previously reached that throw and became
    // an unhandled promise rejection at plugin load time — see adapter.js.
    errors.push(`Unknown whisperModel: ${config.whisperModel}`);
  }
  if (config.whisperLanguage !== 'auto' && !WHISPER_LANGUAGE_CODES.has(config.whisperLanguage)) {
    errors.push(`Unknown whisperLanguage: ${config.whisperLanguage}`);
  }
  if (config.sttWindowModel !== '' && !WHISPER_MODEL_IDS.has(config.sttWindowModel)) {
    errors.push(`Unknown sttWindowModel: ${config.sttWindowModel}`);
  }
  if (config.ttsSpeed < 0.5 || config.ttsSpeed > 2.0) errors.push('ttsSpeed out of range (0.5-2.0)');
  if (config.ttsVolume < 0 || config.ttsVolume > 1) errors.push('ttsVolume out of range (0-1)');
  return errors;
}

/**
 * Applies each incoming field one at a time, on top of DEFAULT_CONFIG,
 * validating the resulting object against OSoundConfigSchema after every
 * field. A field whose value fails schema validation (wrong type, bad
 * enum, out-of-range number) is *dropped* — the default for that field is
 * kept — rather than being allowed through with only a logged warning.
 * This is the actual enforcement point; `apply()` in the DSH adapter must
 * call this instead of doing a naive object spread. See §63: "Never allow
 * malformed config to crash DSH" — the intent is graceful per-field
 * fallback, not a whole-config reject or a decorative warning.
 * @param {Partial<import('../shared/types.js').OSoundConfig>} partial
 * @returns {{config: import('../shared/types.js').OSoundConfig, errors: string[]}}
 */
export function sanitizeConfig(partial) {
  let result = { ...DEFAULT_CONFIG };
  const errors = [];

  for (const key of Object.keys(partial)) {
    const candidate = { ...result, [key]: partial[key] };
    try {
      OSoundConfigSchema(candidate);
      result = candidate;
    } catch (err) {
      errors.push(`${String(key)}: ${err.message}`);
    }
  }

  // ttsFilter is Schema.any() on purpose — the pure sanitizer is the enforcement
  // point: it normalizes the shape and drops/repairs individual bad rules
  // (invalid regex, ReDoS shape, non-object entries) WITHOUT rejecting the
  // whole config. A bad rule disables only itself; it can never crash DSH.
  const ttsFilter = sanitizeTtsFilter(result.ttsFilter);
  errors.push(...ttsFilter.errors);
  result = { ...result, ttsFilter: ttsFilter.value }; // always canonical (defaults filled in)

  const sttFilter = sanitizeSttFilter(result.sttFilter);
  errors.push(...sttFilter.errors);
  result = { ...result, sttFilter: sttFilter.value };

  // Cross-field checks the schema alone can't express (e.g. "is this a
  // real Whisper language code" / "is this a real Whisper model id") —
  // same drop-to-default treatment. Error messages are prefixed with the
  // field name for consistency with the per-field loop above.
  for (const message of validateConfig(result)) {
    if (message.startsWith('Unknown whisperLanguage')) {
      errors.push(`whisperLanguage: ${message}`);
      result = { ...result, whisperLanguage: DEFAULT_CONFIG.whisperLanguage };
    } else if (message.startsWith('Unknown whisperModel')) {
      errors.push(`whisperModel: ${message}`);
      result = { ...result, whisperModel: DEFAULT_CONFIG.whisperModel };
    } else if (message.startsWith('Unknown sttWindowModel')) {
      errors.push(`sttWindowModel: ${message}`);
      result = { ...result, sttWindowModel: DEFAULT_CONFIG.sttWindowModel };
    }
  }

  return { config: result, errors };
}
