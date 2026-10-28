import { SPEECH_FORMAT } from './device-speech.js';
import type { Endpoint, FromSpeech, ToSpeech } from './speech-protocol.js';

/** The part of the Kokoro synthesizer the speech process uses. */
export interface Voice {
  synthesize(text: string, format: typeof SPEECH_FORMAT, signal: AbortSignal): AsyncIterable<Uint8Array>;
  warmUp?(): Promise<void>;
}

/**
 * Runs inside the speech process. Makes speech for each request and sends it back in chunks,
 * and stops a request as soon as it is cancelled.
 */
export function serveSpeech(endpoint: Endpoint<FromSpeech, ToSpeech>, voice: Voice): void {
  const running = new Map<number, AbortController>();

  endpoint.onMessage((message) => {
    if (message.type === 'warm') {
      void (voice.warmUp?.() ?? Promise.resolve()).then(
        () => endpoint.post({ type: 'warm', ok: true }),
        (e: unknown) => endpoint.post({ type: 'warm', ok: false, message: e instanceof Error ? e.message : 'could not load the voice' }),
      );
    } else if (message.type === 'cancel') {
      running.get(message.id)?.abort();
    } else if (message.type === 'speak') {
      void speak(message.id, message.text);
    }
  });

  async function speak(id: number, text: string): Promise<void> {
    const controller = new AbortController();
    running.set(id, controller);
    try {
      for await (const pcm of voice.synthesize(text, SPEECH_FORMAT, controller.signal)) {
        if (controller.signal.aborted) break;
        endpoint.post({ type: 'chunk', id, pcm });
      }
      if (!controller.signal.aborted) endpoint.post({ type: 'done', id });
    } catch (e) {
      if (!controller.signal.aborted) endpoint.post({ type: 'error', id, message: e instanceof Error ? e.message : 'speech failed' });
    } finally {
      running.delete(id);
    }
  }
}
