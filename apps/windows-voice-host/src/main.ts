import path from 'node:path';
import { app, globalShortcut, Menu, nativeImage, Tray } from 'electron';
import { DEFAULT_SHORTCUT, ShortcutManager, type DisplayState } from '@cruzclaw/windows-bridge';
import { ConnectionError, CruzBackendConnection, StaticConnection, type ConnectionProvider } from './connection.js';
import { createVoiceHost, STATE_TEXT, type VoiceHost } from './host.js';

/**
 * The standalone Windows voice host, for the demo server and for trying the CruzClaw backend with a sign-in.
 * It is a small shell around createVoiceHost: a tray icon, a global shortcut and settings from the environment.
 * The CruzClaw desktop app uses createVoiceHost directly and brings its own tray, sign-in and settings.
 */

const URL = process.env.VOICE_URL ?? 'ws://127.0.0.1:8787';
const TOKEN = process.env.VOICE_TOKEN ?? '';
/** Set VOICE_API_URL to use the CruzClaw backend instead of the demo server. */
const API_URL = process.env.VOICE_API_URL ?? '';
const SHORTCUT = process.env.VOICE_SHORTCUT ?? DEFAULT_SHORTCUT;
/** Set VOICE_DEBUG_DUMP=1 to save the last thing the microphone heard as a WAV file in the temp folder. */
const DUMP = process.env.VOICE_DEBUG_DUMP === '1';
/** Set VOICE_WAKE=1 to wake the assistant by saying Hey, Hi, Hello or Okay Cruz. The microphone then stays open on this machine while idle. Off by default. */
const WAKE = process.env.VOICE_WAKE === '1';
const WAKE_MODEL_DIR =
  process.env.VOICE_WAKE_MODEL_DIR ?? path.join(__dirname, '..', '..', '..', 'packages', 'wake-word', 'models', 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01');
/** Listening ends by itself after this much quiet. Set VOICE_AUTO_END=0 to end it with a second press only. */
const AUTO_END = process.env.VOICE_AUTO_END !== '0';
/** After each answer it listens for a reply by itself. Set VOICE_FOLLOW_UP=0 to need a press every time. */
const FOLLOW_UP = process.env.VOICE_FOLLOW_UP !== '0';
/** The assistant's voice is made on this device, in its own process. Set VOICE_SPEECH=server to let the server speak instead. */
const DEVICE_SPEECH = process.env.VOICE_SPEECH !== 'server';
/** Set VOICE_SPEECH_SELFTEST=1 to make the voice say a test phrase, measure the speaker, report, and quit. */
const SPEECH_SELFTEST = process.env.VOICE_SPEECH_SELFTEST === '1';
const END_SILENCE_MS = Number(process.env.VOICE_END_SILENCE_MS) || 900;

const STATE_COLOR: Record<DisplayState, [number, number, number]> = {
  disconnected: [120, 120, 120],
  idle: [90, 170, 90],
  listening: [220, 50, 50],
  thinking: [70, 130, 220],
  speaking: [60, 200, 120],
  awaiting_approval: [240, 170, 40],
  task_working: [70, 130, 220],
};

/** A 16 by 16 filled circle in the state's colour, drawn in memory so no icon file ships. */
function dot(display: DisplayState) {
  const size = 16;
  const [r, g, b] = STATE_COLOR[display];
  const bitmap = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inside = (x - 7.5) ** 2 + (y - 7.5) ** 2 <= 6.5 ** 2;
      const at = (y * size + x) * 4;
      bitmap[at] = b;
      bitmap[at + 1] = g;
      bitmap[at + 2] = r;
      bitmap[at + 3] = inside ? 255 : 0;
    }
  }
  return nativeImage.createFromBitmap(bitmap, { width: size, height: size });
}

function log(line: string): void {
  console.log(`[voice] ${line}`);
}

