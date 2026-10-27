# Voice session protocol

Version 1. Types are in `packages/voice-core/src/protocol.ts`, validators in `protocol-validate.ts`, binary framing in `audio-frame.ts` and ordering rules in `session-guard.ts`.

## Transport

One WebSocket per session. JSON text frames carry control messages and binary frames carry audio. The server authenticates the connection when it opens. After that, identity comes from the connection and never from a message.

## Identity

A client message that contains `accountId`, `userId`, `tenantId`, `organizationId`, `personaId` or `deploymentId` at any depth is rejected. Unknown extra fields are dropped.

## Order

1. Client sends `session.start` (audio format, optional conversation and locale, optional `speech`, optional `resumeFromSeq`).
2. Server replies `session.ready`, which says who speaks (see Speech mode). Until then the server accepts only `ping` and `session.end`, and no audio.
3. Audio and other messages flow. Either side can end the session.

## Speech mode

`session.start` may carry `speech: "device"` to say the client turns the assistant's text into sound itself. The server then sends the reply as `assistant.text.delta` and `assistant.text.done` only: no audio frames and no `tts.*` messages. Omitted or `"server"` means the server speaks, as before.

`session.ready` echoes the mode in effect: `"server"`, `"device"`, or `"none"` (the client asked for server speech but this server has no voice, so only text arrives). A `session.ready` without the field means `"server"`. A client must follow what `session.ready` says, not what it asked for, so a server that does not know the field leaves a client working. A client cannot request `"none"`.

## Client messages

| Type | Purpose |
| --- | --- |
| `session.start` | Open a session. Audio is `pcm_s16le`, mono, at 8, 16, 24 or 48 kHz |
| `input.end` | The client detected the end of speech |
| `interrupt` | Stop the assistant now. Reason is `barge_in`, `user` or `correction` |
| `playback.progress` | How many milliseconds of a reply actually played |
| `task.cancel` | Cancel a task the assistant proposed |
| `ping`, `session.end` | Keep-alive and close |

## Server messages

Each carries a per-session `seq`, strictly increasing from 1, so a reconnecting client resumes with `resumeFromSeq`.

`session.ready`, `transcript.partial`, `transcript.final`, `assistant.text.delta`, `assistant.text.done`, `tts.start`, `tts.end`, `tts.cancelled`, `task.proposed`, `task.event`, `approval.requested`, `error`, `pong`, `session.closed`.

`task.proposed`, `task.event` and `approval.requested` carry the host records from [api-contracts.md](api-contracts.md). `error` has a code and a `retryable` flag. After `tts.cancelled` the client must drop any queued audio for that reply.

## Audio frames

Eight-byte header, then raw PCM: version (1), kind (1 microphone or 2 speech), two reserved zero bytes, and a big-endian sequence number. Frames over 64 KiB, odd-length PCM and unknown headers are rejected. `decodeAudioFrame` returns `null` for bad input and never throws.

## Limits

JSON frames are at most 64 KiB, text fields at most 4000 characters and IDs at most 128.

## Not in this version

Approval decisions are not sent over the voice channel. They go through the host's own approval path. Voice approval handling is a later issue.
