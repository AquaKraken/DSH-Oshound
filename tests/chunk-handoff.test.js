import { describe, expect, it } from 'vitest';
import { ChunkHandoff } from '../src/dsh/adapter.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('ChunkHandoff', () => {
  it('keeps waiting while the job is still generating (no chunk published yet), then delivers the chunk', async () => {
    // Regression: waitForChunk used to return {gone:true} the moment it saw
    // no published chunk, so a client polling during Piper's synthesis of the
    // FIRST chunk got 204 (job gone) and the host job hung forever waiting
    // for an ack that the client would never send.
    let jobAlive = true;
    const h = new ChunkHandoff((id) => jobAlive);

    const pending = h.waitForChunk('job-1', 3000);
    // While the job is alive but no chunk is published, it must NOT settle as "gone".
    const immediate = await Promise.race([
      h.waitForChunk('job-1', 200).then((r) => r),
      sleep(30).then(() => 'still-waiting'),
    ]);
    expect(immediate).toBe('still-waiting');

    await sleep(50);
    const ackPromise = h.publish('job-1', 'C:/temp/chunk.wav');
    const r = await pending;
    // toMatchObject (not toEqual): the entry also carries an internal watchdog timer field.
    expect(r).toMatchObject({ chunk: { jobId: 'job-1', wavPath: 'C:/temp/chunk.wav', acked: false, ack: expect.any(Function) } });

    h.ack('job-1');
    await ackPromise; // resolves after ack
  });

  it('resolves gone immediately for a job that no longer exists in the queue', async () => {
    const h = new ChunkHandoff(() => false);
    const r = await h.waitForChunk('job-gone', 100);
    expect(r).toEqual({ gone: true });
  });

  it('flips from waiting to gone when the job dies while a client is long-polling', async () => {
    let jobAlive = true;
    const h = new ChunkHandoff(() => jobAlive);
    const pending = h.waitForChunk('job-2', 3000);
    await sleep(50);
    jobAlive = false; // queue removed the job (finished/stopped)
    h.notify(); // wake waiters
    const r = await pending;
    expect(r).toEqual({ gone: true });
  });

  it('releases a published chunk on abort (stop) without a client ack', async () => {
    const h = new ChunkHandoff(() => true);
    const ackPromise = h.publish('job-3', 'C:/temp/c3.wav');
    await sleep(20);
    h.release('job-3');
    await ackPromise; // must resolve even though the client never acked
    expect(h.current).toBeNull();
  });

  it('auto-releases a published chunk when the client never acks (watchdog: a vanished ' +
    'client must not wedge the queue) — regression: with no stop call, publish() awaited the ' +
    'client ack forever, so a closed tab mid-speech left the job "playing" and every later TTS ' +
    'request queued behind it until a DSH restart (observed live 2026-09-16)', async () => {
    const h = new ChunkHandoff(() => true, 200); // 200ms watchdog for the test
    const ackPromise = h.publish('job-4', 'C:/temp/c4.wav');
    let resolved = false;
    ackPromise.then(() => {
      resolved = true;
    });
    await sleep(50);
    expect(resolved).toBe(false); // before the deadline: still waiting for the client
    await sleep(300); // past the 200ms watchdog
    expect(resolved).toBe(true); // watchdog released the chunk
    expect(h.current).toBeNull();
    // The handoff is usable again: the queue can move on to the next job.
    const next = h.publish('job-5', 'C:/temp/c5.wav');
    h.ack('job-5');
    await next;
  });

  // --- onAbandon (2026-09-21): the watchdog must REPORT the abandonment to the owner
  // (queue.abandon -> error state + visible message + abort + TTL removal), not just
  // silently release the chunk.

  it('watchdog fires onAbandon(jobId) exactly once, before releasing the chunk', async () => {
    const calls = [];
    const h = new ChunkHandoff(() => true, 150, (jobId) => calls.push(jobId));
    const ackPromise = h.publish('job-a', 'C:/temp/xa.wav');
    await sleep(300); // past the 150ms watchdog
    expect(calls).toEqual(['job-a']); // fired, with the right jobId, exactly once
    await ackPromise; // still released on the watchdog
    expect(h.current).toBeNull();
  });

  it('onAbandon is NOT called when the client acks in time', async () => {
    const calls = [];
    const h = new ChunkHandoff(() => true, 500, (jobId) => calls.push(jobId));
    const ackPromise = h.publish('job-b', 'C:/temp/xb.wav');
    h.ack('job-b'); // timely ack
    await ackPromise;
    await sleep(600); // well past the watchdog window
    expect(calls).toEqual([]);
  });

  // --- exactly-once delivery (2026-09-23 TTS duplication root cause) -------
  // The client PREFETCHES: its long-poll for chunk N+1 is issued while chunk N
  // is still playing, i.e. BEFORE chunk N's ack (sent at playback start) is
  // processed by the host. If a still-published chunk can be served to that
  // second poll, the client plays chunk N twice: "sentence 1 -> sentence 1
  // again -> sentence 2" (user-confirmed: happens every time).

  it('a published chunk is delivered to at most ONE long-poll: the concurrent prefetch keeps waiting (no duplicate chunk)', async () => {
    const h = new ChunkHandoff(() => true);
    const ackPromise = h.publish('job-dup', 'C:/temp/dup.wav');

    // Main poll: gets the chunk (marks it delivered).
    const first = await h.waitForChunk('job-dup', 1000);
    expect(first).toMatchObject({ chunk: { wavPath: 'C:/temp/dup.wav', acked: false } });

    // Prefetch poll, issued while the chunk is still published+unacked
    // (exactly the client's real timing: ack has NOT been processed yet).
    // It must NOT receive the same chunk — it must keep waiting.
    const prefetch = h.waitForChunk('job-dup', 3000);
    const immediate = await Promise.race([prefetch.then((r) => r), sleep(60).then(() => 'still-waiting')]);
    expect(immediate).toBe('still-waiting'); // no re-delivery of the same chunk

    // Now the client acks (playback started); the host publishes chunk 2.
    h.ack('job-dup');
    await ackPromise;
    const nextAck = h.publish('job-dup', 'C:/temp/dup2.wav');

    // The waiting prefetch now receives the NEXT chunk — exactly once.
    const second = await prefetch;
    expect(second).toMatchObject({ chunk: { wavPath: 'C:/temp/dup2.wav', acked: false } });
    h.ack('job-dup');
    await nextAck;
  });

  it('a third late poll after delivery+ack also never re-receives the old chunk', async () => {
    const h = new ChunkHandoff(() => true);
    const ackPromise = h.publish('job-late', 'C:/temp/late.wav');
    const first = await h.waitForChunk('job-late', 1000); // delivered
    expect(first).toMatchObject({ chunk: { wavPath: 'C:/temp/late.wav' } });

    h.ack('job-late'); // released; job still alive (hasJob=true)
    await ackPromise;

    // A very late poll (e.g. a retry after a network hiccup) must wait for a
    // FUTURE chunk, not replay the old one. No new chunk is published, so it
    // ends as a timeout, and the chunk is never handed out twice.
    const late = await h.waitForChunk('job-late', 150);
    expect(late).toEqual({ timeout: true });
  });
});

