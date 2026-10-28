/**
 * What the host writes to its log about a conversation. Only that something happened, and how big it was: never
 * the words. What the person says and what is read out (an email, an approval) can be private, and the log goes to
 * the app's console and its log file.
 */
export interface LoggedMessage {
  type: string;
  text?: unknown;
  summary?: unknown;
}

const count = (value: unknown): number => (typeof value === 'string' ? value.length : 0);

/** A log line for a server message, or undefined when it has nothing worth a line. Never contains message text. */
export function conversationLogLine(message: LoggedMessage, reply: string): string | undefined {
  switch (message.type) {
    case 'transcript.final':
      return `heard the person (${count(message.text)} characters)`;
    case 'assistant.text.done':
      return `reply finished (${count(reply)} characters)`;
    case 'approval.requested':
      return 'an approval was requested';
    default:
      return undefined;
  }
}
