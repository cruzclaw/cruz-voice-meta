import { LIMITS } from './protocol.js';

/**
 * Binary audio frame: an 8-byte header followed by raw PCM.
 *
 *   byte 0     frame version (1)
 *   byte 1     kind: 1 = microphone (client to server), 2 = speech (server to client)
 *   bytes 2-3  reserved, zero
 *   bytes 4-7  sequence number, unsigned big-endian, per direction
 */
export const AUDIO_FRAME_VERSION = 1;
export const AUDIO_HEADER_BYTES = 8;

export type AudioKind = 'mic' | 'speech';

export interface AudioFrame {
  kind: AudioKind;
  seq: number;
  pcm: Uint8Array;
}

const KIND_CODE: Record<AudioKind, number> = { mic: 1, speech: 2 };

export function encodeAudioFrame(frame: AudioFrame): Uint8Array {
  if (!Number.isInteger(frame.seq) || frame.seq < 0 || frame.seq > 0xffffffff) throw new RangeError('seq out of range');
  if (frame.pcm.byteLength % 2 !== 0) throw new RangeError('pcm_s16le data must be a whole number of samples');
  const total = AUDIO_HEADER_BYTES + frame.pcm.byteLength;
  if (total > LIMITS.maxAudioFrameBytes) throw new RangeError('audio frame is too large');
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint8(0, AUDIO_FRAME_VERSION);
  view.setUint8(1, KIND_CODE[frame.kind]);
  view.setUint32(4, frame.seq, false);
  out.set(frame.pcm, AUDIO_HEADER_BYTES);
  return out;
}

/** Returns null for anything that is not a well-formed frame. Never throws. */
export function decodeAudioFrame(data: Uint8Array): AudioFrame | null {
  if (data.byteLength < AUDIO_HEADER_BYTES || data.byteLength > LIMITS.maxAudioFrameBytes) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint8(0) !== AUDIO_FRAME_VERSION) return null;
  const code = view.getUint8(1);
  const kind: AudioKind | null = code === 1 ? 'mic' : code === 2 ? 'speech' : null;
  if (!kind) return null;
  if (view.getUint16(2, false) !== 0) return null;
  const pcm = data.subarray(AUDIO_HEADER_BYTES);
  if (pcm.byteLength % 2 !== 0) return null;
  return { kind, seq: view.getUint32(4, false), pcm: pcm.slice() };
}
