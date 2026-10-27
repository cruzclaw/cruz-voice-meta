import { KokoroSynthesizer } from '@cruzclaw/tts-kokoro';
import type { FromSpeech, ToSpeech } from './speech-protocol.js';
import { serveSpeech } from './speech-server.js';

/**
 * Entry point of the speech process, started by the host as an Electron utility process.
 * It holds the Kokoro voice and nothing else, so its ONNX runtime never meets the wake phrase detector's.
 */
interface ParentPort {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (!parentPort) throw new Error('The speech process must be started by the host.');

serveSpeech(
  {
    post: (message: FromSpeech) => parentPort.postMessage(message),
    onMessage: (listener) => parentPort.on('message', (event) => listener(event.data as ToSpeech)),
  },
  new KokoroSynthesizer(process.env.VOICE_TTS_VOICE ? { voice: process.env.VOICE_TTS_VOICE } : {}),
);
