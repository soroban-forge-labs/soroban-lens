import test from 'node:test';
import assert from 'node:assert/strict';
import { EventPoller, MemoryCursorStore, diffLedgerWindow, describeReorg, isEmptyDiff } from '../dist/index.js';

// #3 ledger reorgs. A scripted fake RPC serves a chain the test can rewrite,
// and a Map-backed store stands in for Module 2.

const SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

const ev = (ledger, n, value = 'AAAACgAAAAAAAAAAAAAAAAAAAGQ=') => ({
  id: `${String(ledger).padStart(19, '0')}-${String(n).padStart(10, '0')}`,
  type: 'contract',
  ledger,
  ledgerClosedAt: '2026-09-15T19:22:52Z',
  contractId: SAC,
  topic: ['AAAADwAAAAh0cmFuc2Zlcg=='],
  value,
  txHash: 'c7e2ba28f4f4e4ac3fcd7ef0a98d558f7019f4df6b4c5ef3941ca539468a31b5',
  transactionIndex: 0,
  operationIndex: 0,
  inSuccessfulContractCall: true,
});

/** A node whose history is `chain`, which the test may rewrite between polls. */
function chainClient(chain) {
  const client = {
    rpcUrl: 'https://soroban-testnet.stellar.org',
    chain,
    async retention() {
      return { latestLedger: this.tip(), oldestLedger: 1 };
    },
    tip() {
      return Math.max(1, ...this.chain.map((e) => e.ledger));
    },
    async getEvents({ startLedger, cursor, limit }) {
      const sorted = [...this.chain].sort((a, b) => (a.id < b.id ? -1 : 1));
      const from = cursor ? sorted.filter((e) => e.id > cursor) : sorted.filter((e) => e.ledger >= startLedger);
      const events = from.slice(0, limit);
      return {
        events,
        cursor: events.at(-1)?.id ?? cursor ?? `${String(startLedger).padStart(19, '0')}-0000000000`,
        latestLedger: this.tip(),
        oldestLedger: 1,
      };
    },
  };
  return client;
}

/** Module 2 as a Map: what the indexer stored, and how it repairs. */
function mapStore() {
  const rows = new Map();
  const toRef = (e) => ({
    id: e.id, ledger: e.ledger, txHash: e.txHash, inSuccessfulContractCall: e.inSuccessfulContractCall,
    topicsXdr: e.topic, valueXdr: e.value,
  });
  return {
    rows,
    insert(events) { for (const e of events) if (!rows.has(e.id)) rows.set(e.id, e); },
    async eventsInLedgers(from, to) {
      return [...rows.values()].filter((e) => e.ledger >= from && e.ledger <= to).map(toRef);
    },
    async applyReorg(diff) {
      for (const id of [...diff.removed, ...diff.changed.map((e) => e.id)]) rows.delete(id);
      this.insert([...diff.added, ...diff.changed]);
    },
  };
}

/**
 * Run a poller over `client` into `store`, calling `between(cycle)` at each
 * idle sleep so the test can rewrite history, and stopping after `cycles`.
 */
async function run(client, store, { cycles, between, depth = 3, log = [] }) {
  const abort = new AbortController();
  let cycle = 0;
  const poller = new EventPoller(
    { contractIds: [SAC], pageSize: 2, reorgDepth: depth },
    {
      client,
      reorgStore: store,
      cursors: new MemoryCursorStore(),
      signal: abort.signal,
      log: (m) => log.push(m),
      sleep: async () => {
        cycle++;
        between?.(cycle);
        if (cycle >= cycles) abort.abort();
      },
    },
  );
  for await (const batch of poller.stream()) store.insert(batch.events);
  return log;
}

