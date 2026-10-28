import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { ServerMessage } from '@cruzclaw/voice-core';
import {
  DEFAULT_PREFERENCES,
  FilePreferenceStore,
  ShortcutManager,
  defaultBounds,
  expandedBounds,
  miniBounds,
  displayState,
  effectsFor,
  initialPanelState,
  loadPreferences,
  panelWindowOptions,
  parsePreferences,
  placePanel,
  reducePanel,
  savePreferences,
  validateAccelerator,
  type DisplayInfo,
  type PanelEvent,
  type PanelState,
  type ShortcutRegistrar,
  type UiAction,
} from '../src/index.js';

const audio = { encoding: 'pcm_s16le', sampleRate: 16000, channels: 1 } as const;
let seq = 0;
const server = (m: object): PanelEvent => ({ kind: 'server', message: { v: 1, seq: ++seq, ...m } as ServerMessage });
const ui = (action: UiAction): PanelEvent => ({ kind: 'ui', action });
const run = (events: PanelEvent[], from = initialPanelState()): PanelState => events.reduce(reducePanel, from);
/** A connected, idle panel. Does not touch seq, so messages built before it is called stay valid. */
const ready = (): PanelState => ({ ...initialPanelState(), connected: true, sessionActive: true });
const task = { taskId: 'task-1', idempotencyKey: 'k', conversationId: 'c', intent: 'send_email', state: 'proposed', createdAt: '', updatedAt: '' };
const taskEvent = (state: string) => server({ type: 'task.event', event: { seq: 1, taskId: 'task-1', type: 'state', state, message: '', at: '' } });

