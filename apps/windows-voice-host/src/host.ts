import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserWindow, ipcMain, screen, utilityProcess } from 'electron';
import {
  EndpointDetector,
  MIC_TEXT,
  attentionLabel,
  attentionShortLabel,
  attentionTotal,
  canCall,
  caption as captionFor,
  chosenEmployee,
  cleanEmployees,
  cleanReadiness,
  emptyText,
  expandedBounds,
  hueSegments,
  micState,
  miniBounds,
  noAttention,
  normalizeAttention,
  panelWindowOptions,
  placePanel,
  sameAttention,
  COMPACT_SIZE,
  type AttentionSummary,
  type DisplayState,
  type PanelState,
  type Readiness,
  type VoiceEmployee,
} from '@cruzclaw/windows-bridge';
import { VoiceClient } from './client.js';
import { ConnectionError, type ConnectionProvider } from './connection.js';
import { HostController, type AudioDevice } from './controller.js';
import { conversationLogLine } from './log-lines.js';
import { PendingPress } from './pending-press.js';
import { SpeechClient, type SpeechChild } from './speech-client.js';

/** The words for each state, for a tray tooltip or a log line. */
export const STATE_TEXT: Record<DisplayState, string> = {
  disconnected: 'Not connected',
  idle: 'Ready',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  awaiting_approval: 'Waiting for your approval',
  task_working: 'Working on a task',
};

export interface VoiceHostOptions {
  /** Where to reach the voice server. For the CruzClaw app this signs in with the app's own session. */
  connection: ConnectionProvider;
  /** The folder holding preload.cjs, audio.html, panel.html and the other page files. */
  assetsDir: string;
  /** The built speech process, for example dist/speech-process.cjs. Needed only for device speech. */
  speechProcessFile?: string;
  /** Speak the replies on this device and ask the server for text only. On by default. */
  deviceSpeech?: boolean;
  /** Shown on the panel, for example "Ctrl+Shift+Space". The shortcut itself belongs to the app. */
  shortcutLabel?: string;
  /** Listening ends by itself when the person stops talking. On by default. */
  autoEnd?: boolean;
  endSilenceMs?: number;
  /** After each answer, listen for a reply without another press. On by default. */
  followUp?: boolean;
  /** Where the wake phrase model was unpacked. Wake listening stays off until enableWake() is called. */
  wakeModelDir?: string;
  /**
   * Where the voice model is kept. It is about 90 MB and downloaded the first time it is needed, so it must be a
   * folder the app can write to, such as one under the user's app data. Defaults to the package's own folder.
   */
  modelCacheDir?: string;
  /** How long a press made before the connection was up stays valid. After this it is forgotten. Defaults to 15 s. */
  pressWindowMs?: number;
  /** Save the last thing the microphone heard as a WAV file in the temp folder. */
  debugDump?: boolean;
  log?: (line: string) => void;
  /** Called on every change of the conversation state, for a tray icon or similar. */
  onChange?: (state: PanelState, display: DisplayState) => void;
  /** The person pressed the strip or the badge to review what is waiting. */
  onAttentionOpen?: () => void;
  /** A conversation that the person did not start by pressing: the wake phrase was heard. */
  onWake?: (phrase: string) => void;
  /** A problem that keeps the call from working, in words for the person. Not called for ordinary retries. */
  onProblem?: (message: string) => void;
  /**
   * The person chose an employee in the panel. The app keeps the choice for that account, ends any call with the
   * earlier employee, and then calls setEmployees again with the same list and the new choice. The host changes
   * nothing by itself, so the app stays the one place that knows who is chosen.
   */
  onEmployeeChoose?: (id: string) => void;
}

