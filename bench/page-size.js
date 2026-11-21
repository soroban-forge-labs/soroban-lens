#!/usr/bin/env node
/**
 * Adaptive page size benchmark (#14).
 *
 *   npm run build -w @soroban-lens/ingest && node bench/page-size.js
 *
 * Drives the real EventPoller against a simulated node: a busy contract with
 * a fixed number of events, a response time that grows with page size, and a
 * request timeout above which the node fails the page. Reports round trips,
 * failed requests and simulated wall time, fixed versus adaptive, per scenario.
 *
 * Simulated rather than live because the comparison needs the same history
 * served twice under identical conditions, which no public RPC offers. The
 * latency model (fixed overhead + per-event cost) is the shape stellar-rpc's
 * getEvents has; the constants are illustrative, not measured.
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const ingest = await import(pathToFileURL(resolve('packages/ingest/dist/index.js')).href);
const { EventPoller, MemoryCursorStore, RetryExhaustedError } = ingest;
const CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

function node({ total, overheadMs, perEventMs, timeoutMs, clock }) {
  const ids = Array.from({ length: total }, (_, i) => `${String(1000 + Math.floor(i / 100)).padStart(19, '0')}-${String(i).padStart(10, '0')}`);
  const stats = { requests: 0, failures: 0, exhausted: false };
  const client = {
    rpcUrl: 'https://rpc.example',
    async retention() { return { latestLedger: 1_000_000, oldestLedger: 1000 }; },
    async getEvents({ cursor, limit }) {
      stats.requests++;
      let start = 0;
      if (cursor) { start = ids.findIndex((id) => id > cursor); if (start < 0) start = ids.length; }
      const n = Math.min(limit, ids.length - start);
      const cost = overheadMs + n * perEventMs;
      if (cost > timeoutMs) {
        stats.failures++;
        clock.t += timeoutMs;
        throw new RetryExhaustedError('request timed out', 1, new Error('timeout'));
      }
      clock.t += cost;
      const events = ids.slice(start, start + n).map((id) => ({
        id, type: 'contract', ledger: Number(id.slice(0, 19)), ledgerClosedAt: '2026-09-15T19:22:52Z',
        contractId: CONTRACT, topic: [], value: 'AAAAAQ==', txHash: '00', transactionIndex: 0, operationIndex: 0,
        inSuccessfulContractCall: true,
      }));
      if (n < limit) stats.exhausted = true;
      return { events, cursor: events.at(-1)?.id ?? cursor ?? 'start', latestLedger: 1_000_000, oldestLedger: 1000 };
    },
  };
  return { client, stats };
}

async function run(scenario, options) {
  const clock = { t: 0 };
  const { client, stats } = node({ ...scenario, clock });
  const abort = new AbortController();
  let delivered = 0;
  const poller = new EventPoller(
    { contractIds: [CONTRACT], reorgDepth: 0, ...options },
    {
      client,
      cursors: new MemoryCursorStore(),
      now: () => clock.t,
      signal: abort.signal,
      sleep: async (ms) => { clock.t += ms; if (stats.exhausted) abort.abort(); },
    },
  );
  for await (const batch of poller.stream()) delivered += batch.events.length;
  return { delivered, ...stats, seconds: clock.t / 1000 };
}

const scenarios = [
  { name: 'busy contract, healthy node', total: 100_000, overheadMs: 150, perEventMs: 0.2, timeoutMs: 30_000 },
  { name: 'busy contract, node times out above ~4000/page', total: 100_000, overheadMs: 150, perEventMs: 1.2, timeoutMs: 5_000 },
  { name: 'quiet contract', total: 150, overheadMs: 150, perEventMs: 0.2, timeoutMs: 30_000 },
];

const rows = [];
for (const s of scenarios) {
  const fixed = await run(s, { pageSize: 200 });
  const adaptive = await run(s, { pageSize: 200, pageSizeBounds: { min: 100, max: 10_000, fastMs: 3000, slowMs: 4500 } });
  if (fixed.delivered !== s.total || adaptive.delivered !== s.total) throw new Error(`${s.name}: events lost`);
  rows.push({ scenario: s.name, mode: 'fixed 200', ...fixed }, { scenario: s.name, mode: 'adaptive 100..10000', ...adaptive });
}

console.log('| scenario | mode | events | round trips | failed requests | simulated time |');
console.log('|---|---|---:|---:|---:|---:|');
for (const r of rows) {
  console.log(`| ${r.scenario} | ${r.mode} | ${r.delivered} | ${r.requests} | ${r.failures} | ${r.seconds.toFixed(1)}s |`);
}
