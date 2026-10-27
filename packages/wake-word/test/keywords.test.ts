import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BARE_PHRASE, DEFAULT_GREETING_THRESHOLD, GREETING_PHRASES, keywordsFile, pcm16ToFloat } from '../src/index.js';

describe('wake phrases', () => {
  it('every phrase is a greeting followed by Cruz, spelled in the model word pieces', () => {
    assert.deepEqual(GREETING_PHRASES.map((p) => p.text), ['hey cruz', 'hi cruz', 'hello cruz', 'okay cruz']);
    for (const p of GREETING_PHRASES) {
      assert.match(p.tokens, /^▁[A-Z]+( [A-Z]+)* ▁C RU Z$/, p.text);
    }
    assert.equal(BARE_PHRASE.tokens, '▁C RU Z');
  });

  it('writes one line per greeting phrase with the boost and threshold, and no bare "Cruz" by default', () => {
    const lines = keywordsFile().trim().split('\n');
    assert.equal(lines.length, GREETING_PHRASES.length);
    for (const line of lines) assert.match(line, new RegExp(`^.+ :1 #${DEFAULT_GREETING_THRESHOLD}$`));
    assert.equal(lines.some((l) => l.startsWith('▁C RU Z')), false, 'a bare Cruz line would fire on cruise and crews');
  });

  it('adds a bare "Cruz" line only when asked, with its own threshold', () => {
    const lines = keywordsFile({ bareThreshold: 0.45, greetingThreshold: 0.15 }).trim().split('\n');
    assert.equal(lines.length, GREETING_PHRASES.length + 1);
    assert.equal(lines.at(-1), '▁C RU Z :1 #0.45');
    assert.ok(lines.slice(0, -1).every((l) => l.endsWith('#0.15')));
  });

  it('rejects thresholds and boosts that would break the spotter or fire on everything', () => {
    for (const bad of [0, 1, -0.1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => keywordsFile({ greetingThreshold: bad }), RangeError, String(bad));
      assert.throws(() => keywordsFile({ bareThreshold: bad }), RangeError, String(bad));
    }
    for (const bad of [0, -1, 11, Number.NaN]) assert.throws(() => keywordsFile({ boost: bad }), RangeError, String(bad));
  });
});

describe('pcm16ToFloat', () => {
  it('converts little-endian 16-bit samples to floats in [-1, 1]', () => {
    const bytes = new Uint8Array([0x00, 0x00, 0xff, 0x7f, 0x00, 0x80]); // 0, 32767, -32768
    const f = pcm16ToFloat(bytes);
    assert.equal(f.length, 3);
    assert.equal(f[0], 0);
    assert.ok(Math.abs(f[1]! - 32767 / 32768) < 1e-9);
    assert.equal(f[2], -1);
  });

  it('copes with an odd byte offset and a trailing odd byte', () => {
    const backing = new Uint8Array([9, 0x01, 0x00, 0x02, 0x00, 0x77]);
    const view = backing.subarray(1, 6); // starts at an odd offset, 5 bytes long
    const f = pcm16ToFloat(view);
    assert.equal(f.length, 2);
    assert.ok(Math.abs(f[0]! - 1 / 32768) < 1e-9);
    assert.ok(Math.abs(f[1]! - 2 / 32768) < 1e-9);
    assert.equal(pcm16ToFloat(new Uint8Array(0)).length, 0);
  });
});
