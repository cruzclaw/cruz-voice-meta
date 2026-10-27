import {
  HostError,
  SessionGuard,
  decodeAudioFrame,
  encodeAudioFrame,
  parseClientMessage,
  type AudioFormat,
  type ClientMessage,
  type ProtocolErrorCode,
  type ServerMessage,
  type VoiceEmployeeHost,
  type VoiceFeatureConfig,
} from '@cruzclaw/voice-core';
import type { Providers, ReasonerEvent } from './ports.js';

/** What a session needs from its connection. Keeps session logic testable without a socket. */
export interface SessionTransport {
  sendJson(message: ServerMessage): void;
  sendAudio(frame: Uint8Array): void;
  close(): void;
}

export interface SessionOptions {
  sessionId: string;
  /** Already bound to the authenticated person by the server. */
  host: VoiceEmployeeHost;
  providers: Providers;
  transport: SessionTransport;
  features: VoiceFeatureConfig;
  /** Called once a task, and its approval if any, has been fully registered. */
  onTaskReady?: (taskId: string) => void;
  maxUtteranceSeconds?: number;
}

type NewServerMessage = ServerMessage extends infer M ? (M extends ServerMessage ? Omit<M, 'v' | 'seq'> : never) : never;

const MAX_SPEECH_CHUNK_BYTES = 32 * 1024;

export class VoiceSession {
  private readonly guard = new SessionGuard();
  private format: AudioFormat | undefined;
  private conversationId = '';
  private seq = 0;
  private audioSeq = 0;
  private utteranceCount = 0;
  private turnCount = 0;
  private mic: Uint8Array[] = [];
  private micBytes = 0;
  private turn: AbortController | undefined;
  private readonly unsubscribers: Array<() => void> = [];
  private closed = false;

  constructor(private readonly opts: SessionOptions) {}

