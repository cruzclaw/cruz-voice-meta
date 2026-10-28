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

/** A tool the host adds to the reasoner, on top of proposing tasks. */
export interface ReasonerTool {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
}

/**
 * What a host can add to a reasoner without changing it: facts for each turn, and tools of its own.
 * Both are written by the host. Nothing the person says, and nothing in the data the host reads out,
 * can change them.
 */
export interface ReasonerExtension {
  /**
   * Facts for this one turn. They go into the instructions for this request only and are not remembered.
   * If it throws, the reasoner tells the model the facts are unavailable instead of guessing.
   */
  context?(input: ReasonerInput, signal: AbortSignal): Promise<string | undefined>;
  tools?: ReadonlyArray<ReasonerTool>;
  /**
   * Runs a call the model made to one of `tools`. The arguments are untrusted model output: check them.
   * The events it returns are spoken and shown as they are, so text from a source such as a message is
   * read out by the host and never passes through the model.
   */
  call?(name: string, args: unknown, input: ReasonerInput, signal: AbortSignal): Promise<ReadonlyArray<ReasonerEvent>>;
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