test('done when: stored rows converge on rewritten history, with the change logged loudly', async () => {
  const original = [ev(10, 0), ev(11, 0), ev(12, 0), ev(12, 1), ev(13, 0)];
  const client = chainClient([...original]);
  const store = mapStore();

  const log = await run(client, store, {
    cycles: 4,
    between: (cycle) => {
      if (cycle !== 1) return;
      // A reorg of the newest two ledgers: 12/1 vanished, 13/0's value changed,
      // 12/2 appeared, and the chain moved on to ledger 14.
      client.chain = [ev(10, 0), ev(11, 0), ev(12, 0), ev(12, 2), ev(13, 0, 'AAAAAQ=='), ev(14, 0)];
    },
  });

  const stored = [...store.rows.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  const truth = [...client.chain].sort((a, b) => (a.id < b.id ? -1 : 1));
  assert.deepEqual(stored, truth, 'the store matches the new history exactly');

  const reorgLines = log.filter((m) => m.startsWith('REORG:'));
  assert.equal(reorgLines.length, 1, log.join('\n'));
  assert.match(reorgLines[0], /1 removed \(0000000000000000012-0000000001\)/);
  assert.match(reorgLines[0], /1 changed \(0000000000000000013-0000000000\)/);
  assert.match(reorgLines[0], /1 added \(0000000000000000012-0000000002\)/);
});

test('history that does not change is never rewritten, and costs one check per new tip', async () => {
  const client = chainClient([ev(10, 0), ev(11, 0), ev(12, 0)]);
  const store = mapStore();
  let applied = 0;
  const apply = store.applyReorg.bind(store);
  store.applyReorg = async (d) => { applied++; return apply(d); };
  const requests = [];
  const getEvents = client.getEvents.bind(client);
  client.getEvents = async (args) => { requests.push(args); return getEvents(args); };

  const log = await run(client, store, { cycles: 5 });
  assert.equal(applied, 0);
  assert.ok(!log.some((m) => m.startsWith('REORG')));
  // The tip never moved, so exactly one window re-read, by startLedger.
  assert.equal(requests.filter((r) => r.startLedger === 10).length, 1);
});

test('reorgs deeper than the configured window are not chased', async () => {
  const client = chainClient([ev(1, 0), ev(10, 0), ev(11, 0)]);
  const store = mapStore();
  await run(client, store, {
    cycles: 3,
    depth: 2,
    between: (cycle) => {
      if (cycle === 1) client.chain = [ev(1, 5), ev(10, 0), ev(11, 0), ev(12, 0)];
    },
  });
  // Ledger 1 is outside the 2-ledger window: the old row stays.
  assert.ok(store.rows.has(ev(1, 0).id));
  assert.ok(store.rows.has(ev(12, 0).id));
});

test('depth 0 turns the check off', async () => {
  const client = chainClient([ev(10, 0)]);
  const store = mapStore();
  let read = 0;
  store.eventsInLedgers = async () => { read++; return []; };
  await run(client, store, { cycles: 3, depth: 0 });
  assert.equal(read, 0);
});

test('a failing check is logged and does not stop the stream', async () => {
  const client = chainClient([ev(10, 0), ev(11, 0)]);
  const store = mapStore();
  store.eventsInLedgers = async () => { throw new Error('database is locked'); };
  const log = await run(client, store, { cycles: 2 });
  assert.ok(log.some((m) => /reorg check for ledgers .* failed: database is locked/.test(m)));
  assert.equal(store.rows.size, 2);
});

// ── the pure diff ────────────────────────────────────────────────────────────

test('diffLedgerWindow separates removed, added and changed', () => {
  const ref = (e) => ({ id: e.id, ledger: e.ledger, txHash: e.txHash, inSuccessfulContractCall: true, topicsXdr: e.topic, valueXdr: e.value });
  const stored = [ev(5, 0), ev(5, 1), ev(6, 0)].map(ref);
  const truth = [ev(5, 0), ev(6, 0, 'AAAAAQ=='), ev(6, 1)];
  const diff = diffLedgerWindow({ fromLedger: 5, toLedger: 6 }, stored, truth);
  assert.deepEqual(diff.removed, [ev(5, 1).id]);
  assert.deepEqual(diff.changed.map((e) => e.id), [ev(6, 0).id]);
  assert.deepEqual(diff.added.map((e) => e.id), [ev(6, 1).id]);
  assert.equal(isEmptyDiff(diff), false);
  assert.match(describeReorg(diff), /^REORG: stored events for ledgers 5\.\.6/);
  assert.equal(isEmptyDiff(diffLedgerWindow({ fromLedger: 5, toLedger: 5 }, [ref(ev(5, 0))], [ev(5, 0)])), true);
});
