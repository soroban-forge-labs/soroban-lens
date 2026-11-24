/**
 * Tests for PooledSqliteEventStore (#159).
 *
 * The conformance suite already proves the pooled store honours the
 * `EventStore` contract — see conformance.test.js, which runs the same 35 tests
 * against it. What is left, and what lives here, is the behaviour that is the
 * reason the class exists: that a slow read no longer occupies the thread the
 * caller is on, plus the pool's own lifecycle and error plumbing.
 *
 * Offline, like every other suite: a synthetic table, no network.
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteEventStore, PooledSqliteEventStore } from '../dist/index.js';

const fixture = JSON.parse(
  readFileSync(new URL('../../../fixtures/testnet-events.json', import.meta.url), 'utf8'),
);

/**
 * Rows enough to make a read cost tens of milliseconds, which is all the
 * blocking-vs-not comparison needs. 4 000 inserts in about a second; the real
 * numbers come from bench/read-pool.bench.js at a realistic size.
 */
const ROW_COUNT = 4000;

/**
 * A decoded event, built directly rather than decoded from XDR.
 *
 * `insertDecoded` stores `topicsXdr`/`valueXdr` verbatim and `extractAddresses`
 * returns nothing for XDR it cannot parse, so a placeholder is enough to
 * exercise every read path except address lookup.
 */
function synthetic(i) {
  return {
    id: `000000000${String(i).padStart(10, '0')}-0000000001`,
    contractId: `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGC${String(i % 10)}SC`,
    type: 'contract',
    ledger: 1000 + i,
    ledgerClosedAt: '2026-01-01T00:00:00Z',
    txHash: 'a'.repeat(64),
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    topics: [
      { type: 'symbol', value: i % 7 === 0 ? 'transfer' : 'mint' },
      { type: 'string', value: `needle-${i}` },
    ],
    topicsXdr: ['AAAAAA==', 'AAAAAA=='],
    value: { type: 'u32', value: i },
    valueXdr: 'AAAAAA==',
    indexedAt: '2026-01-01T00:00:00.000Z',
  };
}

async function tempDbPath() {
  const dir = await mkdtemp(join(tmpdir(), 'pooled-store-'));
  return { path: join(dir, 'lens.db'), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** A migrated database holding ROW_COUNT synthetic events. */
async function seededDb() {
  const { path, cleanup } = await tempDbPath();
  const writer = new SqliteEventStore({ path });
  const batch = [];
  for (let i = 0; i < ROW_COUNT; i++) batch.push(synthetic(i));
  for (let i = 0; i < batch.length; i += 1000) await writer.insertDecoded(batch.slice(i, i + 1000));
  await writer.close();
  return { path, cleanup };
}

/**
 * The longest a timer scheduled every `everyMs` was late, over a fixed window
 * that begins as `startWork()` is called.
 *
 * This is the measurement the whole issue turns on. A synchronous SQLite call
 * on this thread cannot be interrupted, so every timer due during it fires late
 * by however long the query took; a query on a worker thread leaves the timers
 * alone. Lateness, not query duration, is what the API's other requests feel.
 *
 * The work is deliberately *not* awaited before the window closes. An unpooled
 * read resolves its promise synchronously, so awaiting it would continue in a
 * microtask and clear the timer before the loop ever reached its timer phase —
 * reporting a perfect zero for the very stall being measured.
 */
async function maxEventLoopLag(startWork, windowMs = 400, everyMs = 5) {
  let worst = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last - everyMs);
    last = now;
  }, everyMs);

  const work = startWork();
  await new Promise((resolve) => setTimeout(resolve, windowMs));
  clearInterval(timer);
  await work;
  return worst;
}

test('[pool] reads return exactly what the unpooled store returns', async () => {
  const { path, cleanup } = await tempDbPath();
  const plain = new SqliteEventStore({ path });
  await plain.insertEvents(fixture.events);

  const pool = await PooledSqliteEventStore.open({ path, poolSize: 2 });
  try {
    const [plainPage, poolPage] = await Promise.all([
      plain.queryEvents({ limit: 25 }),
      pool.queryEvents({ limit: 25 }),
    ]);
    assert.deepEqual(poolPage, plainPage);

    const id = plainPage.events[0].id;
    assert.deepEqual(await pool.getEvent(id), await plain.getEvent(id));
    assert.deepEqual(await pool.listContracts(), await plain.listContracts());
    assert.deepEqual(await pool.countByTopic(), await plain.countByTopic());
    assert.deepEqual(await pool.getStats(), await plain.getStats());
    assert.deepEqual(await pool.healthCheck(), await plain.healthCheck());
    assert.equal(await pool.getLatestEventId(), await plain.getLatestEventId());
  } finally {
    await pool.close();
    await plain.close();
    await cleanup();
  }
});

