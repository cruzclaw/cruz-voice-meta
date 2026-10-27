import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, screen, session, Tray } from 'electron';
import { DEFAULT_SHORTCUT, panelWindowOptions, placePanel, ShortcutManager, type DisplayState, type PanelState } from '@cruzclaw/windows-bridge';
import { VoiceClient } from './client.js';
import { HostController, type AudioDevice } from './controller.js';

/**
 * Windows voice host. Global shortcut and tray in front, a hidden window that owns the
 * microphone and speaker behind, and the voice protocol over a WebSocket in the middle.
 * There is no panel window yet: state shows in the tray and in this process's log.
 */

const URL = process.env.VOICE_URL ?? 'ws://127.0.0.1:8787';
const TOKEN = process.env.VOICE_TOKEN ?? '';
const SHORTCUT = process.env.VOICE_SHORTCUT ?? DEFAULT_SHORTCUT;
/** Set VOICE_DEBUG_DUMP=1 to save the last thing the microphone heard as a WAV file in the temp folder. */
const DUMP = process.env.VOICE_DEBUG_DUMP === '1';
const PANEL_HEIGHT = 250;

const STATE_COLOR: Record<DisplayState, [number, number, number]> = {
  disconnected: [120, 120, 120],
  idle: [90, 170, 90],
  listening: [220, 50, 50],
  thinking: [70, 130, 220],
  speaking: [60, 200, 120],
  awaiting_approval: [240, 170, 40],
  task_working: [70, 130, 220],
};

const STATE_TEXT: Record<DisplayState, string> = {
  disconnected: 'Not connected',
  idle: 'Ready',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  awaiting_approval: 'Waiting for your approval',
  task_working: 'Working on a task',
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

let audioWindow: BrowserWindow | undefined;
let panel: BrowserWindow | undefined;
let diag = '';
let utterance: Buffer[] = [];
let wasListening = false;
let tray: Tray | undefined;
let client: VoiceClient | undefined;
let quitting = false;

const audio: AudioDevice = {
  startCapture: () => audioWindow?.webContents.send('capture', true),
  stopCapture: () => audioWindow?.webContents.send('capture', false),
  play: (pcm) => audioWindow?.webContents.send('play', pcm),
  stopPlayback: () => audioWindow?.webContents.send('stop-playback'),
};

const controller = new HostController(
  {
    send: (message) => client?.send(message),
    sendMic: (pcm) => client?.sendMic(pcm),
  },
  audio,
  (state, display) => {
    tray?.setImage(dot(display));
    tray?.setToolTip(`CruzClaw voice: ${STATE_TEXT[display]}`);
    if (state.lastError && state.lastError !== lastErrorShown) log(`error ${state.lastError.code}: ${state.lastError.message}`);
    lastErrorShown = state.lastError;
    pushPanel(state, display);
    const listening = display === 'listening';
    if (wasListening && !listening) saveUtterance();
    if (!wasListening && listening) utterance = [];
    wasListening = listening;
  },
);

let lastErrorShown: PanelState['lastError'];

function pushPanel(state: PanelState, display: DisplayState): void {
  const waiting = state.tasks.find((t) => t.approval)?.approval?.summary;
  panel?.webContents.send('panel-state', {
    display,
    label: STATE_TEXT[display],
    connected: state.connected,
    transcript: state.transcript,
    reply: state.reply,
    approval: waiting,
    error: state.lastError && display !== 'listening' ? state.lastError.message : undefined,
    shortcut: SHORTCUT,
  });
}

function setDiag(text: string): void {
  diag = text;
  panel?.webContents.send('panel-diag', diag);
}

/** Writes the captured utterance as a 24 kHz mono WAV so its quality can be checked by ear or by a transcriber. */
function saveUtterance(): void {
  if (!DUMP || !utterance.length) return;
  const pcm = Buffer.concat(utterance);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  const file = path.join(os.tmpdir(), 'voice-last-utterance.wav');
  writeFileSync(file, Buffer.concat([header, pcm]));
  log(`saved ${(pcm.length / 48000).toFixed(1)} s of microphone audio to ${file}`);
}

let lastDisplay = '';
function log(line: string): void {
  console.log(`[voice] ${line}`);
}

async function connectLoop(): Promise<void> {
  let wait = 2000;
  while (!quitting) {
    const next = new VoiceClient(URL, TOKEN, {
      onMessage: (m) => {
        controller.onServer(m);
        if (m.type === 'transcript.final') log(`you said: ${m.text}`);
        if (m.type === 'assistant.text.done') log(`reply: ${controller.state.reply}`);
        if (m.type === 'approval.requested') log(`needs approval: ${m.summary}`);
        if (controller.display !== lastDisplay) log(`state: ${(lastDisplay = controller.display)}`);
      },
      onSpeech: (pcm) => controller.onSpeech(pcm),
      onClose: (reason) => {
        log(reason);
        controller.setConnected(false);
        reconnected.resolve();
      },
    });
    const reconnected = (() => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => (resolve = r));
      return { promise, resolve };
    })();
    try {
      await next.connect();
      client = next;
      controller.setConnected(true);
      log(`connected to ${URL}. Press ${SHORTCUT} to talk, press it again when you finish.`);
      wait = 2000;
      await reconnected.promise;
    } catch (e) {
      log(`${(e as Error).message}. Retrying in ${Math.round(wait / 1000)} s.`);
    }
    client = undefined;
    if (quitting) return;
    await new Promise((r) => setTimeout(r, wait));
    wait = Math.min(wait * 2, 15000);
  }
}

