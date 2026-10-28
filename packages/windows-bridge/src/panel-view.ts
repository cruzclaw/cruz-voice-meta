import type { DisplayState } from './panel-state.js';

/** An employee the person can talk to. */
export interface VoiceEmployee {
  id: string;
  name: string;
}

/**
 * Whether a call can be started, and if not, why. The app that owns the account decides this; the panel only says it.
 * `checking` is the short moment before the first answer. `connection_failed` is also set by the host itself while a
 * connection keeps failing, so it never has to be guessed from words.
 */
export type Readiness =
  | { state: 'checking' }
  | { state: 'ready' }
  /** The account does not have voice turned on. Nothing the person can press on this computer changes that. */
  | { state: 'voice_disabled' }
  /** The account has employees, and none is chosen for voice. */
  | { state: 'no_employee' }
  /** The account has no employee to talk to. */
  | { state: 'no_employees' }
  | { state: 'connection_failed' }
  | { state: 'signed_out' };

export type ReadinessState = Readiness['state'];

/** What the microphone is doing. These three are the only words for it, so selecting an employee can never read as a listening mic. */
export type MicState = 'off' | 'wake' | 'listening';

export const MIC_TEXT: Record<MicState, string> = {
  off: 'Mic off',
  wake: 'Wake listening',
  listening: 'Listening to you',
};

/** The microphone is open for the conversation, or only for the wake phrase on this computer, or closed. */
export function micState(display: DisplayState, wakeListening: boolean): MicState {
  if (display === 'listening') return 'listening';
  return wakeListening ? 'wake' : 'off';
}

/** Only a ready account can start a call. Every other state says what is missing instead. */
export const canCall = (r: Readiness): boolean => r.state === 'ready';

/** The line in the empty conversation area. It names only controls that exist in that state. */
export function emptyText(r: Readiness, shortcut: string): string {
  switch (r.state) {
    case 'checking':
      return 'Checking your account…';
    case 'ready':
      return shortcut ? `Press Call or ${shortcut} to start.` : 'Press Call to start.';
    case 'voice_disabled':
      return 'Voice is not turned on for your account yet.';
    case 'no_employee':
      return 'Choose which employee to talk to.';
    case 'no_employees':
      return 'Your account has no employee to talk to yet.';
    case 'connection_failed':
      return 'Cannot reach CruzClaw right now. It will keep trying.';
    case 'signed_out':
      return 'Sign in to CruzClaw to use voice.';
  }
}

/** The short words on the bar, and under the orb in the full panel. */
export function caption(r: Readiness, display: DisplayState, stateText: string, employeeName: string | undefined): string {
  const who = employeeName ? `${employeeName} · ` : '';
  switch (r.state) {
    // The chosen employee stays in the words in every state that has one, so it never reads as if nobody is chosen.
    case 'checking':
      return `${who}Checking…`;
    case 'voice_disabled':
      return `${who}Voice not enabled`;
    case 'no_employee':
      return 'Choose employee';
    case 'no_employees':
      return 'No employee';
    case 'signed_out':
      return 'Signed out';
    case 'connection_failed':
      return `${who}Cannot connect`;
    case 'ready':
      // A call connects when it is pressed, so before that the honest word is Ready, not Not connected.
      return `${who}${display === 'disconnected' ? 'Ready' : stateText}`;
  }
}

/** The employee to show: the chosen one, only if the account still has them. */
export function chosenEmployee(employees: readonly VoiceEmployee[], selectedId: string | undefined): VoiceEmployee | undefined {
  return selectedId ? employees.find((e) => e.id === selectedId) : undefined;
}

/** Keeps only well-formed entries, so nothing odd can reach the panel page. */
export function cleanEmployees(raw: unknown): VoiceEmployee[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: VoiceEmployee[] = [];
  for (const item of raw) {
    const { id, name } = (item ?? {}) as { id?: unknown; name?: unknown };
    if (typeof id !== 'string' || !id || typeof name !== 'string' || !name.trim() || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: name.trim().slice(0, 60) });
  }
  return out.slice(0, 50);
}

const STATES: readonly ReadinessState[] = ['checking', 'ready', 'voice_disabled', 'no_employee', 'no_employees', 'connection_failed', 'signed_out'];

/** Accepts only a known state. Anything else becomes "checking", never "ready", so a wrong value cannot enable Call. */
export function cleanReadiness(raw: unknown): Readiness {
  const state = (raw as { state?: unknown } | undefined)?.state;
  return { state: STATES.includes(state as ReadinessState) ? (state as ReadinessState) : 'checking' } as Readiness;
}
