import test from 'node:test';
import assert from 'node:assert/strict';
import { compareRetention, describeRetentionGap } from '../dist/index.js';

const window = { latestLedger: 4697317, oldestLedger: 4576358 };

test('a checkpoint before the oldest retained ledger is reported as a gap', () => {
  const gap = compareRetention({ ledger: 4576000 }, window);
  assert.equal(gap.pastWindow, true);
  assert.equal(gap.lostLedgers, 358);
  assert.equal(gap.oldestLedger, 4576358);
  assert.equal(gap.checkpointLedger, 4576000);
});

test('a checkpoint still inside the window is not a gap', () => {
  const gap = compareRetention({ ledger: 4576358 }, window);
  assert.equal(gap.pastWindow, false);
  assert.equal(gap.lostLedgers, 0);
  assert.equal(describeRetentionGap(gap), null);
});

test('a checkpoint with no usable ledger number proves nothing', () => {
  // Legacy cursor files and store-backed tombstones carry ledger 0. Assuming a
  // gap from that would warn on every restart of a stream that is fine.
  for (const ledger of [0, -1]) {
    const gap = compareRetention({ ledger }, window);
    assert.equal(gap.pastWindow, false);
    assert.equal(describeRetentionGap(gap), null);
  }
});

test('the comparison reports how far the window moved since it was saved', () => {
  const gap = compareRetention(
    { ledger: 100, retention: { latestLedger: 4600000, oldestLedger: 4570000 } },
    window,
  );
  assert.equal(gap.windowShiftLedgers, 6358);
});

test('a window that grew rather than shrank does not report a negative shift', () => {
  // A resynced node can legitimately report an older oldestLedger than it did
  // before; that is a wider window, not movement past the checkpoint.
  const gap = compareRetention(
    { ledger: 4695317, retention: { latestLedger: 4697317, oldestLedger: 4600000 } },
    window,
  );
  assert.equal(gap.pastWindow, false);
  assert.equal(gap.windowShiftLedgers, 0);
});

test('the gap warning names the lost range and what happens next', () => {
  const gap = compareRetention(
    { ledger: 100, retention: { latestLedger: 4697317, oldestLedger: 50 } },
    window,
  );
  const warning = describeRetentionGap(gap, '2026-10-01T00:00:00Z');
  assert.match(warning, /retention window has moved past/);
  assert.match(warning, /retains from ledger 4576358/);
  assert.match(warning, /stopped at ledger 100/);
  assert.match(warning, /last saved 2026-10-01T00:00:00Z/);
  assert.match(warning, /advanced 4576308 ledgers since then/);
  assert.match(warning, /4576258 ledger\(s\) of events in between are unrecoverable/);
  assert.match(warning, /restart from ledger 4576358/);
});

test('the warning works without a snapshot or a save time', () => {
  const warning = describeRetentionGap(compareRetention({ ledger: 1 }, window));
  assert.match(warning, /retains from ledger 4576358/);
  assert.doesNotMatch(warning, /last saved/);
  assert.doesNotMatch(warning, /advanced/);
});
