/**
 * Words said on the speaker with no call: an announcement, or the speaker test. It is kept apart from the host window code so
 * that what it reports can be tested with a fake speaker and fake timers.
 *
 * The result is honest about what happened. 'played' means the sound began AND played through to the end. Sound that began and then
 * stalled, so that the time ran out, is 'failed' with a reason, never 'played'.
 */

export type AnnounceResult = 'played' | 'stopped' | 'failed' | 'busy';

/** How long sound may take to begin once it has been handed to the speaker, and how long a whole announcement may take. */
export const ANNOUNCE_AUDIBLE_MS = 8000;
export const ANNOUNCE_TOTAL_MS = 60000;

export interface AnnouncerDeps {
  /** The voice on this computer; absent when there is none. */
  speech: { synthesize(text: string, signal: AbortSignal): AsyncIterable<Uint8Array> } | undefined;
  isDisposed(): boolean;
  /** A call is up. */
  inCall(): boolean;
  /** The speaker is sounding something. */
  speakerBusy(): boolean;
  /** Make sure the audio window exists before anything is handed to it. */
  prepare(): void;
  play(pcm: Uint8Array): void;
  stopPlayback(): void;
  log(line: string): void;
  audibleMs?: number;
  totalMs?: number;
}

interface Run {
  audible: boolean;
  onStarted(): void;
  onFailed(why: string): void;
  onDrained(): void;
  stop(): void;
}

export interface Announcer {
  announce(text: string): Promise<AnnounceResult>;
  /** Stops an announcement at once. Does nothing when none is playing. */
  stop(): void;
  /** The audio window reports: sound began, playback failed, the speaker went quiet. */
  onStarted(): void;
  onFailed(why: string): void;
  onDrained(): void;
  readonly active: boolean;
  /** Why the last announcement could not be played, in the host's own words. Empty when it played. */
  failure(): string;
}

export function createAnnouncer(deps: AnnouncerDeps): Announcer {
  const audibleMs = deps.audibleMs ?? ANNOUNCE_AUDIBLE_MS;
  const totalMs = deps.totalMs ?? ANNOUNCE_TOTAL_MS;
  let current: Run | undefined;
  let failure = '';

  function announce(text: string): Promise<AnnounceResult> {
    const spoken = typeof text === 'string' ? text.trim().slice(0, 500) : '';
    const speech = deps.speech;
    if (deps.isDisposed() || !speech || !spoken) {
      failure = !speech ? 'the voice on this computer is not available' : 'there was nothing to say';
      return Promise.resolve('failed');
    }
    // Never over a call, and never over another announcement or anything else the speaker is playing.
    if (current || deps.inCall() || deps.speakerBusy()) return Promise.resolve('busy');
    deps.prepare();
    failure = '';
    return new Promise<AnnounceResult>((resolve) => {
      let settled = false;
      let made = false;
      let audibleTimer: ReturnType<typeof setTimeout> | undefined;
      const abort = new AbortController();
      const finish = (result: AnnounceResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(audibleTimer);
        clearTimeout(totalTimer);
        if (current === run) current = undefined;
        resolve(result);
      };
      const cut = (result: AnnounceResult): void => {
        abort.abort();
        deps.stopPlayback();
        finish(result);
      };
      const run: Run = {
        audible: false,
        onStarted: () => {
          run.audible = true;
          clearTimeout(audibleTimer);
        },
        onFailed: (why) => {
          deps.log(`announcement: playback failed: ${why}`);
          failure = why;
          cut('failed');
        },
        onDrained: () => {
          if (made) finish(run.audible ? 'played' : 'failed');
        },
        stop: () => cut('stopped'),
      };
      const totalTimer = setTimeout(() => {
        // Whether or not sound began, it did not play through to the end in time: that is not "played".
        failure = run.audible ? 'the sound started but did not finish playing in time' : 'it did not play in time';
        deps.log(`announcement: it did not finish in time (${run.audible ? 'sound had begun' : 'no sound began'})`);
        cut('failed');
      }, totalMs);
      current = run;
      deps.log('announcement: started');
      void (async () => {
        let first = true;
        try {
          for await (const pcm of speech.synthesize(spoken, abort.signal)) {
            if (abort.signal.aborted) return;
            deps.play(pcm);
            if (first) {
              first = false;
              audibleTimer = setTimeout(() => {
                if (!run.audible) {
                  deps.log('announcement: the speaker did not confirm any sound');
                  failure = 'the speaker did not confirm any sound';
                  cut('failed');
                }
              }, audibleMs);
            }
          }
          if (abort.signal.aborted) return;
          made = true;
          // The speaker may already have said it is quiet, before the last chunk was made.
          if (first) finish('failed');
          else if (!deps.speakerBusy()) finish(run.audible ? 'played' : 'failed');
        } catch (e) {
          if (abort.signal.aborted) return;
          deps.log(`announcement: the voice failed: ${e instanceof Error ? e.message : 'unknown'}`);
          failure = e instanceof Error ? e.message.slice(0, 120) : 'the voice failed';
          cut('failed');
        }
      })();
    });
  }

  return {
    announce,
    stop: () => current?.stop(),
    onStarted: () => current?.onStarted(),
    onFailed: (why) => current?.onFailed(why),
    onDrained: () => current?.onDrained(),
    get active() {
      return !!current;
    },
    failure: () => failure,
  };
}
