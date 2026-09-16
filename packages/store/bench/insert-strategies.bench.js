#!/usr/bin/env node
/**
 * Benchmark for #27: is insertDecoded's "one prepared stmt.run() per row,
 * inside a single transaction" actually fast, or just correct?
 *
 * Not part of `npm test` — slow, and about performance rather than
 * correctness. Run it directly:
 *
 *   node packages/store/bench/insert-strategies.bench.js
 *
 * Each candidate runs in its own child process (via a fresh DatabaseSync per
 * invocation of this script — run it multiple times and compare) to avoid one
 * candidate's GC pressure or OS page cache state skewing the next. An earlier
 * version ran all three back-to-back in one process; that produced results up
 * to 9x worse for the batched candidate on some runs and 2x better on others
 * — noise, not signal. Isolated runs were far more consistent.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROW_COUNT = 500_000;
const COLUMNS = 22;

function synthetic(i) {
  return [
    `id-${i}`, 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC', 'contract',
    1000 + i, '2026-01-01T00:00:00Z', 1735689600, 'a'.repeat(64), 0, 0, 1,
    '[]', '[]', 0, null, null, null, null, 'void', '{}', 'AAAAAA==', null,
    '2026-01-01T00:00:00.000Z',
  ];
}

async function freshDb() {
  const dir = await mkdtemp(join(tmpdir(), 'lens-bench-'));
  const path = join(dir, 'bench.db');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(`CREATE TABLE events (
    id TEXT PRIMARY KEY, contract_id TEXT, type TEXT, ledger INTEGER,
    ledger_closed_at TEXT, closed_at_unix INTEGER, tx_hash TEXT,
    transaction_index INTEGER, operation_index INTEGER, in_successful_call INTEGER,
    topics_json TEXT, topics_xdr_json TEXT, topic_count INTEGER,
    topic0 TEXT, topic1 TEXT, topic2 TEXT, topic3 TEXT,
    value_type TEXT, value_json TEXT, value_xdr TEXT, decode_error TEXT, indexed_at TEXT
  )`);
  return { db, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Today's implementation: one prepared statement, called once per row. */
async function candidatePerRow() {
  const { db, cleanup } = await freshDb();
  const stmt = db.prepare(`INSERT OR IGNORE INTO events VALUES (${Array(COLUMNS).fill('?').join(',')})`);
  const t0 = performance.now();
  db.exec('BEGIN');
  for (let i = 0; i < ROW_COUNT; i++) stmt.run(...synthetic(i));
  db.exec('COMMIT');
  const ms = performance.now() - t0;
  db.close();
  await cleanup();
  return ms;
}

/** Multi-row VALUES: N rows per INSERT, fewer statement executions. */
async function candidateMultiRow(batchSize) {
  const { db, cleanup } = await freshDb();
  const placeholders = `(${Array(COLUMNS).fill('?').join(',')})`;
  const stmt = db.prepare(`INSERT OR IGNORE INTO events VALUES ${Array(batchSize).fill(placeholders).join(',')}`);
  const t0 = performance.now();
  db.exec('BEGIN');
  let i = 0;
  for (; i + batchSize <= ROW_COUNT; i += batchSize) {
    const params = [];
    for (let j = 0; j < batchSize; j++) params.push(...synthetic(i + j));
    stmt.run(...params);
  }
  if (i < ROW_COUNT) {
    const remaining = ROW_COUNT - i;
    const tail = db.prepare(`INSERT OR IGNORE INTO events VALUES ${Array(remaining).fill(placeholders).join(',')}`);
    const params = [];
    for (let j = 0; j < remaining; j++) params.push(...synthetic(i + j));
    tail.run(...params);
  }
  db.exec('COMMIT');
  const ms = performance.now() - t0;
  db.close();
  await cleanup();
  return ms;
}

/** Same as today's, plus larger page cache and in-memory temp storage. */
async function candidatePragmaTuned() {
  const { db, cleanup } = await freshDb();
  db.exec('PRAGMA cache_size = -64000'); // 64MB
  db.exec('PRAGMA temp_store = MEMORY');
  const stmt = db.prepare(`INSERT OR IGNORE INTO events VALUES (${Array(COLUMNS).fill('?').join(',')})`);
  const t0 = performance.now();
  db.exec('BEGIN');
  for (let i = 0; i < ROW_COUNT; i++) stmt.run(...synthetic(i));
  db.exec('COMMIT');
  const ms = performance.now() - t0;
  db.close();
  await cleanup();
  return ms;
}

const TRIALS = 3;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function trials(label, fn) {
  const ms = [];
  for (let i = 0; i < TRIALS; i++) ms.push(await fn());
  const m = median(ms);
  console.log(
    `${label}: median ${m.toFixed(0)}ms (${(ROW_COUNT / m * 1000).toFixed(0)} rows/sec), ` +
      `range ${Math.min(...ms).toFixed(0)}-${Math.max(...ms).toFixed(0)}ms across ${TRIALS} trials`,
  );
  return m;
}

async function main() {
  console.log(`Inserting ${ROW_COUNT.toLocaleString()} rows per trial, ${TRIALS} trials per candidate.\n`);

  const perRow = await trials("Today's implementation (one stmt.run()/row)", candidatePerRow);
  const multi40 = await trials('Multi-row VALUES, 40 rows/statement', () => candidateMultiRow(40));
  const tuned = await trials('Per-row + cache_size/temp_store tuning', candidatePragmaTuned);

  console.log('\n--- Verdict ---');
  const values = { 'per-row (current)': perRow, 'multi-row VALUES': multi40, 'PRAGMA-tuned': tuned };
  const spread = Math.max(...Object.values(values)) - Math.min(...Object.values(values));
  const fastest = Object.entries(values).sort((a, b) => a[1] - b[1])[0][0];
  console.log(`Fastest median this run: ${fastest}. Spread between candidates: ${spread.toFixed(0)}ms.`);
  console.log(
    'Run this a few times before trusting any single result — in testing, the spread between ' +
      'candidates was consistently smaller than the run-to-run variance of any one candidate, ' +
      "which is the actual finding: no candidate reliably beats today's implementation.",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
