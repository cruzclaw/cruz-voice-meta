import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EndpointDetector, type EndpointEvent } from '../src/index.js';

/** Feeds levels in 40 ms frames and returns every event with the frame index it came on. */
function run(levels: number[], detector = new EndpointDetector()): Array<[number, EndpointEvent]> {
  const out: Array<[number, EndpointEvent]> = [];
  levels.forEach((level, i) => {
    const e = detector.feed(level);
    if (e) out.push([i, e]);
  });
  return out;
}
const frames = (ms: number, level: number) => Array<number>(Math.round(ms / 40)).fill(level);
const ROOM = 0.004;
const VOICE = 0.08;

describe('EndpointDetector', () => {
  it('reports start, then end after about 0.9 s of quiet following speech', () => {
    const events = run([...frames(400, ROOM), ...frames(1520, VOICE), ...frames(2000, ROOM)]);
    assert.deepEqual(events.map(([, e]) => e), ['speech_started', 'speech_ended']);
    const [, [endFrame]] = events as [unknown, [number, EndpointEvent]];
    const quietStart = (400 + 1520) / 40;
    assert.equal(endFrame - quietStart + 1, Math.ceil(900 / 40)); // 23 quiet frames, 920 ms
  });

  it('does not end during a short pause between words', () => {
    const events = run([...frames(1000, VOICE), ...frames(600, ROOM), ...frames(1000, VOICE), ...frames(1200, ROOM)]);
    assert.deepEqual(events.map(([, e]) => e), ['speech_started', 'speech_ended']);
    // The 600 ms pause did not end it: the end comes after the second stretch of speech.
    assert.ok(events[1]![0] > (1000 + 600 + 1000) / 40);
  });

  it('says nothing was heard after 8 s of room noise', () => {
    const events = run(frames(9000, ROOM));
    assert.deepEqual(events.map(([, e]) => e), ['no_speech']);
    assert.equal(events[0]![0], 8000 / 40 - 1);
  });

  it('ignores a cough or a click shorter than 250 ms', () => {
    const events = run([...frames(1000, ROOM), ...frames(120, 0.2), ...frames(8000, ROOM)]);
    assert.deepEqual(events.map(([, e]) => e), ['no_speech']);
  });

  it('treats scattered clicks that never add up to speech as nothing', () => {
    const clicks: number[] = [];
    for (let i = 0; i < 20; i++) clicks.push(...frames(80, 0.2), ...frames(600, ROOM));
    assert.deepEqual(run(clicks).map(([, e]) => e), ['no_speech']);
  });

  it('follows a noisy room: a steady fan is not speech, a voice over it is', () => {
    const FAN = 0.03;
    assert.deepEqual(run(frames(9000, FAN)).map(([, e]) => e), ['no_speech']);
    const events = run([...frames(1000, FAN), ...frames(1500, 0.3), ...frames(2000, FAN)]);
    assert.deepEqual(events.map(([, e]) => e), ['speech_started', 'speech_ended']);
  });

  it('adapts when the room noise creeps up while listening', () => {
    // A fan spinning up or a crowd arriving: gradual, not a sudden voice.
    const ramp = Array.from({ length: 150 }, (_, i) => 0.004 + (0.03 - 0.004) * (i / 149));
    assert.deepEqual(run([...ramp, ...frames(1000, 0.03)]).map(([, e]) => e), []);
    const events = run([...ramp, ...frames(8000, 0.03)]);
    assert.deepEqual(events.map(([, e]) => e), ['no_speech']);
  });

  it('hears someone who starts talking the moment listening begins', () => {
    const events = run([...frames(1500, VOICE), ...frames(1500, ROOM)]);
    assert.deepEqual(events.map(([, e]) => e), ['speech_started', 'speech_ended']);
  });

  it('stays quiet after finishing until reset, and ignores bad input', () => {
    const d = new EndpointDetector();
    run([...frames(1000, VOICE), ...frames(1000, ROOM)], d);
    assert.equal(d.feed(VOICE), undefined);
    assert.equal(d.feed(Number.NaN), undefined);
    d.reset();
    assert.deepEqual(run([...frames(1000, VOICE), ...frames(1000, ROOM)], d).map(([, e]) => e), ['speech_started', 'speech_ended']);
  });

  it('lets the end-of-speech quiet be changed', () => {
    const quick = new EndpointDetector({ endSilenceMs: 400 });
    const events = run([...frames(1000, VOICE), ...frames(1000, ROOM)], quick);
    assert.equal(events[1]![0], 1000 / 40 + 400 / 40 - 1);
  });
});
