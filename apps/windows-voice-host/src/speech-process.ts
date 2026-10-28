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

// Where the voice model is kept. The host sets this to a folder the app can write to, because the model is
// downloaded the first time it is needed and the folder next to the program is often read only once installed.
const cache = process.env.VOICE_MODEL_CACHE;
const ready: Promise<void> = cache
  ? import('@huggingface/transformers').then(({ env }) => {
      env.cacheDir = cache;
    })
  : Promise.resolve();

const kokoro = new KokoroSynthesizer(process.env.VOICE_TTS_VOICE ? { voice: process.env.VOICE_TTS_VOICE } : {});
/** The same voice, but the cache folder is set before the first use of it. */
const voice = {
  async *synthesize(text: string, format: Parameters<typeof kokoro.synthesize>[1], signal: AbortSignal) {
    await ready;
    yield* kokoro.synthesize(text, format, signal);
  },
  async warmUp() {
    await ready;
    await kokoro.warmUp();
  },
};

serveSpeech(
  {
    post: (message: FromSpeech) => parentPort.postMessage(message),
    onMessage: (listener) => parentPort.on('message', (event) => listener(event.data as ToSpeech)),
  },
  voice,
);
