import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AUDIO_HEADER_BYTES,
  LIMITS,
  SessionGuard,
  decodeAudioFrame,
  encodeAudioFrame,
  parseClientMessage,
  parseServerMessage,
  type ClientMessage,
} from '../src/index.js';

const audio = { encoding: 'pcm_s16le', sampleRate: 16000, channels: 1 };
const start = { v: 1, type: 'session.start', audio, conversationId: 'conv-1' };

describe('parseClientMessage', () => {
  it('accepts a valid session.start, from an object or a JSON string', () => {
    const fromObject = parseClientMessage(start);
    const fromString = parseClientMessage(JSON.stringify(start));
    assert.equal(fromObject.ok, true);
    assert.deepEqual(fromString, fromObject);
  });

  it('accepts every other client message type', () => {
    for (const msg of [
      { v: 1, type: 'input.end' },
      { v: 1, type: 'input.end', utteranceId: 'u1' },
      { v: 1, type: 'interrupt', reason: 'barge_in' },
      { v: 1, type: 'interrupt', reason: 'correction' },
      { v: 1, type: 'playback.progress', ttsId: 't1', playedMs: 1200 },
      { v: 1, type: 'task.cancel', taskId: 'task-1' },
      { v: 1, type: 'ping', t: 1 },
      { v: 1, type: 'session.end' },
    ]) {
      assert.equal(parseClientMessage(msg).ok, true, JSON.stringify(msg));
    }
  });

  it('rejects malformed JSON, non-objects and oversized frames', () => {
    for (const raw of ['{nope', '[]', '"x"', 'null', 'x'.repeat(LIMITS.maxJsonBytes + 1)]) {
      const r = parseClientMessage(raw);
      assert.equal(r.ok, false);
    }
  });

  it('rejects an unsupported protocol version with its own code', () => {
    const r = parseClientMessage({ ...start, v: 2 });
    assert.deepEqual(r.ok === false && r.code, 'UNSUPPORTED_VERSION');
  });

  it('rejects unknown types and bad fields', () => {
    assert.equal(parseClientMessage({ v: 1, type: 'session.hack' }).ok, false);
    assert.equal(parseClientMessage({ ...start, audio: { ...audio, sampleRate: 44100 } }).ok, false);
    assert.equal(parseClientMessage({ ...start, audio: { ...audio, channels: 2 } }).ok, false);
    assert.equal(parseClientMessage({ v: 1, type: 'interrupt', reason: 'because' }).ok, false);
    assert.equal(parseClientMessage({ v: 1, type: 'playback.progress', ttsId: 't', playedMs: -1 }).ok, false);
    assert.equal(parseClientMessage({ v: 1, type: 'task.cancel', taskId: '' }).ok, false);
    assert.equal(parseClientMessage({ v: 1, type: 'ping', t: Number.NaN }).ok, false);
  });

  it('rejects any client-supplied identity, at any depth', () => {
    for (const key of ['accountId', 'userId', 'tenantId', 'organizationId', 'personaId', 'deploymentId']) {
      assert.equal(parseClientMessage({ ...start, [key]: 'someone-else' }).ok, false, key);
      assert.equal(parseClientMessage({ ...start, audio: { ...audio, nested: { [key]: 'x' } } }).ok, false, `nested ${key}`);
    }
  });

  it('accepts the speech mode server or device, and nothing else', () => {
    for (const speech of ['server', 'device']) {
      const r = parseClientMessage({ ...start, speech });
      assert.equal(r.ok && r.message.type === 'session.start' && r.message.speech, speech);
    }
    const omitted = parseClientMessage(start);
    assert.equal(omitted.ok && 'speech' in omitted.message, false);
    // A client cannot ask for "none": that is what a server with no voice says about itself.
    for (const speech of ['none', 'both', '', 7, null]) assert.equal(parseClientMessage({ ...start, speech }).ok, false, String(speech));
  });

  it('drops unknown extra fields from the parsed result', () => {
    const r = parseClientMessage({ ...start, extra: 'ignored' });
    assert.equal(r.ok && 'extra' in r.message, false);
  });
});

