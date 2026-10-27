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

  it('settles out of thinking when the reply ended without speech', () => {
    let s = run([server({ type: 'transcript.final', utteranceId: 'u', text: 'hi' }), server({ type: 'assistant.text.done', turnId: 't' })], ready());
    assert.equal(displayState(s), 'thinking');
    s = run([ui({ type: 'settle' })], s);
    assert.equal(displayState(s), 'idle');
    const stillThinking = run([server({ type: 'transcript.final', utteranceId: 'u3', text: 'x' }), ui({ type: 'settle' })], s);
    assert.equal(displayState(stillThinking), 'thinking');
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
