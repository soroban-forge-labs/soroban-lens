import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { SqliteEventStore } from '@soroban-lens/store';
import { createApiServer } from '../dist/index.js';

const fixture = JSON.parse(readFileSync(new URL('../../../fixtures/testnet-events.json', import.meta.url), 'utf8'));
const CONTRACT = fixture.events[0].contractId;

/** `n` distinct raw events cloned from one fixture event, newest ledger last. */
function makeEvents(n) {
  const template = fixture.events[0];
  return Array.from({ length: n }, (_, i) => ({
    ...template,
    id: `${String(i + 1).padStart(19, '0')}-0000000000`,
    ledger: 1000 + i,
  }));
}

async function withServer(count, options, run) {
  const store = new SqliteEventStore({ path: ':memory:' });
  await store.insertEvents(makeEvents(count));
  const server = createApiServer({ store, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
    await once(server, 'close');
    await store.close();
  }
}

const ndjson = { headers: { accept: 'application/x-ndjson' } };
const lines = (text) => text.trimEnd().split('\n').map((l) => JSON.parse(l));

test('Accept: application/x-ndjson streams one event per line across pages, then a trailer', async () => {
  await withServer(1200, {}, async (base) => {
    const res = await fetch(`${base}/events`, ndjson);
    assert.match(res.headers.get('content-type'), /^application\/x-ndjson/);
    const rows = lines(await res.text());
    const trailer = rows.pop();
    assert.equal(rows.length, 1200); // more than one 500-row keyset page
    assert.equal(new Set(rows.map((r) => r.id)).size, 1200);
    assert.deepEqual(trailer, { trailer: { rows: 1200, capped: false, cap: 1_000_000 } });
    // Contract route too, and a bare */* stays JSON.
    const scoped = lines(await (await fetch(`${base}/contracts/${CONTRACT}/events?limit=3`, ndjson)).text());
    assert.equal(scoped.length, 4);
    assert.match((await fetch(`${base}/events`, { headers: { accept: '*/*' } })).headers.get('content-type'), /json/);
  });
});

test('the row cap truncates the stream and the trailer says so', async () => {
  await withServer(30, { ndjsonMaxRows: 10 }, async (base) => {
    const rows = lines(await (await fetch(`${base}/events`, ndjson)).text());
    assert.deepEqual(rows.pop(), { trailer: { rows: 10, capped: true, cap: 10 } });
    assert.equal(rows.length, 10);
    // Exactly at the cap is not capped; a smaller ?limit is not capped either.
    await withServer(10, { ndjsonMaxRows: 10 }, async (b) => {
      const all = lines(await (await fetch(`${b}/events`, ndjson)).text());
      assert.equal(all.pop().trailer.capped, false);
    });
    const limited = lines(await (await fetch(`${base}/events?limit=4`, ndjson)).text());
    assert.deepEqual(limited.pop(), { trailer: { rows: 4, capped: false, cap: 10 } });
  });
});

test('a 100 000-row stream keeps memory flat', async () => {
  await withServer(100_000, {}, async (base) => {
    const res = await fetch(`${base}/events`, ndjson);
    const decoder = new TextDecoder();
    let rows = 0;
    let tail = '';
    let peak = 0;
    const baseline = process.memoryUsage().heapUsed;
    for await (const chunk of res.body) {
      const text = tail + decoder.decode(chunk, { stream: true });
      const parts = text.split('\n');
      tail = parts.pop();
      rows += parts.length;
      if (rows % 10_000 < parts.length) {
        globalThis.gc?.();
        peak = Math.max(peak, process.memoryUsage().heapUsed - baseline);
      }
    }
    assert.equal(rows, 100_001); // events + trailer
    // The server and client share this process, and the store itself holds the
    // fixture rows; what must not happen is the response (~50 MB) accumulating.
    assert.ok(peak < 150 * 1024 * 1024, `heap grew by ${Math.round(peak / 1048576)} MB`);
  });
});