test('[pool] an expensive read does not block the calling thread', async () => {
  const { path, cleanup } = await seededDb();

  // Enough concurrent calls that the unpooled store's blocking is unmistakable
  // rather than a few milliseconds that a GC pause could explain.
  const CALLS = 24;
  const hammer = (store) => () => Promise.all(Array.from({ length: CALLS }, () => store.checkIntegrity()));

  const plain = new SqliteEventStore({ path, readOnly: true });
  const plainLag = await maxEventLoopLag(hammer(plain));
  await plain.close();

  const pool = await PooledSqliteEventStore.open({ path, readOnly: true, poolSize: 2 });
  const poolLag = await maxEventLoopLag(hammer(pool));
  await pool.close();
  await cleanup();

  // The unpooled store runs all CALLS reads on this thread, so the loop is
  // stalled for their combined duration. Asserted loosely: the point is the
  // order of magnitude, not a number that would turn CI red on a slow runner.
  assert.ok(plainLag > 50, `expected the unpooled store to stall the loop, saw ${plainLag.toFixed(1)}ms`);
  assert.ok(
    poolLag < plainLag / 3,
    `expected pooled lag well under unpooled: pooled ${poolLag.toFixed(1)}ms vs plain ${plainLag.toFixed(1)}ms`,
  );
});

test('[pool] a cheap read overtakes a slow one already running', async () => {
  const { path, cleanup } = await seededDb();
  const pool = await PooledSqliteEventStore.open({ path, readOnly: true, poolSize: 2 });
  try {
    // One worker takes the expensive read; the other must still be free. This
    // is the store-level form of "a slow search no longer delays /health".
    let slowDone = false;
    const slow = Promise.all(
      Array.from({ length: 8 }, () => pool.checkIntegrity()),
    ).then(() => {
      slowDone = true;
    });

    const cheap = await pool.getStats();
    assert.ok(cheap.eventCount >= ROW_COUNT);
    assert.equal(slowDone, false, 'the cheap read should have come back before the slow batch finished');

    await slow;
  } finally {
    await pool.close();
    await cleanup();
  }
});

test('[pool] an error from a worker keeps its message and name', async () => {
  const { path, cleanup } = await seededDb();
  // forceDisableFts5 has to reach the workers, or the "no FTS5" path stops
  // being reachable through the pool at all (#32).
  const pool = await PooledSqliteEventStore.open({ path, poolSize: 1, forceDisableFts5: true });
  try {
    await assert.rejects(
      () => pool.queryEvents({ search: 'needle' }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /search requires the FTS5 SQLite extension/);
        return true;
      },
    );
  } finally {
    await pool.close();
    await cleanup();
  }
});

test('[pool] writes go to the writer and are visible to pooled reads', async () => {
  const { path, cleanup } = await tempDbPath();
  const pool = await PooledSqliteEventStore.open({ path, poolSize: 2 });
  try {
    const inserted = await pool.insertEvents(fixture.events);
    assert.ok(inserted > 0);

    // The workers opened their connections before these rows existed. WAL is
    // what makes them visible without reopening anything.
    const page = await pool.queryEvents({ limit: 1000 });
    assert.equal(page.total, inserted);

    // A write-shaped method that looks like a read still has to reach the
    // writer: a read-only connection cannot checkpoint.
    await pool.checkpoint('TRUNCATE');

    const probe = await pool.writeProbe();
    assert.equal(probe.ok, true);
  } finally {
    await pool.close();
    await cleanup();
  }
});

test('[pool] a file path is required', async () => {
  await assert.rejects(
    () => PooledSqliteEventStore.open({ path: ':memory:' }),
    /needs a file path/,
    'each worker would otherwise open its own private, empty database',
  );
});

test('[pool] a database that cannot be opened fails open() rather than hanging', async () => {
  const { path, cleanup } = await tempDbPath();
  try {
    // readOnly means nothing is created, so this file does not exist. The test
    // passing at all is the point: a rejected open must not leave a thread
    // running, or node:test would never exit.
    await assert.rejects(() => PooledSqliteEventStore.open({ path, readOnly: true, poolSize: 2 }));
  } finally {
    await cleanup();
  }
});

test('[pool] poolSize must be a positive integer', async () => {
  const { path, cleanup } = await tempDbPath();
  try {
    await assert.rejects(() => PooledSqliteEventStore.open({ path, poolSize: 0 }), /positive integer/);
    await assert.rejects(() => PooledSqliteEventStore.open({ path, poolSize: 2.5 }), /positive integer/);
    await assert.rejects(() => PooledSqliteEventStore.open({ path, poolSize: -1 }), /positive integer/);
  } finally {
    await cleanup();
  }
});

test('[pool] close() shuts the workers down and refuses later reads', async () => {
  const { path, cleanup } = await tempDbPath();
  const plain = new SqliteEventStore({ path });
  await plain.insertEvents(fixture.events);
  await plain.close();

  const pool = await PooledSqliteEventStore.open({ path, readOnly: true, poolSize: 2 });
  assert.equal(pool.poolSize, 2);
  assert.ok(await pool.getLatestEventId());

  await pool.close();
  assert.equal(pool.poolSize, 0);
  await assert.rejects(() => pool.getStats(), /store is closed/);
  // Idempotent, like the unpooled store's.
  await pool.close();
  await cleanup();
});
