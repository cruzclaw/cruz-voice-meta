// Builds ESM, CommonJS and type declarations so both ESM and CommonJS hosts can consume the package.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tsc = join(root, '..', '..', 'node_modules', 'typescript', 'bin', 'tsc');
const run = (project) => execFileSync(process.execPath, [tsc, '-p', join(root, project)], { stdio: 'inherit' });

rmSync(join(root, 'dist'), { recursive: true, force: true });
run('tsconfig.esm.json');
run('tsconfig.cjs.json');
run('tsconfig.types.json');
mkdirSync(join(root, 'dist', 'esm'), { recursive: true });
writeFileSync(join(root, 'dist', 'esm', 'package.json'), '{"type":"module"}\n');
writeFileSync(join(root, 'dist', 'cjs', 'package.json'), '{"type":"commonjs"}\n');
