#!/usr/bin/env node
/**
 * Benchmark for #26: does caching the filtered COUNT(*) actually help, and by
 * how much?
 *
 * Not part of `npm test` — it inserts a million synthetic rows, which is slow
 * and irrelevant to correctness. Run it directly:
 *
 *   node packages/store/bench/count-cache.bench.js
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteEventStore } from '../dist/index.js';

const ROW_COUNT = 1_000_000;
const CONTRACT_A = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const CONTRACT_B = 'CA6F5E42TCRGPMDXU33WGMXAADPNEKOIZETAWSKYKAWNHESQQ2MTLSCC';

function synthetic(n) {
  const rows = new Array(n);
  for (let i = 0; i < n; i++) {
    rows[i] = {
      id: `bench-${String(i).padStart(9, '0')}`,
      type: 'contract',
      ledger: 1_000_000 + i,
      ledgerClosedAt: new Date(1_700_000_000_000 + i * 5000).toISOString(),
      contractId: i % 3 === 0 ? CONTRACT_A : CONTRACT_B,
      topic: ['AAAADwAAAAh0cmFuc2Zlcg=='],
      value: 'AAAACgAAAAAAAAAAAAAAAAAAAGQ=',
      txHash: 'a'.repeat(64),
      transactionIndex: 0,
      operationIndex: 0,
      inSuccessfulContractCall: true,
    };
  }
  return rows;
}

async function time(label, fn) {
  const t0 = performance.now();
  const result = await fn();
  const ms = performance.now() - t0;
  console.log(`${label}: ${ms.toFixed(1)}ms`);
  return { result, ms };
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'lens-bench-'));
  const path = join(dir, 'lens.db');

  console.log(`Inserting ${ROW_COUNT.toLocaleString()} synthetic rows...`);
  const insertStore = new SqliteEventStore({ path });
  await time('  insert', () => insertStore.insertEvents(synthetic(ROW_COUNT)));
  await insertStore.close();

  console.log('\nWithout caching (countCacheTtlMs: 0), a filtered COUNT(*) on every call:');
  const uncached = new SqliteEventStore({ path, countCacheTtlMs: 0 });
  const uncachedTimes = [];
  for (let i = 0; i < 20; i++) {
    const { ms } = await time(`  call ${i + 1}`, () =>
      uncached.queryEvents({ contractId: CONTRACT_A, limit: 50 }),
    );
    uncachedTimes.push(ms);
  }
  await uncached.close();

  console.log('\nWith the default cache (countCacheTtlMs: 2000):');
  const cached = new SqliteEventStore({ path, countCacheTtlMs: 2000 });
  const cachedTimes = [];
  for (let i = 0; i < 20; i++) {
    const { ms, result } = await time(`  call ${i + 1}`, () =>
      cached.queryEvents({ contractId: CONTRACT_A, limit: 50 }),
    );
    cachedTimes.push(ms);
    if (i === 1) console.log(`    (totalIsEstimate on call 2: ${result.totalIsEstimate === true})`);
  }
  await cached.close();

  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const uncachedAvg = avg(uncachedTimes);
  const cachedAvgAfterFirst = avg(cachedTimes.slice(1)); // exclude the cold first call
  console.log('\n--- Summary ---');
  console.log(`Rows:                       ${ROW_COUNT.toLocaleString()}`);
  console.log(`Uncached average:           ${uncachedAvg.toFixed(2)}ms/call`);
  console.log(`Cached average (warm):      ${cachedAvgAfterFirst.toFixed(2)}ms/call`);
  console.log(`Speedup on cache hits:      ${(uncachedAvg / cachedAvgAfterFirst).toFixed(0)}x`);

  await rm(dir, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
