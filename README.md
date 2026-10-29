# Cruz Voice Meta

Voice modules for talking to a virtual employee, with a standalone synthetic demo and an embeddable Windows host. Built during the Meta AI developer hackathon, starting **26 October 2026**.

**Status updated: 29 October 2026 (Asia/Kolkata).** [v0.2.2](https://github.com/cruzclaw/cruz-voice-meta/releases/tag/v0.2.2) is published and verified. The Windows integration has been installed and exercised with earlier packages. The real-employee gateway is now deployed and a live identity/context probe passed. The updated guard reported from the target runtime. The complete plugin sync and installed v0.2.2 live acceptance remain **open**. A published package is not evidence that a production app uses it.

This README records the agreed product plan and its delivery history. A checked item means only the named milestone is complete, not that every acceptance criterion for its workstream passed.

## Intended experience

Use the existing Windows app to speak to the employee you select, with that employee's identity, memory, tools and existing Cruz permissions. Voice must not be a separate assistant merely borrowing the employee's name.

1. The compact pad appears on normal startup without taking focus or starting a call. Closing it hides it for that app session; new attention does not reopen it. The shortcut or tray restores it, and the next launch shows it again.
2. Choose an employee explicitly in the panel or tray. The choice is remembered per signed-in account, never selected automatically, even with one employee. The name remains visible while checking access or when voice is unavailable. Changing employees ends the previous call before connecting to the new one.
3. Press Call or **Ctrl+Shift+Space**, or use optional locally detected **“Hey Cruz”** after consent. Wake listening is off initially; a saved opt-in may be restored. This is not speaker recognition.
4. Speak, interrupt and continue. Readiness, microphone state and playback state must be honest. “Speaking” follows renderer playback confirmation; preparing audio remains “Thinking.” Failure displays text and an accurate error rather than pretending sound played.
5. Work uses the employee's existing services. Consequential actions require the applicable owner approval and exact-payload dispatch checks. Reading an item or saying “pass” never approves or sends it.
6. Accepted durable work should survive the voice connection, report actual progress and permit continued conversation. Full durable-work acceptance remains pending.

### Silent attention, not unsolicited notifications

A thin Alexa-style top indicator is present in **both expanded and compact states**, including during calls. It signals waiting work without speaking, playing an alert, revealing content, taking focus or expanding a window.

| Colour | Meaning |
| --- | --- |
| Green | Update waiting |
| Orange | Owner approval waiting |
| Blue | Acknowledgement |
| Red | Error requiring attention |

When several kinds are waiting, they have equal segments; counts do not determine segment widths or priority. The compact strip is crisp, with no colour spill onto its controls; the expanded panel retains its glow. Both states share a **342 logical-pixel width and left edge**. The compact bar is **36 logical pixels high**, with content below its **4-pixel strip**. Geometry has been checked at 100%, 125%, 150% and 200% display scaling.

Pop-ups are off by default. The app does not detect meetings, screen sharing or user activity to make this decision.

**“Hey Cruz, what is it?”** should announce the actual count and source, then offer to read or pass: for example, “There is one notification from [channel]. Should I read it, or say pass?” Content is read only on request. Pass skips the item in the conversation; it does not mark it read, clear it, reject an approval or send anything. Numbered items must keep their identity within the remembered listing.

The indicator reflects notifications and approvals the host actually stores. Email, Slack, Teams and Linear are desired sources, not a claim that this repo implements monitoring for every provider. A deliberate strip/badge/tray action should lead to a reviewable list even without voice. That persistent review journey is separate host work and is not yet accepted live.

## Architecture and repository boundary

```text
Windows app / standalone Electron host
  microphone -> authenticated voice session -> transcription
  spoken reply <- device Kokoro <- streamed reply text
                          |
                 host-selected reasoner
                 /                    \
 public synthetic demo          private employee gateway
 Meta adapter + mock host       existing identity, memory,
                                tools and approval services
```

Public modules define contracts and transport; the host supplies identity, employee context, durable work, attention and approval enforcement. The standalone demo is intentionally synthetic. Its limited tool set is not the capability specification for a real employee.

The private Cruz integration consumes versioned public artifacts. Its database, authentication, employee runtime, billing, memory, customer content and credentials remain private. This repository is independent; it is not a fork or mirror of the application. A local sibling checkout is a developer convenience, never a production dependency.

Device-side speech is the current Windows direction. Kokoro runs in an Electron utility process, separate from the wake detector's runtime. The production backend need not load a speech model. Extracting the embedded gateway into its own container is a later architectural option, not completed work or a prerequisite for the current live test.

| Path | Responsibility |
| --- | --- |
| [packages/voice-core](packages/voice-core) | Host contract, shared types and conformance tests |
| [packages/voice-server](packages/voice-server) | Session/protocol handling, provider ports and Meta adapters |
| [packages/tts-kokoro](packages/tts-kokoro) | Local speech synthesis |
| [packages/windows-bridge](packages/windows-bridge) | Windows state, preferences and placement |
| [packages/wake-word](packages/wake-word) | Optional local wake detector and model setup |
| [apps/windows-voice-host](apps/windows-voice-host) | Standalone Electron host and embeddable library |
| [apps/demo-server](apps/demo-server) | Authenticated demo server with synthetic accounts/providers |
| [examples/mock-employee](examples/mock-employee) | Synthetic host implementing the public contract |

## Run the public demo

Use Node 22 for parity with CI; the package declares Node 20 or later. Windows is required for native Windows interaction checks.

```powershell
npm ci
npm run typecheck
npm test
npm run start -w @cruzclaw/demo-server
```

The server listens on localhost and prints a demo bearer token. In a second PowerShell window at the repository root:

```powershell
$env:VOICE_TOKEN = "<token printed by the local demo server>"
npm run start -w @cruzclaw/windows-voice-host
```

Without a Meta credential, transcription and reasoning are scripted stand-ins: they do **not** understand your microphone. See [demo setup](docs/demo-server.md) for server-side `MODEL_API_KEY` configuration and provider selection. Never put that credential in the desktop bundle. Device speech may download roughly 90 MB on its first run; cold loading takes additional time. If Electron was not installed because npm skipped its install script, follow [Windows setup](docs/windows-host.md).

Optional wake model setup:

```powershell
npm run fetch-model -w @cruzclaw/wake-word
$env:VOICE_WAKE = "1"
```

The integrated app uses its existing sign-in and consent controls; the standalone environment-variable setup is a developer path. Detailed host notes contain older standalone behaviour; the startup/close/attention requirements above describe the current integrated product contract.

## Full delivery plan and current status

References are the original Linear work items. Their workflow labels can lag evidence; this table does not treat “Done” as proof of live acceptance. **Released** means a public artifact exists; **local** means implementation/tests only; **pending** means the stated acceptance is still outstanding.

| Work item | Agreed scope and acceptance | Evidence/status at 29 October |
| --- | --- | --- |
| CRU-659 Packaging and flags | Existing app, original icon, install/upgrade/uninstall, startup/restore, rollback, signed package/Store compatibility; voice gated per account | Earlier unsigned installer installed and icon corrected; clean builds demonstrated. Signed-package, full lifecycle and Store acceptance pending |
| CRU-660 Windows interaction | Tray, shortcut, startup pad, matching widths, employee choice, silent colours, explicit review, honest readiness | Public v0.2.1 released; integrated installer exercised. v0.2.2 installation reported complete; visual/audio live journey pending |
| CRU-661 Wake/privacy | Local opt-in wake, clear microphone state, mute/disable, no audio upload while idle, recovery and real-room accuracy | Detector and bundled model tested locally; saved-consent behaviour implemented. Real-room/noise certification pending |
| CRU-662 Gateway/protocol | Server-owned identity, employee ownership, single-use tickets, TLS, limits, heartbeat/revocation, cancellation; durable conversation separate from audio | Transport and private access checks implemented/tested; earlier edge authentication probe verified. Complete reconnect/replay and latest gateway rollout acceptance pending |
| CRU-663 Speech recognition | Meta provider, speech boundaries, final/partial transcripts, duplicate prevention, language/business-name accuracy, usage | Adapter and endpointing implemented. Current recognition is per utterance after input ends; partial transcripts, WER dataset and metering acceptance remain open |
| CRU-664 Reasoning | Meta conversational adapter, grounded tools, truthful capability/context and safe proposals | Public adapter released. Real product must use selected employee's gateway; that private bridge is deployed and passed a live identity/context probe; broader acceptance remains open |
| CRU-665 Speech output | Streaming playback queue, cancellation, voice controls/personalization and reliable device output | Device Kokoro released; playback-confirmation fix released in v0.2.2. Full personalization and live cold/warm latency acceptance pending |
| CRU-666 Turns/corrections | Listening/thinking/speaking states, cut-in, stale audio rejection; stopping speech distinct from cancelling durable work; no duplicate sends | Cut-in/state/playback tests pass. Automatic full-duplex behaviour and task-safe correction scenarios are not fully certified live |
| CRU-667 Durable work | Existing jobs/commitments/ledger, stable IDs and idempotency, queued/running/awaiting-input/approval/completed/failed/cancelled progress, reconnect survival | Contract and private bridge work exist. Continued conversation during durable work, restart survival and real completion evidence pending |
| CRU-668 Approvals/disclosure | Exact recipient/content/scope approval, edited/revoked approval rejected, once-only dispatch, existing recipient policy, read/pass never authorizes | Session-origin and integration-path enforcement reviewed/tested locally. Target guard confirmed in real Redis and gateway identity probe passed; approval/send acceptance pending; not a universal certification of delegated/scheduled or arbitrary runtime actions |
| CRU-669 Usage/cost | Per-account/session/employee ASR, reasoning and TTS usage, budgets, traceability, retention consent and measured credit applicability | Planned certification; do not assume hackathon credits cover third-party speech or claim a completed cost dashboard |
| CRU-670 Regression/certification | Cross-account tests, interruption, reconnect, failures, approval leakage, real Windows/provider acceptance and repeatable demo | Automated suites and scale checks exist. Full installed/live certification remains open |
| CRU-675 Showcase | Three-minute demonstration of new event work, real Meta use, governed task, interruption and measurable time/attention savings | Planned; final video, measurements and submission receipt pending |
| CRU-676 Public repository | Independent history, licence, secret scanning, public source, contribution/security and branch protections | Repo/source/licence/scanning present; outstanding governance checks must not be inferred from release success |
| CRU-677 Host API | Versioned DTOs, mock/private conformance, context, tasks, approvals, cancellation and progress; no proprietary code published | Public contract and conformance released, private adapter tested. Complete real-host acceptance pending |
| CRU-678 Standalone demonstration | Independent synthetic demo, optional real Meta server credentials, wake/keyboard, speech, interruption, task/approval simulation; reproducible walkthrough | Runnable code exists; full recorded/certified walkthrough pending |
| CRU-679 Release integration | CI, history/secret/license audit, builds, checksums, SBOM/provenance, pinned private dependencies, installer smoke and normal deployment | v0.1.0–v0.2.2 released. v0.2.2 signatures/checksums verified. Latest app pin/installer reported complete and backend deployed; complete sync/live acceptance pending; private CI failure cause remains unresolved |

### Later extensions — not prerequisites for the current Windows milestone

| Work item | Planned scope | Status |
| --- | --- | --- |
| CRU-671 Telephony | Real phone provider, authenticated/idempotent callbacks, inbound routing, approved outbound destination/objective, consent, DTMF/handoff, transcripts and cost; real calls required | Planned; no real-provider certification claimed |
| CRU-672 Company numbers | Compare at least three provider models, geography/KYC, ownership/portability, SIP, WhatsApp compatibility, economics and offboarding before provisioning | Provider discovery pending |
| CRU-673 Meetings | Real provider beyond mock, participant consent, recording off by default, transcription, source-linked decisions/follow-ups and recovery | Planned; no real meeting certification claimed |
| CRU-674 Voice notes/channels | Audio validation/limits, WhatsApp voice notes, dashboard/audio attachments and email audio; separate provider flags, health/reauth and provenance/cost | Planned; each channel needs its own acceptance |

The pre-existing employee platform and unrelated source-monitoring work are dependencies, not new achievements of this repository. Independent proposals outside this project's agreed scope are excluded.

## Dated completion ledger

All entries below were reconstructed on **29 October 2026** from repository history, release evidence and implementation reports. Dates group work by the project day in Asia/Kolkata; report-based host milestones are labelled. They are not backdated claims of contemporaneous review. A completion is limited to the wording of its line.

### 26 October 2026

- [x] **Repository created** with independent public history ([initial commit](https://github.com/cruzclaw/cruz-voice-meta/commit/c60880a)).
- [x] **Initial host contract, synthetic mock and conformance scaffold** committed ([9344e75](https://github.com/cruzclaw/cruz-voice-meta/commit/9344e75)).
- [x] **Project plan recorded** covering Windows voice, existing-employee integration, governance, verification and separately scoped extensions. Planning completion does not imply implementation.

### 27 October 2026

- [x] **Protocol v1 and demo session server** implemented: validators, ordering and audio boundaries ([cd38f6c](https://github.com/cruzclaw/cruz-voice-meta/commit/cd38f6c), [e4362ff](https://github.com/cruzclaw/cruz-voice-meta/commit/e4362ff)).
- [x] **Meta transcription and Muse Spark adapters** implemented ([c1f1808](https://github.com/cruzclaw/cruz-voice-meta/commit/c1f1808), [f044622](https://github.com/cruzclaw/cruz-voice-meta/commit/f044622)).
- [x] **Kokoro, Windows tray/panel/audio, endpointing, greeting, interruption and follow-up** implemented and locally tested ([787c543](https://github.com/cruzclaw/cruz-voice-meta/commit/787c543), [839890d](https://github.com/cruzclaw/cruz-voice-meta/commit/839890d), [255d024](https://github.com/cruzclaw/cruz-voice-meta/commit/255d024)).
- [x] **Optional wake phrase** and compact call UI implemented ([fc04042](https://github.com/cruzclaw/cruz-voice-meta/commit/fc04042)).
- [x] **Reusable server package, dual module builds and fresh-ticket connection** implemented ([6b013ee](https://github.com/cruzclaw/cruz-voice-meta/commit/6b013ee), [5b10d5b](https://github.com/cruzclaw/cruz-voice-meta/commit/5b10d5b)).
- [x] **Device-side speech protocol** implemented; server speech provider optional ([c67b484](https://github.com/cruzclaw/cruz-voice-meta/commit/c67b484)).
- [x] **CI/release foundation, Apache-2.0, packaged licence, scoped audit exceptions and timeout repair** completed in the v0.1.0 source candidate ([a65490b](https://github.com/cruzclaw/cruz-voice-meta/commit/a65490b)). Publication is separately recorded in the release register.

### 28 October 2026

- [x] **Embeddable Windows host and silent attention strip** implemented ([34293ca](https://github.com/cruzclaw/cruz-voice-meta/commit/34293ca)); colours, equal segments and geometry checked locally.
- [x] **Lazy first-call connection/audio/model loading** implemented ([3715503](https://github.com/cruzclaw/cruz-voice-meta/commit/3715503), [922cf44](https://github.com/cruzclaw/cruz-voice-meta/commit/922cf44)).
- [x] **Tool-name dispatch, private transcript logging and session-ending corrections** completed ([9b99c2b](https://github.com/cruzclaw/cruz-voice-meta/commit/9b99c2b), [fd4e3ea](https://github.com/cruzclaw/cruz-voice-meta/commit/fd4e3ea)).
- [x] **Public source merged into main** in [PR #1](https://github.com/cruzclaw/cruz-voice-meta/pull/1).
- [x] **Earlier integrated installer built/installed and original icon corrected** — host implementation reports and installer verification; unsigned, not Store-certified.
- [x] **Earlier backend gateway deployed and invalid-ticket edge responses checked** — host deployment evidence; this does not certify the later real-employee bridge.
- [x] **Startup pad, explicit employee selection, persistent name caption and compact strip clearance** implemented ([8f8a053](https://github.com/cruzclaw/cruz-voice-meta/commit/8f8a053), [f9f246e](https://github.com/cruzclaw/cruz-voice-meta/commit/f9f246e), [1f124d4](https://github.com/cruzclaw/cruz-voice-meta/commit/1f124d4)); [PR #2](https://github.com/cruzclaw/cruz-voice-meta/pull/2) merged.

### 29 October 2026

- [x] **Renderer playback confirmation and honest playback failure** completed, replacing early/fabricated “Speaking” transitions ([890ac77](https://github.com/cruzclaw/cruz-voice-meta/commit/890ac77)). Audio-clock progress confirms playback scheduling, not that a person heard the speaker.
- [x] **Speech-end/chunk/playback timing instrumentation** added ([5bb1bec](https://github.com/cruzclaw/cruz-voice-meta/commit/5bb1bec), [6e73e11](https://github.com/cruzclaw/cruz-voice-meta/commit/6e73e11)).
- [x] **Public v0.2.2 checks/readiness** passed: 349 tests, typecheck, four builds/packs; Electron scale checks reported by implementer. [PR #3](https://github.com/cruzclaw/cruz-voice-meta/pull/3) merged.
- [x] **v0.2.2 published artifacts verified**: four tarballs, checksums, licences, SBOM and cryptographic provenance verification tied to source/tag/workflow.
- [x] **Private real-employee bridge, stable attention listing and voice-origin enforcement implemented/reviewed and pushed** — private host evidence only. No new plugin/container or live acceptance claimed.
- [ ] **Install and accept the v0.2.2 integrated app with the real employee gateway** — still pending.
- [ ] **Certify live identity/context, read/pass, exact approval/once-only send and real latency** — still pending.

### 29 October 2026 — Production checkpoint

- [x] **v0.2.2 app pin and installer** completed and installed, per implementing-agent evidence; reviewer independently passed 101 app tests. On-screen acceptance remains open.
- [x] **Real-employee backend deployed**, with healthy image/revision and no pending migrations. Existing account enablement was preserved.
- [x] **Target runtime guard reported** and a real voice-bridge identity/context question answered correctly. Reply text completed in about 12.6 seconds; this excludes recognition and playback.
- [x] **Public edge probes** returned the expected unauthorized responses for invalid tickets; health and ordinary site routes responded normally.
- [ ] **Complete plugin sync**: plugin/config files were written and the guard loaded, but the later sync path returned a runtime-identity ownership error. Full sync is not certified.
- [ ] **Complete deployment verification**: backend revision and edge bindings pass; the global script still flags unchanged services on older revisions.
- [ ] **Installed live acceptance**: microphone/audio/visual timing, read/pass, mailbox, exact approval, once-only send and dashboard regression remain open. No outbound message was sent during the identity probe.

- [x] **Installed wake-model packaging repair (29 October)**: the consuming Windows app now rejects packages missing required model assets and reports detector startup failures. Reviewer passed 113 app tests and confirmed installed assets and packaged/installed app hashes match. Implementer reports synthesized-speaker wake recognition before and after restart. Real-person wake and microphone-to-answer acceptance remain open.

### Release register

The links are authoritative for publication timestamps and assets; the dated sections above describe source work, not necessarily publication time.

| Release | Immutable source | Delivered milestone |
| --- | --- | --- |
| [v0.1.0](https://github.com/cruzclaw/cruz-voice-meta/releases/tag/v0.1.0) | `a65490ba9daa0d55c1bec2f9434572aae323b0ee` | Core/server/TTS: three tarballs, checksums and SBOM |
| [v0.2.0](https://github.com/cruzclaw/cruz-voice-meta/releases/tag/v0.2.0) | `fd4e3ea0a7dbe84959db160bb04bd2ea50507b0d` | Windows host added: four tarballs; attention/library and lifecycle fixes |
| [v0.2.1](https://github.com/cruzclaw/cruz-voice-meta/releases/tag/v0.2.1) | `1f124d408d923da7f23d4f6b6c0f4ac3b6fa6e99` | Startup pad, employee selection/readiness and compact strip |
| [v0.2.2](https://github.com/cruzclaw/cruz-voice-meta/releases/tag/v0.2.2) | `890ac778e9bb8594986d059b497d60ba5fcb33bb` | Playback confirmation/failure and timing |

## Next milestone and acceptance gate

1. Pin verified v0.2.2 assets in the consuming app/backend and validate a clean checkout.
2. Complete private PR/deployment coordination, recording the unresolved private CI result separately from local tests. Deploy through the host's normal reviewed process.
3. Sync the updated employee plugin to a controlled target and verify guard registration with the real runtime and Redis; verify ordinary dashboard behaviour remains correct.
4. Build/install the pinned app, then test the selected employee's real context and permitted tools. No canned identity/connectivity answers.
5. Demonstrate audible replies, correct mailbox, exact owner approval before a send, exactly one dispatch, read/pass/list identity, cancellation, sign-out/account switch and attention review.
6. Measure **end of user speech to first audible output**, including cold and warm runs. Earlier local speech-start measurements are not this end-to-end metric.
7. Record evidence against each line before closing the corresponding issue or claiming live readiness.

## Verification, risks and maintenance

CI currently runs typecheck, tests, all four release builds, secret/history scanning and dependency/license checks. Real Windows UI/audio and installed-app checks are separate; CI build success does not establish microphone, speaker or live account behaviour.

Three named `sharp` advisories remain accepted risks in the host dependency chain, not fixed vulnerabilities. See [audit exceptions](docs/audit-exceptions.md). The isolated TTS audit is reported separately. Current code-path measurements do not prove future dependency versions safe.

Session resume/replay, partial transcripts, full cost accounting and real-provider certification must not be inferred from protocol fields or mocks. Local name/context tests do not prove model behaviour in production.

For each completed milestone:

- Update its roadmap row and append the actual date, evidence link, exact commit/release and verification level to this ledger.
- For historical entries, record both the completion date and the date the entry was added. Preserve prior failures and distinguish fixes from rollout.
- Keep local, released, installed, deployed and live-accepted statuses separate; do not check a whole workstream because a subtask passed.
- Update the matching Linear issue without duplicating the task. Push reviewed documentation with the completed work; do not retag releases for documentation.
- Keep private credentials, customer content, infrastructure details and proprietary source out of public evidence.

This is a maintained ledger, not an automated status feed. Future changes require a new reviewed update.

## Documentation and licence

- [Host contracts](docs/api-contracts.md), [protocol](docs/protocol.md), [architecture](docs/architecture.md)
- [Demo setup](docs/demo-server.md), [Windows host](docs/windows-host.md), [feature flags](docs/feature-flag.md)
- [Release/provenance](docs/release-and-provenance.md), [threat model](docs/threat-model.md), [audit exceptions](docs/audit-exceptions.md)

Licensed under [Apache-2.0](LICENSE). Each published package includes the licence text. Third-party models and dependencies retain their own licences.
