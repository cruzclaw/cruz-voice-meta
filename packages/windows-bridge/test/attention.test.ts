import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ATTENTION_COLORS,
  ATTENTION_KINDS,
  COMPACT_HEIGHT,
  COMPACT_SIZE,
  COMPACT_WIDTH,
  MAX_COUNT,
  NO_ATTENTION,
  attentionLabel,
  attentionShortLabel,
  attentionTotal,
  expandedBounds,
  hueSegments,
  miniBounds,
  noAttention,
  normalizeAttention,
  sameAttention,
  type AttentionSummary,
  type DisplayInfo,
} from '../src/index.js';

const some = (counts: Partial<AttentionSummary['counts']>): AttentionSummary => ({ counts: { ...NO_ATTENTION.counts, ...counts } });

describe('the four attention colours', () => {
  it('are green for updates, orange for approvals, blue for acknowledgements and red for errors', () => {
    assert.deepEqual(Object.keys(ATTENTION_COLORS).sort(), [...ATTENTION_KINDS].sort());
    // The hue of each, by what a person would call it. Exact values are an implementation choice.
    const hue = (hex: string): number => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
      const max = Math.max(r, g, b);
      const d = max - Math.min(r, g, b);
      const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return (h * 60 + 360) % 360;
    };
    assert.ok(hue(ATTENTION_COLORS.update) > 120 && hue(ATTENTION_COLORS.update) < 160, 'green');
    assert.ok(hue(ATTENTION_COLORS.approval) > 30 && hue(ATTENTION_COLORS.approval) < 50, 'orange');
    assert.ok(hue(ATTENTION_COLORS.acknowledgement) > 210 && hue(ATTENTION_COLORS.acknowledgement) < 240, 'blue');
    assert.ok(hue(ATTENTION_COLORS.error) > 350 || hue(ATTENTION_COLORS.error) < 10, 'red');
  });

  it('are all different, so no kind can be mistaken for another', () => {
    assert.equal(new Set(Object.values(ATTENTION_COLORS)).size, 4);
  });
});

describe('what comes over the wire', () => {
  it('keeps whole positive counts of the four kinds', () => {
    assert.deepEqual(normalizeAttention({ counts: { update: 2, approval: 1, acknowledgement: 3, error: 4 } }).counts, { update: 2, approval: 1, acknowledgement: 3, error: 4 });
  });

  it('treats a wrong shape as nothing waiting, never as a guess', () => {
    for (const bad of [undefined, null, 5, 'x', [], {}, { counts: null }, { counts: 'a' }, { counts: [] }]) {
      assert.deepEqual(normalizeAttention(bad), NO_ATTENTION, JSON.stringify(bad));
    }
  });

  it('drops negative, fractional, non-numeric and unknown values, and caps a huge one', () => {
    const out = normalizeAttention({ counts: { update: -3, approval: 1.5, acknowledgement: '2', error: Number.NaN, mystery: 9 } });
    assert.deepEqual(out.counts, NO_ATTENTION.counts);
    assert.equal(normalizeAttention({ counts: { update: 10 ** 9 } }).counts.update, MAX_COUNT);
    assert.equal(Object.keys(normalizeAttention({ counts: { mystery: 9 } }).counts).length, 4);
  });

  it('does not let one summary change another (no shared object)', () => {
    const a = normalizeAttention({});
    a.counts.update = 5;
    assert.equal(normalizeAttention({}).counts.update, 0);
    assert.equal(NO_ATTENTION.counts.update, 0);
    assert.ok(Object.isFrozen(NO_ATTENTION) && Object.isFrozen(NO_ATTENTION.counts), 'the shared empty one cannot be changed');
    assert.notEqual(noAttention(), noAttention());
  });
});

