// src/client/player.js
// Client half of the TTS chunk hand-off: the host (src/dsh/adapter.js)
// synthesizes WAV chunks with Piper and publishes them; this class
// long-polls /tts/chunk, plays each chunk through Web Audio, and acks so
// the host advances to the next chunk. Multiple players can coexist — the
// host's TtsQueue serializes jobs, and each player simply waits (via the
// long-poll) for its own job's turn.
//
// Design (2026-10-05 decode-ahead rewrite):
//   * ONE persistent AudioContext per job (lazy-created, resumed if
//     suspended, closed when the job ends).
//   * TWO LANES (the point of this rewrite):
//       fetch lane:  long-poll chunk N+1 → DECODE N+1 while N is still
//                    playing → push the decoded buffer into a small ready
//                    queue (decode-ahead; the old code only decoded AFTER
//                    the previous chunk ended, so a late fetch caused an
//                    audible gap).
//       play lane:   take decoded buffers in order and SCHEDULE each at
//                    exactly the previous chunk's end time (src.start at
//                    _nextStartAt), so a decoded chunk plays seamlessly
//                    even though it was scheduled while the previous one
//                    was still sounding. Acks are sent at schedule time
//                    (playback start), exactly once per chunk.
//   * UNDERRUN DETECTION: if a chunk's scheduled start lands after the
//     previous chunk's end (a real gap in the audio), the gap is counted
//     (this.underruns) and warned in the console — recovery is inherent:
//     the late chunk is scheduled at the earliest possible moment.
//   * _ackThenError (BUG-1 guard): if a received chunk then fails, ack it
//     first so the host's 60s ack watchdog does not hold the TTS queue.
//   * Generation guard: speak()/stop() bump an internal generation; old
//     lanes from a superseded job exit instead of touching the new job's
//     queue.
//   * stop() aborts the in-flight chunk fetch, stops EVERY scheduled
//     source (there may be more than one queued), and clears the ready
//     queue. Exactly-once: a chunk is decoded once, scheduled once, acked
//     once.
//
// Public API (unchanged): speak(text, volume), pause(), resume(), stop(),
// onState(fn) -> unsubscribe. New diagnostic: this.underruns (number).

import { api } from './api.js';

/**
 * @typedef {'idle'|'generating'|'playing'|'paused'|'error'} PlayerState
 */

/** FNV-1a 32-bit over the chunk bytes, qualified by length — a cheap identity
 * for duplicate-chunk detection (a re-delivered chunk is byte-identical). */
function chunkSig(buf) {
  const bytes = new Uint8Array(buf);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return `${bytes.length}:${(h >>> 0).toString(16)}`;
}

/** Gap between chunks above this many ms counts as an underrun (clock jitter budget). */
const UNDERRUN_MS = 50;

export class SpeakerPlayer {
  constructor() {
    this.state = 'idle';
    this.jobId = null;
    this.error = null;
    this.underruns = 0; // underrun gaps observed for the current/last job
    this._aborted = false;
    this._gen = 0; // bumped on speak()/stop() — old lanes exit on mismatch
    this._volume = 1.0;
    this._listeners = new Set();
    this._audioCtx = null; // one persistent context per job
    this._gain = null;
    this._scheduledSrcs = []; // buffer sources scheduled (current + decode-ahead lookahead)
    this._ready = []; // decoded AudioBuffers waiting to be scheduled (small lookahead)
    this._readyWaiter = null; // resolver parked by the play lane
    this._laneResult = null; // 'done' | Error | null (fetch-lane terminal result)
    this._drainWaiter = null; // resolver for "all scheduled sources have ended"
    this._fetchCtl = null; // AbortController of the in-flight chunk fetch
    this._nextStartAt = null; // AudioContext time at which the next chunk starts
    this._debug = false; // filled from config.debugLogging (fetched once)
    this._lastChunkSig = null; // signature of the last chunk RECEIVED (dup detection)
    this._chunkSeq = 0; // per-job chunk sequence (debug logging)
    api.getJson('/config')
      .then((j) => {
        this._debug = !!(j && j.config && j.config.debugLogging);
      })
      .catch(() => {}); // diagnostics only — never fatal
  }

  /** Debug-gated chunk-lifecycle log. @param {string} m */
  _dlog(m) {
    if (this._debug) console.log('[O-Sound][TTS]', m);
  }

