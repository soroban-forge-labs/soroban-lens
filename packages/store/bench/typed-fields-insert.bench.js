#!/usr/bin/env node
/**
 * Compare the event insert path with typed-field indexing enabled and disabled.
 * The spec is stored before timing so only per-event indexing work is measured.
 *
 *   node packages/store/bench/typed-fields-insert.bench.js
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { SqliteEventStore } from '../dist/index.js';

const ROW_COUNT = 1_000;
const TRIALS = 3;
const SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const fixture = JSON.parse(await readFile(new URL('../../../fixtures/testnet-events.json', import.meta.url), 'utf8'));
const specsFixture = JSON.parse(await readFile(new URL('../../../fixtures/testnet-specs.json', import.meta.url), 'utf8'));
const samples = fixture.events.filter((event) => event.contractId === SAC);
const spec = specsFixture.specs.find((record) => record.contractId === SAC);

if (samples.length === 0 || !spec) throw new Error('the benchmark fixtures need SAC events and their spec');

const events = Array.from({ length: ROW_COUNT }, (_, i) => ({
  ...samples[i % samples.length],
  id: `${String(4695317 + Math.floor(i / 10)).padStart(19, '0')}-${String(i % 10).padStart(10, '0')}`,
}));

async function trial(typedFieldIndex) {
  const dir = await mkdtemp(join(tmpdir(), 'lens-typed-fields-bench-'));
  const store = new SqliteEventStore({
    path: join(dir, 'bench.db'),
    typedFieldIndex,
    checkpointIntervalMs: 0,
  });
  try {
    await store.saveContractSpec(spec);
    const started = performance.now();
    const inserted = await store.insertEvents(events);
    const elapsed = performance.now() - started;
    if (inserted !== ROW_COUNT) throw new Error(`expected ${ROW_COUNT} inserts, received ${inserted}`);
    return elapsed;
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function median(values) {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
}

async function main() {
  const durations = { disabled: [], enabled: [] };
  for (let i = 0; i < TRIALS; i++) {
    durations.disabled.push(await trial(false));
    durations.enabled.push(await trial(true));
  }
  const disabled = median(durations.disabled);
  const enabled = median(durations.enabled);
  console.log(`Inserted ${ROW_COUNT.toLocaleString()} fixture-backed events per trial (${TRIALS} trials).`);
  console.log(`Typed field index disabled: ${disabled.toFixed(0)}ms (${(ROW_COUNT / disabled * 1000).toFixed(0)} rows/sec)`);
  console.log(`Typed field index enabled:  ${enabled.toFixed(0)}ms (${(ROW_COUNT / enabled * 1000).toFixed(0)} rows/sec)`);
  console.log(`Median insert-path overhead: ${((enabled / disabled - 1) * 100).toFixed(1)}%`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
