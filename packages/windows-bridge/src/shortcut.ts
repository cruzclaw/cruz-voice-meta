export const DEFAULT_SHORTCUT = 'Ctrl+Shift+Space';

const MODIFIERS = new Set(['ctrl', 'control', 'commandorcontrol', 'cmdorctrl', 'alt', 'shift', 'super', 'meta']);
/** Modifiers that make a combo safe to grab globally. Shift alone would swallow normal typing. */
const STRONG = new Set(['ctrl', 'control', 'commandorcontrol', 'cmdorctrl', 'alt', 'super', 'meta']);
const NAMED_KEYS = new Set([
  'space', 'tab', 'enter', 'backspace', 'delete', 'insert', 'home', 'end', 'pageup', 'pagedown',
  'up', 'down', 'left', 'right', 'plus', 'minus', 'period', 'comma', 'slash', 'backslash', 'semicolon', 'quote',
]);
const KEY = /^([a-z0-9]|f([1-9]|1[0-9]|2[0-4])|[a-z0-9]+)$/i;

export type ShortcutCheck = { ok: true; normalized: string } | { ok: false; reason: string };

/** Checks an Electron-style accelerator such as Ctrl+Shift+Space. */
export function validateAccelerator(input: string): ShortcutCheck {
  if (typeof input !== 'string' || input.length > 40) return { ok: false, reason: 'not a valid shortcut' };
  const parts = input.split('+').map((p) => p.trim());
  if (parts.some((p) => p === '')) return { ok: false, reason: 'not a valid shortcut' };
  const key = parts[parts.length - 1]!;
  const mods = parts.slice(0, -1);
  if (MODIFIERS.has(key.toLowerCase())) return { ok: false, reason: 'a shortcut needs a key, not only modifiers' };
  if (!mods.every((m) => MODIFIERS.has(m.toLowerCase()))) return { ok: false, reason: 'unknown modifier' };
  if (new Set(mods.map((m) => m.toLowerCase())).size !== mods.length) return { ok: false, reason: 'repeated modifier' };
  if (!mods.some((m) => STRONG.has(m.toLowerCase()))) {
    return { ok: false, reason: 'include Ctrl, Alt or the Windows key so normal typing is not captured' };
  }
  const k = key.toLowerCase();
  if (!(NAMED_KEYS.has(k) || (KEY.test(key) && (key.length === 1 || /^f\d{1,2}$/i.test(key))))) {
    return { ok: false, reason: 'unknown key' };
  }
  if (/^f\d+$/i.test(key) && (Number(key.slice(1)) < 1 || Number(key.slice(1)) > 24)) {
    return { ok: false, reason: 'unknown key' };
  }
  return { ok: true, normalized: [...mods, key].join('+') };
}

/** The part of Electron's globalShortcut this module needs. `register` returns false when another app owns the combo. */
export interface ShortcutRegistrar {
  register(accelerator: string, handler: () => void): boolean;
  unregister(accelerator: string): void;
}

export type ShortcutResult =
  | { status: 'registered'; active: string }
  | { status: 'fallback'; active: string; unavailable: string[] }
  | { status: 'conflict'; active: string | undefined; unavailable: string[] }
  | { status: 'invalid'; active: string | undefined; reason: string };

export class ShortcutManager {
  private current: string | undefined;
  private lastFired = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly registrar: ShortcutRegistrar,
    private readonly onTrigger: () => void,
    private readonly now: () => number = Date.now,
    /** Holding the keys auto-repeats. Triggers closer than this are one press. */
    private readonly debounceMs = 300,
  ) {}

  get active(): string | undefined {
    return this.current;
  }

  /**
   * Try the preferred combo, then each fallback. The previous shortcut is released
   * only after a new one is held, so a failed change never leaves the person with none.
   */
  apply(preferred: string, fallbacks: string[] = []): ShortcutResult {
    const unavailable: string[] = [];
    for (const [index, candidate] of [preferred, ...fallbacks].entries()) {
      const check = validateAccelerator(candidate);
      if (!check.ok) {
        if (index === 0) return { status: 'invalid', active: this.current, reason: check.reason };
        continue;
      }
      if (check.normalized === this.current) {
        return index === 0 ? { status: 'registered', active: this.current } : { status: 'fallback', active: this.current, unavailable };
      }
      if (this.registrar.register(check.normalized, () => this.fire())) {
        const previous = this.current;
        this.current = check.normalized;
        if (previous) this.registrar.unregister(previous);
        return index === 0
          ? { status: 'registered', active: check.normalized }
          : { status: 'fallback', active: check.normalized, unavailable };
      }
      unavailable.push(check.normalized);
    }
    return { status: 'conflict', active: this.current, unavailable };
  }

  dispose(): void {
    if (this.current) this.registrar.unregister(this.current);
    this.current = undefined;
  }

  private fire(): void {
    const t = this.now();
    if (t - this.lastFired < this.debounceMs) return;
    this.lastFired = t;
    this.onTrigger();
  }
}
