import {
  HostError,
  hashPayload,
  TERMINAL_STATES,
  type ApprovalStatus,
  type ConversationContext,
  type ProgressEvent,
  type ProposedAction,
  type TaskRecord,
  type TaskRequest,
  type TaskState,
  type Unsubscribe,
  type VoiceEmployeeHost,
} from '@cruzclaw/voice-core';

/** Synthetic data only. Time and IDs are deterministic so demos and tests repeat. */
interface TenantState {
  tasks: Map<string, TaskRecord>;
  taskByKey: Map<string, string>;
  events: Map<string, ProgressEvent[]>;
  listeners: Map<string, Set<(event: ProgressEvent) => void>>;
  approvals: Map<string, ApprovalStatus & { key: string; kind: string; payload: Record<string, unknown> }>;
  approvalByKey: Map<string, string>;
  sideEffects: Map<string, number>;
  counter: number;
}

const newTenant = (): TenantState => ({
  tasks: new Map(),
  taskByKey: new Map(),
  events: new Map(),
  listeners: new Map(),
  approvals: new Map(),
  approvalByKey: new Map(),
  sideEffects: new Map(),
  counter: 0,
});

const EPOCH = Date.UTC(2026, 0, 1);

export class MockEmployeeBackend {
  private tenants = new Map<string, TenantState>();

  tenant(key: string): TenantState {
    let t = this.tenants.get(key);
    if (!t) {
      t = newTenant();
      this.tenants.set(key, t);
    }
    return t;
  }

  /** Server side only. Tenant identity is fixed here, never taken from a request. */
  hostFor(tenantKey: string): VoiceEmployeeHost {
    return new MockHost(this, tenantKey);
  }

  now(t: TenantState): string {
    return new Date(EPOCH + t.counter * 1000).toISOString();
  }

  emit(t: TenantState, task: TaskRecord, type: ProgressEvent['type'], message: string): void {
    const list = t.events.get(task.taskId) ?? [];
    t.counter++;
    const event: ProgressEvent = {
      seq: list.length + 1,
      taskId: task.taskId,
      type,
      state: task.state,
      message,
      at: this.now(t),
    };
    list.push(event);
    t.events.set(task.taskId, list);
    t.listeners.get(task.taskId)?.forEach((fn) => fn(event));
  }

  setState(t: TenantState, task: TaskRecord, state: TaskState, message: string): void {
    task.state = state;
    task.updatedAt = this.now(t);
    this.emit(t, task, 'state', message);
  }

  /** One worker step. accepted waits for approval when one exists. */
  advance(tenantKey: string, taskId: string): void {
    const t = this.tenant(tenantKey);
    const task = t.tasks.get(taskId);
    if (!task || TERMINAL_STATES.includes(task.state)) return;
    const approval = task.approvalId ? t.approvals.get(task.approvalId) : undefined;

    if (approval?.state === 'rejected' || approval?.state === 'expired') {
      this.setState(t, task, 'rejected', 'Owner did not approve');
      return;
    }
    if (task.state === 'proposed') {
      this.setState(t, task, 'accepted', 'Task accepted');
    } else if (task.state === 'accepted') {
      if (approval && approval.state !== 'approved') return;
      if (approval && approval.approvedPayloadHash !== approval.payloadHash) return;
      t.sideEffects.set(taskId, (t.sideEffects.get(taskId) ?? 0) + 1);
      this.setState(t, task, 'dispatched', 'Action dispatched');
    } else if (task.state === 'dispatched') {
      this.setState(t, task, 'confirmed', 'Action confirmed');
    }
  }

  decide(tenantKey: string, approvalId: string, decision: 'approved' | 'rejected'): void {
    const t = this.tenant(tenantKey);
    const approval = t.approvals.get(approvalId);
    if (!approval) throw new HostError('NOT_FOUND', 'approval not found');
    if (approval.state !== 'pending') return;
    approval.state = decision;
    if (decision === 'approved') approval.approvedPayloadHash = approval.payloadHash;
    const task = t.tasks.get(approval.taskId);
    if (task) this.emit(t, task, 'approval', `Approval ${decision}`);
  }

  sideEffectCount(tenantKey: string, taskId: string): number {
    return this.tenant(tenantKey).sideEffects.get(taskId) ?? 0;
  }
}

class MockHost implements VoiceEmployeeHost {
  constructor(
    private readonly backend: MockEmployeeBackend,
    private readonly tenantKey: string,
  ) {}

  private get t(): TenantState {
    return this.backend.tenant(this.tenantKey);
  }