function createAudioWindow(): BrowserWindow {
  const win = new BrowserWindow({
    show: false,
    width: 200,
    height: 100,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // The window is hidden, and the speaker must keep playing while it is.
      backgroundThrottling: false,
    },
  });
  void win.loadFile(path.join(__dirname, 'audio.html'));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  return win;
}

function createPanel(): BrowserWindow {
  const options = panelWindowOptions(path.join(__dirname, 'panel-preload.cjs'));
  const win = new BrowserWindow({ ...options, height: PANEL_HEIGHT });
  const displays = screen.getAllDisplays().map((d) => ({ id: d.id, workArea: d.workArea, primary: d.id === screen.getPrimaryDisplay().id }));
  const bounds = placePanel(displays, screen.getCursorScreenPoint(), undefined, { width: options.width, height: PANEL_HEIGHT });
  if (bounds) win.setBounds(bounds);
  void win.loadFile(path.join(__dirname, 'panel.html'));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.once('did-finish-load', () => {
    pushPanel(controller.state, controller.display);
    setDiag(diag);
    // Shown without taking focus, so it never steals typing from the app in front.
    win.showInactive();
  });
  return win;
}

function summon(): void {
  if (panel && !panel.isVisible()) panel.showInactive();
  controller.command('summon');
}

function trayMenu(): Menu {
  return Menu.buildFromTemplate([
    { label: `Talk (${SHORTCUT})`, click: () => summon() },
    { label: 'Show panel', click: () => panel?.showInactive() },
    { label: 'Stop speaking', click: () => controller.command('stop_speaking') },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('window-all-closed', () => undefined); // Lives in the tray.
  void app.whenReady().then(() => {
    if (!TOKEN) {
      log('VOICE_TOKEN is not set. Start the demo server, then set VOICE_TOKEN to its bearer token.');
      app.quit();
      return;
    }
    // Only the hidden audio window may use the microphone.
    const isAudio = (wc: Electron.WebContents | null): boolean => !!wc && wc === audioWindow?.webContents;
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => callback(permission === 'media' && isAudio(wc)));
    session.defaultSession.setPermissionCheckHandler((wc, permission) => permission === 'media' && isAudio(wc));

    audioWindow = createAudioWindow();
    ipcMain.on('mic', (event, data: ArrayBuffer) => {
      if (event.sender !== audioWindow?.webContents) return;
      if (DUMP && controller.state.phase === 'listening') utterance.push(Buffer.from(data));
      controller.onMic(new Uint8Array(data));
    });
    ipcMain.on('level', (event, level: unknown) => {
      if (event.sender === audioWindow?.webContents && typeof level === 'number' && controller.state.phase === 'listening') {
        panel?.webContents.send('panel-level', level);
      }
    });
    ipcMain.on('audio-info', (event, message: unknown) => {
      if (event.sender !== audioWindow?.webContents) return;
      const text = String(message).slice(0, 200);
      log(`audio: ${text}`);
      setDiag(text);
    });
    ipcMain.on('panel-talk', (event) => {
      if (event.sender === panel?.webContents) controller.command('summon');
    });
    ipcMain.on('panel-hide', (event) => {
      if (event.sender === panel?.webContents) panel.hide();
    });
    ipcMain.on('audio-error', (event, message: unknown) => {
      if (event.sender !== audioWindow?.webContents) return;
      log(`audio problem: ${String(message).slice(0, 200)}`);
      setDiag(`Audio problem: ${String(message).slice(0, 120)}`);
    });

    tray = new Tray(dot('disconnected'));
    tray.setToolTip('CruzClaw voice: Not connected');
    tray.setContextMenu(trayMenu());
    tray.on('click', () => summon());

    panel = createPanel();

    const shortcuts = new ShortcutManager(globalShortcut, () => summon());
    const result = shortcuts.apply(SHORTCUT, ['Ctrl+Alt+Space']);
    if (result.status === 'conflict' || result.status === 'invalid') log(`no shortcut could be registered. Use the tray icon to talk.`);
    else if (result.status === 'fallback') log(`${SHORTCUT} is taken by another app. Using ${result.active} instead.`);

    void connectLoop();
  });
  app.on('before-quit', () => {
    quitting = true;
    controller.dispose();
    client?.close();
    globalShortcut.unregisterAll();
  });
}
