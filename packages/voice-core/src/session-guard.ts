import type { ClientMessage, ProtocolErrorCode } from './protocol.js';

export type SessionPhase = 'awaiting_start' | 'starting' | 'ready' | 'closed';

export type GuardResult = { ok: true } | { ok: false; code: ProtocolErrorCode; error: string };

/**
 * Server-side order rules for one connection. The server calls `accept` for
 * every client message and `markReady` once it has sent session.ready.
 */
export class SessionGuard {
  private current: SessionPhase = 'awaiting_start';

  get phase(): SessionPhase {
    return this.current;
  }

  accept(message: ClientMessage): GuardResult {
    if (this.current === 'closed') return this.reject('connection is closed');

    if (message.type === 'session.start') {
      if (this.current !== 'awaiting_start') return this.reject('session.start was already sent');
      this.current = 'starting';
      return { ok: true };
    }
    if (this.current === 'awaiting_start') return this.reject('session.start must be the first message');
    if (message.type === 'ping') return { ok: true };
    if (message.type === 'session.end') {
      this.current = 'closed';
      return { ok: true };
    }
    if (this.current === 'starting') return this.reject('wait for session.ready before sending this message');
    return { ok: true };
  }

  /** Audio is accepted only once the session is ready. */
  acceptAudio(): GuardResult {
    return this.current === 'ready' ? { ok: true } : this.reject('audio sent before session.ready');
  }

  markReady(): void {
    if (this.current === 'starting') this.current = 'ready';
  }

  close(): void {
    this.current = 'closed';
  }

  private reject(error: string): GuardResult {
    return { ok: false, code: 'OUT_OF_ORDER', error };
  }
}
