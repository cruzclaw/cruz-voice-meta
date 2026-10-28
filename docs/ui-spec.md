# UI spec: summoning voice

Two surfaces open the same compact call panel. The Windows panel logic is built in `packages/windows-bridge` (state machine, shortcut, preferences, placement). The Electron shell and the panel page are not built yet. The web tab is not built.

## Windows: toast-style call panel

Looks and behaves like the desktop notification toast, but shorter.

- Frameless, always on top, bottom-right of the active display, about 380 px wide and roughly 160 to 200 px tall.
- Header with the employee name and a close control. Body with live transcript or status line. Footer with mute and end-call controls.
- Unlike a notification toast it must take focus when summoned by shortcut, so the keyboard works.
- States: idle, listening, thinking, speaking, task working (with progress line), awaiting approval, disconnected. When several apply, the panel shows the first of: disconnected, awaiting approval, speaking, thinking, listening, task working, idle.
- Controls are separate and each does one thing: mute (local, sends nothing), stop speaking (interrupts the reply), end voice session, and cancel the selected task. Close or Esc only hides the panel and leaves the session running.
- Shortcut: Ctrl+Shift+Space by default and user-configurable. A combo must include Ctrl, Alt or the Windows key. If another app owns it, the previous shortcut stays and the panel reports the conflict. Pressing it again while the assistant speaks barges in, and pressing it while listening ends the input.
- The panel opens at the bottom-right of the display under the cursor and remembers where the person left it, unless that display is gone.
- Only a person's own action (shortcut, tray, click) takes focus. Server events show the panel without focus.
- Startup with Windows is off until the person turns it on.
- Summoned from the tray menu, a global shortcut, or the wake phrase when consented. Dismiss with Esc or the close control.

## Web: right-edge tab

Same placement and shape as the existing right-edge tip tab on the dashboard (a small tab docked to the right edge, mid-height), but with a talk icon. Clicking it opens the compact call panel docked at the right edge.

## Shared behavior

- Both surfaces are shown only when the voice feature flag is on for the signed-in user. See [feature-flag.md](feature-flag.md).
- No microphone access is requested until the person activates the panel.
- The panel never says an action is done before the host reports `confirmed`.
