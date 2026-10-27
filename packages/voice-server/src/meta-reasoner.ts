import type { Reasoner, ReasonerEvent, ReasonerInput } from './ports.js';

export const META_API_URL = 'https://api.meta.ai/v1';
export const META_REASONING_MODEL = 'muse-spark-1.3';

export interface MetaReasonerOptions {
  /** Read from the server's environment only. Never log it or send it to a client. */
  apiKey: string;
  baseUrl?: string;
  model?: string;
  /** Voice needs fast answers. The API default reasoned for about 10 s on a simple request. */
  effort?: 'minimal' | 'low' | 'medium' | 'high';
  timeoutMs?: number;
  /** Replace fetch, for tests. */
  fetchImpl?: typeof fetch;
}

const INSTRUCTIONS = [
  'You are a voice assistant for a virtual employee. Your reply is spoken aloud.',
  'Reply in one or two short sentences. Plain words only: no markdown, lists, emoji or URLs.',
  'When the person asks you to do something (send an email, save a note), call propose_task.',
  'You can only propose. A person approves before anything happens, so never say an action is done or sent.',
  'You cannot cancel, undo or change a task you already proposed. If asked to, say you cannot, and tell the person to use the cancel control.',
  'For send_email you need the recipient address, a subject and a body. If any is missing, ask for it and do not call the tool.',
].join(' ');

const TOOLS = [
  {
    type: 'function',
    name: 'propose_task',
    description: 'Propose an action for the owner to approve. Nothing happens until they approve it.',
    parameters: {
      type: 'object',
      properties: {
        intent: { type: 'string', enum: ['send_email', 'save_note'] },
        to: { type: 'string', description: 'Recipient email address. For send_email only.' },
        subject: { type: 'string', description: 'For send_email only.' },
        body: { type: 'string', description: 'Email body, or the note text.' },
      },
      required: ['intent', 'body'],
    },
  },
];

type Turn = { role: 'user' | 'assistant'; content: string };

const MAX_TURNS = 10;
const MAX_CONVERSATIONS = 100;
const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,255}\.[A-Za-z]{2,}$/;

/** Turns a validated tool call into a task. Wording comes from checked fields, not from the model. */
export function toTask(args: unknown): Extract<ReasonerEvent, { type: 'task' }> | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const a = args as Record<string, unknown>;
  const text = (v: unknown, max: number): string | undefined =>
    typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : undefined;
  const body = text(a.body, 4000);
  if (!body) return undefined;

  if (a.intent === 'send_email') {
    const to = text(a.to, 320);
    const subject = text(a.subject, 200);
    if (!to || !EMAIL.test(to) || !subject) return undefined;
    return {
      type: 'task',
      intent: 'send_email',
      params: { to },
      approval: {
        kind: 'email.send',
        payload: { to, subject, body },
        summary: `Send an email to ${to} titled ${subject}.`,
      },
    };
  }
  if (a.intent === 'save_note') return { type: 'task', intent: 'save_note', params: { text: body } };
  return undefined;
}

/** Reasoning with Meta Muse Spark over the Responses API, streamed. Proposes tasks; never performs them. */
export class MetaReasoner implements Reasoner {
  private readonly history = new Map<string, Turn[]>();

  constructor(private readonly options: MetaReasonerOptions) {
    if (!options.apiKey) throw new Error('MODEL_API_KEY is not set');
  }

  async *respond(input: ReasonerInput, signal: AbortSignal): AsyncIterable<ReasonerEvent> {
    if (signal.aborted) return;
    const turns = this.history.get(input.conversationId) ?? [];
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 30000);
    const both = AbortSignal.any([signal, timeout]);

    let res: Response;
    try {
      res = await (this.options.fetchImpl ?? fetch)(`${this.options.baseUrl ?? META_API_URL}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.options.apiKey}` },
        body: JSON.stringify({
          model: this.options.model ?? META_REASONING_MODEL,
          stream: true,
          instructions: INSTRUCTIONS,
          tools: TOOLS,
          reasoning: { effort: this.options.effort ?? 'minimal' },
          // No max_output_tokens: reasoning tokens count against it and a low cap returns no answer.
          input: [...turns, { role: 'user', content: input.utterance }],
        }),
        signal: both,
      });
    } catch (e) {
      if (signal.aborted) return;
      throw new Error(timeout.aborted ? 'Meta reasoning timed out' : 'Meta reasoning connection failed');
    }
    if (!res.ok || !res.body) {
      const detail = await res.text().then((t) => (JSON.parse(t) as { error?: { message?: string } }).error?.message).catch(() => undefined);
      throw new Error(`Meta reasoning failed: HTTP ${res.status}${detail ? ` ${detail}` : ''}`);
    }

    let reply = '';
    try {
      for await (const { event, data } of sse(res.body, both)) {
        if (event === 'response.output_text.delta') {
          const delta = (JSON.parse(data) as { delta?: unknown }).delta;
          if (typeof delta === 'string' && delta) {
            reply += delta;
            yield { type: 'text', text: delta };
          }
        } else if (event === 'response.function_call_arguments.done') {
          const raw = (JSON.parse(data) as { arguments?: unknown }).arguments;
          let args: unknown;
          try {
            args = typeof raw === 'string' ? JSON.parse(raw) : undefined;
          } catch {
            args = undefined;
          }
          const task = toTask(args);
          if (task) yield task;
          else yield { type: 'text', text: ' I could not prepare that action. Could you give me the missing details?' };
        } else if (event === 'response.failed' || event === 'error') {
          throw new Error('Meta reasoning failed');
        }
      }
    } catch (e) {
      if (signal.aborted) return;
      throw e instanceof Error && e.message.startsWith('Meta reasoning') ? e : new Error(timeout.aborted ? 'Meta reasoning timed out' : 'Meta reasoning stream failed');
    }
    if (signal.aborted) return;
    if (timeout.aborted) throw new Error('Meta reasoning timed out');
    this.remember(input.conversationId, [...turns, { role: 'user', content: input.utterance }, ...(reply.trim() ? [{ role: 'assistant' as const, content: reply.trim() }] : [])]);
  }

  private remember(conversationId: string, turns: Turn[]): void {
    this.history.delete(conversationId);
    this.history.set(conversationId, turns.slice(-MAX_TURNS));
    while (this.history.size > MAX_CONVERSATIONS) this.history.delete(this.history.keys().next().value as string);
  }
}

/** Minimal server-sent-events reader. Handles events split across network chunks. */
async function* sse(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncIterable<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const stop = (): void => void reader.cancel().catch(() => undefined);
  signal.addEventListener('abort', stop, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = /^event: ?(.*)$/m.exec(block)?.[1];
        const data = block
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).replace(/^ /, ''))
          .join('\n');
        if (event && data) yield { event, data };
      }
    }
  } finally {
    signal.removeEventListener('abort', stop);
    stop();
  }
}
