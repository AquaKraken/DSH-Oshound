// src/tts/queue.js
// A small, dependency-free job queue for TTS playback. One job "speaking"
// at a time; the rest wait. Every job is cancellable individually, and the
// whole queue can be cleared. Per spec §36/§84.
//
// IMPORTANT — the SpeakHandler contract:
// A handler MUST call `control.markPlaying()` once synthesis has finished
// and actual audio playback begins, and SHOULD call `await
// control.waitIfPaused()` between playable units (e.g. between TTS text
// chunks) so pause() has something real to hold. Earlier versions of this
// file left a job's state at 'generating' for its entire lifetime — it
// never actually reached 'playing', so the UI's 🔉 "Speaking" indicator
// never lit up, and pause()/resume() only relabeled a job without
// affecting playback at all. See src/host/voice-service.js for the
// handler that fulfills this contract.

/**
 * @typedef {(jobs: readonly import('../shared/types.js').TtsQueueJob[]) => void} QueueListener
 *
 * @typedef {Object} SpeakControl
 * @property {AbortSignal} signal
 * @property {() => void} markPlaying - Call once actual audio playback starts (after synthesis of the first unit completes).
 * @property {() => Promise<void>} waitIfPaused - Resolves immediately unless the job is currently paused, in which case it resolves on resume()/stop().
 *
 * @typedef {(job: import('../shared/types.js').TtsQueueJob, control: SpeakControl) => Promise<void>} SpeakHandler
 */

export class TtsQueue {
  jobs = [];
  controllers = new Map();
  pauseGates = new Map();
  listeners = new Set();
  draining = false;

  /**
   * @param {SpeakHandler} speak
   * @param {number} [errorTtlMs] - How long a FAILED job is preserved at
   * `state: 'error'` (with its `error` message) before removal, so a client
   * polling GET /tts/chunk can still read the failure instead of seeing a
   * silent "job gone". ~60s covers the worst-case healthy client round-trip;
   * injectable for tests.
   */
  constructor(speak, errorTtlMs = 60_000) {
    this.speak = speak;
    this.errorTtlMs = errorTtlMs;
  }

  /** @param {QueueListener} listener @returns {() => void} */
  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify() {
    for (const l of this.listeners) l([...this.jobs]);
  }

  /** @param {string} text @returns {string} */
  enqueue(text) {
    const id = `tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.jobs.push({ id, text, createdAt: Date.now(), state: 'idle' });
    this.notify();
    void this.drain();
    return id;
  }

  /** @param {string} id @param {import('../shared/types.js').SpeakerState} state */
  setState(id, state) {
    const job = this.jobs.find((j) => j.id === id);
    if (job) {
      job.state = state;
      this.notify();
    }
  }

  /** @param {string} id @param {AbortSignal} signal @returns {SpeakControl} */
  makeControl(id, signal) {
    return {
      signal,
      markPlaying: () => {
        // Don't clobber a state the user has explicitly paused since synthesis started.
        const job = this.jobs.find((j) => j.id === id);
        if (job && job.state !== 'paused') this.setState(id, 'playing');
      },
      waitIfPaused: async () => {
        const gate = this.pauseGates.get(id);
        if (gate) await gate.promise;
      },
    };
  }

  async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (true) {
        const next = this.jobs.find((j) => j.state === 'idle');
        if (!next) break;
        const controller = new AbortController();
        this.controllers.set(next.id, controller);
        this.setState(next.id, 'generating');
        try {
          await this.speak(next, this.makeControl(next.id, controller.signal));
          this.remove(next.id); // finished normally
        } catch (err) {
          // Preserve the failure instead of removing the job immediately: the
          // job stays at state 'error' with its message (readable via GET
          // /tts/chunk and /status) until the TTL removes it. Removing it
          // right away made failures invisible — a missing Piper runtime left
          // the client with only a silent "job gone" 204 (2026-09-19).
          const job = this.jobs.find((j) => j.id === next.id);
          if (job && job.state !== 'error') {
            job.state = 'error';
            job.error = err instanceof Error ? err.message : String(err);
            this._scheduleErrorRemoval(next.id);
          }
          // If the job is ALREADY at 'error' (abandon() ran while the handler was still
          // unwinding after its abort), keep its existing message and TTL — the late
          // rejection (e.g. "Piper synthesis aborted") must not clobber the abandon reason.
          this.notify();
        } finally {
          this.controllers.delete(next.id);
          this.pauseGates.delete(next.id);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /** Pauses a job between playable units. Takes effect the next time the handler calls waitIfPaused().
   * @param {string} id */
  pause(id) {
    if (this.pauseGates.has(id)) return; // already paused
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    this.pauseGates.set(id, { promise, resolve });
    this.setState(id, 'paused');
  }

  /** @param {string} id */
  resume(id) {
    const gate = this.pauseGates.get(id);
    if (gate) {
      gate.resolve();
      this.pauseGates.delete(id);
    }
    this.setState(id, 'playing');
  }

  /** @param {string} id */
  stop(id) {
    this.resume(id); // release any pause gate so an awaiting handler can observe the abort and exit
    this.controllers.get(id)?.abort();
    this.remove(id);
  }

  stopAll() {
    for (const id of [...this.pauseGates.keys()]) this.resume(id);
    for (const c of this.controllers.values()) c.abort();
    this.jobs = [];
    this.notify();
  }

  /**
   * Marks a job as ABANDONED — the client stopped confirming playback
   * (tab closed, browser crash, network drop mid-chunk). Unlike a normal
   * error (synthesis failed) or stop() (user intent), abandonment is detected
   * by the host's chunk-ack watchdog: the job is preserved at state 'error'
   * with a message (readable via GET /tts/chunk and /status), any pause gate
   * is released, the job's controller is aborted so the speak handler exits,
   * and the job is removed after the TTL. The queue is free for the next job.
   * @param {string} id
   * @param {string} message
   */
  abandon(id, message) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) return;
    const gate = this.pauseGates.get(id);
    if (gate) {
      gate.resolve();
      this.pauseGates.delete(id);
    }
    job.state = 'error';
    job.error = message;
    this.controllers.get(id)?.abort();
    this.notify();
    this._scheduleErrorRemoval(id);
  }

  /** @param {string} id */
  remove(id) {
    this.jobs = this.jobs.filter((j) => j.id !== id);
    this.notify();
  }

  /**
   * Keeps a failed job readable by the client for errorTtlMs, then removes it.
   * The timer is unref'd so pending cleanup can never keep the host process
   * alive on its own. A later stop()/remove() of the same id is harmless —
   * this becomes a no-op when the job is already gone.
   * @param {string} id
   */
  _scheduleErrorRemoval(id) {
    const timer = setTimeout(() => this.remove(id), this.errorTtlMs);
    timer.unref?.();
  }

  currentlySpeaking() {
    return this.jobs.find((j) => j.state === 'generating' || j.state === 'playing' || j.state === 'paused');
  }

  list() {
    return [...this.jobs];
  }
}
