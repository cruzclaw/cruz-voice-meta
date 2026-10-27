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

## Known limitation: turning one user's flag off does not end their open sessions

The flag is checked when a session **starts**. Turning an individual user's flag off blocks their new sessions, but a session that is already open stays open until it ends on its own (the person hangs up, the connection drops, or the maximum session length is reached). This is a remaining access-control gap, and it is not covered by the global kill switch.

The global kill switch is different: a gateway that supports it refuses new sessions and also closes open ones at its next heartbeat.

Until the gap is closed, treat "turn one user's flag off" as stopping new use only. To end a specific user's open session right away, use the global kill switch or end the connection on the server. Closing the gap means re-checking the user's flag at each heartbeat, the way the kill switch is checked.

