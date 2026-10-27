import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  MetaReasoner,
  MetaTranscriber,
  RuleReasoner,
  ScriptedTranscriber,
  ToneSynthesizer,
  type Reasoner,
  type Synthesizer,
  type Transcriber,
} from '@cruzclaw/voice-server';
import { createDemoServer } from './server.js';

// Optional local secrets file next to this app. It is git-ignored; never commit it.
const envFile = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const token = process.env.DEMO_TOKEN ?? randomBytes(16).toString('hex');
const apiKey = process.env.MODEL_API_KEY?.trim();

let transcriber: Transcriber;
let reasoner: Reasoner;
if (apiKey) {
  transcriber = new MetaTranscriber({ apiKey });
  reasoner = new MetaReasoner({ apiKey });
  console.log('speech to text: Meta Muse Voice Transcribe (live)');
  console.log('reasoning: Meta Muse Spark (live)');
} else {
  reasoner = new RuleReasoner();
  console.log('reasoning: MOCK rules (email, note, status). Set MODEL_API_KEY for Muse Spark.');
  transcriber = new ScriptedTranscriber(['Please draft an email to Maria', 'What is my status', 'Remind me to call the bank']);
  console.log('speech to text: MOCK. It ignores your voice and returns scripted phrases. Set MODEL_API_KEY for real recognition.');
}

// Kokoro lives in its own package and is loaded on demand. TTS=tone skips it.
let synthesizer: Synthesizer = new ToneSynthesizer();
if (process.env.TTS !== 'tone') {
  try {
    const { KokoroSynthesizer } = await import('@cruzclaw/tts-kokoro');
    const kokoro = new KokoroSynthesizer();
    console.log('text to speech: loading Kokoro (first run downloads about 90 MB)...');
    await kokoro.warmUp();
    synthesizer = kokoro;
    console.log('text to speech: Kokoro (local)');
  } catch (e) {
    console.log(`text to speech: tone only, Kokoro unavailable (${(e as Error).message})`);
  }
} else {
  console.log('text to speech: tone only (TTS=tone)');
}

/** Loopback only. */
const demo = createDemoServer({
  accounts: [{ token, tenantKey: 'demo', features: { voiceEnabled: true }, ...(process.env.DEMO_USER_NAME ? { displayName: process.env.DEMO_USER_NAME } : {}) }],
  providers: { transcriber, reasoner, synthesizer },
  killSwitch: process.env.VOICE_FEATURE_DISABLED === 'true',
  // Provider errors never contain the API key (the adapters build their own messages).
  onProviderError: (e) => console.error(`provider error: ${e instanceof Error ? e.message : 'unknown'}`),
});

const port = await demo.listen(Number(process.env.PORT ?? 8787));
console.log(`demo voice server on ws://127.0.0.1:${port}`);
console.log(`bearer token: ${token}`);
console.log('approve a task: POST /demo/approvals/<approvalId>/approved with the same bearer token');
