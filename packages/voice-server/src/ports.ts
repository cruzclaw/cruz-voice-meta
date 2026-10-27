import type { AudioFormat } from '@cruzclaw/voice-core';

/** Speech to text for one finished utterance. Real providers stream; this keeps the port small. */
export interface Transcriber {
  transcribe(pcm: Uint8Array, format: AudioFormat, signal: AbortSignal): Promise<string>;
}

export type ReasonerEvent =
  | { type: 'text'; text: string }
  | {
      type: 'task';
      intent: string;
      params: Record<string, unknown>;
      /** When set, the action needs an owner approval before anything happens. */
      approval?: { kind: string; payload: Record<string, unknown>; summary: string };
    };

export interface ReasonerInput {
  utterance: string;
  conversationId: string;
}

/** Decides what to say and which task to propose. Never performs the task. */
export interface Reasoner {
  respond(input: ReasonerInput, signal: AbortSignal): AsyncIterable<ReasonerEvent>;
}

/** Text to speech. Output must be pcm_s16le mono at the requested format. */
export interface Synthesizer {
  synthesize(text: string, format: AudioFormat, signal: AbortSignal): AsyncIterable<Uint8Array>;
}

export interface Providers {
  transcriber: Transcriber;
  reasoner: Reasoner;
  /** Without one, a client that does not speak the text itself gets text only. */
  synthesizer?: Synthesizer;
}
