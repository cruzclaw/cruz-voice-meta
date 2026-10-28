# Architecture

## Boundary

```
 voice client (Windows tray, web tab)
        |  streaming voice session
        v
 voice gateway  -- STT / reasoning / TTS providers (server-side keys)
        |  VoiceEmployeeHost
        v
 host implementation  (mock here; a production host lives outside this repo)
```

The voice layer turns speech into a **proposed task**. It never performs the real work. The host decides whether a task is accepted, asks the owner to approve exact payloads, dispatches, and reports progress. A host callback cannot bypass the host's own permission and approval rules, and this repository ships no production approval logic.

## Rules every host follows

- **Identity is server-bound.** A host is created for one authenticated session. Requests carry no account or tenant ID.
- **Four honest states.** `proposed`, `accepted`, `dispatched`, `confirmed`. The voice layer must not say "sent" before `confirmed`.
- **Idempotency.** The same idempotency key never creates a second task or a second approval, and the real side effect runs at most once.
- **Exact approval.** An approval covers the sha256 of the canonical payload. Reusing a key with a different payload is a `CONFLICT`.
- **Replay.** Progress events carry a per-task sequence number so a reconnecting client resumes without loss or duplicates.

## Conformance

`runConformanceSuite` in `packages/voice-core` is the executable form of these rules. A host implementation supplies a small harness (create a host for a tenant, deliver an owner decision, step the worker, count side effects) and runs the same suite. The mock host passes it today.

## Versioning

`VOICE_CONTRACT_VERSION` follows semver. Consumers pin a released version of the public package by immutable tag or commit SHA.