/** Reads the connection settings from the environment. Returns a message instead if they are incomplete. */
function connectionFromEnvironment(): ConnectionProvider | string {
  if (!API_URL) {
    return TOKEN ? new StaticConnection(URL, TOKEN) : 'VOICE_TOKEN is not set. Start the demo server, then set VOICE_TOKEN to its bearer token.';
  }
  const accessToken = process.env.VOICE_ACCESS_TOKEN;
  const email = process.env.VOICE_EMAIL;
  const password = process.env.VOICE_PASSWORD;
  if (!accessToken && !(email && password)) return 'Set VOICE_ACCESS_TOKEN, or VOICE_EMAIL and VOICE_PASSWORD, to sign in to the Cruz server.';
  try {
    return new CruzBackendConnection({
      baseUrl: API_URL,
      persona: { ...(process.env.VOICE_PERSONA_ID ? { id: process.env.VOICE_PERSONA_ID } : {}), ...(process.env.VOICE_PERSONA_NAME ? { name: process.env.VOICE_PERSONA_NAME } : {}) },
      credentials: accessToken ? { accessToken } : { email: email!, password: password! },
    });
  } catch (e) {
    return e instanceof ConnectionError ? e.message : 'The connection settings could not be read.';
  }
}

let host: VoiceHost | undefined;
let tray: Tray | undefined;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('window-all-closed', () => undefined); // Lives in the tray.
  void app.whenReady().then(() => {
    const connection = connectionFromEnvironment();
    if (typeof connection === 'string') {
      log(connection);
      app.quit();
      return;
    }

    host = createVoiceHost({
      connection,
      assetsDir: __dirname,
      speechProcessFile: path.join(__dirname, 'speech-process.cjs'),
      deviceSpeech: DEVICE_SPEECH,
      shortcutLabel: SHORTCUT,
      autoEnd: AUTO_END,
      endSilenceMs: END_SILENCE_MS,
      followUp: FOLLOW_UP,
      wakeModelDir: WAKE_MODEL_DIR,
      debugDump: DUMP,
      log,
      onChange: (_state, display) => {
        tray?.setImage(dot(display));
        tray?.setToolTip(`CruzClaw voice: ${STATE_TEXT[display]}`);
      },
    });

    tray = new Tray(dot('disconnected'));
    tray.setToolTip('CruzClaw voice: Not connected');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `Call (${SHORTCUT})`, click: () => host?.press() },
        { label: 'Hang up', click: () => host?.hangUp() },
        { label: 'Show panel', click: () => host?.showPanel() },
        { label: 'Test speaker', click: () => host?.testSpeaker() },
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() },
      ]),
    );
    tray.on('click', () => host?.press());

    const shortcuts = new ShortcutManager(globalShortcut, () => host?.press());
    const result = shortcuts.apply(SHORTCUT, ['Ctrl+Alt+Space']);
    if (result.status === 'conflict' || result.status === 'invalid') log('no shortcut could be registered. Use the tray icon to talk.');
    else if (result.status === 'fallback') log(`${SHORTCUT} is taken by another app. Using ${result.active} instead.`);

    host.showPanel();
    if (WAKE) void host.enableWake();

    if (SPEECH_SELFTEST) {
      // No server needed: make the voice speak, and check that the speaker's own level meter heard it.
      setTimeout(() => {
        void host!.selfTest().then((r) => {
          if (r.ok) log(`selftest: made ${r.seconds?.toFixed(1)} s of speech, first audio after ${r.firstAudioMs} ms, loudest speaker level ${r.peakLevel?.toFixed(3)}`);
          log(r.ok ? 'selftest: PASS, the voice reached the speaker' : `selftest: FAIL, ${r.reason ?? 'the speaker stayed silent'}`);
          app.exit(r.ok ? 0 : 2);
        });
      }, 1500);
    } else {
      host.start();
      log(`Press ${SHORTCUT} to talk.`);
    }
  });
  app.on('before-quit', () => {
    host?.dispose();
    globalShortcut.unregisterAll();
  });
}
