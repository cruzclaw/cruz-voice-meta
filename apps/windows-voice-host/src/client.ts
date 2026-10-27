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
  /** The connection ended after it had opened. */
  onClose(reason: string): void;
}

/**
 * One connection to a voice server, carrying one voice session at a time.
 * Runs in the Electron main process because a browser WebSocket cannot set the
 * Authorization header the server requires. The token is only ever sent in that header.
 *
 * Opening the connection (which checks the token) is separate from starting the
 * session, because the server speaks its greeting the moment a session starts.
 */
export class VoiceClient {
  private ws: WebSocket | undefined;
  private micSeq = 0;
  private waiting: { resolve(): void; reject(error: Error): void } | undefined;
  private closedReported = false;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly handlers: VoiceClientHandlers,
  ) {}

  get open(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Resolves when the socket is open and the token was accepted. */
  openConnection(timeoutMs = 10000): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url, { headers: { Authorization: `Bearer ${this.token}` } });
      this.ws = ws;
      let opened = false;
      let settled = false;
      const timer = setTimeout(() => {
        ws.terminate();
        fail('The voice server did not answer in time');
      }, timeoutMs);
      const fail = (reason: string): void => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(new Error(reason));
        }
        if (opened) this.reportClosed(reason);
      };

      ws.on('open', () => {
        opened = true;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
      ws.on('unexpected-response', (_req, res) => fail(`The voice server refused the connection (HTTP ${res.statusCode})`));
      ws.on('error', () => fail('Could not reach the voice server'));
      ws.on('close', () => fail('The voice server closed the connection'));
      ws.on('message', (data, isBinary) => this.onData(data as Buffer, isBinary));
    });
  }

  /** Starts a session and resolves when the server says it is ready. Rejects if it refuses. */
  startSession(conversationId: string, timeoutMs = 10000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => settle(new Error('The voice server did not start the session in time')), timeoutMs);
      const settle = (error?: Error): void => {
        clearTimeout(timer);
        this.waiting = undefined;
        if (error) reject(error);
        else resolve();
      };
      this.waiting = { resolve: () => settle(), reject: settle };
      this.send({ v: PROTOCOL_VERSION, type: 'session.start', conversationId, audio: HOST_AUDIO });
    });
  }

  /** Open and start in one step. */
  async connect(conversationId = 'conv-host'): Promise<void> {
    await this.openConnection();
    await this.startSession(conversationId);
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

  private onData(data: Buffer, isBinary: boolean): void {
    if (isBinary) {
      const frame = decodeAudioFrame(new Uint8Array(data));
      if (frame?.kind === 'speech') this.handlers.onSpeech(frame.pcm);
      return;
    }
    let message: ServerMessage;
    try {
      message = JSON.parse(data.toString()) as ServerMessage;
    } catch {
      return;
    }
    if (this.waiting) {
      if (message.type === 'session.ready') this.waiting.resolve();
      else if (message.type === 'error') this.waiting.reject(new Error(`The voice server refused the session: ${message.code}`));
    }
    this.handlers.onMessage(message);
  }

  private reportClosed(reason: string): void {
    if (this.closedReported) return;
    this.closedReported = true;
    this.waiting?.reject(new Error(reason));
    this.handlers.onClose(reason);
  }
}