describe('panel state', () => {
  it('starts disconnected and shows each state from the issue', () => {
    assert.equal(displayState(initialPanelState()), 'disconnected');
    let s = ready();
    assert.equal(displayState(s), 'idle');
    s = run([ui({ type: 'listen_start' })], s);
    assert.equal(displayState(s), 'listening');
    s = run([server({ type: 'transcript.final', utteranceId: 'u', text: 'hi' })], s);
    assert.equal(displayState(s), 'thinking');
    s = run([server({ type: 'tts.start', ttsId: 't', turnId: 'x', audio })], s);
    assert.equal(displayState(s), 'speaking');
    s = run([server({ type: 'tts.end', ttsId: 't' }), server({ type: 'task.proposed', task })], s);
    assert.equal(displayState(s), 'task_working');
    s = run([server({ type: 'approval.requested', approval: { approvalId: 'a1', taskId: 'task-1', state: 'pending', payloadHash: 'h' }, summary: 'Send it' })], s);
    assert.equal(displayState(s), 'awaiting_approval');
    s = run([{ kind: 'connection', connected: false }], s);
    assert.equal(displayState(s), 'disconnected');
  });

  it('never says Done before the host reports confirmed', () => {
    let s = run([server({ type: 'task.proposed', task })], ready());
    for (const state of ['proposed', 'accepted', 'dispatched']) {
      s = run([taskEvent(state)], s);
      assert.notEqual(s.tasks[0]!.label, 'Done', state);
    }
    s = run([taskEvent('confirmed')], s);
    assert.equal(s.tasks[0]!.label, 'Done');
    assert.equal(displayState(s), 'idle');
  });

  it('clears the approval prompt once the task moves on', () => {
    let s = run([server({ type: 'task.proposed', task }), server({ type: 'approval.requested', approval: { approvalId: 'a1', taskId: 'task-1', state: 'pending', payloadHash: 'h' }, summary: 's' })], ready());
    assert.ok(s.tasks[0]!.approval);
    s = run([taskEvent('dispatched')], s);
    assert.equal(s.tasks[0]!.approval, undefined);
  });

  it('ignores replayed server messages and resets seq on a new connection', () => {
    let s = ready();
    const first = server({ type: 'transcript.final', utteranceId: 'u', text: 'one' });
    s = run([first], s);
    const after = run([first], s);
    assert.equal(after, s);
    s = run([{ kind: 'connection', connected: false }, { kind: 'connection', connected: true }], s);
    s = run([server({ type: 'transcript.final', utteranceId: 'u2', text: 'two' })], s);
    assert.equal(s.transcript, 'two');
  });

  it('applies a message the host made itself, even though it carries no server seq, and does not disturb the server seq', () => {
    let s = run([server({ type: 'transcript.final', utteranceId: 'u', text: 'one' })], ready());
    const seqBefore = s.lastSeq;
    const fmt = { encoding: 'pcm_s16le', sampleRate: 24000, channels: 1 } as const;
    s = reducePanel(s, { kind: 'local', message: { v: 1, seq: 0, type: 'tts.start', ttsId: 'l', turnId: 't', audio: fmt } });
    assert.equal(displayState(s), 'speaking');
    assert.equal(s.lastSeq, seqBefore, 'the next real server message is not mistaken for a replay');
    s = reducePanel(s, { kind: 'local', message: { v: 1, seq: 0, type: 'tts.end', ttsId: 'l' } });
    assert.equal(displayState(s), 'idle');
    // The same message as a server message is dropped as a replay, which is why local exists.
    const dropped = reducePanel(s, { kind: 'server', message: { v: 1, seq: 0, type: 'tts.start', ttsId: 'l', turnId: 't', audio: fmt } });
    assert.equal(dropped, s);
  });

  it('settles out of thinking when the reply ended without speech', () => {
    let s = run([server({ type: 'transcript.final', utteranceId: 'u', text: 'hi' }), server({ type: 'assistant.text.done', turnId: 't' })], ready());
    assert.equal(displayState(s), 'thinking');
    s = run([ui({ type: 'settle' })], s);
    assert.equal(displayState(s), 'idle');
    const stillThinking = run([server({ type: 'transcript.final', utteranceId: 'u3', text: 'x' }), ui({ type: 'settle' })], s);
    assert.equal(displayState(stillThinking), 'thinking');
  });

  it('leaves thinking and speaking when the server reports an error', () => {
    const failed = (phaseEvents: PanelEvent[]) =>
      run([...phaseEvents, server({ type: 'error', code: 'PROVIDER_ERROR', message: 'x', retryable: true })], ready());
    assert.equal(displayState(failed([ui({ type: 'listen_start' }), ui({ type: 'listen_end' })])), 'idle');
    assert.equal(displayState(failed([server({ type: 'tts.start', ttsId: 't', turnId: 'u', audio })])), 'idle');
    assert.equal(failed([]).lastError?.code, 'PROVIDER_ERROR');
  });

  it('gives up waiting when nothing was recognised, but not while real speech is being answered', () => {
    const silent = run([ui({ type: 'listen_start' }), ui({ type: 'listen_end' })], ready());
    assert.equal(displayState(silent), 'thinking');
    const gaveUp = run([ui({ type: 'no_response' })], silent);
    assert.equal(displayState(gaveUp), 'idle');
    assert.equal(gaveUp.lastError?.code, 'NO_SPEECH');
    const heard = run([ui({ type: 'listen_start' }), ui({ type: 'listen_end' }), server({ type: 'transcript.final', utteranceId: 'u', text: 'hello' })], ready());
    assert.equal(displayState(run([ui({ type: 'no_response' })], heard)), 'thinking');
  });

  it('starts the screen fresh on a new session, so a greeting does not join the previous reply', () => {
    const old = run([server({ type: 'transcript.final', utteranceId: 'u', text: 'hi' }), server({ type: 'assistant.text.delta', turnId: 't', text: 'Earlier reply.' })], ready());
    assert.equal(old.reply, 'Earlier reply.');
    const fresh = run([{ kind: 'connection', connected: true }, server({ type: 'session.ready', sessionId: 's', audio }), server({ type: 'assistant.text.delta', turnId: 'turn-1', text: 'Hi Dana.' })], old);
    assert.equal(fresh.reply, 'Hi Dana.');
    assert.equal(fresh.transcript, '');
  });

  it('keeps mute local and stops listening when muted', () => {
    let s = run([ui({ type: 'listen_start' })], ready());
    s = run([ui({ type: 'toggle_mute' })], s);
    assert.equal(s.micMuted, true);
    assert.equal(s.phase, 'idle');
    assert.equal(run([ui({ type: 'listen_start' })], s).phase, 'idle');
  });
});

