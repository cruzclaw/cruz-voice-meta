import type { ClientMessage, ProgressEvent, ServerMessage, TaskState } from '@cruzclaw/voice-core';

/** What the panel shows. Chosen from the state below by `displayState`. */
export type DisplayState =
  | 'disconnected'
  | 'awaiting_approval'
  | 'speaking'
  | 'thinking'
  | 'listening'
  | 'task_working'
  | 'idle';

export type TurnPhase = 'idle' | 'listening' | 'thinking' | 'speaking';

export interface TaskView {
  taskId: string;
  intent: string;
  state: TaskState;
  /** Plain words for the person. "Done" appears only once the host reports confirmed. */
  label: string;
  approval?: { approvalId: string; summary: string };
}

export interface PanelState {
  connected: boolean;
  sessionActive: boolean;
  phase: TurnPhase;
  /** Set once the reply text finished, until speech starts or the panel settles. */
  replyDone: boolean;
  micMuted: boolean;
  visible: boolean;
  transcript: string;
  reply: string;
  tasks: TaskView[];
  selectedTaskId: string | undefined;
  lastError: { code: string; message: string; retryable: boolean } | undefined;
  lastSeq: number;
}

export const initialPanelState = (): PanelState => ({
  connected: false,
  sessionActive: false,
  phase: 'idle',
  replyDone: false,
  micMuted: false,
  visible: false,
  transcript: '',
  reply: '',
  tasks: [],
  selectedTaskId: undefined,
  lastError: undefined,
  lastSeq: 0,
});

export type UiAction =
  | { type: 'listen_start' }
  | { type: 'listen_end' }
  | { type: 'toggle_mute' }
  | { type: 'select_task'; taskId: string }
  | { type: 'show' }
  | { type: 'hide' }
  /** The shell calls this a moment after the reply text ends if no speech began. */
  | { type: 'settle' }
  /** The shell calls this when nothing was recognised and the server stayed silent. */
  | { type: 'no_response' }
  /** The person pressed to talk but said nothing, so listening was dropped. */
  | { type: 'listen_cancel' }
  /** The person cut the assistant off, while it was thinking or speaking. */
  | { type: 'interrupted' }
  /** A session could not be opened. */
  | { type: 'session_failed'; message: string };

export type PanelEvent =
  | { kind: 'server'; message: ServerMessage }
  | { kind: 'connection'; connected: boolean }
  | { kind: 'ui'; action: UiAction };

const TERMINAL: readonly TaskState[] = ['confirmed', 'cancelled', 'rejected', 'failed'];

export const isTerminal = (state: TaskState): boolean => TERMINAL.includes(state);

/** Honest wording: nothing reads as finished before the host says confirmed. */
export function taskLabel(state: TaskState): string {
  switch (state) {
    case 'proposed':
      return 'Proposed';
    case 'accepted':
      return 'Queued';
    case 'dispatched':
      return 'Working on it';
    case 'confirmed':
      return 'Done';
    case 'cancelled':
      return 'Cancelled';
    case 'rejected':
      return 'Not approved';
    case 'failed':
      return 'Failed';
  }
}

export function displayState(s: PanelState): DisplayState {
  if (!s.connected) return 'disconnected';
  if (s.tasks.some((t) => t.approval && !isTerminal(t.state))) return 'awaiting_approval';
  if (s.phase === 'speaking') return 'speaking';
  if (s.phase === 'thinking') return 'thinking';
  if (s.phase === 'listening') return 'listening';
  if (s.tasks.some((t) => !isTerminal(t.state))) return 'task_working';
  return 'idle';
}

function applyTaskEvent(tasks: TaskView[], event: ProgressEvent): TaskView[] {
  return tasks.map((t) => {
    if (t.taskId !== event.taskId) return t;
    const next: TaskView = { ...t, state: event.state, label: taskLabel(event.state) };
    // Once the host moves past waiting, the approval prompt is no longer open.
    if (event.state !== 'proposed' && event.state !== 'accepted') delete next.approval;
    return next;
  });
}

function reduceServer(s: PanelState, m: ServerMessage): PanelState {
  switch (m.type) {
    case 'session.ready':
      // A new session starts a fresh conversation on screen, so its greeting does not join the last reply.
      return { ...s, connected: true, sessionActive: true, lastError: undefined, transcript: '', reply: '' };
    case 'session.closed':
      return { ...s, sessionActive: false, phase: 'idle', replyDone: false };
    case 'transcript.partial':
      return { ...s, transcript: m.text };
    case 'transcript.final':
      return { ...s, transcript: m.text, reply: '', phase: 'thinking', replyDone: false };
    case 'assistant.text.delta':
      return { ...s, reply: s.reply + m.text };
    case 'assistant.text.done':
      return { ...s, replyDone: true };
    case 'tts.start':
      return { ...s, phase: 'speaking', replyDone: false };
    case 'tts.end':
    case 'tts.cancelled':
      return { ...s, phase: 'idle', replyDone: false };
    case 'task.proposed': {
      const view: TaskView = {
        taskId: m.task.taskId,
        intent: m.task.intent,
        state: m.task.state,
        label: taskLabel(m.task.state),
      };
      const tasks = [...s.tasks.filter((t) => t.taskId !== view.taskId), view];
      return { ...s, tasks, selectedTaskId: s.selectedTaskId ?? view.taskId };
    }
    case 'task.event':
      return { ...s, tasks: applyTaskEvent(s.tasks, m.event) };
    case 'approval.requested':
      return {
        ...s,
        tasks: s.tasks.map((t) =>
          t.taskId === m.approval.taskId ? { ...t, approval: { approvalId: m.approval.approvalId, summary: m.summary } } : t,
        ),
      };
    case 'error':
      // A failed turn is over. Without this the panel would stay on "thinking" for ever.
      return {
        ...s,
        phase: s.phase === 'listening' ? s.phase : 'idle',
        replyDone: false,
        lastError: { code: m.code, message: m.message, retryable: m.retryable },
      };
    case 'pong':
      return s;
  }
}

