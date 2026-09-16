import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EventPoller,
  MemoryCursorStore,
  buildFilters,
  ingestionLag,
  APPROX_LEDGER_SECONDS,
  MAX_PAGE_SIZE,
} from '../dist/index.js';

const SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const OTHER = 'CA6F5E42TCRGPMDXU33WGMXAADPNEKOIZETAWSKYKAWNHESQQ2MTLSCC';

const rawEvent = (ledger, n) => ({
  id: `00201662329593528${String(ledger).slice(-2)}-000000000${n}`,
  type: 'contract',
  ledger,
  ledgerClosedAt: '2026-09-15T19:22:52Z',
  contractId: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
  topic: ['AAAADwAAAAh0cmFuc2Zlcg=='],
  value: 'AAAACgAAAAAAAAAAAAAAAAAAAGQ=',
  txHash: 'c7e2ba28f4f4e4ac3fcd7ef0a98d558f7019f4df6b4c5ef3941ca539468a31b5',
  transactionIndex: 0,
  operationIndex: 0,
  inSuccessfulContractCall: true,
});

/** Replays a scripted list of pages, recording the requests it was asked for. */
function fakeClient(pages, retention = { latestLedger: 4697317, oldestLedger: 4576358 }) {
  let i = 0;
  return {
    rpcUrl: 'https://soroban-testnet.stellar.org',
    requests: [],
    async retention() { return retention; },
    async getEvents(args) {
      this.requests.push(args);
      const page = pages[Math.min(i, pages.length - 1)];
      i++;
      if (page instanceof Error) throw page;
      return { latestLedger: retention.latestLedger, oldestLedger: retention.oldestLedger, ...page };
    },
  };
}

async function take(stream, n) {
  const out = [];
  for await (const batch of stream) {
    out.push(batch);
    if (out.length >= n) break;
  }
  return out;
}

test('buildFilters chunks contract ids into groups of five', () => {
  const ids = Array.from({ length: 12 }, (_, i) => `C${i}`);
  const filters = buildFilters(ids);
  assert.equal(filters.length, 3);
  assert.deepEqual(filters.map((f) => f.contractIds.length), [5, 5, 2]);
  assert.ok(filters.every((f) => f.type === 'contract'));
});

test('buildFilters with no contract ids watches every contract', () => {
  assert.deepEqual(buildFilters([]), [{ type: 'contract' }]);
});

test('buildFilters passes topic filters through', () => {
  const topics = [['AAAADwAAAAh0cmFuc2Zlcg==', '*']];
  assert.deepEqual(buildFilters(['CA'], topics), [
    { type: 'contract', contractIds: ['CA'], topics },
  ]);
});

test('first poll with no stored cursor starts from a ledger, not a cursor', async () => {
  const client = fakeClient([{ events: [rawEvent(4695317, 0)], cursor: 'cur-1' }]);
  const poller = new EventPoller({ contractIds: [SAC], startLedger: 4695000 }, {
    client, cursors: new MemoryCursorStore(), sleep: async () => {},
  });
  await take(poller.stream(), 1);
  assert.equal(client.requests[0].startLedger, 4695000);
  assert.equal(client.requests[0].cursor, undefined);
});

test('a start ledger below the retention window is clamped to oldestLedger', async () => {
  const client = fakeClient([{ events: [rawEvent(4576358, 0)], cursor: 'cur-1' }]);
  const logs = [];
  const poller = new EventPoller({ contractIds: [SAC], startLedger: 1 }, {
    client, cursors: new MemoryCursorStore(), sleep: async () => {}, log: (m) => logs.push(m),
  });
  await take(poller.stream(), 1);
  assert.equal(client.requests[0].startLedger, 4576358);
  assert.match(logs.join('\n'), /clamped to 4576358/);
});

test('subsequent polls use the cursor and drop the ledger range', async () => {
  const client = fakeClient([
    { events: [rawEvent(4695317, 0)], cursor: 'cur-1' },
    { events: [rawEvent(4695318, 1)], cursor: 'cur-2' },
  ]);
  const poller = new EventPoller({ contractIds: [SAC], startLedger: 4695000 }, {
    client, cursors: new MemoryCursorStore(), sleep: async () => {},
  });
  await take(poller.stream(), 2);
  assert.equal(client.requests[1].cursor, 'cur-1');
  assert.equal(client.requests[1].startLedger, undefined);
});