describe('controls', () => {
  const sent = (s: PanelState, c: Parameters<typeof effectsFor>[1]) =>
    effectsFor(s, c).flatMap((e) => (e.type === 'send' ? [e.message.type] : []));

  it('makes stop speaking, end session and cancel task three distinct messages', () => {
    let s = run([server({ type: 'task.proposed', task }), server({ type: 'tts.start', ttsId: 't', turnId: 'x', audio })], ready());
    assert.deepEqual(sent(s, 'stop_speaking'), ['interrupt']);
    assert.deepEqual(sent(s, 'cancel_task'), ['task.cancel']);
    assert.deepEqual(sent(s, 'end_session'), ['session.end']);
    assert.deepEqual(sent(s, 'mute'), []);
    s = run([taskEvent('confirmed')], s);
    assert.deepEqual(sent(s, 'cancel_task'), []);
  });

  it('does nothing for stop speaking when nothing is speaking', () => {
    assert.deepEqual(effectsFor(ready(), 'stop_speaking'), []);
  });

  it('cancels only the selected task', () => {
    const second = { ...task, taskId: 'task-2' };
    let s = run([server({ type: 'task.proposed', task }), server({ type: 'task.proposed', task: second }), ui({ type: 'select_task', taskId: 'task-2' })], ready());
    const e = effectsFor(s, 'cancel_task')[0];
    assert.ok(e && e.type === 'send' && e.message.type === 'task.cancel' && e.message.taskId === 'task-2');
  });

  it('summon: shows with focus and starts listening from idle', () => {
    const e = effectsFor(ready(), 'summon');
    assert.deepEqual(e.map((x) => x.type), ['show', 'capture']);
    assert.deepEqual(e[0], { type: 'show', focus: true });
  });

  it('summon during speech barges in, then listens', () => {
    const s = run([server({ type: 'tts.start', ttsId: 't', turnId: 'x', audio })], ready());
    const e = effectsFor(s, 'summon');
    const interrupt = e.find((x) => x.type === 'send');
    assert.ok(interrupt && interrupt.type === 'send' && interrupt.message.type === 'interrupt' && interrupt.message.reason === 'barge_in');
    assert.deepEqual(e.at(-1), { type: 'capture', on: true });
  });

  it('summon while thinking also cuts in, then listens', () => {
    const s = run([ui({ type: 'listen_start' }), ui({ type: 'listen_end' })], ready());
    assert.equal(displayState(s), 'thinking');
    const e = effectsFor(s, 'summon');
    assert.ok(e.some((x) => x.type === 'send' && x.message.type === 'interrupt'));
    assert.deepEqual(e.at(-1), { type: 'capture', on: true });
  });

  it('a quiet listen_cancel returns to idle without an error; a normal one reports nothing heard', () => {
    const listening = run([ui({ type: 'listen_start' })], ready());
    const quiet = run([ui({ type: 'listen_cancel', quiet: true })], listening);
    assert.equal(displayState(quiet), 'idle');
    assert.equal(quiet.lastError, undefined);
    assert.equal(run([ui({ type: 'listen_cancel' })], listening).lastError?.code, 'NO_SPEECH');
  });

  it('hanging up returns every busy phase to idle and keeps what was said on screen', () => {
    for (const busy of [
      [ui({ type: 'listen_start' })],
      [ui({ type: 'listen_start' }), ui({ type: 'listen_end' })],
      [server({ type: 'tts.start', ttsId: 't', turnId: 'x', audio })],
    ]) {
      const before = run([...busy, server({ type: 'transcript.final', utteranceId: 'u', text: 'hello' })], ready());
      const after = run([ui({ type: 'hung_up' })], before);
      assert.equal(displayState(after), 'idle');
      assert.equal(after.transcript, 'hello');
    }
  });

  it('an interrupt returns thinking or speaking to idle, and a failed session shows its message', () => {
    const thinking = run([ui({ type: 'listen_start' }), ui({ type: 'listen_end' }), ui({ type: 'interrupted' })], ready());
    assert.equal(displayState(thinking), 'idle');
    const speaking = run([server({ type: 'tts.start', ttsId: 't', turnId: 'x', audio }), ui({ type: 'interrupted' })], ready());
    assert.equal(displayState(speaking), 'idle');
    const listening = run([ui({ type: 'listen_start' }), ui({ type: 'interrupted' })], ready());
    assert.equal(displayState(listening), 'listening');
    const failed = run([ui({ type: 'session_failed', message: 'refused' })], ready());
    assert.equal(failed.lastError?.message, 'refused');
  });

  it('summon while listening ends the input; while disconnected or muted it only shows', () => {
    const listening = run([ui({ type: 'listen_start' })], ready());
    assert.deepEqual(sent(listening, 'summon'), ['input.end']);
    assert.deepEqual(effectsFor(initialPanelState(), 'summon').map((x) => x.type), ['show']);
    const muted = run([ui({ type: 'toggle_mute' })], ready());
    assert.deepEqual(effectsFor(muted, 'summon').map((x) => x.type), ['show']);
  });

  it('dismiss hides and does not end the session', () => {
    assert.deepEqual(effectsFor(ready(), 'dismiss'), [{ type: 'hide' }]);
  });
});

