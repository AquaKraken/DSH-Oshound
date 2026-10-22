import { describe, expect, it } from 'vitest';
import {
  normalizeWords,
  findOverlap,
  sliceFromWord,
  reconcileWindow,
  finalizeTranscript,
} from '../src/shared/stt-reconcile.js';

describe('normalizeWords', () => {
  it('lowercases and strips punctuation, apostrophes, and numbers are kept', () => {
    expect(normalizeWords('Hello, world! Don\'t stop. Room 204.')).toEqual(['hello', 'world', 'dont', 'stop', 'room', '204']);
  });

  it('handles empty/whitespace input', () => {
    expect(normalizeWords('')).toEqual([]);
    expect(normalizeWords('   ')).toEqual([]);
    expect(normalizeWords(null)).toEqual([]);
  });
});

describe('findOverlap', () => {
  it('returns 0 when nothing overlaps', () => {
    expect(findOverlap(['hello', 'world'], ['foo', 'bar'])).toBe(0);
  });

  it('returns the full window length when it is fully covered by the tail', () => {
    expect(findOverlap(['how', 'are', 'you'], ['how', 'are', 'you'])).toBe(3);
  });

  it('returns the largest overlapping prefix', () => {
    // tail "are you" of accumulated matches the first 2 words of the window
    expect(findOverlap(['hello', 'how', 'are', 'you'], ['are', 'you', 'doing', 'well'])).toBe(2);
  });

  it('tolerates one flipped word inside the overlap (fuzzy)', () => {
    // "you" vs "ur" flip: 3/4 = 0.75 still clears the default bar
    expect(findOverlap(['how', 'are', 'you', 'doing'], ['how', 'are', 'ur', 'doing'])).toBe(4);
  });

  it('rejects when no word matches at all', () => {
    expect(findOverlap(['zzz', 'aaa'], ['ccc', 'ddd'])).toBe(0);
  });
});

describe('sliceFromWord', () => {
  it('cuts before word k, preserving the original text after it', () => {
    expect(sliceFromWord('How are you doing?', 2)).toBe('you doing?');
  });

  it('strips leading punctuation left at the cut', () => {
    expect(sliceFromWord('how are. you doing', 2)).toBe('you doing');
  });

  it('returns empty when k reaches the last word', () => {
    expect(sliceFromWord('a b c', 3)).toBe('');
  });

  it("apostrophe-joined words are ONE word and both functions agree (regression: slice/normalize boundary mismatch)", () => {
    expect(normalizeWords("Don't stop")).toEqual(['dont', 'stop']);
    expect(sliceFromWord("Don't stop it", 1)).toBe('stop it');
    expect(reconcileWindow("Please don't", "don't stop it now")).toBe("Please don't stop it now");
  });
});

describe('reconcileWindow — incremental/partial handling', () => {
  it('takes the first window as-is (empty accumulation)', () => {
    expect(reconcileWindow('', 'Good morning everyone')).toBe('Good morning everyone');
  });

  it('appends a non-overlapping window', () => {
    expect(reconcileWindow('Good morning', 'How are you doing?')).toBe('Good morning How are you doing?');
  });

  it('deduplicates the overlap: the window head re-covering the tail is not re-appended', () => {
    const step1 = reconcileWindow('', 'Good morning how are');
    const step2 = reconcileWindow(step1, 'how are you today');
    expect(step2).toBe('Good morning how are you today');
  });

  it('runs a multi-window sequence without duplicating words (incremental build-up)', () => {
    // Simulated windows of a 2-second stride over the same utterance: each
    // window re-transcribes its leading 1.5s (the overlap) plus new tail.
    let acc = '';
    acc = reconcileWindow(acc, 'The quick brown fox jumps');
    acc = reconcileWindow(acc, 'brown fox jumps over the');
    acc = reconcileWindow(acc, 'fox jumps over the lazy');
    acc = reconcileWindow(acc, 'jumps over the lazy dog');
    expect(acc).toBe('The quick brown fox jumps over the lazy dog');
  });

  it('an empty window (silence) leaves the transcript unchanged', () => {
    expect(reconcileWindow('Already said words', '')).toBe('Already said words');
    expect(reconcileWindow('Already said words', '   ')).toBe('Already said words');
  });

  it('is idempotent: re-transcribing the same audio appends nothing (no duplicated transcript text)', () => {
    const acc = 'The quick brown fox jumps over the lazy dog';
    // A duplicated window covering the same span returns the identical text:
    expect(reconcileWindow(acc, 'the quick brown fox jumps over the lazy dog')).toBe(acc);
    // ...and even a partial re-coverage of the tail:
    expect(reconcileWindow(acc, 'over the lazy dog')).toBe(acc);
  });
});

describe('reconcileWindow — multiple speech segments and pauses', () => {
  it('handles a mid-speech pause (empty window in between) without breaking continuity', () => {
    let acc = reconcileWindow('', 'First sentence here');
    acc = reconcileWindow(acc, ''); // the pause window transcribes to nothing
    expect(acc).toBe('First sentence here');
    // Speech resumes: the overlap still matches the pre-pause tail
    acc = reconcileWindow(acc, 'here second sentence');
    expect(acc).toBe('First sentence here second sentence');
  });

  it('handles repeated words in speech (e.g. "no no no again") across windows', () => {
    // Windows slide over "no no no again": each re-covers the 2-word overlap.
    let acc = reconcileWindow('', 'no no');
    acc = reconcileWindow(acc, 'no no no'); // overlap "no no" -> append "no"
    expect(acc).toBe('no no no');
    acc = reconcileWindow(acc, 'no no again'); // overlap "no no" -> append "again"
    expect(acc).toBe('no no no again');
  });

  it('appends brand-new speech after a long silence (no overlap at all)', () => {
    expect(reconcileWindow('Morning', 'Good afternoon everyone')).toBe('Morning Good afternoon everyone');
  });
});

describe('reconcileWindow — short speech', () => {
  it('a window shorter than the overlap is fully covered once spoken (no growth, no loss)', () => {
    let acc = reconcileWindow('', 'Hi');
    expect(reconcileWindow(acc, 'Hi')).toBe('Hi'); // identical re-window
    expect(reconcileWindow(acc, 'hi there')).toBe('Hi there'); // tiny extension
  });

  it('punctuation/case differences in the overlap do not block dedup', () => {
    const acc = reconcileWindow('', 'Hello world, this is');
    // whisper re-transcribed the overlap with different punctuation/case
    const next = reconcileWindow(acc, 'hello world this is a test');
    expect(next).toBe('Hello world, this is a test');
  });
});

describe('finalizeTranscript — partial -> final reconciliation', () => {
  it('the full-recording transcription is authoritative', () => {
    expect(finalizeTranscript('incremental partial words', 'The clean final transcript')).toBe('The clean final transcript');
  });

  it('keeps the incremental partial when the final pass is empty (fallback)', () => {
    expect(finalizeTranscript('incremental partial words', '')).toBe('incremental partial words');
    expect(finalizeTranscript('incremental partial words', '   ')).toBe('incremental partial words');
  });

  it('returns empty when both are empty', () => {
    expect(finalizeTranscript('', '')).toBe('');
  });

  it('the final result has no duplicated words even when the partial did', () => {
    // a hallucinated duplication in the partial must not leak into the final
    expect(finalizeTranscript('word word word', 'word word word once')).toBe('word word word once');
  });
});
