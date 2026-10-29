import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { ClientMessage, ServerMessage } from '@cruzclaw/voice-core';
import { EndpointDetector } from '@cruzclaw/windows-bridge';
import { RuleReasoner, ScriptedTranscriber, type Synthesizer } from '@cruzclaw/voice-server';
import { createDemoServer, type DemoServer } from '../../demo-server/src/server.js';
import { VoiceClient } from '../src/client.js';
import { StaticConnection } from '../src/connection.js';
import { HostController, type AudioDevice, type ChimeKind, type Link } from '../src/controller.js';
import { DeviceSpeech, SPEECH_FORMAT } from '../src/device-speech.js';
import type { Endpoint, FromSpeech, ToSpeech } from '../src/speech-protocol.js';
import { SpeechClient, type SpeechChild } from '../src/speech-client.js';
import { serveSpeech, type Voice } from '../src/speech-server.js';

const until = async (pred: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
};
const tick = () => new Promise((r) => setTimeout(r, 15));

/** One chunk per piece of text, filled with the piece's length so a test can tell the pieces apart. */
function fakeSynth(log: string[], opts: { gate?: Promise<void>; fail?: (text: string) => boolean; chunks?: number } = {}) {
  return async function* (text: string, signal: AbortSignal): AsyncIterable<Uint8Array> {
    log.push(text);
    await opts.gate;
    if (opts.fail?.(text)) throw new Error('voice crashed');
    for (let i = 0; i < (opts.chunks ?? 1); i++) {
      if (signal.aborted) return;
      yield new Uint8Array(2).fill(text.length);
      await new Promise((r) => setTimeout(r, 2));
    }
  };
}

const delta = (turnId: string, text: string): ServerMessage => ({ v: 1, seq: 1, type: 'assistant.text.delta', turnId, text });
const done = (turnId: string): ServerMessage => ({ v: 1, seq: 1, type: 'assistant.text.done', turnId });

function deviceSpeech(opts: Parameters<typeof fakeSynth>[1] = {}) {
  const spoken: string[] = [];
  const events: string[] = [];
  const played: number[] = [];
  const errors: unknown[] = [];
  const speech = new DeviceSpeech({
    synthesize: fakeSynth(spoken, opts),
    emit: (m) => events.push(m.type),
    play: (pcm) => played.push(pcm[0]!),
    onError: (e) => errors.push(e),
    // The audio window's report is the test's to make, so Speaking is only said when a test says sound began.
    audibleTimeoutMs: 60_000,
  });
  speech.reset(true);
  return { speech, spoken, events, played, errors };
}

