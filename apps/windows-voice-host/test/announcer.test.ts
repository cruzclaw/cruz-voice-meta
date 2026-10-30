import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { ANNOUNCE_AUDIBLE_MS, ANNOUNCE_TOTAL_MS, createAnnouncer, type AnnounceResult } from '../src/announcer.js';

/** A voice that makes one chunk, a few, or none. */
const voice = (chunks: number) => ({
  async *synthesize(_text: string, _signal: AbortSignal): AsyncIterable<Uint8Array> {
    for (let i = 0; i < chunks; i++) yield new Uint8Array(960);
  },
});

function setup(over: { chunks?: number; speech?: ReturnType<typeof voice> | undefined; inCall?: boolean; busy?: boolean } = {}) {
  const state = { played: 0, stops: 0, busy: over.busy ?? false, logs: [] as string[] };
  const announcer = createAnnouncer({
    speech: 'speech' in over ? over.speech : voice(over.chunks ?? 1),
    isDisposed: () => false,
    inCall: () => over.inCall ?? false,
    speakerBusy: () => state.busy,
    prepare: () => undefined,
    play: () => {
      state.played += 1;
      state.busy = true;
    },
    stopPlayback: () => {
      state.stops += 1;
      state.busy = false;
    },
    log: (line) => state.logs.push(line),
  });
  return { announcer, state };
}

/** Lets the speech loop run to its end. It uses no timers, so fake timers do not hold it up. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe('an announcement says honestly whether it played', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
  afterEach(() => mock.timers.reset());

  it('plays: the sound began and then the speaker went quiet', async () => {
    const { announcer, state } = setup();
    const result = announcer.announce('Hello');
    await settle();
    announcer.onStarted();
    state.busy = false;
    announcer.onDrained();

    assert.equal(await result, 'played' satisfies AnnounceResult);
    assert.equal(announcer.failure(), '');
    assert.equal(announcer.active, false);
  });

  it('STARTED BUT NEVER FINISHED is a failure, not "played": sound began, playback stalled, the time ran out', async () => {
    const { announcer, state } = setup();
    const result = announcer.announce('Hello');
    await settle();
    announcer.onStarted(); // the speaker confirmed sound...
    mock.timers.tick(ANNOUNCE_TOTAL_MS); // ...but it never went quiet, and the whole time ran out

    assert.equal(await result, 'failed' satisfies AnnounceResult);
    assert.match(announcer.failure(), /started but did not finish playing in time/);
    assert.equal(state.stops, 1, 'the stalled sound is cut off');
    assert.equal(announcer.active, false, 'and nothing is left running');
    assert.ok(state.logs.some((line) => /did not finish in time \(sound had begun\)/.test(line)));
  });

  it('fails when the time runs out and no sound ever began', async () => {
    const { announcer } = setup();
    const result = announcer.announce('Hello');
    await settle();
    mock.timers.tick(ANNOUNCE_TOTAL_MS);

    assert.equal(await result, 'failed');
    assert.ok(announcer.failure().length > 0);
  });

  it('fails, saying so, when the speaker never confirms any sound', async () => {
    const { announcer } = setup();
    const result = announcer.announce('Hello');
    await settle();
    mock.timers.tick(ANNOUNCE_AUDIBLE_MS);

    assert.equal(await result, 'failed');
    assert.equal(announcer.failure(), 'the speaker did not confirm any sound');
  });

  it('does not say "played" while the speaker is still sounding, even though the voice has finished making it', async () => {
    const { announcer, state } = setup();
    let settled = false;
    const result = announcer.announce('Hello').then((r) => ((settled = true), r));
    await settle();
    announcer.onStarted();
    await settle();

    assert.equal(state.busy, true);
    assert.equal(settled, false, 'it is still waiting for the speaker to go quiet');
    state.busy = false;
    announcer.onDrained();
    assert.equal(await result, 'played');
  });

  it('is stopped when asked, and says so', async () => {
    const { announcer, state } = setup();
    const result = announcer.announce('Hello');
    await settle();
    announcer.stop();

    assert.equal(await result, 'stopped');
    assert.equal(state.stops, 1);
  });

  it('reports a playback failure from the audio window', async () => {
    const { announcer } = setup();
    const result = announcer.announce('Hello');
    await settle();
    announcer.onFailed('no output device');

    assert.equal(await result, 'failed');
    assert.equal(announcer.failure(), 'no output device');
  });

  it('says nothing over a call, over another announcement or over the speaker, and fails with no voice or no words', async () => {
    assert.equal(await setup({ inCall: true }).announcer.announce('Hello'), 'busy');
    assert.equal(await setup({ busy: true }).announcer.announce('Hello'), 'busy');
    const { announcer } = setup();
    void announcer.announce('Hello');
    assert.equal(await announcer.announce('Again'), 'busy');
    announcer.stop();

    const none = setup({ speech: undefined });
    assert.equal(await none.announcer.announce('Hello'), 'failed');
    assert.equal(none.announcer.failure(), 'the voice on this computer is not available');
    const empty = setup();
    assert.equal(await empty.announcer.announce('   '), 'failed');
    assert.equal(empty.announcer.failure(), 'there was nothing to say');
  });
});
