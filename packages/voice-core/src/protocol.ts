import type { ApprovalStatus, ProgressEvent, TaskRecord } from './types.js';

/**
 * Voice session protocol, version 1.
 *
 * JSON control frames plus binary audio frames over one WebSocket. The server
 * authenticates the socket when it opens. No message carries an account,
 * tenant, user or persona identifier: identity comes from the authenticated
 * connection only (see FORBIDDEN_IDENTITY_KEYS).
 */

export const PROTOCOL_VERSION = 1;

export interface AudioFormat {
  encoding: 'pcm_s16le';
  sampleRate: 8000 | 16000 | 24000 | 48000;
  channels: 1;
}

export const ALLOWED_SAMPLE_RATES: readonly number[] = [8000, 16000, 24000, 48000];

/** Keys a client must never send. A match anywhere in a message rejects it. */
export const FORBIDDEN_IDENTITY_KEYS: readonly string[] = [
  'accountId',
  'userId',
  'tenantId',
  'organizationId',
  'personaId',
  'deploymentId',
];

export const LIMITS = {
  maxTextChars: 4000,
  maxIdChars: 128,
  maxJsonBytes: 64 * 1024,
  maxAudioFrameBytes: 64 * 1024,
} as const;

// ---- Client to server ----

/** `none` is only ever sent by a server that has no voice of its own: the client gets text only. */
export type SpeechMode = 'server' | 'device' | 'none';

export interface SessionStart {
  v: typeof PROTOCOL_VERSION;
  type: 'session.start';
  conversationId?: string;
  audio: AudioFormat;
  locale?: string;
  /**
   * Who turns the assistant's text into sound. `device` means this client speaks the text itself, so
   * the server sends no audio and no tts.* messages. Omitted means `server`.
   */
  speech?: SpeechMode;
  /** Last server seq the client processed, to resume after a reconnect. */
  resumeFromSeq?: number;
}

/** The client detected the end of the person's speech. */
export interface InputEnd {
  v: typeof PROTOCOL_VERSION;
  type: 'input.end';
  utteranceId?: string;
}

/** Stop the assistant speaking now. `correction` means the person is fixing an instruction. */
export interface Interrupt {
  v: typeof PROTOCOL_VERSION;
  type: 'interrupt';
  reason: 'barge_in' | 'user' | 'correction';
}

/** How much of a spoken reply actually played, so the server can trim context. */
export interface PlaybackProgress {
  v: typeof PROTOCOL_VERSION;
  type: 'playback.progress';
  ttsId: string;
  playedMs: number;
}

export interface TaskCancel {
  v: typeof PROTOCOL_VERSION;
  type: 'task.cancel';
  taskId: string;
}

export interface Ping {
  v: typeof PROTOCOL_VERSION;
  type: 'ping';
  t: number;
}

export interface SessionEnd {
  v: typeof PROTOCOL_VERSION;
  type: 'session.end';
}

export type ClientMessage =
  | SessionStart
  | InputEnd
  | Interrupt
  | PlaybackProgress
  | TaskCancel
  | Ping
  | SessionEnd;

// ---- Server to client ----

interface ServerBase {
  v: typeof PROTOCOL_VERSION;
  /** Per-session, strictly increasing from 1. Lets a client resume without gaps. */
  seq: number;
}

export interface SessionReady extends ServerBase {
  type: 'session.ready';
  sessionId: string;
  audio: AudioFormat;
  /** Who speaks the assistant's text in this session. Absent means `server`, as before this field existed. */
  speech?: SpeechMode;
}

export interface TranscriptPartial extends ServerBase {
  type: 'transcript.partial';
  utteranceId: string;
  text: string;
}

export interface TranscriptFinal extends ServerBase {
  type: 'transcript.final';
  utteranceId: string;
  text: string;
}

export interface AssistantTextDelta extends ServerBase {
  type: 'assistant.text.delta';
  turnId: string;
  text: string;
}

export interface AssistantTextDone extends ServerBase {
  type: 'assistant.text.done';
  turnId: string;
}

export interface TtsStart extends ServerBase {
  type: 'tts.start';
  ttsId: string;
  turnId: string;
  audio: AudioFormat;
}

export interface TtsEnd extends ServerBase {
  type: 'tts.end';
  ttsId: string;
}

/** Playback was stopped by an interrupt; the client must drop queued audio for ttsId. */
export interface TtsCancelled extends ServerBase {
  type: 'tts.cancelled';
  ttsId: string;
}

export interface TaskProposed extends ServerBase {
  type: 'task.proposed';
  task: TaskRecord;
}

export interface TaskProgress extends ServerBase {
  type: 'task.event';
  event: ProgressEvent;
}

export interface ApprovalRequested extends ServerBase {
  type: 'approval.requested';
  approval: ApprovalStatus;
  /** Plain-language description the person can hear. */
  summary: string;
}

export type ProtocolErrorCode =
  | 'INVALID_MESSAGE'
  | 'OUT_OF_ORDER'
  | 'UNSUPPORTED_VERSION'
  | 'UNAUTHENTICATED'
  | 'FEATURE_DISABLED'
  | 'RATE_LIMITED'
  | 'PROVIDER_ERROR'
  | 'INTERNAL';

export interface ProtocolError extends ServerBase {
  type: 'error';
  code: ProtocolErrorCode;
  message: string;
  retryable: boolean;
}

export interface Pong extends ServerBase {
  type: 'pong';
  t: number;
}

export interface SessionClosed extends ServerBase {
  type: 'session.closed';
  reason: 'ended' | 'timeout' | 'error' | 'disabled';
}

export type ServerMessage =
  | SessionReady
  | TranscriptPartial
  | TranscriptFinal
  | AssistantTextDelta
  | AssistantTextDone
  | TtsStart
  | TtsEnd
  | TtsCancelled
  | TaskProposed
  | TaskProgress
  | ApprovalRequested
  | ProtocolError
  | Pong
  | SessionClosed;

export type ParseResult<T> = { ok: true; message: T } | { ok: false; code: ProtocolErrorCode; error: string };