  private task(taskId: string): TaskRecord {
    const task = this.t.tasks.get(taskId);
    if (!task) throw new HostError('NOT_FOUND', 'task not found');
    return task;
  }

  async getContext(conversationId: string): Promise<ConversationContext> {
    const openTasks = [...this.t.tasks.values()]
      .filter((task) => task.conversationId === conversationId && !TERMINAL_STATES.includes(task.state))
      .map((task) => ({ taskId: task.taskId, state: task.state, title: task.intent }));
    return {
      conversationId,
      persona: { id: `persona-${this.tenantKey}`, displayName: 'Demo Employee' },
      summary: 'Synthetic demo conversation.',
      openTasks,
    };
  }

  async proposeTask(request: TaskRequest): Promise<TaskRecord> {
    if (!request.idempotencyKey || !request.intent || !request.conversationId) {
      throw new HostError('INVALID_REQUEST', 'idempotencyKey, conversationId and intent are required');
    }
    const t = this.t;
    const existing = t.taskByKey.get(request.idempotencyKey);
    if (existing) return { ...this.task(existing) };

    t.counter++;
    const task: TaskRecord = {
      taskId: `task-${t.counter}`,
      idempotencyKey: request.idempotencyKey,
      conversationId: request.conversationId,
      intent: request.intent,
      state: 'proposed',
      createdAt: this.backend.now(t),
      updatedAt: this.backend.now(t),
    };
    t.tasks.set(task.taskId, task);
    t.taskByKey.set(request.idempotencyKey, task.taskId);
    this.backend.emit(t, task, 'state', 'Task proposed');
    return { ...task };
  }

  async getTaskStatus(taskId: string): Promise<TaskRecord> {
    return { ...this.task(taskId) };
  }

  async cancelTask(taskId: string): Promise<TaskRecord> {
    const task = this.task(taskId);
    if (!TERMINAL_STATES.includes(task.state)) {
      this.backend.setState(this.t, task, 'cancelled', 'Task cancelled');
    }
    return { ...task };
  }

  async requestApproval(action: ProposedAction): Promise<ApprovalStatus> {
    const t = this.t;
    const task = this.task(action.taskId);
    const payloadHash = hashPayload(action.payload);
    const existingId = t.approvalByKey.get(action.idempotencyKey);
    if (existingId) {
      const existing = t.approvals.get(existingId)!;
      if (existing.payloadHash !== payloadHash || existing.taskId !== action.taskId) {
        throw new HostError('CONFLICT', 'idempotency key was used with a different payload');
      }
      return this.status(existing);
    }
    t.counter++;
    const approval = {
      approvalId: `approval-${t.counter}`,
      taskId: action.taskId,
      state: 'pending' as const,
      payloadHash,
      key: action.idempotencyKey,
      kind: action.kind,
      payload: action.payload,
    };
    t.approvals.set(approval.approvalId, approval);
    t.approvalByKey.set(action.idempotencyKey, approval.approvalId);
    task.approvalId = approval.approvalId;
    this.backend.emit(t, task, 'approval', 'Approval requested');
    return this.status(approval);
  }

  async getApprovalStatus(approvalId: string): Promise<ApprovalStatus> {
    const approval = this.t.approvals.get(approvalId);
    if (!approval) throw new HostError('NOT_FOUND', 'approval not found');
    return this.status(approval);
  }

  subscribeProgress(
    taskId: string,
    listener: (event: ProgressEvent) => void,
    options: { afterSeq?: number } = {},
  ): Unsubscribe {
    this.task(taskId);
    const t = this.t;
    const set = t.listeners.get(taskId) ?? new Set();
    set.add(listener);
    t.listeners.set(taskId, set);
    const backlog = (t.events.get(taskId) ?? []).filter((e) => e.seq > (options.afterSeq ?? 0));
    queueMicrotask(() => backlog.forEach(listener));
    return () => set.delete(listener);
  }

  async replayEvents(taskId: string, afterSeq: number): Promise<ProgressEvent[]> {
    this.task(taskId);
    return (this.t.events.get(taskId) ?? []).filter((e) => e.seq > afterSeq);
  }

  private status(a: ApprovalStatus): ApprovalStatus {
    const out: ApprovalStatus = {
      approvalId: a.approvalId,
      taskId: a.taskId,
      state: a.state,
      payloadHash: a.payloadHash,
    };
    if (a.approvedPayloadHash) out.approvedPayloadHash = a.approvedPayloadHash;
    return out;
  }
}
