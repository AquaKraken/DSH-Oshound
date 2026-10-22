// src/models/piper-catalogue.js
// Parses the official rhasspy/piper-voices voices.json catalogue into
// typed PiperVoiceDescriptor entries and provides cascading
// language -> region -> voice -> quality filtering for the settings UI.
//
// Per spec §16/§78/§79: voices.json is the single source of truth. No
// voice/language/region list is ever hard-coded in production code paths
// (small illustrative examples are fine in tests only).

const HF_VOICES_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main';
const HF_VOICES_JSON = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/voices.json';

/**
 * Raw shape of an entry in the upstream voices.json. Upstream schema is
 * community-maintained, so every field access below is defensive — a
 * malformed/missing field causes that single voice to be skipped rather
 * than throwing (see parseCatalogue), and the last valid cached catalogue
 * is kept on total parse failure (see PiperCatalogue.refresh).
 *
 * @typedef {Object} RawPiperVoiceEntry
 * @property {string} [key]
 * @property {string} [name]
 * @property {{code?: string, family?: string, region?: string, name_native?: string, name_english?: string, country_english?: string}} [language]
 * @property {string} [quality]
 * @property {number} [num_speakers]
 * @property {Object.<string, {size_bytes?: number, md5_digest?: string}>} [files]
 */

const REGION_LANGUAGE_DISPLAY = {
  en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese',
  nl: 'Dutch', ru: 'Russian', pl: 'Polish', tr: 'Turkish', vi: 'Vietnamese', zh: 'Chinese',
  ja: 'Japanese', hi: 'Hindi', ml: 'Malayalam', te: 'Telugu', uk: 'Ukrainian', ar: 'Arabic',
  fi: 'Finnish', el: 'Greek', hu: 'Hungarian', ka: 'Georgian', kk: 'Kazakh', lb: 'Luxembourgish',
  ne: 'Nepali', no: 'Norwegian', fa: 'Persian', ro: 'Romanian', sr: 'Serbian', sk: 'Slovak',
  sl: 'Slovenian', sv: 'Swedish', sw: 'Swahili', ca: 'Catalan', cs: 'Czech', cy: 'Welsh',
  da: 'Danish', is: 'Icelandic', lv: 'Latvian', kokoro: 'Multilingual',
};

/** @type {readonly import('../shared/types.js').PiperQuality[]} */
const VALID_QUALITIES = ['x_low', 'low', 'medium', 'high'];

/** @param {unknown} q @returns {boolean} */
function isValidQuality(q) {
  return typeof q === 'string' && VALID_QUALITIES.includes(q);
}

/**
 * Parses a raw voices.json payload into validated descriptors, skipping malformed entries.
 * @param {unknown} rawJson
 * @returns {import('../shared/types.js').PiperVoiceDescriptor[]}
 */
export function parseCatalogue(rawJson) {
  if (typeof rawJson !== 'object' || rawJson === null) {
    throw new Error('voices.json root is not an object');
  }
  const out = [];
  for (const [key, rawEntry] of Object.entries(rawJson)) {
    const entry = rawEntry;
    try {
      const code = entry.language?.code;
      const quality = entry.quality;
      const name = entry.name;
      if (!code || !isValidQuality(quality) || !name) continue;

      const locale = code; // e.g. "en_US"
      const languageCode = locale.split(/[_-]/)[0] ?? locale;
      const region = entry.language?.country_english ?? entry.language?.region ?? '';
      const languageDisplay = entry.language?.name_english ?? REGION_LANGUAGE_DISPLAY[languageCode] ?? languageCode;

      const onnxFile = Object.keys(entry.files ?? {}).find((f) => f.endsWith('.onnx'));
      const jsonFile = Object.keys(entry.files ?? {}).find((f) => f.endsWith('.onnx.json'));
      if (!onnxFile || !jsonFile) continue;

      out.push({
        key: entry.key ?? key,
        language: languageDisplay,
        languageCode,
        locale,
        region,
        name,
        quality,
        numSpeakers: entry.num_speakers ?? 1,
        onnxUrl: `${HF_VOICES_BASE}/${onnxFile}`,
        onnxConfigUrl: `${HF_VOICES_BASE}/${jsonFile}`,
        onnxSizeBytes: entry.files?.[onnxFile]?.size_bytes,
        modelCardUrl: `https://huggingface.co/rhasspy/piper-voices/blob/main/${languageCode}/${locale}/${name.toLowerCase()}/README.md`,
      });
    } catch {
      // Skip malformed entry; never let one bad row break the whole catalogue.
      continue;
    }
  }
  return out;
}