  /** @param {(s: PlayerState, err?: string) => void} fn @returns {() => void} */
  onState(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _setState(s, error = null) {
    this.state = s;
    this.error = error;
    for (const fn of [...this._listeners]) fn(s, error);
  }

  /** Lazily creates (or resumes) this player's persistent AudioContext. */
  _ensureCtx() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('AudioContext is not available in this browser');
    if (!this._audioCtx || this._audioCtx.state === 'closed') {
      this._audioCtx = new AC();
      this._gain = this._audioCtx.createGain();
      this._gain.connect(this._audioCtx.destination);
    }
    this._gain.gain.value = this._volume;
    if (this._audioCtx.state === 'suspended') this._audioCtx.resume().catch(() => {});
    return this._audioCtx;
  }

  /** Closes the persistent context once the job is over (recreated on next speak). */
  _closeCtx() {
    if (this._audioCtx) {
      this._audioCtx.close().catch(() => {});
      this._audioCtx = null;
      this._gain = null;
    }
    this._nextStartAt = null;
  }

  /** Starts speaking `text` on the host queue. @param {string} text @param {number} volume */
  async speak(text, volume = 1.0) {
    this.stopLocal();
    this._aborted = false;
    this._gen += 1; // invalidate any lanes from a previous job
    this.error = null;
    this._volume = volume;
    this._nextStartAt = null;
    this._lastChunkSig = null;
    this._chunkSeq = 0;
    this.underruns = 0;
    this._ready = [];
    this._readyWaiter = null;
    this._laneResult = null;
    this._scheduledSrcs = [];
    this._drainWaiter = null;
    this._dlog(`speak() text=${text.length} chars "${String(text).replace(/\s+/g, ' ').trim().slice(0, 60)}"`);
    try {
      const res = await api.postJson('/tts', { text });
      this.jobId = res.jobId;
      this._dlog(`job=${this.jobId} accepted`);
      this._setState('generating');
      void this._loop();
    } catch (err) {
      this._setState('error', err.message);
    }
  }

  /**
   * Long-polls the next chunk of the job.
   * @param {string} jobId
   * @returns {Promise<{kind:'chunk', buf: ArrayBuffer} | {kind:'done'}>}
   * Rejects with an Error carrying a `.published` flag (was a chunk received from
   * the host and therefore needs an ack?) on non-OK / network failure.
   */
  async _fetchNext(jobId) {
    for (;;) {
      if (this._aborted) throw new Error('aborted'); // sentinel: lanes bail quietly
      const ctl = new AbortController();
      this._fetchCtl = ctl;
      let r;
      try {
        r = await api.fetch(`/tts/chunk?jobId=${encodeURIComponent(jobId)}`, { signal: ctl.signal });
      } catch (err) {
        if (this._aborted) throw err; // AbortError (or the sentinel above)
        const e = new Error('Connection to O-Sound host lost');
        e.published = false;
        throw e;
      } finally {
        if (this._fetchCtl === ctl) this._fetchCtl = null;
      }
      if (r.status === 204) return { kind: 'done' }; // job finished/stopped on host
      if (r.status === 203) continue; // long-poll timed out — wait again
      if (!r.ok) {
        const msg = await r
          .clone()
          .json()
          .then((j) => j?.error)
          .catch(() => `chunk fetch failed: HTTP ${r.status}`);
        const e = new Error(msg);
        e.published = false; // no chunk received — nothing to ack
        throw e;
      }
      try {
        return { kind: 'chunk', buf: await r.arrayBuffer() };
      } catch (err) {
        const e = new Error(`chunk download failed: ${err.message}`);
        e.published = true; // the host has this chunk published — ack to release it
        throw e;
      }
    }
  }

