// Starts the host in Electron. VS Code terminals set ELECTRON_RUN_AS_NODE, which makes Electron
// behave as plain Node and exit silently, so it is removed here.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const electron = createRequire(import.meta.url)('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, ['.'], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
