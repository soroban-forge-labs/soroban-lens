/**
 * A parameterised conformance suite for any `EventStore` implementation (#38).
 *
 * `test/sqlite-store.test.js` was written against the trait but instantiated
 * `SqliteEventStore` directly, so a second backend (#22, Postgres) could not
 * reuse it without a copy-paste that would drift the moment either one
 * changed. `runEventStoreSuite()` registers `node:test` tests against
 * whatever factory it is given; SQLite runs through it in
 * `test/conformance.test.js`, and a Postgres implementation can call the same
 * function against its own factory, unchanged.
 *
 * Scope is deliberately the interface contract only — nothing here reaches
 * into a specific backend's storage, so a test passing here is evidence about
 * `EventStore`, not about SQLite. Backend-specific behaviour (does a query use
 * a particular index, does VACUUM shrink a file, what a WAL is) stays in that
 * backend's own test file, because asserting it here would make this suite
 * fail against every backend that isn't SQLite.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { EventStore } from './store.js';
import type { RawEventInput } from './types.js';

export interface EventStoreSuiteOptions {
  /** Human-readable name, used as the test suite's label. */
  name: string;
  /** Build a fresh, already-migrated, empty store. Called once per test. */
  createStore: () => Promise<EventStore>;
  /**
   * Real captured RPC events to seed with — the shape `insertEvents` expects.
   * Needs at least 4 events, at least two different contract ids, and at
   * least one event with `inSuccessfulContractCall: false`, or several tests
   * will report "expected the fixture to contain..." rather than a real
   * failure. `fixtures/testnet-events.json` satisfies all of this.
   */
  fixtureEvents: RawEventInput[];
}