/**
 * @typedef {Object} CatalogueSource
 * @property {() => Promise<unknown>} fetchJson - Fetches the raw catalogue JSON. Injected so host code can swap in a cache-aware implementation.
 * @property {() => Promise<import('../shared/types.js').PiperVoiceDescriptor[]|null>} loadCache
 * @property {(voices: import('../shared/types.js').PiperVoiceDescriptor[]) => Promise<void>} saveCache
 */

export class PiperCatalogue {
  voices = [];
  lastRefreshed = null;

  static VOICES_JSON_URL = HF_VOICES_JSON;

  /** @param {CatalogueSource} source */
  constructor(source) {
    this.source = source;
  }

  /** Tries cache first (per §48), then attempts a network refresh; falls back to cache on failure. */
  async initialize() {
    try {
      const cached = await this.source.loadCache();
      if (cached) this.voices = cached;
    } catch {
      // A misbehaving CatalogueSource.loadCache() must not take initialize()
      // down with it — this fire-and-forget call has no caller to catch a
      // rejection (see adapter.js), so this class has to be the one that's
      // defensive. Falls through to refresh() with an empty catalogue,
      // same as a legitimate cache-miss.
    }
    try {
      await this.refresh();
    } catch {
      // Offline/refresh failure: keep whatever was loaded from cache (possibly empty).
    }
  }

  async refresh() {
    const raw = await this.source.fetchJson();
    const parsed = parseCatalogue(raw);
    if (parsed.length === 0) {
      throw new Error('Catalogue refresh produced zero valid voices; keeping cached catalogue.');
    }
    this.voices = parsed;
    this.lastRefreshed = Date.now();
    await this.source.saveCache(parsed);
  }

  getLastRefreshed() {
    return this.lastRefreshed;
  }

  listLanguages() {
    const map = new Map();
    for (const v of this.voices) map.set(v.languageCode, v.language);
    return [...map.entries()].map(([code, name]) => ({ code, name })).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** @param {string} languageCode */
  listRegions(languageCode) {
    const map = new Map();
    for (const v of this.voices) {
      if (v.languageCode === languageCode) map.set(v.locale, v.region || v.locale);
    }
    return [...map.entries()].map(([locale, region]) => ({ locale, region })).sort((a, b) => a.region.localeCompare(b.region));
  }

  /** @param {string} languageCode @param {string} locale */
  listVoices(languageCode, locale) {
    const set = new Set();
    for (const v of this.voices) {
      if (v.languageCode === languageCode && v.locale === locale) set.add(v.name);
    }
    return [...set].sort().map((name) => ({ name }));
  }

  /** @param {string} languageCode @param {string} locale @param {string} name */
  listQualities(languageCode, locale, name) {
    const set = new Set();
    for (const v of this.voices) {
      if (v.languageCode === languageCode && v.locale === locale && v.name === name) set.add(v.quality);
    }
    return [...set];
  }

  /** @param {string} key */
  getVoice(key) {
    return this.voices.find((v) => v.key === key);
  }

  /** @param {string} languageCode @param {string} locale @param {string} name @param {import('../shared/types.js').PiperQuality} quality */
  resolve(languageCode, locale, name, quality) {
    return this.voices.find(
      (v) => v.languageCode === languageCode && v.locale === locale && v.name === name && v.quality === quality,
    );
  }

  /** @param {string} query */
  search(query) {
    const q = query.trim().toLowerCase();
    if (!q) return this.voices;
    return this.voices.filter(
      (v) =>
        v.name.toLowerCase().includes(q) ||
        v.locale.toLowerCase().includes(q) ||
        v.language.toLowerCase().includes(q) ||
        v.region.toLowerCase().includes(q) ||
        v.quality.toLowerCase().includes(q),
    );
  }

  /**
   * Picks a sensible default voice per §47: English, en_US, single speaker,
   * medium quality preferred, falling back gracefully if that exact
   * combination isn't present in the current catalogue.
   */
  pickDefaultVoice() {
    const candidates = this.voices.filter((v) => v.languageCode === 'en');
    const byPreference = (v) =>
      (v.locale === 'en_US' ? 0 : 1) * 100 + (v.numSpeakers === 1 ? 0 : 1) * 10 + (v.quality === 'medium' ? 0 : 1);
    return [...candidates].sort((a, b) => byPreference(a) - byPreference(b))[0] ?? this.voices[0];
  }

  all() {
    return this.voices;
  }
}
