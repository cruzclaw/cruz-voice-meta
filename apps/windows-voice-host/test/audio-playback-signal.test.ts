import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

/**
 * Speaking follows the speaker. The audio window confirms sound by its own audio clock, or reports that it cannot play;
 * the main process accepts either only if no stop came in between; and the device voice announces Speaking only on the
 * confirmation, never on a timer. The audio window cannot run without a speaker, so this pins the contract between the
 * three files as it is written; the logic that consumes the reports is tested in device-speech.test.ts.
 */
const read = (name: string): string => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');
const renderer = read('audio-renderer.js');
const preload = read('preload.cjs');
const host = read('host.ts');
const speech = read('device-speech.ts');

describe('the playback reports', () => {
  it('are sent by the audio window only for the first chunk of a burst', () => {
    assert.match(renderer, /const first = playing\.size === 0;/);
    assert.match(renderer, /if \(first\) reportWhenAudible\(startsAt\);/);
  });

  it('confirm sound by the audio clock, never by a wall-clock timer', () => {
    assert.match(renderer, /context\.state === 'running' && context\.currentTime >= due/);
    assert.match(renderer, /const due = startsAt \+ \(context\.outputLatency \|\| 0\);/);
    assert.doesNotMatch(renderer, /setTimeout\(\(\) => \{\r?\n\s+if \(stops === mine\) window\.hostAudio\.started/, 'the old timer that said so whether or not the clock moved');
  });

  it('say that playback failed, with the reason, when the clock does not get there in time or the output is not running', () => {
    assert.match(renderer, /const AUDIBLE_DEADLINE_MS = 2000;/);
    assert.match(renderer, /window\.hostAudio\.failed\(stops, context\.state === 'running' \? 'the audio clock did not advance' : `the audio output is \$\{context\.state\}`\);/);
    assert.match(renderer, /if \(context\.state !== 'running'\) void context\.resume\(\);/);
  });

  it('carry how many times playback was stopped, and are dropped when a stop came before they were due', () => {
    assert.match(renderer, /let stops = 0;/);
    assert.match(renderer, /function stopPlayback\(\) \{\r?\n\s+stops\+\+;/);
    assert.match(renderer, /if \(stops !== mine\) return clearInterval\(timer\);/);
  });

  it('cross the preload bridge on their own channels', () => {
    assert.match(preload, /started: \(stops\) => ipcRenderer\.send\('playback-started', stops\)/);
    assert.match(preload, /failed: \(stops, reason\) => ipcRenderer\.send\('playback-failed', stops, String\(reason\)\)/);
  });

  it('are accepted by the host only from the audio window and only with the same stop count as the host sent', () => {
    assert.match(host, /on\('playback-started', \(event, stops: unknown\) => \{[\s\S]*?if \(!fromAudio\(event\) \|\| stops !== stopsSent\) return;[\s\S]*?controller\.onPlaybackStarted\(\);/);
    assert.match(host, /on\('playback-failed', \(event, stops: unknown, reason: unknown\) => \{[\s\S]*?if \(!fromAudio\(event\) \|\| stops !== stopsSent\) return;[\s\S]*?controller\.onPlaybackFailed\(why\);/);
  });

  it('count the stops the host sends, and start again from none when the audio window is made anew', () => {
    assert.match(host, /if \(open\) stopsSent\+\+;\r?\n\s+toAudio\(open, 'stop-playback'\);/);
    assert.match(host, /stopsSent = 0;\r?\n\s+audioWindow = createAudioWindow\(\);/);
  });

  it('never let the device voice say Speaking on a timer', () => {
    // The only place tts.start is sent is announce(), and announce() is reached from the confirmation or from sound that
    // played through to the end. The timer in run() leads to a failure, not to an announcement.
    assert.doesNotMatch(speech, /setTimeout\(\(\) => \{\r?\n\s+if \(this\.awaitingAudible && !this\.announced && !signal\.aborted\) this\.announce/);
    assert.match(speech, /this\.fail\('The speaker did not confirm any sound\.'\)/);
  });
});

describe('the latency log', () => {
  it('measures from the end of the speech of the person to the first sound they hear, once per reply', () => {
    assert.match(host, /if \(message\.type === 'input\.end'\) inputEndedAt = Date\.now\(\);/);
    assert.match(host, /if \(inputEndedAt\) log\(`latency: first sound \$\{now - inputEndedAt\} ms after the end of speech`\);\r?\n\s+inputEndedAt = 0;/);
  });
});
