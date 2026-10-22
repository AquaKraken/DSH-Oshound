// src/client/assistant-speaker.js
// View-model for the per-message 🔊 speaker button (spec §28/§29/§82/§83).
// Same framework-agnostic note as composer-microphone.js applies.

import { ICONS } from '../shared/constants.js';

/**
 * @typedef {Object} SpeakerButtonState
 * @property {string} icon
 * @property {string} ariaLabel
 * @property {boolean} activeHighlight
 */

/**
 * @param {import('../shared/types.js').SpeakerState} state
 * @returns {SpeakerButtonState}
 */
export function speakerButtonState(state) {
  switch (state) {
    case 'generating':
      // ⏳ Waiting — synthesis in progress; a click cancels.
      return { icon: ICONS.processing, iconName: 'generatingTTS', live: true, ariaLabel: 'Generating speech — click to cancel', activeHighlight: true };
    case 'playing':
      // ■ Stop — audio is playing; a click stops it and resets back to Play.
      return { icon: ICONS.stop, iconName: 'stop', live: true, ariaLabel: 'Speaking — click to stop', activeHighlight: true };
    case 'error':
      return { icon: ICONS.error, iconName: 'warning', live: false, ariaLabel: 'Speech failed — click to retry', activeHighlight: false };
    case 'idle':
    case 'stopped':
    default:
      // ▶ Play — default; a click reads the assistant response aloud.
      return { icon: ICONS.play, iconName: 'play', live: false, ariaLabel: 'Read assistant response aloud', activeHighlight: false };
  }
}

/**
 * Subtle "🔉 Speaking" tag next to the currently-playing message (spec §83) — never dominant.
 * @param {import('../shared/types.js').SpeakerState} state
 * @returns {string|null}
 */
export function speakingTag(state) {
  return state === 'playing' ? `${ICONS.speakerPlaying} Speaking` : null;
}
