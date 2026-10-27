# Demo server

`apps/demo-server` speaks [protocol v1](protocol.md) over a WebSocket with mock providers and the synthetic employee from `examples/mock-employee`. It needs no credentials and no private code.

```
npm install
npm run start -w @cruzclaw/demo-server
```

It listens on `127.0.0.1:8787` and prints a bearer token. Set `PORT` or `DEMO_TOKEN` to override, and `VOICE_FEATURE_DISABLED=true` to see the kill switch refuse every session.

## Ports

Real providers plug in behind three small interfaces in `src/ports.ts`:

| Port | Demo stand-in | Real provider |
| --- | --- | --- |
| `Transcriber` | `ScriptedTranscriber` returns scripted phrases | Meta Muse Voice Transcribe (CRU-663) |
| `Reasoner` | `RuleReasoner` | Meta Muse Spark (CRU-664) |
| `Synthesizer` | `ToneSynthesizer` plays a quiet tone | A text-to-speech engine, which can be non-Meta (CRU-665) |

Meta offers speech to text and reasoning but no text to speech. The mock transcriber cannot understand audio, so it ignores what you say and answers with the next scripted phrase. Do not mistake it for recognition.

## What the server enforces

- The socket is authenticated at the upgrade with an `Authorization: Bearer` header, compared in constant time. A missing or wrong token gets 401.
- A request that carries an `Origin` header not on the allow list gets 403, which blocks cross-site connections from a browser.
- Identity is the token's account. Nothing a client sends can change it, and the protocol rejects identity fields.
- The per-account feature flag and the kill switch are checked at `session.start`.
- JSON frames are limited to 64 KiB, and one utterance to 60 seconds of audio.
- A task that needs approval does nothing until the owner approves. The demo approves with `POST /demo/approvals/<id>/approved` and the same bearer token. Approvals never travel over the voice channel.

## Not implemented yet

- `resumeFromSeq` is accepted but ignored: there is no session store to resume from.
- Browsers cannot set the `Authorization` header on a WebSocket, so a web client needs another way to authenticate. That decision belongs with the web tab (CRU-660).
- Speech to text works per utterance after `input.end`, not as a stream, and there are no partial transcripts.
- No rate limiting.
