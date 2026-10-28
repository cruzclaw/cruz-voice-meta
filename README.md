# cruz-voice-meta

Voice modules for CruzClaw built on Meta models: a Windows summon experience, a streaming voice session, speech in and out, and governed hand-off of spoken requests to an AI employee. It runs on its own with a synthetic demo employee.

**Status: early scaffold.** Only the host contract and its conformance suite exist so far. Nothing here talks to a Meta model yet.

## What is here

| Path | Purpose |
| --- | --- |
| `packages/voice-core` | The versioned `VoiceEmployeeHost` contract, shared types, payload hashing, feature-flag parsing and the conformance suite |
| `examples/mock-employee` | A deterministic synthetic host that passes the conformance suite |
| `docs/` | Architecture notes, API contract, UI spec and feature-flag design |

Planned: `meta-provider`, `voice-ui`, `windows-bridge`, `tts-provider`, `apps/demo-desktop`, `apps/demo-server`.

## Run it

```
npm install
npm run typecheck
npm test
```

Node 20 or later.

## Public and private

This repository is a public, independent project. It contains no CruzClaw production code, customer data or secrets. A host implementation maps the `VoiceEmployeeHost` interface to a real employee runtime, and it must pass the same conformance suite as the mock. CruzClaw's own host is proprietary and lives elsewhere. See [docs/architecture.md](docs/architecture.md).

## License

Not yet chosen. Apache 2.0 is proposed pending owner and legal review. Until a LICENSE file is added, all rights are reserved.
