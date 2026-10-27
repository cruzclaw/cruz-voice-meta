// Gates the Windows host's dependencies at high severity, except the known Kokoro chain.
//
// The host bundles Kokoro for on-device speech. Kokoro's tree carries advisories in `sharp` (image
// decoding) that have no fix yet and that speech synthesis never calls. Those packages are named
// here on purpose: any other high or critical advisory in the host's tree still fails the build.
// Remove an entry as soon as the advisory is fixed upstream.
import { spawnSync } from 'node:child_process';

const KNOWN = new Set(['sharp', '@huggingface/transformers', 'kokoro-js']);

const run = spawnSync('npm audit --json -w @cruzclaw/windows-voice-host', { encoding: 'utf8', shell: true });
let report;
try {
  report = JSON.parse(run.stdout);
} catch {
  console.error('Could not read the npm audit report.');
  console.error(run.stderr || run.stdout);
  process.exit(2);
}

const vulnerabilities = Object.values(report.vulnerabilities ?? {});
const serious = vulnerabilities.filter((v) => v.severity === 'high' || v.severity === 'critical');
const unexpected = serious.filter((v) => !KNOWN.has(v.name));
const accepted = serious.filter((v) => KNOWN.has(v.name));

for (const v of accepted) console.log(`accepted (Kokoro chain, no fix upstream): ${v.name} [${v.severity}]`);
if (unexpected.length > 0) {
  for (const v of unexpected) console.error(`NOT accepted: ${v.name} [${v.severity}]`);
  process.exit(1);
}
console.log(`host audit ok: ${accepted.length} accepted, 0 unexpected high or critical advisories`);
