/**
 * The spoken opening line. The name comes from the server's own record of the
 * authenticated account, never from anything the client sends.
 */
export function greetingFor(displayName: string | undefined): string {
  // Spoken aloud and shown on screen, so keep only what a name can sensibly contain.
  const name = (displayName ?? '')
    .normalize('NFC')
    .replace(/[^\p{L}\p{M}\p{N} '.\-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
    .trim();
  return name ? `Hi ${name}, I'm listening. How can I help?` : "Hi, I'm listening. How can I help?";
}
