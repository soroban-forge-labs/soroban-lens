import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { EventPoller, MemoryCursorStore } from '@soroban-lens/ingest';
import { SqliteEventStore } from '@soroban-lens/store';
import { StoreBackedReorgs, resolveConfig } from '../dist/index.js';

// #3 end to end through Module 2: the poller, a real SQLite store behind
// StoreBackedReorgs, and a scripted node whose newest ledgers get rewritten.

const FIXTURE = fileURLToPath(new URL('../../../fixtures/testnet-events.json', import.meta.url));
const byId = (a, b) => (a.id < b.id ? -1 : 1);

function chainClient(chain) {
  return {
    rpcUrl: 'https://soroban-testnet.stellar.org',
    chain,
    tip() { return Math.max(...this.chain.map((e) => e.ledger)); },
    async retention() { return { latestLedger: this.tip(), oldestLedger: 1 }; },
    async getEvents({ startLedger, cursor, limit }) {
      const sorted = [...this.chain].sort(byId);
      const events = (cursor ? sorted.filter((e) => e.id > cursor) : sorted.filter((e) => e.ledger >= startLedger)).slice(0, limit);
      return { events, cursor: events.at(-1)?.id ?? cursor ?? 'start', latestLedger: this.tip(), oldestLedger: 1 };
    },
  };
}

test('done when: stored rows in SQLite converge on rewritten history', async () => {
  const events = JSON.parse(await readFile(FIXTURE, 'utf8')).events;
  const tip = Math.max(...events.map((e) => e.ledger));
  const newest = events.filter((e) => e.ledger === tip);
  assert.ok(newest.length >= 2, 'the fixture has several events in its newest ledger');

  const client = chainClient([...events]);
  const store = new SqliteEventStore({ path: ':memory:' });
  const contracts = [...new Set(events.map((e) => e.contractId))];

  // History after the reorg: the newest ledger lost one event, another came
  // back with a different value, and a new ledger followed.
  const [dropped, rewritten] = newest;
  const after = events
    .filter((e) => e.id !== dropped.id)
    .map((e) => (e.id === rewritten.id ? { ...e, value: dropped.value === e.value ? 'AAAAAQ==' : dropped.value } : e))
    .concat([{ ...newest[0], id: `${String(tip + 1).padStart(19, '0')}-0000000000`, ledger: tip + 1 }]);

  const abort = new AbortController();
  const log = [];
  let cycle = 0;
  const poller = new EventPoller(
    { contractIds: [], pageSize: 25, reorgDepth: 3 },
    {
      client,
      cursors: new MemoryCursorStore(),
      reorgStore: new StoreBackedReorgs(store, []),
      signal: abort.signal,
      log: (m) => log.push(m),
      sleep: async () => {
        if (++cycle === 1) client.chain = after;
        if (cycle >= 3) abort.abort();
      },
    },
  );
  for await (const batch of poller.stream()) await store.insertEvents(batch.events);

  const stored = (await store.queryEvents({ order: 'asc', limit: 1000 })).events;
  assert.deepEqual(stored.map((e) => e.id), after.map((e) => e.id).sort());
  assert.equal(stored.find((e) => e.id === rewritten.id).valueXdr, after.find((e) => e.id === rewritten.id).value);
  assert.ok(log.some((m) => m.startsWith('REORG:') && m.includes('1 removed') && m.includes('1 changed')), log.join('\n'));
  assert.ok(contracts.length > 1);
  await store.close();
});

test('the adapter only judges rows for this stream\'s contracts', async () => {
  const events = JSON.parse(await readFile(FIXTURE, 'utf8')).events;
  const store = new SqliteEventStore({ path: ':memory:' });
  await store.insertEvents(events);
  const sac = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
  const refs = await new StoreBackedReorgs(store, [sac]).eventsInLedgers(0, Number.MAX_SAFE_INTEGER);
  assert.ok(refs.length > 0);
  assert.equal(refs.length, events.filter((e) => e.contractId === sac).length);
  await store.close();
});

test('reorg depth and page-size bounds come from flags and environment', () => {
  assert.equal(resolveConfig({}, {}).reorgDepth, 3);
  assert.equal(resolveConfig({}, { LENS_REORG_DEPTH: '0' }).reorgDepth, 0);
  assert.equal(resolveConfig({}, {}).pageSizeBounds, undefined);
  assert.deepEqual(resolveConfig({}, { LENS_PAGE_SIZE_MAX: '10000' }).pageSizeBounds, { min: 200, max: 10000 });
  assert.deepEqual(resolveConfig({ pageSizeMin: 50 }, { LENS_PAGE_SIZE: '500' }).pageSizeBounds, { min: 50, max: 500 });
});
