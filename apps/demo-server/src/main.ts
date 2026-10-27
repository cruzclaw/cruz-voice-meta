import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MetaTranscriber } from './meta-transcriber.js';
import { RuleReasoner, ScriptedTranscriber, ToneSynthesizer } from './mock-providers.js';
import type { Transcriber } from './ports.js';
import { createDemoServer } from './server.js';

// Optional local secrets file next to this app. It is git-ignored; never commit it.
const envFile = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const token = process.env.DEMO_TOKEN ?? randomBytes(16).toString('hex');
const apiKey = process.env.MODEL_API_KEY?.trim();

let transcriber: Transcriber;
if (apiKey) {
  transcriber = new MetaTranscriber({ apiKey });
  console.log('speech to text: Meta Muse Voice Transcribe (live)');
} else {
  transcriber = new ScriptedTranscriber(['Please draft an email to Maria', 'What is my status', 'Remind me to call the bank']);
  console.log('speech to text: MOCK. It ignores your voice and returns scripted phrases. Set MODEL_API_KEY for real recognition.');
}

/** Loopback only. Mock reasoning and speech until their adapters are added. */
const demo = createDemoServer({
  accounts: [{ token, tenantKey: 'demo', features: { voiceEnabled: true } }],
  providers: { transcriber, reasoner: new RuleReasoner(), synthesizer: new ToneSynthesizer() },
  killSwitch: process.env.VOICE_FEATURE_DISABLED === 'true',
});

const port = await demo.listen(Number(process.env.PORT ?? 8787));
console.log(`demo voice server on ws://127.0.0.1:${port}`);
console.log(`bearer token: ${token}`);
console.log('approve a task: POST /demo/approvals/<approvalId>/approved with the same bearer token');
