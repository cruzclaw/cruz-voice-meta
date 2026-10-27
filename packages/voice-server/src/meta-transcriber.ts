import WebSocket from 'ws';
import type { AudioFormat } from '@cruzclaw/voice-core';
import type { Transcriber } from './ports.js';

export const META_ASR_URL = 'wss://api.meta.ai/v1/asr/realtime';
export const META_ASR_MODEL = 'muse-voice-transcribe-1.0';

export interface MetaTranscriberOptions {
  /** Read from the server's environment only. Never log it or send it to a client. */
  apiKey: string;
  url?: string;
  model?: string;
  /** Biases recognition toward these terms. Fixed for the whole session by the API. */
  keywords?: string[];
  /** Give up if no handshake acknowledgement or final result arrives in this time. */
  timeoutMs?: number;
}

const FRAME_MS = 80;
/** The API wants audio no more than five seconds ahead of processing. Stay under that. */
const MAX_LEAD_MS = 4000;

const ENCODING: Partial<Record<number, 'PCM_16KHZ' | 'PCM_24KHZ'>> = { 16000: 'PCM_16KHZ', 24000: 'PCM_24KHZ' };

type Message = { type?: string; transcript?: string; final?: boolean; message?: string; sessionId?: string };

/**
 * Speech to text through Meta's realtime endpoint, one connection per utterance in
 * PUSH_TO_TALK mode. The key travels only inside the first frame, as the API requires.
 */
export class MetaTranscriber implements Transcriber {
  constructor(private readonly options: MetaTranscriberOptions) {
    if (!options.apiKey) throw new Error('MODEL_API_KEY is not set');
  }

  async transcribe(pcm: Uint8Array, format: AudioFormat, signal: AbortSignal): Promise<string> {
    const encoding = ENCODING[format.sampleRate];
    if (!encoding) throw new Error(`Meta transcription supports 16 kHz and 24 kHz audio, not ${format.sampleRate} Hz`);
    if (signal.aborted) return '';

    const timeoutMs = this.options.timeoutMs ?? 15000;
    const ws = new WebSocket(this.options.url ?? META_ASR_URL);
    const bytesPerFrame = Math.round((format.sampleRate * FRAME_MS) / 1000) * 2;

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let lastText = '';
      let sender: NodeJS.Timeout | undefined;
      let deadline: NodeJS.Timeout | undefined;

      const finish = (error: Error | undefined, text = ''): void => {
        if (settled) return;
        settled = true;
        if (sender) clearInterval(sender);
        if (deadline) clearTimeout(deadline);
        signal.removeEventListener('abort', onAbort);
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.terminate();
        if (error) reject(error);
        else resolve(text);
      };
      const onAbort = (): void => finish(undefined, '');
      signal.addEventListener('abort', onAbort);
      const arm = (): void => {
        if (deadline) clearTimeout(deadline);
        deadline = setTimeout(() => finish(new Error('Meta transcription timed out')), timeoutMs);
      };
      arm();

      const stream = (): void => {
        const startedAt = Date.now();
        let offset = 0;
        sender = setInterval(() => {
          const elapsed = Date.now() - startedAt;
          while (offset < pcm.byteLength && (offset / bytesPerFrame) * FRAME_MS - elapsed <= MAX_LEAD_MS) {
            ws.send(pcm.subarray(offset, Math.min(offset + bytesPerFrame, pcm.byteLength)), { binary: true });
            offset += bytesPerFrame;
          }
          if (offset >= pcm.byteLength) {
            clearInterval(sender);
            sender = undefined;
            ws.send(JSON.stringify({ type: 'endStream' }));
            arm();
          }
        }, FRAME_MS);
      };

      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            authorization: { accessToken: `Bearer ${this.options.apiKey}` },
            audioEncoding: encoding,
            model: this.options.model ?? META_ASR_MODEL,
            mode: 'PUSH_TO_TALK',
            partialMode: 'CUMULATIVE',
            emitAudioProgress: false,
            ...(this.options.keywords?.length ? { keywords: this.options.keywords } : {}),
          }),
        );
      });

      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        let msg: Message;
        try {
          msg = JSON.parse(data.toString()) as Message;
        } catch {
          return;
        }
        if (msg.type === undefined && msg.sessionId !== undefined) return stream(); // handshake acknowledged
        if (msg.type === 'error') return finish(new Error(`Meta transcription error: ${msg.message ?? 'unknown'}`));
        if (msg.type === 'transcript' && typeof msg.transcript === 'string') {
          lastText = msg.transcript;
          if (msg.final === true) finish(undefined, msg.transcript.trim());
        }
        // Other event types are ignored, as the API asks.
      });

      ws.on('close', (code) => {
        if (settled) return;
        if (lastText) return finish(undefined, lastText.trim());
        finish(new Error(`Meta transcription closed before a result (code ${code})`));
      });
      // Never include the URL or headers here: nothing secret should reach a log.
      ws.on('error', () => finish(new Error('Meta transcription connection failed')));
    });
  }
}
