import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isSignOff } from '../src/signoff.js';

describe('a sign-off ends the exchange', () => {
  it('knows the ways people close a conversation, with or without the usual extras', () => {
    for (const text of ['Good night.', 'good night Cruz', 'Okay, good night!', 'Goodnight', 'Bye', 'Goodbye, thanks', "That's all.", 'That is all for now', 'Thanks, that will be all', "We're done", 'Stop listening', 'See you tomorrow', 'Go to sleep']) {
      assert.equal(isSignOff(text), true, text);
    }
  });

  it('does not take a request for a sign-off', () => {
    for (const text of ['Remind me to say good night to Maria', 'What is the byte size of that file', 'Send the report, that is all I need from you today please', 'What is on my calendar tomorrow', 'Is it a good night for a walk', '', '   ']) {
      assert.equal(isSignOff(text), false, text);
    }
  });
});
