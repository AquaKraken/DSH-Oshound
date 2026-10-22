// src/client/composer-microphone.js
//
// Conceptual view-model for the composer 🎤 button (spec §9/§81). This is
// deliberately framework-agnostic (no React/Vue/whatever DSH's current Web
// UI uses) — bind `MicrophoneButtonState` to the real component once
// you've confirmed DSH's current Web UI framework and composer extension
// API (see src/dsh/adapter.js header). The state machine and icon mapping
// below are the real, reusable part.

import { ICONS } from '../shared/constants.js';

/**
 * @typedef {Object} MicrophoneButtonState
 * @property {string} icon
 * @property {string} label
 * @property {string} ariaLabel
 * @property {boolean} disabled
 */

/**
 * @param {import('../shared/types.js').VoiceState} voiceState
 * @param {import('../shared/types.js').InputMode} inputMode
 * @returns {MicrophoneButtonState}
 */
export function microphoneButtonState(voiceState, inputMode) {
  switch (voiceState) {
    case 'idle':
      return {
        icon: ICONS.mic,
        iconName: 'mic',
        live: false,
        label: ICONS.mic,
        ariaLabel: inputMode === 'push-to-talk' ? 'Hold to record voice input' : 'Start voice recording',
        disabled: false,
      };
    case 'recording':
      return { icon: ICONS.micRecording, iconName: 'micRecording', live: true, label: `${ICONS.micRecording} Recording…`, ariaLabel: 'Stop voice recording', disabled: false };
    case 'processing':
      return { icon: ICONS.processing, iconName: 'processing', live: true, label: `${ICONS.processing} Transcribing…`, ariaLabel: 'Transcribing speech', disabled: true };
    case 'success':
      return { icon: ICONS.success, iconName: 'mic', live: false, label: ICONS.mic, ariaLabel: 'Start voice recording', disabled: false };
    case 'error':
      return { icon: ICONS.error, iconName: 'warning', live: false, label: `${ICONS.error} Voice error`, ariaLabel: 'Voice input error, click to retry', disabled: false };
  }
}

/**
 * Prevents overlapping recordings (spec §14): only a state-machine transition from 'idle' may start one.
 * @param {import('../shared/types.js').VoiceState} voiceState
 * @returns {boolean}
 */
export function canStartRecording(voiceState) {
  return voiceState === 'idle' || voiceState === 'success' || voiceState === 'error';
}
