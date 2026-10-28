import { PANEL_SIZE } from './placement.js';

/**
 * Plain options for Electron's BrowserWindow, kept as data so the safety settings
 * can be tested without Electron. The panel is a small frameless always-on-top
 * card that stays out of the taskbar and Alt+Tab clutter.
 */
export function panelWindowOptions(preloadPath: string) {
  return {
    width: PANEL_SIZE.width,
    height: PANEL_SIZE.height,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    // Created hidden. The shell decides when to show it, and whether to focus it.
    show: false,
    focusable: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  } as const;
}