  /**
   * FETCH LANE: long-poll → (dup check) → DECODE → push to the ready queue.
   * Decoding happens while the previous chunk is still playing (decode-ahead);
   * the play lane schedules from the queue without waiting for playback to end.
   * Terminal results ('done' or Error) are parked in _laneResult.
   * @param {string} jobId
   * @param {number} gen generation this lane belongs to
   */
  async _fetchLane(jobId, gen) {
    let inHand = false; // a chunk's bytes were received (host has it published)
    try {
      for (;;) {
        if (this._aborted || gen !== this._gen) return;
        const item = await this._fetchNext(jobId);
        if (item.kind === 'chunk') inHand = true;
        if (this._aborted || gen !== this._gen) return;
        if (item.kind === 'done') {
          this._laneResult = 'done';
          this._wakeReady();
          return;
        }
        // Duplicate/replay detection (ALWAYS on — it must never fire after the
        // exactly-once handoff fix, so a hit is a genuine regression alarm):
        // a chunk that is byte-identical to the previously received one means
        // the host served the same published chunk to a second long-poll.
        this._chunkSeq += 1;
        const sig = chunkSig(item.buf);
        if (this._lastChunkSig === sig) {
          console.warn('[O-Sound][TTS] DUPLICATE CHUNK: chunk', this._chunkSeq, 'is byte-identical to the previously played chunk — it will be played twice');
        } else {
          this._lastChunkSig = sig;
        }
        this._dlog(`chunk ${this._chunkSeq} received (${item.buf.byteLength} bytes)`);
        // DECODE-AHEAD: decode while the previous chunk is still sounding.
        const ctx = this._ensureCtx();
        const t0 = Date.now();
        const audioBuffer = await ctx.decodeAudioData(item.buf); // detaches item.buf
        this._dlog(`chunk ${this._chunkSeq} decoded in ${Date.now() - t0}ms (${audioBuffer.duration.toFixed(2)}s audio, decode-ahead)`);
        if (this._aborted || gen !== this._gen) return;
        this._ready.push({ audioBuffer });
        this._wakeReady();
      }
    } catch (err) {
      if (this._aborted || gen !== this._gen) return;
      const e = err instanceof Error ? err : new Error(String(err));
      if (inHand && e.published !== true) e.published = true; // bytes in hand → ack to release it
      this._dlog(`fetch lane error: ${e.message} (published=${e.published})`);
      this._laneResult = e;
      this._wakeReady();
    }
  }

  /**
   * PLAY LANE + lane pump: wait for a decoded chunk (or the lane's terminal
   * result), schedule it at the previous chunk's end time, and repeat. Does
   * NOT wait for playback to end — that is what allows the next chunk to be
   * scheduled while the current one is still sounding.
   * @param {string} jobId
   * @param {number} gen generation this loop belongs to
   */
  async _loop() {
    const jobId = this.jobId;
    if (!jobId) return;
    const gen = this._gen;
    this._fetchLane(jobId, gen); // runs in parallel; terminal result parked in _laneResult
    for (;;) {
      if (this._aborted || gen !== this._gen) return;
      const item = await this._takeReady();
      if (this._aborted || gen !== this._gen) return;
      if (item === 'done') {
        // The host finished after the last ack. All chunks are already
        // scheduled — wait for the audio to actually end before closing the
        // context (closing early would clip the tail).
        this._dlog(`job=${jobId} done after ${this._chunkSeq} chunk(s) — draining audio`);
        await this._drainScheduled();
        if (gen !== this._gen) return;
        this._finish();
        return;
      }
      if (item instanceof Error) {
        this._ackThenError(jobId, item.message ?? String(item), item.published === true, gen);
        return;
      }
      try {
        this._scheduleChunk(item, jobId);
      } catch (err) {
        this._ackThenError(jobId, `Playback failed: ${err.message}`, true, gen);
        return;
      }
    }
  }

  /** Next decoded chunk, or the fetch lane's terminal result; parks the play
   * lane if neither is available yet. */
  _takeReady() {
    if (this._ready.length > 0) return Promise.resolve(this._ready.shift());
    if (this._laneResult !== null) return Promise.resolve(this._laneResult);
    return new Promise((resolve) => {
      this._readyWaiter = resolve;
    });
  }

  /** Wakes the parked play lane with the next ready item (if any is waiting). */
  _wakeReady() {
    if (!this._readyWaiter) return;
    const w = this._readyWaiter;
    this._readyWaiter = null;
    w(this._ready.length > 0 ? this._ready.shift() : this._laneResult);
  }

