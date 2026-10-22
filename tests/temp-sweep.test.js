import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sweepStaleTempFiles } from '../src/host/temp-sweep.js';

const NOW = 1_700_000_000_000; // fixed clock for determinism

describe('sweepStaleTempFiles', () => {
  let dir;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'osound-sweep-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('deletes top-level files older than the threshold and keeps fresh ones', async () => {
    const oldFile = path.join(dir, 'tts-old.wav');
    const freshFile = path.join(dir, 'stt-fresh.wav');
    await writeFile(oldFile, 'old');
    await writeFile(freshFile, 'fresh');
    // Age only the old file 10 minutes into the past.
    const t = new Date(NOW - 10 * 60 * 1000);
    await stat(oldFile); // ensure it exists
    const { utimes } = await import('node:fs/promises');
    await utimes(oldFile, t, t);

    const r = await sweepStaleTempFiles(dir, 5 * 60 * 1000, NOW);
    expect(r.deleted).toBe(1);
    expect(r.failed).toBe(0);
    await expect(stat(oldFile)).rejects.toThrow();
    await expect(stat(freshFile)).resolves.toBeTruthy();
  });

  it('a missing directory is a no-op {deleted:0, failed:0}, never a throw', async () => {
    const r = await sweepStaleTempFiles(path.join(dir, 'does-not-exist'), 60_000, NOW);
    expect(r).toEqual({ deleted: 0, failed: 0 });
  });

  it('subdirectories are kept (the sweep never deletes trees)', async () => {
    const sub = path.join(dir, 'subdir');
    await mkdir(sub, { recursive: true });
    const t = new Date(NOW - 60 * 60 * 1000);
    const { utimes } = await import('node:fs/promises');
    await utimes(sub, t, t);

    const r = await sweepStaleTempFiles(dir, 5 * 60 * 1000, NOW);
    expect(r.deleted).toBe(0);
    await expect(stat(sub)).resolves.toBeTruthy();
  });

  it('files exactly at the threshold age are kept (strictly-older semantics)', async () => {
    const f = path.join(dir, 'edge.wav');
    await writeFile(f, 'x');
    const { utimes } = await import('node:fs/promises');
    await utimes(f, new Date(NOW - 5 * 60 * 1000), new Date(NOW - 5 * 60 * 1000)); // exactly 5 min old

    const r = await sweepStaleTempFiles(dir, 5 * 60 * 1000, NOW);
    expect(r.deleted).toBe(0);
    await expect(stat(f)).resolves.toBeTruthy();
  });
});
