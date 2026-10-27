import type { AudioFormat } from '@cruzclaw/voice-core';

/** One generated clip: mono float samples in [-1, 1] at the engine's own rate. */
export interface SpeechClip {
  samples: Float32Array;
  sampleRate: number;
}

/** The part of a text-to-speech engine this package needs. Lets tests run without a model. */
export interface SpeechEngine {
  generate(text: string, voice: string): Promise<SpeechClip>;
}

export interface KokoroSynthesizerOptions {
  /** Kokoro voice id. Defaults to af_heart. */
  voice?: string;
  /** Replace the real model, for tests. */
  engine?: SpeechEngine | (() => Promise<SpeechEngine>);
}

export const DEFAULT_VOICE = 'af_heart';
export const KOKORO_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
/** About 100 ms of audio per chunk at 24 kHz, so an interrupt is noticed quickly. */
const CHUNK_MS = 100;
/** Kokoro reads a limited number of tokens at once. Keep each piece comfortably short. */
const MAX_PIECE_CHARS = 240;

/** Splits reply text into pieces that are spoken one after another, so the first sound starts early. */
export function splitForSpeech(text: string): string[] {
  const sentences = text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter((s) => /[\p{L}\p{N}]/u.test(s));
  const pieces: string[] = [];
  for (const sentence of sentences) {
    let rest = sentence;
    while (rest.length > MAX_PIECE_CHARS) {
      const cut = Math.max(rest.lastIndexOf(', ', MAX_PIECE_CHARS), rest.lastIndexOf(' ', MAX_PIECE_CHARS));
      const at = cut > 40 ? cut + 1 : MAX_PIECE_CHARS;
      pieces.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest) pieces.push(rest);
  }
  return pieces;
}

/** Float samples to signed 16-bit little-endian PCM, clamped so loud peaks do not wrap. */
export function floatToPcm16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(i * 2, Math.round(s < 0 ? s * 32768 : s * 32767), true);
  }
  return out;
}

/** Linear resampling. Good enough for speech at the rates the protocol allows. */
export function resample(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to || samples.length === 0) return samples;
  const length = Math.max(1, Math.round((samples.length * to) / from));
  const out = new Float32Array(length);
  const ratio = from / to;
  for (let i = 0; i < length; i++) {
    const pos = i * ratio;
    const lo = Math.floor(pos);
    const frac = pos - lo;
    const a = samples[Math.min(lo, samples.length - 1)] ?? 0;
    const b = samples[Math.min(lo + 1, samples.length - 1)] ?? 0;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

async function loadKokoro(): Promise<SpeechEngine> {
  // Loaded on first use so importing this package never pulls in the model runtime.
  const { KokoroTTS } = await import('kokoro-js');
  const tts = await KokoroTTS.from_pretrained(KOKORO_MODEL, { dtype: 'q8', device: 'cpu' });
  return {
    async generate(text, voice) {
      const audio = await tts.generate(text, { voice: voice as never });
      return { samples: audio.audio, sampleRate: audio.sampling_rate };
    },
  };
}

/**
 * Local speech with Kokoro-82M. Matches the Synthesizer port used by the voice server
 * (text and format in, PCM chunks out) without importing it.
 */
export class KokoroSynthesizer {
  private engine: Promise<SpeechEngine> | undefined;
  /** The model is not safe to run twice at once, so requests take turns. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: KokoroSynthesizerOptions = {}) {}

  /** Loads the model now, so the first reply is not slowed by it. */
  warmUp(): Promise<void> {
    return this.load().then(() => undefined);
  }

  async *synthesize(text: string, format: AudioFormat, signal: AbortSignal): AsyncIterable<Uint8Array> {
    const voice = this.options.voice ?? DEFAULT_VOICE;
    const chunkSamples = Math.round((format.sampleRate * CHUNK_MS) / 1000);
    for (const piece of splitForSpeech(text)) {
      if (signal.aborted) return;
      const clip = await this.turn(async () => (signal.aborted ? undefined : (await this.load()).generate(piece, voice)));
      if (!clip || signal.aborted) return;
      const samples = resample(clip.samples, clip.sampleRate, format.sampleRate);
      for (let at = 0; at < samples.length; at += chunkSamples) {
        if (signal.aborted) return;
        yield floatToPcm16(samples.subarray(at, at + chunkSamples));
        await new Promise((r) => setImmediate(r));
      }
    }
  }

  private load(): Promise<SpeechEngine> {
    if (!this.engine) {
      const source = this.options.engine;
      this.engine = typeof source === 'function' ? source() : source ? Promise.resolve(source) : loadKokoro();
      // A failed load must be retried next time, not cached forever.
      this.engine.catch(() => {
        this.engine = undefined;
      });
    }
    return this.engine;
  }

  private turn<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