  /** Handle one JSON text frame. Never throws. */
  handleText(raw: string): void {
    if (this.closed) return;
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) return this.error(parsed.code, parsed.error, false);
    const guarded = this.guard.accept(parsed.message);
    if (!guarded.ok) return this.error(guarded.code, guarded.error, false);
    this.dispatch(parsed.message);
  }

  /** Handle one binary audio frame. Never throws. */
  handleBinary(data: Uint8Array): void {
    if (this.closed) return;
    const guarded = this.guard.acceptAudio();
    if (!guarded.ok) return this.error(guarded.code, guarded.error, false);
    const frame = decodeAudioFrame(data);
    if (!frame || frame.kind !== 'mic') return this.error('INVALID_MESSAGE', 'malformed microphone frame', false);
    const maxBytes = (this.opts.maxUtteranceSeconds ?? 60) * (this.format?.sampleRate ?? 16000) * 2;
    if (this.micBytes + frame.pcm.byteLength > maxBytes) {
      this.mic = [];
      this.micBytes = 0;
      return this.error('INVALID_MESSAGE', 'utterance is too long; send input.end sooner', false);
    }
    this.mic.push(frame.pcm);
    this.micBytes += frame.pcm.byteLength;
  }

  /** The connection dropped or the server is stopping. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.turn?.abort();
    this.unsubscribers.splice(0).forEach((fn) => fn());
    this.guard.close();
  }

  private dispatch(message: ClientMessage): void {
    switch (message.type) {
      case 'session.start':
        return this.start(message);
      case 'input.end':
        return this.endInput(message.utteranceId);
      case 'interrupt':
        this.turn?.abort();
        return;
      case 'task.cancel':
        void this.guarded(async () => {
          await this.opts.host.cancelTask(message.taskId);
        });
        return;
      case 'ping':
        return this.send({ type: 'pong', t: message.t });
      case 'playback.progress':
        return; // The demo keeps no per-reply context to trim.
      case 'session.end':
        this.send({ type: 'session.closed', reason: 'ended' });
        this.close();
        this.opts.transport.close();
        return;
    }
  }

  private start(message: Extract<ClientMessage, { type: 'session.start' }>): void {
    if (!this.opts.features.voiceEnabled) {
      this.error('FEATURE_DISABLED', 'voice is not enabled for this account', false);
      this.send({ type: 'session.closed', reason: 'disabled' });
      this.close();
      this.opts.transport.close();
      return;
    }
    this.format = message.audio;
    this.conversationId = message.conversationId ?? `conv-${this.opts.sessionId}`;
    this.guard.markReady();
    this.send({ type: 'session.ready', sessionId: this.opts.sessionId, audio: message.audio });
  }

  private endInput(requestedId: string | undefined): void {
    const chunks = this.mic;
    const total = this.micBytes;
    this.mic = [];
    this.micBytes = 0;
    if (total === 0) return;
    const pcm = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      pcm.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.turn?.abort();
    const utteranceId = requestedId ?? `utt-${++this.utteranceCount}`;
    const controller = new AbortController();
    this.turn = controller;
    void this.runTurn(pcm, utteranceId, controller);
  }

  private async runTurn(pcm: Uint8Array, utteranceId: string, controller: AbortController): Promise<void> {
    const { signal } = controller;
    const format = this.format!;
    await this.guarded(async () => {
      const utterance = await this.opts.providers.transcriber.transcribe(pcm, format, signal);
      if (signal.aborted || !utterance.trim()) return;
      this.send({ type: 'transcript.final', utteranceId, text: utterance });

      const turnId = `turn-${++this.turnCount}`;
      let reply = '';
      const tasks: Array<Extract<ReasonerEvent, { type: 'task' }>> = [];
      for await (const event of this.opts.providers.reasoner.respond(
        { utterance, conversationId: this.conversationId },
        signal,
      )) {
        if (signal.aborted) return;
        if (event.type === 'text') {
          reply += event.text;
          this.send({ type: 'assistant.text.delta', turnId, text: event.text });
        } else {
          tasks.push(event);
        }
      }
      this.send({ type: 'assistant.text.done', turnId });

      for (const [index, task] of tasks.entries()) {
        await this.proposeTask(task, `${this.opts.sessionId}:${utteranceId}:${index}`, utterance);
      }
      await this.speak(reply, turnId, signal);
    }, controller);
    if (this.turn === controller) this.turn = undefined;
  }

  private async proposeTask(
    event: Extract<ReasonerEvent, { type: 'task' }>,
    key: string,
    utterance: string,
  ): Promise<void> {
    const { host } = this.opts;
    const task = await host.proposeTask({
      idempotencyKey: key,
      conversationId: this.conversationId,
      utterance,
      intent: event.intent,
      params: event.params,
    });
    this.send({ type: 'task.proposed', task });
    this.unsubscribers.push(
      host.subscribeProgress(task.taskId, (progress) => {
        if (!this.closed) this.send({ type: 'task.event', event: progress });
      }),
    );
    if (event.approval) {
      const approval = await host.requestApproval({
        idempotencyKey: `${key}:approval`,
        taskId: task.taskId,
        kind: event.approval.kind,
        payload: event.approval.payload,
      });
      this.send({ type: 'approval.requested', approval, summary: event.approval.summary });
    }
    this.opts.onTaskReady?.(task.taskId);
  }

  private async speak(text: string, turnId: string, signal: AbortSignal): Promise<void> {
    if (!text.trim() || signal.aborted) return;
    const format = this.format!;
    const ttsId = `tts-${turnId}`;
    this.send({ type: 'tts.start', ttsId, turnId, audio: format });
    for await (const chunk of this.opts.providers.synthesizer.synthesize(text, format, signal)) {
      if (signal.aborted) break;
      for (let at = 0; at < chunk.byteLength; at += MAX_SPEECH_CHUNK_BYTES) {
        this.opts.transport.sendAudio(
          encodeAudioFrame({ kind: 'speech', seq: this.audioSeq++, pcm: chunk.subarray(at, at + MAX_SPEECH_CHUNK_BYTES) }),
        );
      }
    }
    this.send({ type: signal.aborted ? 'tts.cancelled' : 'tts.end', ttsId });
  }

  /** Runs async work and turns failures into protocol errors instead of crashes. */
  private async guarded(work: () => Promise<void>, controller?: AbortController): Promise<void> {
    try {
      await work();
    } catch (e) {
      if (controller?.signal.aborted || this.closed) return;
      if (e instanceof HostError) return this.error('INTERNAL', `${e.code}: ${e.message}`, false);
      this.error('PROVIDER_ERROR', 'a speech or reasoning provider failed', true);
    }
  }

  private send(message: NewServerMessage): void {
    if (this.closed && message.type !== 'session.closed') return;
    this.opts.transport.sendJson({ v: 1, seq: ++this.seq, ...message } as ServerMessage);
  }

  private error(code: ProtocolErrorCode, message: string, retryable: boolean): void {
    this.send({ type: 'error', code, message, retryable });
  }
}
