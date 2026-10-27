import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MockEmployeeBackend } from '@cruzclaw/mock-employee';
import { encodeAudioFrame, type ServerMessage } from '@cruzclaw/voice-core';
import { RuleReasoner, ScriptedTranscriber, ToneSynthesizer } from '../src/mock-providers.js';
import { VoiceSession } from '../src/session.js';

const audio = { encoding: 'pcm_s16le', sampleRate: 16000, channels: 1 } as const;
const start = JSON.stringify({ v: 1, type: 'session.start', audio });
const micFrame = encodeAudioFrame({ kind: 'mic', seq: 0, pcm: new Uint8Array(640) });

function setup(opts: { phrases?: string[]; voiceEnabled?: boolean; onSpeech?: () => void } = {}) {
  const backend = new MockEmployeeBackend();
  const messages: ServerMessage[] = [];
  const speech: Uint8Array[] = [];
  const ready: string[] = [];
  let closed = false;
  const session: VoiceSession = new VoiceSession({
    sessionId: 's1',
    host: backend.hostFor('t1'),
    providers: {
      transcriber: new ScriptedTranscriber(opts.phrases ?? ['Please draft an email to Maria']),
      reasoner: new RuleReasoner(),
      synthesizer: new ToneSynthesizer(),
    },
    features: { voiceEnabled: opts.voiceEnabled ?? true, wakePhraseConsent: false },
    onTaskReady: (id) => ready.push(id),
    transport: {
      sendJson: (m) => messages.push(m),
      sendAudio: (f) => {
        speech.push(f);
        opts.onSpeech?.();
      },
      close: () => {
        closed = true;
      },
    },
  });
  const types = () => messages.map((m) => m.type);
  const until = async (done: () => boolean) => {
    for (let i = 0; i < 500 && !done(); i++) await new Promise((r) => setImmediate(r));
    assert.ok(done(), `timed out; saw ${types().join(', ')}`);
  };
  return { backend, session, messages, speech, ready, types, until, isClosed: () => closed };
}

describe('VoiceSession', () => {
  it('runs a full turn: transcript, reply, approval-gated task, speech', async () => {
    const t = setup();
    t.session.handleText(start);
    t.session.handleBinary(micFrame);
    t.session.handleText(JSON.stringify({ v: 1, type: 'input.end' }));
    await t.until(() => t.types().includes('tts.end'));

    assert.deepEqual(
      t.types().filter((x, i, a) => a.indexOf(x) === i),
      ['session.ready', 'transcript.final', 'assistant.text.delta', 'assistant.text.done', 'task.proposed', 'task.event', 'approval.requested', 'tts.start', 'tts.end'],
    );
    assert.ok(t.speech.length > 0);
    assert.deepEqual(t.messages.map((m) => m.seq), t.messages.map((_, i) => i + 1));
    assert.equal(t.ready.length, 1);
  });

  it('does nothing real until the owner approves the exact payload', async () => {
    const t = setup();
    t.session.handleText(start);
    t.session.handleBinary(micFrame);
    t.session.handleText(JSON.stringify({ v: 1, type: 'input.end' }));
    await t.until(() => t.types().includes('approval.requested'));
    const taskId = t.ready[0]!;
    const approval = t.messages.find((m) => m.type === 'approval.requested');
    assert.ok(approval && approval.type === 'approval.requested');

    for (let i = 0; i < 5; i++) t.backend.advance('t1', taskId);
    assert.equal(t.backend.sideEffectCount('t1', taskId), 0);

    t.backend.decide('t1', approval.approval.approvalId, 'approved');
    for (let i = 0; i < 5; i++) t.backend.advance('t1', taskId);
    assert.equal(t.backend.sideEffectCount('t1', taskId), 1);
  });

  it('cancels speech on interrupt and never sends tts.end for it', async () => {
    let session!: VoiceSession;
    let interrupted = false;
    const t = setup({
      onSpeech: () => {
        if (!interrupted) {
          interrupted = true;
          session.handleText(JSON.stringify({ v: 1, type: 'interrupt', reason: 'barge_in' }));
        }
      },
    });
    session = t.session;
    t.session.handleText(start);
    t.session.handleBinary(micFrame);
    t.session.handleText(JSON.stringify({ v: 1, type: 'input.end' }));
    await t.until(() => t.types().includes('tts.cancelled'));
    assert.equal(t.types().includes('tts.end'), false);
    assert.equal(t.speech.length, 1);
  });

  it('refuses a session when the feature is off', () => {
    const t = setup({ voiceEnabled: false });
    t.session.handleText(start);
    assert.deepEqual(t.types(), ['error', 'session.closed']);
    const err = t.messages[0];
    assert.ok(err && err.type === 'error' && err.code === 'FEATURE_DISABLED');
    assert.equal(t.isClosed(), true);
    t.session.handleBinary(micFrame);
    assert.equal(t.messages.length, 2);
  });

  it('rejects out-of-order input, client identity and malformed audio', () => {
    const t = setup();
    t.session.handleBinary(micFrame);
    t.session.handleText(JSON.stringify({ v: 1, type: 'input.end' }));
    t.session.handleText(JSON.stringify({ v: 1, type: 'session.start', audio, userId: 'someone-else' }));
    t.session.handleText(start);
    t.session.handleBinary(new Uint8Array([1, 2, 3]));
    const codes = t.messages.map((m) => (m.type === 'error' ? m.code : m.type));
    assert.deepEqual(codes, ['OUT_OF_ORDER', 'OUT_OF_ORDER', 'INVALID_MESSAGE', 'session.ready', 'INVALID_MESSAGE']);
  });

  it('answers ping and stops after session.end', () => {
    const t = setup();
    t.session.handleText(start);
    t.session.handleText(JSON.stringify({ v: 1, type: 'ping', t: 7 }));
    t.session.handleText(JSON.stringify({ v: 1, type: 'session.end' }));
    t.session.handleText(JSON.stringify({ v: 1, type: 'ping', t: 8 }));
    assert.deepEqual(t.types(), ['session.ready', 'pong', 'session.closed']);
    assert.equal(t.isClosed(), true);
  });

  it('caps one utterance so a client cannot buffer without limit', () => {
    const t = setup();
    t.session.handleText(start);
    const big = encodeAudioFrame({ kind: 'mic', seq: 1, pcm: new Uint8Array(60 * 1024) });
    for (let i = 0; i < 40; i++) t.session.handleBinary(big);
    assert.ok(t.messages.some((m) => m.type === 'error'));
  });
});
