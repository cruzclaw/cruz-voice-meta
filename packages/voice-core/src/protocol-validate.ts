import {
  ALLOWED_SAMPLE_RATES,
  FORBIDDEN_IDENTITY_KEYS,
  LIMITS,
  PROTOCOL_VERSION,
  type AudioFormat,
  type ClientMessage,
  type ParseResult,
  type ProtocolErrorCode,
  type ServerMessage,
  type SpeechMode,
} from './protocol.js';

type Obj = Record<string, unknown>;

class Reject extends Error {
  constructor(
    public readonly code: ProtocolErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const bad = (message: string): never => {
  throw new Reject('INVALID_MESSAGE', message);
};

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function str(o: Obj, key: string, max: number = LIMITS.maxIdChars, optional = false): string | undefined {
  const v = o[key];
  if (v === undefined && optional) return undefined;
  if (typeof v !== 'string' || v.length === 0) return bad(`${key} must be a non-empty string`);
  if (v.length > max) return bad(`${key} is too long`);
  return v;
}

function int(o: Obj, key: string, optional = false): number | undefined {
  const v = o[key];
  if (v === undefined && optional) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return bad(`${key} must be a non-negative integer`);
  return v;
}

function obj(o: Obj, key: string): Obj {
  const v = o[key];
  if (!isObj(v)) return bad(`${key} must be an object`);
  return v;
}

/** Rejects identity keys at any depth, so identity can only come from the connection. */
function rejectIdentityKeys(value: unknown, depth = 0): void {
  if (depth > 8) bad('message is nested too deeply');
  if (Array.isArray(value)) {
    value.forEach((item) => rejectIdentityKeys(item, depth + 1));
  } else if (isObj(value)) {
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_IDENTITY_KEYS.includes(key)) bad(`${key} must not be sent by a client`);
      rejectIdentityKeys(value[key], depth + 1);
    }
  }
}

function audio(o: Obj): AudioFormat {
  const a = obj(o, 'audio');
  if (a.encoding !== 'pcm_s16le') bad('audio.encoding must be pcm_s16le');
  if (typeof a.sampleRate !== 'number' || !ALLOWED_SAMPLE_RATES.includes(a.sampleRate)) {
    bad('audio.sampleRate is not supported');
  }
  if (a.channels !== 1) bad('audio.channels must be 1');
  return { encoding: 'pcm_s16le', sampleRate: a.sampleRate as AudioFormat['sampleRate'], channels: 1 };
}

function speechMode(o: Obj, allowed: SpeechMode[]): SpeechMode | undefined {
  const v = o.speech;
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !allowed.includes(v as SpeechMode)) return bad('speech is not a supported mode');
  return v as SpeechMode;
}

function parseJson(raw: string | unknown): unknown {
  if (typeof raw !== 'string') return raw;
  if (raw.length > LIMITS.maxJsonBytes) throw new Reject('INVALID_MESSAGE', 'message is too large');
  try {
    return JSON.parse(raw);
  } catch {
    throw new Reject('INVALID_MESSAGE', 'message is not valid JSON');
  }
}

function envelope(value: unknown): Obj {
  if (!isObj(value)) return bad('message must be an object');
  if (value.v !== PROTOCOL_VERSION) throw new Reject('UNSUPPORTED_VERSION', `protocol version must be ${PROTOCOL_VERSION}`);
  if (typeof value.type !== 'string') return bad('type is required');
  return value;
}

function wrap<T>(fn: () => T): ParseResult<T> {
  try {
    return { ok: true, message: fn() };
  } catch (e) {
    if (e instanceof Reject) return { ok: false, code: e.code, error: e.message };
    throw e;
  }
}

