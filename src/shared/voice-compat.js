// src/shared/voice-compat.js
// Pure check: can the bundled Piper runtime load a given voice?
//
// Evidence (ISSUES.md ISSUE-001, reproduced outside the UI on Windows):
//   * the bundled runtime (rhasspy/piper 2023.11.14-2) rejects any phoneme_id_map key that
//     is more than one Unicode code point — stderr: `"aɪ" is not a single codepoint` — and
//     then fail-fasts (exit 3221226505 / 0xC0000409) before synthesis starts;
//   * bn_BD-google-medium declares piper_version 1.5.0 and uses diphthong keys
//     (aɪ, aə, əɪ, eɪ, oə), so this runtime cannot load it.
// This rule is derived from that failure and tested against those keys. It is not proven
// exhaustive for every other voice; the runtime stays the final authority.
//
// Policy (v0.5.0): the engine is NOT changed. An incompatible voice is refused before
// synthesis with a clear message, instead of crashing the runtime. Nothing is swapped.

/** Unicode code-point length (not UTF-16 units) — `"aɪ"` is 2. */
export function codePointLength(s) {
  return Array.from(String(s)).length;
}

/**
 * @param {object|null} voiceJson - parsed `<voice>.onnx.json`
 * @param {string} [voiceKey] - used only to build the message
 * @returns {{ok: true, piperVersion: string|null} | {ok: false, piperVersion: string|null, multiCodepointKeys: string[], message: string}}
 */
export function checkVoiceEngineCompatibility(voiceJson, voiceKey = 'this voice') {
  const piperVersion = typeof voiceJson?.piper_version === 'string' ? voiceJson.piper_version : null;
  const map = voiceJson && typeof voiceJson === 'object' ? voiceJson.phoneme_id_map : null;
  if (!map || typeof map !== 'object') return { ok: true, piperVersion }; // unknown layout — let the runtime decide
  const multiCodepointKeys = Object.keys(map).filter((k) => codePointLength(k) > 1);
  if (multiCodepointKeys.length === 0) return { ok: true, piperVersion };
  const version = piperVersion ? ` (it declares piper_version ${piperVersion})` : '';
  return {
    ok: false,
    piperVersion,
    multiCodepointKeys,
    message:
      `Voice "${voiceKey}" can't be used with the bundled Piper runtime (2023.11.14-2)${version}: ` +
      `it uses multi-character phonemes (e.g. "${multiCodepointKeys[0]}") that this runtime rejects. ` +
      `Please pick a different voice in Settings → Voice.`,
  };
}
