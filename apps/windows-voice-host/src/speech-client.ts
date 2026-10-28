import type { SpeechSource } from './device-speech.js';
import type { Endpoint, FromSpeech, ToSpeech } from './speech-protocol.js';

/** A running speech process, as the host sees it. */
export interface SpeechChild {
  endpoint: Endpoint<ToSpeech, FromSpeech>;
  /** Called once if the process ends, whatever the reason. */
  onExit(listener: () => void): void;
  kill(): void;
}

interface Pending {
  push(message: FromSpeech): void;
  fail(error: Error): void;
}

/**
 * Asks the speech process to speak, and hands the audio back as it is made. The process is started the
 * first time it is needed and started again if it ever stops, so one crash does not end the voice.
 */
export class SpeechClient implements SpeechSource {
  private child: SpeechChild | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private warmWaiters: Array<(ok: boolean) => void> = [];

  constructor(private readonly spawn: () => SpeechChild) {}

  /** Starts the process and loads the model. Resolves true when the voice is ready to use. */
  warmUp(): Promise<boolean> {
    return new Promise((resolve) => {
      this.warmWaiters.push(resolve);
      this.ensure().endpoint.post({ type: 'warm' });
    });
  }

  async *synthesize(text: string, signal: AbortSignal): AsyncIterable<Uint8Array> {
    if (signal.aborted) return;
    const id = this.nextId++;
    const chunks: Uint8Array[] = [];
    let finished = false;
    let failure: Error | undefined;
    let wake: (() => void) | undefined;
    const notify = (): void => {
      wake?.();
      wake = undefined;
    };

    this.pending.set(id, {
      push: (m) => {
        if (m.type === 'chunk') chunks.push(m.pcm);
        else if (m.type === 'done') finished = true;
        else if (m.type === 'error') {
          failure = new Error(m.message);
          finished = true;
        }
        notify();
      },
      fail: (error) => {
        failure = error;
        finished = true;
        notify();
      },
    });
    const onAbort = (): void => {
      finished = true;
      notify();
    };
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      this.ensure().endpoint.post({ type: 'speak', id, text });
      while (true) {
        const chunk = chunks.shift();
        if (chunk) {
          yield chunk;
          continue;
        }
        if (finished) break;
        await new Promise<void>((resolve) => (wake = resolve));
      }
      if (failure && !signal.aborted) throw failure;
    } finally {
      signal.removeEventListener('abort', onAbort);
      this.pending.delete(id);
      // Anything still being made for this request is no longer wanted.
      if (signal.aborted || failure) this.child?.endpoint.post({ type: 'cancel', id });
    }
  }

  /** Stops the process. Call when the app quits. */
  dispose(): void {
    const child = this.child;
    this.child = undefined;
    child?.kill();
    this.failAll(new Error('The speech process was stopped'));
  }

  private ensure(): SpeechChild {
    if (this.child) return this.child;
    const child = this.spawn();
    this.child = child;
    child.endpoint.onMessage((message) => {
      if (this.child !== child) return;
      if (message.type === 'warm') {
        const waiters = this.warmWaiters;
        this.warmWaiters = [];
        for (const resolve of waiters) resolve(message.ok);
      } else {
        this.pending.get(message.id)?.push(message);
      }
    });
    child.onExit(() => {
      if (this.child !== child) return;
      this.child = undefined; // The next request starts a new one.
      this.failAll(new Error('The speech process stopped'));
    });
    return child;
  }

  private failAll(error: Error): void {
    for (const request of [...this.pending.values()]) request.fail(error);
    const waiters = this.warmWaiters;
    this.warmWaiters = [];
    for (const resolve of waiters) resolve(false);
  }
}