describe('parseServerMessage', () => {
  it('accepts valid server messages and requires seq from 1', () => {
    assert.equal(parseServerMessage({ v: 1, seq: 1, type: 'session.ready', sessionId: 's1', audio }).ok, true);
    assert.equal(parseServerMessage({ v: 1, seq: 2, type: 'transcript.final', utteranceId: 'u', text: 'hello' }).ok, true);
    assert.equal(parseServerMessage({ v: 1, seq: 3, type: 'tts.cancelled', ttsId: 't' }).ok, true);
    assert.equal(parseServerMessage({ v: 1, seq: 0, type: 'tts.end', ttsId: 't' }).ok, false);
    assert.equal(parseServerMessage({ v: 1, type: 'tts.end', ttsId: 't' }).ok, false);
  });

  it('carries the speech mode on session.ready, and keeps working without it', () => {
    const ready = { v: 1, seq: 1, type: 'session.ready', sessionId: 's1', audio };
    for (const speech of ['server', 'device', 'none']) {
      const r = parseServerMessage({ ...ready, speech });
      assert.equal(r.ok && r.message.type === 'session.ready' && r.message.speech, speech);
    }
    const old = parseServerMessage(ready);
    assert.equal(old.ok && 'speech' in old.message, false);
    assert.equal(parseServerMessage({ ...ready, speech: 'loud' }).ok, false);
  });

  it('checks host records are objects and errors carry retryable', () => {
    assert.equal(parseServerMessage({ v: 1, seq: 1, type: 'task.event', event: 'nope' }).ok, false);
    assert.equal(parseServerMessage({ v: 1, seq: 1, type: 'task.event', event: { seq: 1 } }).ok, true);
    assert.equal(parseServerMessage({ v: 1, seq: 1, type: 'error', code: 'INTERNAL', message: 'x' }).ok, false);
    assert.equal(
      parseServerMessage({ v: 1, seq: 1, type: 'error', code: 'INTERNAL', message: 'x', retryable: false }).ok,
      true,
    );
  });

  it('rejects unknown types', () => {
    assert.equal(parseServerMessage({ v: 1, seq: 1, type: 'wat' }).ok, false);
  });
});

describe('audio frames', () => {
  const pcm = new Uint8Array([1, 0, 2, 0, 3, 0]);

  it('round-trips a frame', () => {
    const decoded = decodeAudioFrame(encodeAudioFrame({ kind: 'mic', seq: 7, pcm }));
    assert.deepEqual(decoded, { kind: 'mic', seq: 7, pcm });
    assert.equal(decodeAudioFrame(encodeAudioFrame({ kind: 'speech', seq: 0xffffffff, pcm }))?.seq, 0xffffffff);
  });

  it('refuses to encode bad frames', () => {
    assert.throws(() => encodeAudioFrame({ kind: 'mic', seq: -1, pcm }), RangeError);
    assert.throws(() => encodeAudioFrame({ kind: 'mic', seq: 1, pcm: new Uint8Array(3) }), RangeError);
    assert.throws(
      () => encodeAudioFrame({ kind: 'mic', seq: 1, pcm: new Uint8Array(LIMITS.maxAudioFrameBytes) }),
      RangeError,
    );
  });

  it('decodes malformed input to null without throwing', () => {
    const good = encodeAudioFrame({ kind: 'mic', seq: 1, pcm });
    assert.equal(decodeAudioFrame(good.subarray(0, AUDIO_HEADER_BYTES - 1)), null);
    assert.equal(decodeAudioFrame(new Uint8Array(LIMITS.maxAudioFrameBytes + 1)), null);
    for (const [index, value] of [[0, 9], [1, 9], [2, 1]] as const) {
      const copy = good.slice();
      copy[index] = value;
      assert.equal(decodeAudioFrame(copy), null, `byte ${index}`);
    }
    assert.equal(decodeAudioFrame(good.subarray(0, good.length - 1)), null);
  });
});

describe('SessionGuard', () => {
  const msg = (m: object) => m as ClientMessage;

  it('requires session.start first, then session.ready before other messages and audio', () => {
    const g = new SessionGuard();
    assert.equal(g.accept(msg({ type: 'interrupt', reason: 'user' })).ok, false);
    assert.equal(g.acceptAudio().ok, false);
    assert.equal(g.accept(msg(start)).ok, true);
    assert.equal(g.accept(msg({ type: 'interrupt', reason: 'user' })).ok, false);
    assert.equal(g.acceptAudio().ok, false);
    assert.equal(g.accept(msg({ type: 'ping', t: 1 })).ok, true);
    g.markReady();
    assert.equal(g.phase, 'ready');
    assert.equal(g.accept(msg({ type: 'interrupt', reason: 'user' })).ok, true);
    assert.equal(g.acceptAudio().ok, true);
  });

  it('rejects a second session.start and everything after the session ends', () => {
    const g = new SessionGuard();
    g.accept(msg(start));
    g.markReady();
    const second = g.accept(msg(start));
    assert.equal(second.ok === false && second.code, 'OUT_OF_ORDER');
    assert.equal(g.accept(msg({ type: 'session.end' })).ok, true);
    assert.equal(g.phase, 'closed');
    assert.equal(g.accept(msg({ type: 'ping', t: 1 })).ok, false);
    assert.equal(g.acceptAudio().ok, false);
  });
});
