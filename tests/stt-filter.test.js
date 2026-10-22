import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  applySttFilter,
  DEFAULT_SILENCE_GATE,
  DEFAULT_STT_FILTER,
  defaultSttFilter,
  sanitizeSilenceGate,
  sanitizeSttFilter,
} from '../src/stt/stt-filter.js';
import { computeWavRmsDbfs, parsePcm16Wav } from '../src/stt/rms.js';
import { DEFAULT_CONFIG, sanitizeConfig } from '../src/host/config.js';
import { VoiceService } from '../src/host/voice-service.js';

describe('applySttFilter — annotation tokens (conservative defaults)', () => {
  it('strips the five default annotation token families', () => {
    expect(applySttFilter('This is (music) a test.', DEFAULT_STT_FILTER)).toBe('This is  a test.');
    expect(applySttFilter('noise [BLANK_AUDIO] end', DEFAULT_STT_FILTER)).toBe('noise  end');
    expect(applySttFilter('♪♪♪ singing ♪♪♪', DEFAULT_STT_FILTER)).toBe(' singing ');
    expect(applySttFilter('then *sighs* and continues', DEFAULT_STT_FILTER)).toBe('then  and continues');
    expect(applySttFilter('（音楽） plays （music） too', DEFAULT_STT_FILTER)).toBe(' plays  too');
  });

  it('real speech passes untouched ("Thank you." must pass)', () => {
    expect(applySttFilter('Thank you.', DEFAULT_STT_FILTER)).toBe('Thank you.');
    expect(applySttFilter('The meeting starts at 10:00.', DEFAULT_STT_FILTER)).toBe('The meeting starts at 10:00.');
    // "music" as a real word is NOT stripped — only the annotated forms are:
    expect(applySttFilter('I love music.', DEFAULT_STT_FILTER)).toBe('I love music.');
  });

  it('disabled filter passes everything through', () => {
    expect(applySttFilter('(music)', { ...DEFAULT_STT_FILTER, enabled: false })).toBe('(music)');
  });

  it('user rules compose with the defaults (a user-only token is stripped too)', () => {
    const f = defaultSttFilter();
    f.rules.push({ kind: 'literal', value: 'XXNOISEXX', replacement: '' });
    expect(applySttFilter('a XXNOISEXX b (music)', f)).toBe('a  b ');
    // and rules run in order: a user regex appended LAST can collapse the
    // double space the (music) removal leaves behind
    const f2 = defaultSttFilter();
    f2.rules.push({ kind: 'regex', value: '\\s{2,}', replacement: ' ' });
    expect(applySttFilter('a (music) b', f2)).toBe('a b');
  });
});

