# Release and provenance

## Release flow

1. A reviewed pull request merges to `main` and CI passes.
2. A maintainer bumps the `@cruzclaw/voice-core` version and pushes a matching tag, for example `v0.1.0`.
3. The `release` workflow rebuilds from the tag, runs typecheck and tests, and refuses to publish if the tag does not match the package version.
4. It attaches three files to the GitHub release: the package tarball, `SHA256SUMS` and a CycloneDX SBOM. The tarball carries a build provenance attestation.

## How a host consumes a release

A host pins the exact release tarball URL and its sha256, never a branch or a floating range. To verify a download:

```
sha256sum -c SHA256SUMS
gh attestation verify cruzclaw-voice-core-<version>.tgz --repo cruzclaw/cruz-voice-meta
```

Updating a host means changing the pinned URL and checksum in a pull request in the host's own repository, where its own CI runs. This repository never pushes to a host.

## Rollback

Re-pin the previous release in the host. Published releases are not edited or replaced; a fix is a new version.

## Provenance rules

- Every file here is authored for this repository or has an explicit, recorded origin and license.
- Nothing is copied from a private repository. A change that moves code from elsewhere needs a provenance note in its pull request and a review before merge.
- CI scans full history for secrets and audits dependencies and licenses on every pull request.
- The license is not yet chosen. Apache 2.0 is proposed and needs owner and legal approval before a LICENSE file is added and before the first release is tagged.
