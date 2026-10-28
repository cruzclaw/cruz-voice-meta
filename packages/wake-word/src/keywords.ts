/**
 * The phrases that wake the assistant, written as the word pieces ("tokens") the keyword model
 * was trained on. They were produced with the model's own SentencePiece file (bpe.model), for
 * example "HEY CRUZ" becomes "▁HE Y ▁C RU Z". The model spots any phrase given this way, so
 * nothing is trained.
 *
 * A greeting is required on purpose. "Cruz" on its own sounds the same as "cruise" and
 * "crews", and measured on test speech it fires on those words at every sensitivity that
 * still catches it. With a greeting in front, the phrase was caught every time and ordinary
 * speech never set it off.
 */
export interface WakePhrase {
  text: string;
  tokens: string;
}

export const GREETING_PHRASES: readonly WakePhrase[] = [
  { text: 'hey cruz', tokens: '▁HE Y ▁C RU Z' },
  { text: 'hi cruz', tokens: '▁HI ▁C RU Z' },
  { text: 'hello cruz', tokens: '▁HE LL O ▁C RU Z' },
  { text: 'okay cruz', tokens: '▁OKAY ▁C RU Z' },
];

/** Not used unless asked for: see the note above. */
export const BARE_PHRASE: WakePhrase = { text: 'cruz', tokens: '▁C RU Z' };

export interface WakeOptions {
  /** Above 0 and below 1. Lower fires more easily. Measured: 0.2 caught every greeting phrase on test speech. */
  greetingThreshold?: number;
  /** Also wake on "Cruz" alone, with this threshold. Off by default. */
  bareThreshold?: number;
  /** Extra score added to a phrase's path. 1.0 was used in the measurements. */
  boost?: number;
}

export const DEFAULT_GREETING_THRESHOLD = 0.2;

const unit = (value: number | undefined, fallback: number, name: string): number => {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0 || value >= 1) throw new RangeError(`${name} must be above 0 and below 1`);
  return value;
};

/** The keywords file the spotter reads: one phrase per line as tokens, then `:boost` and `#threshold`. */
export function keywordsFile(options: WakeOptions = {}): string {
  const greeting = unit(options.greetingThreshold, DEFAULT_GREETING_THRESHOLD, 'greetingThreshold');
  const boost = options.boost ?? 1.0;
  if (!Number.isFinite(boost) || boost <= 0 || boost > 10) throw new RangeError('boost must be above 0 and at most 10');
  const lines = GREETING_PHRASES.map((p) => `${p.tokens} :${boost} #${greeting}`);
  if (options.bareThreshold !== undefined) {
    lines.push(`${BARE_PHRASE.tokens} :${boost} #${unit(options.bareThreshold, 0.5, 'bareThreshold')}`);
  }
  return `${lines.join('\n')}\n`;
}
