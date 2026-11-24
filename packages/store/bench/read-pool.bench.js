#!/usr/bin/env node
/**
 * Benchmark for #159: does moving reads to a worker pool actually stop a slow
 * query delaying everything else?
 *
 * Not part of `npm test` — inserts a hundred thousand rows and spends tens of
 * seconds measuring. Run it directly:
 *
 *   node packages/store/bench/read-pool.bench.js
 *
 * What it measures, and why that shape: the complaint in #159 is not that a
 * full-text search is slow. It is that while one runs, `node:sqlite` being
 * synchronous means every *other* request waits — so the number that matters is
 * the latency of cheap requests arriving *during* an expensive one.
 *
 * Both phases run against the same database file, and cheap requests are
 * dispatched against a fixed schedule rather than in a tight loop, because a
 * client's clock does not stop when the server is blocked. Latency is measured
 * from the moment a request *should* have been served, which is what a caller
 * experiences; measuring from dispatch would hide the entire stall, since on a
 * blocked thread a request cannot even be dispatched on time.
 *
 * An isolated phase runs first, with nothing competing, to separate the cost of
 * pooling a call from the benefit of not blocking on one.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { xdr } from '@stellar/stellar-sdk';
import { SqliteEventStore, PooledSqliteEventStore } from '../dist/index.js';

const ROW_COUNT = 100_000;
/** Matches every row, so the search has to gather them all: the slow case. */
const COMMON_TERM = 'transfer';
/** How long each loaded phase measures for. */
const WINDOW_MS = 6000;
/** One cheap request every this many ms, on a fixed schedule. */
const CHEAP_EVERY_MS = 20;
const POOL_SIZE = 2;

/** An indexed point lookup, set in main() once the table exists. */
let cheapId = '';

function xdrOf(scv) {
  return scv.toXDR('base64');
}

function synthetic(i) {
  return {
    id: `bench-${String(i).padStart(9, '0')}`,
    type: 'contract',
    ledger: 1_000_000 + i,
    ledgerClosedAt: new Date(1_700_000_000_000 + i * 5000).toISOString(),
    contractId: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
    topic: [xdrOf(xdr.ScVal.scvSymbol(COMMON_TERM))],
    value: xdrOf(xdr.ScVal.scvU32(100)),
    txHash: 'a'.repeat(64),
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
  };
}

const median = (samples) => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)];