describe('sanitizeSttFilter / sanitizeSilenceGate', () => {
  it('undefined → default rules + default gate, no errors', () => {
    const { value, errors } = sanitizeSttFilter(undefined);
    expect(errors).toHaveLength(0);
    expect(value.rules).toEqual(DEFAULT_STT_FILTER.rules);
    expect(value.silenceGate).toEqual(DEFAULT_SILENCE_GATE);
  });

  it('a valid silenceGate passes through', () => {
    const { value, errors } = sanitizeSttFilter({ silenceGate: { enabled: true, thresholdDb: -40 } });
    expect(errors).toHaveLength(0);
    expect(value.silenceGate).toEqual({ enabled: true, thresholdDb: -40 });
  });

  it('an out-of-range thresholdDb falls back to the default WITH a report', () => {
    const { value, errors } = sanitizeSttFilter({ silenceGate: { thresholdDb: 55 } });
    expect(value.silenceGate.thresholdDb).toBe(DEFAULT_SILENCE_GATE.thresholdDb);
    expect(errors.some((e) => e.startsWith('sttFilter.silenceGate.thresholdDb'))).toBe(true);
  });

  it('a garbage silenceGate falls back to the default WITH a report', () => {
    const { value, errors } = sanitizeSttFilter({ silenceGate: 'nope' });
    expect(value.silenceGate).toEqual(DEFAULT_SILENCE_GATE);
    expect(errors.some((e) => e.startsWith('sttFilter.silenceGate:'))).toBe(true);
  });

  it('invalid + ReDoS-shaped user rules are disabled, defaults survive', () => {
    const { value, errors } = sanitizeSttFilter({
      rules: [{ kind: 'regex', value: '(' }, { kind: 'regex', value: '(a+)+b' }, { kind: 'literal', value: 'ok' }],
    });
    expect(value.rules).toHaveLength(1);
    expect(value.rules[0].value).toBe('ok');
    expect(errors.some((e) => e.includes('invalid regex'))).toBe(true);
    expect(errors.some((e) => e.includes('catastrophic'))).toBe(true);
  });

  it('garbage field type → full default + report', () => {
    const { value, errors } = sanitizeSttFilter(42);
    expect(value).toEqual(defaultSttFilter());
    expect(errors.some((e) => e.startsWith('sttFilter:'))).toBe(true);
  });

  it('sanitizeSilenceGate unit: valid boolean + threshold accepted', () => {
    const { value, errors } = sanitizeSilenceGate({ enabled: false, thresholdDb: -30 });
    expect(errors).toHaveLength(0);
    expect(value).toEqual({ enabled: false, thresholdDb: -30 });
  });
});

describe('sanitizeConfig integration (sttFilter)', () => {
  it('a valid sttFilter passes through with no errors', () => {
    const { config, errors } = sanitizeConfig({ sttFilter: { silenceGate: { thresholdDb: -50 } } });
    expect(errors.filter((e) => e.startsWith('sttFilter'))).toHaveLength(0);
    expect(config.sttFilter.silenceGate.thresholdDb).toBe(-50);
    expect(config.sttFilter.rules).toEqual(DEFAULT_STT_FILTER.rules);
  });

  it('a garbage sttFilter falls back to the default WITH a report', () => {
    const { config, errors } = sanitizeConfig({ sttFilter: 'garbage' });
    expect(config.sttFilter).toEqual(DEFAULT_CONFIG.sttFilter);
    expect(errors.some((e) => e.startsWith('sttFilter'))).toBe(true);
  });
});

// --- RMS (silence gate) -----------------------------------------------------

/** Builds the exact 44-byte-header 16 kHz mono PCM16 WAV the client sends. */
function buildWav16kMono(samples) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(32000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((s, i) => buf.writeInt16LE(s, 44 + i * 2));
  return buf;
}

