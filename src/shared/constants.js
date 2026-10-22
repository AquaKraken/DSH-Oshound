// src/shared/constants.js
// Centralized icons + labels so every UI surface (composer button, speaker
// button, settings page, diagnostics) uses the same glyphs consistently.
// Per spec section 80/119: dark-theme-first, compact, English-only, icons
// used generously rather than text-only rows.

export const ICONS = {
  mic: '🎤',
  micRecording: '🔴',
  processing: '⏳',
  success: '✓',
  error: '⚠',
  speakerIdle: '🔊',
  speakerPlaying: '🔉',
  speakerPaused: '⏸',
  play: '▶',
  stop: '⏹',
  pause: '⏸',
  resume: '▶',
  download: '⬇',
  trash: '🗑',
  gear: '⚙',
  info: 'ℹ',
  refresh: '↻',
  star: '☆',
  starFilled: '★',
  language: '🌐',
  disk: '💾',
  keyboard: '⌨',
  speaker: '🔈',
  headphones: '🎧',
};

export const PLUGIN_NAME = 'O-Sound';
export const PLUGIN_ID = 'dsh-osound';

export const HOME_DIR_ENV = 'USERPROFILE';
export const OSOUND_HOME_SUBDIR = '.dsh';

export const PATHS = {
  whisperModels: 'models/whisper',
  piperVoices: 'models/piper',
  piperCatalogueCache: 'models/piper/catalogue/voices.json',
  voiceTemp: 'voice/temp',
};

export const DEFAULT_CONFIG_ID = 'ggml-base.bin';

export const LABELS = {
  recordStart: `${ICONS.mic} Start voice recording`,
  recordStop: `${ICONS.micRecording} Stop voice recording`,
  speakResponse: `${ICONS.speakerIdle} Read assistant response aloud`,
  manageModels: `${ICONS.gear} Manage Models`,
  manageVoices: `${ICONS.gear} Manage Piper Voices`,
  downloadModel: (mb) => `${ICONS.download} Download (${mb} MB)`,
  installed: `${ICONS.success} Installed`,
  notInstalled: `${ICONS.error} Not Installed`,
};
