#!/usr/bin/env node
/**
 * Benchmark suite for #98.
 *
 *   npm run bench                         # 1,000,000 events, writes bench/results/latest.json
 *   npm run bench:quick                   # 50,000 events, a smoke run (not comparable to a full one)
 *   node bench/run.js --root ../other     # benchmark another checkout's built packages
 *
 * Measures insert throughput, query latency by filter, and API response times
 * against one deterministic generated dataset, and writes a JSON file that
 * bench/compare.js can diff against another run. See docs/benchmarks.md.
 *
 * Not part of `npm test`: it is slow and about performance, not correctness.
 */
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir, cpus, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { createDataset, RARE_SEARCH_TERM } from './lib/dataset.js';
import { sample, summarize } from './lib/stats.js';
import { get, startApi } from './lib/api.js';

const { values } = parseArgs({
  options: {
    root: { type: 'string', default: '.' },
    events: { type: 'string', default: process.env.LENS_BENCH_EVENTS ?? '1000000' },
    seed: { type: 'string', default: '1' },
    out: { type: 'string', default: 'bench/results/latest.json' },
    'skip-api': { type: 'boolean', default: false },
  },
});

const root = resolve(values.root);
const events = Number(values.events);
const seed = Number(values.seed);
const BATCH_SIZE = 5000;
const FAST = { warmup: 3, samples: 21 };
const SLOW = { warmup: 1, samples: 7 };

if (!Number.isInteger(events) || events < 1000) throw new Error('--events must be an integer >= 1000');
if (!Number.isInteger(seed)) throw new Error('--seed must be an integer');
if (events < 1_000_000) {
  console.error(`note: ${events.toLocaleString()} events is a smoke run; the suite's target is 1,000,000.`);
}

const metrics = {};
const round = (n) => Math.round(n * 1000) / 1000;

function recordLatency(name, timings) {
  const s = summarize(timings);
  metrics[name] = { value: round(s.p50), p95: round(s.p95), unit: 'ms', better: 'lower', samples: s.n };
}

function recordRate(name, perSecond, unit) {
  metrics[name] = { value: Math.round(perSecond), unit, better: 'higher' };
}

