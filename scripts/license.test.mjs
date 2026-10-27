import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const root = readFileSync(new URL('../LICENSE', import.meta.url));

describe('license text in the published packages', () => {
  it('starts as the Apache License, Version 2.0', () => {
    assert.match(root.toString(), /Apache License\s+Version 2\.0, January 2004/);
  });

  for (const name of ['voice-core', 'voice-server', 'tts-kokoro']) {
    it(`${name} carries a LICENSE identical to the root one, so it ships in the tarball`, () => {
      const copy = readFileSync(new URL(`../packages/${name}/LICENSE`, import.meta.url));
      assert.equal(Buffer.compare(copy, root), 0);
    });

    it(`${name} declares Apache-2.0 and does not exclude LICENSE from its files`, () => {
      const pkg = JSON.parse(readFileSync(new URL(`../packages/${name}/package.json`, import.meta.url), 'utf8'));
      assert.equal(pkg.license, 'Apache-2.0');
      assert.ok(!(pkg.files ?? []).some((f) => String(f).startsWith('!') && /license/i.test(f)));
    });
  }
});
