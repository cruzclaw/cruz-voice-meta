import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { ClientMessage, ServerMessage } from '@cruzclaw/voice-core';
import { EndpointDetector } from '@cruzclaw/windows-bridge';
import { RuleReasoner, ScriptedTranscriber, type Synthesizer } from '@cruzclaw/voice-server';
import { createDemoServer, type DemoServer } from '../../demo-server/src/server.js';
import { VoiceClient } from '../src/client.js';
import { StaticConnection } from '../src/connection.js';
import { HostController, type AudioDevice, type ChimeKind, type Link, type WakeSource } from '../src/controller.js';

/** A speaker that keeps sounding for a while after the last chunk, like the real one. */
class FakeAudio implements AudioDevice {
  calls: string[] = [];
  played = 0;
  busy = false;
  /** Called when the speaker falls silent by itself. Not called when playback is stopped. */
  onDrained: (() => void) | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(public lingerMs = 80) {}
  startCapture() { this.calls.push('start'); }
  stopCapture() { this.calls.push('stop'); }
  play(pcm: Uint8Array) {
    this.played += pcm.byteLength;
    this.busy = true;
    clearTimeout(this.timer);
    if (Number.isFinite(this.lingerMs)) {
      this.timer = setTimeout(() => { this.busy = false; this.onDrained?.(); }, this.lingerMs);
    }
  }
  stopPlayback() { this.calls.push('stopPlayback'); this.busy = false; clearTimeout(this.timer); }
  isPlaying() { return this.busy; }
  chime(kind: ChimeKind) { this.calls.push(`chime:${kind}`); }
  /** Every change of the wake microphone, in order. Kept apart from calls so older tests are unaffected. */
  wakeCalls: boolean[] = [];
  listenForWake(on: boolean) { this.wakeCalls.push(on); }
}

