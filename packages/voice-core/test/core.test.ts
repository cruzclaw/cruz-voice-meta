import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hashPayload, parseVoiceFeatureConfig } from '../src/index.ts';

describe('hashPayload', () => {
  it('ignores key order', () => {
    assert.equal(hashPayload({ a: 1, b: { c: 2, d: 3 } }), hashPayload({ b: { d: 3, c: 2 }, a: 1 }));
  });

  it('changes when any value changes', () => {
    assert.notEqual(hashPayload({ to: 'a@example.com' }), hashPayload({ to: 'b@example.com' }));
  });
});

describe('parseVoiceFeatureConfig', () => {
  it('defaults to off for missing or malformed input', () => {
    for (const raw of [undefined, null, 'on', 1, {}, { voiceEnabled: 'true' }]) {
      assert.deepEqual(parseVoiceFeatureConfig(raw), { voiceEnabled: false, wakePhraseConsent: false });
    }
  });

  it('ignores wake consent while voice is off', () => {
    assert.equal(parseVoiceFeatureConfig({ voiceEnabled: false, wakePhraseConsent: true }).wakePhraseConsent, false);
  });

  it('turns on only for an explicit true', () => {
    assert.deepEqual(parseVoiceFeatureConfig({ voiceEnabled: true, wakePhraseConsent: true }), {
      voiceEnabled: true,
      wakePhraseConsent: true,
    });
  });
});
