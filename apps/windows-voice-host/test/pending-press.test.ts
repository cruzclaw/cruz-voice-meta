import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PendingPress } from '../src/pending-press.js';

describe('a press that came before the connection', () => {
  it('starts the call once, when the connection comes up soon enough', () => {
    let now = 1000;
    const p = new PendingPress(15000, () => now);
    p.request();
    now += 4000;

    assert.equal(p.take(), true);
    assert.equal(p.take(), false, 'only once');
  });

  it('is forgotten when the connection takes too long, so a call never starts by itself minutes later', () => {
    let now = 0;
    const p = new PendingPress(15000, () => now);
    p.request();
    now += 15001;

    assert.equal(p.take(), false);
    assert.equal(p.take(), false);
  });

  it('is exactly fresh at the limit, and a newer press restarts the clock', () => {
    let now = 0;
    const p = new PendingPress(1000, () => now);
    p.request();
    now = 1000;
    assert.equal(p.take(), true);
    p.request();
    now = 5000;
    p.request();
    now = 5900;
    assert.equal(p.take(), true);
  });

  it('does nothing when nobody pressed', () => {
    assert.equal(new PendingPress(1000, () => 0).take(), false);
  });

  it('is cancelled by hanging up or by a connection that can never work', () => {
    let now = 0;
    const p = new PendingPress(15000, () => now);
    p.request();
    p.clear();
    now = 1;

    assert.equal(p.take(), false);
  });
});
