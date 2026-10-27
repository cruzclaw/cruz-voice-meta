import WebSocket from 'ws';
import {
  decodeAudioFrame,
  encodeAudioFrame,
  PROTOCOL_VERSION,
  type AudioFormat,
  type ClientMessage,
  type ServerMessage,
} from '@cruzclaw/voice-core';

export const HOST_AUDIO: AudioFormat = { encoding: 'pcm_s16le', sampleRate: 24000, channels: 1 };

export interface VoiceClientHandlers {
  onMessage(message: ServerMessage): void;
  /** One frame of the assistant's speech, as raw PCM. */
  onSpeech(pcm: Uint8Array): void;
  onClose(reason: string): void;
}

/**
 * One voice session over one WebSocket. Runs in the Electron main process because a
 * browser WebSocket cannot set the Authorization header the server requires.
 * The token is only ever sent in that header.
 */
export class VoiceClient {
  private ws: WebSocket | undefined;
  private micSeq = 0;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly handlers: VoiceClientHandlers,
  ) {}

  get open(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Resolves when the server says session.ready. Rejects if it refuses or closes first. */
  connect(timeoutMs = 10000): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url, { headers: { Authorization: `Bearer ${this.token}` } });
      this.ws = ws;
      let ready = false;
      let finished = false;
      const fail = (reason: string): void => {
        clearTimeout(timer);
        if (finished) return;
        finished = true;
        if (!ready) reject(new Error(reason));
        else this.handlers.onClose(reason);
      };
      const timer = setTimeout(() => {
        ws.terminate();
        fail('The voice server did not answer in time');
      }, timeoutMs);

      ws.on('open', () => this.send({ v: PROTOCOL_VERSION, type: 'session.start', audio: HOST_AUDIO }));
      ws.on('unexpected-response', (_req, res) => fail(`The voice server refused the connection (HTTP ${res.statusCode})`));
      ws.on('error', () => fail('Could not reach the voice server'));
      ws.on('close', () => fail('The voice server closed the connection'));
      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          const frame = decodeAudioFrame(new Uint8Array(data as Buffer));
          if (frame?.kind === 'speech') this.handlers.onSpeech(frame.pcm);
          return;
        }
        let message: ServerMessage;
        try {
          message = JSON.parse(data.toString()) as ServerMessage;
        } catch {
          return;
        }
        if (message.type === 'session.ready') {
          ready = true;
          clearTimeout(timer);
          resolve();
        } else if (message.type === 'error' && !ready) {
          fail(`The voice server refused the session: ${message.code}`);
        }
        this.handlers.onMessage(message);
      });
    });
  }

  send(message: ClientMessage): void {
    if (this.open) this.ws!.send(JSON.stringify(message));
  }

  sendMic(pcm: Uint8Array): void {
    if (this.open) this.ws!.send(encodeAudioFrame({ kind: 'mic', seq: this.micSeq++, pcm }), { binary: true });
  }

  close(): void {
    this.ws?.close();
  }
}
