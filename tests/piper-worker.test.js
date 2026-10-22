import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PiperWorker, PiperWorkerDeadError, PiperWorkerError } from '../src/tts/piper-worker.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A fake piper child process: EventEmitter-based with the stdio surface the
 * worker uses (stdout/stderr 'data', stdin write/'error', 'exit', kill).
 */
function makeFakeChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.kill = vi.fn();
  child.stdin = new EventEmitter();
  child.stdin.write = vi.fn(() => true);
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

function makeWorker(child, overrides = {}) {
  return new PiperWorker({
    exePath: 'C:/x/piper.exe',
    modelPath: 'C:/x/voice.onnx',
    configPath: 'C:/x/voice.onnx.json',
    lengthScale: 1.0,
    noiseScale: 0.667,
    noiseWScale: 0.8,
    _spawn: vi.fn(() => child),
    ...overrides,
  });
}

let tempDir;
beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'osound-pw-test-'));
});
afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('PiperWorker', () => {
  it('start() spawns --json-input with the bound scales', async () => {
    const child = makeFakeChild();
    const w = makeWorker(child, { lengthScale: 1.2, noiseScale: 0.5, noiseWScale: 0.7 });
    const p = w.start();
    expect(w._spawn).toHaveBeenCalledWith(
      'C:/x/piper.exe',
      expect.arrayContaining(['--json-input', '--length_scale', '1.2', '--noise_scale', '0.5', '--noise_w', '0.7']),
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
    );
    child.stderr.emit('data', Buffer.from('Initialized piper\n'));
    await p;
  });

  it('start() resolves when "Initialized piper" appears on stderr', async () => {
    const child = makeFakeChild();
    const w = makeWorker(child);
    const p = w.start();
    child.stderr.emit('data', Buffer.from('[piper] [info] Initialized piper voice\n'));
    await p;
    expect(w.isAlive).toBe(true);
  });

  it('start() rejects with PiperWorkerError (and kills) when the marker never arrives', async () => {
    const child = makeFakeChild();
    const w = makeWorker(child, { initTimeoutMs: 80 });
    await expect(w.start()).rejects.toThrow(PiperWorkerError);
    expect(child.kill).toHaveBeenCalled();
    expect(w.isAlive).toBe(false);
  });

  it('start() rejects with PiperWorkerDeadError when the process exits before ready', async () => {
    const child = makeFakeChild();
    const w = makeWorker(child, { initTimeoutMs: 5000 });
    const p = w.start();
    child.emit('exit', 2);
    await expect(p).rejects.toThrow(PiperWorkerDeadError);
    expect(w.isAlive).toBe(false);
  });

  it('synthesize() writes the JSON job line and resolves with the wavPath on its path echo', async () => {
    const child = makeFakeChild();
    const w = makeWorker(child);
    const p = w.start();
    child.stderr.emit('data', Buffer.from('Initialized piper\n'));
    await p;

    const wavPath = path.join(tempDir, 'out.wav');
    await writeFile(wavPath, 'RIFFfake'); // the file is "written by piper"
    const sp = w.synthesize('Hello world.', wavPath);

    // The job line is exactly one JSON object with text + output_file.
    expect(child.stdin.write).toHaveBeenCalledTimes(1);
    const line = child.stdin.write.mock.calls[0][0];
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toEqual({ text: 'Hello world.', output_file: wavPath });

    child.stdout.emit('data', Buffer.from(wavPath + '\n'));
    await expect(sp).resolves.toBe(wavPath);
    expect(w.pending.size).toBe(0);
  });

  it('synthesize() rejects when the worker is not running', async () => {
    const w = makeWorker(makeFakeChild());
    await expect(w.synthesize('x', 'C:/x/out.wav')).rejects.toThrow(PiperWorkerDeadError);
  });

  it('enforces the bounded queue: a second job while one is in flight rejects (maxQueue=1)', async () => {
    const child = makeFakeChild();
    const w = makeWorker(child, { maxQueue: 1 });
    const p = w.start();
    child.stderr.emit('data', Buffer.from('Initialized piper\n'));
    await p;

    w.synthesize('a', path.join(tempDir, 'a.wav')); // in flight, no echo yet
    await expect(w.synthesize('b', path.join(tempDir, 'b.wav'))).rejects.toThrow(/queue full/);
    expect(w.pending.size).toBe(1);
  });

  it('an unexpected process exit rejects every pending job as dead', async () => {
    const child = makeFakeChild();
    const w = makeWorker(child);
    const p = w.start();
    child.stderr.emit('data', Buffer.from('Initialized piper\n'));
    await p;

    const sp = w.synthesize('a', path.join(tempDir, 'a.wav'));
    child.emit('exit', 3);
    await expect(sp).rejects.toThrow(PiperWorkerDeadError);
    expect(w.isAlive).toBe(false);
    expect(child.kill).toHaveBeenCalled();
  });

  it('stop() rejects pending jobs and kills the process (idempotent)', async () => {
    const child = makeFakeChild();
    const w = makeWorker(child);
    const p = w.start();
    child.stderr.emit('data', Buffer.from('Initialized piper\n'));
    await p;

    const sp = w.synthesize('a', path.join(tempDir, 'a.wav'));
    w.stop();
    w.stop(); // idempotent
    await expect(sp).rejects.toThrow(PiperWorkerDeadError);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(w.isAlive).toBe(false);
  });

  it('a job AbortSignal abort: rejects "aborted", clears the entry, deletes the orphan WAV, and a late echo is ignored', async () => {
    const child = makeFakeChild();
    const w = makeWorker(child);
    const p = w.start();
    child.stderr.emit('data', Buffer.from('Initialized piper\n'));
    await p;

    const wavPath = path.join(tempDir, 'abort.wav');
    await writeFile(wavPath, 'RIFForphan');
    const controller = new AbortController();
    const sp = w.synthesize('a', wavPath, { signal: controller.signal });
    controller.abort();
    await expect(sp).rejects.toThrow('aborted');
    expect(w.pending.size).toBe(0);

    // The orphan is deleted best-effort...
    await sleep(20);
    await expect(stat(wavPath)).rejects.toThrow();
    // ...and a late path echo (piper finished anyway) is unmatched: no crash, nothing pending.
    child.stdout.emit('data', Buffer.from(wavPath + '\n'));
    await sleep(10);
    expect(w.pending.size).toBe(0);
  });

  it('a wedged job (no path echo in time) kills the worker and rejects it as dead', async () => {
    const child = makeFakeChild();
    const w = makeWorker(child, { jobTimeoutMs: 120 });
    const p = w.start();
    child.stderr.emit('data', Buffer.from('Initialized piper\n'));
    await p;

    await expect(w.synthesize('a', path.join(tempDir, 'a.wav'))).rejects.toThrow(PiperWorkerDeadError);
    expect(child.kill).toHaveBeenCalled();
    expect(w.isAlive).toBe(false);
  });

  it('a path echo with no file on disk rejects (defensive check)', async () => {
    const child = makeFakeChild();
    const w = makeWorker(child);
    const p = w.start();
    child.stderr.emit('data', Buffer.from('Initialized piper\n'));
    await p;

    const wavPath = path.join(tempDir, 'missing.wav'); // never created
    const sp = w.synthesize('a', wavPath);
    child.stdout.emit('data', Buffer.from(wavPath + '\n'));
    await expect(sp).rejects.toThrow(/does not exist/);
  });
});