describe('the strip', () => {
  it('is empty when nothing is waiting', () => {
    assert.deepEqual(hueSegments(NO_ATTENTION), []);
    assert.equal(attentionLabel(NO_ATTENTION), '');
    assert.equal(attentionTotal(NO_ATTENTION), 0);
  });

  it('shows one colour across the whole strip for one kind', () => {
    assert.deepEqual(hueSegments(some({ approval: 3 })), [{ kind: 'approval', color: ATTENTION_COLORS.approval, share: 1 }]);
  });

  it('gives every kind that is waiting an equal part, and none ranks over another', () => {
    const all = hueSegments(some({ update: 1, approval: 1, acknowledgement: 1, error: 1 }));
    assert.deepEqual(all.map((s) => s.kind), ['update', 'approval', 'acknowledgement', 'error']);
    assert.ok(all.every((s) => s.share === 0.25));
    // Counts do not change the parts: one error is as visible as fifty updates.
    const lopsided = hueSegments(some({ update: 50, error: 1 }));
    assert.deepEqual(lopsided.map((s) => s.share), [0.5, 0.5]);
    assert.ok(Math.abs(all.reduce((sum, s) => sum + s.share, 0) - 1) < 1e-9);
  });

  it('does not depend on the order the kinds arrive in', () => {
    const a = hueSegments(normalizeAttention({ counts: { error: 1, update: 1 } }));
    const b = hueSegments(normalizeAttention({ counts: { update: 1, error: 1 } }));
    assert.deepEqual(a, b);
  });

  it('says what is waiting in plain words, with the right singular and plural', () => {
    assert.equal(attentionLabel(some({ update: 1 })), '1 update waiting');
    assert.equal(attentionLabel(some({ update: 2 })), '2 updates waiting');
    assert.equal(attentionLabel(some({ update: 2, approval: 1 })), '2 updates and 1 approval waiting');
    assert.equal(attentionLabel(some({ update: 1, approval: 2, acknowledgement: 1, error: 3 })), '1 update, 2 approvals, 1 acknowledgement and 3 errors waiting');
  });

  it('has a short label that fits one line, and falls back to a total instead of cutting words', () => {
    assert.equal(attentionShortLabel(some({ update: 2 })), '2 updates waiting');
    assert.equal(attentionShortLabel(some({ update: 2, approval: 1 })), '2 updates and 1 approval waiting');
    assert.equal(attentionShortLabel(some({ update: 2, approval: 1, acknowledgement: 1, error: 3 })), '7 items waiting');
    assert.equal(attentionShortLabel(some({ update: 1, approval: 1, acknowledgement: 1, error: 0 })).endsWith('waiting'), true);
    assert.equal(attentionShortLabel(NO_ATTENTION), '');
    assert.equal(attentionLabel(some({ update: 2, approval: 1, acknowledgement: 1, error: 3 })).length > 34, true, 'the full words stay available for a screen reader');
  });

  it('can tell whether two summaries look the same', () => {
    assert.equal(sameAttention(some({ update: 1 }), some({ update: 1 })), true);
    assert.equal(sameAttention(some({ update: 1 }), some({ update: 2 })), false);
    assert.equal(sameAttention(some({ update: 1 }), some({ approval: 1 })), false);
  });
});

describe('the minimised bar and the full panel have the same width and aligned edges', () => {
  const area = (x: number, width: number, height = 1040): DisplayInfo => ({ id: x, workArea: { x, y: 0, width, height }, primary: x === 0 });
  const displays = [area(0, 1920), area(1920, 2560, 1400), area(4480, 1280, 700)];
  const placed = (x: number) => ({ x, y: 200, width: COMPACT_WIDTH, height: COMPACT_HEIGHT });

  it('uses one shared width', () => {
    assert.equal(COMPACT_SIZE.width, COMPACT_WIDTH);
    assert.equal(COMPACT_SIZE.height, COMPACT_HEIGHT);
  });

  it('makes the bar exactly as wide as the panel on every display, wherever the panel is', () => {
    for (const x of [0, 100, 1500, 1578, 1920, 3000, 4480, 5000]) {
      const full = placed(x);
      const mini = miniBounds(displays, full, COMPACT_HEIGHT);
      assert.equal(mini.width, full.width, `x=${x}`);
      assert.equal(mini.x, full.x, `left edge, x=${x}`);
      assert.equal(mini.x + mini.width, full.x + full.width, `right edge, x=${x}`);
    }
  });

  it('keeps the bar the panel width even if the window has been left at another width', () => {
    for (const width of [200, 342, 380, 900, 1920]) {
      assert.equal(miniBounds(displays, { x: 100, y: 600, width, height: COMPACT_HEIGHT }, COMPACT_HEIGHT).width, COMPACT_WIDTH, `window width ${width}`);
    }
  });

  it('returns to exactly the same width and edges after minimise then expand, repeatedly', () => {
    let rect = placed(1500);
    const first = { ...rect };
    for (let i = 0; i < 5; i += 1) {
      const mini = miniBounds(displays, rect, COMPACT_HEIGHT);
      assert.equal(mini.width, COMPACT_WIDTH);
      rect = expandedBounds(displays, mini, COMPACT_SIZE);
      assert.equal(rect.width, COMPACT_WIDTH);
      assert.equal(rect.x, first.x);
    }
  });

  it('squeezes both to a narrow display together, so they still match', () => {
    const narrow = [area(0, 300)];
    const mini = miniBounds(narrow, placed(0), COMPACT_HEIGHT);
    const full = expandedBounds(narrow, mini, COMPACT_SIZE);
    assert.equal(mini.width, 300);
    assert.equal(full.width, 300);
    assert.equal(mini.x, full.x);
  });

  it('keeps both inside the display when the panel was against the right edge', () => {
    for (const d of displays) {
      // Far enough over that the panel's middle is still on this display, but its right edge hangs off it.
      const x = d.workArea.x + d.workArea.width - 200;
      const mini = miniBounds(displays, placed(x), COMPACT_HEIGHT);
      const full = expandedBounds(displays, mini, COMPACT_SIZE);
      for (const r of [mini, full]) {
        assert.ok(r.x >= d.workArea.x && r.x + r.width <= d.workArea.x + d.workArea.width, `display ${d.id}`);
      }
      assert.equal(mini.x, full.x);
    }
  });
});
