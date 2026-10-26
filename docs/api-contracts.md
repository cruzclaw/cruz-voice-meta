# API contracts

Contract version: `0.1.0`. Types are in `packages/voice-core/src/types.ts`.

## VoiceEmployeeHost

| Method | Behavior |
| --- | --- |
| `getContext(conversationId)` | Persona, summary and open (non-terminal) tasks for the conversation |
| `proposeTask(request)` | Creates a task in `proposed`, or `accepted` if the host takes it at once. Same `idempotencyKey` returns the same task. Missing key, intent or conversation is `INVALID_REQUEST` |
| `getTaskStatus(taskId)` | Current record. Another tenant's task is `NOT_FOUND` |
| `cancelTask(taskId)` | Idempotent. A cancelled task never performs its side effect. A terminal task is returned unchanged |
| `requestApproval(action)` | Creates a `pending` approval bound to `payloadHash`. Same key and payload returns the same approval. Same key with a different payload is `CONFLICT` |
| `getApprovalStatus(approvalId)` | `pending`, `approved`, `rejected` or `expired`. When approved, `approvedPayloadHash` equals `payloadHash` |
| `subscribeProgress(taskId, listener, {afterSeq})` | Delivers backlog after `afterSeq`, then live events. Returns an unsubscribe function |
| `replayEvents(taskId, afterSeq)` | Events with `seq > afterSeq`, in order |

Owner decisions are not part of this interface. They arrive through the host's own approval channel.

## Task states

`proposed` -> `accepted` -> `dispatched` -> `confirmed`, with `cancelled`, `rejected` and `failed` as other terminal states.

## Errors

`HostError` with code `NOT_FOUND`, `INVALID_REQUEST`, `CONFLICT` or `FORBIDDEN`.
