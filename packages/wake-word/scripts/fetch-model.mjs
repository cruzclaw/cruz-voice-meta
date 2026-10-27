// Downloads the keyword spotting model (about 17 MB, Apache-2.0) into packages/wake-word/models.
// It is not stored in the repository. The download is checked against a pinned SHA-256.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const NAME = 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01';
const SOURCE = `https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/${NAME}.tar.bz2`;
const SHA256 = 'f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a';

const models = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'models');
if (existsSync(path.join(models, NAME, 'tokens.txt'))) {
  console.log(`The model is already in ${path.join(models, NAME)}`);
  process.exit(0);
}

mkdirSync(models, { recursive: true });
const archive = `${NAME}.tar.bz2`;
const archivePath = path.join(models, archive);
console.log(`Downloading ${SOURCE}`);
const res = await fetch(SOURCE);
if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
const hash = createHash('sha256');
await pipeline(
  Readable.fromWeb(res.body),
  async function* (source) {
    for await (const chunk of source) {
      hash.update(chunk);
      yield chunk;
    }
  },
  createWriteStream(archivePath),
);

const actual = hash.digest('hex');
if (actual !== SHA256) {
  rmSync(archivePath, { force: true });
  throw new Error(`The download does not match the pinned checksum.\n  expected ${SHA256}\n  got      ${actual}`);
}
// Relative names with the models folder as the working directory keep tar from reading "C:" as a host name.
execFileSync('tar', ['-xjf', archive], { cwd: models, stdio: 'inherit' });
rmSync(archivePath, { force: true });
console.log(`Ready: ${path.join(models, NAME)}`);
