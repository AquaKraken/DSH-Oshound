import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, sanitizeConfig } from '../src/host/config.js';

describe('sanitizeConfig', () => {
  it('accepts valid overrides', () => {
    const { config, errors } = sanitizeConfig({ ttsSpeed: 1.5, autoSpeak: false });
    expect(errors).toHaveLength(0);
    expect(config.ttsSpeed).toBe(1.5);
    expect(config.autoSpeak).toBe(false);
  });

  it('drops an invalid enum value and falls back to the default (regression: used to pass through untouched)', () => {
    const { config, errors } = sanitizeConfig({ whisperTask: 'nonsense-value' });
    expect(config.whisperTask).toBe(DEFAULT_CONFIG.whisperTask);
    expect(errors.some((e) => e.startsWith('whisperTask'))).toBe(true);
  });

  it('drops an out-of-range number and falls back to the default (regression: used to only log a warning)', () => {
    const { config, errors } = sanitizeConfig({ ttsSpeed: 999 });
    expect(config.ttsSpeed).toBe(DEFAULT_CONFIG.ttsSpeed);
    expect(errors.some((e) => e.startsWith('ttsSpeed'))).toBe(true);
  });

  it('drops an unknown Piper quality value', () => {
    const { config, errors } = sanitizeConfig({ piperQuality: 'ultra-hd' });
    expect(config.piperQuality).toBe(DEFAULT_CONFIG.piperQuality);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('drops an unknown Whisper language code', () => {
    const { config, errors } = sanitizeConfig({ whisperLanguage: 'not-a-real-code' });
    expect(config.whisperLanguage).toBe(DEFAULT_CONFIG.whisperLanguage);
    expect(errors.some((e) => e.startsWith('whisperLanguage'))).toBe(true);
  });

  it('drops an unknown Whisper model id (regression: a well-formed-but-unknown id used to pass ' +
     'schema validation silently, then crash ModelManager.getModel()/diagnostics with an unhandled ' +
     'rejection at plugin load time — see adapter.test.js)', () => {
    const { config, errors } = sanitizeConfig({ whisperModel: 'not-a-real-model-id' });
    expect(config.whisperModel).toBe(DEFAULT_CONFIG.whisperModel);
    expect(errors.some((e) => e.startsWith('whisperModel'))).toBe(true);
  });

  it('keeps valid fields even when a sibling field in the same call is invalid', () => {
    const { config } = sanitizeConfig({ ttsSpeed: 1.2, whisperTask: 'bogus' });
    expect(config.ttsSpeed).toBe(1.2);
    expect(config.whisperTask).toBe(DEFAULT_CONFIG.whisperTask);
  });
});
