import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { after, describe, it } from 'node:test';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { MetaConnectionError, MetaTranscriber } from '../src/meta-transcriber.js';

const format24 = { encoding: 'pcm_s16le', sampleRate: 24000, channels: 1 } as const;
const KEY = 'test-key-123';
const servers: WebSocketServer[] = [];
after(() => servers.forEach((s) => s.close()));

interface Seen {
  handshake?: Record<string, unknown>;
  headers?: IncomingMessage['headers'];
  binaryBytes: number;
  endStream: boolean;
}

/** A stand-in for Meta's endpoint that follows the documented protocol. */
async function fakeMeta(behave: (ws: ServerSocket, seen: Seen) => void) {
  const seen: Seen = { binaryBytes: 0, endStream: false };
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  servers.push(wss);
  await new Promise((r) => wss.once('listening', r));
  wss.on('connection', (ws, req) => {
    seen.headers = req.headers;
    ws.on('message', (data, isBinary) => {
      if (isBinary) seen.binaryBytes += (data as Buffer).length;
      else {
        const json = JSON.parse(data.toString());
        if (json.type === 'endStream') seen.endStream = true;
        else seen.handshake = json;
      }
    });
    behave(ws, seen);
  });
  const port = (wss.address() as { port: number }).port;
  return { url: `ws://127.0.0.1:${port}`, seen };
}

const pcm = (ms: number) => new Uint8Array(Math.round((24000 * ms) / 1000) * 2);
const ack = (ws: ServerSocket) => ws.send(JSON.stringify({ sessionId: 'sess-1' }));

describe('MetaTranscriber', () => {
  it('sends the key only in the first frame, streams the audio, then ends the stream', async () => {
    const meta = await fakeMeta((ws, seen) => {
      ws.on('message', (_d, isBinary) => {
        if (!isBinary && seen.handshake && !seen.endStream && seen.binaryBytes === 0) ack(ws);
        if (seen.endStream) {
          ws.send(JSON.stringify({ type: 'transcript', transcript: 'draft an', final: false, audioProcessedMs: 500 }));
          ws.send(JSON.stringify({ type: 'transcript', transcript: ' Draft an email to Maria ', final: true, audioProcessedMs: 1000 }));
        }
      });
    });
    const t = new MetaTranscriber({ apiKey: KEY, url: meta.url, keywords: ['Maria'] });
    const text = await t.transcribe(pcm(1000), format24, new AbortController().signal);

    assert.equal(text, 'Draft an email to Maria');
    assert.deepEqual(meta.seen.handshake, {
      authorization: { accessToken: `Bearer ${KEY}` },
      audioEncoding: 'PCM_24KHZ',
      model: 'muse-voice-transcribe-1.0',
      mode: 'PUSH_TO_TALK',
      partialMode: 'CUMULATIVE',
      emitAudioProgress: false,
      keywords: ['Maria'],
    });
    assert.equal(meta.seen.headers?.authorization, undefined);
    assert.equal(meta.seen.binaryBytes, pcm(1000).length);
    assert.equal(meta.seen.endStream, true);
  });

  it('uses PCM_16KHZ for 16 kHz audio and refuses rates Meta does not take', async () => {
    const meta = await fakeMeta((ws, seen) => {
      ws.on('message', () => {
        if (seen.handshake && !seen.endStream && seen.binaryBytes === 0) ack(ws);
        if (seen.endStream) ws.send(JSON.stringify({ type: 'transcript', transcript: 'hi', final: true }));
      });
    });
    const t = new MetaTranscriber({ apiKey: KEY, url: meta.url });
    const f16 = { ...format24, sampleRate: 16000 } as const;
    assert.equal(await t.transcribe(new Uint8Array(3200), f16, new AbortController().signal), 'hi');
    assert.equal(meta.seen.handshake?.audioEncoding, 'PCM_16KHZ');
    await assert.rejects(t.transcribe(pcm(100), { ...format24, sampleRate: 48000 }, new AbortController().signal), /16 kHz and 24 kHz/);
  });

  it('turns a server error into a rejection that does not contain the key', async () => {
    const meta = await fakeMeta((ws) => ws.send(JSON.stringify({ type: 'error', message: 'bad model', sessionId: 's' })));
    const t = new MetaTranscriber({ apiKey: KEY, url: meta.url });
    await assert.rejects(t.transcribe(pcm(100), format24, new AbortController().signal), (e: Error) => {
      assert.match(e.message, /bad model/);
      assert.equal(e.message.includes(KEY), false);
      return true;
    });
  });

  it('times out when the server never answers', async () => {
    const meta = await fakeMeta(() => undefined);
    const t = new MetaTranscriber({ apiKey: KEY, url: meta.url, timeoutMs: 150 });
    await assert.rejects(t.transcribe(pcm(100), format24, new AbortController().signal), /timed out/);
  });

  it('fails without leaking the key when the connection cannot be made', async () => {
    const t = new MetaTranscriber({ apiKey: KEY, url: 'ws://127.0.0.1:1', timeoutMs: 500 });
    await assert.rejects(t.transcribe(pcm(100), format24, new AbortController().signal), (e: Error) => {
      assert.equal(e.message.includes(KEY), false);
      return true;
    });
  });

  it('stops quietly and returns empty text when aborted', async () => {
    const meta = await fakeMeta(() => undefined);
    const controller = new AbortController();
    const t = new MetaTranscriber({ apiKey: KEY, url: meta.url, timeoutMs: 5000 });
    const pending = t.transcribe(pcm(100), format24, controller.signal);
    setTimeout(() => controller.abort(), 50);
    assert.equal(await pending, '');
  });

  it('requires a key', () => {
    assert.throws(() => new MetaTranscriber({ apiKey: '' }), /MODEL_API_KEY/);
  });
});