export interface VoiceHost {
  readonly controller: HostController;
  /** Opens a connection (retrying) now. Without this, the first press opens it. */
  start(): void;
  press(): void;
  hangUp(): void;
  /**
   * The person signed out. Closes the connection (which ends the conversation on the server), stops the microphone
   * and the speaker, clears what is on the panel, and stops reconnecting. The next press opens a fresh connection.
   */
  endSession(reason?: 'signed_out' | 'employee_changed'): void;
  toggleMute(): void;
  /** Shows the full panel. Never takes focus. Brings it back after the person closed it. */
  showPanel(): void;
  /**
   * Shows the small bar, without focus. It starts no call, opens no microphone and turns nothing on. The bar then
   * stays until the person closes it (or hidePanel is called); waiting items never bring it back after that, and
   * showPanel, press or showBar do.
   */
  showBar(): void;
  /** The same as the person pressing close: hidden for now, back with showPanel, press or showBar. */
  hidePanel(): void;
  panelVisible(): boolean;
  /** The employees the person can talk to and the one chosen for voice (if any, and only if in the list). */
  setEmployees(employees: unknown, selectedId?: string): void;
  /** Whether a call can start, and if not, why. See Readiness. The host adds connection_failed itself. */
  setReadiness(readiness: unknown): void;
  /** What the panel is saying about readiness now. */
  readonly readiness: Readiness;
  /** What is waiting. Draws the strip in the full panel and the minimised bar, silently. */
  setAttention(summary: unknown): void;
  readonly attention: AttentionSummary;
  /** Turns wake phrase listening on. Resolves false, with the reason sent to the log, if it could not start. */
  enableWake(): Promise<boolean>;
  disableWake(): void;
  readonly wakeOn: boolean;
  testSpeaker(): void;
  /** Makes the voice say a test phrase on this machine and reports whether the speaker's level meter heard it. */
  selfTest(): Promise<{ ok: boolean; reason?: string; seconds?: number; firstAudioMs?: number; peakLevel?: number }>;
  /** The state of the panel as the person sees it, for tests and diagnostics. */
  describe(): { visible: boolean; mini: boolean; bounds: Electron.Rectangle | undefined; attention: AttentionSummary };
  dispose(): void;
}

/**
 * The whole voice host for an Electron main process: a hidden audio window that owns the microphone and
 * speaker, the compact call panel, the connection and the conversation logic. The app around it decides
 * what the shortcut, tray and settings do. Nothing here reads the person's screen, windows or meetings.
 */
