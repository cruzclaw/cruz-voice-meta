import type { Rect } from './preferences.js';

export type { Rect } from './preferences.js';

export interface DisplayInfo {
  id: number;
  /** Usable area in display-independent pixels, excluding the taskbar. */
  workArea: Rect;
  primary?: boolean;
}

export const PANEL_SIZE = { width: 380, height: 180 } as const;
export const PANEL_MARGIN = 16;

const contains = (r: Rect, x: number, y: number): boolean =>
  x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;

const fits = (outer: Rect, inner: Rect): boolean =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;

/** The display the person is using: the one under the cursor, else the primary, else the first. */
export function pickDisplay(displays: DisplayInfo[], cursor: { x: number; y: number }): DisplayInfo | undefined {
  return displays.find((d) => contains(d.workArea, cursor.x, cursor.y)) ?? displays.find((d) => d.primary) ?? displays[0];
}

/** Bottom-right of the work area, clamped so a small display never pushes the panel off screen. */
export function defaultBounds(display: DisplayInfo, size: { width: number; height: number } = PANEL_SIZE): Rect {
  const w = Math.min(size.width, display.workArea.width);
  const h = Math.min(size.height, display.workArea.height);
  return {
    x: display.workArea.x + display.workArea.width - w - Math.min(PANEL_MARGIN, display.workArea.width - w),
    y: display.workArea.y + display.workArea.height - h - Math.min(PANEL_MARGIN, display.workArea.height - h),
    width: w,
    height: h,
  };
}

/**
 * Keep where the person left the panel if that spot is still fully on a connected
 * display (a monitor may have been unplugged since). Otherwise use the default.
 */
export function placePanel(
  displays: DisplayInfo[],
  cursor: { x: number; y: number },
  saved?: Rect,
  size: { width: number; height: number } = PANEL_SIZE,
): Rect | undefined {
  if (saved && displays.some((d) => fits(d.workArea, saved))) return saved;
  const display = pickDisplay(displays, cursor);
  return display ? defaultBounds(display, size) : undefined;
}