function reduceUi(s: PanelState, a: UiAction): PanelState {
  switch (a.type) {
    case 'listen_start':
      return s.micMuted ? s : { ...s, phase: 'listening', transcript: '' };
    case 'listen_end':
      return s.phase === 'listening' ? { ...s, phase: 'thinking' } : s;
    case 'toggle_mute':
      // Muting while listening ends capture locally; nothing is sent to the server.
      return { ...s, micMuted: !s.micMuted, phase: !s.micMuted && s.phase === 'listening' ? 'idle' : s.phase };
    case 'select_task':
      return s.tasks.some((t) => t.taskId === a.taskId) ? { ...s, selectedTaskId: a.taskId } : s;
    case 'show':
      return { ...s, visible: true };
    case 'hide':
      return { ...s, visible: false };
    case 'settle':
      return s.phase === 'thinking' && s.replyDone ? { ...s, phase: 'idle', replyDone: false } : s;
    case 'interrupted':
      return s.phase === 'thinking' || s.phase === 'speaking' ? { ...s, phase: 'idle', replyDone: false } : s;
    case 'session_failed':
      return { ...s, phase: 'idle', lastError: { code: 'SESSION', message: a.message.slice(0, 200), retryable: true } };
    case 'listen_cancel':
      return s.phase === 'listening'
        ? { ...s, phase: 'idle', lastError: { code: 'NO_SPEECH', message: 'I did not hear anything. Try again.', retryable: true } }
        : s;
    case 'no_response':
      // Only when nothing was transcribed. A slow answer to real speech keeps waiting.
      return s.phase === 'thinking' && s.transcript === ''
        ? { ...s, phase: 'idle', lastError: { code: 'NO_SPEECH', message: 'I did not catch that. Try again.', retryable: true } }
        : s;
  }
}

/** Pure. A server message with a seq at or below the last seen one is a replay and is ignored. */
export function reducePanel(s: PanelState, e: PanelEvent): PanelState {
  switch (e.kind) {
    case 'server': {
      if (e.message.seq <= s.lastSeq) return s;
      return { ...reduceServer(s, e.message), lastSeq: e.message.seq };
    }
    case 'connection':
      // A new connection starts a new server seq, and a drop abandons any turn in flight.
      return e.connected
        ? { ...s, connected: true, lastSeq: 0 }
        : { ...s, connected: false, sessionActive: false, phase: 'idle', replyDone: false, lastSeq: 0 };
    case 'ui':
      return reduceUi(s, e.action);
  }
}

// ---- Controls: each is its own command with its own effect ----

export type Command = 'summon' | 'mute' | 'stop_speaking' | 'end_session' | 'cancel_task' | 'dismiss';

export type Effect =
  | { type: 'send'; message: ClientMessage }
  | { type: 'capture'; on: boolean }
  | { type: 'show'; focus: boolean }
  | { type: 'hide' };

type ClientBody = ClientMessage extends infer M ? (M extends ClientMessage ? Omit<M, 'v'> : never) : never;

const msg = (m: ClientBody): Effect => ({ type: 'send', message: { v: 1, ...m } as ClientMessage });

/**
 * What a control should do right now. Mute and dismiss are local. Stop speaking,
 * end session and cancel task are three different server messages, so one click
 * can never do more than it says.
 */
export function effectsFor(s: PanelState, command: Command): Effect[] {
  switch (command) {
    case 'summon': {
      // Summoned by the person, so taking focus is expected.
      const effects: Effect[] = [{ type: 'show', focus: true }];
      // Cutting in works while it is thinking as well as while it speaks.
      if (s.phase === 'speaking' || s.phase === 'thinking') effects.push(msg({ type: 'interrupt', reason: 'barge_in' }));
      if (s.phase === 'listening') {
        effects.push({ type: 'capture', on: false }, msg({ type: 'input.end' }));
      } else if (!s.micMuted && s.connected) {
        effects.push({ type: 'capture', on: true });
      }
      return effects;
    }
    case 'mute':
      return s.phase === 'listening' || s.micMuted ? [{ type: 'capture', on: s.micMuted }] : [];
    case 'stop_speaking':
      return s.phase === 'speaking' ? [msg({ type: 'interrupt', reason: 'user' })] : [];
    case 'end_session':
      return s.sessionActive ? [{ type: 'capture', on: false }, msg({ type: 'session.end' })] : [];
    case 'cancel_task': {
      const task = s.tasks.find((t) => t.taskId === s.selectedTaskId);
      return task && !isTerminal(task.state) ? [msg({ type: 'task.cancel', taskId: task.taskId })] : [];
    }
    case 'dismiss':
      return [{ type: 'hide' }];
  }
}
