import test from 'node:test';
import assert from 'node:assert/strict';
import { AdaptivePageSize, EventPoller, MemoryCursorStore, RetryExhaustedError } from '../dist/index.js';

// #14 adaptive page size.

const SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

test('full, fast pages double the size up to the ceiling', () => {
  const p = new AdaptivePageSize({ initial: 200, min: 100, max: 1000 });
  const sizes = [];
  for (let i = 0; i < 5; i++) {
    p.recordPage(p.size, 50);
    sizes.push(p.size);
  }
  assert.deepEqual(sizes, [400, 800, 1000, 1000, 1000]);
});

test('slow pages and failures halve it down to the floor', () => {
  const p = new AdaptivePageSize({ initial: 800, min: 100, max: 1000, slowMs: 5000 });
  p.recordPage(10, 6000);
  assert.equal(p.size, 400);
  p.recordFailure();
  p.recordFailure();
  p.recordFailure();
  assert.equal(p.size, 100);
});

test('after a failure it does not grow straight back into the size that failed', () => {
  const p = new AdaptivePageSize({ initial: 3200, min: 100, max: 10_000 });
  p.recordFailure();
  assert.equal(p.size, 1600);
  for (let i = 0; i < 10; i++) p.recordPage(p.size, 50);
  assert.equal(p.size, 1600, 'capped at the post-failure size');
  for (let i = 0; i < 50; i++) p.recordPage(p.size, 50);
  assert.equal(p.size, 3200, 'probes one step higher after a long run of good pages');
});

test('a short page or a middling response time leaves it alone', () => {
  const p = new AdaptivePageSize({ initial: 200, min: 100, max: 1000, fastMs: 1000, slowMs: 5000 });
  p.recordPage(150, 50); // not full: nothing more to fetch, no reason to grow
  p.recordPage(200, 3000); // full, but neither fast nor slow
  assert.equal(p.size, 200);
});

test('bounds are validated and the start is clamped into them', () => {
  assert.equal(new AdaptivePageSize({ initial: 50, min: 100, max: 1000 }).size, 100);
  assert.equal(new AdaptivePageSize({ initial: 200, min: 200, max: 200 }).adaptive, false);
  for (const bad of [{ min: 0, max: 10 }, { min: 10, max: 5 }, { min: 1, max: 10_001 }, { min: 1.5, max: 10 }]) {
    assert.throws(() => new AdaptivePageSize({ initial: 10, ...bad }), RangeError, JSON.stringify(bad));
  }
});

/** A busy contract: `total` events, each page costing `perEventMs` of fake time. */
function busyClient({ total, perEventMs = 0.1, timeoutAbove = Infinity, clock }) {
  const events = Array.from({ length: total }, (_, i) => ({
    id: `${String(1000 + Math.floor(i / 50)).padStart(19, '0')}-${String(i).padStart(10, '0')}`,
    type: 'contract',
    ledger: 1000 + Math.floor(i / 50),
    ledgerClosedAt: '2026-09-15T19:22:52Z',
    contractId: SAC,
    topic: [],
    value: 'AAAAAQ==',
    txHash: '00',
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
  }));
  return {
    rpcUrl: 'https://rpc.example',
    requests: [],
    failures: 0,
    exhausted: false,
    async retention() {
      return { latestLedger: 2000, oldestLedger: 1000 };
    },
    async getEvents({ cursor, startLedger, limit }) {
      this.requests.push(limit);
      if (limit > timeoutAbove) {
        this.failures++;
        clock.t += 10_000;
        throw new RetryExhaustedError('timed out', 1, new Error('timeout'));
      }
      const from = cursor ? events.filter((e) => e.id > cursor) : events.filter((e) => e.ledger >= startLedger);
      const page = from.slice(0, limit);
      clock.t += 50 + page.length * perEventMs;
      if (page.length < limit) this.exhausted = true;
      return { events: page, cursor: page.at(-1)?.id ?? cursor ?? 'start', latestLedger: 2000, oldestLedger: 1000 };
    },
  };
}

async function drain(options, client, clock) {
  let delivered = 0;
  const abort = new AbortController();
  const poller = new EventPoller(
    { contractIds: [SAC], reorgDepth: 0, ...options },
    { client, cursors: new MemoryCursorStore(), now: () => clock.t, signal: abort.signal, // The retry path sleeps too; only stop once history is fully served.
      sleep: async () => { if (client.exhausted) abort.abort(); } },
  );
  for await (const batch of poller.stream()) delivered += batch.events.length;
  return delivered;
}

test('on a busy contract, adaptive paging needs far fewer round trips for the same events', async () => {
  const fixedClock = { t: 0 };
  const fixed = busyClient({ total: 20_000, clock: fixedClock });
  assert.equal(await drain({ pageSize: 200 }, fixed, fixedClock), 20_000);

  const adaptiveClock = { t: 0 };
  const adaptive = busyClient({ total: 20_000, clock: adaptiveClock });
  assert.equal(await drain({ pageSize: 200, pageSizeBounds: { min: 100, max: 10_000 } }, adaptive, adaptiveClock), 20_000);

  assert.equal(fixed.requests.length, 101);
  assert.ok(adaptive.requests.length <= 10, `adaptive took ${adaptive.requests.length} round trips`);
  assert.equal(adaptive.failures, 0);
});

test('a node that times out on large pages pushes the size back down, and every event still arrives', async () => {
  const clock = { t: 0 };
  const client = busyClient({ total: 5000, timeoutAbove: 1600, clock });
  const delivered = await drain({ pageSize: 200, pageSizeBounds: { min: 100, max: 10_000 } }, client, clock);
  assert.equal(delivered, 5000);
  // It probes past the limit once, backs off, and settles under it.
  assert.equal(client.failures, 1);
  const failedAt = client.requests.findIndex((limit) => limit > 1600);
  assert.ok(client.requests.slice(failedAt + 1).every((limit) => limit <= 1600), client.requests.join(','));
});

test('without bounds the page size never changes', async () => {
  const clock = { t: 0 };
  const client = busyClient({ total: 1000, clock });
  await drain({ pageSize: 200 }, client, clock);
  assert.ok(client.requests.every((limit) => limit === 200));
});