describe('DeviceSpeech', () => {
  it('starts speaking at the end of the first sentence, without waiting for the rest of the reply', async () => {
    const t = deviceSpeech();
    t.speech.onMessage(delta('t1', 'The status is good'));
    await tick();
    assert.deepEqual(t.spoken, [], 'half a sentence is not spoken');
    t.speech.onMessage(delta('t1', '. Two tasks are done'));
    await until(() => t.spoken.length === 1);
    assert.equal(t.spoken[0], 'The status is good.');
    await until(() => t.played.length === 1);
    await tick();
    assert.equal(t.events.length, 0, 'handed to the speaker is not yet heard');
    t.speech.onAudible();
    assert.deepEqual(t.events, ['tts.start']);
    assert.equal(t.events.includes('tts.end'), false, 'the first sentence is out, but the reply is not finished');

    t.speech.onMessage(delta('t1', ' and one is waiting. '));
    t.speech.onMessage(done('t1'));
    await until(() => t.events.includes('tts.end'));
    assert.deepEqual(t.spoken, ['The status is good.', 'Two tasks are done and one is waiting.']);
    assert.deepEqual(t.events, ['tts.start', 'tts.end']);
  });

  it('speaks a reply that arrives whole, such as the greeting, and speaks the last sentence even without a full stop', async () => {
    const t = deviceSpeech();
    t.speech.onMessage(delta('t1', "Hi Dana, I'm listening. How can I help?"));
    t.speech.onMessage(done('t1'));
    await until(() => t.events.includes('tts.end'));
    assert.deepEqual(t.spoken, ["Hi Dana, I'm listening.", 'How can I help?']);
  });

  it('keeps a figure such as 3.5 in one piece, because there is no space after its stop', async () => {
    const t = deviceSpeech();
    t.speech.onMessage(delta('t1', 'It costs 3.5 dollars. Done'));
    t.speech.onMessage(done('t1'));
    await until(() => t.events.includes('tts.end'));
    assert.deepEqual(t.spoken, ['It costs 3.5 dollars.', 'Done']);
  });

  it('says nothing and reports nothing when there is nothing to say', async () => {
    const t = deviceSpeech();
    t.speech.onMessage(delta('t1', '  ... '));
    t.speech.onMessage(done('t1'));
    await tick();
    assert.deepEqual(t.spoken, []);
    assert.deepEqual(t.events, []);
  });

  it('does nothing until a session says the device speaks, and again after one says it does not', async () => {
    const t = deviceSpeech();
    t.speech.reset(false);
    t.speech.onMessage(delta('t1', 'Hello there.'));
    t.speech.onMessage(done('t1'));
    await tick();
    assert.deepEqual(t.spoken, []);
    t.speech.reset(true);
    t.speech.onMessage(delta('t2', 'Hello there.'));
    t.speech.onMessage(done('t2'));
    await until(() => t.events.includes('tts.end'));
    t.speech.reset(false);
    t.speech.onMessage(delta('t3', 'Again.'));
    t.speech.onMessage(done('t3'));
    await tick();
    assert.deepEqual(t.spoken, ['Hello there.']);
  });

  it('cancel stops at once: no more pieces, no more audio, and no end is reported for the cut-off reply', async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const t = deviceSpeech({ gate });
    t.speech.onMessage(delta('t1', 'First sentence. Second sentence. Third'));
    await until(() => t.spoken.length === 1);
    t.speech.cancel();
    open();
    await tick();
    await tick();
    assert.deepEqual(t.spoken, ['First sentence.'], 'the queued pieces were dropped');
    assert.deepEqual(t.played, [], 'nothing from the cut-off piece reached the speaker');
    t.speech.onMessage(done('t1'));
    await tick();
    assert.equal(t.events.includes('tts.end'), false);
  });

  it('does not play audio that a slow voice produces after the cut, even if the voice ignores the cancel', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const played: number[] = [];
    const events: string[] = [];
    const speech = new DeviceSpeech({
      async *synthesize() {
        await gate;
        yield new Uint8Array(2); // produced after the cut, whatever the signal says
        yield new Uint8Array(2);
      },
      emit: (m) => events.push(m.type),
      play: (pcm) => played.push(pcm.length),
    });
    speech.reset(true);
    speech.onMessage(delta('t1', 'Hello there.'));
    speech.onMessage(done('t1'));
    await tick();
    speech.cancel();
    release();
    await tick();
    await tick();
    assert.deepEqual(played, []);
    assert.deepEqual(events, [], 'no sound was ever made, so Speaking was never shown for it');
  });

  it('shows Speaking only when the speaker says sound has begun: not while the first chunk is made, and not when it is only handed over', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const order: string[] = [];
    let speakerBusy = true;
    const speech = new DeviceSpeech({
      async *synthesize() {
        await gate; // the slow first chunk: loading the voice, or making the first sentence
        yield new Uint8Array(2);
      },
      emit: (m) => order.push(m.type),
      play: () => order.push('play'),
      audibleTimeoutMs: 60_000,
      isPlaying: () => speakerBusy,
      quietTimeoutMs: 60_000,
    });
    speech.reset(true);
    speech.onMessage(delta('t1', 'Hello there.'));
    speech.onMessage(done('t1'));
    await tick();
    await tick();
    assert.equal(order.length, 0, 'while it is being made, nothing says Speaking');

    release();
    await until(() => order.includes('play'));
    await tick();
    assert.deepEqual(order, ['play'], 'handed to the speaker, but nothing is audible yet');

    speech.onAudible();
    assert.deepEqual(order, ['play', 'tts.start'], 'Speaking comes when the speaker says sound began');
    speakerBusy = false;
    speech.onQuiet();
    assert.deepEqual(order, ['play', 'tts.start', 'tts.end']);
  });

  it('never says Speaking when the speaker does not confirm sound: playback has failed, and that is said', async () => {
    const order: string[] = [];
    const failures: string[] = [];
    const speech = new DeviceSpeech({
      async *synthesize() { yield new Uint8Array(2); },
      emit: (m) => order.push(m.type),
      play: () => order.push('play'),
      audibleTimeoutMs: 40,
      isPlaying: () => true,
      quietTimeoutMs: 60_000,
      onPlaybackFailed: (reason) => failures.push(reason),
    });
    speech.reset(true);
    speech.onMessage(delta('t1', 'Hello there.'));
    speech.onMessage(done('t1'));
    await tick();
    assert.deepEqual(order, ['play']);
    await until(() => failures.length === 1, 1000);
    await tick();

    assert.deepEqual(order, ['play'], 'no Speaking, and no end of a reply that was never heard');
    assert.match(failures[0]!, /did not confirm any sound/);
  });

  it('says playback failed at once when the audio window says it cannot play, and never says Speaking', async () => {
    const order: string[] = [];
    const failures: string[] = [];
    const speech = new DeviceSpeech({
      async *synthesize() { yield new Uint8Array(2); },
      emit: (m) => order.push(m.type),
      play: () => order.push('play'),
      audibleTimeoutMs: 60_000,
      isPlaying: () => true,
      quietTimeoutMs: 60_000,
      onPlaybackFailed: (reason) => failures.push(reason),
    });
    speech.reset(true);
    speech.onMessage(delta('t1', 'Hello there.'));
    speech.onMessage(done('t1'));
    await tick();
    speech.onFailed('the audio output is suspended');

    assert.deepEqual(failures, ['the audio output is suspended']);
    assert.deepEqual(order, ['play']);
    speech.onAudible(); // a late confirmation after the failure changes nothing
    speech.onQuiet();
    assert.deepEqual(order, ['play']);
  });

  it('drops the rest of a reply whose playback failed, and speaks the next reply normally', async () => {
    const order: string[] = [];
    const failures: string[] = [];
    const speech = new DeviceSpeech({
      async *synthesize() { yield new Uint8Array(2); },
      emit: (m) => order.push(m.type),
      play: () => order.push('play'),
      audibleTimeoutMs: 60_000,
      isPlaying: () => true,
      quietTimeoutMs: 60_000,
      onPlaybackFailed: (reason) => failures.push(reason),
    });
    speech.reset(true);
    speech.onMessage(delta('t1', 'First sentence. Second sentence. '));
    await tick();
    const handedOver = order.filter((x) => x === 'play').length;
    speech.onFailed('the audio output is suspended');
    speech.onMessage(delta('t1', 'Third sentence. '));
    speech.onMessage(done('t1'));
    await tick();
    assert.equal(order.filter((x) => x === 'play').length, handedOver, 'what is still streaming in for the failed reply is not spoken');

    speech.onMessage(delta('t2', 'A new reply. '));
    speech.onMessage(done('t2'));
    await tick();
    assert.equal(order.filter((x) => x === 'play').length, handedOver + 1, 'the next reply is tried again');
    speech.onAudible();
    assert.ok(order.includes('tts.start'));
  });

  it('ignores a failure report when sound already began, or when nothing is waiting', async () => {
    const failures: string[] = [];
    const t = deviceSpeech();
    const speech = new DeviceSpeech({
      async *synthesize() { yield new Uint8Array(2); },
      emit: (m) => t.events.push(m.type),
      play: () => undefined,
      audibleTimeoutMs: 60_000,
      isPlaying: () => true,
      quietTimeoutMs: 60_000,
      onPlaybackFailed: (reason) => failures.push(reason),
    });

    speech.reset(true);
    speech.onFailed('nothing is waiting');
    speech.onMessage(delta('t1', 'Hello there.'));
    speech.onMessage(done('t1'));
    await tick();
    speech.onAudible();
    speech.onFailed('too late: sound already began');

    assert.deepEqual(failures, []);
    assert.deepEqual(t.events, ['tts.start']);
  });

  it('ends the reply only when the speaker is quiet, not when the last sentence has been made', async () => {
    const order: string[] = [];
    let playing = true;
    const speech = new DeviceSpeech({
      async *synthesize() { yield new Uint8Array(2); },
      emit: (m) => order.push(m.type),
      play: () => order.push('play'),
      audibleTimeoutMs: 60_000,
      isPlaying: () => playing,
      quietTimeoutMs: 60_000,
    });
    speech.reset(true);
    speech.onMessage(delta('t1', 'Hello there.'));
    speech.onMessage(done('t1'));
    await tick();
    speech.onAudible();
    await tick();
    assert.deepEqual(order, ['play', 'tts.start'], 'everything is made, but the speaker is still playing it');

    playing = false;
    speech.onQuiet();
    assert.deepEqual(order, ['play', 'tts.start', 'tts.end']);
  });

  it('opens before it closes even when the speaker goes quiet before it ever reported sound', async () => {
    const order: string[] = [];
    const speech = new DeviceSpeech({
      async *synthesize() { yield new Uint8Array(2); },
      emit: (m) => order.push(m.type),
      play: () => order.push('play'),
      audibleTimeoutMs: 60_000,
      isPlaying: () => true,
      quietTimeoutMs: 60_000,
    });
    speech.reset(true);
    speech.onMessage(delta('t1', 'Hi.'));
    speech.onMessage(done('t1'));
    await tick();
    speech.onQuiet(); // a very short sound that was over before its start was reported

    assert.deepEqual(order, ['play', 'tts.start', 'tts.end']);
  });

  it('ignores a report of sound or quiet that belongs to nothing: no reply waiting, or one that was cut off', async () => {
    const t = deviceSpeech();

    t.speech.onAudible();
    t.speech.onQuiet();
    assert.equal(t.events.length, 0);

    t.speech.onMessage(delta('t1', 'Hello there. And more'));
    await until(() => t.played.length === 1);
    t.speech.cancel(); // cut off before sound was reported
    t.speech.onAudible();
    t.speech.onQuiet();
    await tick();

    assert.equal(t.events.length, 0, 'neither Speaking nor an end for a reply that was cut off');
  });

  it('a report of sound for the cut-off reply never marks the next reply as started', async () => {
    const t = deviceSpeech();

    t.speech.onMessage(delta('t1', 'First reply. More'));
    await until(() => t.played.length === 1);
    t.speech.cancel();
    t.speech.onMessage(delta('t2', 'Second reply. More'));
    await until(() => t.played.length === 2);
    assert.equal(t.events.length, 0);

    t.speech.onAudible(); // this one is for the second reply, whose sound is awaited
    assert.deepEqual(t.events, ['tts.start']);
  });

  it('a reply that made no sound closes without ever having said Speaking, so the follow-up logic still sees it end', async () => {
    const order: string[] = [];
    const speech = new DeviceSpeech({
      async *synthesize() {
        // nothing to say aloud
      },
      emit: (m) => order.push(m.type),
      play: () => order.push('play'),
    });
    speech.reset(true);
    speech.onMessage(delta('t1', 'Hello there.'));
    speech.onMessage(done('t1'));
    await until(() => order.includes('tts.end'));
    assert.deepEqual(order, ['tts.end']);
  });

  it('a reply that follows a cut-off one is spoken even while the old one is still unwinding', async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const t = deviceSpeech({ gate });
    t.speech.onMessage(delta('t1', 'Old reply. '));
    await until(() => t.spoken.length === 1);
    t.speech.cancel(); // the old piece is still waiting on the gate
    t.speech.onMessage(delta('t2', 'New reply.'));
    t.speech.onMessage(done('t2'));
    open();
    await until(() => t.events.includes('tts.end'));
    assert.deepEqual(t.spoken, ['Old reply.', 'New reply.']);
    assert.equal(t.events.filter((e) => e === 'tts.end').length, 1);
  });

  it('a new reply replaces one that was still being spoken', async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const t = deviceSpeech({ gate });
    t.speech.onMessage(delta('t1', 'Old one. Old two. Old three.'));
    await until(() => t.spoken.length === 1);
    t.speech.onMessage(delta('t2', 'Fresh.'));
    t.speech.onMessage(done('t2'));
    open();
    await until(() => t.events.includes('tts.end'));
    assert.deepEqual(t.spoken, ['Old one.', 'Fresh.']);
  });

  it('when the voice fails, reports it, and still ends the reply so the call can go on', async () => {
    const t = deviceSpeech({ fail: () => true });
    t.speech.onMessage(delta('t1', 'Hello there.'));
    t.speech.onMessage(done('t1'));
    await until(() => t.events.includes('tts.end'));
    assert.equal(t.errors.length, 1);
    assert.deepEqual(t.events, ['tts.end'], 'nothing was heard, so it never said Speaking');
  });
});

