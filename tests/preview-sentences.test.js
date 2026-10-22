import { describe, expect, it } from 'vitest';
import { previewSentenceFor } from '../src/shared/preview-sentences.js';

const EN_US = 'Hello. This is a Piper speech synthesis test. Please read this sentence clearly.';

describe('previewSentenceFor', () => {
  it('returns the English line for English voices', () => {
    expect(previewSentenceFor({ languageCode: 'en' })).toBe(EN_US);
  });

  it('prefers the exact locale (full 58-locale coverage from the test script)', () => {
    expect(previewSentenceFor({ locale: 'de_DE' })).toContain('Sprachsynthese');
    expect(previewSentenceFor({ locale: 'ja_JP' })).toContain('音声合成');
    expect(previewSentenceFor({ locale: 'ar_JO' })).toContain('Piper');
    expect(previewSentenceFor({ locale: 'hi_IN' })).toContain('Piper');
    expect(previewSentenceFor({ locale: 'zh_CN' })).toContain('Piper');
  });

  it('distinguishes region variants of the same language (es_AR uses voseo)', () => {
    const ar = previewSentenceFor({ locale: 'es_AR', languageCode: 'es' });
    const es = previewSentenceFor({ locale: 'es_ES', languageCode: 'es' });
    expect(ar).toContain('leé');
    expect(es).toContain('lee');
    expect(ar).not.toBe(es);
  });

  it('falls back to the language line for locales not in the 58', () => {
    expect(previewSentenceFor({ locale: 'en_AU', languageCode: 'en' })).toBe(EN_US);
  });

  it('handles region-qualified language codes by the leading language part', () => {
    expect(previewSentenceFor({ languageCode: 'de-DE' })).toBe(previewSentenceFor({ locale: 'de_DE' }));
    expect(previewSentenceFor({ languageCode: 'en_US' })).toBe(EN_US);
  });

  it('is case-insensitive for locales', () => {
    expect(previewSentenceFor({ locale: 'DE_de' })).toBe(previewSentenceFor({ locale: 'de_DE' }));
  });

  it('is defensive against missing / null fields (falls back to English, never blank)', () => {
    expect(previewSentenceFor(null)).toBe(EN_US);
    expect(previewSentenceFor(undefined)).toBe(EN_US);
    expect(previewSentenceFor({})).toBe(EN_US);
    expect(previewSentenceFor({ languageCode: 'xx' })).toBe(EN_US);
    // A display name is NOT a valid lookup key → falls back, never mis-matches.
    expect(previewSentenceFor({ language: 'German' })).toBe(EN_US);
  });
});