/** Parse and validate one client frame (a JSON string or an already-parsed value). */
export function parseClientMessage(raw: string | unknown): ParseResult<ClientMessage> {
  return wrap(() => {
    const o = envelope(parseJson(raw));
    rejectIdentityKeys(o);
    switch (o.type) {
      case 'session.start': {
        const msg: ClientMessage = { v: PROTOCOL_VERSION, type: 'session.start', audio: audio(o) };
        const conversationId = str(o, 'conversationId', LIMITS.maxIdChars, true);
        const locale = str(o, 'locale', 35, true);
        const resumeFromSeq = int(o, 'resumeFromSeq', true);
        const speech = speechMode(o, ['server', 'device']);
        if (speech !== undefined) msg.speech = speech;
        if (conversationId !== undefined) msg.conversationId = conversationId;
        if (locale !== undefined) msg.locale = locale;
        if (resumeFromSeq !== undefined) msg.resumeFromSeq = resumeFromSeq;
        return msg;
      }
      case 'input.end': {
        const utteranceId = str(o, 'utteranceId', LIMITS.maxIdChars, true);
        return utteranceId === undefined
          ? { v: PROTOCOL_VERSION, type: 'input.end' }
          : { v: PROTOCOL_VERSION, type: 'input.end', utteranceId };
      }
      case 'interrupt':
        if (o.reason !== 'barge_in' && o.reason !== 'user' && o.reason !== 'correction') bad('reason is not valid');
        return { v: PROTOCOL_VERSION, type: 'interrupt', reason: o.reason as 'barge_in' | 'user' | 'correction' };
      case 'playback.progress':
        return {
          v: PROTOCOL_VERSION,
          type: 'playback.progress',
          ttsId: str(o, 'ttsId') as string,
          playedMs: int(o, 'playedMs') as number,
        };
      case 'task.cancel':
        return { v: PROTOCOL_VERSION, type: 'task.cancel', taskId: str(o, 'taskId') as string };
      case 'ping':
        if (typeof o.t !== 'number' || !Number.isFinite(o.t)) bad('t must be a number');
        return { v: PROTOCOL_VERSION, type: 'ping', t: o.t as number };
      case 'session.end':
        return { v: PROTOCOL_VERSION, type: 'session.end' };
      default:
        return bad(`unknown message type ${JSON.stringify(String(o.type).slice(0, 40))}`);
    }
  });
}

/** Parse and validate one server frame on the client side. Nested host records are checked as objects only. */
export function parseServerMessage(raw: string | unknown): ParseResult<ServerMessage> {
  return wrap(() => {
    const o = envelope(parseJson(raw));
    const seq = int(o, 'seq') as number;
    if (seq < 1) bad('seq must start at 1');
    const base = { v: PROTOCOL_VERSION, seq } as const;
    switch (o.type) {
      case 'session.ready':
      {
        const speech = speechMode(o, ['server', 'device', 'none']);
        return {
          ...base,
          type: 'session.ready',
          sessionId: str(o, 'sessionId') as string,
          audio: audio(o),
          ...(speech === undefined ? {} : { speech }),
        };
      }
      case 'transcript.partial':
      case 'transcript.final':
        return {
          ...base,
          type: o.type,
          utteranceId: str(o, 'utteranceId') as string,
          text: str(o, 'text', LIMITS.maxTextChars) as string,
        };
      case 'assistant.text.delta':
        return { ...base, type: 'assistant.text.delta', turnId: str(o, 'turnId') as string, text: str(o, 'text', LIMITS.maxTextChars) as string };
      case 'assistant.text.done':
        return { ...base, type: 'assistant.text.done', turnId: str(o, 'turnId') as string };
      case 'tts.start':
        return { ...base, type: 'tts.start', ttsId: str(o, 'ttsId') as string, turnId: str(o, 'turnId') as string, audio: audio(o) };
      case 'tts.end':
      case 'tts.cancelled':
        return { ...base, type: o.type, ttsId: str(o, 'ttsId') as string };
      case 'task.proposed':
        return { ...base, type: 'task.proposed', task: obj(o, 'task') as never };
      case 'task.event':
        return { ...base, type: 'task.event', event: obj(o, 'event') as never };
      case 'approval.requested':
        return {
          ...base,
          type: 'approval.requested',
          approval: obj(o, 'approval') as never,
          summary: str(o, 'summary', LIMITS.maxTextChars) as string,
        };
      case 'error':
        if (typeof o.retryable !== 'boolean') bad('retryable must be a boolean');
        return {
          ...base,
          type: 'error',
          code: str(o, 'code', 40) as ProtocolErrorCode,
          message: str(o, 'message', LIMITS.maxTextChars) as string,
          retryable: o.retryable as boolean,
        };
      case 'pong':
        if (typeof o.t !== 'number') bad('t must be a number');
        return { ...base, type: 'pong', t: o.t as number };
      case 'session.closed':
        if (!['ended', 'timeout', 'error', 'disabled'].includes(String(o.reason))) bad('reason is not valid');
        return { ...base, type: 'session.closed', reason: o.reason as 'ended' | 'timeout' | 'error' | 'disabled' };
      default:
        return bad(`unknown message type ${JSON.stringify(String(o.type).slice(0, 40))}`);
    }
  });
}
