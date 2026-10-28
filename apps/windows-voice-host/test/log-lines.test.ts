import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { conversationLogLine } from '../src/log-lines.js';

const SECRET = 'the quarterly numbers are 41 and 97, call Maria on 555-0100';

describe('what the log says about a conversation', () => {
  it('records that something happened and how long it was, never the words', () => {
    const lines = [
      conversationLogLine({ type: 'transcript.final', text: SECRET }, ''),
      conversationLogLine({ type: 'assistant.text.done' }, SECRET),
      conversationLogLine({ type: 'approval.requested', summary: SECRET }, ''),
    ];

    assert.deepEqual(lines, [
      `heard the person (${SECRET.length} characters)`,
      `reply finished (${SECRET.length} characters)`,
      'an approval was requested',
    ]);
    for (const line of lines) {
      assert.equal(line!.includes('quarterly'), false);
      assert.equal(line!.includes('Maria'), false);
    }
  });

  it('has nothing to say about other messages', () => {
    assert.equal(conversationLogLine({ type: 'assistant.text.delta', text: SECRET }, SECRET), undefined);
    assert.equal(conversationLogLine({ type: 'transcript.partial', text: SECRET }, ''), undefined);
  });
});
