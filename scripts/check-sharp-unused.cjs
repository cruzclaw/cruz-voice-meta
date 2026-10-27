// Evidence for docs/audit-exceptions.md: does on-device speech ever call into `sharp`?
//
// Loads the real Kokoro synthesizer, replaces the `sharp` module with a counting stand-in, speaks a
// sentence, and reports how many times sharp was loaded and how many times it was called. The
// advisories are in sharp's image decoding (libvips, libheif, librsvg), so a count of zero calls
// means none of that code ran.
//
// Run from the repo root, after `npm install` and `npm run build -w @cruzclaw/tts-kokoro`:
//   node scripts/check-sharp-unused.cjs
// The first run downloads the Kokoro model (about 90 MB).
const Module = require('node:module');

let loads = 0;
let calls = 0;
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const loaded = realLoad.apply(this, arguments);
  if (request !== 'sharp') return loaded;
  loads += 1;
  const count = new Proxy(loaded, {
    apply(target, thisArg, args) {
      calls += 1;
      return Reflect.apply(target, thisArg, args);
    },
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== 'function') return value;
      return new Proxy(value, {
        apply(fn, self, args) {
          calls += 1;
          return Reflect.apply(fn, self, args);
        },
      });
    },
  });
  return count;
};

(async () => {
  const { KokoroSynthesizer } = require('@cruzclaw/tts-kokoro');
  const synth = new KokoroSynthesizer();
  let bytes = 0;
  const format = { encoding: 'pcm_s16le', sampleRate: 24000, channels: 1 };
  for await (const chunk of synth.synthesize('Hello. This is a check that speech does not touch image code.', format, new AbortController().signal)) {
    bytes += chunk.byteLength;
  }
  const seconds = (bytes / 2 / 24000).toFixed(1);
  console.log(`spoke ${seconds} s of audio; sharp was loaded ${loads} time(s) and called ${calls} time(s)`);
  process.exit(calls === 0 && bytes > 0 ? 0 : 1);
})().catch((e) => {
  console.error('check failed:', e && e.message);
  process.exit(2);
});