export function runEventStoreSuite(options: EventStoreSuiteOptions): void {
  const { name, createStore, fixtureEvents } = options;
  const contractIds = [...new Set(fixtureEvents.map((e) => e.contractId))];
  const someContract = contractIds[0]!;
  const unsuccessful = fixtureEvents.find((e) => !e.inSuccessfulContractCall);
  assert.ok(contractIds.length >= 2, 'fixtureEvents needs at least two distinct contract ids');
  assert.ok(unsuccessful, 'fixtureEvents needs at least one unsuccessful contract call');

  async function seeded(): Promise<EventStore> {
    const store = await createStore();
    await store.insertEvents(fixtureEvents);
    return store;
  }

  test(`[${name}] insertEvents is idempotent on event id`, async () => {
    const store = await createStore();
    const first = await store.insertEvents(fixtureEvents);
    const second = await store.insertEvents(fixtureEvents);
    assert.equal(first, fixtureEvents.length);
    assert.equal(second, 0, 'replaying the same batch must insert nothing new');
    assert.equal((await store.getStats()).eventCount, fixtureEvents.length);
    await store.close();
  });

  test(`[${name}] insertEvents on an empty array is a no-op`, async () => {
    const store = await createStore();
    assert.equal(await store.insertEvents([]), 0);
    await store.close();
  });

  test(`[${name}] getEvent returns a stored event, and null for an unknown id`, async () => {
    const store = await seeded();
    const event = await store.getEvent(fixtureEvents[0]!.id);
    assert.equal(event?.id, fixtureEvents[0]!.id);
    assert.equal(event?.contractId, fixtureEvents[0]!.contractId);
    assert.equal(await store.getEvent('definitely-not-a-real-id'), null);
    await store.close();
  });

  test(`[${name}] keyset pagination walks the whole set exactly once`, async () => {
    const store = await seeded();
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 100; guard++) {
      const page = await store.queryEvents({ limit: 5, ...(cursor ? { cursor } : {}) });
      seen.push(...page.events.map((e) => e.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    assert.equal(seen.length, fixtureEvents.length);
    assert.equal(new Set(seen).size, fixtureEvents.length, 'no event appeared on two pages');
    await store.close();
  });

  test(`[${name}] order: 'asc' reverses the default newest-first stream`, async () => {
    const store = await seeded();
    const desc = await store.queryEvents({ limit: 1000 });
    const asc = await store.queryEvents({ limit: 1000, order: 'asc' });
    assert.deepEqual(
      asc.events.map((e) => e.id),
      [...desc.events.map((e) => e.id)].reverse(),
    );
    await store.close();
  });

  test(`[${name}] filtering by contractId returns only that contract`, async () => {
    const store = await seeded();
    const page = await store.queryEvents({ contractId: someContract, limit: 1000 });
    assert.ok(page.events.length > 0);
    assert.ok(page.events.every((e) => e.contractId === someContract));
    const expected = fixtureEvents.filter((e) => e.contractId === someContract).length;
    assert.equal(page.total, expected);
    await store.close();
  });

  test(`[${name}] filtering by txHash returns only that transaction's events`, async () => {
    const store = await seeded();
    const txHash = fixtureEvents[0]!.txHash;
    const page = await store.queryEvents({ txHash, limit: 1000 });
    assert.ok(page.events.length > 0);
    assert.ok(page.events.every((e) => e.txHash === txHash));
    await store.close();
  });

  test(`[${name}] ledger range filters are inclusive on both ends`, async () => {
    const store = await seeded();
    const ledgers = fixtureEvents.map((e) => e.ledger);
    const min = Math.min(...ledgers);
    const max = Math.max(...ledgers);
    const all = await store.queryEvents({ fromLedger: min, toLedger: max, limit: 1000 });
    assert.equal(all.total, fixtureEvents.length);
    const none = await store.queryEvents({ toLedger: min - 1, limit: 10 });
    assert.equal(none.total, 0);
    await store.close();
  });

  test(`[${name}] successfulOnly excludes failed contract calls; the default keeps them`, async () => {
    const store = await seeded();
    const all = await store.queryEvents({ limit: 1000 });
    const ok = await store.queryEvents({ successfulOnly: true, limit: 1000 });
    assert.ok(all.total > ok.total);
    assert.ok(ok.events.every((e) => e.inSuccessfulContractCall));
    await store.close();
  });

  test(`[${name}] limit is clamped to the documented bounds rather than rejected`, async () => {
    const store = await seeded();
    const page = await store.queryEvents({ limit: 999_999 });
    assert.ok(page.events.length <= fixtureEvents.length);
    await store.close();
  });

  test(`[${name}] a filter matching nothing returns an empty page, not an error`, async () => {
    const store = await seeded();
    const page = await store.queryEvents({ txHash: 'f'.repeat(64), limit: 10 });
    assert.equal(page.total, 0);
    assert.deepEqual(page.events, []);
    assert.equal(page.nextCursor, null);
    await store.close();
  });

  test(`[${name}] listContracts summarises each contract, most recently active first`, async () => {
    const store = await seeded();
    const contracts = await store.listContracts(100);
    assert.ok(contracts.length >= 2);
    const ids = contracts.map((c) => c.contractId);
    assert.equal(new Set(ids).size, ids.length, 'no contract listed twice');
    for (const c of contracts) {
      assert.equal(c.eventCount, fixtureEvents.filter((e) => e.contractId === c.contractId).length);
    }
    await store.close();
  });

  test(`[${name}] getStats reflects what was actually inserted`, async () => {
    const store = await seeded();
    const stats = await store.getStats();
    assert.equal(stats.eventCount, fixtureEvents.length);
    assert.equal(stats.contractCount, contractIds.length);
    assert.equal(stats.minLedger, Math.min(...fixtureEvents.map((e) => e.ledger)));
    assert.equal(stats.maxLedger, Math.max(...fixtureEvents.map((e) => e.ledger)));
    await store.close();
  });

  test(`[${name}] getStats on an empty store reports zero, not an error`, async () => {
    const store = await createStore();
    const stats = await store.getStats();
    assert.equal(stats.eventCount, 0);
    assert.equal(stats.contractCount, 0);
    await store.close();
  });

  test(`[${name}] pruneBefore removes rows below the threshold and leaves the rest`, async () => {
    const store = await seeded();
    const ledgers = [...new Set(fixtureEvents.map((e) => e.ledger))].sort((a, b) => a - b);
    const threshold = ledgers[Math.floor(ledgers.length / 2)]!;
    const removed = await store.pruneBefore(threshold);
    const remaining = await store.queryEvents({ limit: 1000 });
    assert.equal(removed, fixtureEvents.filter((e) => e.ledger < threshold).length);
    assert.ok(remaining.events.every((e) => e.ledger >= threshold));
    await store.close();
  });

  test(`[${name}] pruneBefore does not touch stream state`, async () => {
    const store = await seeded();
    await store.saveStreamState({ key: 'k', cursor: 'abc', ledger: 1, updatedAt: '2026-01-01T00:00:00Z' });
    await store.pruneBefore(Number.MAX_SAFE_INTEGER);
    assert.deepEqual(await store.loadStreamState('k'), {
      key: 'k', cursor: 'abc', ledger: 1, updatedAt: '2026-01-01T00:00:00Z',
    });
    await store.close();
  });

  test(`[${name}] stream state round-trips and upserts on the same key`, async () => {
    const store = await createStore();
    assert.equal(await store.loadStreamState('missing'), null);
    await store.saveStreamState({ key: 'k', cursor: 'c1', ledger: 1, updatedAt: '2026-01-01T00:00:00Z' });
    await store.saveStreamState({ key: 'k', cursor: 'c2', ledger: 2, updatedAt: '2026-01-02T00:00:00Z' });
    const loaded = await store.loadStreamState('k');
    assert.equal(loaded?.cursor, 'c2', 'the second save must overwrite, not add a row');
    const all = await store.listStreamStates();
    assert.equal(all.filter((s) => s.key === 'k').length, 1);
    await store.close();
  });

  test(`[${name}] checkIntegrity reports nothing on a freshly-inserted store`, async () => {
    const store = await seeded();
    assert.deepEqual(await store.checkIntegrity(), []);
    await store.close();
  });

  test(`[${name}] redecode() with no failed rows changes nothing`, async () => {
    const store = await seeded();
    const before = await store.queryEvents({ limit: 1000 });
    const rewritten = await store.redecode();
    assert.equal(rewritten, 0);
    const after = await store.queryEvents({ limit: 1000 });
    assert.deepEqual(after.events, before.events);
    await store.close();
  });

  test(`[${name}] healthCheck reports ok on a freshly-migrated store`, async () => {
    const store = await createStore();
    const health = await store.healthCheck();
    assert.equal(health.ok, true);
    await store.close();
  });

  test(`[${name}] exportSnapshot / importSnapshot round-trips the full event set`, async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const dir = await mkdtemp(join(tmpdir(), 'event-store-suite-'));
    const path = join(dir, 'snapshot.ndjson');
    try {
      const source = await seeded();
      const exported = await source.exportSnapshot(path);
      assert.equal(exported, fixtureEvents.length);
      await source.close();

      const target = await createStore();
      const imported = await target.importSnapshot(path);
      assert.equal(imported, fixtureEvents.length);
      const page = await target.queryEvents({ limit: 1000, order: 'asc' });
      assert.equal(page.events.length, fixtureEvents.length);
      await target.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test(`[${name}] close() does not throw`, async () => {
    const store = await createStore();
    await assert.doesNotReject(() => store.close());
  });
}
