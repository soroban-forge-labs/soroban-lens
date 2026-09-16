#!/usr/bin/env node
/**
 * Benchmark for #32: does GET /events?search= stay fast on a large table?
 *
 * Not part of `npm test` — inserts a million rows, which is slow and
 * irrelevant to correctness. Run it directly:
 *
 *   node packages/store/bench/fts-search.bench.js
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { xdr } from '@stellar/stellar-sdk';
import { SqliteEventStore } from '../dist/index.js';

const ROW_COUNT = 1_000_000;

function xdrOf(scv) {
  return scv.toXDR('base64');
}

/** Every row mentions a common word ("transfer") and 1-in-10000 a rare one. */
function synthetic(i) {
  const rare = i % 10_000 === 0;
  return {
    id: `bench-${String(i).padStart(9, '0')}`,
    type: 'contract',
    ledger: 1_000_000 + i,
    ledgerClosedAt: new Date(1_700_000_000_000 + i * 5000).toISOString(),
    contractId: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
    topic: [xdrOf(xdr.ScVal.scvSymbol(rare ? 'unobtainium_event' : 'transfer'))],
    value: xdrOf(xdr.ScVal.scvU32(100)),
    txHash: 'a'.repeat(64),
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
  };
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'lens-bench-'));
  const path = join(dir, 'lens.db');
  const store = new SqliteEventStore({ path, checkpointIntervalMs: 0 });

  console.log(`Inserting ${ROW_COUNT.toLocaleString()} synthetic rows...`);
  const rows = new Array(ROW_COUNT);
  for (let i = 0; i < ROW_COUNT; i++) rows[i] = synthetic(i);
  const t0 = performance.now();
  await store.insertEvents(rows);
  console.log(`  insert: ${(performance.now() - t0).toFixed(0)}ms`);

  const median = (arr) => [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)];

  const rareTimes = [];
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    const page = await store.queryEvents({ search: 'unobtainium', limit: 50 });
    rareTimes.push(performance.now() - t);
    if (i === 0) console.log(`  matches for a rare substring: ${page.total} (expected ${Math.floor(ROW_COUNT / 10_000)})`);
  }

  const commonTimes = [];
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    const page = await store.queryEvents({ search: 'transfer', limit: 50 });
    commonTimes.push(performance.now() - t);
    if (i === 0) console.log(`  matches for a common substring: ${page.total} (expected ${ROW_COUNT - Math.floor(ROW_COUNT / 10_000)})`);
  }

  console.log('\n--- Summary ---');
  console.log(`Rows:                                   ${ROW_COUNT.toLocaleString()}`);
  console.log(`Rare substring (0.01% of rows):          median ${median(rareTimes).toFixed(1)}ms`);
  console.log(`Common substring (~99.99% of rows):      median ${median(commonTimes).toFixed(1)}ms`);
  console.log(
    '\nSame shape as #23\'s address benchmark: the selective search resolves quickly because the',
    'trigram index drives straight to matching rows; the unselective one still has to gather every',
    'match before applying the page LIMIT, which is inherent to any index once a filter stops being',
    'selective, not specific to FTS5.',
  );

  await store.close();
  await rm(dir, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
