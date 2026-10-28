// Runs host-ui.cjs in Electron at several display scale factors. VS Code terminals set
// ELECTRON_RUN_AS_NODE, which makes Electron behave as plain Node, so it is removed here.
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const electron = createRequire(import.meta.url)('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const script = fileURLToPath(new URL('./host-ui.cjs', import.meta.url));
let failed = false;

for (const factor of process.argv[2] ? [process.argv[2]] : ['1', '1.25', '1.5', '2']) {
  const data = mkdtempSync(path.join(os.tmpdir(), 'voice-ui-'));
  const run = spawnSync(electron, [script, `--force-device-scale-factor=${factor}`, `--user-data-dir=${data}`], { env, encoding: 'utf8', timeout: 120000 });
  const lines = (run.stdout ?? '').split('\n').filter((l) => /^(ok {2}|FAIL|ALL PASSED|\d+ FAILED|display scale)/.test(l));
  console.log(`\n=== scale ${factor} ===\n${lines.join('\n')}`);
  if (run.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