test('a restart resumes from the persisted cursor instead of the start ledger', async () => {
  const cursors = new MemoryCursorStore();
  await cursors.save('resume-key', { cursor: 'saved-cursor', ledger: 4695317, updatedAt: '' });
  const client = fakeClient([{ events: [rawEvent(4695318, 0)], cursor: 'cur-2' }]);
  const poller = new EventPoller({ contractIds: [SAC], startLedger: 4000000 }, {
    client, cursors, cursorKey: 'resume-key', sleep: async () => {},
  });
  await take(poller.stream(), 1);
  assert.equal(client.requests[0].cursor, 'saved-cursor');
  assert.equal(client.requests[0].startLedger, undefined);
});

test('the cursor is persisted after each page', async () => {
  const cursors = new MemoryCursorStore();
  const client = fakeClient([
    { events: [rawEvent(4695317, 0)], cursor: 'cur-1' },
    { events: [rawEvent(4695318, 1)], cursor: 'cur-2' },
  ]);
  const poller = new EventPoller({ contractIds: [SAC], startLedger: 4695000 }, {
    client, cursors, cursorKey: 'k', sleep: async () => {},
  });
  await take(poller.stream(), 2);
  const saved = await cursors.load('k');
  assert.equal(saved.cursor, 'cur-1', 'cursor advances only once the consumer pulls the next page');
  assert.equal(saved.ledger, 4695317);
});

test('empty pages are not yielded but still advance the cursor', async () => {
  const cursors = new MemoryCursorStore();
  const client = fakeClient([
    { events: [], cursor: 'cur-empty' },
    { events: [rawEvent(4695320, 0)], cursor: 'cur-2' },
  ]);
  const poller = new EventPoller({ contractIds: [SAC], startLedger: 4695000, pageSize: 5 }, {
    client, cursors, cursorKey: 'k', sleep: async () => {},
  });
  const batches = await take(poller.stream(), 1);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].events[0].ledger, 4695320, 'the empty page was skipped, not yielded');
  assert.equal(client.requests[1].cursor, 'cur-empty');
});

test('a short page marks the stream as caught up', async () => {
  const client = fakeClient([{ events: [rawEvent(4695317, 0)], cursor: 'cur-1' }]);
  const poller = new EventPoller({ contractIds: [SAC], startLedger: 4695000, pageSize: 200 }, {
    client, cursors: new MemoryCursorStore(), sleep: async () => {},
  });
  const [batch] = await take(poller.stream(), 1);
  assert.equal(batch.progress.caughtUp, true);
  assert.equal(batch.progress.latestLedger, 4697317);
});

test('a full page means more history is pending', async () => {
  const events = Array.from({ length: 2 }, (_, i) => rawEvent(4695317 + i, i));
  const client = fakeClient([{ events, cursor: 'cur-1' }]);
  const poller = new EventPoller({ contractIds: [SAC], startLedger: 4695000, pageSize: 2 }, {
    client, cursors: new MemoryCursorStore(), sleep: async () => {},
  });
  const [batch] = await take(poller.stream(), 1);
  assert.equal(batch.progress.caughtUp, false);
});

test('a cursor that fell out of retention restarts from oldestLedger', async () => {
  const cursors = new MemoryCursorStore();
  await cursors.save('k', { cursor: 'ancient', ledger: 100, updatedAt: '' });
  const client = fakeClient([
    new Error('start ledger is before the oldest ledger retained by this node'),
    { events: [rawEvent(4576358, 0)], cursor: 'cur-fresh' },
  ]);
  const logs = [];
  const poller = new EventPoller({ contractIds: [SAC] }, {
    client, cursors, cursorKey: 'k', sleep: async () => {}, log: (m) => logs.push(m),
  });
  const [batch] = await take(poller.stream(), 1);
  assert.equal(client.requests[0].cursor, 'ancient');
  assert.equal(client.requests[1].startLedger, 4576358);
  assert.equal(batch.events[0].ledger, 4576358);
  assert.match(logs.join('\n'), /outside the retention window/);
});

test('errors that are not retention problems propagate', async () => {
  const client = fakeClient([new Error('invalid contract id encoding')]);
  const poller = new EventPoller({ contractIds: [OTHER], startLedger: 4695000 }, {
    client, cursors: new MemoryCursorStore(), sleep: async () => {},
  });
  await assert.rejects(() => take(poller.stream(), 1), /invalid contract id encoding/);
});

