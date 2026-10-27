/**
 * Messages between the host and the speech process, the separate process that runs the voice model.
 * It is separate because the speech model and the wake phrase detector each load their own copy of
 * the ONNX runtime, and two copies cannot live in one process.
 */

export type ToSpeech =
  | { type: 'speak'; id: number; text: string }
  | { type: 'cancel'; id: number }
  /** Loads the model now so the first reply is not slowed by it. */
  | { type: 'warm' };

export type FromSpeech =
  | { type: 'chunk'; id: number; pcm: Uint8Array }
  | { type: 'done'; id: number }
  | { type: 'error'; id: number; message: string }
  | { type: 'warm'; ok: boolean; message?: string };

/** The one end of a channel to the other process. Electron's parentPort and a utility process both fit. */
export interface Endpoint<Out, In> {
  post(message: Out): void;
  onMessage(listener: (message: In) => void): void;
}
