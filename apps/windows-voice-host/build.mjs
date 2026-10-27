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
  external: ['electron', 'sherpa-onnx-node'],
  logLevel: 'info',
});
// The speech process loads the voice model and its native runtime, which stay outside the bundle.
await build({
  entryPoints: ['src/speech-process.ts'],
  outfile: 'dist/speech-process.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['kokoro-js', 'onnxruntime-node', 'onnxruntime-web', '@huggingface/transformers', 'sharp'],
  logLevel: 'info',
});
for (const file of ['preload.cjs', 'audio.html', 'audio-renderer.js', 'audio-worklet.js', 'panel-preload.cjs', 'panel.html', 'panel.css', 'panel.js']) {
  copyFileSync(`src/${file}`, `dist/${file}`);
}