/** A pair of in-memory endpoints standing in for the two ends of the process channel. */
function channel() {
  const toChild: Array<(m: ToSpeech) => void> = [];
  const toParent: Array<(m: FromSpeech) => void> = [];
  const exits: Array<() => void> = [];
  const log: ToSpeech[] = [];
  const parent: Endpoint<ToSpeech, FromSpeech> = {
    post: (m) => { log.push(m); queueMicrotask(() => toChild.forEach((l) => l(m))); },
    onMessage: (l) => void toParent.push(l),
  };
  const child: Endpoint<FromSpeech, ToSpeech> = {
    post: (m) => queueMicrotask(() => toParent.forEach((l) => l(m))),
    onMessage: (l) => void toChild.push(l),
  };
  return { parent, child, log, exit: () => exits.forEach((l) => l()), onExit: (l: () => void) => void exits.push(l) };
}

function speechProcess(voice: Voice) {
  const children: Array<ReturnType<typeof channel>> = [];
  let killed = 0;
  const client = new SpeechClient(() => {
    const c = channel();
    serveSpeech(c.child, voice);
    children.push(c);
    const process: SpeechChild = { endpoint: c.parent, onExit: c.onExit, kill: () => void killed++ };
    return process;
  });
  return { client, children, killed: () => killed };
}

