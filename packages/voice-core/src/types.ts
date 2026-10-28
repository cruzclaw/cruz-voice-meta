/**
 * VoiceEmployeeHost contract, version 0.1.0.
 *
 * A host is constructed for ONE server-authenticated session. Account, tenant
 * and persona identity are bound at construction by the server and never
 * appear in a request, so a client-supplied ID cannot authorize anything.
 */

export const VOICE_CONTRACT_VERSION = '0.1.0';

/**
 * proposed   the voice layer suggested the task; the host has not taken it yet
 * accepted   the host validated and took ownership of the task (a host may
 *            return this straight from proposeTask)
 * dispatched the host started the real side effect (sent, ran, wrote)
 * confirmed  the host observed the side effect complete
 */
export type TaskState =
  | 'proposed'
  | 'accepted'
  | 'dispatched'
  | 'confirmed'
  | 'cancelled'
  | 'rejected'
  | 'failed';

export const TERMINAL_STATES: readonly TaskState[] = ['confirmed', 'cancelled', 'rejected', 'failed'];

export interface TaskSummary {
  taskId: string;
  state: TaskState;
  title: string;
}

export interface ConversationContext {
  conversationId: string;
  persona: { id: string; displayName: string };
  summary?: string;
  openTasks: TaskSummary[];
}

export interface TaskRequest {
  /** Stable across retries. The same key must never create a second task. */
  idempotencyKey: string;
  conversationId: string;
  /** What the person said, after speech-to-text. */
  utterance: string;
  /** Machine-readable intent chosen by the reasoner, such as "send_email". */
  intent: string;
  params: Record<string, unknown>;
}

export interface TaskRecord {
  taskId: string;
  idempotencyKey: string;
  conversationId: string;
  intent: string;
  state: TaskState;
  createdAt: string;
  updatedAt: string;
  /** Set when the task is waiting on an owner approval. */
  approvalId?: string;
}

export interface ProposedAction {
  idempotencyKey: string;
  taskId: string;
  /** What will happen, such as "email.send". */
  kind: string;
  /** The exact payload the owner will approve. Hashed, never edited after. */
  payload: Record<string, unknown>;
}

export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'expired';

export interface ApprovalStatus {
  approvalId: string;
  taskId: string;
  state: ApprovalState;
  /** sha256 of the canonical payload shown to the owner. */
  payloadHash: string;
  /** Present once approved: the hash the approval covers. Must equal payloadHash. */
  approvedPayloadHash?: string;
}

export type ProgressEventType = 'state' | 'note' | 'approval';

export interface ProgressEvent {
  /** Per-task, strictly increasing, starting at 1. Enables replay after a reconnect. */
  seq: number;
  taskId: string;
  type: ProgressEventType;
  state: TaskState;
  message: string;
  at: string;
}

export type Unsubscribe = () => void;

export type HostErrorCode = 'NOT_FOUND' | 'INVALID_REQUEST' | 'CONFLICT' | 'FORBIDDEN';

export class HostError extends Error {
  constructor(
    public readonly code: HostErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HostError';
  }
}

export interface VoiceEmployeeHost {
  getContext(conversationId: string): Promise<ConversationContext>;
  proposeTask(request: TaskRequest): Promise<TaskRecord>;
  getTaskStatus(taskId: string): Promise<TaskRecord>;
  /** Idempotent. Cancelling a terminal task returns its record unchanged. */
  cancelTask(taskId: string): Promise<TaskRecord>;
  /** Idempotent on action.idempotencyKey. */
  requestApproval(action: ProposedAction): Promise<ApprovalStatus>;
  getApprovalStatus(approvalId: string): Promise<ApprovalStatus>;
  subscribeProgress(
    taskId: string,
    listener: (event: ProgressEvent) => void,
    options?: { afterSeq?: number },
  ): Unsubscribe;
  /** Events with seq greater than afterSeq, in order. */
  replayEvents(taskId: string, afterSeq: number): Promise<ProgressEvent[]>;
}
