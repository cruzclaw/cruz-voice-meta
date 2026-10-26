# Threat model

Scope: the voice session between a client, a voice gateway and an employee host, plus the build and release pipeline. This is an initial model and will grow with each module.

## Assets

- The owner's authority: a spoken request must not become an action the owner did not allow.
- Audio and transcripts of real people.
- Provider API keys.
- Tenant data held by a host.

## Threats and controls

| Threat | Control |
| --- | --- |
| A client claims another account or tenant | Identity is bound by the server when a host is created. Requests carry no account ID. The conformance suite checks cross-tenant reads, cancels, replays and approval lookups |
| An approved action is swapped for a different one | Approval covers the sha256 of the canonical payload. Reusing an idempotency key with a different payload is a CONFLICT |
| A retry sends twice | Stable idempotency keys on tasks and approvals. The suite checks the side effect runs at most once |
| The voice layer says "done" too early | Four states: proposed, accepted, dispatched, confirmed. Only confirmed means complete |
| A reconnect loses or repeats progress | Per-task sequence numbers and replay from any sequence |
| Ambient audio leaves the device | No audio uplink before the person activates. Wake-phrase monitoring is a separate, revocable consent and stays on the device |
| A provider key leaks to a client | Keys live on the server side only. Clients get no provider credentials |
| The feature is on for the wrong people | A server-side per-user flag, default off, with a global kill switch, enforced at session start |
| A malicious dependency or build | Lockfile install, dependency and license audit in CI, SBOM, provenance attestation and checksums on releases |
| A secret committed by mistake | Full-history secret scan in CI and before pushes |

## Out of scope for now

Telephone and meeting audio, WhatsApp voice notes, and any host's own permission model. A host is responsible for its own authorization, and the public code ships no production approval logic.
