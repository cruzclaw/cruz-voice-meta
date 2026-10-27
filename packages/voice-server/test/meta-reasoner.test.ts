import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MetaReasoner, toTask } from '../src/meta-reasoner.js';
import type { ReasonerEvent } from '../src/ports.js';

const KEY = 'test-key-123';
const ev = (event: string, data: object) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const textEvents = (...deltas: string[]) => deltas.map((delta) => ev('response.output_text.delta', { delta })).join('');
const toolEvent = (args: object | string) =>
  ev('response.function_call_arguments.done', { name: 'propose_task', arguments: typeof args === 'string' ? args : JSON.stringify(args) });

/** Streams the text split into awkward pieces, the way a network would. */
function body(text: string, pieces = 1): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  const size = Math.ceil(bytes.length / pieces);
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
      controller.close();
    },
  });
}

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Record<string, any>;
}

function fakeFetch(respond: () => Response | Promise<Response>, sent: Sent[] = []): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
    return respond();
  }) as unknown as typeof fetch;
}

const run = async (r: MetaReasoner, utterance: string, conversationId = 'c1', signal = new AbortController().signal) => {
  const out: ReasonerEvent[] = [];
  for await (const e of r.respond({ utterance, conversationId }, signal)) out.push(e);
  return out;
};

const emailArgs = { intent: 'send_email', to: 'maria@example.com', subject: 'Quarterly update', body: 'Hi Maria, here is the update.' };

