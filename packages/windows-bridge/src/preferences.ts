import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_SHORTCUT, validateAccelerator } from './shortcut.js';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PanelPreferences {
  shortcut: string;
  /** Opt-in. Nothing starts with Windows unless the person turns this on. */
  launchAtStartup: boolean;
  /** Where the person last left the panel, in display-independent pixels. */
  lastBounds: Rect | undefined;
}

export const DEFAULT_PREFERENCES: PanelPreferences = {
  shortcut: DEFAULT_SHORTCUT,
  launchAtStartup: false,
  lastBounds: undefined,
};

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 100_000;

function parseRect(v: unknown): Rect | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const r = v as Record<string, unknown>;
  if (!num(r.x) || !num(r.y) || !num(r.width) || !num(r.height) || r.width <= 0 || r.height <= 0) return undefined;
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

/** Field by field: one bad value falls back to its default and keeps the rest. */
export function parsePreferences(raw: unknown): PanelPreferences {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const shortcut = typeof r.shortcut === 'string' ? validateAccelerator(r.shortcut) : undefined;
  return {
    shortcut: shortcut?.ok ? shortcut.normalized : DEFAULT_PREFERENCES.shortcut,
    launchAtStartup: r.launchAtStartup === true,
    lastBounds: parseRect(r.lastBounds),
  };
}

export interface PreferenceStore {
  read(): Promise<unknown>;
  write(value: unknown): Promise<void>;
}

export async function loadPreferences(store: PreferenceStore): Promise<PanelPreferences> {
  try {
    return parsePreferences(await store.read());
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export async function savePreferences(store: PreferenceStore, prefs: PanelPreferences): Promise<void> {
  await store.write(parsePreferences(prefs));
}

/** JSON file store. Writes to a temp file and renames, so a crash never leaves half a file. */
export class FilePreferenceStore implements PreferenceStore {
  constructor(private readonly path: string) {}

  async read(): Promise<unknown> {
    try {
      return JSON.parse(await fs.readFile(this.path, 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT' || e instanceof SyntaxError) return undefined;
      throw e;
    }
  }

  async write(value: unknown): Promise<void> {
    await fs.mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(value, null, 2), 'utf8');
    await fs.rename(temp, this.path);
  }
}
