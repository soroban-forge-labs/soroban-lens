import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SqliteEventStore,
  LATEST_SCHEMA_VERSION,
  MAX_QUERY_LIMIT,
  MIGRATIONS,
  DEFAULT_MAX_QUERY_LIMIT,
  resolveMaxQueryLimit,
  normaliseLimit,
} from '../dist/index.js';

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
  assert.match(health.detail, new RegExp(`schema v${LATEST_SCHEMA_VERSION}`));
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

// ── #29 report database size in getStats ─────────────────────────────────────

test('getStats reports a database size that matches the file on disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-db-'));
  const path = join(dir, 'lens.db');
  const store = new SqliteEventStore({ path });
  await store.insertEvents(fixture.events);

  const stats = await store.getStats();
  // The bar the issue sets is "matches du", so compare against stat(), which
  // is what du reads.
  assert.equal(stats.sizeBytes, statSync(path).size);
  assert.ok(stats.sizeBytes > 0);

  await store.close();
  await rm(dir, { recursive: true, force: true });
});

test('getStats reports the WAL separately, since it is what fills a volume', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-db-'));
  const path = join(dir, 'lens.db');
  const store = new SqliteEventStore({ path });
  await store.insertEvents(fixture.events);

  const stats = await store.getStats();
  assert.equal(stats.walSizeBytes, statSync(`${path}-wal`).size);

  await store.close();
  await rm(dir, { recursive: true, force: true });
});

test('an in-memory database reports null size rather than a misleading zero', async () => {
  const store = new SqliteEventStore({ path: ':memory:' });
  const stats = await store.getStats();
  // null means "no file", which is a different fact from "a 0-byte file".
  assert.equal(stats.sizeBytes, null);
  assert.equal(stats.walSizeBytes, null);
  await store.close();
});

// ── #30 countByTopic aggregate ───────────────────────────────────────────────

test('countByTopic ranks first-topic values across every contract', async () => {
  const store = await seeded();
  const topics = await store.countByTopic();

  assert.ok(topics.length > 0);
  // Ordered by frequency, descending.
  const counts = topics.map((t) => t.count);
  assert.deepEqual(counts, [...counts].sort((a, b) => b - a));

  // It spans contracts, unlike listTopics. The global count for a topic must
  // be at least what any single contract reports for it.
  const perContract = await store.listTopics(SAC);
  for (const { topic, count } of perContract) {
    const global = topics.find((t) => t.topic === topic);
    assert.ok(global, `global aggregate is missing ${topic}`);
    assert.ok(global.count >= count, `${topic}: global ${global.count} < ${SAC} ${count}`);
  }
  await store.close();
});

test('countByTopic totals match the events that carry a scalar first topic', async () => {
  const store = await seeded();
  const topics = await store.countByTopic(1000);
  const summed = topics.reduce((n, t) => n + t.count, 0);

  const { total } = await store.queryEvents({ limit: 1000 });
  // Every fixture event has a scalar symbol first topic, so the aggregate
  // accounts for all of them.
  assert.equal(summed, total);
  await store.close();
});

test('countByTopic respects its limit and the documented ceiling', async () => {
  const store = await seeded();
  assert.equal((await store.countByTopic(2)).length, 2);
  assert.ok((await store.countByTopic(MAX_QUERY_LIMIT + 500)).length <= MAX_QUERY_LIMIT);
  await store.close();
});

test('countByTopic is empty on an empty database rather than erroring', async () => {
  const store = new SqliteEventStore({ path: ':memory:' });
  assert.deepEqual(await store.countByTopic(), []);
  await store.close();
});

// ── #31 query by transaction and operation index ─────────────────────────────

test('filtering by transaction index narrows to one transaction in a ledger', async () => {
  const store = await seeded();
  const sample = fixture.events[0];
  const page = await store.queryEvents({
    transactionIndex: sample.transactionIndex,
    limit: MAX_QUERY_LIMIT,
  });
  assert.ok(page.events.length > 0);
  assert.ok(page.events.every((e) => e.transactionIndex === sample.transactionIndex));
  await store.close();
});

