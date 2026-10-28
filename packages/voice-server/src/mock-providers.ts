import type { AudioFormat } from '@cruzclaw/voice-core';
import type { Reasoner, ReasonerEvent, ReasonerInput, Synthesizer, Transcriber } from './ports.js';

/**
 * Mock speech to text. It cannot understand audio, so it returns scripted
 * phrases in order, one per utterance. Only for the credential-free demo.
 */
export class ScriptedTranscriber implements Transcriber {
  private index = 0;
  constructor(private readonly script: string[]) {
    if (script.length === 0) throw new Error('script must have at least one phrase');
  }

  async transcribe(pcm: Uint8Array): Promise<string> {
    if (pcm.byteLength === 0) return '';
    const phrase = this.script[this.index % this.script.length]!;
    this.index++;
    return phrase;
  }
}

/** Rule-based stand-in for the reasoning model. */
export class RuleReasoner implements Reasoner {
  async *respond(input: ReasonerInput, signal: AbortSignal): AsyncIterable<ReasonerEvent> {
    const text = input.utterance.toLowerCase();
    const say = (s: string): ReasonerEvent => ({ type: 'text', text: s });
    if (signal.aborted) return;

    if (text.includes('email')) {
      const payload = { to: 'maria@example.com', subject: 'Quarterly update', body: 'Draft prepared by the demo employee.' };
      yield say('I drafted an email to Maria. ');
      yield say('I need your approval before I send it.');
      yield {
        type: 'task',
        intent: 'send_email',
        params: { to: payload.to },
        approval: { kind: 'email.send', payload, summary: 'Send an email to maria@example.com titled Quarterly update.' },
      };
    } else if (text.includes('status') || text.includes('what are you working on')) {
      yield say('You have no open tasks right now.');
    } else if (text.includes('note') || text.includes('remind')) {
      yield say('Noted. I will keep that in mind.');
      yield { type: 'task', intent: 'save_note', params: { text: input.utterance } };
    } else {
      yield say('I heard you. Ask me to draft an email, save a note or check status.');
    }
  }
}

/** Deterministic quiet tone, about 60 ms per word, delivered in 20 ms chunks. */
export class ToneSynthesizer implements Synthesizer {
  async *synthesize(text: string, format: AudioFormat, signal: AbortSignal): AsyncIterable<Uint8Array> {
    const words = Math.max(1, text.trim().split(/\s+/).length);
    const total = Math.round((format.sampleRate * 0.06) * words);
    const chunk = Math.round(format.sampleRate * 0.02);
    let n = 0;
    while (n < total) {
      if (signal.aborted) return;
      const count = Math.min(chunk, total - n);
      const buf = new Uint8Array(count * 2);
      const view = new DataView(buf.buffer);
      for (let i = 0; i < count; i++) {
        view.setInt16(i * 2, Math.round(Math.sin(((n + i) * 2 * Math.PI * 440) / format.sampleRate) * 1500), true);
      }
      n += count;
      yield buf;
      await new Promise((r) => setImmediate(r));
    }
  }
}
