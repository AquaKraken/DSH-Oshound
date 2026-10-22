// src/shared/types.js
// Documentation only — no runtime exports. This file used to be
// TypeScript `interface`/`type` declarations (erased at compile time);
// now that the project is plain JS with no build step, they live here as
// JSDoc @typedef blocks purely so editors (VS Code's JS language service
// reads JSDoc automatically, no config needed) can still offer
// autocomplete on plugin-internal shapes. Nothing imports this file at
// runtime — it is safe to delete without breaking anything.

/**
 * @typedef {'installed'|'not-installed'|'downloading'|'update-available'|'error'} InstallState
 * @typedef {'idle'|'recording'|'processing'|'success'|'error'} VoiceState
 * @typedef {'idle'|'generating'|'playing'|'paused'|'stopped'|'error'} SpeakerState
 * @typedef {'click'|'toggle'|'push-to-talk'} InputMode
 * @typedef {'transcribe'|'translate'} WhisperTask
 * @typedef {'x_low'|'low'|'medium'|'high'} PiperQuality
 * @typedef {'stop'|'continue'|'ask'} InterruptBehavior
 */

/**
 * One row in the local Whisper model registry (src/models/whisper-models.js).
 * @typedef {Object} WhisperModelDescriptor
 * @property {string} id
 * @property {string} filename
 * @property {string} displayName
 * @property {'multilingual'|'en'} languageMode - 'multilingual' models support the full Whisper language set; 'en' models are English-only.
 * @property {string} url
 * @property {number} approxSizeBytes
 * @property {string} [sha256]
 * @property {string} officialSource
 */

/**
 * One resolved Piper voice, derived at runtime from the official voices.json catalogue.
 * @typedef {Object} PiperVoiceDescriptor
 * @property {string} key - e.g. "en_US-lessac-medium"
 * @property {string} language - display language, e.g. "English"
 * @property {string} languageCode - e.g. "en"
 * @property {string} locale - e.g. "en_US"
 * @property {string} region - display region, e.g. "United States"
 * @property {string} name - e.g. "Lessac"
 * @property {PiperQuality} quality
 * @property {number} numSpeakers
 * @property {string} onnxUrl
 * @property {string} onnxConfigUrl
 * @property {number} [onnxSizeBytes]
 * @property {string} [license]
 * @property {string} [modelCardUrl]
 */

/**
 * @typedef {Object} DownloadProgress
 * @property {string} id
 * @property {number} downloadedBytes
 * @property {number} totalBytes
 * @property {number} percent
 * @property {'downloading'|'verifying'|'done'|'error'|'cancelled'} state
 * @property {string} [error]
 */

/**
 * @typedef {Object} OSoundConfig
 * @property {string} whisperModel
 * @property {string} whisperLanguage - 'auto' or a Whisper language code
 * @property {WhisperTask} whisperTask
 * @property {string} sttWindowModel - '' (use whisperModel) or a Whisper model id for the incremental STT windows
 * @property {string} microphoneDevice - 'default' or a device id
 * @property {InputMode} inputMode
 * @property {string} pushToTalkKey
 * @property {string} piperLanguageCode
 * @property {string} piperLocale
 * @property {string} piperVoiceKey
 * @property {PiperQuality} piperQuality
 * @property {string} outputDevice
 * @property {number} ttsSpeed
 * @property {number} ttsVolume
 * @property {number} ttsLengthScale
 * @property {number} ttsNoiseScale
 * @property {number} ttsNoiseWScale
 * @property {boolean} ttsPersistentWorker - persistent Piper worker (one process per voice, model loaded once); off = one Piper process per chunk
 * @property {boolean} ttsLevelMatch - rescale each chunk's RMS to a fixed target level (reduces loudness jumps between chunks)
 * @property {number} pauseBetweenSentences - trailing silence appended to each chunk except the last (ms; 0 = off)
 * @property {TtsFilter} ttsFilter - TTS text filter applied to the Piper input only (never displayed text)
 * @property {SttFilterFull} sttFilter - STT transcript filter (annotation tokens) + RMS silence gate
 * @property {boolean} autoSpeak
 * @property {boolean} autoSendTranscript
 * @property {number} autoSendDelaySec - review window before auto-send (seconds; 0 = immediately)
 * @property {boolean} speakThinking
 * @property {boolean} speakToolOutput
 * @property {boolean} speakCode
 * @property {boolean} stopSpeechOnRecording
 * @property {InterruptBehavior} interruptBehavior
 * @property {boolean} debugLogging
 */

/**
 * @typedef {Object} TtsFilterRule
 * @property {'literal'|'regex'} kind
 * @property {string} value
 * @property {string} replacement
 */

/**
 * @typedef {Object} TtsFilter
 * @property {boolean} enabled
 * @property {TtsFilterRule[]} rules
 */

/**
 * @typedef {Object} SttSilenceGate
 * @property {boolean} enabled
 * @property {number} thresholdDb - dBFS (0 = full scale); recordings below are treated as silence
 */

/**
 * @typedef {Object} SttFilterFull
 * @property {boolean} enabled
 * @property {TtsFilterRule[]} rules - annotation-token rules (same shape as TtsFilterRule)
 * @property {SttSilenceGate} silenceGate
 */

/**
 * @typedef {Object} TtsQueueJob
 * @property {string} id
 * @property {string} text
 * @property {number} createdAt
 * @property {SpeakerState} state
 * @property {string} [error] - Present only while state is 'error': the user-readable failure message (e.g. "Piper runtime is not installed (missing: piper.exe)."), kept readable for the queue's error TTL window so GET /tts/chunk can surface it.
 */

/**
 * @typedef {Object} DiagnosticsReport
 * @property {InstallState} dshIntegration
 * @property {InstallState} platform
 * @property {InstallState} whisperRuntime
 * @property {InstallState} whisperModel
 * @property {InstallState} piperRuntime
 * @property {InstallState} piperVoice
 * @property {InstallState} microphone
 * @property {InstallState} audioOutput
 * @property {InstallState} catalogue
 * @property {Object.<string,string>} details
 */

export {};
