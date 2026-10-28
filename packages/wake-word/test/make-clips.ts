// Run by sherpa.live.test.ts in its own process:  node --import tsx make-clips.ts <output folder>
// Writes each clip as raw 16-bit PCM at 24 kHz.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { KokoroSynthesizer } from '../../tts-kokoro/src/index.js';
import { LIVE_CLIPS } from './live-clips.js';

const out = process.argv[2];
if (!out) throw new Error('usage: make-clips.ts <output folder>');
mkdirSync(out, { recursive: true });
const format = { encoding: 'pcm_s16le', sampleRate: 24000, channels: 1 } as const;
for (const clip of LIVE_CLIPS) {
  const synth = new KokoroSynthesizer({ voice: clip.voice });
  const parts: Uint8Array[] = [];
  for await (const chunk of synth.synthesize(clip.text, format, new AbortController().signal)) parts.push(chunk);
  writeFileSync(path.join(out, `${clip.name}.pcm`), Buffer.concat(parts));
}
console.log(`wrote ${LIVE_CLIPS.length} clips`);
