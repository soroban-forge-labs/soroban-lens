import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { SqliteEventStore, PooledSqliteEventStore, PostgresEventStore, runEventStoreSuite } from '../dist/index.js';

const fixture = JSON.parse(
  readFileSync(new URL('../../../fixtures/testnet-events.json', import.meta.url), 'utf8'),
);

/**
 * One parameterised run (#38, #22): the same shared suite against every
 * backend. The suite itself does not know or care which backend it is running
 * against, so adding a backend means adding one entry here.
 */
runEventStoreSuite({
  name: 'SqliteEventStore',
  fixtureEvents: fixture.events,
  createStore: async () => {
    // A fresh on-disk file per test rather than ':memory:', matching how
    // this store is actually run in production.
    const dir = await mkdtemp(join(tmpdir(), 'event-store-suite-'));
    return new SqliteEventStore({ path: join(dir, 'lens.db') });
  },
});

// The same suite again, with every read served by a worker thread (#159). It
// is the whole point of the pooled store that this needs no special casing:
// same trait, same assertions, same fixture.
//
// poolSize 1 deliberately. `createStore` runs once per test, so the suite
// builds one store per test and size 2 would mean twice the threads for no
// extra coverage — the concurrency itself is tested in pooled-store.test.js.
runEventStoreSuite({
  name: 'PooledSqliteEventStore',
  fixtureEvents: fixture.events,
  createStore: async () => {
    const dir = await mkdtemp(join(tmpdir(), 'event-store-pool-suite-'));
    return PooledSqliteEventStore.open({ path: join(dir, 'lens.db'), poolSize: 1 });
  },
});

// Postgres is opt-in so the default `npm test` keeps its offline guarantee.
// `docker compose -f docker-compose.postgres.yml up --build` runs this with a
// throwaway database; against your own, set LENS_TEST_POSTGRES_URL (and have
// `pg` installed — it is an optional peer dependency).
const postgresUrl = process.env.LENS_TEST_POSTGRES_URL;

if (!postgresUrl) {
  test('[PostgresEventStore] conformance suite', { skip: 'set LENS_TEST_POSTGRES_URL to run it' }, () => {});
} else {
  const schemas = [];

  runEventStoreSuite({
    name: 'PostgresEventStore',
    fixtureEvents: fixture.events,
    createStore: async () => {
      // A schema per test: isolated, and dropped wholesale afterwards.
      const schema = `lens_test_${randomUUID().replaceAll('-', '')}`;
      schemas.push(schema);
      return PostgresEventStore.connect({ connectionString: postgresUrl, schema, max: 2 });
    },
  });

  after(async () => {
    const pg = await import('pg');
    const Pool = pg.Pool ?? pg.default.Pool;
    const pool = new Pool({ connectionString: postgresUrl, max: 1 });
    try {
      for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await pool.end();
    }
  });
}
