# UI spec: summoning voice

Two surfaces open the same compact call panel. Neither is built yet.

## Windows: toast-style call panel

Looks and behaves like the desktop notification toast, but shorter.

- Frameless, always on top, bottom-right of the active display, about 380 px wide and roughly 160 to 200 px tall.
- Header with the employee name and a close control. Body with live transcript or status line. Footer with mute and end-call controls.
- Unlike a notification toast it must take focus when summoned by shortcut, so the keyboard works.
- States: listening, thinking, speaking, working on a task (with progress line), ended.
- Summoned from the tray menu, a global shortcut, or the wake phrase when consented. Dismiss with Esc or the close control.

## Web: right-edge tab

Same placement and shape as the existing right-edge tip tab on the dashboard (a small tab docked to the right edge, mid-height), but with a talk icon. Clicking it opens the compact call panel docked at the right edge.

## Shared behavior

- Both surfaces are shown only when the voice feature flag is on for the signed-in user. See [feature-flag.md](feature-flag.md).
- No microphone access is requested until the person activates the panel.
- The panel never says an action is done before the host reports `confirmed`.
