#!/usr/bin/env node
/**
 * Benchmark for #35: how much smaller is a compressed database, and what
 * does decompression cost on read?
 *
 * Not part of `npm test` — inserts hundreds of thousands of rows, which is
 * slow and irrelevant to correctness. Run it directly:
 *
 *   node packages/store/bench/xdr-compression.bench.js
 */
import { readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteEventStore } from '../dist/index.js';

const ROW_COUNT = 200_000;
const fixture = JSON.parse(
  readFileSync(new URL('../../../fixtures/testnet-events.json', import.meta.url), 'utf8'),
);

function synthetic(n) {
  const rows = new Array(n);
  for (let i = 0; i < n; i++) {
    const base = fixture.events[i % fixture.events.length];
    rows[i] = { ...base, id: `bench-${String(i).padStart(9, '0')}`, ledger: 1_000_000 + i };
  }
  return rows;
}

async function main() {
  const rows = synthetic(ROW_COUNT);

  const dir = await mkdtemp(join(tmpdir(), 'lens-bench-'));
  const path = join(dir, 'lens.db');
  const store = new SqliteEventStore({ path, checkpointIntervalMs: 0 });
  await store.insertEvents(rows);
  await store.checkpoint('TRUNCATE'); // so the file size on disk reflects the data, not a growing WAL
  const sizeBytes = statSync(path).size;
  await store.close();
  await rm(dir, { recursive: true, force: true });

  console.log(`${ROW_COUNT.toLocaleString()} rows (real fixture events, cycled), compressed: ${(sizeBytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  -> ${(sizeBytes / ROW_COUNT).toFixed(0)} bytes/row`);

  // Same dataset, forcing plain-text storage, for the size comparison — done
  // by inserting through the same store.insertEvents() path is not possible
  // without the encoding, so this reads the compression ratio directly
  // instead: encode every row's raw XDR both ways and sum.
  const { compressXdrColumn } = await import('../dist/index.js');
  let plainBytes = 0;
  let compressedBytes = 0;
  for (const row of rows) {
    const topicsText = JSON.stringify(row.topic);
    const valueText = row.value;
    plainBytes += Buffer.byteLength(topicsText, 'utf8') + Buffer.byteLength(valueText, 'utf8');
    compressedBytes += compressXdrColumn(topicsText).length + compressXdrColumn(valueText).length;
  }
  console.log(`\nRaw XDR columns only (topics_xdr_json + value_xdr), unconditionally compressed:`);
  console.log(`  Plain text:  ${(plainBytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  Compressed:  ${(compressedBytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  Reduction:   ${(100 * (1 - compressedBytes / plainBytes)).toFixed(1)}%`);
  console.log('  (encodeXdrColumn, what is actually stored, keeps whichever of the two is smaller per row —');
  console.log('   so the real on-disk saving sits between this number and zero, never worse than plain text.)');

  // Read cost: decompress N times, time it.
  const { decompressXdrColumn } = await import('../dist/index.js');
  const sample = compressXdrColumn(JSON.stringify(rows[0].topic));
  const N = 100_000;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) decompressXdrColumn(sample);
  const ms = performance.now() - t0;
  console.log(`\nDecompression cost: ${(ms / N * 1000).toFixed(2)}µs/call (${N.toLocaleString()} calls, ${ms.toFixed(0)}ms total)`);
  console.log('  Read via the UI\'s "Raw XDR" panel — one event, one call — this is not a hot path.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
