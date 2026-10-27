import { copyFileSync, mkdirSync } from 'node:fs';
import { build } from 'esbuild';

mkdirSync('dist', { recursive: true });
await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  logLevel: 'info',
});
for (const file of ['preload.cjs', 'audio.html', 'audio-renderer.js', 'audio-worklet.js']) {
  copyFileSync(`src/${file}`, `dist/${file}`);
}