describe('MetaTranscriber connection failures', () => {
  /** An endpoint that answers the first `refusals` upgrades with an HTTP status, then behaves like Meta. */
  async function flaky(refusals: number, status: number, behave?: (ws: ServerSocket, seen: Seen) => void) {
    const seen: Seen = { binaryBytes: 0, endStream: false };
    let attempts = 0;
    const http = createServer();
    const wss = new WebSocketServer({ noServer: true });
    http.on('upgrade', (req, socket, head) => {
      attempts += 1;
      if (attempts <= refusals) {
        socket.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\n\r\n`);
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on('message', (data, isBinary) => {
          if (isBinary) seen.binaryBytes += (data as Buffer).length;
          else if (JSON.parse(data.toString()).type === 'endStream') seen.endStream = true;
          else ack(ws);
          if (seen.endStream) ws.send(JSON.stringify({ type: 'transcript', transcript: ' hello there ', final: true }));
        });
        behave?.(ws, seen);
      });
    });
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    after(() => http.close());
    return { url: `ws://127.0.0.1:${(http.address() as { port: number }).port}`, attempts: () => attempts, seen };
  }

  it('says what failed, by code or HTTP status and how far it got, and nothing that is secret', async () => {
    const meta = await flaky(99, 503);
    const t = new MetaTranscriber({ apiKey: KEY, url: meta.url });

    await assert.rejects(t.transcribe(pcm(500), format24, new AbortController().signal), (error: Error) => {
      assert.ok(error instanceof MetaConnectionError);
      assert.match(error.message, /^Meta transcription connection failed \(HTTP 503 while connecting, \d+ ms in, 0 ms of audio sent\)$/);
      assert.equal(error.message.includes(KEY) || error.message.includes('127.0.0.1') || error.message.includes('ws://'), false);
      assert.equal(error.failure.status, 503);

      return true;
    });
  });

  it('tries once more when the connection could not be opened for a reason that passes, and gets the words', async () => {
    const meta = await flaky(1, 503);
    const t = new MetaTranscriber({ apiKey: KEY, url: meta.url });

    assert.equal(await t.transcribe(pcm(500), format24, new AbortController().signal), 'hello there');
    assert.equal(meta.attempts(), 2);
  });

  it('tries only once more, so a lasting outage is reported and not hammered', async () => {
    const meta = await flaky(99, 429);
    const t = new MetaTranscriber({ apiKey: KEY, url: meta.url });

    await assert.rejects(t.transcribe(pcm(500), format24, new AbortController().signal), /HTTP 429 while connecting/);
    assert.equal(meta.attempts(), 2);
  });

  it('does not try again for a refusal that will not change (a credential or a bad request)', async () => {
    for (const status of [401, 403, 400]) {
      const meta = await flaky(99, status);
      const t = new MetaTranscriber({ apiKey: KEY, url: meta.url });

      await assert.rejects(t.transcribe(pcm(500), format24, new AbortController().signal), new RegExp(`HTTP ${status} while connecting`));
      assert.equal(meta.attempts(), 1, String(status));
    }
  });

  it('reports a refused connection by its error code, and tries once more', async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const port = (closed.address() as { port: number }).port;

    await new Promise((r) => closed.close(r)); // nothing listens there now
    const t = new MetaTranscriber({ apiKey: KEY, url: `ws://127.0.0.1:${port}` });

    await assert.rejects(t.transcribe(pcm(500), format24, new AbortController().signal), /ECONNREFUSED while connecting/);
  });

  it('does not repeat a connection that dropped part way through, because audio was already sent', async () => {
    let connections = 0;
    const meta = await fakeMeta((ws, seen) => {
      connections += 1;
      ws.on('message', (_d, isBinary) => {
        if (!isBinary && seen.handshake && seen.binaryBytes === 0) ack(ws);
        if (isBinary && seen.binaryBytes > 4000) ws.terminate();
      });
    });
    const t = new MetaTranscriber({ apiKey: KEY, url: meta.url, timeoutMs: 3000 });

    await assert.rejects(t.transcribe(pcm(1500), format24, new AbortController().signal), (error: Error) => /while (streaming|waiting)|closed before a result/.test(error.message));
    assert.equal(connections, 1);
  });

  it('stops quietly when the turn is cancelled during the wait before the second try', async () => {
    const meta = await flaky(99, 503);
    const t = new MetaTranscriber({ apiKey: KEY, url: meta.url });
    const controller = new AbortController();
    const running = t.transcribe(pcm(500), format24, controller.signal);

    setTimeout(() => controller.abort(), 100);

    assert.equal(await running, '');
    assert.equal(meta.attempts(), 1);
  });
});
