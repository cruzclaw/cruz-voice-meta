# Audit exceptions

CI fails on any high or critical `npm audit` advisory. This page records the only exception, why it is safe, and how it is kept narrow.

## The exception: three advisories in `sharp`, reached through Kokoro

| Advisory | Component |
| --- | --- |
| GHSA-f88m-g3jw-g9cj | libvips (bundled in `sharp`) |
| GHSA-rgj7-g3m4-5g8c | libheif |
| GHSA-wq5f-xc86-pv6w | librsvg |

All three are in `sharp`'s image decoders. No fixed version exists (`npm audit` reports no fix available). The Windows host depends on them only through `kokoro-js` -> `@huggingface/transformers` -> `sharp`, because the host speaks replies with Kokoro (on-device speech).

`scripts/audit-host.mjs` accepts **exactly these three advisory ids**, each at severity high or lower. Package names are not accepted as a group. It fails on:

- any other high or critical advisory, including a new one in `sharp` itself
- an accepted advisory that rises to critical
- a vulnerable package outside the chain `sharp`, `@huggingface/transformers`, `kokoro-js`
- an audit that could not run or produced an unreadable report

It prints a note when an accepted advisory is no longer reported, so the entry can be removed. The rules are covered by `scripts/audit-host.test.mjs`.

## Evidence that speech does not reach the affected code

1. **Where sharp is used.** In `@huggingface/transformers` the only importer is `src/utils/image.js`, the image loading and resizing code behind its vision pipelines. Text-to-speech takes text in and gives audio out.
2. **Nothing in our code handles images.** `packages/tts-kokoro` and the host's speech process contain no image, SVG or HEIF handling. The host only passes text into Kokoro and reads PCM audio out. (The tray icon is an Electron `nativeImage` built in memory, which does not use `sharp`.)
3. **Measured.** `scripts/check-sharp-unused.cjs` loads the real Kokoro synthesizer, replaces `sharp` with a counting stand-in, and speaks a sentence. Result on 2026-10-27 with `sharp` as installed by the lockfile: *spoke 4.9 s of audio; sharp was loaded 1 time and called 0 times.* The counter itself was checked: a direct call to the stand-in registers as a call.

What this does not establish: the package is still loaded (importing it is unavoidable), and the check covers the speech path as written today. It is evidence about current behavior, not a guarantee about future versions of Kokoro or transformers.

## Keeping it honest

- Re-run `node scripts/check-sharp-unused.cjs` when `kokoro-js` or `@huggingface/transformers` changes. It exits non-zero if `sharp` is called.
- Remove an entry from `ACCEPTED` in `scripts/audit-host.mjs` as soon as the advisory is fixed upstream. When all three are gone, delete the exception and this page and put the host back in the plain `npm audit` gate in `.github/workflows/ci.yml`.
- The isolated `@cruzclaw/tts-kokoro` package is still audited in report-only mode in CI.