const toneVoice = (opts: { chunks?: number; fail?: boolean; warm?: () => Promise<void> } = {}): Voice => ({
  async *synthesize(text, format, signal) {
    assert.deepEqual(format, SPEECH_FORMAT);
    if (opts.fail) throw new Error('model missing');
    for (let i = 0; i < (opts.chunks ?? 3); i++) {
      if (signal.aborted) return;
      yield new Uint8Array(2).fill(text.length);
      await new Promise((r) => setTimeout(r, 3));
    }
  },
  ...(opts.warm ? { warmUp: opts.warm } : {}),
});

describe('the speech process', () => {
  it('makes speech in chunks and ends the request', async () => {
    const p = speechProcess(toneVoice({ chunks: 3 }));
    const out: number[] = [];
    for await (const chunk of p.client.synthesize('hello', new AbortController().signal)) out.push(chunk[0]!);
    assert.deepEqual(out, [5, 5, 5]);
  });

  it('starts the process only when it is first needed', async () => {
    const p = speechProcess(toneVoice());
    assert.equal(p.children.length, 0);
    for await (const _ of p.client.synthesize('a', new AbortController().signal));
    assert.equal(p.children.length, 1);
    for await (const _ of p.client.synthesize('b', new AbortController().signal));
    assert.equal(p.children.length, 1, 'one process serves every request');
  });

  it('keeps two requests apart', async () => {
    const p = speechProcess(toneVoice({ chunks: 2 }));
    const run = async (text: string) => {
      const out: number[] = [];
      for await (const c of p.client.synthesize(text, new AbortController().signal)) out.push(c[0]!);
      return out;
    };
    const [a, b] = await Promise.all([run('aa'), run('bbbb')]);
    assert.deepEqual(a, [2, 2]);
    assert.deepEqual(b, [4, 4]);
  });

  it('cancelling stops the work in the process and returns quietly', async () => {
    const p = speechProcess(toneVoice({ chunks: 200 }));
    const controller = new AbortController();
    let got = 0;
    for await (const _ of p.client.synthesize('long', controller.signal)) {
      if (++got === 2) controller.abort();
    }
    assert.ok(got < 10, `stopped early, got ${got}`);
    await until(() => p.children[0]!.log.some((m) => m.type === 'cancel'));
  });

  it('the process stops sending the moment a request is cancelled, and never reports it done', async () => {
    const sent: FromSpeech[] = [];
    let deliver!: (m: ToSpeech) => void;
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    serveSpeech(
      { post: (m) => void sent.push(m), onMessage: (l) => void (deliver = l) },
      {
        async *synthesize() {
          yield new Uint8Array(2);
          await hold;
          yield new Uint8Array(2); // made after the cancel
          yield new Uint8Array(2);
        },
      },
    );
    deliver({ type: 'speak', id: 7, text: 'x' });
    await until(() => sent.length === 1);
    deliver({ type: 'cancel', id: 7 });
    release();
    await tick();
    await tick();
    assert.deepEqual(sent.map((m) => m.type), ['chunk']);
  });

  it('a request that is already cancelled never reaches the process', async () => {
    const p = speechProcess(toneVoice());
    const controller = new AbortController();
    controller.abort();
    for await (const _ of p.client.synthesize('x', controller.signal));
    assert.equal(p.children.length, 0);
  });

  it('reports a voice error, and the next request still works', async () => {
    let fail = true;
    const p = speechProcess({
      async *synthesize(text) {
        if (fail) throw new Error('model missing');
        yield new Uint8Array(2).fill(text.length);
      },
    });
    await assert.rejects(async () => { for await (const _ of p.client.synthesize('x', new AbortController().signal)); }, /model missing/);
    fail = false;
    const out: number[] = [];
    for await (const c of p.client.synthesize('abc', new AbortController().signal)) out.push(c[0]!);
    assert.deepEqual(out, [3]);
  });

  it('if the process dies mid-request the request fails, and the next one starts a new process', async () => {
    const p = speechProcess(toneVoice({ chunks: 200 }));
    let thrown: unknown;
    try {
      let got = 0;
      for await (const _ of p.client.synthesize('long', new AbortController().signal)) {
        if (++got === 2) p.children[0]!.exit();
      }
    } catch (e) {
      thrown = e;
    }
    assert.match(String((thrown as Error)?.message), /stopped/);
    const out: number[] = [];
    for await (const c of p.client.synthesize('ab', new AbortController().signal)) out.push(c[0]!);
    assert.equal(p.children.length, 2, 'a second process was started');
    assert.equal(out.length > 0, true);
  });

  it('warm-up loads the voice and says whether it worked', async () => {
    const ok = speechProcess(toneVoice({ warm: async () => undefined }));
    assert.equal(await ok.client.warmUp(), true);
    const bad = speechProcess(toneVoice({ warm: async () => { throw new Error('download failed'); } }));
    assert.equal(await bad.client.warmUp(), false);
  });

  it('dispose stops the process and fails what was waiting', async () => {
    const p = speechProcess(toneVoice({ chunks: 500 }));
    const failure = (async () => {
      try { for await (const _ of p.client.synthesize('long', new AbortController().signal)); } catch (e) { return e as Error; }
      return undefined;
    })();
    await until(() => p.children.length === 1);
    p.client.dispose();
    assert.match(String((await failure)?.message), /stopped/);
    assert.equal(p.killed(), 1);
  });
});

