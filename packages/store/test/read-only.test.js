/**
 * Tests for #158: opening the store read-only.
 *
 * The option already opened the file with SQLite's read-only flag and skipped
 * migrations and the WAL pragma. What is asserted here is the half that was
 * missing — that a write fails with an error naming this store's own
 * configuration, rather than leaving SQLite to say `attempt to write a readonly
 * database`, or for `PRAGMA wal_checkpoint`, `disk I/O error`, which reads like
 * failing hardware.
 *
 * Offline, like every other suite: the committed fixture, no network.
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteEventStore } from '../dist/index.js';

const fixture = JSON.parse(
  readFileSync(new URL('../../../fixtures/testnet-events.json', import.meta.url), 'utf8'),
);

/** A migrated, seeded database file, plus the writer still open on it. */
async function seeded() {
  const dir = await mkdtemp(join(tmpdir(), 'read-only-'));
  const path = join(dir, 'lens.db');
  const writer = new SqliteEventStore({ path });
  await writer.insertEvents(fixture.events);
  return { path, writer, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('[read-only] reads are served normally', async () => {
  const { path, writer, cleanup } = await seeded();
  const store = new SqliteEventStore({ path, readOnly: true });
  try {
    assert.equal(store.readOnly, true);

    const page = await store.queryEvents({ limit: 5 });
    assert.equal(page.events.length, 5);
    assert.equal(page.total, fixture.events.length);

    const first = page.events[0];
    assert.deepEqual(await store.getEvent(first.id), first);
    assert.ok((await store.listContracts()).length > 0);
    assert.equal((await store.getStats()).eventCount, fixture.events.length);
    assert.equal((await store.healthCheck()).ok, true);
  } finally {
    await store.close();
    await writer.close();
    await cleanup();
  }
});

test('[read-only] every write method says the store is read-only, not what SQLite thinks', async () => {
  const { path, writer, cleanup } = await seeded();
  const store = new SqliteEventStore({ path, readOnly: true });
  const event = (await store.queryEvents({ limit: 1 })).events[0];

  const writes = {
    migrate: () => store.migrate(),
    migrateDown: () => store.migrateDown(0),
    insertEvents: () => store.insertEvents(fixture.events),
    insertDecoded: () => store.insertDecoded([event]),
    saveContractSpec: () =>
      store.saveContractSpec({
        contractId: event.contractId,
        source: 'none',
        entriesXdr: [],
        eventCount: 0,
        fetchedAt: new Date().toISOString(),
      }),
    saveStreamState: () =>
      store.saveStreamState({ key: 'k', cursor: '0-0', ledger: 1, updatedAt: new Date().toISOString() }),
    deleteEvents: () => store.deleteEvents([event.id]),
    pruneBefore: () => store.pruneBefore(Number.MAX_SAFE_INTEGER),
    pruneToSize: () => store.pruneToSize(1),
    redecode: () => store.redecode(true),
    repairRow: () => store.repairRow(event.id),
    rebuildSearchIndex: () => store.rebuildSearchIndex(),
    importSnapshot: () => store.importSnapshot(join(tmpdir(), 'unused.ndjson')),
    checkpoint: () => store.checkpoint('TRUNCATE'),
  };

  try {
    for (const [name, write] of Object.entries(writes)) {
      await assert.rejects(
        write,
        (error) => {
          assert.ok(error instanceof Error, `${name} threw a non-Error`);
          // Names the method, so a stack is not needed to find the caller.
          assert.match(error.message, new RegExp(`^${name}\\(\\) needs to write`), name);
          // Names the file, because "read-only" is only actionable with it.
          assert.ok(error.message.includes(path), `${name} did not name the database`);
          return true;
        },
        name,
      );
    }
  } finally {
    await store.close();
    await writer.close();
    await cleanup();
  }
});

test('[read-only] migrate() refuses even when the file is already current', async () => {
  // It would otherwise succeed by doing nothing, which is the one outcome that
  // cannot be distinguished from having migrated a read-only database.
  const { path, writer, cleanup } = await seeded();
  const store = new SqliteEventStore({ path, readOnly: true });
  try {
    assert.equal((await store.getStats()).schemaVersion > 0, true);
    await assert.rejects(() => store.migrate(), /opened read-only/);
  } finally {
    await store.close();
    await writer.close();
    await cleanup();
  }
});

test('[read-only] writeProbe reports no, rather than throwing', async () => {
  const { path, writer, cleanup } = await seeded();
  const store = new SqliteEventStore({ path, readOnly: true });
  try {
    // "Can this be written to" is the question writeProbe exists to answer, so
    // a read-only store is a legitimate no — `lens doctor` prints it.
    const probe = await store.writeProbe();
    assert.equal(probe.ok, false);
    assert.match(probe.detail, /read-only/);
  } finally {
    await store.close();
    await writer.close();
    await cleanup();
  }
});

test('[read-only] exportSnapshot still works, writing only to its destination', async () => {
  const { path, writer, cleanup } = await seeded();
  const dir = await mkdtemp(join(tmpdir(), 'read-only-out-'));
  const dest = join(dir, 'snapshot.ndjson');
  const store = new SqliteEventStore({ path, readOnly: true });
  try {
    // Exporting from a snapshot another process owns is a reason to open
    // read-only, not something to refuse: nothing is written to this store.
    assert.equal(await store.exportSnapshot(dest), fixture.events.length);
    assert.equal(readFileSync(dest, 'utf8').trim().split('\n').length, fixture.events.length);
  } finally {
    await store.close();
    await writer.close();
    await rm(dir, { recursive: true, force: true });
    await cleanup();
  }
});

test('[read-only] serves queries from a file another connection is writing', async () => {
  const { path, writer, cleanup } = await seeded();
  const store = new SqliteEventStore({ path, readOnly: true });
  try {
    assert.equal((await store.getStats()).eventCount, fixture.events.length);

    // The writer keeps going underneath it; WAL is what makes the new rows
    // visible to a reader that never reopens anything.
    const more = fixture.events.map((event, i) => ({
      ...event,
      id: `9999999999-${String(i).padStart(10, '0')}`,
    }));
    const added = await writer.insertEvents(more);
    assert.ok(added > 0);

    assert.equal((await store.getStats()).eventCount, fixture.events.length + added);
    const latest = await store.getLatestEventId();
    assert.ok(latest.startsWith('9999999999-'));
  } finally {
    await store.close();
    await writer.close();
    await cleanup();
  }
});

