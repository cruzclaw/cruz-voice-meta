# Voice feature flag

## Decision

The flag is a **per-user server-side setting**, returned with the session bootstrap and parsed by `parseVoiceFeatureConfig`. It is OFF by default and ON only for allow-listed test accounts until rollout.

Why server side:

- **Rollback without a release.** Turning it off needs no new Windows or web build.
- **Server enforcement.** The voice gateway refuses sessions when the flag is off. Hiding the tab or panel is a convenience, not the control.
- **No client self-enable.** A client cannot flip its own flag, and local config cannot override it.

## Shape

```
{ voiceEnabled: boolean, wakePhraseConsent: boolean }
```

- Missing, malformed or non-`true` values resolve to OFF.
- `wakePhraseConsent` counts only while `voiceEnabled` is on, and is a separate, revocable opt-in.

## Consumers

- Web tab and Windows panel read the parsed config and render nothing when off.
- The Windows shell receives it from the signed-in web session, since the shell holds no credentials of its own.
- The gateway checks the same setting on every session start.
