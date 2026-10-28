# Windows voice host

`apps/windows-voice-host` is the Windows app that talks to a voice server. A small panel called Cruz (about 342 by 330) shows what it is doing: an orb that changes colour with the state and moves with the loudness of whoever is talking (you while listening, the assistant while speaking), the conversation text scrolling below it, and Mute and Call buttons. The Call button turns into a red Hang up button for as long as a conversation is going: Hang up stops listening, speaking and any answer in progress, and nothing listens again by itself until the next call. The minimise button (before the close button) shrinks the panel to a thin bar, about a tenth of its height, just above the taskbar, with the state, Mute and Call or Hang up; the arrow on the bar expands it again. The shortcut still talks, ends your turn and cuts the assistant off, as before. The tray icon shows the state too, and the terminal logs what was heard and said.

## Run it locally

1. Start the demo server (`apps/demo-server`, see `docs/demo-server.md`). It prints a bearer token.
2. From `apps/windows-voice-host`: set `VOICE_TOKEN` to that token and run `npm start`.
   `VOICE_URL` (default `ws://127.0.0.1:8787`) and `VOICE_SHORTCUT` (default `Ctrl+Shift+Space`) are optional.
3. Press the shortcut. The first press (and the first after 15 minutes of quiet) opens a session and the assistant greets you by name; when the greeting ends it listens on its own. Later presses chime and listen straight away.
4. Speak, then stop. About 0.9 s of quiet ends your turn and a second chime means it is thinking. Press the shortcut at any time, while it is thinking or speaking, to cut in: it stops and listens.

After each answer finishes playing it listens for a follow-up by itself (rising chime). Say nothing for about 8 s and it returns to ready without a message. `VOICE_FOLLOW_UP=0` turns this off, so every turn needs a press. It never listens while the speaker is still sounding, because the microphone would record the assistant.

Chimes are generated tones: rising when it starts listening, falling when it starts thinking, short and low when nothing was heard.

Electron's binary is not fetched by npm 11 (install scripts are skipped). If `npm start` says Electron is missing, run `node node_modules/electron/install.js` once.

## The assistant's voice is made on this device

By default the host asks the server for text only (`speech: "device"`, see [protocol.md](protocol.md)) and speaks the reply itself with Kokoro-82M. It starts talking at the end of the first sentence while the rest of the reply is still arriving. The model runs in its own Electron utility process, because Kokoro and the wake phrase detector each load their own ONNX runtime and cannot share a process. The first run downloads the model (about 90 MB) and the log says "voice is ready" once it has loaded. If it cannot load, replies show as text and the panel says why.

Set `VOICE_SPEECH=server` to let the server speak instead. If the server does not support text-only sessions, the host uses the server's voice automatically.

Check the voice without a server: `VOICE_TOKEN=x VOICE_SPEECH_SELFTEST=1` (with `ELECTRON_RUN_AS_NODE` unset) makes the voice say a test phrase, reads the speaker's own level meter, prints PASS or FAIL, and quits. It proves the sound reaches the audio output, not that it is pleasant to hear, so listen to it once.

## How it is split

| Part | Where | Job |
| --- | --- | --- |
| `VoiceClient` | `src/client.ts` | WebSocket in the main process, because browsers cannot set the Authorization header. Opening the connection (token check) is separate from starting a session, because the greeting plays when a session starts |
| `HostController` | `src/controller.ts` | Shortcut presses and server messages into state and actions, using `@cruzclaw/windows-bridge` |
| Audio window | `src/audio-*.js`, `preload.cjs` | Hidden, sandboxed page that owns the microphone (24 kHz, 40 ms frames, echo cancellation) and the speaker |
| Shell | `src/main.ts` | Tray, global shortcut, microphone permission for the audio window only |

The controller and client are tested against the real demo server with a fake microphone and speaker. The audio window is not covered by automated tests and needs a person at a microphone.

## Connecting to the CruzClaw backend

By default the host talks to the demo server. To talk to a real CruzClaw employee, point it at the backend instead:

| Variable | Meaning |
| --- | --- |
| `VOICE_API_URL` | The backend, for example `https://api.example.com`. Must be `https://` (plain `http://` is accepted for `localhost` only, so a password cannot cross the network in the clear). |
| `VOICE_PERSONA_NAME` or `VOICE_PERSONA_ID` | The employee to talk to. A name is matched without regard to case. |
| `VOICE_EMAIL` and `VOICE_PASSWORD` | Sign in with an account that has voice turned on. |
| `VOICE_ACCESS_TOKEN` | Alternative to the two above: an access token you already have. It expires, and the app cannot renew it without a refresh token. |

How it connects: the host signs in, finds the employee, and asks `POST /api/voice/ticket` for a ticket. The ticket opens one WebSocket (`/api/voice/ws`) for that user and that employee and works once, so every connection asks for a new one. The server decides who you are from the ticket alone; nothing the app sends can change it. The Meta key never leaves the server.

Setup problems that will not fix themselves, such as a wrong password, an account without voice, or an employee that does not exist, are shown on the panel and logged once. The app does not retry them. Network problems and a busy server are retried with a growing wait.

