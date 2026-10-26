import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hashPayload } from './hash.ts';
import { HostError, type ProgressEvent, type TaskRequest, type VoiceEmployeeHost } from './types.ts';

/**
 * What a host implementation provides so the suite can drive it. Everything
 * outside `createHost` is the server side of the host (owner decisions and the
 * worker that performs the real work), which the voice layer never calls.
 */
export interface ConformanceHarness {
  /** A host bound to a server-side session. Distinct keys are distinct tenants. */
  createHost(tenantKey: string): VoiceEmployeeHost;
  /** Owner decision, delivered out of band. */
  decideApproval(tenantKey: string, approvalId: string, decision: 'approved' | 'rejected'): Promise<void>;
  /** Run the worker one step for the task. */
  advance(tenantKey: string, taskId: string): Promise<void>;
  /** Real side effects executed for the task. Must never exceed 1. */
  sideEffectCount(tenantKey: string, taskId: string): number;
}

const request = (key: string, over: Partial<TaskRequest> = {}): TaskRequest => ({
  idempotencyKey: key,
  conversationId: 'conv-1',
  utterance: 'send the weekly update to the team',
  intent: 'send_email',
  params: { audience: 'team' },
  ...over,
});

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (err: unknown) => err instanceof HostError && err.code === code);
}

async function drive(h: ConformanceHarness, tenant: string, taskId: string, steps = 6): Promise<void> {
  for (let i = 0; i < steps; i++) await h.advance(tenant, taskId);
}

/** Run against any host. The public mock and the private adapter must both pass. */
export function runConformanceSuite(name: string, makeHarness: () => ConformanceHarness): void {
  describe(`VoiceEmployeeHost conformance: ${name}`, () => {
    it('creates a task that has not been dispatched and returns the same task for the same key', async () => {
      const h = makeHarness();
      const host = h.createHost('a');
      const first = await host.proposeTask(request('k1'));
      const second = await host.proposeTask(request('k1'));
      // A host may accept at once, but nothing is dispatched before the worker runs.
      assert.ok(['proposed', 'accepted'].includes(first.state));
      assert.equal(h.sideEffectCount('a', first.taskId), 0);
      assert.equal(second.taskId, first.taskId);
      assert.equal((await host.getContext('conv-1')).openTasks.length, 1);
    });

    it('rejects a request without an idempotency key', async () => {
      const host = makeHarness().createHost('a');
      await rejectsWith(host.proposeTask(request('')), 'INVALID_REQUEST');
    });

    it('does not expose one tenant\'s tasks, approvals or events to another', async () => {
      const h = makeHarness();
      const a = h.createHost('a');
      const b = h.createHost('b');
      const task = await a.proposeTask(request('k1'));
      const approval = await a.requestApproval({
        idempotencyKey: 'ap1',
        taskId: task.taskId,
        kind: 'email.send',
        payload: { to: 'team@example.com' },
      });
      await rejectsWith(b.getTaskStatus(task.taskId), 'NOT_FOUND');
      await rejectsWith(b.cancelTask(task.taskId), 'NOT_FOUND');
      await rejectsWith(b.replayEvents(task.taskId, 0), 'NOT_FOUND');
      await rejectsWith(b.getApprovalStatus(approval.approvalId), 'NOT_FOUND');
      assert.equal((await b.getContext('conv-1')).openTasks.length, 0);
    });

    it('cancels idempotently and never performs the side effect afterwards', async () => {
      const h = makeHarness();
      const host = h.createHost('a');
      const task = await host.proposeTask(request('k1'));
      assert.equal((await host.cancelTask(task.taskId)).state, 'cancelled');
      assert.equal((await host.cancelTask(task.taskId)).state, 'cancelled');
      await drive(h, 'a', task.taskId);
      assert.equal((await host.getTaskStatus(task.taskId)).state, 'cancelled');
      assert.equal(h.sideEffectCount('a', task.taskId), 0);
    });

    it('emits ordered events that can be replayed and subscribed from a sequence number', async () => {
      const h = makeHarness();
      const host = h.createHost('a');
      const task = await host.proposeTask(request('k1'));
      await drive(h, 'a', task.taskId);
      const all = await host.replayEvents(task.taskId, 0);
      assert.ok(all.length >= 2);
      all.forEach((event, i) => assert.equal(event.seq, i + 1));
      const tail = await host.replayEvents(task.taskId, 1);
      assert.deepEqual(tail, all.slice(1));

      const seen: ProgressEvent[] = [];
      const stop = host.subscribeProgress(task.taskId, (e) => seen.push(e), { afterSeq: 1 });
      await new Promise((resolve) => setImmediate(resolve));
      stop();
      assert.deepEqual(seen, all.slice(1));
    });

    it('binds an approval to the exact payload and returns the same approval for the same key', async () => {
      const h = makeHarness();
      const host = h.createHost('a');
      const task = await host.proposeTask(request('k1'));
      const payload = { to: 'team@example.com', body: 'Weekly update' };
      const first = await host.requestApproval({ idempotencyKey: 'ap1', taskId: task.taskId, kind: 'email.send', payload });
      const again = await host.requestApproval({ idempotencyKey: 'ap1', taskId: task.taskId, kind: 'email.send', payload });
      assert.equal(first.state, 'pending');
      assert.equal(first.payloadHash, hashPayload(payload));
      assert.equal(again.approvalId, first.approvalId);
      await rejectsWith(
        host.requestApproval({
          idempotencyKey: 'ap1',
          taskId: task.taskId,
          kind: 'email.send',
          payload: { ...payload, to: 'someone-else@example.com' },
        }),
        'CONFLICT',
      );
    });

    it('holds the side effect until approval, then performs it exactly once', async () => {
      const h = makeHarness();
      const host = h.createHost('a');
      const task = await host.proposeTask(request('k1'));
      const approval = await host.requestApproval({
        idempotencyKey: 'ap1',
        taskId: task.taskId,
        kind: 'email.send',
        payload: { to: 'team@example.com' },
      });
      await drive(h, 'a', task.taskId);
      assert.equal(h.sideEffectCount('a', task.taskId), 0);
      assert.notEqual((await host.getTaskStatus(task.taskId)).state, 'dispatched');

      await h.decideApproval('a', approval.approvalId, 'approved');
      const decided = await host.getApprovalStatus(approval.approvalId);
      assert.equal(decided.state, 'approved');
      assert.equal(decided.approvedPayloadHash, decided.payloadHash);

      await drive(h, 'a', task.taskId, 12);
      assert.equal((await host.getTaskStatus(task.taskId)).state, 'confirmed');
      assert.equal(h.sideEffectCount('a', task.taskId), 1);
    });

    it('rejects the task and performs nothing when the owner rejects the approval', async () => {
      const h = makeHarness();
      const host = h.createHost('a');
      const task = await host.proposeTask(request('k1'));
      const approval = await host.requestApproval({
        idempotencyKey: 'ap1',
        taskId: task.taskId,
        kind: 'email.send',
        payload: { to: 'team@example.com' },
      });
      await h.decideApproval('a', approval.approvalId, 'rejected');
      await drive(h, 'a', task.taskId);
      assert.equal((await host.getTaskStatus(task.taskId)).state, 'rejected');
      assert.equal(h.sideEffectCount('a', task.taskId), 0);
    });
  });
}