const until = async (pred: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** Speaks for about two seconds so a test can interrupt it mid-sentence. */
class SlowSynth implements Synthesizer {
  async *synthesize(_text: string, _format: unknown, signal: AbortSignal): AsyncIterable<Uint8Array> {
    for (let i = 0; i < 40 && !signal.aborted; i++) {
      yield new Uint8Array(960);
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

let demo: DemoServer;
let port: number;

before(async () => {
  demo = createDemoServer({
    accounts: [
      { token: 'good', tenantKey: 'on', features: { voiceEnabled: true }, displayName: 'Dana' },
      { token: 'off', tenantKey: 'off', features: { voiceEnabled: false } },
    ],
    providers: { transcriber: new ScriptedTranscriber(['What is the status']), reasoner: new RuleReasoner(), synthesizer: new SlowSynth() },
    workerIntervalMs: 10,
  });
  port = await demo.listen(0);
});
after(() => demo.close());

const ended = (h: { seen: ServerMessage[] }) => h.seen.filter((m) => m.type === 'tts.end').length;

/** A host wired like the real app: one connection at launch, a session only when the person presses. */
function host(token: string, now: () => number = Date.now, followUp = true) {
  const audio = new FakeAudio();
  const seen: ServerMessage[] = [];
  const closed: string[] = [];
  const sent: ClientMessage[] = [];
  const sessionsStarted: boolean[] = [];
  let controller!: HostController;
  let client: VoiceClient | undefined;
  let mine = 0;
  const make = () => {
    const id = ++mine;
    return new VoiceClient(new StaticConnection(`ws://127.0.0.1:${port}`, token), {
      onMessage: (m) => { if (id === mine) { seen.push(m); controller.onServer(m); } },
      onSpeech: (pcm) => { if (id === mine) controller.onSpeech(pcm); },
      onClose: (reason) => { if (id === mine) { closed.push(reason); controller.setConnected(false); } },
    });
  };
  const link: Link = {
    send: (m) => { sent.push(m); client?.send(m); },
    sendMic: (pcm) => client?.sendMic(pcm),
    startSession: async (fresh) => {
      sessionsStarted.push(fresh);
      if (fresh && client) {
        const old = client;
        mine++;
        old.close();
        client = make();
        await client.openConnection();
        controller.setConnected(true);
      }
      await client!.startSession('conv-test');
    },
  };
  controller = new HostController(link, audio, { now, followUp, endpoint: new EndpointDetector() });
  audio.onDrained = () => controller.onPlaybackDrained();
  const open = async () => {
    client = make();
    await client.openConnection();
    controller.setConnected(true);
  };
  return { audio, seen, closed, sent, sessionsStarted, controller, open, close: () => { controller.dispose(); client?.close(); } };
}

const speak = (c: HostController, ms = 1200) => {
  for (let i = 0; i < ms / 40; i++) { c.onMic(new Uint8Array(960)); c.onLevel(0.08); }
  for (let i = 0; i < 25; i++) { c.onMic(new Uint8Array(960)); c.onLevel(0.003); }
};

describe('Windows voice host against the demo server', () => {
  it('a first press starts the session, the assistant greets by name, then it listens on its own', async () => {
    const h = host('good');
    await h.open();
    assert.equal(h.controller.display, 'idle');
    assert.deepEqual(h.audio.calls, [], 'nothing is spoken or heard just from connecting');

    h.controller.command('summon');
    await until(() => ended(h) === 1);
    assert.equal(h.controller.state.reply, "Hi Dana, I'm listening. How can I help?");
    assert.ok(h.audio.played > 0, 'the greeting reached the speaker');
    await until(() => h.audio.calls.includes('start'));
    // The microphone opens only after the greeting finished, with the listening chime first.
    assert.deepEqual(h.audio.calls.filter((c) => c !== 'stopPlayback' && c !== 'stop'), ['chime:listening', 'start']);
    assert.equal(h.controller.display, 'listening');
    h.close();
  });

  it('then ends by itself, chimes that it is thinking, and speaks the reply', async () => {
    const h = host('good');
    await h.open();
    h.controller.command('summon');
    await until(() => h.controller.display === 'listening');
    const greetingBytes = h.audio.played;
    speak(h.controller);
    assert.equal(h.controller.display, 'thinking');
    assert.ok(h.audio.calls.indexOf('chime:thinking') > h.audio.calls.indexOf('chime:listening'));
    await until(() => ended(h) === 2);
    assert.ok(h.audio.played > greetingBytes, 'the reply reached the speaker');
    const inputEnds = h.sent.filter((m) => m.type === 'input.end') as Array<{ utteranceId: string }>;
    assert.deepEqual(inputEnds.map((m) => m.utteranceId), ['host-1']);
    h.close();
  });

  it('does not open the microphone while the greeting is still playing out of the speaker', async () => {
    const h = host('good');
    await h.open();
    h.audio.lingerMs = 600;
    h.controller.command('summon');
    await until(() => ended(h) === 1);
    // The server has finished sending, but the speaker is still sounding.
    assert.equal(h.audio.busy, true);
    assert.equal(h.audio.calls.includes('start'), false, 'microphone stays closed while the speaker is busy');
    assert.notEqual(h.controller.display, 'listening');
    await until(() => h.audio.calls.includes('start'));
    assert.equal(h.audio.busy, false, 'it opened only after the speaker went quiet');
    h.close();
  });

  it('after an answer it listens for a follow-up by itself, once the speaker is quiet', async () => {
    const h = host('good');
    await h.open();
    h.controller.command('summon');
    await until(() => h.controller.display === 'listening');
    speak(h.controller);
    await until(() => ended(h) === 2);
    // The answer was sent; the speaker is still sounding, so the microphone stays closed for now.
    assert.equal(h.audio.calls.filter((c) => c === 'start').length, 1);
    await until(() => h.audio.calls.filter((c) => c === 'start').length === 2);
    assert.equal(h.audio.busy, false);
    assert.equal(h.controller.display, 'listening');
    assert.deepEqual(h.audio.calls.filter((c) => c.startsWith('chime')), ['chime:listening', 'chime:thinking', 'chime:listening']);
    assert.deepEqual(h.sessionsStarted, [false], 'same session: no new greeting');
    h.close();
  });

  it('a follow-up window nobody speaks into ends quietly: no chime, no error, back to ready', async () => {
    const h = host('good');
    await h.open();
    h.controller.command('summon');
    await until(() => h.controller.display === 'listening');
    speak(h.controller);
    await until(() => h.audio.calls.filter((c) => c === 'start').length === 2);
    for (let i = 0; i < 210; i++) h.controller.onLevel(0.003);
    assert.equal(h.controller.display, 'idle');
    assert.equal(h.controller.state.lastError, undefined);
    assert.equal(h.audio.calls.includes('chime:cancelled'), false);
    h.close();
  });

  it('a press while the greeting plays skips it and listens at once', async () => {
    const h = host('good');
    await h.open();
    h.controller.command('summon');
    await until(() => h.controller.display === 'speaking');
    await new Promise((r) => setTimeout(r, 120));
    h.controller.command('summon');
    assert.equal(h.controller.display, 'listening');
    assert.ok(h.audio.calls.includes('stopPlayback'));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(h.audio.calls.filter((c) => c === 'start').length, 1, 'does not also listen when the cut-off greeting ends');
    assert.equal(h.controller.display, 'listening');
    h.close();
  });

  it('later presses just chime and listen, with no new greeting', async () => {
    const h = host('good', Date.now, false);
    await h.open();
    h.controller.command('summon');
    await until(() => h.controller.display === 'listening');
    speak(h.controller);
    await until(() => ended(h) === 2);
    h.controller.command('summon');
    assert.equal(h.controller.display, 'listening');
    assert.deepEqual(h.sessionsStarted, [false]);
    h.close();
  });

  it('a press after a long quiet spell starts a fresh session with a new greeting', async () => {
    let clock = 1_000_000;
    const h = host('good', () => clock, false);
    await h.open();
    h.controller.command('summon');
    await until(() => h.controller.display === 'listening');
    speak(h.controller);
    await until(() => ended(h) === 2);
    clock += 16 * 60 * 1000;
    h.controller.command('summon');
    await until(() => ended(h) === 3);
    assert.deepEqual(h.sessionsStarted, [false, true]);
    assert.equal(h.seen.filter((m) => m.type === 'session.ready').length, 2);
    assert.equal(h.controller.state.reply, "Hi Dana, I'm listening. How can I help?");
    h.close();
  });

  it('a press while the assistant speaks its answer interrupts and stops playback at once', async () => {
    const h = host('good');
    await h.open();
    h.controller.command('summon');
    await until(() => h.controller.display === 'listening');
    speak(h.controller);
    await until(() => h.seen.filter((m) => m.type === 'tts.start').length === 2);
    assert.equal(h.controller.display, 'speaking');
    h.controller.command('summon');
    assert.ok(h.audio.calls.includes('stopPlayback'));
    assert.equal(h.controller.display, 'listening');
    h.close();
  });

  it('refuses a wrong token at connect without leaking it', async () => {
    const h = host('wrong-token-value');
    await assert.rejects(h.open(), (e: Error) => {
      assert.match(e.message, /did not accept the sign-in or ticket \(HTTP 401\)/);
      assert.equal(e.message.includes('wrong-token-value'), false);
      return true;
    });
  });

  it('shows why when the feature is off for the account, on the first press, and never opens the microphone', async () => {
    const h = host('off');
    await h.open();
    h.controller.command('summon');
    await until(() => h.controller.state.lastError !== undefined);
    assert.ok(['FEATURE_DISABLED', 'SESSION'].includes(h.controller.state.lastError!.code));
    assert.equal(h.audio.calls.includes('start'), false);
    h.close();
  });

  it('drops a turn and silences the speaker when the connection is lost', async () => {
    const h = host('good');
    await h.open();
    h.controller.command('summon');
    await until(() => h.controller.display === 'speaking');
    h.close();
    h.controller.setConnected(false);
    assert.equal(h.controller.display, 'disconnected');
    assert.equal(h.audio.calls.at(-1), 'stopPlayback');
  });
});

/** Controller behaviour with a scripted link, for cases that depend on exact message timing. */
function scripted(options: ConstructorParameters<typeof HostController>[2] = {}) {
  const audio = new FakeAudio(Number.POSITIVE_INFINITY); // drained by hand with c.onPlaybackDrained()
  const sent: ClientMessage[] = [];
  const starts: boolean[] = [];
  let failWith: Error | undefined;
  const c = new HostController(
    { send: (m) => void sent.push(m), sendMic: () => undefined, startSession: async (fresh) => { starts.push(fresh); if (failWith) throw failWith; } },
    audio,
    options,
  );
  let n = 0;
  const server = (message: object) => c.onServer({ v: 1, seq: ++n, ...message } as ServerMessage);
  c.setConnected(true);
  const fmt = { encoding: 'pcm_s16le', sampleRate: 24000, channels: 1 };
  return {
    c, audio, sent, starts, server, fmt,
    fail: (e: Error) => { failWith = e; },
    /** A session is up and the greeting is over, so the next press listens. */
    active: () => { server({ type: 'session.ready', sessionId: 's', audio: fmt }); },
  };
}

describe('HostController timing and interrupts', () => {
  it('chimes: rising when listening starts, falling when it starts thinking, low when nothing was said', () => {
    const t = scripted({ endpoint: new EndpointDetector() });
    t.active();
    t.c.command('summon');
    for (let i = 0; i < 30; i++) t.c.onLevel(0.08);
    for (let i = 0; i < 25; i++) t.c.onLevel(0.003);
    assert.deepEqual(t.audio.calls.filter((x) => x.startsWith('chime')), ['chime:listening', 'chime:thinking']);
    t.server({ type: 'error', code: 'PROVIDER_ERROR', message: 'x', retryable: true });
    t.audio.calls.length = 0;
    t.c.command('summon');
    for (let i = 0; i < 210; i++) t.c.onLevel(0.003);
    assert.deepEqual(t.audio.calls.filter((x) => x.startsWith('chime')), ['chime:listening', 'chime:cancelled']);
    t.c.dispose();
  });

  it('pressing while it thinks cuts in: an interrupt goes out and it listens', () => {
    const t = scripted({ endpoint: new EndpointDetector() });
    t.active();
    t.c.command('summon');
    speak(t.c);
    assert.equal(t.c.display, 'thinking');
    t.c.command('summon');
    assert.equal(t.c.display, 'listening');
    assert.ok(t.sent.some((m) => m.type === 'interrupt'));
    t.c.dispose();
  });

  it("ignores the cut-off turn's late transcript, reply and speech, but not the next turn's", () => {
    const t = scripted({ endpoint: new EndpointDetector() });
    t.active();
    t.c.command('summon');
    speak(t.c); // utterance host-1 sent
    t.c.command('summon'); // cut in while thinking
    assert.equal(t.c.display, 'listening');

    // Everything the old turn still had in flight arrives now.
    t.server({ type: 'transcript.final', utteranceId: 'host-1', text: 'old words' });
    t.server({ type: 'assistant.text.delta', turnId: 'turn-1', text: 'Old answer.' });
    t.server({ type: 'assistant.text.done', turnId: 'turn-1' });
    t.server({ type: 'tts.start', ttsId: 'tts-1', turnId: 'turn-1', audio: t.fmt });
    t.c.onSpeech(new Uint8Array(960));
    assert.equal(t.c.display, 'listening', 'the old turn did not take over the screen');
    assert.equal(t.c.state.reply, '');
    assert.equal(t.audio.played, 0, 'none of the old speech was played');

    speak(t.c); // utterance host-2
    t.server({ type: 'transcript.final', utteranceId: 'host-2', text: 'new words' });
    t.server({ type: 'assistant.text.delta', turnId: 'turn-2', text: 'New answer.' });
    t.server({ type: 'tts.start', ttsId: 'tts-2', turnId: 'turn-2', audio: t.fmt });
    assert.equal(t.c.state.transcript, 'new words');
    assert.equal(t.c.state.reply, 'New answer.');
    assert.equal(t.c.display, 'speaking');
    t.c.onSpeech(new Uint8Array(960));
    assert.equal(t.audio.played, 960, 'the new answer is played');
    t.c.dispose();
  });

  it('cutting in on speech stops playback and ignores the tts.cancelled that follows', () => {
    const t = scripted({ endpoint: new EndpointDetector() });
    t.active();
    t.server({ type: 'tts.start', ttsId: 't', turnId: 'turn-1', audio: t.fmt });
    assert.equal(t.c.display, 'speaking');
    t.c.command('summon');
    assert.ok(t.audio.calls.includes('stopPlayback'));
    assert.equal(t.c.display, 'listening');
    t.server({ type: 'tts.cancelled', ttsId: 't' });
    assert.equal(t.c.display, 'listening');
    t.c.dispose();
  });

  it('waits for the speaker to drain before listening, and a press then cuts the rest off first', () => {
    const t = scripted();
    t.c.command('summon'); // starts the session; the greeting is under way
    t.server({ type: 'session.ready', sessionId: 's', audio: t.fmt });
    t.server({ type: 'tts.start', ttsId: 'g', turnId: 'turn-1', audio: t.fmt });
    t.c.onSpeech(new Uint8Array(960)); // still playing
    t.server({ type: 'tts.end', ttsId: 'g' });
    assert.equal(t.audio.calls.includes('start'), false, 'no microphone while the speaker is busy');
    t.c.onPlaybackDrained();
    assert.equal(t.c.display, 'listening');
    assert.deepEqual(t.audio.calls.filter((x) => x.startsWith('chime') || x === 'start'), ['chime:listening', 'start']);
    t.c.dispose();
  });

  it('a drain report that arrives for anything but a finished greeting does nothing', () => {
    const t = scripted();
    t.active();
    t.c.onPlaybackDrained();
    assert.equal(t.c.display, 'idle');
    assert.equal(t.audio.calls.includes('start'), false);
    t.c.dispose();
  });

  it('opening the microphone always silences any speech still playing', () => {
    const t = scripted();
    t.active();
    t.audio.play(new Uint8Array(960));
    assert.equal(t.audio.isPlaying(), true);
    t.c.command('summon');
    assert.equal(t.audio.isPlaying(), false);
    assert.ok(t.audio.calls.indexOf('stopPlayback') < t.audio.calls.indexOf('start'));
    t.c.dispose();
  });

  it('does not listen for a follow-up after an interrupted answer, an error, or when it is switched off', () => {
    const answer = (t: ReturnType<typeof scripted>, then: () => void) => {
      t.active();
      t.c.command('summon');
      t.c.command('summon'); // end listening, thinking
      t.server({ type: 'transcript.final', utteranceId: 'host-1', text: 'hello' });
      t.server({ type: 'assistant.text.delta', turnId: 'turn-1', text: 'Hi.' });
      t.server({ type: 'tts.start', ttsId: 't', turnId: 'turn-1', audio: t.fmt });
      then();
    };
    const starts = (t: ReturnType<typeof scripted>) => t.audio.calls.filter((x) => x === 'start').length;

    const normal = scripted();
    answer(normal, () => normal.server({ type: 'tts.end', ttsId: 't' }));
    assert.equal(starts(normal), 2, 'the baseline: it does listen again');

    const interrupted = scripted();
    answer(interrupted, () => { interrupted.c.command('summon'); interrupted.server({ type: 'tts.end', ttsId: 't' }); });
    assert.equal(starts(interrupted), 2, 'one listen from the first press, one from the cut-in; no extra');

    const failed = scripted();
    answer(failed, () => failed.server({ type: 'error', code: 'PROVIDER_ERROR', message: 'x', retryable: true }));
    failed.server({ type: 'tts.end', ttsId: 't' });
    assert.equal(starts(failed), 1);

    const off = scripted({ followUp: false });
    answer(off, () => off.server({ type: 'tts.end', ttsId: 't' }));
    assert.equal(starts(off), 1);
    for (const t of [normal, interrupted, failed, off]) t.c.dispose();
  });

  it('muting stops automatic listening, but a deliberate press turns the microphone back on', () => {
    const t = scripted();
    t.active();
    t.c.toggleMute();
    assert.equal(t.c.state.micMuted, true);
    t.c.command('summon'); // what an automatic listen does: it respects mute
    assert.equal(t.audio.calls.includes('start'), false);
    t.c.press(); // the person pressed Talk
    assert.equal(t.c.state.micMuted, false);
    assert.equal(t.c.display, 'listening');
    t.c.dispose();
  });

  it('muting while listening drops the turn: the server is told to discard it and never answers it', () => {
    const t = scripted({ endpoint: new EndpointDetector() });
    t.active();
    t.c.command('summon');
    assert.equal(t.c.display, 'listening');
    t.c.toggleMute();
    assert.equal(t.c.display, 'idle');
    assert.equal(t.c.state.micMuted, true);
    assert.deepEqual(t.sent.map((m) => m.type), ['input.end', 'interrupt']);
    assert.ok(t.audio.calls.includes('stop'));
    // Whatever the server still sends for that utterance is ignored.
    t.server({ type: 'transcript.final', utteranceId: 'host-1', text: 'half a sentence' });
    t.server({ type: 'assistant.text.delta', turnId: 'turn-1', text: 'Answer.' });
    t.server({ type: 'tts.start', ttsId: 't', turnId: 'turn-1', audio: t.fmt });
    assert.equal(t.c.display, 'idle');
    assert.equal(t.c.state.reply, '');
    t.c.dispose();
  });

  it('no follow-up listening while muted, and unmuting does not start listening by itself', () => {
    const t = scripted();
    t.active();
    t.c.command('summon');
    t.c.command('summon');
    t.server({ type: 'transcript.final', utteranceId: 'host-1', text: 'hello' });
    t.server({ type: 'tts.start', ttsId: 't', turnId: 'turn-1', audio: t.fmt });
    t.c.toggleMute(); // muted while the answer plays
    t.server({ type: 'tts.end', ttsId: 't' });
    assert.equal(t.audio.calls.filter((x) => x === 'start').length, 1, 'only the original listen');
    t.c.toggleMute();
    assert.equal(t.c.state.micMuted, false);
    assert.notEqual(t.c.display, 'listening');
    t.c.dispose();
  });

  it('muting then unmuting before the answer finishes playing does not open the microphone by surprise', () => {
    const t = scripted();
    t.active();
    t.c.command('summon');
    t.c.command('summon');
    t.server({ type: 'transcript.final', utteranceId: 'host-1', text: 'hello' });
    t.server({ type: 'tts.start', ttsId: 't', turnId: 'turn-1', audio: t.fmt });
    t.c.onSpeech(new Uint8Array(960)); // the speaker is busy
    t.server({ type: 'tts.end', ttsId: 't' }); // a follow-up is now due once it drains
    t.c.toggleMute();
    t.c.toggleMute();
    t.c.onPlaybackDrained();
    assert.equal(t.audio.calls.filter((x) => x === 'start').length, 1, 'only the original listen');
    assert.notEqual(t.c.display, 'listening');
    t.c.dispose();
  });

  it('hanging up ends the whole conversation: nothing more is heard, said or listened for', () => {
    const t = scripted({ endpoint: new EndpointDetector() });
    t.active();
    t.c.command('summon');
    assert.equal(t.c.inCall, true);
    t.c.hangUp();
    assert.equal(t.c.display, 'idle');
    assert.equal(t.c.inCall, false);
    assert.deepEqual(t.sent.map((m) => m.type), ['input.end', 'interrupt'], 'the server drops the audio and any answer');
    // What the server still had in flight is ignored, and no follow-up listening comes of it.
    t.server({ type: 'transcript.final', utteranceId: 'host-1', text: 'half' });
    t.server({ type: 'assistant.text.delta', turnId: 'turn-1', text: 'Answer.' });
    t.server({ type: 'tts.start', ttsId: 't', turnId: 'turn-1', audio: t.fmt });
    t.server({ type: 'tts.end', ttsId: 't' });
    assert.equal(t.c.display, 'idle');
    assert.equal(t.audio.calls.filter((x) => x === 'start').length, 1, 'no follow-up listening after hanging up');
    t.c.dispose();
  });

  it('hanging up while it speaks or thinks stops the voice at once and cancels the pending follow-up', () => {
    const t = scripted();
    t.active();
    t.c.command('summon');
    t.c.command('summon');
    t.server({ type: 'transcript.final', utteranceId: 'host-1', text: 'hello' });
    t.server({ type: 'tts.start', ttsId: 't', turnId: 'turn-1', audio: t.fmt });
    t.c.onSpeech(new Uint8Array(960));
    assert.equal(t.c.inCall, true);
    t.c.hangUp();
    assert.equal(t.audio.isPlaying(), false);
    assert.equal(t.c.inCall, false);
    assert.ok(t.sent.some((m) => m.type === 'interrupt'));
    t.server({ type: 'tts.end', ttsId: 't' });
    t.c.onPlaybackDrained();
    assert.equal(t.audio.calls.filter((x) => x === 'start').length, 1);
    t.c.dispose();
  });

  it('the next call after hanging up listens straight away, with no new greeting', () => {
    const t = scripted();
    t.active();
    t.c.command('summon');
    t.c.hangUp();
    t.c.press();
    assert.equal(t.c.display, 'listening');
    assert.deepEqual(t.starts, [], 'the session was kept, so no new session or greeting');
    // And the new turn is answered normally.
    t.c.command('summon');
    t.server({ type: 'transcript.final', utteranceId: 'host-2', text: 'again' });
    assert.equal(t.c.state.transcript, 'again');
    t.c.dispose();
  });

  it('signing out in the middle of a call stops everything and leaves nothing of the conversation on the panel', () => {
    const t = scripted({ endpoint: new EndpointDetector() });
    t.active();
    t.server({ type: 'transcript.final', utteranceId: 'u1', text: 'what does the email say' });
    t.server({ type: 'assistant.text.delta', turnId: 'turn-1', text: 'The email from Maria says the numbers are 41 and 97.' });
    t.server({ type: 'tts.start', ttsId: 't', turnId: 'turn-1', audio: t.fmt });
    assert.equal(t.c.display, 'speaking');
    assert.match(t.c.state.reply, /41 and 97/);

    t.c.endConversation();

    assert.equal(t.c.inCall, false);
    assert.equal(t.c.display, 'disconnected');
    assert.equal(t.c.state.connected, false);
    assert.equal(t.c.state.sessionActive, false);
    assert.equal(t.c.state.transcript, '');
    assert.equal(t.c.state.reply, '', 'the last reply is gone');
    assert.deepEqual(t.c.state.tasks, []);
    assert.equal(t.audio.calls.at(-1), 'stopPlayback');
    assert.ok(t.audio.calls.includes('stop'), 'the microphone is closed');
    // What the old connection still sends is ignored.
    t.server({ type: 'assistant.text.delta', turnId: 'turn-1', text: 'More of it.' });
    t.server({ type: 'transcript.final', utteranceId: 'u2', text: 'secret' });
    assert.equal(t.c.state.reply, '');
    assert.equal(t.c.state.transcript, '');
    t.c.dispose();
  });

  it('after signing out and back in, the first call is a normal fresh call with a greeting', async () => {
    const t = scripted();
    t.active();
    t.c.endConversation();
    t.c.setConnected(true);
    t.c.command('summon');
    await new Promise((r) => setTimeout(r, 5));

    assert.equal(t.starts.length, 1, 'a session was started');
    assert.equal(t.c.state.reply, '');
    t.server({ type: 'session.ready', sessionId: 's2', audio: t.fmt });
    t.server({ type: 'assistant.text.delta', turnId: 'turn-9', text: 'Hi.' });
    assert.equal(t.c.state.reply, 'Hi.', 'the greeting is shown, not discarded as if aborted');
    t.c.dispose();
  });

  it('hanging up while the session is still starting silences the greeting that follows', async () => {
    const sent: ClientMessage[] = [];
    const audio = new FakeAudio(Number.POSITIVE_INFINITY);
    let finish!: () => void;
    const fmt = { encoding: 'pcm_s16le', sampleRate: 24000, channels: 1 } as const;
    let n = 0;
    const c: HostController = new HostController(
      {
        send: (m) => void sent.push(m),
        sendMic: () => undefined,
        // The server says ready, then the session start resolves, then the greeting messages arrive.
        startSession: () => new Promise<void>((resolve) => {
          finish = () => { c.onServer({ v: 1, seq: ++n, type: 'session.ready', sessionId: 's', audio: fmt }); resolve(); };
        }),
      },
      audio,
    );
    c.setConnected(true);
    c.command('summon'); // starts the session
    assert.equal(c.inCall, true);
    c.hangUp(); // before the server has answered
    finish();
    await new Promise((r) => setTimeout(r, 5));
    c.onServer({ v: 1, seq: ++n, type: 'assistant.text.delta', turnId: 'turn-1', text: 'Hi there.' });
    c.onServer({ v: 1, seq: ++n, type: 'tts.start', ttsId: 't', turnId: 'turn-1', audio: fmt });
    c.onSpeech(new Uint8Array(960));
    assert.equal(c.state.reply, '', 'the greeting is not shown');
    assert.equal(audio.played, 0, 'and not played');
    assert.equal(c.inCall, false);
    assert.ok(sent.some((m) => m.type === 'interrupt'), 'the server is told to drop it');
    c.dispose();
  });

  it('inCall covers the gaps between turns, so the button does not flicker', () => {
    const t = scripted();
    t.active();
    assert.equal(t.c.inCall, false);
    t.c.command('summon');
    t.c.command('summon');
    t.server({ type: 'transcript.final', utteranceId: 'host-1', text: 'hello' });
    t.server({ type: 'tts.start', ttsId: 't', turnId: 'turn-1', audio: t.fmt });
    t.c.onSpeech(new Uint8Array(960)); // the speaker is still sounding
    t.server({ type: 'tts.end', ttsId: 't' }); // display is idle now, but the follow-up is due
    assert.equal(t.c.display, 'idle');
    assert.equal(t.c.inCall, true);
    t.c.dispose();
  });

  describe('wake phrase', () => {
    /** Hears the phrase whenever it is given a chunk that is exactly two bytes long. */
    const fakeWake = () => {
      const w = { fed: 0, resets: 0, feed(pcm: Uint8Array) { w.fed++; return pcm.byteLength === 2 ? 'HEY CRUZ' : undefined; }, reset() { w.resets++; } };
      return w satisfies WakeSource & { fed: number; resets: number };
    };
    const PHRASE = new Uint8Array(2);
    const woken = (extra: ConstructorParameters<typeof HostController>[2] = {}) => {
      const wake = fakeWake();
      const phrases: string[] = [];
      let now = 1_000_000;
      const t = scripted({ wake, onWake: (p) => phrases.push(p), now: () => now, ...extra });
      return { ...t, wake, phrases, advance: (ms: number) => { now += ms; } };
    };

    it('keeps the microphone open for the phrase only while connected, idle and not muted', () => {
      const t = woken();
      assert.deepEqual(t.audio.wakeCalls, [true], 'open as soon as it is connected and idle');
      t.c.toggleMute();
      assert.deepEqual(t.audio.wakeCalls, [true, false], 'muting closes the microphone');
      t.c.toggleMute();
      assert.deepEqual(t.audio.wakeCalls, [true, false, true]);
      t.c.setConnected(false);
      assert.equal(t.audio.wakeCalls.at(-1), false, 'closed when disconnected');
      t.c.dispose();
    });

    it('turning the phrase off closes the microphone at once, forgets the detector, and hears nothing after', () => {
      const t = woken();
      assert.equal(t.audio.wakeCalls.at(-1), true);
      t.c.disableWake();
      assert.equal(t.audio.wakeCalls.at(-1), false, 'the microphone is released');
      assert.equal(t.c.wakeListening, false);
      const fed = t.wake.fed;
      t.c.onMic(PHRASE);
      assert.equal(t.wake.fed, fed, 'nothing is checked any more');
      assert.deepEqual(t.phrases, [], 'and nothing wakes it');
      t.c.enableWake(t.wake);
      assert.equal(t.audio.wakeCalls.at(-1), true, 'it can be turned on again');
      t.c.dispose();
    });

    it('closes the microphone for the phrase during a call and reopens it when the call ends', () => {
      const t = woken();
      t.active();
      t.c.press(); // listening
      assert.equal(t.audio.wakeCalls.at(-1), false);
      t.c.hangUp();
      assert.equal(t.audio.wakeCalls.at(-1), true, 'back to listening for the phrase after hanging up');
      t.c.dispose();
    });

    it('starts a call when the phrase is heard, and tells the shell which phrase', async () => {
      const t = woken();
      t.c.onMic(PHRASE);
      assert.deepEqual(t.phrases, ['HEY CRUZ']);
      await Promise.resolve();
      assert.deepEqual(t.starts, [false], 'a first call opens the session, so the greeting plays');
      assert.equal(t.audio.wakeCalls.at(-1), false);
      t.c.dispose();
    });

    it('with a session already open, the phrase goes straight to the chime and listening', () => {
      const t = woken();
      t.active();
      t.c.onMic(PHRASE);
      assert.equal(t.c.display, 'listening');
      assert.deepEqual(t.starts, []);
      assert.ok(t.audio.calls.includes('chime:listening'));
      t.c.dispose();
    });

    it('does not hear the phrase while listening, thinking, speaking, muted or hung up', () => {
      const t = woken();
      t.active();
      t.c.press(); // listening: audio goes to the server, not to the detector
      const fed = t.wake.fed;
      t.c.onMic(PHRASE);
      assert.equal(t.wake.fed, fed);
      t.c.toggleMute();
      t.c.onMic(PHRASE);
      assert.equal(t.wake.fed, fed, 'muted');
      assert.deepEqual(t.phrases, []);
      t.c.dispose();
    });

    it('one phrase starts one call: a repeat within a moment is ignored', () => {
      const t = woken();
      t.active();
      t.c.onMic(PHRASE); // starts listening
      t.c.hangUp(); // back to waiting for the phrase straight away
      t.c.onMic(PHRASE);
      assert.deepEqual(t.phrases, ['HEY CRUZ'], 'still inside the cooldown');
      t.advance(2000);
      t.c.onMic(PHRASE);
      assert.deepEqual(t.phrases, ['HEY CRUZ', 'HEY CRUZ']);
      t.c.dispose();
    });

    it('forgets earlier audio each time it starts listening again, so a half-heard phrase does not carry over', () => {
      const t = woken();
      t.active();
      const before = t.wake.resets;
      t.c.press();
      t.c.hangUp();
      assert.ok(t.wake.resets > before);
      t.c.dispose();
    });

    it('skips the first moments of listening when the microphone was already open, so the chime is not heard as speech', () => {
      const sent: number[] = [];
      let now = 5_000_000;
      const c = new HostController(
        { send: () => undefined, sendMic: (p) => void sent.push(p.byteLength), startSession: async () => undefined },
        new FakeAudio(),
        { wake: fakeWake(), now: () => now },
      );
      c.setConnected(true);
      c.onServer({ v: 1, seq: 1, type: 'session.ready', sessionId: 's', audio: { encoding: 'pcm_s16le', sampleRate: 24000, channels: 1 } });
      c.press();
      c.onMic(new Uint8Array(960)); // the chime is still sounding
      now += 300;
      c.onMic(new Uint8Array(960));
      c.dispose();
      assert.deepEqual(sent, [960], 'only the audio after the chime was sent');
    });

    it('does nothing about the phrase without a wake source', () => {
      const t = scripted();
      assert.deepEqual(t.audio.wakeCalls, []);
      t.c.onMic(PHRASE);
      assert.equal(t.c.display, 'idle');
      t.c.dispose();
    });
  });

  it('a press with no session starts one, and a normal press afterwards does not', async () => {
    const t = scripted();
    t.c.command('summon');
    await Promise.resolve();
    assert.deepEqual(t.starts, [false]);
    t.active();
    t.c.command('summon');
    assert.deepEqual(t.starts, [false]);
    assert.equal(t.c.display, 'listening');
    t.c.dispose();
  });

  it('a quick second press while the session is still starting does not start another', async () => {
    const starts: boolean[] = [];
    let release!: () => void;
    const c = new HostController(
      { send: () => undefined, sendMic: () => undefined, startSession: (fresh) => { starts.push(fresh); return new Promise<void>((r) => (release = r)); } },
      new FakeAudio(),
    );
    c.setConnected(true);
    c.command('summon');
    c.command('summon');
    c.command('summon');
    assert.deepEqual(starts, [false], 'one session, not three');
    release();
    await new Promise((r) => setTimeout(r, 5));
    c.dispose();
  });

  it('shows why a session could not start, and does not open the microphone', async () => {
    const t = scripted();
    t.fail(new Error('Could not reach the voice server'));
    t.c.command('summon');
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(t.c.state.lastError?.code, 'SESSION');
    assert.equal(t.audio.calls.includes('start'), false);
    t.c.dispose();
  });

  it('does nothing while disconnected', () => {
    const t = scripted();
    t.c.setConnected(false);
    t.c.command('summon');
    assert.deepEqual(t.starts, []);
    assert.equal(t.audio.calls.includes('start'), false);
    t.c.dispose();
  });

  it('microphone frames only travel while listening', () => {
    const sent: number[] = [];
    const c = new HostController(
      { send: () => undefined, sendMic: (p) => void sent.push(p.byteLength), startSession: async () => undefined },
      new FakeAudio(),
    );
    c.setConnected(true);
    c.onServer({ v: 1, seq: 1, type: 'session.ready', sessionId: 's', audio: { encoding: 'pcm_s16le', sampleRate: 24000, channels: 1 } });
    c.onMic(new Uint8Array(960)); // before the press
    c.command('summon');
    c.onMic(new Uint8Array(960)); // while listening
    c.command('summon');
    c.onMic(new Uint8Array(960)); // after the second press
    c.dispose();
    assert.deepEqual(sent, [960]);
  });

  it('stops showing "thinking" when the server never answers a silent utterance', async () => {
    const t = scripted({ noResponseMs: 30 });
    t.active();
    t.c.command('summon');
    t.c.command('summon');
    assert.equal(t.c.display, 'thinking');
    await until(() => t.c.display === 'idle', 1000);
    assert.equal(t.c.state.lastError?.code, 'NO_SPEECH');
    t.c.dispose();
  });

  it('does not give up on a slow answer once speech was recognised', async () => {
    const t = scripted({ noResponseMs: 30 });
    t.active();
    t.c.command('summon');
    t.c.command('summon');
    t.server({ type: 'transcript.final', utteranceId: 'host-1', text: 'hello' });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(t.c.display, 'thinking');
    t.c.dispose();
  });

  it('ends listening by itself when the person stops talking, and drops it when nothing is said', () => {
    const t = scripted({ endpoint: new EndpointDetector() });
    t.active();
    t.c.command('summon');
    for (let i = 0; i < 30; i++) t.c.onLevel(0.08);
    for (let i = 0; i < 22; i++) t.c.onLevel(0.003);
    assert.equal(t.c.display, 'listening', 'not yet: under 0.9 s of quiet');
    t.c.onLevel(0.003);
    assert.equal(t.c.display, 'thinking');
    assert.deepEqual(t.sent.map((m) => m.type), ['input.end']);
    t.server({ type: 'error', code: 'PROVIDER_ERROR', message: 'x', retryable: true });

    t.sent.length = 0;
    t.c.command('summon');
    for (let i = 0; i < 210; i++) t.c.onLevel(0.003);
    assert.equal(t.c.state.lastError?.code, 'NO_SPEECH');
    assert.deepEqual(t.sent.map((m) => m.type), ['input.end']);
    t.c.dispose();
  });

  it('without a detector, only a press ends listening', () => {
    const t = scripted();
    t.active();
    t.c.command('summon');
    for (let i = 0; i < 400; i++) t.c.onLevel(0.003);
    assert.equal(t.c.display, 'listening');
    t.c.dispose();
  });
});
