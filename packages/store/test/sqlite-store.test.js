import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteEventStore, LATEST_SCHEMA_VERSION, MAX_QUERY_LIMIT, normaliseLimit } from '../dist/index.js';

const fixture = JSON.parse(readFileSync(new URL('../../../fixtures/testnet-events.json', import.meta.url), 'utf8'));
const SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

async function seeded() {
  const store = new SqliteEventStore({ path: ':memory:' });
  await store.insertEvents(fixture.events);
  return store;
}

test('migrations bring a fresh database to the latest version', async () => {
  const store = new SqliteEventStore({ path: ':memory:' });
  const stats = await store.getStats();
  assert.equal(stats.schemaVersion, LATEST_SCHEMA_VERSION);
  assert.equal(stats.eventCount, 0);
  await store.close();
});

test('migrate() is idempotent', async () => {
  const store = new SqliteEventStore({ path: ':memory:' });
  await store.migrate();
  await store.migrate();
  assert.equal((await store.getStats()).schemaVersion, LATEST_SCHEMA_VERSION);
  await store.close();
});

test('the whole fixture inserts with correct types', async () => {
  const store = await seeded();
  const stats = await store.getStats();
  assert.equal(stats.eventCount, fixture.events.length);
  assert.equal(stats.contractCount, new Set(fixture.events.map((e) => e.contractId)).size);
  assert.equal(stats.minLedger, 4695317);
  assert.equal(stats.maxLedger, 4695324);
  await store.close();
});

test('inserts are idempotent, so at-least-once delivery is safe', async () => {
  const store = new SqliteEventStore({ path: ':memory:' });
  const first = await store.insertEvents(fixture.events);
  const second = await store.insertEvents(fixture.events);
  assert.equal(first, fixture.events.length);
  assert.equal(second, 0, 'replaying a batch must insert nothing');
  assert.equal((await store.getStats()).eventCount, fixture.events.length);
  await store.close();
});

test('a stored event round-trips with its decoded payload and raw XDR intact', async () => {
  const store = await seeded();
  const raw = fixture.events.find((e) => e.contractId === SAC);
  const event = await store.getEvent(raw.id);
  assert.equal(event.contractId, SAC);
  assert.equal(event.ledger, raw.ledger);
  assert.deepEqual(event.topicsXdr, raw.topic);
  assert.equal(event.valueXdr, raw.value);
  assert.equal(typeof event.topics[0].value, 'string');
  assert.equal(typeof event.inSuccessfulContractCall, 'boolean');
  await store.close();
});

test('getEvent returns null for an unknown id', async () => {
  const store = await seeded();
  assert.equal(await store.getEvent('nope'), null);
  await store.close();
});

test('events come back newest first by default', async () => {
  const store = await seeded();
  const page = await store.queryEvents({ limit: 10 });
  const ids = page.events.map((e) => e.id);
  assert.deepEqual(ids, [...ids].sort().reverse());
  await store.close();
});

test('order: asc reverses the stream', async () => {
  const store = await seeded();
  const page = await store.queryEvents({ limit: 10, order: 'asc' });
  const ids = page.events.map((e) => e.id);
  assert.deepEqual(ids, [...ids].sort());
  await store.close();
});

test('filtering by contract returns only that contract', async () => {
  const store = await seeded();
  const page = await store.queryEvents({ contractId: SAC, limit: 100 });
  assert.ok(page.events.length > 0);
  assert.ok(page.events.every((e) => e.contractId === SAC));
  assert.equal(page.total, fixture.events.filter((e) => e.contractId === SAC).length);
  await store.close();
});

test('total counts all matches, not just the returned page', async () => {
  const store = await seeded();
  const page = await store.queryEvents({ limit: 5 });
  assert.equal(page.events.length, 5);
  assert.equal(page.total, fixture.events.length);
  await store.close();
});

