/**
 * What is waiting for the person, shown as a thin silent strip of colour. Pure logic, no Electron.
 *
 * Four kinds, four colours, fixed meanings:
 *   green  an update is waiting
 *   orange the owner's approval is pending
 *   blue   an acknowledgement is waiting
 *   red    an error needs attention
 *
 * These are attention colours. They are not the colours of the conversation (listening, thinking,
 * speaking), and blue here never means anything but an acknowledgement.
 *
 * When more than one kind is waiting, each one gets an equal part of the strip. Nothing is ranked
 * over anything else, so no kind can hide another, and nothing here decides what matters most.
 */

export type AttentionKind = 'update' | 'approval' | 'acknowledgement' | 'error';

/** The order the colours are laid out in. It is a layout order only, not a priority. */
export const ATTENTION_KINDS: readonly AttentionKind[] = ['update', 'approval', 'acknowledgement', 'error'];

export const ATTENTION_COLORS: Readonly<Record<AttentionKind, string>> = {
  update: '#1fb26a',
  approval: '#f59e0b',
  acknowledgement: '#2f6df6',
  error: '#e5484d',
};

export interface AttentionSummary {
  counts: Record<AttentionKind, number>;
}

const emptyCounts = (): Record<AttentionKind, number> => ({ update: 0, approval: 0, acknowledgement: 0, error: 0 });

/** Nothing waiting. Frozen, and never handed out: every caller that needs an empty summary gets its own. */
export const NO_ATTENTION: AttentionSummary = Object.freeze({ counts: Object.freeze(emptyCounts()) as Record<AttentionKind, number> });

/** A new empty summary that is safe to change. */
export const noAttention = (): AttentionSummary => ({ counts: emptyCounts() });

/** More than this is shown as this. It only keeps one bad value from drawing something absurd. */
export const MAX_COUNT = 999;

/**
 * Accepts what came over the wire and keeps only whole counts of the four known kinds.
 * Anything else, including a wrong shape, means nothing is waiting: never a guess.
 */
export function normalizeAttention(raw: unknown): AttentionSummary {
  const counts = raw && typeof raw === 'object' ? (raw as { counts?: unknown }).counts : undefined;
  if (!counts || typeof counts !== 'object') return noAttention();
  const out = emptyCounts();
  for (const kind of ATTENTION_KINDS) {
    const value = (counts as Record<string, unknown>)[kind];
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) out[kind] = Math.min(value, MAX_COUNT);
  }
  return { counts: out };
}

export const attentionTotal = (summary: AttentionSummary): number => ATTENTION_KINDS.reduce((sum, kind) => sum + summary.counts[kind], 0);

export interface HueSegment {
  kind: AttentionKind;
  color: string;
  /** This kind's part of the strip, from 0 to 1. The parts of the kinds that are waiting add up to 1. */
  share: number;
}

/** One equal part of the strip for every kind that has something waiting. Empty when nothing is. */
export function hueSegments(summary: AttentionSummary): HueSegment[] {
  const waiting = ATTENTION_KINDS.filter((kind) => summary.counts[kind] > 0);
  return waiting.map((kind) => ({ kind, color: ATTENTION_COLORS[kind], share: 1 / waiting.length }));
}

const NAME: Record<AttentionKind, [string, string]> = {
  update: ['update', 'updates'],
  approval: ['approval', 'approvals'],
  acknowledgement: ['acknowledgement', 'acknowledgements'],
  error: ['error', 'errors'],
};

/** Plain words for the strip and for a screen reader, such as "2 updates and 1 approval waiting". Empty when nothing is. */
export function attentionLabel(summary: AttentionSummary): string {
  const parts = ATTENTION_KINDS.filter((kind) => summary.counts[kind] > 0).map((kind) => {
    const count = summary.counts[kind];
    return `${count} ${NAME[kind][count === 1 ? 0 : 1]}`;
  });
  if (parts.length === 0) return '';
  const joined = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `${joined} waiting`;
}

/** The longest wording shown on one line of the panel. A longer one becomes a plain total. */
export const SHORT_LABEL_MAX = 34;

/** A version of the label that fits on one line: the full words if they fit, otherwise how many are waiting. */
export function attentionShortLabel(summary: AttentionSummary): string {
  const full = attentionLabel(summary);
  if (full.length <= SHORT_LABEL_MAX) return full;
  const total = attentionTotal(summary);
  return `${total} ${total === 1 ? 'item' : 'items'} waiting`;
}

/** Two summaries that would look and read the same. Lets the host skip a redraw when a poll finds nothing new. */
export function sameAttention(a: AttentionSummary, b: AttentionSummary): boolean {
  return ATTENTION_KINDS.every((kind) => a.counts[kind] === b.counts[kind]);
}