describe('MetaReasoner', () => {
  it('sends a fast, streamed, tool-enabled request with the key only in the header', async () => {
    const sent: Sent[] = [];
    const r = new MetaReasoner({ apiKey: KEY, fetchImpl: fakeFetch(() => new Response(body(textEvents('Hi.'))), sent) });
    await run(r, 'hello');
    const [req] = sent;
    assert.equal(req!.url, 'https://api.meta.ai/v1/responses');
    assert.equal(req!.headers.authorization, `Bearer ${KEY}`);
    assert.equal(req!.body.model, 'muse-spark-1.3');
    assert.equal(req!.body.stream, true);
    assert.deepEqual(req!.body.reasoning, { effort: 'minimal' });
    assert.equal(req!.body.max_output_tokens, undefined);
    assert.equal(req!.body.tools[0].name, 'propose_task');
    assert.deepEqual(req!.body.input, [{ role: 'user', content: 'hello' }]);
    assert.equal(JSON.stringify(req!.body).includes(KEY), false);
  });

  it('streams text and survives events split across chunks', async () => {
    const stream = textEvents('Two plus ', 'two is four.');
    for (const pieces of [1, 3, 17]) {
      const r = new MetaReasoner({ apiKey: KEY, fetchImpl: fakeFetch(() => new Response(body(stream, pieces))) });
      assert.deepEqual(await run(r, 'q'), [
        { type: 'text', text: 'Two plus ' },
        { type: 'text', text: 'two is four.' },
      ]);
    }
  });

  it('turns an email tool call into a task whose approval wording comes from checked fields', async () => {
    const r = new MetaReasoner({ apiKey: KEY, fetchImpl: fakeFetch(() => new Response(body(textEvents("I'll draft it.") + toolEvent(emailArgs)))) });
    const out = await run(r, 'email Maria');
    assert.deepEqual(out[1], {
      type: 'task',
      intent: 'send_email',
      params: { to: 'maria@example.com' },
      approval: {
        kind: 'email.send',
        payload: { to: 'maria@example.com', subject: 'Quarterly update', body: 'Hi Maria, here is the update.' },
        summary: 'Send an email to maria@example.com titled Quarterly update.',
      },
    });
  });

  it('drops a tool call with a bad address or missing fields and asks for details instead', async () => {
    for (const bad of [{ ...emailArgs, to: 'not-an-email' }, { ...emailArgs, subject: '' }, { intent: 'send_email', body: 'x' }, { intent: 'delete_all', body: 'x' }, '{not json']) {
      const r = new MetaReasoner({ apiKey: KEY, fetchImpl: fakeFetch(() => new Response(body(toolEvent(bad)))) });
      const out = await run(r, 'x');
      assert.equal(out.some((e) => e.type === 'task'), false, JSON.stringify(bad));
      assert.match((out[0] as { text: string }).text, /could not prepare/);
    }
  });

  it('accepts a note task and rejects oversized fields', () => {
    assert.deepEqual(toTask({ intent: 'save_note', body: 'call the bank' }), { type: 'task', intent: 'save_note', params: { text: 'call the bank' } });
    assert.equal(toTask({ intent: 'save_note', body: 'x'.repeat(4001) }), undefined);
    assert.equal(toTask(null), undefined);
  });

  it('carries earlier turns of the same conversation, and keeps conversations apart', async () => {
    const sent: Sent[] = [];
    let n = 0;
    const r = new MetaReasoner({ apiKey: KEY, fetchImpl: fakeFetch(() => new Response(body(textEvents(`answer ${++n}`))), sent) });
    await run(r, 'first', 'a');
    await run(r, 'second', 'a');
    await run(r, 'other', 'b');
    assert.deepEqual(sent[1]!.body.input, [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer 1' },
      { role: 'user', content: 'second' },
    ]);
    assert.deepEqual(sent[2]!.body.input, [{ role: 'user', content: 'other' }]);
  });

  it('turns an HTTP error into a rejection without the key', async () => {
    const r = new MetaReasoner({
      apiKey: KEY,
      fetchImpl: fakeFetch(() => new Response(JSON.stringify({ error: { message: 'invalid api key' } }), { status: 401 })),
    });
    await assert.rejects(run(r, 'x'), (e: Error) => {
      assert.match(e.message, /HTTP 401 invalid api key/);
      assert.equal(e.message.includes(KEY), false);
      return true;
    });
  });

  it('rejects when the stream reports a failure, and when the connection drops', async () => {
    const failed = new MetaReasoner({ apiKey: KEY, fetchImpl: fakeFetch(() => new Response(body(ev('response.failed', { error: 'x' })))) });
    await assert.rejects(run(failed, 'x'), /Meta reasoning failed/);
    const down = new MetaReasoner({ apiKey: KEY, fetchImpl: (async () => { throw new TypeError(`fetch failed for ${KEY}`); }) as unknown as typeof fetch });
    await assert.rejects(run(down, 'x'), (e: Error) => {
      assert.equal(e.message.includes(KEY), false);
      return true;
    });
  });

  it('times out a stalled stream instead of waiting forever', async () => {
    const stalled = new ReadableStream<Uint8Array>({ start() {} });
    const r = new MetaReasoner({ apiKey: KEY, timeoutMs: 80, fetchImpl: fakeFetch(() => new Response(stalled)) });
    await assert.rejects(run(r, 'x'), /timed out/);
  });

  it('uses a timer that keeps the process alive, and clears it when the reply ends', async (t) => {
    // AbortSignal.timeout does not hold the process open, so on Linux a stalled stream with nothing else
    // running ended the whole test process instead of timing out. This pins the real timer.
    const set = t.mock.method(globalThis, 'setTimeout');
    const cleared = t.mock.method(globalThis, 'clearTimeout');
    const ok = new MetaReasoner({ apiKey: KEY, timeoutMs: 4321, fetchImpl: fakeFetch(() => new Response(body(textEvents('Hi.')))) });
    await run(ok, 'hello');
    assert.ok(set.mock.calls.some((c) => c.arguments[1] === 4321), 'the deadline is a real timer');
    assert.ok(cleared.mock.callCount() > 0, 'and it is cleared when the reply ends, so nothing is left running');
  });

  it('clears the timer when the turn is aborted too', async (t) => {
    const cleared = t.mock.method(globalThis, 'clearTimeout');
    const controller = new AbortController();
    const stalled = new ReadableStream<Uint8Array>({ start() {} });
    const r = new MetaReasoner({ apiKey: KEY, timeoutMs: 5000, fetchImpl: fakeFetch(() => new Response(stalled)) });
    const pending = run(r, 'interrupted', 'a', controller.signal);
    setTimeout(() => controller.abort(), 20);
    assert.deepEqual(await pending, []);
    assert.ok(cleared.mock.callCount() > 0);
  });

  it('stops quietly and does not remember a turn that was aborted', async () => {
    const sent: Sent[] = [];
    const controller = new AbortController();
    const stalled = new ReadableStream<Uint8Array>({ start() {} });
    const r = new MetaReasoner({ apiKey: KEY, timeoutMs: 5000, fetchImpl: fakeFetch(() => new Response(stalled), sent) });
    const pending = run(r, 'interrupted', 'a', controller.signal);
    setTimeout(() => controller.abort(), 40);
    assert.deepEqual(await pending, []);
    const r2 = new MetaReasoner({ apiKey: KEY, fetchImpl: fakeFetch(() => new Response(body(textEvents('ok'))), sent) });
    await run(r2, 'next', 'a');
    assert.deepEqual(sent.at(-1)!.body.input, [{ role: 'user', content: 'next' }]);
  });

  it('offers only the intents the host can do, and speaks as the named employee', async () => {
    const sent: Sent[] = [];
    const r = new MetaReasoner({ apiKey: KEY, intents: ['send_email'], assistantName: 'Tesla', fetchImpl: fakeFetch(() => new Response(body(textEvents('Hi.'))), sent) });
    await run(r, 'hello');
    const [req] = sent;
    assert.deepEqual(req!.body.tools[0].parameters.properties.intent.enum, ['send_email']);
    assert.match(req!.body.instructions, /You are Tesla/);
    assert.match(req!.body.instructions, /send an email/);
    assert.doesNotMatch(req!.body.instructions, /note/i, 'it is never told it can save notes');
  });

  it('drops a task for an intent that was not offered, even if the model asks for it', async () => {
    const r = new MetaReasoner({ apiKey: KEY, intents: ['send_email'], fetchImpl: fakeFetch(() => new Response(body(toolEvent({ intent: 'save_note', body: 'call the bank' })))) });
    const out = await run(r, 'remind me');
    assert.equal(out.some((e) => e.type === 'task'), false);
    assert.match((out[0] as { text: string }).text, /could not prepare/);
    assert.equal(toTask({ intent: 'save_note', body: 'x' }, ['send_email']), undefined);
    assert.ok(toTask({ intent: 'send_email', to: 'a@b.co', subject: 's', body: 'b' }, ['send_email']));
  });

  it('refuses an empty list of intents', () => {
    assert.throws(() => new MetaReasoner({ apiKey: KEY, intents: [] }), /intents/);
  });

  it('requires a key', () => {
    assert.throws(() => new MetaReasoner({ apiKey: '' }), /MODEL_API_KEY/);
  });
});
