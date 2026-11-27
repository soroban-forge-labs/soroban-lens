/**
 * SQLite-specific half of #153: what the planner does with a topic position.
 *
 * The shared conformance suite covers the behaviour every backend owes — the
 * default being unchanged, a later position returning the addresses, the
 * position bounds. What it cannot cover is the query plan, which is this
 * backend's own business.
 *
 * #153 says to add an index "only if EXPLAIN QUERY PLAN shows a full scan", so
 * the plan is the deciding evidence and worth asserting rather than checking
 * once by hand: positions 1-3 have no covering index of their own and are
 * served by narrowing on `contract_id` first. If that ever degrades to a table
 * scan, this fails and the index question reopens.
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

/** The Stellar Asset Contract in the fixture: the one with transfers. */
const SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

async function seeded() {
  const dir = await mkdtemp(join(tmpdir(), 'topics-'));
  const path = join(dir, 'lens.db');
  const store = new SqliteEventStore({ path });
  await store.insertEvents(fixture.events);
  return { store, path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** The same SQL listTopics runs, so the plan asserted is the plan used. */
function planFor(path, position) {
  const column = `topic${position}`;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT ${column} AS topic, COUNT(*) AS count
         FROM events
         WHERE contract_id = ? AND ${column} IS NOT NULL
         GROUP BY ${column}
         ORDER BY count DESC
         LIMIT ?`,
      )
      .all(SAC, 50)
      .map((step) => step.detail);
  } finally {
    db.close();
  }
}

test('[topics] no position falls back to a full table scan', async () => {
  const { store, path, cleanup } = await seeded();
  try {
    for (const position of [0, 1, 2, 3]) {
      const plan = planFor(path, position);
      const scans = plan.filter((detail) => detail.startsWith('SCAN '));
      assert.deepEqual(
        scans,
        [],
        `position ${position} plans a full scan, so #153's index question reopens:\n  ${plan.join('\n  ')}`,
      );
      assert.ok(
        plan.some((detail) => detail.includes('USING') && detail.includes('INDEX')),
        `position ${position} does not use an index:\n  ${plan.join('\n  ')}`,
      );
    }
  } finally {
    await store.close();
    await cleanup();
  }
});

test('[topics] position 0 is served by its covering index, later ones narrow on the contract', async () => {
  const { store, path, cleanup } = await seeded();
  try {
    // Recorded so the asymmetry is visible rather than folklore: topic0 has
    // idx_events_contract_topic0 and the others do not, which is why they pay
    // for a temp B-tree to group. Measured at 40k rows for one contract, that
    // was about 5ms against 33ms. No index was added: a covering index per
    // position would cost three more writes on every insert, and the plans
    // above are index searches rather than scans.
    assert.ok(
      planFor(path, 0).some((d) => d.includes('idx_events_contract_topic0')),
      'topic0 lost its covering index',
    );
    for (const position of [1, 2, 3]) {
      const plan = planFor(path, position);
      assert.ok(
        plan.some((d) => d.includes('idx_events_contract_id_desc')),
        `position ${position} no longer narrows on contract_id first:\n  ${plan.join('\n  ')}`,
      );
    }
  } finally {
    await store.close();
    await cleanup();
  }
});

test('[topics] the fixture SAC reports addresses past position 0, not event names', async () => {
  const { store, cleanup } = await seeded();
  try {
    // The concrete form of #153's "done when", on the real fixture.
    //
    // `G…` or `C…`: a Stellar address is an account or a contract, and this
    // fixture has both — one of the two transfers was sent by a contract. An
    // assertion of "starts with G" passes on 17 of the 18 values and is wrong.
    const isAddress = (value) => /^[GC][A-Z2-7]{55}$/.test(value);

    const senders = await store.listTopics(SAC, { position: 1 });
    assert.ok(senders.length > 1, 'expected several distinct addresses at topic1');
    assert.ok(
      senders.every((t) => isAddress(t.topic)),
      `topic1 should hold addresses, got ${JSON.stringify(senders.filter((t) => !isAddress(t.topic)))}`,
    );

    const receivers = await store.listTopics(SAC, { position: 2 });
    assert.ok(receivers.length > 0, 'expected addresses at topic2');
    assert.ok(receivers.every((t) => isAddress(t.topic)));

    // Position 0 is the event names, which is what made the issue worth
    // filing: counting it answers "what kinds of event", never "who".
    const names = await store.listTopics(SAC);
    assert.ok(
      names.every((t) => !isAddress(t.topic)),
      `topic0 should hold event names, got ${JSON.stringify(names)}`,
    );
    assert.ok(
      names.some((t) => t.topic === 'transfer'),
      `expected a transfer event, got ${JSON.stringify(names)}`,
    );
  } finally {
    await store.close();
    await cleanup();
  }
});
