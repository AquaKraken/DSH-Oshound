import { describe, expect, it } from 'vitest';
import { parseCatalogue, PiperCatalogue } from '../src/models/piper-catalogue.js';

const RAW_FIXTURE = {
  'en_US-lessac-medium': {
    key: 'en_US-lessac-medium',
    name: 'lessac',
    language: { code: 'en_US', name_english: 'English', country_english: 'United States' },
    quality: 'medium',
    num_speakers: 1,
    files: {
      'en/en_US/lessac/medium/en_US-lessac-medium.onnx': { size_bytes: 63201294 },
      'en/en_US/lessac/medium/en_US-lessac-medium.onnx.json': { size_bytes: 4664 },
    },
  },
  'en_US-amy-medium': {
    key: 'en_US-amy-medium',
    name: 'amy',
    language: { code: 'en_US', name_english: 'English', country_english: 'United States' },
    quality: 'medium',
    num_speakers: 1,
    files: {
      'en/en_US/amy/medium/en_US-amy-medium.onnx': { size_bytes: 63000000 },
      'en/en_US/amy/medium/en_US-amy-medium.onnx.json': { size_bytes: 4000 },
    },
  },
  'hi_IN-priyamvada-medium': {
    key: 'hi_IN-priyamvada-medium',
    name: 'priyamvada',
    language: { code: 'hi_IN', name_english: 'Hindi', country_english: 'India' },
    quality: 'medium',
    num_speakers: 1,
    files: {
      'hi/hi_IN/priyamvada/medium/hi_IN-priyamvada-medium.onnx': { size_bytes: 63000000 },
      'hi/hi_IN/priyamvada/medium/hi_IN-priyamvada-medium.onnx.json': { size_bytes: 4000 },
    },
  },
  malformed_entry: { name: 'broken' }, // missing language/quality/files -> must be skipped
};

function fixtureSource() {
  return {
    async fetchJson() { return RAW_FIXTURE; },
    async loadCache() { return null; },
    async saveCache() {},
  };
}

describe('parseCatalogue', () => {
  it('parses valid entries and skips malformed ones', () => {
    const voices = parseCatalogue(RAW_FIXTURE);
    expect(voices).toHaveLength(3);
    expect(voices.find((v) => v.name === 'broken')).toBeUndefined();
  });

  it('derives languageCode from locale', () => {
    const voices = parseCatalogue(RAW_FIXTURE);
    const lessac = voices.find((v) => v.key === 'en_US-lessac-medium');
    expect(lessac.languageCode).toBe('en');
    expect(lessac.region).toBe('United States');
  });
});

describe('PiperCatalogue cascading filters', () => {
  it('lists languages, regions, voices and qualities correctly', async () => {
    const cat = new PiperCatalogue(fixtureSource());
    await cat.initialize();

    const languages = cat.listLanguages();
    expect(languages.map((l) => l.code).sort()).toEqual(['en', 'hi']);

    const regions = cat.listRegions('en');
    expect(regions).toEqual([{ locale: 'en_US', region: 'United States' }]);

    const voices = cat.listVoices('en', 'en_US');
    expect(voices.map((v) => v.name).sort()).toEqual(['amy', 'lessac']);

    const qualities = cat.listQualities('en', 'en_US', 'lessac');
    expect(qualities).toEqual(['medium']);
  });

  it('resolves an exact voice and rejects invalid combinations', async () => {
    const cat = new PiperCatalogue(fixtureSource());
    await cat.initialize();
    expect(cat.resolve('en', 'en_US', 'lessac', 'medium')?.key).toBe('en_US-lessac-medium');
    expect(cat.resolve('en', 'en_US', 'lessac', 'high')).toBeUndefined();
  });

  it('searches across name/locale/language/region/quality', async () => {
    const cat = new PiperCatalogue(fixtureSource());
    await cat.initialize();
    expect(cat.search('hindi').map((v) => v.key)).toEqual(['hi_IN-priyamvada-medium']);
    expect(cat.search('lessac')).toHaveLength(1);
  });

  it('picks a sensible default English voice', async () => {
    const cat = new PiperCatalogue(fixtureSource());
    await cat.initialize();
    const def = cat.pickDefaultVoice();
    expect(def?.locale).toBe('en_US');
  });

  it(
    'initialize() never rejects even if the CatalogueSource.loadCache() implementation throws ' +
      'instead of returning null (regression: only refresh() was wrapped in try/catch; a throwing ' +
      'loadCache() propagated out of initialize() as an unhandled rejection when called ' +
      'fire-and-forget, exactly as adapter.js does it)',
    async () => {
      const throwingSource = {
        async fetchJson() { throw new Error('offline'); },
        async loadCache() { throw new Error('cache file is corrupt'); },
        async saveCache() {},
      };
      const cat = new PiperCatalogue(throwingSource);
      await expect(cat.initialize()).resolves.toBeUndefined();
      expect(cat.all()).toEqual([]);
    },
  );
});
