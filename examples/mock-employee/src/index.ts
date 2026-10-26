import type { ConformanceHarness } from '@cruzclaw/voice-core';
import { MockEmployeeBackend } from './mock-host.ts';

export { MockEmployeeBackend } from './mock-host.ts';

/** Wires the mock into the shared conformance suite. */
export function createMockHarness(): ConformanceHarness {
  const backend = new MockEmployeeBackend();
  return {
    createHost: (tenantKey) => backend.hostFor(tenantKey),
    decideApproval: async (tenantKey, approvalId, decision) => backend.decide(tenantKey, approvalId, decision),
    advance: async (tenantKey, taskId) => backend.advance(tenantKey, taskId),
    sideEffectCount: (tenantKey, taskId) => backend.sideEffectCount(tenantKey, taskId),
  };
}
