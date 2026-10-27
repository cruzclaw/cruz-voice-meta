import {
  displayState,
  effectsFor,
  initialPanelState,
  reducePanel,
  type Command,
  type DisplayState,
  type Effect,
  type EndpointDetector,
  type PanelEvent,
  type PanelState,
} from '@cruzclaw/windows-bridge';
import type { ClientMessage, ServerMessage } from '@cruzclaw/voice-core';

export type ChimeKind = 'listening' | 'thinking' | 'cancelled';

/** The microphone and speaker. Electron implements this with a hidden audio window; tests use a fake. */
export interface AudioDevice {
  startCapture(): void;
  stopCapture(): void;
  play(pcm: Uint8Array): void;
  stopPlayback(): void;
  /** True while speech is still coming out of the speaker, even after the server has finished sending it. */
  isPlaying(): boolean;
  /** A short tone, not speech. Capture started right after a chime waits for it to finish. */
  chime(kind: ChimeKind): void;
}

/** The part of VoiceClient the controller drives. */
export interface Link {
  send(message: ClientMessage): void;
  sendMic(pcm: Uint8Array): void;
  /** Starts a session, which makes the server speak its greeting. `fresh` replaces a session that is already active. */
  startSession(fresh: boolean): Promise<void>;
}

export interface ControllerOptions {
  onChange?: (state: PanelState, display: DisplayState) => void;
  /** When given, listening ends by itself once the person stops talking. */
  endpoint?: EndpointDetector;
  /** If nothing comes back after the person stops talking, stop showing "thinking". */
  noResponseMs?: number;
  /** A press after this long without activity starts a new session, with a new greeting. */
  idleGreetMs?: number;
  now?: () => number;
}

/** After the reply text ends with no speech following, the state settles back to idle. */
const SETTLE_MS = 2000;
const NO_RESPONSE_MS = 15000;
const IDLE_GREET_MS = 15 * 60 * 1000;
/** Stay under the server's 60 s per-utterance cap. */
const MAX_UTTERANCE_MS = 55000;

/** Messages about a reply that was cut off. They can still arrive after the interrupt was sent. */
const REPLY_MESSAGES: ReadonlyArray<ServerMessage['type']> = ['assistant.text.delta', 'assistant.text.done', 'tts.start', 'tts.end', 'tts.cancelled'];

/**
 * Turns shortcut presses, server messages and audio into the panel state, and decides
 * what to do next. The state machine and control effects come from windows-bridge.
 */
export class HostController {
  state: PanelState = initialPanelState();
  private readonly onChange: NonNullable<ControllerOptions['onChange']>;
  private readonly endpoint: EndpointDetector | undefined;
  private readonly noResponseMs: number;
  private readonly idleGreetMs: number;
  private readonly now: () => number;
  private settle: ReturnType<typeof setTimeout> | undefined;
  private cap: ReturnType<typeof setTimeout> | undefined;
  private waiting: ReturnType<typeof setTimeout> | undefined;
  private lastActivity = 0;
  private starting = false;
  /** True from the start of a session until the greeting has been spoken or skipped. */
  private greeting = false;
  /** The greeting was fully sent but is still playing; listening starts when the speaker falls silent. */
  private listenWhenDrained = false;
  private utteranceCount = 0;
  private expectedUtterance: string | undefined;
  /** After an interrupt, replies from the cut-off turn are ignored until the next utterance is recognised. */
  private discardReply = false;

  constructor(
    private readonly link: Link,
    private readonly audio: AudioDevice,
    options: ControllerOptions = {},
  ) {
    this.onChange = options.onChange ?? (() => undefined);
    this.endpoint = options.endpoint;
    this.noResponseMs = options.noResponseMs ?? NO_RESPONSE_MS;
    this.idleGreetMs = options.idleGreetMs ?? IDLE_GREET_MS;
    this.now = options.now ?? Date.now;
  }

  get display(): DisplayState {
    return displayState(this.state);
  }

  setConnected(connected: boolean): void {
    if (!connected) this.stopAll();
    this.dispatch({ kind: 'connection', connected });
  }

  onServer(message: ServerMessage): void {
    this.lastActivity = this.now();
    // A recognised utterance that is not the latest one belongs to a turn the person already left.
    if ((message.type === 'transcript.final' || message.type === 'transcript.partial') && this.expectedUtterance && message.utteranceId !== this.expectedUtterance) return;
    if (message.type === 'transcript.final' || message.type === 'session.ready') this.discardReply = false;
    if (this.discardReply && REPLY_MESSAGES.includes(message.type)) return;

    this.dispatch({ kind: 'server', message });
    if (message.type === 'transcript.final' || message.type === 'error' || message.type === 'session.closed') clearTimeout(this.waiting);
    if (message.type === 'tts.cancelled') this.audio.stopPlayback();
    if (message.type === 'assistant.text.done') {
      clearTimeout(this.settle);
      this.settle = setTimeout(() => this.dispatch({ kind: 'ui', action: { type: 'settle' } }), SETTLE_MS);
    }
    if (message.type === 'tts.end' && this.greeting) {
      // The greeting has been sent, not necessarily heard. Opening the microphone while it still
      // plays would record the greeting as the person's speech.
      this.greeting = false;
      if (this.audio.isPlaying()) this.listenWhenDrained = true;
      else this.command('summon');
    }
    if (message.type === 'error' || message.type === 'session.closed') {
      this.greeting = false;
      this.stopAll();
    }
  }

