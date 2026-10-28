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

## Revoking access while a session is open

The flag is checked when a session starts, but that is not enough: turning a person's flag off must also end the session they already have open. A gateway has to re-check eligibility on a timer (the connection heartbeat is a good one) and close the session when access is withdrawn: the account is no longer active, the flag is off, or the employee is no longer theirs.

A gateway also needs a rule for a failed check. Closing everyone on one database blip is as bad as never closing, so a sensible rule is to keep the session through a few failures in a row and close it if they continue, so an outage cannot keep revoked access open. The global kill switch is separate and is checked at the same heartbeat.

The CruzClaw gateway does this: it re-checks at every heartbeat, closes with code 1008 when access is withdrawn, keeps the session through up to two failed lookups in a row, and closes with 1011 on the third. Revocation takes effect within one heartbeat interval (25 s by default), not instantly.