describe('computeWavRmsDbfs', () => {
  it('digital silence → far below any threshold', () => {
    const dbfs = computeWavRmsDbfs(buildWav16kMono(new Array(16000).fill(0)));
    expect(dbfs).toBeLessThanOrEqual(-100);
  });

  it('full-scale square wave → ≈ 0 dBFS', () => {
    const samples = Array.from({ length: 16000 }, (_, i) => (i % 2 === 0 ? 32767 : -32768));
    const dbfs = computeWavRmsDbfs(buildWav16kMono(samples));
    expect(dbfs).toBeGreaterThan(-0.5);
    expect(dbfs).toBeLessThanOrEqual(0);
  });

  it('a -20 dBFS sine wave measures ≈ -20 dBFS (±0.5)', () => {
    const amp = 32768 * 10 ** (-20 / 20) * Math.SQRT2;
    const n = 16000;
    const samples = Array.from({ length: n }, (_, i) => Math.round(amp * Math.sin((2 * Math.PI * 440 * i) / 16000)));
    const dbfs = computeWavRmsDbfs(buildWav16kMono(samples));
    expect(Math.abs(dbfs - -20)).toBeLessThan(0.5);
  });

  it('rejects non-WAV and truncated buffers (null → the gate is skipped, never "silence")', () => {
    expect(computeWavRmsDbfs(Buffer.from('not a wav at all'))).toBeNull();
    expect(computeWavRmsDbfs(buildWav16kMono([1, 2, 3]).subarray(0, 30))).toBeNull();
    expect(computeWavRmsDbfs(Buffer.alloc(44 + 8))).toBeNull();
  });

  it('rejects non-PCM16 formats (e.g. PCM8, float) → null', () => {
    const wav = buildWav16kMono([1, 2, 3]);
    wav.writeUInt16LE(8, 34); // bits per sample → 8
    expect(parsePcm16Wav(wav)).toBeNull();
    const wav2 = buildWav16kMono([1, 2, 3]);
    wav2.writeUInt16LE(3, 20); // audio format → IEEE float
    expect(parsePcm16Wav(wav2)).toBeNull();
  });

  it('handles stereo (averages channels)', () => {
    // Both channels identical → same level as mono.
    const mono = buildWav16kMono(new Array(8000).fill(8000));
    const samples = new Array(8000).fill(8000);
    const stereo = Buffer.alloc(44 + 8000 * 2 * 2);
    stereo.write('RIFF', 0);
    stereo.writeUInt32LE(36 + 8000 * 4, 4);
    stereo.write('WAVE', 8);
    stereo.write('fmt ', 12);
    stereo.writeUInt32LE(16, 16);
    stereo.writeUInt16LE(1, 20);
    stereo.writeUInt16LE(2, 22); // stereo
    stereo.writeUInt32LE(16000, 24);
    stereo.writeUInt32LE(64000, 28);
    stereo.writeUInt16LE(4, 32);
    stereo.writeUInt16LE(16, 34);
    stereo.write('data', 36);
    stereo.writeUInt32LE(8000 * 4, 40);
    samples.forEach((s, i) => {
      stereo.writeInt16LE(s, 44 + i * 4);
      stereo.writeInt16LE(s, 44 + i * 4 + 2);
    });
    expect(computeWavRmsDbfs(stereo)).toBeCloseTo(computeWavRmsDbfs(mono), 5);
  });
});

// --- VoiceService.transcribe integration (gate + filter) --------------------

let tempDir;
beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'osound-stt-test-'));
});
afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function makeSttService({ sttFilter, calls }) {
  return new VoiceService({
    runtimeManager: {
      checkWhisper: async () => ({ state: 'installed', missing: [] }),
      getWhisperExePath: () => 'C:/unused/whisper.exe',
    },
    modelManager: { isInstalled: async () => 'installed', modelPath: () => 'C:/unused/model.bin' },
    piperCatalogue: {},
    piperVoicesDir: tempDir,
    voiceTempDir: tempDir,
    getConfig: () => ({
      whisperModel: 'tiny',
      whisperLanguage: 'auto',
      whisperTask: 'transcribe',
      sttFilter,
    }),
    playWav: async () => {},
    log: () => {},
    // Test seam (deps.runWhisper): records the call and returns an annotated transcript.
    runWhisper: (opts) => {
      calls.push(opts);
      return Promise.resolve({ text: 'This is (music) a test [BLANK_AUDIO].', durationMs: 1 });
    },
  });
}

