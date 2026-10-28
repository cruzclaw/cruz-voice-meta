import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MIC_TEXT,
  type Readiness,
  type ReadinessState,
  canCall,
  caption,
  chosenEmployee,
  cleanEmployees,
  cleanReadiness,
  emptyText,
  micState,
} from '../src/panel-view.js';

const ALL: ReadinessState[] = ['checking', 'ready', 'voice_disabled', 'no_employee', 'no_employees', 'connection_failed', 'signed_out'];
const r = (state: ReadinessState): Readiness => ({ state }) as Readiness;

describe('what the panel says when a call cannot start', () => {
  it('lets only a ready account call', () => {
    for (const state of ALL) assert.equal(canCall(r(state)), state === 'ready', state);
  });

  it('tells the five reasons apart, in different words', () => {
    const lines = ALL.filter((s) => s !== 'ready').map((s) => emptyText(r(s), 'Ctrl+Shift+Space'));
    assert.equal(new Set(lines).size, lines.length);
    assert.match(emptyText(r('voice_disabled'), 'Ctrl+Shift+Space'), /not turned on/);
    assert.match(emptyText(r('no_employee'), 'Ctrl+Shift+Space'), /Choose which employee/);
    assert.match(emptyText(r('connection_failed'), 'Ctrl+Shift+Space'), /Cannot reach/);
  });

  it('points at the Call button and the shortcut only when a call can actually start', () => {
    for (const state of ALL) {
      const text = emptyText(r(state), 'Ctrl+Shift+Space');
      assert.equal(/Call|Ctrl\+Shift\+Space/.test(text), state === 'ready', `${state}: ${text}`);
    }
    assert.equal(emptyText(r('ready'), ''), 'Press Call to start.');
  });

  it('never points at the tray menu, which may not offer anything yet', () => {
    for (const state of ALL) assert.equal(/tray|menu/i.test(emptyText(r(state), 'Ctrl+Shift+Space')), false, state);
  });

  it('says Ready, not Not connected, before a call, and names the employee', () => {
    assert.equal(caption(r('ready'), 'disconnected', 'Not connected', 'Tesla'), 'Tesla · Ready');
    assert.equal(caption(r('ready'), 'listening', 'Listening', 'Tesla'), 'Tesla · Listening');
    assert.equal(caption(r('ready'), 'idle', 'Ready', undefined), 'Ready');
  });

  it('gives each blocked state its own short caption', () => {
    assert.equal(caption(r('voice_disabled'), 'disconnected', 'Not connected', 'Tesla'), 'Voice not enabled');
    assert.equal(caption(r('no_employee'), 'disconnected', 'Not connected', undefined), 'Choose employee');
    assert.equal(caption(r('connection_failed'), 'disconnected', 'Not connected', 'Tesla'), 'Tesla · Cannot connect');
  });
});

describe('the microphone, said separately from everything else', () => {
  it('has exactly three states with their own words', () => {
    assert.deepEqual(MIC_TEXT, { off: 'Mic off', wake: 'Wake listening', listening: 'Listening to you' });
  });

  it('is listening only while the conversation is listening', () => {
    assert.equal(micState('listening', false), 'listening');
    assert.equal(micState('listening', true), 'listening');
  });

  it('is wake listening only when the wake phrase is on and no conversation is listening', () => {
    assert.equal(micState('idle', true), 'wake');
    assert.equal(micState('disconnected', true), 'wake');
  });

  it('is off otherwise, including in a call that is thinking or speaking', () => {
    for (const display of ['disconnected', 'idle', 'thinking', 'speaking', 'awaiting_approval', 'task_working'] as const) {
      assert.equal(micState(display, false), 'off', display);
    }
  });
});

describe('the employee list', () => {
  it('shows a chosen employee only if the account still has them', () => {
    const list = [{ id: 'a', name: 'Tesla' }, { id: 'b', name: 'Ops' }];
    assert.deepEqual(chosenEmployee(list, 'a'), list[0]);
    assert.equal(chosenEmployee(list, 'gone'), undefined);
    assert.equal(chosenEmployee(list, undefined), undefined);
    assert.equal(chosenEmployee(list, ''), undefined);
  });

  it('keeps only well-formed, distinct employees and trims their names', () => {
    const cleaned = cleanEmployees([{ id: 'a', name: '  Tesla ' }, { id: 'a', name: 'Dup' }, { id: '', name: 'x' }, { id: 'c' }, null, 5, { id: 'd', name: '   ' }]);
    assert.deepEqual(cleaned, [{ id: 'a', name: 'Tesla' }]);
    assert.deepEqual(cleanEmployees('nope'), []);
  });

  it('treats an unknown readiness as checking, so a wrong value can never enable Call', () => {
    assert.deepEqual(cleanReadiness({ state: 'ready' }), { state: 'ready' });
    assert.deepEqual(cleanReadiness({ state: 'banana' }), { state: 'checking' });
    assert.deepEqual(cleanReadiness(undefined), { state: 'checking' });
    assert.equal(canCall(cleanReadiness({ state: 'READY' })), false);
  });
});
