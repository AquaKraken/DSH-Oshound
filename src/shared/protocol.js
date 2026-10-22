// src/shared/protocol.js
// Documentation only — no runtime exports. Strongly typed voice operation
// *shapes* (spec §60), kept as JSDoc now that there's no TS compiler to
// check `interface`/`type` declarations against. Wire these onto DSH's
// real client<->host mechanism in src/dsh/adapter.js once you've confirmed
// it from the current deepseek-harness source for your installed version
// (see README "DSH integration points").
//
// VERIFY-BEFORE-SHIP: this file intentionally does NOT invent a transport
// (no made-up "/voice.rpc" endpoint, no invented event bus) — it only
// documents the request/response shapes other files pass around as plain
// objects.

/**
 * @typedef {Object} VoiceRecordStartRequest
 * @property {string} [microphoneDevice]
 *
 * @typedef {Object} VoiceRecordStopResponse
 * @property {string} audioPath
 * @property {number} durationMs
 *
 * @typedef {Object} VoiceSttTranscribeRequest
 * @property {string} audioPath
 * @property {string} [language]
 * @property {import('./types.js').WhisperTask} [task]
 *
 * @typedef {Object} VoiceSttTranscribeResponse
 * @property {string} text
 *
 * @typedef {Object} VoiceTtsSpeakRequest
 * @property {string} text
 *
 * @typedef {Object} VoiceTtsSpeakResponse
 * @property {string} jobId
 *
 * @typedef {Object} VoiceWhisperModelsDownloadRequest
 * @property {string} id
 *
 * @typedef {Object} VoicePiperVoicesListRequest
 * @property {string} languageCode
 * @property {string} locale
 *
 * @typedef {Object} VoicePiperVoicesDownloadRequest
 * @property {string} key
 *
 * @typedef {Object} VoicePiperVoicesRemoveRequest
 * @property {string} key
 *
 * @typedef {Object} VoiceConfigGetResponse
 * @property {import('./types.js').OSoundConfig} config
 *
 * @typedef {Object} VoiceConfigSetRequest
 * @property {Partial<import('./types.js').OSoundConfig>} config
 */

// Conceptual operation names (spec §60) — each corresponds to one of the
// request/response typedefs above once wired onto DSH's real RPC mechanism:
//   voice.record.start / voice.record.stop
//   voice.stt.transcribe
//   voice.tts.speak / voice.tts.pause / voice.tts.resume / voice.tts.stop
//   voice.whisper.models.list / voice.whisper.models.download
//   voice.piper.catalogue.get / voice.piper.catalogue.refresh
//   voice.piper.voices.list / voice.piper.voices.download / voice.piper.voices.remove
//   voice.config.get / voice.config.set
//   voice.diagnostics

export {};
