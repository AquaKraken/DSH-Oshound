import { describe, expect, it } from 'vitest';
import { runPiper, PiperInvocationError } from '../src/tts/piper.js';

const FAKE = {
  exePath: 'C:/definitely/not/real/piper.exe',
  modelPath: 'C:/definitely/not/real/model.onnx',
  configPath: 'C:/definitely/not/real/model.onnx.json',
  text: 'hello',
  outputWavPath: 'C:/definitely/not/real/out.wav',
};

describe('runPiper abort signal', () => {
  it('a PRE-ABORTED signal rejects immediately WITHOUT touching disk or spawning', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runPiper({ ...FAKE, signal: controller.signal }),
    ).rejects.toThrow(PiperInvocationError);
    await expect(
      runPiper({ ...FAKE, signal: controller.signal }),
    ).rejects.toThrow('Piper synthesis aborted');
    // The rejection came from the abort check, not from the (fake) missing files:
    // if the code had fallen through to assertExists(), the message would name a path.
  });

  it('without a signal, the normal validation path still runs (missing exe is reported as such)', async () => {
    await expect(runPiper(FAKE)).rejects.toThrow('Piper executable not found');
  });
});
