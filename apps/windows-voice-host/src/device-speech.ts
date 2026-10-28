import type { AudioFormat, ServerMessage } from '@cruzclaw/voice-core';

/** Turns text into speech on this machine. Matches the speech process and the Kokoro synthesizer. */
export interface SpeechSource {
  synthesize(text: string, signal: AbortSignal): AsyncIterable<Uint8Array>;
}

export interface DeviceSpeechOptions {
  synthesize: SpeechSource['synthesize'];
  /** Tells the rest of the host what is happening, in the same messages a server that speaks would send. */
  emit(message: ServerMessage): void;
  /** One chunk of the assistant's voice, ready for the speaker. */
  play(pcm: Uint8Array): void;
  /** Speech could not be made. The text of the reply is still on screen. */
  onError?(error: unknown): void;
}

/** What the speech process produces. */
export const SPEECH_FORMAT: AudioFormat = { encoding: 'pcm_s16le', sampleRate: 24000, channels: 1 };

/** A piece must hold a letter or digit, otherwise there is nothing to say. */
const SPEAKABLE = /[\p{L}\p{N}]/u;
/** A sentence ends at . ! or ? followed by a space. A figure like 3.5 has no space, so it stays whole. */
const SENTENCE_END = /(?<=[.!?])\s+/;

/**
 * Speaks the assistant's reply here, on this device, when the server sends text only.
 *
 * It listens to the reply as it streams in and starts talking at the end of the first sentence,
 * without waiting for the whole answer. It reports what it does as the same tts.start and tts.end
 * messages a server that speaks would send, so the panel and the call logic need no second path.
 */
export class DeviceSpeech {
  private active = false;
  private turnId: string | undefined;
  private buffer = '';
  private queue: string[] = [];
  private done = false;
  private started = false;
  /** tts.start has been sent for this reply: only once sound exists, not when making it begins. */
  private announced = false;
  /** The cancel generation whose loop is running. A cut-off loop that is still unwinding must not block the next reply. */
  private runningFor: AbortSignal | undefined;
  private abort = new AbortController();

  constructor(private readonly options: DeviceSpeechOptions) {}

  /** A session has started. `on` says whether this session leaves the speaking to the device. */
  reset(on: boolean): void {
    this.cancel();
    this.active = on;
  }

  /** Feed every server message through here. Anything that is not about the reply is ignored. */
  onMessage(message: ServerMessage): void {
    if (!this.active) return;
    if (message.type === 'assistant.text.delta') {
      if (message.turnId !== this.turnId) {
        // A new reply replaces an old one that was still being spoken.
        this.cancel();
        this.turnId = message.turnId;
      }
      this.buffer += message.text;
      const parts = this.buffer.split(SENTENCE_END);
      this.buffer = parts.pop() ?? '';
      for (const part of parts) this.enqueue(part);
    } else if (message.type === 'assistant.text.done') {
      if (message.turnId !== this.turnId) {
        // Text that came whole, such as a greeting, has no deltas before it in this turn.
        this.cancel();
        this.turnId = message.turnId;
      }
      this.enqueue(this.buffer);
      this.buffer = '';
      this.done = true;
      void this.run();
    }
  }

  /** Stops now: nothing queued is spoken and no end of speech is reported for what was cut off. */
  cancel(): void {
    this.abort.abort();
    this.abort = new AbortController();
    this.turnId = undefined;
    this.buffer = '';
    this.queue = [];
    this.done = false;
    this.started = false;
    this.announced = false;
  }

  private enqueue(text: string): void {
    const piece = text.trim();
    if (!piece || !SPEAKABLE.test(piece)) return;
    this.queue.push(piece);
    void this.run();
  }

  private announce(turnId: string | undefined): void {
    this.announced = true;
    this.options.emit({ v: 1, seq: 0, type: 'tts.start', ttsId: `local-${turnId}`, turnId: turnId ?? 'local', audio: SPEECH_FORMAT });
  }

  /** One loop at a time takes pieces off the queue in order. */
  private async run(): Promise<void> {
    const signal = this.abort.signal;
    if (this.runningFor === signal) return;
    this.runningFor = signal;
    const turnId = this.turnId;
    try {
      while (!signal.aborted) {
        const piece = this.queue.shift();
        if (piece === undefined) break;
        this.started = true;
        for await (const chunk of this.options.synthesize(piece, signal)) {
          if (signal.aborted) return;
          // "Speaking" starts with the sound, not with the effort of making it, which can take seconds the first time.
          if (!this.announced) this.announce(turnId);
          if (signal.aborted) return;
          this.options.play(chunk);
        }
      }
    } catch (error) {
      if (signal.aborted) return;
      this.queue = [];
      this.options.onError?.(error);
    } finally {
      if (this.runningFor === signal) this.runningFor = undefined;
    }
    if (signal.aborted) return;
    // Pieces may have arrived while the last one was being made.
    if (this.queue.length > 0) return void this.run();
    if (this.done && this.started) {
      // A reply that made no sound at all still opens and closes, so the panel and the follow-up logic see an ordinary reply.
      if (!this.announced) this.announce(turnId);
      this.started = false;
      this.announced = false;
      this.done = false;
      this.options.emit({ v: 1, seq: 0, type: 'tts.end', ttsId: `local-${turnId}` });
    }
  }
}