// --- 2026-10-05: bounded, sequence-based handoff ---------------------------------
// The single-slot version was rewritten to a per-job bounded FIFO so a faster
// synthesizer (e.g. a persistent Piper worker) can publish ahead without
// unbounded memory/files, and stop/abandon can settle every pending publish.

describe('ChunkHandoff (2026-10-05: bounded, sequence-based)', () => {
  it('serves queued chunks strictly in publish order with increasing seq', async () => {
    const h = new ChunkHandoff(() => true, 60_000, null, 3);
    const p1 = h.publish('job-s', 'C:/temp/s1.wav');
    const p2 = h.publish('job-s', 'C:/temp/s2.wav');
    const p3 = h.publish('job-s', 'C:/temp/s3.wav');
    const r1 = await h.waitForChunk('job-s', 500);
    expect(r1).toMatchObject({ chunk: { seq: 0, wavPath: 'C:/temp/s1.wav' } });
    const r2 = await h.waitForChunk('job-s', 500);
    expect(r2).toMatchObject({ chunk: { seq: 1, wavPath: 'C:/temp/s2.wav' } });
    const r3 = await h.waitForChunk('job-s', 500);
    expect(r3).toMatchObject({ chunk: { seq: 2, wavPath: 'C:/temp/s3.wav' } });
    h.ack('job-s');
    await p1;
    h.ack('job-s');
    await p2;
    h.ack('job-s');
    await p3;
  });

  it('applies backpressure: no chunk is queued beyond maxAhead until a slot frees', async () => {
    const h = new ChunkHandoff(() => true, 60_000, null, 1);
    const p1 = h.publish('job-b', 'C:/temp/b1.wav');
    const p2 = h.publish('job-b', 'C:/temp/b2.wav'); // blocks: queue full (1 unacked)
    await sleep(30);
    // b2 must NOT be queued yet — the poll only ever sees b1 first.
    const r1 = await h.waitForChunk('job-b', 500);
    expect(r1).toMatchObject({ chunk: { seq: 0, wavPath: 'C:/temp/b1.wav' } });
    h.ack('job-b'); // frees a slot → b2 is queued now
    await p1;
    await sleep(20);
    const r2 = await h.waitForChunk('job-b', 500);
    expect(r2).toMatchObject({ chunk: { seq: 1, wavPath: 'C:/temp/b2.wav' } });
    h.ack('job-b');
    await p2;
  });

  it('ack settles chunks in order (oldest first), even when the client has prefetched ahead', async () => {
    const h = new ChunkHandoff(() => true, 60_000, null, 2);
    const p1 = h.publish('job-io', 'C:/temp/i1.wav');
    const p2 = h.publish('job-io', 'C:/temp/i2.wav');
    const r1 = await h.waitForChunk('job-io', 500); // i1 delivered (playing)
    expect(r1).toMatchObject({ chunk: { wavPath: 'C:/temp/i1.wav' } });
    const r2 = await h.waitForChunk('job-io', 500); // i2 delivered (prefetch / decode-ahead)
    expect(r2).toMatchObject({ chunk: { wavPath: 'C:/temp/i2.wav' } });
    h.ack('job-io'); // ack for the oldest — i2 must stay pending
    await p1;
    expect(h.current).toMatchObject({ wavPath: 'C:/temp/i2.wav' });
    h.ack('job-io');
    await p2;
    expect(h.current).toBeNull();
  });

  it('abort(jobId) settles every pending publish at once (stop/abandon/teardown path)', async () => {
    const h = new ChunkHandoff(() => true, 60_000, null, 3);
    const p1 = h.publish('job-ab', 'C:/temp/a1.wav');
    const p2 = h.publish('job-ab', 'C:/temp/a2.wav');
    const p3 = h.publish('job-ab', 'C:/temp/a3.wav');
    await sleep(10);
    h.abort('job-ab');
    await Promise.all([p1, p2, p3]); // every publish resolved, no client ack needed
    expect(h.current).toBeNull();
  });

  it('abort wakes a parked long-poll immediately with gone (no waiting out the timeout)', async () => {
    let jobAlive = true;
    const h = new ChunkHandoff((id) => jobAlive, 60_000, null, 2);
    const pending = h.waitForChunk('job-w', 5000);
    await sleep(20);
    jobAlive = false; // queue removed the job (stop)
    h.abort('job-w'); // the stop route does exactly this
    const t0 = Date.now();
    const r = await pending;
    expect(r).toEqual({ gone: true });
    expect(Date.now() - t0).toBeLessThan(500); // immediate, not the 5s timeout
  });

  it('two jobs can hold chunks at once (no shared slot): each gets only its own chunks', async () => {
    const h = new ChunkHandoff(() => true, 60_000, null, 2);
    const pA = h.publish('job-X', 'C:/temp/x.wav');
    const pB = h.publish('job-Y', 'C:/temp/y.wav'); // old single-slot code clobbered X here
    const rX = await h.waitForChunk('job-X', 500);
    expect(rX).toMatchObject({ chunk: { jobId: 'job-X', wavPath: 'C:/temp/x.wav' } });
    const rY = await h.waitForChunk('job-Y', 500);
    expect(rY).toMatchObject({ chunk: { jobId: 'job-Y', wavPath: 'C:/temp/y.wav' } });
    h.ack('job-X');
    await pA; // X settles on X's ack only
    h.ack('job-Y');
    await pB;
  });
});
