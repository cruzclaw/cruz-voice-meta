import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

/**
 * Speaking follows the speaker. The audio window reports when sound has really begun, the main process accepts that
 * report only if no stop came in between, and the device voice announces Speaking on it. The audio window cannot run
 * without a speaker, so this pins the contract between the three files as it is written; the logic that consumes the
 * report is tested in device-speech.test.ts.
 */
const read = (name: string): string => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');
const renderer = read('audio-renderer.js');
const preload = read('preload.cjs');
const host = read('host.ts');

describe('the playback-started report', () => {
  it('is sent by the audio window only for the first chunk of a burst, at its start time plus the output latency', () => {
    assert.match(renderer, /const first = playing\.size === 0;/);
    assert.match(renderer, /if \(first\) reportWhenAudible\(startsAt\);/);
    assert.match(renderer, /startsAt - context\.currentTime \+ \(context\.outputLatency \|\| 0\)/);
  });

  it('carries how many times playback was stopped, and is dropped when a stop came before it was due', () => {
    assert.match(renderer, /let stops = 0;/);
    assert.match(renderer, /function stopPlayback\(\) \{\r?\n\s+stops\+\+;/);
    assert.match(renderer, /if \(stops === mine\) window\.hostAudio\.started\(stops\);/);
  });

  it('crosses the preload bridge on its own channel', () => {
    assert.match(preload, /started: \(stops\) => ipcRenderer\.send\('playback-started', stops\)/);
  });

  it('is accepted by the host only from the audio window and only when it has the same stop count as the host sent', () => {
    assert.match(host, /on\('playback-started', \(event, stops: unknown\) => \{[\s\S]*?if \(!fromAudio\(event\) \|\| stops !== stopsSent\) return;[\s\S]*?controller\.onPlaybackStarted\(\);/);
  });

  it('counts the stops it sends, and starts again from none when the audio window is made anew', () => {
    assert.match(host, /if \(open\) stopsSent\+\+;\r?\n\s+toAudio\(open, 'stop-playback'\);/);
    assert.match(host, /stopsSent = 0;\r?\n\s+audioWindow = createAudioWindow\(\);/);
  });
});