  /** The speaker has finished everything it was given. */
  onPlaybackDrained(): void {
    if (!this.listenWhenDrained) return;
    this.listenWhenDrained = false;
    this.command('summon');
  }

  onSpeech(pcm: Uint8Array): void {
    if (this.state.phase === 'speaking' && !this.discardReply) this.audio.play(pcm);
  }

  /** Microphone frames only travel while the person is actually being listened to. */
  onMic(pcm: Uint8Array): void {
    if (this.state.phase === 'listening') this.link.sendMic(pcm);
  }

  /** One microphone level per frame while listening. Ends or drops the turn when the person goes quiet. */
  onLevel(level: number): void {
    if (this.state.phase !== 'listening' || !this.endpoint) return;
    const event = this.endpoint.feed(level);
    if (event === 'speech_ended') this.command('summon');
    else if (event === 'no_speech') this.cancelListening();
  }

  command(command: Command): void {
    if (command === 'summon' && this.needsSession()) {
      this.lastActivity = this.now();
      void this.beginSession();
      return;
    }
    this.lastActivity = this.now();
    for (const effect of effectsFor(this.state, command)) this.apply(effect);
  }

  /** Stops timers and devices. Call when the app quits. */
  dispose(): void {
    this.stopAll();
  }

  /** The first press, and the first press after a long quiet spell, starts a session so the assistant greets the person. */
  private needsSession(): boolean {
    if (!this.state.connected || this.starting) return false;
    return !this.state.sessionActive || this.now() - this.lastActivity > this.idleGreetMs;
  }

  private async beginSession(): Promise<void> {
    this.starting = true;
    const fresh = this.state.sessionActive;
    try {
      // Set before the session starts: the greeting begins as soon as the server says ready.
      this.greeting = true;
      this.discardReply = false;
      this.expectedUtterance = undefined;
      await this.link.startSession(fresh);
    } catch (e) {
      this.greeting = false;
      this.dispatch({ kind: 'ui', action: { type: 'session_failed', message: e instanceof Error ? e.message : 'Could not start the session' } });
    } finally {
      this.starting = false;
    }
  }

  /** Stops listening without waiting for a reply. The server is still told the input ended so it discards the audio. */
  private cancelListening(): void {
    if (this.state.phase !== 'listening') return;
    clearTimeout(this.cap);
    this.audio.stopCapture();
    this.audio.chime('cancelled');
    this.sendInputEnd();
    this.dispatch({ kind: 'ui', action: { type: 'listen_cancel' } });
  }

  private sendInputEnd(): void {
    // Each utterance gets an id so a late answer to an earlier one cannot be mistaken for this one.
    const utteranceId = `host-${++this.utteranceCount}`;
    this.expectedUtterance = utteranceId;
    this.link.send({ v: 1, type: 'input.end', utteranceId });
  }

  private apply(effect: Effect): void {
    switch (effect.type) {
      case 'capture':
        if (effect.on) {
          this.endpoint?.reset();
          this.greeting = false;
          this.listenWhenDrained = false;
          // Anything still playing would be heard by the microphone as the person speaking.
          this.audio.stopPlayback();
          this.audio.chime('listening');
          this.audio.startCapture();
          this.dispatch({ kind: 'ui', action: { type: 'listen_start' } });
          clearTimeout(this.cap);
          this.cap = setTimeout(() => this.command('summon'), MAX_UTTERANCE_MS);
        } else {
          clearTimeout(this.cap);
          this.audio.stopCapture();
          this.audio.chime('thinking');
          this.dispatch({ kind: 'ui', action: { type: 'listen_end' } });
          clearTimeout(this.waiting);
          this.waiting = setTimeout(() => this.dispatch({ kind: 'ui', action: { type: 'no_response' } }), this.noResponseMs);
        }
        return;
      case 'send':
        if (effect.message.type === 'input.end') {
          this.sendInputEnd();
          return;
        }
        if (effect.message.type === 'interrupt') {
          this.audio.stopPlayback();
          this.discardReply = true;
          this.listenWhenDrained = false;
          // Nothing recognised before the next utterance ends can be for it.
          this.expectedUtterance = 'interrupted';
          this.greeting = false;
          clearTimeout(this.settle);
          clearTimeout(this.waiting);
          this.dispatch({ kind: 'ui', action: { type: 'interrupted' } });
        }
        this.link.send(effect.message);
        return;
      case 'show':
      case 'hide':
        return; // The panel is shown by the shell.
    }
  }

  private stopAll(): void {
    this.listenWhenDrained = false;
    clearTimeout(this.cap);
    clearTimeout(this.settle);
    clearTimeout(this.waiting);
    this.audio.stopCapture();
    this.audio.stopPlayback();
  }

  private dispatch(event: PanelEvent): void {
    this.state = reducePanel(this.state, event);
    this.onChange(this.state, this.display);
  }
}
