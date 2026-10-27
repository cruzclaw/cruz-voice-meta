import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { KokoroSynthesizer, floatToPcm16, resample, splitForSpeech, type SpeechEngine } from '../src/index.js';

const f24 = { encoding: 'pcm_s16le', sampleRate: 24000, channels: 1 } as const;
const collect = async (it: AsyncIterable<Uint8Array>) => {
  const out: Uint8Array[] = [];
  for await (const c of it) out.push(c);
  return out;
};
const clip = (ms: number, rate = 24000, value = 0.5) => ({ samples: new Float32Array((rate * ms) / 1000).fill(value), sampleRate: rate });

describe('splitForSpeech', () => {
  it('splits into sentences, drops fragments with no letters, and keeps order', () => {
    assert.deepEqual(splitForSpeech('I drafted an email.  Shall I send it? Yes! ... '), ['I drafted an email.', 'Shall I send it?', 'Yes!']);
    assert.deepEqual(splitForSpeech(''), []);
    assert.deepEqual(splitForSpeech('   '), []);
  });

  it('breaks an overlong sentence into short pieces without losing words', () => {
    const long = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ') + '.';
    const pieces = splitForSpeech(long);
    assert.ok(pieces.length > 2);
    assert.ok(pieces.every((p) => p.length <= 240));
    assert.equal(pieces.join(' '), long);
  });
});

describe('floatToPcm16', () => {
  it('converts, clamps and keeps little-endian order', () => {
    const pcm = floatToPcm16(new Float32Array([0, 1, -1, 2, -2, 0.5]));
    const v = new DataView(pcm.buffer);
    assert.deepEqual([0, 1, 2, 3, 4, 5].map((i) => v.getInt16(i * 2, true)), [0, 32767, -32768, 32767, -32768, 16384]);
  });
});

describe('resample', () => {
  it('returns the same samples at the same rate and scales the length otherwise', () => {
    const a = new Float32Array(2400).fill(0.25);
    assert.equal(resample(a, 24000, 24000), a);
    assert.equal(resample(a, 24000, 16000).length, 1600);
    assert.equal(resample(a, 24000, 48000).length, 4800);
    assert.ok(resample(a, 24000, 16000).every((x) => Math.abs(x - 0.25) < 1e-6));
  });
});

describe('KokoroSynthesizer', () => {
  it('speaks each sentence in order as 16-bit PCM chunks of about 100 ms', async () => {
    const spoken: string[] = [];
    const engine: SpeechEngine = { generate: async (text) => (spoken.push(text), clip(450)) };
    const chunks = await collect(new KokoroSynthesizer({ engine }).synthesize('First one. Second one.', f24, new AbortController().signal));
    assert.deepEqual(spoken, ['First one.', 'Second one.']);
    const bytes = chunks.reduce((n, c) => n + c.length, 0);
    assert.equal(bytes, 2 * 450 * 24 * 2);
    assert.ok(chunks.every((c) => c.length % 2 === 0 && c.length <= 4800));
  });

  it('resamples to the requested format', async () => {
    const engine: SpeechEngine = { generate: async () => clip(500) };
    const f16 = { ...f24, sampleRate: 16000 } as const;
    const chunks = await collect(new KokoroSynthesizer({ engine }).synthesize('Hello there.', f16, new AbortController().signal));
    assert.equal(chunks.reduce((n, c) => n + c.length, 0), 500 * 16 * 2);
  });

  it('stops without generating more once aborted', async () => {
    let calls = 0;
    const controller = new AbortController();
    const engine: SpeechEngine = {
      generate: async () => {
        calls++;
        return clip(300);
      },
    };
    const received: Uint8Array[] = [];
    for await (const c of new KokoroSynthesizer({ engine }).synthesize('One. Two. Three.', f24, controller.signal)) {
      received.push(c);
      controller.abort();
    }
    assert.equal(received.length, 1);
    assert.equal(calls, 1);
  });

  it('runs one generation at a time even when asked concurrently', async () => {
    let active = 0;
    let peak = 0;
    const engine: SpeechEngine = {
      generate: async () => {
        peak = Math.max(peak, ++active);
        await new Promise((r) => setTimeout(r, 15));
        active--;
        return clip(100);
      },
    };
    const s = new KokoroSynthesizer({ engine });
    const signal = new AbortController().signal;
    await Promise.all([collect(s.synthesize('A one. A two.', f24, signal)), collect(s.synthesize('B one. B two.', f24, signal))]);
    assert.equal(peak, 1);
  });

  it('retries loading after a failure instead of caching it', async () => {
    let attempts = 0;
    const s = new KokoroSynthesizer({
      engine: async () => {
        if (++attempts === 1) throw new Error('download failed');
        return { generate: async () => clip(100) };
      },
    });
    await assert.rejects(s.warmUp(), /download failed/);
    await s.warmUp();
    assert.equal(attempts, 2);
  });

  it('says nothing for text with nothing to say', async () => {
    const engine: SpeechEngine = { generate: async () => assert.fail('should not run') };
    assert.deepEqual(await collect(new KokoroSynthesizer({ engine }).synthesize('...', f24, new AbortController().signal)), []);
  });
});

// Needs the real model (about 90 MB download on first run). Run with KOKORO_LIVE=1.
describe('KokoroSynthesizer with the real model', { skip: !process.env.KOKORO_LIVE }, () => {
  it('produces audible 24 kHz speech', async () => {
    const chunks = await collect(new KokoroSynthesizer().synthesize('Hello from the demo employee.', f24, new AbortController().signal));
    const seconds = chunks.reduce((n, c) => n + c.length, 0) / 2 / 24000;
    assert.ok(seconds > 1 && seconds < 6, `unexpected length ${seconds}s`);
    const peak = Math.max(...chunks.flatMap((c) => Array.from(new Int16Array(c.buffer, c.byteOffset, c.length / 2)).map(Math.abs)));
    assert.ok(peak > 2000, 'audio is silent');
  });
});
