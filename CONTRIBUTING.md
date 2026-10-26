# Contributing

1. Open a pull request against `main`. Direct pushes to `main` are not used.
2. `npm run typecheck` and `npm test` must pass. Any change to the host contract must keep the conformance suite passing for the mock, and extend it when behavior changes.
3. Contract changes bump `VOICE_CONTRACT_VERSION` in `packages/voice-core/src/types.ts` and are described in `docs/api-contracts.md`.
4. Do not copy code from any private repository. If you are unsure of the origin of a file, say so in the PR and it will get a provenance review before merge.
5. Use synthetic data in tests, fixtures and demos. No real names, emails or customer content.