describe('shortcut', () => {
  it('accepts the default and rejects unsafe or malformed combos', () => {
    assert.deepEqual(validateAccelerator('Ctrl+Shift+Space'), { ok: true, normalized: 'Ctrl+Shift+Space' });
    assert.equal(validateAccelerator('Alt+F9').ok, true);
    for (const bad of ['', 'Space', 'Shift+A', 'Ctrl+Shift', 'Ctrl+Ctrl+A', 'Ctrl+Banana+A', 'Ctrl+', 'Ctrl+F25', 'Ctrl+Nope']) {
      assert.equal(validateAccelerator(bad).ok, false, bad);
    }
  });

  function fakeRegistrar(taken: string[] = []) {
    const held = new Map<string, () => void>();
    const registrar: ShortcutRegistrar = {
      register: (a, h) => (taken.includes(a) ? false : (held.set(a, h), true)),
      unregister: (a) => void held.delete(a),
    };
    return { registrar, held };
  }

  it('registers the preferred combo', () => {
    const { registrar, held } = fakeRegistrar();
    const m = new ShortcutManager(registrar, () => undefined);
    assert.deepEqual(m.apply('Ctrl+Shift+Space'), { status: 'registered', active: 'Ctrl+Shift+Space' });
    assert.equal(held.size, 1);
  });

  it('falls back and reports the conflict when another app owns the combo', () => {
    const { registrar } = fakeRegistrar(['Ctrl+Shift+Space']);
    const m = new ShortcutManager(registrar, () => undefined);
    assert.deepEqual(m.apply('Ctrl+Shift+Space', ['Ctrl+Alt+Space']), {
      status: 'fallback',
      active: 'Ctrl+Alt+Space',
      unavailable: ['Ctrl+Shift+Space'],
    });
  });

  it('keeps the old shortcut when a change fails', () => {
    const { registrar, held } = fakeRegistrar(['Ctrl+Alt+K']);
    const m = new ShortcutManager(registrar, () => undefined);
    m.apply('Ctrl+Shift+Space');
    const r = m.apply('Ctrl+Alt+K');
    assert.equal(r.status, 'conflict');
    assert.equal(m.active, 'Ctrl+Shift+Space');
    assert.deepEqual([...held.keys()], ['Ctrl+Shift+Space']);
    assert.equal(m.apply('Shift+A').status, 'invalid');
    assert.equal(m.active, 'Ctrl+Shift+Space');
  });

  it('releases the old combo after a successful change, and on dispose', () => {
    const { registrar, held } = fakeRegistrar();
    const m = new ShortcutManager(registrar, () => undefined);
    m.apply('Ctrl+Shift+Space');
    m.apply('Ctrl+Alt+K');
    assert.deepEqual([...held.keys()], ['Ctrl+Alt+K']);
    m.dispose();
    assert.equal(held.size, 0);
  });

  it('treats key repeat as one press', () => {
    const { registrar, held } = fakeRegistrar();
    let t = 0;
    let fired = 0;
    const m = new ShortcutManager(registrar, () => fired++, () => t);
    m.apply('Ctrl+Shift+Space');
    const press = held.get('Ctrl+Shift+Space')!;
    press();
    t = 100;
    press();
    t = 200;
    press();
    assert.equal(fired, 1);
    t = 500;
    press();
    assert.equal(fired, 2);
  });
});

