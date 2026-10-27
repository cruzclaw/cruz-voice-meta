# Windows voice host

`apps/windows-voice-host` is the Windows app that talks to a voice server. There is no panel window yet: the tray icon shows the state and the terminal logs what was heard and said.

## Run it locally

1. Start the demo server (`apps/demo-server`, see `docs/demo-server.md`). It prints a bearer token.
2. From `apps/windows-voice-host`: set `VOICE_TOKEN` to that token and run `npm start`.
   `VOICE_URL` (default `ws://127.0.0.1:8787`) and `VOICE_SHORTCUT` (default `Ctrl+Shift+Space`) are optional.
3. Press the shortcut. The first press (and the first after 15 minutes of quiet) opens a session and the assistant greets you by name; when the greeting ends it listens on its own. Later presses chime and listen straight away.
4. Speak, then stop. About 0.9 s of quiet ends your turn and a second chime means it is thinking. Press the shortcut at any time, while it is thinking or speaking, to cut in: it stops and listens.

Chimes are generated tones: rising when it starts listening, falling when it starts thinking, short and low when nothing was heard.

Electron's binary is not fetched by npm 11 (install scripts are skipped). If `npm start` says Electron is missing, run `node node_modules/electron/install.js` once.

## How it is split

| Part | Where | Job |
| --- | --- | --- |
| `VoiceClient` | `src/client.ts` | WebSocket in the main process, because browsers cannot set the Authorization header. Opening the connection (token check) is separate from starting a session, because the greeting plays when a session starts |
| `HostController` | `src/controller.ts` | Shortcut presses and server messages into state and actions, using `@cruzclaw/windows-bridge` |
| Audio window | `src/audio-*.js`, `preload.cjs` | Hidden, sandboxed page that owns the microphone (24 kHz, 40 ms frames, echo cancellation) and the speaker |
| Shell | `src/main.ts` | Tray, global shortcut, microphone permission for the audio window only |

The controller and client are tested against the real demo server with a fake microphone and speaker. The audio window is not covered by automated tests and needs a person at a microphone.

## Known limits

- Listening ends by itself after about 0.9 s of quiet following speech (`VOICE_END_SILENCE_MS` sets it, 300 to 3000; `VOICE_AUTO_END=0` turns it off, leaving the second press). It judges from the microphone level only, so a sudden loud noise can look like speech and a long pause to think can end a turn. The second press and the 55 s cap are the backstops. Listening with no speech for 8 s is dropped.
- Microphone audio goes to the server only between the first press and the end of listening.
- Approvals still go through the demo server's HTTP endpoint, not the host.
- No panel window, so there is no text on screen.
