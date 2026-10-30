/**
 * The person is ending the conversation, not asking for something: "good night", "goodbye", "that's all". The assistant still answers
 * (it says good night back), but the microphone does not open again afterwards, so the two are not left saying good night to each
 * other. The wake phrase starts the next conversation.
 *
 * Only a short utterance made of nothing but a sign-off counts. "Good night" inside a longer request ("remind me to say good night to
 * Maria") is a request, and the conversation goes on.
 */
const SIGN_OFFS = [
  'good night',
  'goodnight',
  'night night',
  'goodbye',
  'good bye',
  'bye',
  'bye bye',
  'see you',
  'see you later',
  'see you tomorrow',
  'talk to you later',
  'that is all',
  'that is it',
  'that will be all',
  'we are done',
  'i am done',
  'all done',
  'stop listening',
  'go to sleep',
  'go back to sleep',
  'sleep now',
];
/** Words that may come before or after the sign-off without making it a request. */
const FILLER = new Set(['ok', 'okay', 'alright', 'thanks', 'thank', 'you', 'thankyou', 'so', 'well', 'cruz', 'hey', 'hi', 'and', 'for', 'now', 'today', 'tesla', 'please']);
const MAX_WORDS = 7;

const normalise = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/\bthats\b/g, 'that is')
    .replace(/\bwere\b/g, 'we are')
    .replace(/\bim\b/g, 'i am')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export function isSignOff(text: string): boolean {
  const spoken = normalise(text);
  const words = spoken.split(' ').filter(Boolean);

  if (words.length === 0 || words.length > MAX_WORDS) return false;

  for (const phrase of SIGN_OFFS) {
    const at = spoken.indexOf(phrase);

    if (at < 0) continue;
    // Whole words only: "bye" must not match inside "byte".
    const before = at === 0 || spoken[at - 1] === ' ';
    const after = at + phrase.length === spoken.length || spoken[at + phrase.length] === ' ';

    if (!before || !after) continue;
    const rest = `${spoken.slice(0, at)} ${spoken.slice(at + phrase.length)}`.split(' ').filter(Boolean);

    if (rest.every((word) => FILLER.has(word))) return true;
  }

  return false;
}