describe('a host that can speak, talking to a server that does not honour text-only', () => {
  const setup = () => {
    const spoken: string[] = [];
    const played: number[] = [];
    const audio = { startCapture() {}, stopCapture() {}, play: (p: Uint8Array) => void played.push(p.length), stopPlayback() {}, isPlaying: () => false, chime() {}, listenForWake() {} };
    const c = new HostController({ send() {}, sendMic() {}, startSession: async () => undefined }, audio, { speak: fakeSynth(spoken) });
    c.setConnected(true);
    let n = 0;
    const server = (m: object) => c.onServer({ v: 1, seq: ++n, ...m } as ServerMessage);
    const fmt = { encoding: 'pcm_s16le', sampleRate: 24000, channels: 1 };
    return { c, spoken, played, server, fmt };
  };

  for (const speech of [undefined, 'server', 'none'] as const) {
    it(`stays quiet when the session says speech is ${speech ?? 'not mentioned'}, so the server's own voice is the only one`, async () => {
      const t = setup();
      t.server({ type: 'session.ready', sessionId: 's', audio: t.fmt, ...(speech ? { speech } : {}) });
      t.server({ type: 'assistant.text.delta', turnId: 'turn-1', text: 'Hello there. How are you?' });
      t.server({ type: 'assistant.text.done', turnId: 'turn-1' });
      await tick();
      await tick();
      assert.deepEqual(t.spoken, []);
      assert.deepEqual(t.played, []);
      t.c.dispose();
    });
  }

  it('speaks when the session says the device speaks', async () => {
    const t = setup();
    t.server({ type: 'session.ready', sessionId: 's', audio: t.fmt, speech: 'device' });
    t.server({ type: 'assistant.text.delta', turnId: 'turn-1', text: 'Hello there.' });
    t.server({ type: 'assistant.text.done', turnId: 'turn-1' });
    await until(() => t.played.length > 0);
    assert.deepEqual(t.spoken, ['Hello there.']);
    t.c.dispose();
  });
});

