export interface EndpointOptions {
  /** Length of audio each level covers, in ms. */
  frameMs?: number;
  /** Quiet this long after speech means the person has finished. */
  endSilenceMs?: number;
  /** Nothing heard for this long after listening began means the person said nothing. */
  noSpeechMs?: number;
  /** Speech shorter than this in total (a cough, a click) does not count. */
  minSpeechMs?: number;
  /** Lowest level treated as speech, on a 0 to 1 scale of full volume. */
  minThreshold?: number;
}

export type EndpointEvent = 'speech_started' | 'speech_ended' | 'no_speech';

const DEFAULTS: Required<EndpointOptions> = {
  frameMs: 40,
  endSilenceMs: 900,
  noSpeechMs: 8000,
  minSpeechMs: 250,
  minThreshold: 0.012,
};

/** The room's noise floor is never assumed above this, so a person who starts talking at once is still heard. */
const MAX_FLOOR = 0.02;
const SPEECH_OVER_FLOOR = 3;

/**
 * Decides from the microphone level alone when a person has started and finished
 * speaking. Pure: feed it one level per frame, in order. It follows the room's
 * noise, so a fan does not read as speech and a quiet room does not need a loud voice.
 * After it reports speech_ended or no_speech it stays quiet until reset().
 */
export class EndpointDetector {
  private readonly o: Required<EndpointOptions>;
  private floor: number | undefined;
  private elapsedMs = 0;
  private speechMs = 0;
  private silentMs = 0;
  /** Quiet time since the last loud frame, while speech has not yet started. */
  private quietMs = 0;
  private started = false;
  private done = false;
  private peak = 0;
  private frames = 0;

  constructor(options: EndpointOptions = {}) {
    this.o = { ...DEFAULTS, ...options };
  }

  reset(): void {
    this.floor = undefined;
    this.elapsedMs = 0;
    this.speechMs = 0;
    this.silentMs = 0;
    this.quietMs = 0;
    this.started = false;
    this.done = false;
    this.peak = 0;
    this.frames = 0;
  }

  /**
   * What the microphone has done since listening began, for the log: how long, how loud at most, the room floor it learned, the
   * level that counted as speech, how much speech there was. Numbers only.
   */
  get stats(): { listenedMs: number; frames: number; peak: number; floor: number; threshold: number; speechMs: number; speechStarted: boolean } {
    return { listenedMs: this.elapsedMs, frames: this.frames, peak: this.peak, floor: this.floor ?? 0, threshold: this.threshold, speechMs: this.speechMs, speechStarted: this.started };
  }

  /** The level above which a frame counts as speech right now. */
  get threshold(): number {
    return Math.max(this.o.minThreshold, (this.floor ?? 0) * SPEECH_OVER_FLOOR);
  }

  feed(level: number): EndpointEvent | undefined {
    if (this.done || !Number.isFinite(level)) return undefined;
    const { frameMs } = this.o;
    this.elapsedMs += frameMs;
    this.frames += 1;
    if (level > this.peak) this.peak = level;
    const loud = level > this.threshold;

    if (this.floor === undefined) this.floor = Math.min(level, MAX_FLOOR);
    else if (level < this.floor) this.floor = this.floor * 0.5 + level * 0.5;
    else if (!loud && !this.started) this.floor = Math.min(MAX_FLOOR, this.floor + (level - this.floor) * 0.02);

    if (loud) {
      this.speechMs += frameMs;
      this.silentMs = 0;
      this.quietMs = 0;
      if (!this.started && this.speechMs >= this.o.minSpeechMs) {
        this.started = true;
        return 'speech_started';
      }
      return undefined;
    }

    if (this.started) {
      this.silentMs += frameMs;
      if (this.silentMs >= this.o.endSilenceMs) return this.finish('speech_ended');
      return undefined;
    }
    // A short burst that never became speech is forgotten, so scattered noise adds up to nothing.
    this.quietMs += frameMs;
    if (this.quietMs > 300) this.speechMs = 0;
    if (this.elapsedMs >= this.o.noSpeechMs) return this.finish('no_speech');
    return undefined;
  }

  private finish(event: EndpointEvent): EndpointEvent {
    this.done = true;
    return event;
  }
}