describe('preferences', () => {
  it('defaults to the standard shortcut and no startup launch', () => {
    assert.deepEqual(parsePreferences(undefined), DEFAULT_PREFERENCES);
    assert.equal(DEFAULT_PREFERENCES.launchAtStartup, false);
  });

  it('keeps good fields and defaults bad ones', () => {
    const p = parsePreferences({ shortcut: 'Shift+A', launchAtStartup: 'yes', lastBounds: { x: 1, y: 2, width: 0, height: 5 } });
    assert.equal(p.shortcut, 'Ctrl+Shift+Space');
    assert.equal(p.launchAtStartup, false);
    assert.equal(p.lastBounds, undefined);
    assert.equal(parsePreferences({ shortcut: 'Ctrl+Alt+K', launchAtStartup: true }).launchAtStartup, true);
  });

  it('persists to a file atomically and survives a corrupt file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'prefs-'));
    try {
      const path = join(dir, 'nested', 'prefs.json');
      const store = new FilePreferenceStore(path);
      assert.deepEqual(await loadPreferences(store), DEFAULT_PREFERENCES);
      await savePreferences(store, { shortcut: 'Ctrl+Alt+K', launchAtStartup: true, lastBounds: { x: 10, y: 20, width: 380, height: 180 } });
      assert.equal((await loadPreferences(store)).shortcut, 'Ctrl+Alt+K');
      assert.equal(JSON.parse(await readFile(path, 'utf8')).launchAtStartup, true);
      await writeFile(path, '{not json');
      assert.deepEqual(await loadPreferences(store), DEFAULT_PREFERENCES);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('placement', () => {
  const left: DisplayInfo = { id: 1, primary: true, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
  const right: DisplayInfo = { id: 2, workArea: { x: 1920, y: 0, width: 1280, height: 984 } };

  it('puts the panel bottom-right of the display under the cursor', () => {
    assert.deepEqual(placePanel([left, right], { x: 100, y: 100 }), { x: 1524, y: 844, width: 380, height: 180 });
    assert.deepEqual(placePanel([left, right], { x: 2500, y: 100 }), { x: 2804, y: 788, width: 380, height: 180 });
  });

  it('keeps a saved spot only while it is still on a connected display', () => {
    const saved = { x: 2000, y: 100, width: 380, height: 180 };
    assert.deepEqual(placePanel([left, right], { x: 0, y: 0 }, saved), saved);
    assert.deepEqual(placePanel([left], { x: 0, y: 0 }, saved), { x: 1524, y: 844, width: 380, height: 180 });
  });

  it('never places the panel off a small display, and handles no displays', () => {
    const tiny: DisplayInfo = { id: 3, workArea: { x: 0, y: 0, width: 300, height: 120 } };
    assert.deepEqual(defaultBounds(tiny), { x: 0, y: 0, width: 300, height: 120 });
    assert.equal(placePanel([], { x: 0, y: 0 }), undefined);
  });
});

describe('window options', () => {
  it('is frameless, on top, out of the taskbar, hidden at creation and locked down', () => {
    const o = panelWindowOptions('preload.js');
    assert.equal(o.frame, false);
    assert.equal(o.alwaysOnTop, true);
    assert.equal(o.skipTaskbar, true);
    assert.equal(o.show, false);
    assert.equal(o.webPreferences.contextIsolation, true);
    assert.equal(o.webPreferences.nodeIntegration, false);
    assert.equal(o.webPreferences.sandbox, true);
  });
});

describe('minimised bar placement', () => {
  const taskbarBottom: DisplayInfo = { id: 1, primary: true, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }; // a 40 px taskbar
  const second: DisplayInfo = { id: 2, workArea: { x: 1920, y: 0, width: 1920, height: 1080 } };
  const full = { x: 1500, y: 600, width: 342, height: 330 };

  it('is as tall as its buttons and the 4 px strip need, the same width and left edge, resting just above the taskbar', () => {
    const mini = miniBounds([taskbarBottom], full, 330);
    assert.equal(mini.height, 36);
    assert.equal(mini.width, 342);
    assert.equal(mini.x, 1500);
    assert.equal(mini.y + mini.height, 1040 - 4, 'bottom edge is 4 px above the taskbar');
  });

  it('never goes thinner than its buttons need, and stays on a display where the window is', () => {
    assert.equal(miniBounds([taskbarBottom], full, 200).height, 36);
    const onSecond = miniBounds([taskbarBottom, second], { ...full, x: 2400 }, 330);
    assert.equal(onSecond.y + onSecond.height, 1080 - 4);
    assert.equal(onSecond.x, 2400);
  });

  it('pulls a bar that would hang off the right edge back onto the screen', () => {
    const mini = miniBounds([taskbarBottom], { ...full, x: 1800 }, 330);
    assert.equal(mini.x, 1920 - 342);
  });

  it('expands upward from the bar, and stays on screen', () => {
    const mini = miniBounds([taskbarBottom], full, 330);
    const back = expandedBounds([taskbarBottom], mini, { width: 342, height: 330 });
    assert.equal(back.height, 330);
    assert.equal(back.y + back.height, mini.y + mini.height, 'bottom edge stays where the bar was');
    const nearTop = expandedBounds([taskbarBottom], { x: 100, y: 10, width: 342, height: 33 }, { width: 342, height: 330 });
    assert.equal(nearTop.y, 0, 'clamped to the top of the work area');
  });

  it('with no display information it keeps the size and does not throw', () => {
    assert.deepEqual(miniBounds([], full, 330), { ...full, height: 36 });
    assert.equal(expandedBounds([], { x: 5, y: 900, width: 342, height: 36 }, { width: 342, height: 330 }).height, 330);
  });
});