Accounts that need an emailed code to sign in (admin accounts) cannot sign in this way. Use an access token for those.

## Wake phrase (optional, off by default)

Say "Hey Cruz", "Hi Cruz", "Hello Cruz" or "Okay Cruz" and the assistant starts a call, as if you had pressed Call.

1. Once: `npm run fetch-model -w @cruzclaw/wake-word` downloads the keyword model (about 17 MB, Apache-2.0, checked against a pinned checksum) into `packages/wake-word/models`, which is not committed.
2. Start the host with `VOICE_WAKE=1`. The log says "wake phrase on" when the detector has loaded, or why it did not.

How it works and what it costs:
- **Local only.** A small keyword spotter (sherpa-onnx) runs on this machine. Nothing is sent anywhere until the phrase has been heard and the call has started.
- **The microphone stays open while idle**, so Windows shows its microphone indicator all the time. It closes while muted, while disconnected, and during a call (when it is used for the call instead). The panel says "Say Hey Cruz" while it is waiting.
- **A greeting is required.** "Cruz" alone sounds the same as "cruise" and "crews" and cannot be told apart from them. With a greeting, test speech woke it every time and ordinary speech, other assistants ("Hey Siri") and cruise or crews without a greeting never did. A bare "Cruz" can be enabled in `@cruzclaw/wake-word` (`bareThreshold`) but is not recommended.
- **Say the phrase, wait for the chime.** The first moments after the phrase are the chime, so start your request after it. On the first call of a session the greeting plays first.
- Measured on speech made by Kokoro in five voices, not on real voices or noise. Whether it works for your voice and room is what a live test shows. `WAKE_LIVE=1 npx tsx --test packages/wake-word/test/sherpa.live.test.ts` repeats the speech test.
- Kokoro (the speech engine) and the keyword spotter each load their own `onnxruntime.dll` and cannot run in the same process. In this app they do not: speech runs in the server.

## Known limits

- Listening ends by itself after about 0.9 s of quiet following speech (`VOICE_END_SILENCE_MS` sets it, 300 to 3000; `VOICE_AUTO_END=0` turns it off, leaving the second press). It judges from the microphone level only, so a sudden loud noise can look like speech and a long pause to think can end a turn. The second press and the 55 s cap are the backstops. Listening with no speech for 8 s is dropped.
- Microphone audio goes to the server only between the first press and the end of listening.
- Approvals still go through the demo server's HTTP endpoint, not the host.
- Mute stops automatic listening (follow-ups, the end of the greeting). A deliberate press of Talk, the shortcut or the tray turns the microphone back on. Muting while listening drops what was said so far without an answer.

## Using the host inside another Electron app

`@cruzclaw/windows-voice-host` is also a library. Its main entry is `dist/index.cjs`, and `createVoiceHost` gives an
Electron main process the whole host: the compact call panel, the hidden audio window, the connection and the
conversation logic. The app keeps its own tray, shortcut, sign-in and settings.

```js
const { createVoiceHost } = require('@cruzclaw/windows-voice-host');
const host = createVoiceHost({
  connection,                       // { resolve(): Promise<{ url, headers }> }, asked again for every connection
  assetsDir: dist,                  // the folder holding panel.html, audio.html and the rest
  speechProcessFile: dist + '/speech-process.cjs',
  modelCacheDir: userDataFolder,    // where the ~90 MB voice model is kept. Must be writable
  shortcutLabel: 'Ctrl+Shift+Space',
  onAttentionOpen: () => showWhatIsWaiting(),
});
host.press();                       // connects on the first press, then starts the call
host.setAttention({ counts: { update: 1, approval: 0, acknowledgement: 0, error: 0 } });
```

Nothing is opened or loaded until it is needed: no window until something is waiting or a call starts, no microphone
or speech process until the first call, no connection until the first press (or `start()`).

### The silent attention strip

`setAttention` draws a thin flowing strip of colour at the very top of the window, in the full panel and in the
minimised bar alike. Green is an update, orange an approval, blue an acknowledgement and red an error. When more than
one kind is waiting each gets an equal part of the strip: nothing is ranked over anything else, and counts do not
change the parts. It makes no sound, never speaks, never shows what a message says, never takes focus and never
expands the panel by itself. With nothing waiting and no panel open, the bar appears silently when something arrives
and goes away when nothing is waiting. Pressing the strip or the badge calls `onAttentionOpen`. Closing the panel
while something is waiting leaves the bar, so the strip is never taken away.

The bar and the panel have exactly the same width and left edge (`COMPACT_WIDTH`). `npm run test:electron` checks it on
a real window at display scales 1, 1.25, 1.5 and 2, along with the colours, the focus rules and the audio window rules.
The blue of an acknowledgement is not used for any conversation state in the strip, and the colours of the strip are
kept equal to `ATTENTION_COLORS` by a test.

What counts as an update, an approval, an acknowledgement or an error is up to the app. The host only draws the counts.
It does not detect meetings, screen sharing or other windows.
