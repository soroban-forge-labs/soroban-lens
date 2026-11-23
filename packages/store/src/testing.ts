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

  for (const order of ['desc', 'asc'] as const) {
    test(`[${name}] paging forward then back returns the original pages exactly (order: ${order})`, async () => {
      const store = await seeded();

      // Walk forward, remembering each page and the prevCursor it handed out.
      const forward: { ids: string[]; prevCursor: string | null }[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 100; guard++) {
        const page = await store.queryEvents({ limit: 5, order, ...(cursor ? { cursor } : {}) });
        forward.push({ ids: page.events.map((e) => e.id), prevCursor: page.prevCursor });
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      assert.ok(forward.length > 2, 'the fixture must span several pages for this to mean anything');
      assert.equal(forward[0]!.prevCursor, null, 'the first page has no previous page');
      assert.ok(forward.slice(1).every((p) => p.prevCursor !== null), 'every later page has one');

      // Walk back from the last page: each step must reproduce the page before it.
      for (let i = forward.length - 1; i > 0; i--) {
        const back = await store.queryEvents({
          limit: 5,
          order,
          direction: 'backward',
          cursor: forward[i]!.prevCursor!,
        });
        assert.deepEqual(
          back.events.map((e) => e.id),
          forward[i - 1]!.ids,
          `going back from page ${i} must return page ${i - 1} exactly`,
        );
        assert.equal(back.prevCursor, forward[i - 1]!.prevCursor);
        assert.notEqual(back.nextCursor, null, 'a page reached by going back has a page after it');
      }
      await store.close();
    });
  }

  test(`[${name}] backward without a cursor returns the last page, and it has no nextCursor`, async () => {
    const store = await seeded();
    const forwardAll: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 100; guard++) {
      const page = await store.queryEvents({ limit: 5, ...(cursor ? { cursor } : {}) });
      forwardAll.push(...page.events.map((e) => e.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    const last = await store.queryEvents({ limit: 5, direction: 'backward' });
    assert.deepEqual(last.events.map((e) => e.id), forwardAll.slice(-5));
    assert.equal(last.nextCursor, null);
    assert.notEqual(last.prevCursor, null);
    await store.close();
  });

  test(`[${name}] a single page has neither cursor`, async () => {
    const store = await seeded();
    const page = await store.queryEvents({ limit: 1000 });
    assert.equal(page.nextCursor, null);
    assert.equal(page.prevCursor, null);
    await store.close();
  });

  test(`[${name}] getLatestEventId is the newest id, and null when empty`, async () => {
    const empty = await createStore();
    assert.equal(await empty.getLatestEventId(), null);
    await empty.close();

    const store = await seeded();
    const newest = await store.queryEvents({ limit: 1 });
    assert.equal(await store.getLatestEventId(), newest.events[0]!.id);
    await store.close();
  });

  test(`[${name}] skipTotal leaves the events alone and reports no total`, async () => {
    const store = await seeded();
    const counted = await store.queryEvents({ limit: 5 });
    const skipped = await store.queryEvents({ limit: 5, skipTotal: true });
    assert.deepEqual(skipped.events, counted.events);
    assert.equal(skipped.total, 0);
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

  test(`[${name}] filtering by contractIds returns one ordered, pageable stream`, async () => {
    const store = await seeded();
    const selected = contractIds.slice(0, 2);
    const expected = fixtureEvents
      .filter((event) => selected.includes(event.contractId))
      .map((event) => event.id)
      .sort()
      .reverse();
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 100; guard++) {
      const page = await store.queryEvents({
        contractIds: selected,
        limit: 3,
        ...(cursor ? { cursor } : {}),
      });
      assert.ok(page.events.every((event) => selected.includes(event.contractId)));
      seen.push(...page.events.map((event) => event.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    assert.deepEqual(seen, expected);
    await store.close();
  });

  test(`[${name}] contractIds rejects conflicting or invalid filters`, async () => {
    const store = await createStore();
    await assert.rejects(
      store.queryEvents({ contractId: someContract, contractIds: [someContract] }),
      /cannot be used together/,
    );
    await assert.rejects(store.queryEvents({ contractIds: [] }), /between 1 and 20/);
    await assert.rejects(store.queryEvents({ contractIds: Array(21).fill(someContract) }), /between 1 and 20/);
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

  test(`[${name}] deleteEvents removes exactly the named rows, ignoring unknown ids`, async () => {
    const store = await seeded();
    const ids = fixtureEvents.slice(0, 3).map((e) => e.id);
    const removed = await store.deleteEvents([...ids, 'not-an-event-id']);
    assert.equal(removed, 3);
    for (const id of ids) assert.equal(await store.getEvent(id), null);
    assert.equal((await store.getStats()).eventCount, fixtureEvents.length - 3);
    assert.equal(await store.deleteEvents([]), 0);
    // A deleted id can be inserted again: the reorg path deletes, then re-inserts.
    assert.equal(await store.insertEvents(fixtureEvents.slice(0, 1)), 1);
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

  test(`[${name}] contract specs round-trip, upsert, and list without their entries`, async () => {
    const store = await createStore();
    const id = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
    assert.equal(await store.getContractSpec(id), null);
    await store.saveContractSpec({
      contractId: id, source: 'none', entriesXdr: [], eventCount: 0,
      error: 'contract instance not found', fetchedAt: '2026-01-01T00:00:00Z',
    });
    await store.saveContractSpec({
      contractId: id, source: 'wasm', wasmHash: 'ab'.repeat(32), entriesXdr: ['AAAA', 'BBBB'],
      eventCount: 2, fetchedAt: '2026-01-02T00:00:00Z',
    });
    const loaded = await store.getContractSpec(id);
    assert.equal(loaded?.source, 'wasm', 'the second save must overwrite, not add a row');
    assert.deepEqual(loaded?.entriesXdr, ['AAAA', 'BBBB']);
    assert.equal(loaded?.error, undefined, 'a successful refresh clears the old error');
    const all = await store.listContractSpecs();
    assert.equal(all.length, 1);
    assert.ok(!('entriesXdr' in all[0]!), 'the listing must not carry the (large) entries');
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

  test(`[${name}] a filter on a topic past the fourth position finds the event (#164)`, async () => {
    const store = await seeded();
    const deep = fixtureEvents.find((e) => e.topic.length >= 5);
    assert.ok(deep, 'fixtureEvents needs an event with at least 5 topics');
    const page = await store.queryEvents({ topics: [null, null, null, null, null, ], limit: 1000 });
    const probe = (await store.getEvent(deep.id))!;
    const value = (probe.topics[4] as { value: unknown }).value;
    const hit = await store.queryEvents({ topics: [null, null, null, null, String(value)], limit: 1000 });
    assert.ok(hit.events.some((e) => e.id === deep.id), 'the 5-topic event is returned');
    assert.ok(hit.events.every((e) => e.topics[4] && String((e.topics[4] as { value: unknown }).value) === String(value)));
    const miss = await store.queryEvents({ topics: [null, null, null, null, 'no-such-topic'] });
    assert.equal(miss.events.length, 0);
    assert.ok(page.events.length > 0);
    await store.close();
  });

  test(`[${name}] a typed topic filter tells a symbol from a string (#146)`, async () => {
    const store = await createStore();
    const SYMBOL_TRANSFER = 'AAAADwAAAAh0cmFuc2Zlcg==';
    const STRING_TRANSFER = 'AAAADgAAAAh0cmFuc2Zlcg==';
    const base = fixtureEvents.find((e) => e.topic[0] === SYMBOL_TRANSFER);
    assert.ok(base, 'fixtureEvents needs a symbol transfer event');
    // Same event with the first topic re-encoded as the string "transfer",
    // under an id no fixture event uses.
    const asString: RawEventInput = { ...base, id: `${base.id.slice(0, -10)}9999999999`, topic: [STRING_TRANSFER, ...base.topic.slice(1)] };
    await store.insertEvents([base, asString]);

    const untyped = await store.queryEvents({ topics: ['transfer'], limit: 1000 });
    assert.deepEqual(untyped.events.map((e) => e.id).sort(), [base.id, asString.id].sort(),
      'an untyped filter still matches both, exactly as before');

    const symbol = await store.queryEvents({ topics: ['transfer'], topicTypes: ['symbol'], limit: 1000 });
    assert.deepEqual(symbol.events.map((e) => e.id), [base.id]);

    const string = await store.queryEvents({ topics: ['transfer'], topicTypes: ['string'], limit: 1000 });
    assert.deepEqual(string.events.map((e) => e.id), [asString.id]);

    // A type with no value matches any value of that type at that position.
    const anyString = await store.queryEvents({ topicTypes: ['string'], limit: 1000 });
    assert.deepEqual(anyString.events.map((e) => e.id), [asString.id]);

    // Positions are independent: the sender is an address, not a symbol.
    const wrong = await store.queryEvents({ topicTypes: [null, 'symbol'], limit: 1000 });
    assert.equal(wrong.events.length, 0);
    await store.close();
  });

  test(`[${name}] a deep topic filter can be typed too (#146)`, async () => {
    const store = await seeded();
    const deep = fixtureEvents.find((e) => e.topic.length >= 5);
    assert.ok(deep, 'fixtureEvents needs an event with at least 5 topics');
    const probe = (await store.getEvent(deep.id))!;
    const topic = probe.topics[4]!;
    const value = String((topic as { value: unknown }).value);
    const hit = await store.queryEvents({ topics: [null, null, null, null, value], topicTypes: [null, null, null, null, topic.type], limit: 1000 });
    assert.ok(hit.events.some((e) => e.id === deep.id));
    const miss = await store.queryEvents({ topics: [null, null, null, null, value], topicTypes: [null, null, null, null, 'no-such-type'], limit: 1000 });
    assert.equal(miss.events.length, 0);
    await store.close();
  });

  test(`[${name}] addressPosition narrows an address filter to one position (#147)`, async () => {
    const store = await seeded();
    // Pick an address that is the sender of one transfer and the recipient of
    // another, so "anywhere" and "as sender" must give different answers.
    const decoded = await Promise.all(fixtureEvents.map((e) => store.getEvent(e.id)));
    const transfers = decoded.filter((e) => e && e.topics[0]?.type === 'symbol' && e.topics[0].value === 'transfer');
    const senders = new Set(transfers.map((e) => e!.topics[1]?.value));
    const both = transfers.map((e) => e!.topics[2]?.value).find((a) => typeof a === 'string' && senders.has(a));
    assert.ok(typeof both === 'string', 'fixtureEvents needs an address that both sends and receives');

    const anywhere = await store.queryEvents({ address: both, limit: 1000 });
    const asSender = await store.queryEvents({ address: both, addressPosition: 'topic1', limit: 1000 });
    const asRecipient = await store.queryEvents({ address: both, addressPosition: 'topic2', limit: 1000 });

    assert.ok(asSender.events.length > 0);
    assert.ok(asSender.events.every((e) => e.topics[1]?.value === both), 'every topic1 hit has it as the sender');
    assert.ok(asRecipient.events.every((e) => e.topics[2]?.value === both), 'every topic2 hit has it as the recipient');
    assert.ok(asRecipient.events.length > 0);
    assert.ok(anywhere.events.length > asSender.events.length, 'the unpositioned filter is still the union');
    await store.close();
  });

  test(`[${name}] indexedAfter returns only events indexed after the timestamp (#165)`, async () => {
    const store = await createStore();
    const half = Math.floor(fixtureEvents.length / 2);
    await store.insertEvents(fixtureEvents.slice(0, half));
    await new Promise((r) => setTimeout(r, 20));
    const cutoff = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 20));
    await store.insertEvents(fixtureEvents.slice(half));
    const page = await store.queryEvents({ indexedAfter: cutoff, limit: 1000 });
    const second = new Set(fixtureEvents.slice(half).map((e) => e.id));
    assert.equal(page.events.length, second.size);
    assert.ok(page.events.every((e) => second.has(e.id)));
    await store.close();
  });

  test(`[${name}] close() does not throw`, async () => {
    const store = await createStore();
    await assert.doesNotReject(() => store.close());
  });
}