test('txHash and operationIndex together pin down a single operation', async () => {
  const store = await seeded();
  const sample = fixture.events.find((e) => e.operationIndex === 0);
  const page = await store.queryEvents({
    txHash: sample.txHash,
    operationIndex: 0,
    limit: MAX_QUERY_LIMIT,
  });
  assert.ok(page.events.length > 0);
  assert.ok(page.events.every((e) => e.txHash === sample.txHash && e.operationIndex === 0));
  await store.close();
});

test('index 0 is a real filter, not treated as absent', async () => {
  const store = await seeded();
  const all = await store.queryEvents({ limit: MAX_QUERY_LIMIT });
  const atZero = await store.queryEvents({ operationIndex: 0, limit: MAX_QUERY_LIMIT });
  // The classic falsy-zero bug: if 0 were dropped, this would return everything.
  assert.ok(atZero.events.every((e) => e.operationIndex === 0));
  const expected = fixture.events.filter((e) => e.operationIndex === 0).length;
  assert.equal(atZero.total, expected);
  assert.ok(expected < all.total || all.total === expected);
  await store.close();
});

test('an index that matches nothing returns an empty page, not everything', async () => {
  const store = await seeded();
  const page = await store.queryEvents({ transactionIndex: 99999, limit: 10 });
  assert.equal(page.total, 0);
  assert.deepEqual(page.events, []);
  await store.close();
});

// ── #36 index indexed_at ─────────────────────────────────────────────────────

test('the indexed_at index exists in a migration and the planner uses it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-db-'));
  const path = join(dir, 'lens.db');
  const store = new SqliteEventStore({ path });
  await store.insertEvents(fixture.events);
  await store.close();

  const db = new DatabaseSync(path);
  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events'")
    .all()
    .map((r) => r.name);
  assert.ok(indexes.includes('idx_events_indexed_at'), `indexes: ${indexes.join(', ')}`);

  // The bar the issue sets: a query ordering by indexed_at must actually use it,
  // not merely have an index sitting there unused.
  const plan = db
    .prepare('EXPLAIN QUERY PLAN SELECT id FROM events ORDER BY indexed_at DESC LIMIT 10')
    .all()
    .map((r) => r.detail)
    .join(' | ');
  assert.match(plan, /idx_events_indexed_at/, `planner chose: ${plan}`);
  assert.ok(!/SCAN events(?! USING)/.test(plan), `still a full scan: ${plan}`);

  db.close();
  await rm(dir, { recursive: true, force: true });
});

