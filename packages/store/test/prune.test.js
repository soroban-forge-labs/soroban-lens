/**
 * SQLite-specific half of #154: that a prune takes the side tables with it.
 *
 * The shared conformance suite already asserts the behaviour every backend owes
 * — one contract pruned, the others untouched, filters combining with AND — and
 * it cannot assert this, because `event_addresses`, `event_topics` and
 * `events_fts` are this backend's own tables. So the orphan checks live here,
 * per the scope note in testing.ts.
 *
 * Worth stating plainly: nothing in `prune()` deletes from those tables. They
 * are cleaned by `ON DELETE CASCADE` and `trg_events_fts_delete`, which means
 * the only thing standing between a correct prune and a search that still
 * matches deleted events is `PRAGMA foreign_keys = ON` in the constructor.
 * These tests are what notice if that ever stops being true.
 *
 * `lens verify` would not: `checkIntegrity` reads the events table's own
 * columns and never looks at a side table.
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteEventStore } from '../dist/index.js';

const fixture = JSON.parse(
  readFileSync(new URL('../../../fixtures/testnet-events.json', import.meta.url), 'utf8'),
);

async function seeded() {
  const dir = await mkdtemp(join(tmpdir(), 'prune-'));
  const path = join(dir, 'lens.db');
  const store = new SqliteEventStore({ path });
  await store.insertEvents(fixture.events);
  return { store, path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Row counts and orphan counts straight from the file, not through the store. */
function inspect(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  const count = (sql) => db.prepare(sql).get().n;
  try {
    return {
      events: count('SELECT COUNT(*) AS n FROM events'),
      addresses: count('SELECT COUNT(*) AS n FROM event_addresses'),
      topics: count('SELECT COUNT(*) AS n FROM event_topics'),
      fts: count('SELECT COUNT(*) AS n FROM events_fts'),
      orphanAddresses: count(
        'SELECT COUNT(*) AS n FROM event_addresses a WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.id = a.event_id)',
      ),
      orphanTopics: count(
        'SELECT COUNT(*) AS n FROM event_topics t WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.id = t.event_id)',
      ),
      orphanFts: count(
        'SELECT COUNT(*) AS n FROM events_fts f WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.id = f.event_id)',
      ),
    };
  } finally {
    db.close();
  }
}

function assertNoOrphans(path, when) {
  const rows = inspect(path);
  assert.equal(rows.orphanAddresses, 0, `orphaned event_addresses rows ${when}`);
  assert.equal(rows.orphanTopics, 0, `orphaned event_topics rows ${when}`);
  assert.equal(rows.orphanFts, 0, `orphaned events_fts rows ${when}`);
  return rows;
}

test('[prune] pruning one contract leaves no orphaned side-table rows', async () => {
  const { store, path, cleanup } = await seeded();
  try {
    const seededRows = assertNoOrphans(path, 'before pruning');
    assert.ok(seededRows.addresses > 0, 'the fixture should mention addresses');
    assert.ok(seededRows.fts > 0, 'the fixture should be indexed for search');

    const busiest = (await store.listContracts()).sort((a, b) => b.eventCount - a.eventCount)[0];
    const removed = await store.prune({ contractId: busiest.contractId });
    assert.equal(removed, busiest.eventCount);

    const after = assertNoOrphans(path, 'after pruning one contract');
    assert.equal(after.events, seededRows.events - removed);
    // The side tables shrank with the events rather than merely not orphaning.
    assert.ok(after.addresses < seededRows.addresses, 'event_addresses did not shrink');
    assert.equal(after.fts, after.events);
  } finally {
    await store.close();
    await cleanup();
  }
});

test('[prune] a pruned event stops matching a full-text search', async () => {
  const { store, path, cleanup } = await seeded();
  try {
    // The FTS row is deleted by a trigger, not by prune() itself. If that
    // trigger were ever dropped, search would keep returning events that no
    // longer exist, and the orphan count above is the only other witness.
    const target = (await store.listContracts()).sort((a, b) => b.eventCount - a.eventCount)[0];
    const before = await store.queryEvents({ contractId: target.contractId, limit: 1 });
    const topic = before.events[0].topics[0]?.value;
    assert.equal(typeof topic, 'string');

    const hitsBefore = await store.queryEvents({ search: topic, limit: 1000 });
    assert.ok(hitsBefore.total > 0);

    await store.prune({ contractId: target.contractId });

    const hitsAfter = await store.queryEvents({ search: topic, limit: 1000 });
    assert.ok(
      hitsAfter.events.every((e) => e.contractId !== target.contractId),
      'search still returns events from the pruned contract',
    );
    assertNoOrphans(path, 'after pruning a searchable contract');
  } finally {
    await store.close();
    await cleanup();
  }
});

test('[prune] pruning everything empties the side tables too', async () => {
  const { store, path, cleanup } = await seeded();
  try {
    // The decisive version: anything left in a side table here is a leak,
    // orphaned or not.
    const removed = await store.prune({ beforeLedger: Number.MAX_SAFE_INTEGER });
    assert.equal(removed, fixture.events.length);

    const after = inspect(path);
    assert.deepEqual(
      { events: after.events, addresses: after.addresses, topics: after.topics, fts: after.fts },
      { events: 0, addresses: 0, topics: 0, fts: 0 },
    );
  } finally {
    await store.close();
    await cleanup();
  }
});

test('[prune] an age-based prune resolves days against an injectable clock', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prune-age-'));
  const path = join(dir, 'lens.db');
  // The fixture's own close times, so the cutoff can be placed precisely
  // between two of them rather than relative to the real clock.
  const closes = fixture.events.map((e) => Math.floor(new Date(e.ledgerClosedAt).getTime() / 1000));
  const oldest = Math.min(...closes);
  const newest = Math.max(...closes);
  assert.ok(newest > oldest, 'the fixture needs more than one close time');

  // "Now" is 10 days after the newest event; a 10-day cutoff therefore lands
  // exactly on it, so everything strictly older goes and the newest stays.
  const nowSeconds = newest + 10 * 86_400;
  const store = new SqliteEventStore({ path, now: () => nowSeconds * 1000 });
  try {
    await store.insertEvents(fixture.events);
    const expected = closes.filter((c) => c < newest).length;

    const removed = await store.prune({ olderThanDays: 10 });
    assert.equal(removed, expected);

    const left = await store.queryEvents({ limit: 1000 });
    assert.ok(
      left.events.every((e) => Math.floor(new Date(e.ledgerClosedAt).getTime() / 1000) >= newest),
      'an event older than the cutoff survived',
    );
    assertNoOrphans(path, 'after an age-based prune');
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('[prune] a read-only store refuses to prune', async () => {
  const { store, path, cleanup } = await seeded();
  const reader = new SqliteEventStore({ path, readOnly: true });
  try {
    await assert.rejects(() => reader.prune({ contractId: 'C' }), /prune\(\) needs to write/);
  } finally {
    await reader.close();
    await store.close();
    await cleanup();
  }
});