describe('VoiceService.transcribe — silence gate + STT filter', () => {
  it('a silent recording returns "" and NEVER spawns Whisper', async () => {
    const calls = [];
    const wavPath = path.join(tempDir, 'silent.wav');
    await writeFile(wavPath, buildWav16kMono(new Array(16000).fill(0)));
    const service = makeSttService({ calls, sttFilter: defaultSttFilter() });

    const text = await service.transcribe(wavPath);
    expect(text).toBe('');
    expect(calls).toHaveLength(0); // Whisper never ran
  });

  it('a loud recording runs Whisper and the transcript is FILTERED', async () => {
    const calls = [];
    const wavPath = path.join(tempDir, 'loud.wav');
    const samples = Array.from({ length: 16000 }, (_, i) => (i % 2 === 0 ? 32767 : -32768));
    await writeFile(wavPath, buildWav16kMono(samples));
    const service = makeSttService({ calls, sttFilter: defaultSttFilter() });

    const text = await service.transcribe(wavPath);
    expect(calls).toHaveLength(1);
    expect(text).not.toContain('(music)');
    expect(text).not.toContain('[BLANK_AUDIO]');
    expect(text).toContain('a test');
  });

  it('with the gate disabled, silence still runs Whisper', async () => {
    const calls = [];
    const wavPath = path.join(tempDir, 'silent2.wav');
    await writeFile(wavPath, buildWav16kMono(new Array(16000).fill(0)));
    const f = defaultSttFilter();
    f.silenceGate.enabled = false;
    const service = makeSttService({ calls, sttFilter: f });

    const text = await service.transcribe(wavPath);
    expect(calls).toHaveLength(1);
    expect(text).toContain('a test');
  });

  it('unparseable audio SKIPS the gate (never treated as silence)', async () => {
    const calls = [];
    const wavPath = path.join(tempDir, 'garbage.bin');
    await writeFile(wavPath, Buffer.from('definitely not a wav file'));
    const service = makeSttService({ calls, sttFilter: defaultSttFilter() });

    const text = await service.transcribe(wavPath);
    expect(calls).toHaveLength(1); // gate skipped → Whisper ran
    expect(text).toContain('a test');
  });
});

import { wordToSttTagRule, addWordsToFilterRules } from '../src/stt/stt-filter.js';

describe('v0.5.1 Whisper common tags & word-to-filter helpers', () => {
  it('strips capitalized, bracketed, parenthesized, and multi-word common Whisper tags', () => {
    expect(applySttFilter('[Music] Hello [Applause] world (Laughter)!', DEFAULT_STT_FILTER)).toBe(' Hello  world !');
    expect(applySttFilter('(upbeat music) testing [Background Music] 123', DEFAULT_STT_FILTER)).toBe(' testing  123');
    expect(applySttFilter('[Blank Audio] (clearing throat) [Inaudible] (speaking foreign language)', DEFAULT_STT_FILTER).trim()).toBe('');
    expect(applySttFilter('Subtitles by the Amara.org community.', DEFAULT_STT_FILTER).trim()).toBe('');
    expect(applySttFilter('<|nospeech|> ♪ hello ♪', DEFAULT_STT_FILTER).trim()).toBe('hello');
  });

  it('wordToSttTagRule and addWordsToFilterRules auto-convert bare words or bracketed words into tag rules', () => {
    const rules = addWordsToFilterRules([], '(music), (noise), cough', 'tag');
    expect(rules).toHaveLength(3);
    const filter = { enabled: true, rules };
    expect(applySttFilter('Hello (music) [MUSIC] *noise* （cough） world', filter)).toBe('Hello     world');
    // Real speech with those words outside brackets is untouched:
    expect(applySttFilter('I love music and I have a cough.', filter)).toBe('I love music and I have a cough.');
  });

  it('auto-upgrades unmodified v0.5.0 legacy 5-rule array to v0.5.1 defaults', () => {
    const legacyRaw = {
      enabled: true,
      rules: [
        { kind: 'regex', value: '\\(\\s*(?:music|noise|silence|sound|applause)\\s*\\)', replacement: '' },
        { kind: 'regex', value: '（\\s*(?:音楽|music|noise)\\s*）', replacement: '' },
        { kind: 'regex', value: '\\[\\s*(?:BLANK_AUDIO|blank_audio|NOISE|noise|SILENCE|silence)\\s*\\]', replacement: '' },
        { kind: 'literal', value: '♪♪♪', replacement: '' },
        { kind: 'regex', value: '\\*(?:sighs?|laughs?|chuckles?|chews?|coughs?|hums?|breathes?|applause|clears?\\s+throat)\\*', replacement: '' },
      ],
    };
    const { value, errors } = sanitizeSttFilter(legacyRaw);
    expect(errors).toHaveLength(0);
    expect(applySttFilter('[Music] (Laughter)', value).trim()).toBe('');
  });
});
