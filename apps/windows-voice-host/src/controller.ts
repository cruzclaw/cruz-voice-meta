import {
  displayState,
  type EndpointDetector,
  effectsFor,
  initialPanelState,
  reducePanel,
  type Command,
  type DisplayState,
  type Effect,
  type PanelEvent,
  type PanelState,
} from '@cruzclaw/windows-bridge';
import type { ClientMessage, ServerMessage } from '@cruzclaw/voice-core';

/** The microphone and speaker. Electron implements this with a hidden audio window; tests use a fake. */
export interface AudioDevice {
  startCapture(): void;
  stopCapture(): void;
  play(pcm: Uint8Array): void;
  stopPlayback(): void;
}

/** The part of VoiceClient the controller drives. */
export interface Link {
  send(message: ClientMessage): void;
  sendMic(pcm: Uint8Array): void;
}

/** After the reply text ends with no speech following, the state settles back to idle. */
const SETTLE_MS = 2000;
/** If nothing comes back after the person stops talking, stop showing "thinking". */
const NO_RESPONSE_MS = 15000;
/** Stay under the server's 60 s per-utterance cap. */
const MAX_UTTERANCE_MS = 55000;

/**
 * Turns shortcut presses, server messages and audio into the panel state, and decides
 * what to do next. The state machine and control effects come from windows-bridge.
 */
export class HostController {
  state: PanelState = initialPanelState();
  private settle: ReturnType<typeof setTimeout> | undefined;
  private cap: ReturnType<typeof setTimeout> | undefined;
  private waiting: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly link: Link,
    private readonly audio: AudioDevice,
    private readonly onChange: (state: PanelState, display: DisplayState) => void = () => undefined,
    private readonly noResponseMs = NO_RESPONSE_MS,
    /** When given, listening ends by itself once the person stops talking. */
    private readonly endpoint?: EndpointDetector,
  ) {}

  get display(): DisplayState {
    return displayState(this.state);
  }

  setConnected(connected: boolean): void {
    if (!connected) this.stopAll();
    this.dispatch({ kind: 'connection', connected });
  }

  onServer(message: ServerMessage): void {
    this.dispatch({ kind: 'server', message });
    if (message.type === 'transcript.final' || message.type === 'error' || message.type === 'session.closed') clearTimeout(this.waiting);
    if (message.type === 'tts.cancelled') this.audio.stopPlayback();
    if (message.type === 'assistant.text.done') {
      clearTimeout(this.settle);
      this.settle = setTimeout(() => this.dispatch({ kind: 'ui', action: { type: 'settle' } }), SETTLE_MS);
    }
    if (message.type === 'error' || message.type === 'session.closed') this.stopAll();
  }

  onSpeech(pcm: Uint8Array): void {
    if (this.state.phase === 'speaking') this.audio.play(pcm);
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

  /** Stops listening without waiting for a reply. The server is still told the input ended so it discards the audio. */
  private cancelListening(): void {
    if (this.state.phase !== 'listening') return;
    clearTimeout(this.cap);
    this.audio.stopCapture();
    this.link.send({ v: 1, type: 'input.end' });
    this.dispatch({ kind: 'ui', action: { type: 'listen_cancel' } });
  }

  command(command: Command): void {
    for (const effect of effectsFor(this.state, command)) this.apply(effect);
  }

  /** Stops timers and devices. Call when the app quits. */
  dispose(): void {
    this.stopAll();
  }

  private apply(effect: Effect): void {
    switch (effect.type) {
      case 'capture':
        if (effect.on) {
          this.endpoint?.reset();
          this.audio.startCapture();
          this.dispatch({ kind: 'ui', action: { type: 'listen_start' } });
          clearTimeout(this.cap);
          this.cap = setTimeout(() => this.command('summon'), MAX_UTTERANCE_MS);
        } else {
          clearTimeout(this.cap);
          this.audio.stopCapture();
          this.dispatch({ kind: 'ui', action: { type: 'listen_end' } });
          clearTimeout(this.waiting);
          this.waiting = setTimeout(() => this.dispatch({ kind: 'ui', action: { type: 'no_response' } }), this.noResponseMs);
        }
        return;
      case 'send':
        if (effect.message.type === 'interrupt') this.audio.stopPlayback();
        this.link.send(effect.message);
        return;
      case 'show':
      case 'hide':
        return; // No panel window yet.
    }
  }

  private stopAll(): void {
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
