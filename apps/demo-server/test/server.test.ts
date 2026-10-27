import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import WebSocket from 'ws';
import { decodeAudioFrame, encodeAudioFrame, type ServerMessage } from '@cruzclaw/voice-core';
import { RuleReasoner, ScriptedTranscriber, ToneSynthesizer } from '../src/mock-providers.js';
import { createDemoServer, type DemoServer } from '../src/server.js';

const audio = { encoding: 'pcm_s16le', sampleRate: 16000, channels: 1 };
let demo: DemoServer;
let port: number;

before(async () => {
  demo = createDemoServer({
    accounts: [
      { token: 'token-on', tenantKey: 'on', features: { voiceEnabled: true }, displayName: 'Dana' },
      { token: 'token-off', tenantKey: 'off', features: { voiceEnabled: false } },
    ],
    providers: {
      transcriber: new ScriptedTranscriber(['Please draft an email to Maria']),
      reasoner: new RuleReasoner(),
      synthesizer: new ToneSynthesizer(),
    },
    workerIntervalMs: 10,
  });
  port = await demo.listen(0);
});
after(() => demo.close());

const connect = (token?: string, origin?: string) =>
  new WebSocket(`ws://127.0.0.1:${port}`, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(origin ? { Origin: origin } : {}) },
  });

const rejected = (ws: WebSocket) =>
  new Promise<number | undefined>((resolve) => {
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
    ws.on('open', () => resolve(undefined));
    ws.on('error', () => undefined);
  });

describe('demo server over a real WebSocket', () => {
  it('rejects missing or wrong tokens and foreign browser origins before upgrading', async () => {
    assert.equal(await rejected(connect()), 401);
    assert.equal(await rejected(connect('nope')), 401);
    assert.equal(await rejected(connect('token-on', 'https://evil.example')), 403);
  });

  it('runs a turn, speaks, and completes the task only after approval over HTTP', async () => {
    const ws = connect('token-on');
    const messages: ServerMessage[] = [];
    let speechFrames = 0;
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        if (decodeAudioFrame(new Uint8Array(data))?.kind === 'speech') speechFrames++;
        return;
      }
      messages.push(JSON.parse(data.toString()));
    });
    await new Promise((r) => ws.once('open', r));
    const waitFor = async (pred: () => boolean) => {
      for (let i = 0; i < 300 && !pred(); i++) await new Promise((r) => setTimeout(r, 10));
      assert.ok(pred(), `timed out; saw ${messages.map((m) => m.type).join(', ')}`);
    };

    ws.send(JSON.stringify({ v: 1, type: 'session.start', audio }));
    await waitFor(() => messages.some((m) => m.type === 'session.ready'));
    // The assistant speaks first, and addresses the person by the name on the server's own record.
    await waitFor(() => messages.some((m) => m.type === 'tts.end'));
    const greeting = messages.filter((m) => m.type === 'assistant.text.delta').map((m) => (m as { text: string }).text).join('');
    assert.equal(greeting, "Hi Dana, I'm listening. How can I help?");
    ws.send(encodeAudioFrame({ kind: 'mic', seq: 0, pcm: new Uint8Array(640) }), { binary: true });
    ws.send(JSON.stringify({ v: 1, type: 'input.end' }));
    await waitFor(() => messages.filter((m) => m.type === 'tts.end').length === 2);
    assert.ok(speechFrames > 0);

    const approval = messages.find((m) => m.type === 'approval.requested');
    assert.ok(approval && approval.type === 'approval.requested');
    const task = messages.find((m) => m.type === 'task.proposed');
    assert.ok(task && task.type === 'task.proposed');
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(demo.backend.sideEffectCount('on', task.task.taskId), 0);

    const url = `http://127.0.0.1:${port}/demo/approvals/${approval.approval.approvalId}/approved`;
    assert.equal((await fetch(url, { method: 'POST' })).status, 401);
    assert.equal((await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer token-off' } })).status, 404);
    assert.equal((await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer token-on' } })).status, 204);

    await waitFor(() => messages.some((m) => m.type === 'task.event' && m.event.state === 'confirmed'));
    assert.equal(demo.backend.sideEffectCount('on', task.task.taskId), 1);
    ws.close();
  });

  it('refuses a session for an account without the flag', async () => {
    const ws = connect('token-off');
    const messages: ServerMessage[] = [];
    ws.on('message', (data: Buffer) => messages.push(JSON.parse(data.toString())));
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ v: 1, type: 'session.start', audio }));
    await new Promise((r) => ws.once('close', r));
    assert.deepEqual(messages.map((m) => m.type), ['error', 'session.closed']);
  });
});