/** Speaker that keeps sounding for a short while after the last chunk, like the real one. */
class FakeAudio implements AudioDevice {
  calls: string[] = [];
  played = 0;
  busy = false;
  onDrained: (() => void) | undefined;
  /** Like the audio window: sound begins a moment after the first chunk is handed over, unless playback was stopped. */
  onStarted: (() => void) | undefined;
  /** When set, the audio window cannot play: it reports a failure instead of sound beginning. */
  failWith: string | undefined;
  onFailed: ((reason: string) => void) | undefined;
  private stops = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  startCapture() { this.calls.push('start'); }
  stopCapture() { this.calls.push('stop'); }
  play(pcm: Uint8Array) {
    this.played += pcm.byteLength;
    if (!this.busy) {
      const mine = this.stops;
      setTimeout(() => {
        if (this.stops !== mine) return;
        if (this.failWith) this.onFailed?.(this.failWith);
        else this.onStarted?.();
      }, 15);
    }
    this.busy = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.busy = false; this.onDrained?.(); }, 60);
  }
  stopPlayback() { this.calls.push('stopPlayback'); this.stops++; this.busy = false; clearTimeout(this.timer); }
  isPlaying() { return this.busy; }
  chime(kind: ChimeKind) { this.calls.push(`chime:${kind}`); }
  listenForWake() { /* not used here */ }
}