  /**
   * Schedules one decoded chunk at exactly the previous chunk's end time
   * (seamless), detects underruns, and acks at playback start so the host can
   * synthesize the next chunk while this one is sounding.
   * @param {{audioBuffer: AudioBuffer}} item
   * @param {string} jobId
   */
  _scheduleChunk(item, jobId) {
    const ctx = this._ensureCtx();
    const src = ctx.createBufferSource();
    src.buffer = item.audioBuffer;
    src.connect(this._gain);
    const now = ctx.currentTime;
    const startAt = Math.max(now, this._nextStartAt ?? 0);
    if (this._nextStartAt !== null && (startAt - this._nextStartAt) * 1000 > UNDERRUN_MS) {
      const gapMs = Math.round((startAt - this._nextStartAt) * 1000);
      this.underruns += 1;
      console.warn(`[O-Sound][TTS] UNDERRUN: ${gapMs}ms gap between chunks (chunk ${this._chunkSeq} scheduled late; decode/fetch caught up — audio continues)`);
    }
    this._nextStartAt = startAt + item.audioBuffer.duration;
    this._scheduledSrcs.push(src);
    src.onended = () => {
      const i = this._scheduledSrcs.indexOf(src);
      if (i !== -1) this._scheduledSrcs.splice(i, 1);
      if (this._scheduledSrcs.length === 0 && this._drainWaiter) {
        const w = this._drainWaiter;
        this._drainWaiter = null;
        w();
      }
    };
    src.start(startAt);
    // ACK at playback start: the host synthesizes and publishes the next chunk
    // while this one is still sounding (the fetch lane is already waiting).
    void api.postJson('/tts/chunk-done', { jobId }).catch(() => {});
    this._setState('playing');
    this._dlog(`chunk ${this._chunkSeq} scheduled at ${startAt.toFixed(2)}s (ack sent)`);
  }

  /** Resolves when every scheduled source has ended (or is stopped). */
  _drainScheduled() {
    if (this._scheduledSrcs.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this._drainWaiter = resolve;
    });
  }

  /** Pauses mid-chunk (local suspend) AND holds the host queue. */
  pause() {
    if (!this.jobId) return;
    this._audioCtx?.suspend().catch(() => {});
    api.postJson('/tts/control', { jobId: this.jobId, action: 'pause' }).catch(() => {});
    this._setState('paused');
  }

  resume() {
    if (!this.jobId) return;
    this._audioCtx?.resume().catch(() => {});
    api.postJson('/tts/control', { jobId: this.jobId, action: 'resume' }).catch(() => {});
    this._setState('playing');
  }

  /** Stops this player's job and any local audio. */
  stop() {
    const jobId = this.jobId;
    this.stopLocal();
    this.jobId = null;
    if (jobId) api.postJson('/tts/control', { jobId, action: 'stop' }).catch(() => {});
    this._closeCtx();
    this._setState('idle');
  }

  /** Aborts local playback only (job may continue server-side). */
  stopLocal() {
    this._aborted = true;
    this._gen += 1; // invalidate any running lanes
    if (this._fetchCtl) {
      this._fetchCtl.abort(); // cancel the in-flight chunk fetch
      this._fetchCtl = null;
    }
    if (this._scheduledSrcs.length > 0) {
      for (const src of this._scheduledSrcs) {
        src.onended = null;
        try {
          src.stop();
        } catch {
          /* not started yet */
        }
      }
      this._scheduledSrcs = [];
    }
    if (this._drainWaiter) {
      const w = this._drainWaiter;
      this._drainWaiter = null;
      w();
    }
    this._ready = []; // drop any decode-ahead lookahead
    if (this._readyWaiter) {
      const w = this._readyWaiter;
      this._readyWaiter = null;
      w('aborted'); // unblock the play lane so it observes _aborted and exits
    }
    this._nextStartAt = null;
  }

  /**
   * BUG-1 guard: if the host has a chunk published for this job and we are about
   * to die, ack it FIRST — otherwise the host's 60s ack watchdog would hold the
   * queue (and eventually abandon the job) for no reason. Then report the error.
   * @param {string} jobId
   * @param {string} message
   * @param {boolean} published
   * @param {number} gen
   */
  _ackThenError(jobId, message, published, gen) {
    if (published && jobId && gen === this._gen) void api.postJson('/tts/chunk-done', { jobId }).catch(() => {});
    if (gen === this._gen) {
      this.stopLocal();
      this._closeCtx();
      this._setState('error', message);
    }
  }

  _finish() {
    this.jobId = null;
    this._closeCtx();
    this._setState('idle');
  }
}
