import { describe, expect, it } from 'vitest';
import { TtsQueue } from '../src/tts/queue.js';

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('TtsQueue', () => {
  it('reaches the "playing" state once the handler calls markPlaying (regression: used to stay stuck on generating)', async () => {
    const seen = [];
    const queue = new TtsQueue(async (_job, control) => {
      await delay(10); // "synthesis"
      control.markPlaying();
      await delay(10); // "playback"
    });
    queue.onChange((jobs) => jobs.forEach((j) => seen.push(j.state)));

    queue.enqueue('hello');
    await delay(50);

    expect(new Set(seen)).toContain('playing');
    expect(seen).toContain('generating');
  });

  it('pause() actually blocks progress via waitIfPaused, and resume() releases it (regression: used to be a decorative label)', async () => {
    let resumedAt = 0;
    const queue = new TtsQueue(async (_job, control) => {
      control.markPlaying();
      await delay(10); // "unit 1" is playing — this is when pause() below gets called
      await control.waitIfPaused(); // checked between units, per the SpeakHandler contract
      resumedAt = Date.now();
    });

    const id = queue.enqueue('hello');
    await delay(3); // still inside the 10ms "unit 1" window — job must still be in the queue
    queue.pause(id);
    const pausedAt = Date.now();
    expect(queue.list().find((j) => j.id === id)?.state).toBe('paused');

    await delay(30); // handler has long since hit waitIfPaused() and is blocked on the gate
    expect(resumedAt).toBe(0);

    queue.resume(id);
    await delay(10);
    expect(resumedAt).toBeGreaterThanOrEqual(pausedAt);
  });

  it('stop() releases any pending pause gate so the handler can exit instead of hanging forever', async () => {
    let finished = false;
    const queue = new TtsQueue(async (_job, control) => {
      control.markPlaying();
      await delay(10); // give the test time to pause() before we reach the gate
      await control.waitIfPaused();
      if (control.signal.aborted) return;
      finished = true;
    });

    const id = queue.enqueue('hello');
    await delay(3);
    queue.pause(id);
    queue.stop(id);
    await delay(20);

    expect(finished).toBe(false);
    expect(queue.list()).toHaveLength(0);
  });

  it('keeps a failed job at state "error" WITH its message (readable by the client) until the ' +
    'TTL expires, instead of removing it immediately (regression: a missing Piper runtime failed ' +
    'silently — the job vanished before the client could poll, and the client only ever saw a ' +
    '"job gone" 204 with no useful error)', async () => {
    const queue = new TtsQueue(
      async () => {
        throw new Error('Piper runtime is not installed (missing: piper.exe).');
      },
      300, // short TTL for the test; default is 60_000
    );

    const id = queue.enqueue('hello');
    await delay(30); // drain() has run the (failing) handler

    // The failed job must still be visible, in error state, with the message preserved.
    const job = queue.list().find((j) => j.id === id);
    expect(job?.state).toBe('error');
    expect(job?.error).toBe('Piper runtime is not installed (missing: piper.exe).');

    // ...and it is gone once the TTL has elapsed.
    await delay(350);
    expect(queue.list().find((j) => j.id === id)).toBeUndefined();
  });

  it('a failed job does not block the queue: the next idle job still runs and is removed on success', async () => {
    let calls = 0;
    const queue = new TtsQueue(
      async (job, control) => {
        calls += 1;
        if (calls === 1) throw new Error('boom');
        control.markPlaying(); // second job behaves like a normal successful one
      },
      60_000,
    );

    const id1 = queue.enqueue('first (fails)');
    await delay(20); // first job has failed and been preserved
    const id2 = queue.enqueue('second (succeeds)');
    await delay(30);

    expect(queue.list().find((j) => j.id === id1)?.state).toBe('error'); // preserved
    expect(queue.list().find((j) => j.id === id2)).toBeUndefined(); // success path unchanged: removed on finish
  });

  // --- abandon() (chunk-ack watchdog, 2026-09-21) ---------------------------------
  // The host's ChunkHandoff watchdog calls abandon(jobId, message) when the client
  // stops confirming chunks (tab closed, crash, network drop). The job must become
  // a VISIBLE error (readable via GET /tts/chunk + /status), its controller must be
  // aborted so the speak handler exits, the queue must move on, and the job must be
  // TTL-removed.

  it('abandon() marks the job error WITH the message, aborts its controller, and the queue moves on', async () => {
    let aborted = false;
    let secondRan = false;
    const queue = new TtsQueue(
      async (job, control) => {
        control.markPlaying();
        if (job.text === 'first') {
          // Wait out the abort: the handler must exit promptly once abandon() fires.
          await new Promise((resolve) => {
            const onAbort = () => resolve();
            control.signal.addEventListener('abort', onAbort, { once: true });
          });
          aborted = control.signal.aborted;
          return;
        }
        secondRan = true;
      },
      300,
    );

    const id1 = queue.enqueue('first');
    await delay(20);
    queue.abandon(id1, 'Playback abandoned: the client did not confirm the chunk within 60s (tab closed or connection lost).');

    const job = queue.list().find((j) => j.id === id1);
    expect(job?.state).toBe('error');
    expect(job?.error).toBe('Playback abandoned: the client did not confirm the chunk within 60s (tab closed or connection lost).');

    await delay(30);
    expect(aborted).toBe(true); // the speak handler's signal was aborted
    const id2 = queue.enqueue('second');
    await delay(30);
    expect(secondRan).toBe(true); // the queue is free for the next job
    expect(queue.list().find((j) => j.id === id2)).toBeUndefined();
  });

  it('abandon() removes the job after the TTL expires', async () => {
    const queue = new TtsQueue(
      async (_job, control) => {
        // Stay in the queue until the signal aborts, so the job is still alive when abandon() runs.
        await new Promise((resolve) => {
          const onAbort = () => resolve();
          control.signal.addEventListener('abort', onAbort, { once: true });
        });
      },
      200,
    );
    const id = queue.enqueue('hello');
    await delay(10);
    queue.abandon(id, 'gone');
    expect(queue.list().find((j) => j.id === id)?.state).toBe('error');
    await delay(260);
    expect(queue.list().find((j) => j.id === id)).toBeUndefined();
  });

  it('abandon() of an unknown job id is a safe no-op', () => {
    const queue = new TtsQueue(async () => {}, 60_000);
    expect(() => queue.abandon('no-such-job', 'gone')).not.toThrow();
    expect(queue.list()).toHaveLength(0);
  });

  it('a late handler rejection after abandon() does NOT clobber the abandon message', async () => {
    // The watchdog abandons the job while the handler is still unwinding (its
    // in-flight Piper synth rejects with "aborted" after the abort). The client
    // must keep seeing the ABANDON reason, not the internal abort error.
    const queue = new TtsQueue(
      async (_job, control) => {
        await new Promise((resolve) => {
          const onAbort = () => resolve();
          control.signal.addEventListener('abort', onAbort, { once: true });
        });
        throw new Error('Piper synthesis aborted');
      },
      300,
    );
    const id = queue.enqueue('hello');
    await delay(10);
    queue.abandon(id, 'Playback abandoned (client gone).');
    await delay(30);

    const job = queue.list().find((j) => j.id === id);
    expect(job?.state).toBe('error');
    expect(job?.error).toBe('Playback abandoned (client gone).');
  });
});
