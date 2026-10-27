import { randomBytes } from 'node:crypto';
import { RuleReasoner, ScriptedTranscriber, ToneSynthesizer } from './mock-providers.js';
import { createDemoServer } from './server.js';

/** Credential-free demo: mock speech and reasoning, synthetic employee, loopback only. */
const token = process.env.DEMO_TOKEN ?? randomBytes(16).toString('hex');
const demo = createDemoServer({
  accounts: [{ token, tenantKey: 'demo', features: { voiceEnabled: true } }],
  providers: {
    transcriber: new ScriptedTranscriber(['Please draft an email to Maria', 'What is my status', 'Remind me to call the bank']),
    reasoner: new RuleReasoner(),
    synthesizer: new ToneSynthesizer(),
  },
  killSwitch: process.env.VOICE_FEATURE_DISABLED === 'true',
});

const port = await demo.listen(Number(process.env.PORT ?? 8787));
console.log(`demo voice server on ws://127.0.0.1:${port}`);
console.log(`bearer token: ${token}`);
console.log('approve a task: POST /demo/approvals/<approvalId>/approved with the same bearer token');
