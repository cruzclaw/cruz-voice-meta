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
  /** Whether the speaker may still be making sound. The reply is over only when it is quiet. */
  isPlaying?(): boolean;
  /** How long to wait for the speaker to say it has begun, before saying Speaking anyway. */
  audibleTimeoutMs?: number;
  /** How long to wait for the speaker to say it is quiet, before ending the reply anyway. */
  quietTimeoutMs?: number;
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
 *
 * tts.start follows the speaker, not the voice: it is sent when the audio window says sound has begun (onAudible), and
 * tts.end when the speaker says it is quiet (onQuiet). Making the first sentence can take seconds, and playing the
 * last one takes seconds more, and the panel must not say Speaking for the first or stop saying it for the second.
 * If the speaker never reports, the panel is not left stuck: a timer says it anyway.
 */
export class DeviceSpeech {
  private active = false;
  private turnId: string | undefined;
  private buffer = '';
  private queue: string[] = [];
  private done = false;
  private started = false;
  /** tts.start has been sent for this reply. */
  private announced = false;
  /** Sound has been handed to the speaker and its beginning is awaited. */
  private awaitingAudible = false;
  /** Everything of this reply has been made, and its end waits for the speaker to be quiet. */
  private finishing = false;
  private currentTurn: string | undefined;
  private audibleTimer: ReturnType<typeof setTimeout> | undefined;
  private quietTimer: ReturnType<typeof setTimeout> | undefined;
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
    this.awaitingAudible = false;
    this.finishing = false;
    clearTimeout(this.audibleTimer);
    clearTimeout(this.quietTimer);
  }

  /** The speaker says sound has begun. Only counts for a reply whose sound is being awaited. */
  onAudible(): void {
    if (this.awaitingAudible && !this.announced) this.announce(this.currentTurn);
  }

  /** The speaker says it is quiet. Ends a reply that has been completely made. */
  onQuiet(): void {
    if (this.finishing) this.end();
  }

  private enqueue(text: string): void {
    const piece = text.trim();
    if (!piece || !SPEAKABLE.test(piece)) return;
    this.queue.push(piece);
    void this.run();
  }

  private announce(turnId: string | undefined): void {
    clearTimeout(this.audibleTimer);
    this.awaitingAudible = false;
    this.announced = true;
    this.options.emit({ v: 1, seq: 0, type: 'tts.start', ttsId: `local-${turnId}`, turnId: turnId ?? 'local', audio: SPEECH_FORMAT });
  }

  /** The reply is over: Speaking, if it was said, is closed first, so the panel always sees a start and then an end. */
  private end(): void {
    clearTimeout(this.quietTimer);
    const turnId = this.currentTurn;

    if (!this.announced) this.announce(turnId);
    this.started = false;
    this.announced = false;
    this.awaitingAudible = false;
    this.finishing = false;
    this.done = false;
    this.options.emit({ v: 1, seq: 0, type: 'tts.end', ttsId: `local-${turnId}` });
  }

  /** One loop at a time takes pieces off the queue in order. */
  private async run(): Promise<void> {
    const signal = this.abort.signal;
    if (this.runningFor === signal) return;
    this.runningFor = signal;
    const turnId = this.turnId;
    this.currentTurn = turnId;
    try {
      while (!signal.aborted) {
        const piece = this.queue.shift();
        if (piece === undefined) break;
        this.started = true;
        for await (const chunk of this.options.synthesize(piece, signal)) {
          if (signal.aborted) return;
          this.options.play(chunk);
          // Speaking is said when the speaker reports sound, or after a while if it never does.
          if (!this.announced && !this.awaitingAudible) {
            this.awaitingAudible = true;
            this.audibleTimer = setTimeout(() => {
              if (this.awaitingAudible && !this.announced && !signal.aborted) this.announce(turnId);
            }, this.options.audibleTimeoutMs ?? 1500);
          }
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
      // Everything has been made. It is over when the speaker has said everything it was given. With no sound at all
      // (nothing was playing) it is over now, and still opens and closes, so the panel sees an ordinary reply.
      this.finishing = true;
      if (this.options.isPlaying?.()) {
        this.quietTimer = setTimeout(() => {
          if (this.finishing && !signal.aborted) this.end();
        }, this.options.quietTimeoutMs ?? 30000);
      } else {
        this.end();
      }
    }
  }
}
