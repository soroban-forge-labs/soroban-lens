import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import {
  MIGRATIONS,
  POSTGRES_MIGRATIONS,
  LATEST_SCHEMA_VERSION,
  PostgresEventStore,
} from '../dist/index.js';

// These run offline: no Postgres, no `pg` package. The behavioural contract is
// covered by the shared suite in conformance.test.js when a database is available.

test('the Postgres migrations reach the same versions, with the same names, as SQLite', () => {
  assert.deepEqual(
    POSTGRES_MIGRATIONS.map((m) => [m.version, m.name]),
    MIGRATIONS.map((m) => [m.version, m.name]),
  );
  assert.equal(Math.max(...POSTGRES_MIGRATIONS.map((m) => m.version)), LATEST_SCHEMA_VERSION);
});

test('every Postgres migration can be rolled back', () => {
  for (const m of POSTGRES_MIGRATIONS) assert.ok(m.down, `migration ${m.version} has no down`);
});

test('the Postgres schema uses JSONB with a GIN index, and a bytewise id collation', () => {
  const v1 = POSTGRES_MIGRATIONS.find((m) => m.version === 1).up;
  assert.match(v1, /topics_json\s+JSONB/);
  assert.match(v1, /value_json\s+JSONB/);
  assert.match(v1, /USING GIN \(topics_json/);
  assert.match(v1, /id\s+TEXT COLLATE "C" PRIMARY KEY/);
});

/** A pool that records every query and answers with canned rows. */
function recordingPool(rowsFor = () => []) {
  const calls = [];
  const pool = {
    calls,
    async query(text, values = []) {
      calls.push({ text, values });
      const rows = rowsFor(text);
      return { rows, rowCount: rows.length };
    },
    async connect() {
      return { query: pool.query, release() {} };
    },
    async end() {},
  };
  return pool;
}

test('queryEvents numbers its placeholders and keeps filters, cursor and limit in order', async () => {
  const pool = recordingPool((text) => (text.includes('COUNT(*)') ? [{ n: 0 }] : []));
  const store = new PostgresEventStore(pool, { countCacheTtlMs: 0 });

  await store.queryEvents({ contractId: 'CABC', fromLedger: 10, topics: ['transfer'], cursor: 'ID9', limit: 5 });

  const select = pool.calls.find((c) => c.text.includes('SELECT * FROM events'));
  assert.ok(select);
  assert.match(select.text, /contract_id = \$1 AND ledger >= \$2 AND topic0 = \$3/);
  assert.match(select.text, /AND id < \$4 ORDER BY id DESC LIMIT \$5/);
  assert.deepEqual(select.values, ['CABC', 10, 'transfer', 'ID9', 6]);
});

test('queryEvents escapes LIKE metacharacters in a search term', async () => {
  const pool = recordingPool((text) => (text.includes('COUNT(*)') ? [{ n: 0 }] : []));
  const store = new PostgresEventStore(pool, { countCacheTtlMs: 0 });

  await store.queryEvents({ search: '50%_off\\' });

  const select = pool.calls.find((c) => c.text.includes('SELECT * FROM events'));
  assert.match(select.text, /topics_json::text ILIKE \$1 OR value_json::text ILIKE \$1/);
  assert.equal(select.values[0], '%50\\%\\_off\\\\%');
});

test('queryEvents filters typed values with parameterized text and numeric predicates', async () => {
  const pool = recordingPool((text) => (text.includes('COUNT(*)') ? [{ n: 0 }] : []));
  const store = new PostgresEventStore(pool, { countCacheTtlMs: 0 });

  await store.queryEvents({
    typedField: 'amount',
    typedValue: '1000',
    typedGte: '1000',
    typedLt: '9000',
  });

  const select = pool.calls.find((call) => call.text.includes('SELECT * FROM events'));
  assert.ok(select);
  assert.match(select.text, /id IN \(SELECT event_id FROM typed_event_fields WHERE field_name = \$1 AND text_value = \$2 AND numeric_value >= \$3::BIGINT AND numeric_value < \$4::BIGINT\)/);
  assert.deepEqual(select.values, ['amount', '1000', '1000', '9000', 51]);
});

test('insertEvents is idempotent SQL in one transaction, indexing addresses only for new rows', async () => {
  const fixture = JSON.parse(
    readFileSync(new URL('../../../fixtures/testnet-events.json', import.meta.url), 'utf8'),
  );
  // Report one row inserted for the events INSERT, as a fresh (non-duplicate) event would.
  const pool = recordingPool((text) => (text.includes('INSERT INTO events') ? [{}] : []));
  const store = new PostgresEventStore(pool);

  assert.equal(await store.insertEvents([fixture.events[0]]), 1);

  const texts = pool.calls.map((c) => c.text.trim());
  assert.equal(texts[0], 'BEGIN');
  assert.equal(texts.at(-1), 'COMMIT');
  assert.ok(texts.some((t) => /ON CONFLICT \(id\) DO NOTHING/.test(t)), 'replays must be absorbed by the id');

  // A duplicate (rowCount 0) must not re-run address extraction.
  const dupPool = recordingPool();
  assert.equal(await new PostgresEventStore(dupPool).insertEvents([fixture.events[0]]), 0);
  assert.ok(!dupPool.calls.some((c) => c.text.includes('event_addresses')));
});

test('insertDecoded on an empty batch does not touch the database', async () => {
  const pool = recordingPool();
  assert.equal(await new PostgresEventStore(pool).insertDecoded([]), 0);
  assert.equal(pool.calls.length, 0);
});

test('connect() without a connection string or pool is a clear error', async () => {
  await assert.rejects(() => PostgresEventStore.connect({}), /connectionString/);
});

test('connect() rejects a schema name that is not a plain identifier', async () => {
  await assert.rejects(
    () => PostgresEventStore.connect({ connectionString: 'postgres://x', schema: 'a"; DROP TABLE events; --' }),
    /invalid schema name/,
  );
});