export function createVoiceHost(options: VoiceHostOptions): VoiceHost {
  const log = options.log ?? (() => undefined);
  const deviceSpeech = options.deviceSpeech !== false;
  const shortcutLabel = options.shortcutLabel ?? '';
  const panelSize = { ...COMPACT_SIZE };
  const file = (name: string): string => path.join(options.assetsDir, name);

  let audioWindow: BrowserWindow | undefined;
  /** The audio page has registered its listeners. Before that, anything sent to it would be lost. */
  let audioReady = false;
  let audioBacklog: Array<[string, unknown[]]> = [];
  let panel: BrowserWindow | undefined;
  let panelLoaded = false;
  let mini = false;
  /** The person closed the panel. Waiting items do not bring it back; showPanel, press and showBar do. */
  let dismissed = false;
  let employees: VoiceEmployee[] = [];
  let selectedEmployeeId: string | undefined;
  /** Set by the app. The panel is told this, except that a connection that keeps failing overrides "ready". */
  let baseReadiness: Readiness = { state: 'ready' };
  let linkFailed = false;
  let diag = '';
  let attention: AttentionSummary = noAttention();
  let utterance: Buffer[] = [];
  let wasListening = false;
  let client: VoiceClient | undefined;
  let disposed = false;
  let generation = 0;
  let conversationEpoch = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectWait = 2000;
  let lastErrorShown: PanelState['lastError'];
  let lastDisplay = '';
  let wakeDetector: { dispose(): void } | undefined;
  let peakSpeakerLevel = 0;
  /** The panel is wanted before its page has loaded: show it, and as the bar or the full panel, as soon as it can. */
  let pendingShow = false;
  let pendingBar = false;
  /** The person asked for a call before the connection was up. It starts as soon as it is, if still fresh. */
  const pendingPress = new PendingPress(options.pressWindowMs ?? 15000);

  /** Chunks handed to the speaker since playback last stopped, and whether any may still be audible. */
  let chunksSent = 0;
  let speakerBusy = false;

  // ---- the device voice, in its own process ----

  const speech =
    deviceSpeech && options.speechProcessFile
      ? new SpeechClient((): SpeechChild => {
          const child = utilityProcess.fork(options.speechProcessFile!, [], {
            serviceName: 'CruzClaw voice',
            stdio: 'inherit',
            env: { ...process.env, ...(options.modelCacheDir ? { VOICE_MODEL_CACHE: options.modelCacheDir } : {}) },
          });
          return {
            endpoint: { post: (message) => child.postMessage(message), onMessage: (listener) => void child.on('message', listener) },
            onExit: (listener) => void child.on('exit', listener),
            kill: () => void child.kill(),
          };
        })
      : undefined;

  // ---- the speaker and microphone ----

  /**
   * The audio window (microphone and speaker) and the voice model are created the first time they are needed:
   * a call, a chime, the wake phrase or a speaker test. An app that only shows the attention strip never opens
   * the microphone, never starts the speech process and never downloads the model.
   */
  const needAudio = (): BrowserWindow | undefined => {
    if (disposed) return undefined;
    if (!audioWindow || audioWindow.isDestroyed()) {
      audioReady = false;
      audioBacklog = [];
      audioWindow = createAudioWindow();
      if (speech) void speech.warmUp().then((ok) => log(ok ? 'voice is ready' : 'the voice could not be loaded. Replies will show as text only.'));
    }
    return audioWindow;
  };
  /** Stopping something that was never started must not start the audio window. */
  const audioIfOpen = (): BrowserWindow | undefined => (audioWindow && !audioWindow.isDestroyed() ? audioWindow : undefined);

  /**
   * Sends to the audio page. A page that has only just been created has not registered its listeners yet, so
   * what is sent is held, in order, and delivered the moment the page says it is ready.
   */
  const toAudio = (win: BrowserWindow | undefined, channel: string, ...args: unknown[]): void => {
    if (!win) return;
    if (!audioReady) audioBacklog.push([channel, args]);
    else win.webContents.send(channel, ...args);
  };

  const audio: AudioDevice = {
    startCapture: () => toAudio(needAudio(), 'capture', true),
    stopCapture: () => toAudio(audioIfOpen(), 'capture', false),
    play: (pcm) => {
      chunksSent++;
      speakerBusy = true;
      toAudio(needAudio(), 'play', pcm);
    },
    stopPlayback: () => {
      chunksSent = 0;
      speakerBusy = false;
      toAudio(audioIfOpen(), 'stop-playback');
    },
    isPlaying: () => speakerBusy,
    chime: (kind) => toAudio(needAudio(), 'chime', kind),
    listenForWake: (on) => toAudio(on ? needAudio() : audioIfOpen(), 'wake-mic', on),
  };

  const controller = new HostController(
    {
      send: (message) => client?.send(message),
      sendMic: (pcm) => client?.sendMic(pcm),
      startSession: (fresh, mode) => startSession(fresh, mode),
    },
    audio,
    {
      followUp: options.followUp ?? true,
      onWake: (phrase: string) => {
        log(`wake phrase heard: ${phrase}`);
        options.onWake?.(phrase);
        if (!panel || !panel.isVisible()) showPanelSilently();
      },
      ...(options.autoEnd === false ? {} : { endpoint: new EndpointDetector({ endSilenceMs: Math.min(3000, Math.max(300, options.endSilenceMs ?? 900)) }) }),
      ...(speech
        ? {
            speak: (text: string, signal: AbortSignal) => speech.synthesize(text, signal),
            onSpeechError: (e: unknown) => {
              const reason = e instanceof Error ? e.message : 'the voice failed';
              log(`speech problem: ${reason}`);
              setDiag(`Voice problem: ${reason.slice(0, 120)}`);
            },
          }
        : {}),
      onChange: (state, display) => {
        options.onChange?.(state, display);
        if (state.lastError && state.lastError !== lastErrorShown) log(`error ${state.lastError.code}: ${state.lastError.message}`);
        lastErrorShown = state.lastError;
        pushPanel(state, display);
        const listening = display === 'listening';
        if (wasListening && !listening) saveUtterance();
        if (!wasListening && listening) utterance = [];
        wasListening = listening;
      },
    },
  );

  // ---- the panel ----

  const displayInfos = () => {
    const primary = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((d) => ({ id: d.id, workArea: d.workArea, primary: d.id === primary }));
  };

  const effectiveReadiness = (): Readiness => (baseReadiness.state === 'ready' && linkFailed ? { state: 'connection_failed' } : baseReadiness);

  function pushPanel(state: PanelState, display: DisplayState): void {
    const waiting = state.tasks.find((t) => t.approval)?.approval?.summary;
    const readiness = effectiveReadiness();
    const chosen = chosenEmployee(employees, selectedEmployeeId);
    const mic = state.micMuted ? 'off' : micState(display, controller.wakeListening);
    panel?.webContents.send('panel-state', {
      display,
      // Everything the panel says about who, whether a call can start and the microphone is decided here, in tested code.
      readiness: readiness.state,
      canCall: canCall(readiness),
      employee: chosen?.name,
      employees,
      selectedEmployeeId: chosen?.id,
      caption: captionFor(readiness, display, STATE_TEXT[display], chosen?.name),
      emptyText: emptyText(readiness, shortcutLabel),
      mic,
      micText: MIC_TEXT[mic],
      label: STATE_TEXT[display],
      connected: state.connected,
      transcript: state.transcript,
      reply: state.reply,
      approval: waiting,
      error: state.lastError && display !== 'listening' ? state.lastError.message : undefined,
      shortcut: shortcutLabel,
      autoEnd: options.autoEnd !== false,
      muted: state.micMuted,
      wake: controller.wakeListening,
      inCall: controller.inCall,
      mini,
      debug: !!options.debugDump,
      // The page forgets the turns it has been keeping when this changes (the person signed out).
      epoch: conversationEpoch,
    });
  }

  function pushAttention(): void {
    panel?.webContents.send('panel-attention', {
      segments: hueSegments(attention).map(({ kind, share }) => ({ kind, share })),
      label: attentionLabel(attention),
      shortLabel: attentionShortLabel(attention),
      total: attentionTotal(attention),
    });
  }

  function setDiag(text: string): void {
    diag = text;
    panel?.webContents.send('panel-diag', diag);
  }

  function createPanel(): BrowserWindow {
    const windowOptions = panelWindowOptions(file('panel-preload.cjs'));
    const win = new BrowserWindow({
      ...windowOptions,
      width: panelSize.width,
      height: panelSize.height,
      webPreferences: { ...windowOptions.webPreferences, partition: 'cruzclaw-voice-panel' },
    });
    const bounds = placePanel(displayInfos(), screen.getCursorScreenPoint(), undefined, panelSize);
    if (bounds) win.setBounds(bounds);
    panelLoaded = false;
    void win.loadFile(file('panel.html'));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.once('did-finish-load', () => {
      panelLoaded = true;
      pushPanel(controller.state, controller.display);
      pushAttention();
      setDiag(diag);
      if (pendingBar) {
        pendingBar = false;
        mini = false;
        setMini(true); // moves it to the bar's place and shows it, without focus
      }
      if (pendingShow) {
        pendingShow = false;
        if (!win.isVisible()) win.showInactive();
      }
    });
    win.on('closed', () => {
      if (panel === win) {
        panel = undefined;
        panelLoaded = false;
      }
    });
    return win;
  }

  /** Shows the panel without taking focus. The person's typing stays where it was. */
  function showPanelSilently(): void {
    panel ??= createPanel();
    if (!panelLoaded) {
      pendingShow = true;
      return;
    }
    if (!panel.isVisible()) panel.showInactive();
  }

  function setMini(on: boolean): void {
    if (!panel) return;
    if (on !== mini) {
      mini = on;
      const now = panel.getBounds();
      panel.setBounds(on ? miniBounds(displayInfos(), now, panelSize.height) : expandedBounds(displayInfos(), now, panelSize));
    }
    if (panelLoaded && !panel.isVisible()) panel.showInactive();
    pushPanel(controller.state, controller.display);
  }

  // ---- attention, silently ----

  function applyAttention(raw: unknown): void {
    const next = normalizeAttention(raw);
    if (sameAttention(next, attention)) return;
    attention = next;
    pushAttention();
    // The strip is drawn wherever the panel is. Something waiting brings up the small bar, with no focus, sound or
    // speech, unless the person has closed the panel. Nothing here ever hides it: only the person closes it.
    if (attentionTotal(attention) > 0 && !dismissed && !panel?.isVisible()) showBarSilently();
  }

  // ---- the connection ----

  function newClient(): VoiceClient {
    const mine = ++generation;
    return new VoiceClient(options.connection, {
      onMessage: (m) => {
        if (mine !== generation) return;
        controller.onServer(m);
        const line = conversationLogLine(m, controller.state.reply);
        if (line) log(line);
        if (controller.display !== lastDisplay) log(`state: ${(lastDisplay = controller.display)}`);
      },
      onSpeech: (pcm) => {
        if (mine === generation) controller.onSpeech(pcm);
      },
      onClose: (reason) => {
        if (mine !== generation) return;
        log(reason);
        client = undefined;
        controller.setConnected(false);
        linkFailed = true;
        pushPanel(controller.state, controller.display);
        scheduleReconnect();
      },
    });
  }

  async function connectOnce(): Promise<void> {
    if (disposed || client) return;
    const next = newClient();
    const mine = generation;
    try {
      await next.openConnection();
    } catch (e) {
      if (disposed || mine !== generation) return;
      const wasFailing = linkFailed;
      // A wrong password or an account without voice will not fix itself, and retrying would only repeat the attempt.
      if (e instanceof ConnectionError && e.fatal) {
        log(`${e.message} Fix this and start the app again.`);
        pendingPress.clear();
        controller.showProblem(e.message);
        options.onProblem?.(e.message);
        return;
      }
      log(`${(e as Error).message}. Retrying in ${Math.round(reconnectWait / 1000)} s.`);
      linkFailed = true;
      if (!wasFailing) pushPanel(controller.state, controller.display);
      scheduleReconnect();
      return;
    }
    // The person signed out while this was connecting.
    if (mine !== generation) {
      next.close();
      return;
    }
    client = next;
    reconnectWait = 2000;
    if (linkFailed) {
      linkFailed = false;
      pushPanel(controller.state, controller.display);
    }
    controller.setConnected(true);
    log('connected');
    if (pendingPress.take()) controller.press();
  }

  function scheduleReconnect(): void {
    if (disposed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void connectOnce();
    }, reconnectWait);
    reconnectWait = Math.min(reconnectWait * 2, 15000);
  }

  /** One id for this launch, so the assistant keeps its memory of the conversation across greetings. */
  const conversationId = `host-${randomUUID()}`;

  /** A fresh session replaces the current connection, because a connection carries one session. */
  async function startSession(fresh: boolean, mode?: 'device'): Promise<void> {
    if (fresh && client) {
      const old = client;
      client = undefined;
      generation++; // Silences the old connection's close and messages.
      old.close();
      await connectOnce();
    }
    if (!client) throw new Error('Not connected to the voice server');
    await client.startSession(conversationId, mode);
  }

  // ---- the audio window ----

  function createAudioWindow(): BrowserWindow {
    const win = new BrowserWindow({
      show: false,
      width: 200,
      height: 100,
      webPreferences: {
        preload: file('preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        // Its own storage, so the microphone permission below applies to this window and nothing else in the app.
        partition: 'cruzclaw-voice-audio',
        // The window is hidden, and the speaker must keep playing while it is.
        backgroundThrottling: false,
      },
    });
    void win.loadFile(file('audio.html'));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    // Only this window may use the microphone, and nothing else may.
    const own = win.webContents.session;
    own.setPermissionRequestHandler((wc, permission, callback) => callback(permission === 'media' && wc === win.webContents));
    own.setPermissionCheckHandler((wc, permission) => permission === 'media' && wc === win.webContents);
    return win;
  }

  /** Writes the captured utterance as a 24 kHz mono WAV so its quality can be checked by ear or by a transcriber. */
  function saveUtterance(): void {
    if (!options.debugDump || !utterance.length) return;
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
    const target = path.join(os.tmpdir(), 'voice-last-utterance.wav');
    writeFileSync(target, Buffer.concat([header, pcm]));
    log(`saved ${(pcm.length / 48000).toFixed(1)} s of microphone audio to ${target}`);
  }

  // ---- messages from the two windows ----

  const fromAudio = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean => !disposed && !!audioWindow && event.sender === audioWindow.webContents;
  const fromPanel = (event: Electron.IpcMainEvent): boolean => !disposed && !!panel && event.sender === panel.webContents;
  const listeners: Array<[string, (...args: any[]) => void]> = [];
  const on = (channel: string, listener: (event: Electron.IpcMainEvent, ...args: any[]) => void): void => {
    ipcMain.on(channel, listener);
    listeners.push([channel, listener]);
  };

  on('mic', (event, data: ArrayBuffer) => {
    if (!fromAudio(event)) return;
    if (options.debugDump && controller.state.phase === 'listening') utterance.push(Buffer.from(data));
    controller.onMic(new Uint8Array(data));
  });
  on('level', (event, level: unknown) => {
    if (fromAudio(event) && typeof level === 'number' && controller.state.phase === 'listening') {
      panel?.webContents.send('panel-level', level);
      controller.onLevel(level);
    }
  });
  on('playback-drained', (event, count: unknown) => {
    // Only the report that covers every chunk sent so far means the speaker is quiet.
    if (!fromAudio(event) || count !== chunksSent) return;
    speakerBusy = false;
    controller.onPlaybackDrained();
  });
  on('audio-ready', (event) => {
    if (!fromAudio(event) || !audioWindow) return;
    // The page is ready: deliver, in order, everything that was waiting for it.
    audioReady = true;
    const waiting = audioBacklog;
    audioBacklog = [];
    for (const [channel, args] of waiting) audioWindow.webContents.send(channel, ...args);
    // The window loads after the connection may already be up, so tell it what to do now.
    if (controller.wakeListening && !waiting.some(([channel]) => channel === 'wake-mic')) audioWindow.webContents.send('wake-mic', true);
  });
  on('audio-info', (event, message: unknown) => {
    if (!fromAudio(event)) return;
    const text = String(message).slice(0, 200);
    log(`audio: ${text}`);
    setDiag(text);
  });
  on('audio-error', (event, message: unknown) => {
    if (!fromAudio(event)) return;
    log(`audio problem: ${String(message).slice(0, 200)}`);
    setDiag(`Audio problem: ${String(message).slice(0, 120)}`);
  });
  on('out-level', (event, level: unknown) => {
    // How loud the assistant's voice is right now, measured at the speaker, to move the orb with it.
    if (!fromAudio(event) || typeof level !== 'number') return;
    peakSpeakerLevel = Math.max(peakSpeakerLevel, level);
    if (controller.state.phase === 'speaking') panel?.webContents.send('panel-level', level);
  });
  on('panel-talk', (event) => void (fromPanel(event) && pressNow()));
  on('panel-hangup', (event) => {
    if (!fromPanel(event)) return;
    pendingPress.clear();
    controller.hangUp();
  });
  on('panel-mute', (event) => void (fromPanel(event) && controller.toggleMute()));
  on('panel-minimize', (event) => void (fromPanel(event) && setMini(true)));
  on('panel-expand', (event) => void (fromPanel(event) && setMini(false)));
  on('panel-hide', (event) => void (fromPanel(event) && dismissPanel()));
  on('panel-choose-employee', (event, id: unknown) => {
    if (!fromPanel(event) || typeof id !== 'string' || !employees.some((e) => e.id === id)) return;
    options.onEmployeeChoose?.(id);
  });
  on('panel-attention-open', (event) => void (fromPanel(event) && options.onAttentionOpen?.()));

  /** Closing is the person's act and lasts until the next showPanel, press or showBar (or the next launch). */
  function dismissPanel(): void {
    dismissed = true;
    pendingShow = false;
    pendingBar = false;
    panel?.hide();
  }

  /** The small bar, without focus. */
  function showBarSilently(): void {
    dismissed = false;
    panel ??= createPanel();
    if (panelLoaded) setMini(true);
    else {
      pendingBar = true;
      pendingShow = true;
    }
  }

  /**
   * Call pressed in the panel or with the shortcut. A call connects when it is pressed, so a press before the
   * connection is up connects now and starts the call when it is. If the account is not ready, nothing connects:
   * the panel opens and says why.
   */
  function pressNow(): void {
    if (!canCall(effectiveReadiness())) {
      log(`call not started: ${effectiveReadiness().state}`);
      return;
    }
    if (!controller.state.connected) {
      pendingPress.request();
      void connectOnce();
      return;
    }
    controller.press();
  }

  // ---- the handle ----

  const host: VoiceHost = {
    controller,
    start: () => void connectOnce(),
    press: () => {
      dismissed = false;
      showPanelSilently();
      // Not ready: show the full panel so the reason is on screen, and start nothing.
      if (!canCall(effectiveReadiness()) && mini) setMini(false);
      pressNow();
    },
    hangUp: () => {
      pendingPress.clear();
      controller.hangUp();
    },
    endSession: (reason = 'signed_out') => {
      pendingPress.clear();
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      reconnectWait = 2000;
      // Whatever the old connection still says is ignored, and a connection still being opened is closed when it opens.
      generation += 1;
      conversationEpoch += 1;
      const old = client;
      client = undefined;
      // Before the panel is told, so a failure from the earlier account is not shown to whoever comes next.
      linkFailed = false;
      controller.endConversation();
      old?.close();
      log(reason === 'employee_changed' ? 'employee changed: the call and the connection were closed' : 'signed out: the call and the connection were closed');
    },
    toggleMute: () => controller.toggleMute(),
    showPanel: () => {
      dismissed = false;
      showPanelSilently();
      if (mini) setMini(false);
    },
    showBar: showBarSilently,
    hidePanel: dismissPanel,
    setEmployees(list, selectedId) {
      employees = cleanEmployees(list);
      selectedEmployeeId = chosenEmployee(employees, selectedId)?.id;
      pushPanel(controller.state, controller.display);
    },
    setReadiness(value) {
      baseReadiness = cleanReadiness(value);
      pushPanel(controller.state, controller.display);
    },
    get readiness() {
      return effectiveReadiness();
    },
    panelVisible: () => !!panel && panel.isVisible(),
    setAttention: applyAttention,
    get attention() {
      return attention;
    },
    async enableWake() {
      if (!options.wakeModelDir || wakeDetector) return !!wakeDetector;
      try {
        const { createSherpaWakeDetector } = await import('@cruzclaw/wake-word');
        const detector = await createSherpaWakeDetector({ modelDir: options.wakeModelDir, sampleRate: 24000 });
        if (disposed) {
          detector.dispose();
          return false;
        }
        wakeDetector = detector;
        controller.enableWake({ feed: (pcm) => detector.feed(pcm), reset: () => detector.reset() });
        log('wake phrase on. Audio is checked on this machine only.');
        return true;
      } catch (e) {
        log(`wake phrase is off: ${e instanceof Error ? e.message : 'could not start'}`);
        return false;
      }
    },
    disableWake() {
      wakeDetector?.dispose();
      wakeDetector = undefined;
      controller.disableWake();
    },
    get wakeOn() {
      return !!wakeDetector;
    },
    testSpeaker: () => toAudio(needAudio(), 'beep'),
    async selfTest() {
      // Proves the voice path on this machine without a server: the speech process makes a phrase, it goes to the
      // speaker, and the speaker's own level meter hears it.
      if (!speech) return { ok: false, reason: 'device speech is off' };
      needAudio();
      const started = Date.now();
      let bytes = 0;
      let firstAudioMs = -1;
      try {
        for await (const pcm of speech.synthesize('Hello. This is a test of the voice on this device.', new AbortController().signal)) {
          if (firstAudioMs < 0) firstAudioMs = Date.now() - started;
          bytes += pcm.byteLength;
          audio.play(pcm);
        }
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : 'the voice failed' };
      }
      const seconds = bytes / 2 / 24000;
      await new Promise((r) => setTimeout(r, seconds * 1000 + 800)); // let it play out
      return { ok: bytes > 0 && peakSpeakerLevel > 0.01, seconds, firstAudioMs, peakLevel: peakSpeakerLevel };
    },
    describe: () => ({ visible: !!panel && panel.isVisible(), mini, bounds: panel?.getBounds(), attention }),
    dispose() {
      disposed = true;
      clearTimeout(reconnectTimer);
      controller.dispose();
      wakeDetector?.dispose();
      client?.close();
      speech?.dispose();
      for (const [channel, listener] of listeners) ipcMain.removeListener(channel, listener);
      for (const win of [panel, audioWindow]) if (win && !win.isDestroyed()) win.destroy();
      panel = undefined;
      audioWindow = undefined;
    },
  };

  return host;
}