/** If the server ever tries to speak, this counts it. */
class CountingSynth implements Synthesizer {
  calls = 0;
  async *synthesize(): AsyncIterable<Uint8Array> {
    this.calls++;
    yield new Uint8Array(960);
  }
}

describe('speaking on the device, end to end against the demo server', () => {
  let demo: DemoServer;
  let port: number;
  const serverVoice = new CountingSynth();

  before(async () => {
    demo = createDemoServer({
      accounts: [{ token: 'good', tenantKey: 'on', features: { voiceEnabled: true }, displayName: 'Dana' }],
      providers: { transcriber: new ScriptedTranscriber(['What is the status']), reasoner: new RuleReasoner(), synthesizer: serverVoice },
      workerIntervalMs: 10,
    });
    port = await demo.listen(0);
  });
  after(() => demo.close());

  function host(opts: { gate?: Promise<void>; speak?: boolean } = {}) {
    const audio = new FakeAudio();
    const seen: ServerMessage[] = [];
    const sent: ClientMessage[] = [];
    const startModes: Array<'device' | undefined> = [];
    const spoken: string[] = [];
    const serverAudio = { frames: 0 };
    let controller!: HostController;
    let client!: VoiceClient;
    const link: Link = {
      send: (m) => { sent.push(m); client.send(m); },
      sendMic: (pcm) => client.sendMic(pcm),
      startSession: async (_fresh, speech) => { startModes.push(speech); await client.startSession('conv-device', speech); },
    };
    client = new VoiceClient(new StaticConnection(`ws://127.0.0.1:${port}`, 'good'), {
      onMessage: (m) => { seen.push(m); controller.onServer(m); },
      onSpeech: (pcm) => { serverAudio.frames++; controller.onSpeech(pcm); },
      onClose: () => controller.setConnected(false),
    });
    controller = new HostController(link, audio, {
      endpoint: new EndpointDetector(),
      ...(opts.speak === false ? {} : { speak: fakeSynth(spoken, { ...(opts.gate ? { gate: opts.gate } : {}), chunks: 4 }) }),
    });
    audio.onDrained = () => controller.onPlaybackDrained();
    audio.onStarted = () => controller.onPlaybackStarted();
    audio.onFailed = (reason) => controller.onPlaybackFailed(reason);
    return { audio, seen, sent, startModes, spoken, serverAudio, controller, open: async () => { await client.openConnection(); controller.setConnected(true); }, close: () => { controller.dispose(); client.close(); } };
  }
  const talk = (c: HostController) => {
    for (let i = 0; i < 30; i++) { c.onMic(new Uint8Array(960)); c.onLevel(0.08); }
    for (let i = 0; i < 25; i++) { c.onMic(new Uint8Array(960)); c.onLevel(0.003); }
  };
  const types = (h: { seen: ServerMessage[] }) => h.seen.map((m) => m.type);

  it('asks for text only, speaks the greeting itself, and then listens', async () => {
    const before = serverVoice.calls;
    const h = host();
    await h.open();
    h.controller.command('summon');
    await until(() => h.controller.display === 'listening');
    assert.deepEqual(h.startModes, ['device']);
    const ready = h.seen.find((m) => m.type === 'session.ready') as Extract<ServerMessage, { type: 'session.ready' }>;
    assert.equal(ready.speech, 'device');
    assert.deepEqual(h.spoken, ["Hi Dana, I'm listening.", 'How can I help?']);
    assert.ok(h.audio.played > 0, 'the greeting reached the speaker');
    assert.equal(h.serverAudio.frames, 0, 'the server sent no audio');
    assert.equal(serverVoice.calls, before, 'the server never made speech');
    assert.equal(types(h).some((t) => t.startsWith('tts.')), false, 'the server sent no tts messages');
    // The microphone opened only after the greeting had been heard, as before.
    assert.deepEqual(h.audio.calls.filter((c) => c !== 'stopPlayback' && c !== 'stop'), ['chime:listening', 'start']);
    h.close();
  });

  it('answers a question out loud from the streamed text, then listens for a follow-up', async () => {
    const h = host();
    await h.open();
    h.controller.command('summon');
    await until(() => h.controller.display === 'listening');
    const greetingBytes = h.audio.played;
    talk(h.controller);
    assert.equal(h.controller.display, 'thinking');
    await until(() => h.audio.played > greetingBytes);
    assert.ok(h.controller.state.reply.length > 0);
    await until(() => h.controller.display === 'listening'); // follow-up window
    assert.equal(h.serverAudio.frames, 0);
    assert.ok(h.spoken.length >= 3, `spoke ${h.spoken.join(' | ')}`);
    h.close();
  });

  it('while the first sound is still being made it says thinking, not speaking, and pressing then cuts the reply off and listens', async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const h = host({ gate });
    await h.open();
    h.controller.command('summon');
    await until(() => h.spoken.length >= 1);
    assert.notEqual(h.controller.display, 'speaking', 'nothing is audible yet');
    h.controller.command('summon'); // cut in
    assert.equal(h.controller.display, 'listening');
    assert.ok(h.audio.calls.includes('stopPlayback'));
    // The greeting is not a turn the server is still working on, so there is nothing for the server to cancel.
    const playedAtCut = h.audio.played;
    const piecesAtCut = h.spoken.length;
    open();
    await tick();
    await tick();
    assert.equal(h.audio.played, playedAtCut, 'nothing more was played after the cut');
    assert.equal(h.spoken.length, piecesAtCut, 'the rest of the reply was not even made');
    assert.equal(h.controller.display, 'listening');
    h.close();
  });

  it('when the audio window cannot play, the person is told, nothing ever says Speaking, and nothing listens by itself afterwards', async () => {
    const h = host();
    const seen = new Set<string>();

    h.audio.failWith = 'the audio output is suspended';
    await h.open();
    const watch = setInterval(() => seen.add(h.controller.display), 2);

    h.controller.command('summon');
    await until(() => h.controller.state.lastError?.code === 'PLAYBACK', 8000);
    await new Promise((resolve) => setTimeout(resolve, 150));
    clearInterval(watch);

    assert.equal(seen.has('speaking'), false, 'never shown as speaking');
    assert.match(h.controller.state.lastError!.message, /could not be played on this computer/);
    assert.notEqual(h.controller.display, 'listening', 'it does not open the microphone as if the reply had been heard');
    assert.ok(h.audio.calls.includes('stopPlayback'), 'what was scheduled is stopped, so nothing sounds late');
    h.close();
  });

  it('pressing while it is really speaking cuts the voice off and listens', async () => {
    const h = host();
    await h.open();
    h.controller.command('summon');
    await until(() => h.controller.display === 'speaking');
    assert.ok(h.audio.played >= 1, 'it says speaking only once sound has been handed to the speaker');
    h.controller.command('summon'); // cut in
    assert.equal(h.controller.display, 'listening');
    assert.ok(h.audio.calls.includes('stopPlayback'));
    h.close();
  });

  it('hanging up while it speaks silences the device voice', async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const h = host({ gate });
    await h.open();
    h.controller.command('summon');
    await until(() => h.spoken.length >= 1);
    h.controller.hangUp();
    open();
    await tick();
    await tick();
    assert.equal(h.audio.played, 0);
    assert.equal(h.controller.display, 'idle');
    h.close();
  });

  it('a host without a voice of its own still gets the server voice, as before', async () => {
    const before = serverVoice.calls;
    const h = host({ speak: false });
    await h.open();
    h.controller.command('summon');
    await until(() => h.controller.display === 'listening');
    assert.deepEqual(h.startModes, [undefined]);
    assert.ok(serverVoice.calls > before);
    assert.ok(h.serverAudio.frames > 0);
    h.close();
  });

  it('a voice that fails does not stop the call: the text is shown and listening goes on', async () => {
    const errors: unknown[] = [];
    const h = host();
    h.controller.state; // touch
    // Replace the voice with one that fails, on a second controller wired the same way.
    const audio = new FakeAudio();
    let client!: VoiceClient;
    let controller!: HostController;
    client = new VoiceClient(new StaticConnection(`ws://127.0.0.1:${port}`, 'good'), {
      onMessage: (m) => controller.onServer(m),
      onSpeech: (pcm) => controller.onSpeech(pcm),
      onClose: () => controller.setConnected(false),
    });
    controller = new HostController(
      { send: (m) => client.send(m), sendMic: (p) => client.sendMic(p), startSession: async (_f, speech) => client.startSession('c', speech) },
      audio,
      { speak: fakeSynth([], { fail: () => true }), onSpeechError: (e) => errors.push(e) },
    );
    audio.onDrained = () => controller.onPlaybackDrained();
    audio.onStarted = () => controller.onPlaybackStarted();
    audio.onFailed = (reason) => controller.onPlaybackFailed(reason);
    await client.openConnection();
    controller.setConnected(true);
    controller.command('summon');
    await until(() => controller.display === 'listening');
    assert.ok(errors.length >= 1);
    assert.equal(controller.state.reply.includes('Dana'), true, 'the greeting text was still shown');
    controller.dispose();
    client.close();
    h.close();
  });
});
