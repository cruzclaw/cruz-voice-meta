import { copyFileSync, mkdirSync } from 'node:fs';
import { build } from 'esbuild';

mkdirSync('dist', { recursive: true });

const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'info' };
const native = ['electron', 'sherpa-onnx-node', 'bufferutil', 'utf-8-validate'];

// The standalone shell: tray, shortcut and settings from the environment.
await build({ ...common, entryPoints: ['src/main.ts'], outfile: 'dist/main.cjs', external: native });

// The library for another Electron app. Everything but the native runtimes is inside it.
await build({ ...common, entryPoints: ['src/index.ts'], outfile: 'dist/index.cjs', external: native });

// The speech process loads the voice model and its native runtime, which stay outside the bundle.
await build({
  ...common,
  entryPoints: ['src/speech-process.ts'],
  outfile: 'dist/speech-process.cjs',
  external: ['kokoro-js', 'onnxruntime-node', 'onnxruntime-web', '@huggingface/transformers', 'sharp'],
});

for (const file of ['preload.cjs', 'audio.html', 'audio-renderer.js', 'audio-worklet.js', 'panel-preload.cjs', 'panel.html', 'panel.css', 'panel.js']) {
  copyFileSync(`src/${file}`, `dist/${file}`);
}
