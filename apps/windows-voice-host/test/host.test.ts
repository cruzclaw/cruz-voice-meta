import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { ServerMessage } from '@cruzclaw/voice-core';
import type { Synthesizer } from '../../demo-server/src/ports.js';
import { RuleReasoner, ScriptedTranscriber } from '../../demo-server/src/mock-providers.js';
import { createDemoServer, type DemoServer } from '../../demo-server/src/server.js';
import { VoiceClient } from '../src/client.js';
import { HostController, type AudioDevice } from '../src/controller.js';

class FakeAudio implements AudioDevice {
  calls: string[] = [];
  played = 0;
  startCapture() { this.calls.push('start'); }
  stopCapture() { this.calls.push('stop'); }
  play(pcm: Uint8Array) { this.played += pcm.byteLength; }
  stopPlayback() { this.calls.push('stopPlayback'); }
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
      { token: 'good', tenantKey: 'on', features: { voiceEnabled: true } },
      { token: 'off', tenantKey: 'off', features: { voiceEnabled: false } },
    ],
    providers: { transcriber: new ScriptedTranscriber(['What is the status']), reasoner: new RuleReasoner(), synthesizer: new SlowSynth() },
    workerIntervalMs: 10,
  });
  port = await demo.listen(0);
});
after(() => demo.close());

function host(token: string) {
  const audio = new FakeAudio();
  const seen: ServerMessage[] = [];
  const closed: string[] = [];
  let controller!: HostController;
  const client = new VoiceClient(`ws://127.0.0.1:${port}`, token, {
    onMessage: (m) => { seen.push(m); controller.onServer(m); },
    onSpeech: (pcm) => controller.onSpeech(pcm),
    onClose: (reason) => { closed.push(reason); controller.setConnected(false); },
  });
  controller = new HostController(client, audio);
  return { audio, seen, closed, client, controller };
}

describe('Windows voice host against the demo server', () => {
  it('connects, listens on the first press, ends on the second, then plays the spoken reply', async () => {
    const h = host('good');
    await h.client.connect();
    h.controller.setConnected(true);
    assert.equal(h.controller.display, 'idle');

    h.controller.command('summon');
    assert.equal(h.controller.display, 'listening');
    assert.deepEqual(h.audio.calls, ['start']);
    for (let i = 0; i < 10; i++) h.controller.onMic(new Uint8Array(960));
    h.controller.command('summon');
    assert.equal(h.audio.calls.at(-1), 'stop');

    await until(() => h.seen.some((m) => m.type === 'tts.end'));
    assert.ok(h.audio.played > 0, 'speech frames reached the speaker');
    assert.equal(h.seen.find((m) => m.type === 'transcript.final')!.type, 'transcript.final');
    assert.equal(h.controller.display, 'idle');
    h.controller.dispose();
    h.client.close();
  });

  it('does not send microphone audio unless the person is being listened to', () => {
    const sent: number[] = [];
    const link = { send: () => undefined, sendMic: (pcm: Uint8Array) => void sent.push(pcm.byteLength) };
    const c = new HostController(link, new FakeAudio());
    c.setConnected(true);
    c.onMic(new Uint8Array(960)); // before the press
    c.command('summon');
    c.onMic(new Uint8Array(960)); // while listening
    c.command('summon');
    c.onMic(new Uint8Array(960)); // after the second press
    c.dispose();
    assert.deepEqual(sent, [960]);
  });

  it('a press while the assistant is speaking interrupts and stops playback at once', async () => {
    const h = host('good');
    await h.client.connect();
    h.controller.setConnected(true);
    h.controller.command('summon');
    for (let i = 0; i < 5; i++) h.controller.onMic(new Uint8Array(960));
    h.controller.command('summon');
    await until(() => h.controller.state.phase === 'speaking');
    h.controller.command('summon');
    assert.ok(h.audio.calls.includes('stopPlayback'));
    await until(() => h.seen.some((m) => m.type === 'tts.cancelled'));
    h.controller.dispose();
    h.client.close();
  });

  it('reports a wrong token without leaking it', async () => {
    const h = host('wrong-token-value');
    await assert.rejects(h.client.connect(), (e: Error) => {
      assert.match(e.message, /refused the connection \(HTTP 401\)/);
      assert.equal(e.message.includes('wrong-token-value'), false);
      return true;
    });
  });

  it('shows the feature as off when the account flag is off', async () => {
    const h = host('off');
    await assert.rejects(h.client.connect(), /FEATURE_DISABLED|closed/);
  });

  it('drops a turn and silences the speaker when the connection is lost', async () => {
    const h = host('good');
    await h.client.connect();
    h.controller.setConnected(true);
    h.controller.command('summon');
    h.client.close();
    await until(() => h.closed.length > 0);
    assert.equal(h.controller.display, 'disconnected');
    assert.equal(h.audio.calls.at(-1), 'stopPlayback');
    h.controller.dispose();
  });
});
