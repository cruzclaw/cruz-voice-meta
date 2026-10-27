// Runs the real keyword spotter on speech made by Kokoro. Needs the wake word model
// (`npm run fetch-model -w @cruzclaw/wake-word`) and the Kokoro model, and takes about a minute,
// so it only runs when WAKE_LIVE=1 is set:
//   WAKE_LIVE=1 npx tsx --test packages/wake-word/test/sherpa.live.test.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createSherpaWakeDetector, type WakeDetector } from '../src/index.js';
import { LIVE_CLIPS } from './live-clips.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const modelDir = path.join(here, '..', 'models', 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01');
const live = process.env.WAKE_LIVE === '1' && existsSync(modelDir);
const FRAME = 1920; // 40 ms at 24 kHz, as the microphone delivers it

/** Streams the clip, then half a second of quiet, the way the microphone would. Returns every phrase heard. */
function hear(detector: WakeDetector, pcm: Uint8Array): string[] {
  detector.reset();
  const padded = new Uint8Array(pcm.byteLength + 24000); // 0.5 s of silence at 16-bit
  padded.set(pcm);
  const heard: string[] = [];
  for (let i = 0; i < padded.byteLength; i += FRAME) {
    const phrase = detector.feed(padded.subarray(i, Math.min(i + FRAME, padded.byteLength)));
    if (phrase) heard.push(phrase);
  }
  return heard;
}

describe('wake detector on real speech', { skip: !live && 'set WAKE_LIVE=1 and fetch the model to run' }, () => {
  let detector: WakeDetector;
  let dir: string;
  before(async () => {
    // Kokoro and sherpa-onnx each bring their own onnxruntime.dll, so the speech is made in another process.
    dir = mkdtempSync(path.join(os.tmpdir(), 'wake-clips-'));
    const made = spawnSync(process.execPath, ['--import', 'tsx', path.join(here, 'make-clips.ts'), dir], { stdio: 'inherit', cwd: path.join(here, '..', '..', '..') });
    assert.equal(made.status, 0, 'could not make the test speech');
    detector = await createSherpaWakeDetector({ modelDir });
  });
  after(() => {
    detector?.dispose();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  for (const clip of LIVE_CLIPS) {
    it(`${clip.expect === 'wake' ? 'wakes on' : 'stays quiet for'} "${clip.text}" (${clip.voice})`, () => {
      const heard = hear(detector, new Uint8Array(readFileSync(path.join(dir, `${clip.name}.pcm`))));
      if (clip.expect === 'wake') assert.ok(heard.some((h) => h.endsWith('CRUZ')), `not heard; got ${JSON.stringify(heard)}`);
      else assert.deepEqual(heard, [], `woke it: ${JSON.stringify(heard)}`);
    });
  }

  it('does not wake on silence or noise-like audio, and survives odd chunk sizes', () => {
    detector.reset();
    assert.equal(detector.feed(new Uint8Array(24000 * 2 * 3)), undefined);
    const noise = new Uint8Array(24000 * 2 * 2);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 7919) % 251;
    assert.equal(detector.feed(noise.subarray(1, 4001)), undefined, 'an odd offset and odd length are fine');
    assert.equal(detector.feed(new Uint8Array(0)), undefined);
    assert.equal(detector.feed(new Uint8Array(1)), undefined);
  });
});