// Recovery clears the saved cursor and replays from the oldest retained
// ledger — up to seven days of work. These guard against triggering that on
// anything short of a genuine retention miss.
for (const [name, error] of [
  ['a transient error that merely mentions the cursor', new Error('bad gateway while forwarding cursor request')],
  ['a malformed-cursor rejection', new Error('invalid cursor encoding')],
  ["the client's own both-arguments guard", new Error('getEvents accepts either `cursor` or `startLedger`, never both')],
  ['an internal error worded like a range problem', Object.assign(new Error('cursor must be between 1 and 2'), { code: -32603 })],
]) {
  test(`${name} does not trigger a full re-index`, async () => {
    const cursors = new MemoryCursorStore();
    await cursors.save('k', { cursor: 'saved', ledger: 4695317, updatedAt: '' });
    const client = fakeClient([error, { events: [rawEvent(4576358, 0)], cursor: 'cur-fresh' }]);
    const poller = new EventPoller({ contractIds: [SAC] }, {
      client, cursors, cursorKey: 'k', sleep: async () => {},
    });

    await assert.rejects(() => take(poller.stream(), 1), (thrown) => thrown === error);
    // The saved position must survive, or the next start replays from scratch.
    assert.equal((await cursors.load('k')).cursor, 'saved');
    assert.equal(client.requests.length, 1, 'must not have retried from oldestLedger');
  });
}

test('a retention miss carrying the JSON-RPC invalid-request code still recovers', async () => {
  const cursors = new MemoryCursorStore();
  await cursors.save('k', { cursor: 'ancient', ledger: 100, updatedAt: '' });
  const client = fakeClient([
    Object.assign(new Error('cursor must be within the ledger range: 4576358 - 4697317'), {
      code: -32600,
    }),
    { events: [rawEvent(4576358, 0)], cursor: 'cur-fresh' },
  ]);
  const poller = new EventPoller({ contractIds: [SAC] }, {
    client, cursors, cursorKey: 'k', sleep: async () => {},
  });

  const [batch] = await take(poller.stream(), 1);
  assert.equal(client.requests[1].startLedger, 4576358);
  assert.equal(batch.events[0].ledger, 4576358);
});

test('an abort signal stops the stream', async () => {
  const controller = new AbortController();
  const client = fakeClient([{ events: [rawEvent(4695317, 0)], cursor: 'c' }]);
  const poller = new EventPoller({ contractIds: [SAC], startLedger: 4695000 }, {
    client, cursors: new MemoryCursorStore(), sleep: async () => {}, signal: controller.signal,
  });
  let count = 0;
  for await (const _ of poller.stream()) {
    count++;
    controller.abort();
  }
  assert.equal(count, 1);
});

// ── #8 validate contract ids before the first RPC call ────────────────────────

test('a malformed contract id is rejected before any network call', () => {
  const client = fakeClient([{ events: [rawEvent(4695317, 0)], cursor: 'cur-1' }]);
  // An account id is the mistake worth naming: same alphabet, wrong prefix.
  assert.throws(
    () => new EventPoller({ contractIds: ['GBIBH5UV4Q5L7VVJIHWYBTCSUDHJQXQC2V6Y5LOW4D26XNU5NREMIKE4'] }, { client }),
    (error) => {
      assert.equal(error.name, 'InvalidContractIdError');
      assert.match(error.message, /Account ids start with 'G'/);
      return true;
    },
  );
  assert.equal(client.requests.length, 0, 'must fail before reaching the RPC');
});

test('contract id validation catches every malformed id, not just the first', () => {
  const client = fakeClient([]);
  assert.throws(
    () => new EventPoller({ contractIds: ['nope', 'C0000', 'also-bad'] }, { client }),
    (error) => {
      assert.deepEqual(error.invalid, ['nope', 'C0000', 'also-bad']);
      return true;
    },
  );
});

test('a well-formed contract id and an empty list are both accepted', () => {
  const client = fakeClient([]);
  const SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
  assert.doesNotThrow(() => new EventPoller({ contractIds: [SAC] }, { client }));
  // Empty means "every contract on the network", which is documented behaviour.
  assert.doesNotThrow(() => new EventPoller({ contractIds: [] }, { client }));
});

// ── #10 report ingestion lag in PollerProgress ───────────────────────────────

test('progress reports lag in ledgers and an estimated wall-clock lag', async () => {
  const client = fakeClient([{ events: [rawEvent(4695317, 0)], cursor: 'cur-1' }]);
  const poller = new EventPoller({ contractIds: [SAC], startLedger: 4695000 }, {
    client, cursors: new MemoryCursorStore(), sleep: async () => {},
  });
  const [batch] = await take(poller.stream(), 1);

  assert.equal(batch.progress.lagLedgers, 4697317 - 4695317);
  assert.equal(batch.progress.lagSeconds, (4697317 - 4695317) * APPROX_LEDGER_SECONDS);
});

test('ingestionLag is the single definition every consumer shares', () => {
  assert.deepEqual(ingestionLag(100, 160), { lagLedgers: 60, lagSeconds: 300 });
  assert.deepEqual(ingestionLag(160, 160), { lagLedgers: 0, lagSeconds: 0 });
});

test('lag never goes negative when the node reports a stale latestLedger', () => {
  // The page we were just served can be ahead of the node's own latestLedger.
  assert.deepEqual(ingestionLag(200, 160), { lagLedgers: 0, lagSeconds: 0 });
});

