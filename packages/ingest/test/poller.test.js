import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EventPoller,
  MemoryCursorStore,
  buildFilters,
  ingestionLag,
  APPROX_LEDGER_SECONDS,
  MAX_PAGE_SIZE,
  IngestMetrics,
  isContractId,
  RetryExhaustedError,
  withRetry,
} from '../dist/index.js';

const SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const OTHER = 'CA6F5E42TCRGPMDXU33WGMXAADPNEKOIZETAWSKYKAWNHESQQ2MTLSCC';

/**
 * #142: `cursorKey` is a base key; the poller derives per-contract keys as
 * `<base>:<contractId>`. These helpers keep the tests reading naturally.
 */
const K = (base, id) => `${base}:${id}`;

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

test('metrics advance after acknowledgement and include empty-page progress', async () => {
  const metrics = new IngestMetrics();
  const abort = new AbortController();
  const client = fakeClient([
    { events: [rawEvent(4695317, 0)], cursor: 'one' },
    { events: [], cursor: 'two' },
  ]);
  const stream = new EventPoller({ contractIds: [SAC] }, {
    client, metrics, signal: abort.signal,
    sleep: async () => abort.abort(),
  }).stream();
  await stream.next();
  assert.doesNotMatch(metrics.render(), /lens_events_ingested_total\{/);
  assert.equal((await stream.next()).done, true);
  assert.match(metrics.render(), /lens_events_ingested_total\{contract="[^"]+"\} 1\n/);
  await new EventPoller({ contractIds: [SAC], endLedger: 4697317 }, {
    client: fakeClient([{ events: [], cursor: 'empty' }]), metrics,
  }).stream().next();
  assert.match(metrics.render(), /lens_current_ledger 4697317\n/);
  assert.match(metrics.render(), /lens_latest_ledger 4697317\n/);
});

test('metrics count retention recovery once', async () => {
  const metrics = new IngestMetrics();
  const cursors = new MemoryCursorStore();
  await cursors.save(K('metrics', SAC), { cursor: 'ancient', ledger: 100, updatedAt: '' });
  await take(new EventPoller({ contractIds: [SAC] }, {
    client: fakeClient([
      new Error('start ledger is before the oldest ledger retained by this node'),
      { events: [rawEvent(4576358, 0)], cursor: 'fresh' },
    ]), cursors, cursorKey: 'metrics', metrics,
  }).stream(), 1);
  assert.match(metrics.render(), /lens_cursor_restarts_total 1\n/);
});

test('a fixed RPC tip warns once after the threshold and clears on advancement', async () => {
  const controller = new AbortController();
  const metrics = new IngestMetrics();
  const logs = [];
  const snapshots = [];
  let now = 0;
  const client = fakeClient([
    { events: [], cursor: 'one', latestLedger: 4697317 },
    { events: [], cursor: 'two', latestLedger: 4697317 },
    { events: [], cursor: 'three', latestLedger: 4697317 },
    { events: [], cursor: 'four', latestLedger: 4697317 },
    { events: [], cursor: 'five', latestLedger: 4697318 },
  ]);
  const poller = new EventPoller({
    contractIds: [SAC], pollIntervalMs: 10, maxPollIntervalMs: 10, stalledThresholdMs: 20,
  }, {
    client,
    metrics,
    signal: controller.signal,
    log: (message) => logs.push(message),
    now: () => now,
    sleep: async (ms) => {
      snapshots.push(metrics.render());
      now += ms;
      if (now >= 50) controller.abort();
    },
  });

  for await (const _batch of poller.stream()) {}

  assert.equal(logs.filter((message) => message.includes('may be stalled')).length, 1);
  assert.match(snapshots[2], /lens_rpc_stalled 1\n/);
  assert.match(snapshots[3], /lens_rpc_stalled 1\n/);
  assert.match(snapshots[4], /lens_rpc_stalled 0\n/);
});

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
  await cursors.save(K('resume-key', SAC), { cursor: 'saved-cursor', ledger: 4695317, updatedAt: '' });
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
  const saved = await cursors.load(K('k', SAC));
  assert.equal(saved.cursor, 'cur-1', 'cursor advances only once the consumer pulls the next page');
  assert.equal(saved.ledger, 4695317);
  assert.deepEqual(saved.retention, { latestLedger: 4697317, oldestLedger: 4576358 });
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

test('consecutive empty polls use capped exponential idle backoff', async () => {
  const sleeps = [];
  const controller = new AbortController();
  const client = fakeClient([
    { events: [], cursor: 'empty-1' },
    { events: [], cursor: 'empty-2' },
    { events: [], cursor: 'empty-3' },
    { events: [rawEvent(4695320, 0)], cursor: 'event' },
  ]);
  const poller = new EventPoller(
    { contractIds: [SAC], startLedger: 4695000, pollIntervalMs: 100, maxPollIntervalMs: 250 },
    { client, signal: controller.signal, sleep: async (ms) => sleeps.push(ms) },
  );

  await take(poller.stream(), 1);
  assert.deepEqual(sleeps, [100, 200, 250]);
});

test('an event resets idle backoff before the next quiet poll', async () => {
  const sleeps = [];
  const controller = new AbortController();
  const client = fakeClient([
    { events: [], cursor: 'empty-1' },
    { events: [], cursor: 'empty-2' },
    { events: [rawEvent(4695317, 0)], cursor: 'event-1' },
    { events: [], cursor: 'empty-after-event' },
    { events: [rawEvent(4695318, 1)], cursor: 'event-2' },
  ]);
  const poller = new EventPoller(
    { contractIds: [SAC], startLedger: 4695000, pollIntervalMs: 100, maxPollIntervalMs: 400 },
    {
      client,
      signal: controller.signal,
      sleep: async (ms) => {
        sleeps.push(ms);
        if (sleeps.length === 4) controller.abort();
      },
    },
  );

  await take(poller.stream(), 2);
  assert.deepEqual(sleeps, [100, 200, 100, 100]);
});

test('a cap equal to the base interval preserves fixed polling', async () => {
  const sleeps = [];
  const controller = new AbortController();
  const client = fakeClient([
    { events: [], cursor: 'empty-1' },
    { events: [], cursor: 'empty-2' },
    { events: [], cursor: 'empty-3' },
  ]);
  const poller = new EventPoller(
    { contractIds: [SAC], startLedger: 4695000, pollIntervalMs: 100, maxPollIntervalMs: 100 },
    {
      client,
      signal: controller.signal,
      sleep: async (ms) => {
        sleeps.push(ms);
        if (sleeps.length === 3) controller.abort();
      },
    },
  );

  await poller.stream().next();
  assert.deepEqual(sleeps, [100, 100, 100]);
});

test('invalid idle polling intervals are rejected before the first request', async () => {
  const client = fakeClient([{ events: [], cursor: 'empty' }]);
  for (const options of [
    { pollIntervalMs: -1 },
    { pollIntervalMs: 100, maxPollIntervalMs: 99 },
    { pollIntervalMs: 100, maxPollIntervalMs: Number.NaN },
  ]) {
    const poller = new EventPoller({ contractIds: [SAC], startLedger: 4695000, ...options }, { client });
    await assert.rejects(() => poller.stream().next(), /pollIntervalMs|maxPollIntervalMs/);
  }
  assert.equal(client.requests.length, 0);
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
  await cursors.save(K('k', SAC), { cursor: 'ancient', ledger: 100, updatedAt: '' });
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

test('a restart whose saved position fell out of the window warns before fetching', async () => {
  const cursors = new MemoryCursorStore();
  await cursors.save(K('k', SAC), {
    cursor: 'ancient',
    ledger: 100,
    updatedAt: '2026-10-01T00:00:00Z',
    retention: { latestLedger: 4690000, oldestLedger: 50 },
  });
  const client = fakeClient([
    new Error('start ledger is before the oldest ledger retained by this node'),
    { events: [rawEvent(4576358, 0)], cursor: 'cur-fresh' },
  ]);
  const logs = [];
  const poller = new EventPoller({ contractIds: [SAC] }, {
    client, cursors, cursorKey: 'k', sleep: async () => {},
    log: (m) => logs.push({ m, fetched: client.requests.length }),
  });

  const [batch] = await take(poller.stream(), 1);

  const warning = logs.find((entry) => /retention window has moved past/.test(entry.m));
  assert.ok(warning, 'expected a retention gap warning');
  assert.equal(warning.fetched, 0, 'the warning must come before the first getEvents call');
  assert.match(warning.m, /retains from ledger 4576358/);
  assert.match(warning.m, /stopped at ledger 100/);
  assert.match(warning.m, /advanced 4576308 ledgers since then/);
  assert.match(warning.m, /4576258 ledger\(s\) of events in between are unrecoverable/);
  assert.equal(client.requests[0].cursor, 'ancient');
  assert.equal(batch.events[0].ledger, 4576358);
});

test('a restart still inside the window does not warn about a gap', async () => {
  const cursors = new MemoryCursorStore();
  await cursors.save(K('k', SAC), {
    cursor: 'saved',
    ledger: 4695317,
    updatedAt: '',
    retention: { latestLedger: 4697317, oldestLedger: 4500000 },
  });
  const client = fakeClient([{ events: [rawEvent(4695318, 0)], cursor: 'cur-2' }]);
  const logs = [];
  const poller = new EventPoller({ contractIds: [SAC] }, {
    client, cursors, cursorKey: 'k', sleep: async () => {}, log: (m) => logs.push(m),
  });
  await take(poller.stream(), 1);
  assert.doesNotMatch(logs.join('\n'), /retention window has moved past/);
  assert.match(logs.join('\n'), /resuming from cursor saved/);
});

test('a cursor saved before snapshots existed is compared by ledger alone', async () => {
  const cursors = new MemoryCursorStore();
  await cursors.save(K('k', SAC), { cursor: 'ancient', ledger: 100, updatedAt: '' });
  const client = fakeClient([{ events: [rawEvent(4576358, 0)], cursor: 'cur-1' }]);
  const logs = [];
  const poller = new EventPoller({ contractIds: [SAC] }, {
    client, cursors, cursorKey: 'k', sleep: async () => {}, log: (m) => logs.push(m),
  });
  await take(poller.stream(), 1);
  const text = logs.join('\n');
  assert.match(text, /retention window has moved past/);
  assert.doesNotMatch(text, /advanced .* ledgers since then/);
});

test('a failed retention check does not stop a warm restart', async () => {
  const cursors = new MemoryCursorStore();
  await cursors.save(K('k', SAC), { cursor: 'saved', ledger: 4695317, updatedAt: '' });
  const client = {
    rpcUrl: 'https://soroban-testnet.stellar.org',
    requests: [],
    async retention() { throw new Error('getHealth timed out'); },
    async getEvents(args) {
      this.requests.push(args);
      return {
        events: [rawEvent(4695318, 0)], cursor: 'cur-2',
        latestLedger: 4697317, oldestLedger: 4576358,
      };
    },
  };
  const logs = [];
  const poller = new EventPoller({ contractIds: [SAC] }, {
    client, cursors, cursorKey: 'k', sleep: async () => {}, log: (m) => logs.push(m),
  });
  const [batch] = await take(poller.stream(), 1);
  assert.equal(batch.events[0].ledger, 4695318);
  assert.match(logs.join('\n'), /could not read the node's retention window/);
  assert.equal(client.requests[0].cursor, 'saved');
});

test('errors that are not retention problems propagate', async () => {
  const client = fakeClient([new Error('invalid contract id encoding')]);
  const poller = new EventPoller({ contractIds: [OTHER], startLedger: 4695000 }, {
    client, cursors: new MemoryCursorStore(), sleep: async () => {},
  });
  await assert.rejects(() => take(poller.stream(), 1), /invalid contract id encoding/);
});

for (const [name, error] of [
  ['a transient error that merely mentions the cursor', new Error('bad gateway while forwarding cursor request')],
  ['a malformed-cursor rejection', new Error('invalid cursor encoding')],
  ["the client's own both-arguments guard", new Error('getEvents accepts either `cursor` or `startLedger`, never both')],
  ['an internal error worded like a range problem', Object.assign(new Error('cursor must be between 1 and 2'), { code: -32603 })],
]) {
  test(`${name} does not trigger a full re-index`, async () => {
    const cursors = new MemoryCursorStore();
    await cursors.save(K('k', SAC), { cursor: 'saved', ledger: 4695317, updatedAt: '' });
    const client = fakeClient([error, { events: [rawEvent(4576358, 0)], cursor: 'cur-fresh' }]);
    const poller = new EventPoller({ contractIds: [SAC] }, {
      client, cursors, cursorKey: 'k', sleep: async () => {},
    });

    await assert.rejects(() => take(poller.stream(), 1), (thrown) => thrown === error);
    assert.equal((await cursors.load(K('k', SAC))).cursor, 'saved');
    assert.equal(client.requests.length, 1, 'must not have retried from oldestLedger');
  });
}

test('a retention miss carrying the JSON-RPC invalid-request code still recovers', async () => {
  const cursors = new MemoryCursorStore();
  await cursors.save(K('k', SAC), { cursor: 'ancient', ledger: 100, updatedAt: '' });
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

test('a contract-shaped id with a changed character fails its checksum before RPC', () => {
  const client = fakeClient([]);
  const mistyped = `C${SAC[1] === 'A' ? 'B' : 'A'}${SAC.slice(2)}`;
  assert.match(mistyped, /^C[A-Z2-7]{55}$/);
  assert.equal(isContractId(mistyped), false);
  assert.throws(
    () => new EventPoller({ contractIds: [mistyped] }, { client }),
    (error) => {
      assert.equal(error.name, 'InvalidContractIdError');
      assert.match(error.message, /checksum/);
      return true;
    },
  );
  assert.equal(client.requests.length, 0, 'must fail before reaching the RPC');
});

test('readiness drops after exhausted RPC retries and recovers on an empty page', async () => {
  const metrics = new IngestMetrics();
  const controller = new AbortController();
  const client = fakeClient([
    new RetryExhaustedError('RPC is unreachable', 2, new Error('connection refused')),
    { events: [], cursor: 'cur-1' },
  ]);
  let sleeps = 0;
  const poller = new EventPoller({ contractIds: [SAC], pollIntervalMs: 0 }, {
    client,
    metrics,
    signal: controller.signal,
    sleep: async () => {
      if (sleeps++ === 0) assert.equal(metrics.isReady(1000), false);
      else {
        assert.equal(metrics.isReady(1000), true);
        controller.abort();
      }
    },
  });
  const batches = [];
  for await (const batch of poller.stream()) batches.push(batch);
  assert.equal(batches.length, 0);
  assert.equal(sleeps, 2);
  assert.equal(metrics.isReady(1000), true);
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
  assert.doesNotThrow(() => new EventPoller({ contractIds: [SAC] }, { client }));
  assert.doesNotThrow(() => new EventPoller({ contractIds: [] }, { client }));
});

// ── #10 report ingestion lag in PollerProgress ────────────────────────────────

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
  assert.deepEqual(ingestionLag(200, 160), { lagLedgers: 0, lagSeconds: 0 });
});

// ── #19 warn when a page hits the RPC ceiling ─────────────────────────────────

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

// ── #11 dedupe within a batch before yielding ─────────────────────────────────

test('a replayed batch emits each event exactly once', async () => {
  const first = [rawEvent(4695317, 0), rawEvent(4695318, 1)];
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
  assert.equal(batches[1].events.length, 1);
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
  assert.equal(batches[1].events[0].ledger, 4695320);
});

test('caughtUp still reflects what the RPC returned, not what survived dedup', async () => {
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

// ── #4 expose system events ───────────────────────────────────────────────────

test('buildFilters defaults to contract events, unchanged', () => {
  assert.deepEqual(buildFilters([]), [{ type: 'contract' }]);
  assert.deepEqual(buildFilters(['CA']), [{ type: 'contract', contractIds: ['CA'] }]);
});

test('buildFilters can ask for system events; diagnostic was removed (#144)', () => {
  assert.deepEqual(buildFilters([], undefined, 'system'), [{ type: 'system' }]);
});

test('the event type reaches the RPC filter, and defaults to contract', async () => {
  const client = fakeClient([{ events: [rawEvent(4695317, 0)], cursor: 'cur-1' }]);
  const poller = new EventPoller(
    { contractIds: [SAC], startLedger: 4695000, eventType: 'system' },
    { client, cursors: new MemoryCursorStore(), sleep: async () => {} },
  );
  await take(poller.stream(), 1);
  assert.equal(client.requests[0].filters[0].type, 'system');

  const plain = fakeClient([{ events: [rawEvent(4695317, 0)], cursor: 'cur-1' }]);
  const defaulted = new EventPoller({ contractIds: [SAC], startLedger: 4695000 }, {
    client: plain, cursors: new MemoryCursorStore(), sleep: async () => {},
  });
  await take(defaulted.stream(), 1);
  assert.equal(plain.requests[0].filters[0].type, 'contract');
});

// ── #9 bounded runs with endLedger ────────────────────────────────────────────

test('endLedger is passed to the RPC and ends the stream cleanly', async () => {
  const client = fakeClient([{ events: [rawEvent(4695317, 0)], cursor: 'cur-1' }]);
  const poller = new EventPoller(
    { contractIds: [SAC], startLedger: 4695000, endLedger: 4695400, pageSize: 200 },
    { client, cursors: new MemoryCursorStore(), sleep: async () => {} },
  );

  const batches = [];
  for await (const batch of poller.stream()) batches.push(batch);

  assert.equal(batches.length, 1);
  assert.equal(client.requests[0].endLedger, 4695400);
  assert.equal(batches[0].progress.reachedEndLedger, true);
});

test('a bounded run keeps paging while the RPC fills pages', async () => {
  const full = Array.from({ length: 2 }, (_, i) => rawEvent(4695317 + i, i));
  const client = fakeClient([
    { events: full, cursor: 'cur-1' },
    { events: [rawEvent(4695319, 5)], cursor: 'cur-2' },
  ]);
  const poller = new EventPoller(
    { contractIds: [SAC], startLedger: 4695000, endLedger: 4695400, pageSize: 2 },
    { client, cursors: new MemoryCursorStore(), sleep: async () => {} },
  );

  const batches = [];
  for await (const batch of poller.stream()) batches.push(batch);

  assert.equal(batches.length, 2, 'a full page means the range is not exhausted yet');
  assert.equal(batches[0].progress.reachedEndLedger, false);
  assert.equal(batches[1].progress.reachedEndLedger, true);
});

test('an unbounded run never reports reachedEndLedger', async () => {
  const client = fakeClient([{ events: [rawEvent(4695317, 0)], cursor: 'cur-1' }]);
  const poller = new EventPoller({ contractIds: [SAC], startLedger: 4695000 }, {
    client, cursors: new MemoryCursorStore(), sleep: async () => {},
  });
  const [batch] = await take(poller.stream(), 1);
  assert.equal(batch.progress.reachedEndLedger, false);
  assert.equal(client.requests[0].endLedger, undefined);
});

// ── #5 topic filters reach the RPC ────────────────────────────────────────────

test('topic filters are passed through to the RPC filter', async () => {
  const topics = [['AAAADwAAAAh0cmFuc2Zlcg==', '*']];
  const client = fakeClient([{ events: [rawEvent(4695317, 0)], cursor: 'cur-1' }]);
  const poller = new EventPoller(
    { contractIds: [SAC], startLedger: 4695000, topics },
    { client, cursors: new MemoryCursorStore(), sleep: async () => {} },
  );
  await take(poller.stream(), 1);
  assert.deepEqual(client.requests[0].filters[0].topics, topics);
});

test('the retention-gap restart does not wait through retry backoff', async () => {
  const sleeps = [];
  const outOfRange = Object.assign(
    new Error('cursor is outside the retention window: must be between the oldest ledger 4576358 and the latest'),
    { code: -32600 },
  );
  const inner = fakeClient([outOfRange, { events: [rawEvent(4576358, 0)], cursor: 'fresh' }]);
  const client = {
    ...inner,
    requests: inner.requests,
    getEvents: (args) => withRetry(() => inner.getEvents(args), { sleep: async (ms) => sleeps.push(ms) }),
  };
  const cursors = new MemoryCursorStore();
  await cursors.save(K('gap', SAC), { cursor: 'ancient', ledger: 100, updatedAt: '' });

  const [batch] = await take(new EventPoller({ contractIds: [SAC] }, {
    client, cursors, cursorKey: 'gap', sleep: async (ms) => sleeps.push(ms),
  }).stream(), 1);

  assert.equal(batch.events.length, 1);
  assert.equal(inner.requests.length, 2, 'one rejected request, then the restart');
  assert.equal(inner.requests[1].startLedger, 4576358);
  assert.deepEqual(sleeps, [], 'no backoff before the restart');
});

// ── #139 check the network passphrase before the first poll ───────────────────

test('a mismatched network passphrase fails before any getEvents call', async () => {
  const client = fakeClient([{ events: [rawEvent(4695317, 0)], cursor: 'cur-1' }]);
  client.getNetwork = async () => ({ passphrase: 'Test SDF Network ; September 2015' });
  const poller = new EventPoller(
    {
      contractIds: [SAC],
      networkPassphrase: 'Public Global Stellar Network ; September 2015',
    },
    { client, cursors: new MemoryCursorStore(), sleep: async () => {} },
  );

  await assert.rejects(
    () => poller.stream().next(),
    (error) => {
      assert.equal(error.name, 'NetworkPassphraseMismatchError');
      assert.equal(error.expected, 'Public Global Stellar Network ; September 2015');
      assert.equal(error.actual, 'Test SDF Network ; September 2015');
      assert.equal(error.rpcUrl, 'https://soroban-testnet.stellar.org');
      assert.match(error.message, /Network passphrase mismatch/);
      return true;
    },
  );
  assert.equal(client.requests.length, 0, 'must fail before reaching getEvents');
});

test('a matching network passphrase proceeds to the first poll', async () => {
  const client = fakeClient([{ events: [rawEvent(4695317, 0)], cursor: 'cur-1' }]);
  client.getNetwork = async () => ({ passphrase: 'Test SDF Network ; September 2015' });
  const poller = new EventPoller(
    {
      contractIds: [SAC],
      startLedger: 4695000,
      networkPassphrase: 'Test SDF Network ; September 2015',
    },
    { client, cursors: new MemoryCursorStore(), sleep: async () => {} },
  );

  const [batch] = await take(poller.stream(), 1);
  assert.equal(batch.events.length, 1);
  assert.equal(client.requests.length, 1);
});

test('no networkPassphrase configured skips the check entirely', async () => {
  let called = 0;
  const client = fakeClient([{ events: [rawEvent(4695317, 0)], cursor: 'cur-1' }]);
  client.getNetwork = async () => { called++; return { passphrase: 'irrelevant' }; };
  const poller = new EventPoller({ contractIds: [SAC], startLedger: 4695000 }, {
    client, cursors: new MemoryCursorStore(), sleep: async () => {},
  });

  await take(poller.stream(), 1);
  assert.equal(called, 0, 'getNetwork must not be called when no passphrase is configured');
});

test('getNetwork is called once, not once per page', async () => {
  let called = 0;
  const client = fakeClient([
    { events: [rawEvent(4695317, 0)], cursor: 'cur-1' },
    { events: [rawEvent(4695318, 1)], cursor: 'cur-2' },
  ]);
  client.getNetwork = async () => {
    called++;
    return { passphrase: 'Test SDF Network ; September 2015' };
  };
  const poller = new EventPoller(
    {
      contractIds: [SAC],
      startLedger: 4695000,
      networkPassphrase: 'Test SDF Network ; September 2015',
    },
    { client, cursors: new MemoryCursorStore(), sleep: async () => {} },
  );

  await take(poller.stream(), 2);
  assert.equal(called, 1, 'the check runs before the first poll and never again');
});

// ── #142 add a contract without replaying the others ─────────────────────────

test('adding a contract does not reset the others (#142)', async () => {
  // Two distinct valid contract ids plus a third for the "newly added" case.
  const A = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
  const B = 'CA6F5E42TCRGPMDXU33WGMXAADPNEKOIZETAWSKYKAWNHESQQ2MTLSCC';
  const C = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';

  const cursors = new MemoryCursorStore();
  const requests = [];
  const called = { [A]: 0, [B]: 0, [C]: 0 };

  /**
   * Each contract returns 2 events on its first call, then empty. The `called`
   * counter is shared across `makeClient()` instances so round 1's progress is
   * visible to round 2.
   */
  const makeClient = () => ({
    rpcUrl: 'https://soroban-testnet.stellar.org',
    async retention() { return { latestLedger: 4697317, oldestLedger: 4576358 }; },
    async getEvents(args) {
      const id = args.filters[0].contractIds[0];
      requests.push({
        id,
        mode: args.cursor ? 'cursor' : 'startLedger',
        startLedger: args.startLedger,
        cursor: args.cursor,
      });
      const n = called[id]++;
      const events = n === 0
        ? [
            { ...rawEvent(4695317, 0), contractId: id },
            { ...rawEvent(4695318, 1), contractId: id },
          ]
        : [];
      return {
        events,
        cursor: `cursor-${id}-${n}`,
        latestLedger: 4697317,
        oldestLedger: 4576358,
      };
    },
  });

  // Round 1: [A, B] indexed to caught-up. Cursors saved per contract.
  for await (const _ of new EventPoller(
    { contractIds: [A, B], startLedger: 4695000, endLedger: 4697317, pageSize: 10 },
    { client: makeClient(), cursors, sleep: async () => {} },
  ).stream()) { /* drain */ }

  requests.length = 0;
  // A and B were each called once; leaving `called` alone means round 2 sees
  // them "caught up" (empty page) and C "backfilling" (its first page).

  // Round 2: same config plus C.
  for await (const _ of new EventPoller(
    { contractIds: [A, B, C], startLedger: 4695000, endLedger: 4697317, pageSize: 10 },
    { client: makeClient(), cursors, sleep: async () => {} },
  ).stream()) { /* drain */ }

  const aReqs = requests.filter((r) => r.id === A);
  const bReqs = requests.filter((r) => r.id === B);
  const cReqs = requests.filter((r) => r.id === C);

  // Existing contracts: every request carries a cursor, never a start ledger.
  assert.ok(aReqs.length > 0, 'A must be polled');
  assert.ok(aReqs.every((r) => r.mode === 'cursor'),
    `A must never backfill, got: ${JSON.stringify(aReqs)}`);
  assert.ok(bReqs.length > 0, 'B must be polled');
  assert.ok(bReqs.every((r) => r.mode === 'cursor'),
    `B must never backfill, got: ${JSON.stringify(bReqs)}`);

  // New contract: backfills from its start ledger, then uses its own cursor.
  assert.ok(cReqs.length > 0, 'C must be polled');
  assert.equal(cReqs[0].mode, 'startLedger');
  assert.equal(cReqs[0].startLedger, 4695000);
  if (cReqs.length > 1) {
    assert.ok(cReqs.slice(1).every((r) => r.mode === 'cursor'),
      'C must resume from its own cursor after its first page');
  }
});

test('adding a contract does not re-read pages for the others — page counts (#142)', async () => {
  const A = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
  const B = 'CA6F5E42TCRGPMDXU33WGMXAADPNEKOIZETAWSKYKAWNHESQQ2MTLSCC';
  const C = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';

  const cursors = new MemoryCursorStore();
  const requests = [];
  const called = { [A]: 0, [B]: 0, [C]: 0 };

  // Slow path: A and B each have 3 events and are re-indexed page-by-page
  // (pageSize 1) so the count is unambiguous. If a reset happened, their
  // pages in round 2 would be > 1 (they would need to re-fetch history).
  const makeClient = () => ({
    rpcUrl: 'https://soroban-testnet.stellar.org',
    async retention() { return { latestLedger: 4697317, oldestLedger: 4576358 }; },
    async getEvents(args) {
      const id = args.filters[0].contractIds[0];
      requests.push({ id, mode: args.cursor ? 'cursor' : 'startLedger' });
      const n = called[id]++;
      const events = n < 3
        ? [{ ...rawEvent(4695317 + n, n), contractId: id }]
        : [];
      return {
        events,
        cursor: `cursor-${id}-${n}`,
        latestLedger: 4697317,
        oldestLedger: 4576358,
      };
    },
  });

  // Round 1: A and B fully indexed.
  for await (const _ of new EventPoller(
    { contractIds: [A, B], startLedger: 4695000, endLedger: 4697317, pageSize: 1 },
    { client: makeClient(), cursors, sleep: async () => {} },
  ).stream()) { /* drain */ }

  requests.length = 0;

  // Round 2: add C. If A or B were reset, their page counts would exceed 1.
  for await (const _ of new EventPoller(
    { contractIds: [A, B, C], startLedger: 4695000, endLedger: 4697317, pageSize: 1 },
    { client: makeClient(), cursors, sleep: async () => {} },
  ).stream()) { /* drain */ }

  const aPages = requests.filter((r) => r.id === A).length;
  const bPages = requests.filter((r) => r.id === B).length;
  // A and B are already caught up, so each needs exactly one empty page per
  // round before the round concludes. Crucially, they never re-index.
  assert.equal(aPages, 1, `A must not re-read (expected 1 empty page, got ${aPages})`);
  assert.equal(bPages, 1, `B must not re-read (expected 1 empty page, got ${bPages})`);
});

// ── #143 record and replay RPC traffic ────────────────────────────────────────

test('a poller runs end to end from a committed recording (#143)', async () => {
  const { fileURLToPath } = await import('node:url');
  const { RecordedRpcClient } = await import('../dist/index.js');
  const path = fileURLToPath(new URL('../../../fixtures/testnet-getevents-recording.json', import.meta.url));
  const client = await RecordedRpcClient.load(path);

  // Same startup sequence as a real run: passphrase check (#139), then the
  // backfill resolution reads `retention()`, then per-contract `getEvents`.
  const poller = new EventPoller(
    {
      contractIds: [SAC],
      startLedger: 4695000,
      endLedger: 4695400,
      pageSize: 2,
      networkPassphrase: 'Test SDF Network ; September 2015',
    },
    { client, cursors: new MemoryCursorStore(), sleep: async () => {} },
  );

  const batches = [];
  for await (const batch of poller.stream()) batches.push(batch);

  // Two pages: 2 events (full), 1 event (short, caught up, reachedEndLedger).
  assert.equal(batches.length, 2);
  assert.equal(batches[0].events.length, 2);
  assert.equal(batches[1].events.length, 1);
  assert.equal(batches[0].progress.caughtUp, false);
  assert.equal(batches[1].progress.caughtUp, true);
  assert.equal(batches[1].progress.reachedEndLedger, true);

  const ids = batches.flatMap((b) => b.events.map((e) => e.id));
  assert.equal(ids.length, 3, 'all three recorded events were replayed');
  assert.equal(new Set(ids).size, ids.length, 'no duplicates across pages');
  assert.deepEqual(batches[0].events.map((e) => e.ledger), [4695317, 4695318]);
  assert.deepEqual(batches[1].events.map((e) => e.ledger), [4695319]);

  // Every event came from the recording's contract, not a hand-written fake.
  const contracts = new Set(batches.flatMap((b) => b.events.map((e) => e.contractId)));
  assert.deepEqual([...contracts], [SAC]);
});

test('a replayed recording with no matching exchange fails clearly (#143)', async () => {
  const { RecordedRpcClient } = await import('../dist/index.js');
  const client = new RecordedRpcClient({
    version: 1,
    recordedAt: '2026-09-15T21:40:00Z',
    meta: { rpcUrl: 'https://example.invalid' },
    exchanges: [{ method: 'retention', args: null, response: { latestLedger: 1, oldestLedger: 1 } }],
  });
  await assert.rejects(
    () => client.getEvents({ filters: [], startLedger: 1 }),
    /no recorded getEvents exchange/,
  );
});
