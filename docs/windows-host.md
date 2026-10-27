# Windows voice host

`apps/windows-voice-host` is the Windows app that talks to a voice server. There is no panel window yet: the tray icon shows the state and the terminal logs what was heard and said.

## Run it locally

1. Start the demo server (`apps/demo-server`, see `docs/demo-server.md`). It prints a bearer token.
2. From `apps/windows-voice-host`: set `VOICE_TOKEN` to that token and run `npm start`.
   `VOICE_URL` (default `ws://127.0.0.1:8787`) and `VOICE_SHORTCUT` (default `Ctrl+Shift+Space`) are optional.
3. Press the shortcut, speak, press it again. Press it while the assistant is speaking to interrupt.

Electron's binary is not fetched by npm 11 (install scripts are skipped). If `npm start` says Electron is missing, run `node node_modules/electron/install.js` once.

## How it is split

| Part | Where | Job |
| --- | --- | --- |
| `VoiceClient` | `src/client.ts` | WebSocket in the main process, because browsers cannot set the Authorization header |
| `HostController` | `src/controller.ts` | Shortcut presses and server messages into state and actions, using `@cruzclaw/windows-bridge` |
| Audio window | `src/audio-*.js`, `preload.cjs` | Hidden, sandboxed page that owns the microphone (24 kHz, 40 ms frames, echo cancellation) and the speaker |
| Shell | `src/main.ts` | Tray, global shortcut, microphone permission for the audio window only |

The controller and client are tested against the real demo server with a fake microphone and speaker. The audio window is not covered by automated tests and needs a person at a microphone.

## Known limits

- Microphone audio goes to the server only between the two presses; there is no voice activity detection yet.
- Approvals still go through the demo server's HTTP endpoint, not the host.
- No panel window, so there is no text on screen.