async function main() {
  const storeEntry = join(root, 'packages/store/dist/index.js');
  try {
    await access(storeEntry);
  } catch {
    throw new Error(`${storeEntry} does not exist. Build first: (cd ${root} && npm run build)`);
  }
  const { SqliteEventStore, extractAddresses } = await import(pathToFileURL(storeEntry).href);

  const dir = await mkdtemp(join(tmpdir(), 'lens-bench-'));
  const dbPath = join(dir, 'bench.db');

  try {
    // countCacheTtlMs: 0 so every sample pays for a real COUNT(*), not a cache hit.
    const store = new SqliteEventStore({ path: dbPath, checkpointIntervalMs: 0, countCacheTtlMs: 0 });
    const dataset = createDataset({ events, seed });

    // ---- insert throughput -------------------------------------------------
    console.error(`Inserting ${events.toLocaleString()} events in batches of ${BATCH_SIZE}...`);
    const batchMs = [];
    let totalMs = 0;
    let inserted = 0;
    for (const batch of dataset.batches(BATCH_SIZE)) {
      // Generation happens outside the timer; only decode + insert is measured.
      const start = performance.now();
      inserted += await store.insertEvents(batch);
      const elapsed = performance.now() - start;
      totalMs += elapsed;
      if (batch.length === BATCH_SIZE) batchMs.push(elapsed);
      if (inserted % 100_000 < BATCH_SIZE) console.error(`  ${inserted.toLocaleString()} / ${events.toLocaleString()}`);
    }
    await store.checkpoint('TRUNCATE');

    const stats = await store.getStats();
    if (stats.eventCount !== events || inserted !== events) {
      throw new Error(
        `expected ${events} events after seeding, store reports ${stats.eventCount} (inserted ${inserted}); the generator produced duplicate ids`,
      );
    }
    recordRate('insert.throughput_total', inserted / (totalMs / 1000), 'events/s');
    const medianBatch = summarize(batchMs).p50;
    recordRate('insert.throughput_batch_median', (BATCH_SIZE / medianBatch) * 1000, 'events/s');
    console.error(`  insert: ${Math.round(inserted / (totalMs / 1000)).toLocaleString()} events/s overall`);

    // ---- pick filters from what is actually in the store -------------------
    const { info } = dataset;
    const contracts = (await store.listContracts(1000)).sort((a, b) => a.eventCount - b.eventCount);
    const coldContract = contracts[0].contractId;
    const hotContract = contracts.at(-1).contractId;
    const topTopic = (await store.countByTopic(1))[0]?.topic;
    if (!topTopic) throw new Error('countByTopic returned nothing on a seeded store');
    const hotAddress = Array.from(extractAddresses(info.hotAccountXdr))[0];
    const coldAddress = Array.from(extractAddresses(info.coldAccountXdr))[0];
    if (!hotAddress || !coldAddress) throw new Error('could not extract benchmark addresses from the generated XDR');

    const fromLedger = Math.max(info.baseLedger, info.midLedger - 500);
    const toLedger = Math.min(info.lastLedger, info.midLedger + 500);
    const midTime = info.baseTime + (info.midLedger - info.baseLedger) * info.ledgerSeconds;
    const fromTime = midTime - 1800;
    const toTime = midTime + 1800;
    const wideFromTime = midTime - 3 * 3600;
    const wideToTime = midTime + 3 * 3600;

    // ---- query latency -----------------------------------------------------
    const rows = (page) => {
      if (page.events.length === 0) throw new Error('returned no rows: the filter or dataset is wrong');
    };
    const page = (query) => () => store.queryEvents(query);

    const cases = [
      ['latest_page', page({ limit: 50, skipTotal: true }), FAST, rows],
      ['latest_page_exact_count', page({ limit: 50 }), SLOW, rows],
      ['contract_hot', page({ contractId: hotContract, limit: 50, skipTotal: true }), FAST, rows],
      ['contract_hot_exact_count', page({ contractId: hotContract, limit: 50 }), SLOW, rows],
      ['contract_cold', page({ contractId: coldContract, limit: 50 }), FAST, rows],
      ['topic_prefix', page({ topics: [topTopic], limit: 50, skipTotal: true }), FAST, rows],
      ['topic_prefix_exact_count', page({ topics: [topTopic], limit: 50 }), SLOW, rows],
      ['address_hot', page({ address: hotAddress, limit: 50, skipTotal: true }), FAST, rows],
      ['address_cold', page({ address: coldAddress, limit: 50 }), FAST, rows],
      ['ledger_window', page({ fromLedger, toLedger, limit: 50 }), FAST, rows],
      ['time_window', page({ fromTime, toTime, limit: 50 }), FAST, rows],
      ['tx_hash', page({ txHash: info.midTxHash, limit: 50 }), FAST, rows],
      ['deep_cursor_page', page({ cursor: info.midId, limit: 50, skipTotal: true }), FAST, rows],
      [
        'get_event_by_id',
        () => store.getEvent(info.midId),
        FAST,
        (event) => {
          if (!event) throw new Error('returned null for an id that was inserted');
        },
      ],
      ['count_by_topic', () => store.countByTopic(10), SLOW, undefined],
      [
        'count_by_time_bucket_hour',
        () => store.countByTimeBucket({ fromTime: wideFromTime, toTime: wideToTime }, 'hour'),
        SLOW,
        undefined,
      ],
    ];

    // Full-text search needs FTS5, which not every SQLite build has; skip it
    // (rather than fail) so the rest of the suite still runs there.
    try {
      const probe = await store.queryEvents({ search: RARE_SEARCH_TERM, limit: 1 });
      if (probe.total > 0) {
        cases.push(['search_rare', page({ search: RARE_SEARCH_TERM, limit: 50 }), SLOW, rows]);
      } else {
        console.error('  skipping search_rare: no rare events in this dataset');
      }
    } catch (error) {
      console.error(`  skipping search_rare: ${error instanceof Error ? error.message.split('\n')[0] : error}`);
    }

    for (const [name, fn, opts, check] of cases) {
      const timings = await sample(fn, { ...opts, check });
      recordLatency(`query.${name}`, timings);
      console.error(`  query.${name}: p50 ${metrics[`query.${name}`].value}ms`);
    }

    const scanDb = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const contractLimit = Math.min(100, contracts.length);
      const aggregate = scanDb.prepare(
        `SELECT contract_id, COUNT(*) AS event_count, MIN(ledger) AS first_ledger,
                MAX(ledger) AS last_ledger, MAX(ledger_closed_at) AS last_seen_at
         FROM events
         GROUP BY contract_id
         ORDER BY last_ledger DESC
         LIMIT ?`,
      );
      const checkContracts = (contracts) => {
        if (contracts.length !== contractLimit) {
          throw new Error(`expected ${contractLimit} contract summaries, got ${contracts.length}`);
        }
      };
      const scanTimings = await sample(() => aggregate.all(contractLimit), { ...SLOW, check: checkContracts });
      recordLatency('query.list_contracts_group_by', scanTimings);
      console.error(`  query.list_contracts_group_by: p50 ${metrics['query.list_contracts_group_by'].value}ms`);

      const summaryTimings = await sample(() => store.listContracts(contractLimit), { ...SLOW, check: checkContracts });
      recordLatency('query.list_contracts', summaryTimings);
      console.error(`  query.list_contracts: p50 ${metrics['query.list_contracts'].value}ms`);
    } finally {
      scanDb.close();
    }

    await store.close();

    // ---- API response times ------------------------------------------------
    if (!values['skip-api']) {
      const api = await startApi({ root, dbPath });
      try {
        const sequential = async (name, path, opts) => {
          const timings = await sample(() => get(`${api.baseUrl}${path}`), opts);
          recordLatency(`api.${name}`, timings);
          console.error(`  api.${name}: p50 ${metrics[`api.${name}`].value}ms`);
        };
        const hotEvents = `/contracts/${hotContract}/events?limit=50`;
        const coldEvents = `/contracts/${coldContract}/events?limit=50`;

        await sequential('health', '/health', { warmup: 10, samples: 100 });
        await sequential('contracts_list', '/contracts', SLOW);
        await sequential('contract_events_hot', hotEvents, { warmup: 5, samples: 100 });
        await sequential('contract_events_cold', coldEvents, { warmup: 5, samples: 100 });

        // Eight clients at once against the hottest contract.
        const workers = 8;
        const totalRequests = 400;
        let issued = 0;
        const latencies = [];
        const wallStart = performance.now();
        await Promise.all(
          Array.from({ length: workers }, async () => {
            while (issued < totalRequests) {
              issued++;
              const start = performance.now();
              await get(`${api.baseUrl}${hotEvents}`);
              latencies.push(performance.now() - start);
            }
          }),
        );
        const wallSeconds = (performance.now() - wallStart) / 1000;
        recordRate('api.concurrent_events_rps', totalRequests / wallSeconds, 'req/s');
        recordLatency('api.concurrent_events', latencies);
        console.error(`  api.concurrent_events_rps: ${metrics['api.concurrent_events_rps'].value} req/s`);
      } finally {
        await api.stop();
      }
    }

    // ---- write results -----------------------------------------------------
    let commit = null;
    try {
      commit = execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      // not a git checkout
    }

    const result = {
      schema: 1,
      meta: {
        events,
        seed,
        commit,
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        cpu: cpus()[0]?.model ?? 'unknown',
        cpuCount: cpus().length,
        memoryGb: Math.round(totalmem() / 1024 ** 3),
        timestamp: new Date().toISOString(),
      },
      metrics,
    };
    const outPath = resolve(values.out);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`);

    console.log(`\n${'metric'.padEnd(42)}${'value'.padStart(14)}  unit`);
    for (const [name, m] of Object.entries(metrics)) {
      const p95 = m.p95 === undefined ? '' : `  (p95 ${m.p95})`;
      console.log(`${name.padEnd(42)}${m.value.toLocaleString('en-US').padStart(14)}  ${m.unit}${p95}`);
    }
    console.log(`\nWrote ${outPath}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