test('keyset pagination walks the whole set exactly once', async () => {
  const store = await seeded();
  const seen = [];
  let cursor;
  for (let guard = 0; guard < 50; guard++) {
    const page = await store.queryEvents({ limit: 7, ...(cursor ? { cursor } : {}) });
    seen.push(...page.events.map((e) => e.id));
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  assert.equal(seen.length, fixture.events.length);
  assert.equal(new Set(seen).size, fixture.events.length, 'no event appeared on two pages');
  await store.close();
});

test('nextCursor is null on the final page', async () => {
  const store = await seeded();
  const page = await store.queryEvents({ limit: MAX_QUERY_LIMIT });
  assert.equal(page.nextCursor, null);
  await store.close();
});

test('filtering by topic prefix matches the first topic', async () => {
  const store = await seeded();
  const page = await store.queryEvents({ topics: ['transfer'], limit: 100 });
  assert.ok(page.events.length > 0);
  assert.ok(page.events.every((e) => e.topics[0].value === 'transfer'));
  await store.close();
});

test('a null topic segment is a wildcard', async () => {
  const store = await seeded();
  const wildcard = await store.queryEvents({ topics: [null, null], limit: 100 });
  assert.equal(wildcard.total, fixture.events.length);
  await store.close();
});

test('topic filters combine with a contract filter', async () => {
  const store = await seeded();
  const page = await store.queryEvents({ contractId: SAC, topics: ['fee'], limit: 100 });
  assert.ok(page.events.length > 0);
  assert.ok(page.events.every((e) => e.contractId === SAC && e.topics[0].value === 'fee'));
  await store.close();
});

test('a >4-topic event is stored whole and still filterable on its prefix', async () => {
  const store = await seeded();
  const page = await store.queryEvents({ topics: ['AXIS', 'order'], limit: 10 });
  assert.ok(page.events.length > 0);
  const event = page.events[0];
  assert.equal(event.topics.length, 5, 'all five topics survived, not just the indexed four');
  await store.close();
});

test('ledger range filters are inclusive on both ends', async () => {
  const store = await seeded();
  const page = await store.queryEvents({ fromLedger: 4695318, toLedger: 4695320, limit: 100 });
  assert.ok(page.events.length > 0);
  assert.ok(page.events.every((e) => e.ledger >= 4695318 && e.ledger <= 4695320));
  const below = await store.queryEvents({ toLedger: 4695316, limit: 10 });
  assert.equal(below.total, 0);
  await store.close();
});

test('successfulOnly excludes failed contract calls but the default keeps them', async () => {
  const store = await seeded();
  const all = await store.queryEvents({ limit: MAX_QUERY_LIMIT });
  const ok = await store.queryEvents({ successfulOnly: true, limit: MAX_QUERY_LIMIT });
  assert.ok(all.total > ok.total, 'fixture must contain at least one unsuccessful call');
  assert.ok(ok.events.every((e) => e.inSuccessfulContractCall));
  await store.close();
});

test('filtering by transaction hash works', async () => {
  const store = await seeded();
  const txHash = fixture.events[0].txHash;
  const page = await store.queryEvents({ txHash, limit: 10 });
  assert.ok(page.events.length > 0);
  assert.ok(page.events.every((e) => e.txHash === txHash));
  await store.close();
});

test('limits are clamped to the documented bounds', async () => {
  assert.equal(normaliseLimit(undefined), 50);
  assert.equal(normaliseLimit(0), 1);
  assert.equal(normaliseLimit(-5), 1);
  assert.equal(normaliseLimit(99999), MAX_QUERY_LIMIT);
  assert.equal(normaliseLimit(Number.NaN), 50);
  const store = await seeded();
  assert.ok((await store.queryEvents({ limit: 99999 })).events.length <= MAX_QUERY_LIMIT);
  await store.close();
});

test('listContracts summarises each contract, most recent first', async () => {
  const store = await seeded();
  const contracts = await store.listContracts();
  assert.equal(contracts.length, new Set(fixture.events.map((e) => e.contractId)).size);
  const sac = contracts.find((c) => c.contractId === SAC);
  assert.ok(sac.eventCount > 1);
  assert.ok(sac.lastLedger >= sac.firstLedger);
  const ledgers = contracts.map((c) => c.lastLedger);
  assert.deepEqual(ledgers, [...ledgers].sort((a, b) => b - a));
  await store.close();
});

test('listTopics ranks a contract distinct topics by frequency', async () => {
  const store = await seeded();
  const topics = await store.listTopics(SAC);
  assert.ok(topics.length > 0);
  assert.ok(topics.map((t) => t.topic).includes('transfer'));
  const counts = topics.map((t) => t.count);
  assert.deepEqual(counts, [...counts].sort((a, b) => b - a));
  await store.close();
});

test('stream state survives a round trip and upserts on the same key', async () => {
  const store = new SqliteEventStore({ path: ':memory:' });
  await store.saveStreamState({ key: 'k', cursor: 'c1', ledger: 1, updatedAt: '2026-09-15T00:00:00Z' });
  await store.saveStreamState({ key: 'k', cursor: 'c2', ledger: 2, updatedAt: '2026-09-15T00:01:00Z' });
  const state = await store.loadStreamState('k');
  assert.equal(state.cursor, 'c2');
  assert.equal(state.ledger, 2);
  assert.equal((await store.listStreamStates()).length, 1);
  assert.equal(await store.loadStreamState('missing'), null);
  await store.close();
});

test('healthCheck reports schema and event count', async () => {
  const store = new SqliteEventStore({ path: ':memory:' });
  const health = await store.healthCheck();
  assert.equal(health.ok, true);
  assert.match(health.detail, /schema v1/);
  await store.close();
});

test('healthCheck does not take the write lock, so the API can serve it on every request', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-db-'));
  const path = join(dir, 'lens.db');
  const writer = new SqliteEventStore({ path });
  await writer.insertEvents(fixture.events);
  const reader = new SqliteEventStore({ path, migrateOnOpen: false });

  // Hold the write lock the way a running indexer does mid-batch.
  const indexer = new DatabaseSync(path);
  indexer.exec('BEGIN IMMEDIATE');
  indexer.exec('CREATE TABLE _lock_holder (id INTEGER)');

  const startedAt = Date.now();
  const health = await reader.healthCheck();
  const elapsedMs = Date.now() - startedAt;

  indexer.exec('ROLLBACK');
  indexer.close();

  assert.equal(health.ok, true, health.detail);
  // busy_timeout is 5s, so anything needing the write lock would have parked
  // on it. Returning promptly is the proof that this path is read-only.
  assert.ok(elapsedMs < 1000, `healthCheck blocked for ${elapsedMs}ms — it took the write lock`);

  await reader.close();
  await writer.close();
  await rm(dir, { recursive: true, force: true });
});

test('writeProbe reports writability and leaves no trace', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-db-'));
  const path = join(dir, 'lens.db');
  const store = new SqliteEventStore({ path });
  await store.insertEvents(fixture.events);

  const before = await store.getStats();
  const probe = await store.writeProbe();
  const after = await store.getStats();

  assert.equal(probe.ok, true, probe.detail);
  assert.match(probe.detail, /writable/);
  assert.deepEqual(after, before);

  // Rolled back, not merely dropped — no DDL a concurrent reader could observe.
  const inspector = new DatabaseSync(path);
  const tables = inspector
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((r) => r.name);
  inspector.close();
  assert.ok(!tables.includes('_lens_write_probe'), `probe table leaked: ${tables.join(', ')}`);

  await store.close();
  await rm(dir, { recursive: true, force: true });
});

test('data persists across reopening a file-backed database', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-db-'));
  const path = join(dir, 'nested', 'lens.db');
  const first = new SqliteEventStore({ path });
  await first.insertEvents(fixture.events);
  await first.close();

  const second = new SqliteEventStore({ path });
  assert.equal((await second.getStats()).eventCount, fixture.events.length);
  await second.close();
});