function percentile(samples, p) {
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

/** The same two reads with nothing else happening. */
async function solo(store, label) {
  const search = [];
  const point = [];
  for (let i = 0; i < 6; i++) {
    let t = performance.now();
    await store.queryEvents({ search: COMMON_TERM, limit: 50 });
    search.push(performance.now() - t);
    t = performance.now();
    await store.getEvent(cheapId);
    point.push(performance.now() - t);
  }
  const result = { search: median(search), getEvent: median(point) };
  console.log(
    `    ${label.padEnd(10)} search ${result.search.toFixed(1)}ms    getEvent ${result.getEvent.toFixed(3)}ms`,
  );
  return result;
}

/**
 * Keep an expensive read running while cheap reads arrive on a schedule.
 *
 * Requests that came due while the thread was blocked are all dispatched when
 * it frees up, each still carrying its own intended arrival time — the same
 * backlog an HTTP server would have accepted and not yet answered.
 */
async function phase(label, store) {
  const latencies = [];
  const latestIdLatencies = [];
  const pending = [];
  let expensiveRuns = 0;
  let stop = false;

  let worstLag = 0;
  let lastTick = performance.now();
  const lagTimer = setInterval(() => {
    const now = performance.now();
    worstLag = Math.max(worstLag, now - lastTick - 5);
    lastTick = now;
  }, 5);

  const expensive = (async () => {
    while (!stop) {
      await store.queryEvents({ search: COMMON_TERM, limit: 50 });
      expensiveRuns++;
      // Yield to the macrotask queue, not just the microtask queue. On the
      // unpooled store `queryEvents` resolves synchronously, so `await` alone
      // continues in a microtask and this loop never lets the event loop reach
      // its timer phase — `stop` would never be set and it would spin until V8
      // gave out. Starving the loop is the behaviour under measurement; it must
      // not also be how the harness drives it.
      await new Promise((resolve) => setImmediate(resolve));
    }
  })();

  const start = performance.now();
  const maxDispatch = Math.ceil(WINDOW_MS / CHEAP_EVERY_MS) + 1;
  let dispatched = 0;
  while (performance.now() - start < WINDOW_MS) {
    const elapsed = performance.now() - start;
    while (dispatched * CHEAP_EVERY_MS <= elapsed && dispatched < maxDispatch) {
      const intendedAt = start + dispatched * CHEAP_EVERY_MS;
      dispatched++;
      pending.push(
        store.getEvent(cheapId).then(() => {
          latencies.push(performance.now() - intendedAt);
        }),
      );
      pending.push(
        store.getLatestEventId().then(() => {
          latestIdLatencies.push(performance.now() - intendedAt);
        }),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  stop = true;
  await expensive;
  await Promise.all(pending);
  clearInterval(lagTimer);

  console.log();
  console.log(`  ${label}`);
  console.log(`    expensive searches completed:   ${expensiveRuns}`);
  console.log(`    cheap requests:                 ${latencies.length}`);
  console.log(
    `    getEvent p50/p95/p99:           ${percentile(latencies, 50).toFixed(1)} / ` +
      `${percentile(latencies, 95).toFixed(1)} / ${percentile(latencies, 99).toFixed(1)}ms`,
  );
  console.log(
    `    getLatestEventId p50/p95/p99:   ${percentile(latestIdLatencies, 50).toFixed(1)} / ` +
      `${percentile(latestIdLatencies, 95).toFixed(1)} / ${percentile(latestIdLatencies, 99).toFixed(1)}ms`,
  );
  console.log(`    worst event-loop lag:           ${worstLag.toFixed(1)}ms`);

  return { latencies, latestIdLatencies, worstLag, expensiveRuns };
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'lens-bench-'));
  const path = join(dir, 'lens.db');

  const writer = new SqliteEventStore({ path, checkpointIntervalMs: 0 });
  console.log(`Inserting ${ROW_COUNT.toLocaleString()} synthetic rows...`);
  const rows = new Array(ROW_COUNT);
  for (let i = 0; i < ROW_COUNT; i++) rows[i] = synthetic(i);
  let t0 = performance.now();
  await writer.insertEvents(rows);
  console.log(`  insert: ${(performance.now() - t0).toFixed(0)}ms`);
  const first = await writer.queryEvents({ limit: 1 });
  cheapId = first.events[0].id;
  console.log(`  rows in table: ${first.total.toLocaleString()}`);
  await writer.close();

  const plain = new SqliteEventStore({ path, readOnly: true });
  t0 = performance.now();
  const pool = await PooledSqliteEventStore.open({ path, readOnly: true, poolSize: POOL_SIZE });
  const openMs = performance.now() - t0;

  console.log();
  console.log('  ISOLATED — one caller, nothing competing');
  const soloPlain = await solo(plain, 'unpooled');
  const soloPool = await solo(pool, 'pooled');

  const before = await phase('BEFORE — every read on the calling thread', plain);
  await plain.close();
  const after = await phase(`AFTER — reads on ${POOL_SIZE} worker threads`, pool);
  await pool.close();

  const ratio = (a, b) => (b === 0 ? Infinity : a / b);
  console.log();
  console.log('--- Summary ---');
  console.log(`Rows:                             ${ROW_COUNT.toLocaleString()}`);
  console.log(`Pool size:                        ${POOL_SIZE} (open: ${openMs.toFixed(0)}ms)`);
  console.log(
    `getEvent p99 under load:          ${percentile(before.latencies, 99).toFixed(1)}ms -> ` +
      `${percentile(after.latencies, 99).toFixed(1)}ms ` +
      `(${ratio(percentile(before.latencies, 99), percentile(after.latencies, 99)).toFixed(0)}x better)`,
  );
  console.log(
    `getEvent p50 under load:          ${percentile(before.latencies, 50).toFixed(1)}ms -> ` +
      `${percentile(after.latencies, 50).toFixed(1)}ms`,
  );
  console.log(
    `getLatestEventId p99 under load:  ${percentile(before.latestIdLatencies, 99).toFixed(1)}ms -> ` +
      `${percentile(after.latestIdLatencies, 99).toFixed(1)}ms`,
  );
  console.log(
    `Worst event-loop lag:             ${before.worstLag.toFixed(1)}ms -> ${after.worstLag.toFixed(1)}ms`,
  );
  console.log(
    `Isolated search, no load:         ${soloPlain.search.toFixed(1)}ms -> ${soloPool.search.toFixed(1)}ms`,
  );
  console.log(
    `Isolated getEvent, no load:       ${soloPlain.getEvent.toFixed(3)}ms -> ${soloPool.getEvent.toFixed(3)}ms ` +
      `(+${(soloPool.getEvent - soloPlain.getEvent).toFixed(2)}ms per call)`,
  );
  console.log(`Expensive searches completed:     ${before.expensiveRuns} -> ${after.expensiveRuns}`);

  console.log();
  console.log(
    'The win is in who waits. On the calling thread a point lookup inherits the whole duration of',
    'whatever search is in flight, because a synchronous query cannot be interrupted; on a pool it is',
    'served by a worker that is not busy. The isolated numbers show the pool is not achieving that by',
    'making anything faster: the same search costs about the same either way, and a point lookup costs',
    'slightly more pooled, which is the message round trip. That is also why getLatestEventId stays on',
    'the calling thread — the round trip would cost more than the query it carries.',
  );
  console.log();
  console.log(
    'Two honest caveats. Opening the pool is not free (reported above, almost entirely the Stellar SDK',
    'loading in each worker rather than thread creation). And read the completed-search count as noise',
    'unless it moves by a lot: across runs of this very benchmark it has landed both above and well',
    'below the unpooled count for the same configuration, because the loop driving those searches is',
    'competing with every other reply the pool delivers. Expensive throughput is roughly unchanged;',
    'the p99 above is the number this change is about. The pool bounds how much one slow query can',
    'hurt everything else; it does not make the store unboundedly concurrent, and with every worker',
    'busy further reads queue.',
  );

  await rm(dir, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