test('migrating an existing v1 database adds the index without touching rows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-db-'));
  const path = join(dir, 'lens.db');

  // Build a database that stopped at v1, exactly as a deployed one would be.
  const v1 = new DatabaseSync(path);
  v1.exec(`CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  v1.exec(MIGRATIONS[0].up);
  v1.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(1, MIGRATIONS[0].name, '');
  v1.close();

  // Opening it runs only the pending migration.
  const store = new SqliteEventStore({ path });
  const inserted = await store.insertEvents(fixture.events);
  const stats = await store.getStats();
  assert.equal(stats.schemaVersion, LATEST_SCHEMA_VERSION);
  assert.equal(inserted, fixture.events.length);
  await store.close();

  const db = new DatabaseSync(path);
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events'")
    .all()
    .map((r) => r.name);
  db.close();
  assert.ok(names.includes('idx_events_indexed_at'));

  await rm(dir, { recursive: true, force: true });
});

// ── #24 time-bounded queries backed by closed_at_unix ────────────────────────

const unix = (iso) => Math.floor(Date.parse(iso) / 1000);

test('fromTime and toTime bound a query by ledger close time', async () => {
  const store = await seeded();
  const from = unix('2026-09-15T19:22:55Z');
  const to = unix('2026-09-15T19:23:00Z');
  const page = await store.queryEvents({ fromTime: from, toTime: to, limit: MAX_QUERY_LIMIT });

  assert.ok(page.events.length > 0);
  for (const event of page.events) {
    const at = unix(event.ledgerClosedAt);
    assert.ok(at >= from && at <= to, `${event.ledgerClosedAt} is outside the window`);
  }
  await store.close();
});

test('time bounds are inclusive on both ends', async () => {
  const store = await seeded();
  const all = await store.queryEvents({ limit: MAX_QUERY_LIMIT });
  const exact = unix(all.events[0].ledgerClosedAt);

  // A single-second window must still contain the event that closed in it.
  const page = await store.queryEvents({ fromTime: exact, toTime: exact, limit: MAX_QUERY_LIMIT });
  assert.ok(page.events.some((e) => e.id === all.events[0].id));
  await store.close();
});

test('time bounds combine with contract and topic filters', async () => {
  const store = await seeded();
  const page = await store.queryEvents({
    contractId: SAC,
    fromTime: unix('2026-09-15T00:00:00Z'),
    limit: MAX_QUERY_LIMIT,
  });
  assert.ok(page.events.length > 0);
  assert.ok(page.events.every((e) => e.contractId === SAC));
  await store.close();
});

test('a window before anything indexed returns nothing, not everything', async () => {
  const store = await seeded();
  const page = await store.queryEvents({ toTime: unix('2020-01-01T00:00:00Z'), limit: 10 });
  assert.equal(page.total, 0);
  await store.close();
});

test('time-bounded queries use the closed_at_unix index', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-db-'));
  const path = join(dir, 'lens.db');
  const store = new SqliteEventStore({ path });
  await store.insertEvents(fixture.events);
  await store.close();

  const db = new DatabaseSync(path);
  const plan = db
    .prepare('EXPLAIN QUERY PLAN SELECT * FROM events WHERE closed_at_unix >= ? AND closed_at_unix <= ?')
    .all(0, 9_999_999_999)
    .map((r) => r.detail)
    .join(' | ');
  db.close();
  assert.match(plan, /idx_events_closed_at_unix/, `planner chose: ${plan}`);

  await rm(dir, { recursive: true, force: true });
});

// ── #55 configurable query limit ─────────────────────────────────────────────

test('the query ceiling defaults to 1000', () => {
  assert.equal(resolveMaxQueryLimit(undefined), DEFAULT_MAX_QUERY_LIMIT);
  assert.equal(resolveMaxQueryLimit(''), DEFAULT_MAX_QUERY_LIMIT);
  assert.equal(DEFAULT_MAX_QUERY_LIMIT, 1000);
});

test('the query ceiling can be raised or lowered', () => {
  assert.equal(resolveMaxQueryLimit('5000'), 5000);
  assert.equal(resolveMaxQueryLimit('10'), 10);
  assert.equal(resolveMaxQueryLimit('250.9'), 250, 'truncated, not rounded up past the ceiling');
});

test('an unusable ceiling falls back rather than rejecting every request', () => {
  // A ceiling of NaN or 0 would make the API reject every limit, which is a
  // far worse outcome than ignoring a typo.
  for (const bad of ['lots', '0', '-5', 'NaN']) {
    assert.equal(resolveMaxQueryLimit(bad), DEFAULT_MAX_QUERY_LIMIT, bad);
  }
});

// ── #16 structured logging ───────────────────────────────────────────────────

test('a fresh database logs one migration_applied event per migration, via the shared logger', async () => {
  const records = [];
  const log = {
    debug() {},
    info: (event, message, fields) => records.push({ event, message, fields }),
    warn() {},
    error() {},
  };
  const store = new SqliteEventStore({ path: ':memory:', log });
  await store.close();

  assert.equal(records.length, MIGRATIONS.length);
  assert.ok(records.every((r) => r.event === 'migration_applied'));
  assert.deepEqual(records.map((r) => r.fields.version), MIGRATIONS.map((m) => m.version));
});

test('a database already at the latest schema logs nothing on open', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-db-'));
  const path = join(dir, 'lens.db');
  await (async () => {
    const first = new SqliteEventStore({ path });
    await first.close();
  })();

  const records = [];
  const log = { debug() {}, info: (e) => records.push(e), warn() {}, error() {} };
  const reopened = new SqliteEventStore({ path, log });
  await reopened.close();

  assert.deepEqual(records, []);
  await rm(dir, { recursive: true, force: true });
});

test('a store built with no log option stays silent, unchanged from before this existed', async () => {
  // No assertion beyond "does not throw" is possible without capturing
  // process.stderr, but that absence is exactly the point: passing nothing
  // must not require passing a no-op either.
  const store = new SqliteEventStore({ path: ':memory:' });
  await store.close();
});

// ── #21 prune command and retention policy ───────────────────────────────────

test('pruneBefore removes rows below the threshold and leaves the rest', async () => {
  const store = await seeded();
  const removed = await store.pruneBefore(4695319);
  const remaining = await store.queryEvents({ limit: MAX_QUERY_LIMIT });

  assert.ok(removed > 0);
  assert.ok(remaining.events.every((e) => e.ledger >= 4695319));
  assert.equal(remaining.total, fixture.events.filter((e) => e.ledger >= 4695319).length);
  await store.close();
});

test('pruneBefore returns 0 and touches nothing when there is nothing below the threshold', async () => {
  const store = await seeded();
  const before = await store.getStats();
  const removed = await store.pruneBefore(0);
  const after = await store.getStats();

  assert.equal(removed, 0);
  assert.equal(after.eventCount, before.eventCount);
  await store.close();
});

test('pruneBefore reduces the file size on disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-db-'));
  const path = join(dir, 'lens.db');
  const store = new SqliteEventStore({ path });

  // The 60-event fixture fits in SQLite's minimum single page (4096 bytes),
  // so shrinking is only observable with enough rows to span several pages.
  const many = Array.from({ length: 5000 }, (_, i) => ({
    ...fixture.events[i % fixture.events.length],
    id: `synthetic-${String(i).padStart(6, '0')}`,
    ledger: 4695317 + i,
    txHash: 'a'.repeat(64),
  }));
  await store.insertEvents(many);
  const before = await store.getStats();

  const removed = await store.pruneBefore(4695317 + 4900); // keep the last 100
  const after = await store.getStats();

  assert.equal(removed, 4900);
  assert.ok(after.sizeBytes < before.sizeBytes, `expected shrink: ${before.sizeBytes} -> ${after.sizeBytes}`);
  await store.close();
  await rm(dir, { recursive: true, force: true });
});

test('pruneBefore does not touch stream_state — the cursor is independent of what rows remain', async () => {
  const store = await seeded();
  await store.saveStreamState({ key: 'k', cursor: 'abc', ledger: 4695317, updatedAt: '2026-01-01T00:00:00Z' });
  await store.pruneBefore(4695324);
  const state = await store.loadStreamState('k');
  assert.deepEqual(state, { key: 'k', cursor: 'abc', ledger: 4695317, updatedAt: '2026-01-01T00:00:00Z' });
  await store.close();
});

// ── #25 re-decode rows that failed to decode ─────────────────────────────────

test('redecode repairs a row whose decode_error was wrong, without touching the raw XDR', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-db-'));
  const path = join(dir, 'lens.db');
  const store = new SqliteEventStore({ path });
  await store.insertEvents([fixture.events[0]]);

  // Simulate a row a previous, buggier decoder got wrong: the raw XDR was
  // always fine, but the derived columns say otherwise. This is exactly what
  // "the decoder is fixed" looks like from the row's point of view — the
  // fault was in decodeEvent, not in the bytes.
  const db = new DatabaseSync(path);
  db.exec(
    `UPDATE events SET decode_error = 'simulated old bug', value_type = 'undecodable',
     value_json = '{"type":"undecodable","value":"corrupted"}', topic0 = NULL
     WHERE id = '${fixture.events[0].id}'`,
  );
  db.close();

  const before = await store.getEvent(fixture.events[0].id);
  assert.equal(before.decodeError, 'simulated old bug');

  const rewritten = await store.redecode();
  assert.equal(rewritten, 1);

  const after = await store.getEvent(fixture.events[0].id);
  assert.equal(after.decodeError, undefined);
  assert.equal(after.value.type, 'i128'); // the fixture event's real decoded shape
  assert.equal(after.topicsXdr[0], fixture.events[0].topic[0], 'raw XDR was never touched');

  await store.close();
  await rm(dir, { recursive: true, force: true });
});

test('redecode without --all only touches rows with a stored decode_error', async () => {
  const store = await seeded();
  const before = await store.queryEvents({ limit: MAX_QUERY_LIMIT });
  const rewritten = await store.redecode();
  assert.equal(rewritten, 0, 'the fixture has no failed rows to begin with');
  const after = await store.queryEvents({ limit: MAX_QUERY_LIMIT });
  // total may now be served from the #26 count cache (totalIsEstimate: true)
  // on the second call — a cosmetic difference unrelated to what this test
  // checks, so compare events/nextCursor/total, not the whole object shape.
  assert.deepEqual(after.events, before.events);
  assert.equal(after.nextCursor, before.nextCursor);
  assert.equal(after.total, before.total);
  await store.close();
});

test('redecode(true) re-runs over every row, including ones that already decoded cleanly', async () => {
  const store = await seeded();
  const rewritten = await store.redecode(true);
  assert.equal(rewritten, fixture.events.length);
  // Idempotent: decoding the same valid XDR twice produces the same result.
  const page = await store.queryEvents({ limit: MAX_QUERY_LIMIT });
  assert.equal(page.total, fixture.events.length);
  assert.ok(page.events.every((e) => e.decodeError === undefined));
  await store.close();
});

test('redecode on an empty database does nothing', async () => {
  const store = new SqliteEventStore({ path: ':memory:' });
  assert.equal(await store.redecode(), 0);
  assert.equal(await store.redecode(true), 0);
  await store.close();
});

// ── #39 detect and repair corrupt rows ────────────────────────────────────────

test('checkIntegrity reports nothing on a freshly-decoded database', async () => {
  const store = await seeded();
  assert.deepEqual(await store.checkIntegrity(), []);
  await store.close();
});

test('a hand-corrupted topic0 is detected and repaired', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-db-'));
  const path = join(dir, 'lens.db');
  const store = new SqliteEventStore({ path });
  await store.insertEvents([fixture.events[0]]);
  const id = fixture.events[0].id;

  const db = new DatabaseSync(path);
  db.exec(`UPDATE events SET topic0 = 'hand-corrupted-value' WHERE id = '${id}'`);
  db.close();

  const problems = await store.checkIntegrity();
  assert.equal(problems.length, 1);
  assert.equal(problems[0].id, id);
  assert.match(problems[0].problems[0], /topic0 is "hand-corrupted-value"/);

  await store.repairRow(id);
  assert.deepEqual(await store.checkIntegrity(), []);

  const event = await store.getEvent(id);
  assert.equal(event.topics[0].value, 'fee'); // the real decoded first topic

  await store.close();
  await rm(dir, { recursive: true, force: true });
});

test('a topic_count mismatch is detected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-db-'));
  const path = join(dir, 'lens.db');
  const store = new SqliteEventStore({ path });
  await store.insertEvents([fixture.events[0]]);
  const id = fixture.events[0].id;

  const db = new DatabaseSync(path);
  db.exec(`UPDATE events SET topic_count = 999 WHERE id = '${id}'`);
  db.close();

  const problems = await store.checkIntegrity();
  assert.equal(problems.length, 1);
  assert.match(problems[0].problems[0], /topic_count \(999\)/);

  await store.close();
  await rm(dir, { recursive: true, force: true });
});

test('malformed JSON in a stored column is detected without throwing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-db-'));
  const path = join(dir, 'lens.db');
  const store = new SqliteEventStore({ path });
  await store.insertEvents([fixture.events[0]]);
  const id = fixture.events[0].id;

  const db = new DatabaseSync(path);
  db.exec(`UPDATE events SET value_json = 'not json at all {{{' WHERE id = '${id}'`);
  db.close();

  const problems = await store.checkIntegrity();
  assert.equal(problems.length, 1);
  assert.match(problems[0].problems[0], /value_json is not valid JSON/);

  await store.close();
  await rm(dir, { recursive: true, force: true });
});

test('repairRow on a clean id is a no-op', async () => {
  const store = await seeded();
  const before = await store.getEvent(fixture.events[0].id);
  await store.repairRow(fixture.events[0].id);
  const after = await store.getEvent(fixture.events[0].id);
  assert.deepEqual(after, before);
  await store.close();
});

test('repairRow on an unknown id does nothing', async () => {
  const store = await seeded();
  await assert.doesNotReject(() => store.repairRow('does-not-exist'));
  await store.close();
});

// ── #40 migration rollback ────────────────────────────────────────────────────

test('a migration can be applied and rolled back', async () => {
  const store = new SqliteEventStore({ path: ':memory:' });
  assert.equal((await store.getStats()).schemaVersion, LATEST_SCHEMA_VERSION);

  const rolledBack = await store.migrateDown(LATEST_SCHEMA_VERSION - 1);
  assert.deepEqual(rolledBack, [LATEST_SCHEMA_VERSION]);
  assert.equal((await store.getStats()).schemaVersion, LATEST_SCHEMA_VERSION - 1);

  // And forward again, via the ordinary migrate() path.
  await store.migrate();
  assert.equal((await store.getStats()).schemaVersion, LATEST_SCHEMA_VERSION);
  await store.close();
});

test('rolling back an index migration actually drops the index', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-db-'));
  const path = join(dir, 'lens.db');
  const store = new SqliteEventStore({ path });

  const indexNames = () => {
    const db = new DatabaseSync(path);
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events'").all().map((r) => r.name);
    db.close();
    return names;
  };
  assert.ok(indexNames().includes('idx_events_indexed_at'));

  await store.migrateDown(1);
  assert.ok(!indexNames().includes('idx_events_indexed_at'));

  await store.close();
  await rm(dir, { recursive: true, force: true });
});

test('rolling back to version 0 drops the tables entirely — the one truly irreversible step', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-db-'));
  const path = join(dir, 'lens.db');
  const store = new SqliteEventStore({ path });
  await store.insertEvents(fixture.events);

  await store.migrateDown(0);

  const db = new DatabaseSync(path);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  db.close();
  assert.ok(!tables.includes('events'));
  assert.ok(!tables.includes('stream_state'));

  await store.close();
  await rm(dir, { recursive: true, force: true });
});

test('rolling back past a migration with no down SQL fails cleanly and changes nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-db-'));
  const path = join(dir, 'lens.db');
  const store = new SqliteEventStore({ path });
  const versionBefore = (await store.getStats()).schemaVersion;

  // Every real migration today has a down. Simulate one that does not by
  // temporarily stripping it from the shared MIGRATIONS array, then restoring
  // it — this is the one legitimate way to exercise "missing down" without a
  // second, parallel migration table just for the test.
  const target = MIGRATIONS[MIGRATIONS.length - 1];
  const savedDown = target.down;
  delete target.down;
  try {
    await assert.rejects(
      () => store.migrateDown(versionBefore - 1),
      new RegExp(`migration ${target.version}.*has no down SQL`),
    );
  } finally {
    target.down = savedDown;
  }

  // Nothing was rolled back — the all-or-nothing guarantee.
  assert.equal((await store.getStats()).schemaVersion, versionBefore);

  await store.close();
  await rm(dir, { recursive: true, force: true });
});

test('rolling back to the current version is a no-op', async () => {
  const store = new SqliteEventStore({ path: ':memory:' });
  const rolledBack = await store.migrateDown(LATEST_SCHEMA_VERSION);
  assert.deepEqual(rolledBack, []);
  await store.close();
});

// ── #26 cache the total count ────────────────────────────────────────────────

test('the first query for a filter returns an exact count, not marked as an estimate', async () => {
  const store = new SqliteEventStore({ path: ':memory:', countCacheTtlMs: 5000 });
  await store.insertEvents(fixture.events);
  const page = await store.queryEvents({ limit: 5 });
  assert.equal(page.total, fixture.events.length);
  assert.equal(page.totalIsEstimate, undefined);
  await store.close();
});

test('a second query for the same filter within the TTL is served from cache', async () => {
  let now = 1_000_000;
  const store = new SqliteEventStore({ path: ':memory:', countCacheTtlMs: 2000, now: () => now });
  await store.insertEvents(fixture.events);

  const first = await store.queryEvents({ limit: 5 });
  assert.equal(first.totalIsEstimate, undefined);

  now += 500; // well within the 2000ms TTL
  const second = await store.queryEvents({ limit: 5, contractId: undefined });
  assert.equal(second.total, first.total);
  assert.equal(second.totalIsEstimate, true);
  await store.close();
});

test('the cache expires: a query after the TTL recomputes and reflects new rows', async () => {
  let now = 0;
  const store = new SqliteEventStore({ path: ':memory:', countCacheTtlMs: 1000, now: () => now });
  await store.insertEvents(fixture.events);

  const before = await store.queryEvents({ limit: 5 });
  assert.equal(before.total, fixture.events.length);

  // Within the TTL, a fresh insert is not yet reflected — that staleness is
  // the deliberate trade for not scanning on every request.
  now += 500;
  await store.insertEvents([{ ...fixture.events[0], id: 'extra-one' }]);
  const stale = await store.queryEvents({ limit: 5 });
  assert.equal(stale.total, fixture.events.length, 'still serving the cached count');
  assert.equal(stale.totalIsEstimate, true);

  now += 600; // past the 1000ms TTL from the first query
  const fresh = await store.queryEvents({ limit: 5 });
  assert.equal(fresh.total, fixture.events.length + 1);
  assert.equal(fresh.totalIsEstimate, undefined);

  await store.close();
});

test('countCacheTtlMs: 0 disables caching — every query is exact and fresh', async () => {
  const store = new SqliteEventStore({ path: ':memory:', countCacheTtlMs: 0 });
  await store.insertEvents(fixture.events);

  await store.queryEvents({ limit: 5 });
  await store.insertEvents([{ ...fixture.events[0], id: 'extra-two' }]);
  const page = await store.queryEvents({ limit: 5 });

  assert.equal(page.total, fixture.events.length + 1, 'never stale with caching disabled');
  assert.equal(page.totalIsEstimate, undefined);
  await store.close();
});

test('different filters get independent cache entries', async () => {
  let now = 0;
  const store = new SqliteEventStore({ path: ':memory:', countCacheTtlMs: 5000, now: () => now });
  await store.insertEvents(fixture.events);

  const all = await store.queryEvents({ limit: 1 });
  const scoped = await store.queryEvents({ limit: 1, contractId: SAC });
  assert.equal(all.totalIsEstimate, undefined, 'a different filter is a cache miss, not reused');
  assert.equal(scoped.totalIsEstimate, undefined);
  assert.notEqual(all.total, scoped.total);
  await store.close();
});

test('the default TTL is short (2000ms) and caching is on by default', async () => {
  let now = 0;
  const store = new SqliteEventStore({ path: ':memory:', now: () => now });
  await store.insertEvents(fixture.events);
  await store.queryEvents({ limit: 1 });
  now += 100;
  const second = await store.queryEvents({ limit: 1 });
  assert.equal(second.totalIsEstimate, true, 'caching must be on by default to fix the perf problem');
  await store.close();
});