// ── #19 warn when a page hits the RPC ceiling ────────────────────────────────

test('a page at the RPC ceiling logs a distinct warning naming the ledger', async () => {
  const events = Array.from({ length: MAX_PAGE_SIZE }, (_, i) => rawEvent(4695317, i));
  const client = fakeClient([{ events, cursor: 'cur-1' }]);
  const logs = [];
  const poller = new EventPoller(
    { contractIds: [SAC], startLedger: 4695000, pageSize: MAX_PAGE_SIZE },
    { client, cursors: new MemoryCursorStore(), sleep: async () => {}, log: (m) => logs.push(m) },
  );
  await take(poller.stream(), 1);

  const warning = logs.find((l) => l.includes('RPC ceiling'));
  assert.ok(warning, `expected a ceiling warning, got: ${logs.join(' | ')}`);
  assert.match(warning, /10000 events at ledger 4695317/);
});

test('a full page below the ceiling is not a ceiling warning', async () => {
  // Merely "not caught up" — the ordinary case, and must stay quiet.
  const events = Array.from({ length: 2 }, (_, i) => rawEvent(4695317 + i, i));
  const client = fakeClient([{ events, cursor: 'cur-1' }]);
  const logs = [];
  const poller = new EventPoller({ contractIds: [SAC], startLedger: 4695000, pageSize: 2 }, {
    client, cursors: new MemoryCursorStore(), sleep: async () => {}, log: (m) => logs.push(m),
  });
  const [batch] = await take(poller.stream(), 1);

  assert.equal(batch.progress.caughtUp, false);
  assert.equal(logs.find((l) => l.includes('RPC ceiling')), undefined);
});

// ── #11 dedupe within a batch before yielding ────────────────────────────────

test('a replayed batch emits each event exactly once', async () => {
  const first = [rawEvent(4695317, 0), rawEvent(4695318, 1)];
  // The same page served twice, which is what at-least-once delivery does
  // after a crash mid-write.
  const client = fakeClient([
    { events: first, cursor: 'cur-1' },
    { events: [...first, rawEvent(4695319, 2)], cursor: 'cur-2' },
  ]);
  const poller = new EventPoller({ contractIds: [SAC], startLedger: 4695000, pageSize: 200 }, {
    client, cursors: new MemoryCursorStore(), sleep: async () => {},
  });

  const batches = await take(poller.stream(), 2);
  const ids = batches.flatMap((b) => b.events.map((e) => e.id));
  assert.equal(new Set(ids).size, ids.length, `duplicate ids emitted: ${ids.join(', ')}`);
  assert.equal(ids.length, 3);
  assert.equal(batches[1].events.length, 1, 'only the genuinely new event survives');
});

test('duplicates within a single page are dropped too', async () => {
  const dupe = rawEvent(4695317, 0);
  const client = fakeClient([{ events: [dupe, dupe, rawEvent(4695318, 1)], cursor: 'cur-1' }]);
  const poller = new EventPoller({ contractIds: [SAC], startLedger: 4695000 }, {
    client, cursors: new MemoryCursorStore(), sleep: async () => {},
  });

  const [batch] = await take(poller.stream(), 1);
  assert.equal(batch.events.length, 2);
});

test('a page that is entirely duplicates is not yielded but still advances', async () => {
  const first = [rawEvent(4695317, 0)];
  const client = fakeClient([
    { events: first, cursor: 'cur-1' },
    { events: first, cursor: 'cur-2' },
    { events: [rawEvent(4695320, 3)], cursor: 'cur-3' },
  ]);
  const poller = new EventPoller({ contractIds: [SAC], startLedger: 4695000 }, {
    client, cursors: new MemoryCursorStore(), sleep: async () => {},
  });

  const batches = await take(poller.stream(), 2);
  assert.deepEqual(batches.map((b) => b.events.length), [1, 1]);
  assert.equal(batches[1].events[0].ledger, 4695320, 'the all-duplicate page was skipped');
});

test('caughtUp still reflects what the RPC returned, not what survived dedup', async () => {
  // A full page of repeats means there IS more history to walk, even though
  // nothing new came out of it.
  const events = Array.from({ length: 2 }, (_, i) => rawEvent(4695317 + i, i));
  const client = fakeClient([
    { events, cursor: 'cur-1' },
    { events, cursor: 'cur-2' },
  ]);
  const poller = new EventPoller({ contractIds: [SAC], startLedger: 4695000, pageSize: 2 }, {
    client, cursors: new MemoryCursorStore(), sleep: async () => {},
  });

  const [batch] = await take(poller.stream(), 1);
  assert.equal(batch.progress.caughtUp, false);
});
