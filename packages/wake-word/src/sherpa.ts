import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_GREETING_THRESHOLD, keywordsFile, type WakeOptions } from './keywords.js';

/** Listens to a microphone stream for the wake phrase. Everything stays on this machine. */
export interface WakeDetector {
  /** Feeds 16-bit little-endian mono PCM. Returns the phrase (for example "HEY CRUZ") when it was just heard. */
  feed(pcm: Uint8Array): string | undefined;
  /** Forgets any audio heard so far. Call after the microphone was used for something else. */
  reset(): void;
  dispose(): void;
}

export interface SherpaWakeOptions extends WakeOptions {
  /** The folder the model was unpacked into (see `npm run fetch-model`). */
  modelDir: string;
  /** Sample rate of the PCM passed to feed(). It must not change while the detector is in use. */
  sampleRate?: number;
  /** Where to write the keywords file. Defaults to a folder in the temp directory. */
  workDir?: string;
}

// The parts of sherpa-onnx-node's keyword spotter that are used here. The package ships no types.
interface Spotter {
  createStream(): Stream;
  isReady(stream: Stream): boolean;
  decode(stream: Stream): void;
  getResult(stream: Stream): { keyword?: string };
  reset(stream: Stream): void;
}
interface Stream {
  acceptWaveform(wave: { samples: Float32Array; sampleRate: number }): void;
}

const MODEL_FILES = [
  'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
  'decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
  'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
  'tokens.txt',
] as const;

/** Converts 16-bit little-endian PCM to floats in [-1, 1]. Copes with an odd byte offset or length. */
export function pcm16ToFloat(pcm: Uint8Array): Float32Array {
  const count = pcm.byteLength >> 1;
  const out = new Float32Array(count);
  const view = new DataView(pcm.buffer, pcm.byteOffset, count * 2);
  for (let i = 0; i < count; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

export async function createSherpaWakeDetector(options: SherpaWakeOptions): Promise<WakeDetector> {
  const missing = MODEL_FILES.filter((f) => !existsSync(path.join(options.modelDir, f)));
  if (missing.length) {
    throw new Error(`The wake word model is missing (${missing[0]}). Run "npm run fetch-model -w @cruzclaw/wake-word" once.`);
  }
  const sampleRate = options.sampleRate ?? 24000;
  const workDir = options.workDir ?? path.join(os.tmpdir(), 'cruzclaw-wake');
  mkdirSync(workDir, { recursive: true });
  const keywordsPath = path.join(workDir, `keywords-${options.greetingThreshold ?? DEFAULT_GREETING_THRESHOLD}-${options.bareThreshold ?? 'none'}.txt`);
  writeFileSync(keywordsPath, keywordsFile(options));

  // Loaded here, not at the top, so nothing needs the native addon unless wake listening is switched on.
  const loaded = (await import('sherpa-onnx-node')) as unknown as { default?: unknown };
  const sherpa = (loaded.default ?? loaded) as { KeywordSpotter: new (config: unknown) => Spotter };
  const spotter = new sherpa.KeywordSpotter({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: path.join(options.modelDir, MODEL_FILES[0]),
        decoder: path.join(options.modelDir, MODEL_FILES[1]),
        joiner: path.join(options.modelDir, MODEL_FILES[2]),
      },
      tokens: path.join(options.modelDir, MODEL_FILES[3]),
      numThreads: 1,
      provider: 'cpu',
      debug: 0,
    },
    maxActivePaths: 4,
    numTrailingBlanks: 1,
    keywordsScore: options.boost ?? 1.0,
    keywordsThreshold: options.greetingThreshold ?? DEFAULT_GREETING_THRESHOLD,
    keywordsFile: keywordsPath,
  });

  let stream = spotter.createStream();
  let disposed = false;
  return {
    feed(pcm) {
      if (disposed || pcm.byteLength < 2) return undefined;
      stream.acceptWaveform({ samples: pcm16ToFloat(pcm), sampleRate });
      let heard: string | undefined;
      while (spotter.isReady(stream)) {
        spotter.decode(stream);
        const { keyword } = spotter.getResult(stream);
        if (keyword) {
          heard = keyword;
          spotter.reset(stream);
        }
      }
      return heard;
    },
    reset() {
      if (!disposed) stream = spotter.createStream();
    },
    dispose() {
      disposed = true;
    },
  };
}
