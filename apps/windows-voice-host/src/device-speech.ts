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
  /** Sound was handed to the speaker and none was heard: the speaker said so, or said nothing at all. */
  onPlaybackFailed?(reason: string): void;
  /** Whether the speaker may still be making sound. The reply is over only when it is quiet. */
  isPlaying?(): boolean;
  /** How long to wait for the speaker to confirm sound before treating playback as failed. */
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
 * tts.start follows the speaker, never the voice and never a timer: it is sent only when the audio window confirms
 * sound (onAudible), and tts.end when the speaker says it is quiet (onQuiet). Making the first sentence can take
 * seconds, and playing the last one takes seconds more, and the panel must not say Speaking for the first or stop
 * saying it for the second.
 *
 * If sound was handed over and the speaker never confirms it, or says it cannot play, nothing is shown as speaking.
 * The reply is dropped, the failure is reported (onPlaybackFailed) and the rest of that reply is ignored.
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
  /** Sound has been handed to the speaker and its confirmation is awaited. */
  private awaitingAudible = false;
  /** Everything of this reply has been made, and its end waits for the speaker to be quiet. */
  private finishing = false;
  /** The reply whose playback failed: what is still streaming in for it is not spoken. */
  private failedTurn: string | undefined;
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
    this.failedTurn = undefined;
    this.active = on;
  }

  /** Feed every server message through here. Anything that is not about the reply is ignored. */
  onMessage(message: ServerMessage): void {
    if (!this.active) return;
    if ((message.type === 'assistant.text.delta' || message.type === 'assistant.text.done') && message.turnId === this.failedTurn) return;
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

  /** The speaker confirms sound has begun. Only counts for a reply whose sound is being awaited. */
  onAudible(): void {
    if (this.awaitingAudible && !this.announced) this.announce(this.currentTurn);
  }

  /** The speaker says it could not play what it was given. Only counts for a reply whose sound is being awaited. */
  onFailed(reason: string): void {
    if (this.awaitingAudible && !this.announced) this.fail(reason);
  }

  /** The speaker says it is quiet. Ends a reply that has been completely made. */
  onQuiet(): void {
    if (!this.finishing) return;
    // Sound that played all the way through was audible, even if its start report has not arrived yet.
    if (this.awaitingAudible && !this.announced) this.announce(this.currentTurn);
    this.end();
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

  /** The reply is over. Speaking is closed only if it was ever said: a reply that was not heard is not shown as spoken. */
  private end(): void {
    clearTimeout(this.quietTimer);
    const turnId = this.currentTurn;

    this.started = false;
    this.announced = false;
    this.awaitingAudible = false;
    this.finishing = false;
    this.done = false;
    this.options.emit({ v: 1, seq: 0, type: 'tts.end', ttsId: `local-${turnId}` });
  }

  /** Nothing was heard: the reply is dropped, what is left of it is ignored, and the failure is reported. */
  private fail(reason: string): void {
    this.failedTurn = this.currentTurn;
    this.cancel();
    this.options.onPlaybackFailed?.(reason);
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
          // Speaking waits for the speaker's own confirmation. If it does not come, playback has failed.
          if (!this.announced && !this.awaitingAudible) {
            this.awaitingAudible = true;
            this.audibleTimer = setTimeout(() => {
              if (this.awaitingAudible && !this.announced && !signal.aborted) this.fail('The speaker did not confirm any sound.');
            }, this.options.audibleTimeoutMs ?? 4000);
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
      // Everything has been made. It is over when the speaker has said everything it was given. With nothing playing
      // it is over now, and closes without ever having said Speaking.
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
