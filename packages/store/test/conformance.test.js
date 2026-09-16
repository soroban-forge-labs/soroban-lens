import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteEventStore, runEventStoreSuite } from '../dist/index.js';

const fixture = JSON.parse(
  readFileSync(new URL('../../../fixtures/testnet-events.json', import.meta.url), 'utf8'),
);

/**
 * SQLite runs the shared conformance suite (#38). A hypothetical Postgres
 * backend (#22) would add a second file exactly like this one — same import,
 * same fixture, a factory pointed at its own connection — and call
 * runEventStoreSuite() unchanged; the suite itself does not know or care
 * which backend it is running against.
 */
runEventStoreSuite({
  name: 'SqliteEventStore',
  fixtureEvents: fixture.events,
  createStore: async () => {
    // A fresh on-disk file per test rather than ':memory:', matching how
    // this store is actually run in production — checked, not assumed:
    // VACUUM INTO works fine from :memory: too, so :memory: would have been
    // an equally valid choice for this suite specifically.
    const dir = await mkdtemp(join(tmpdir(), 'event-store-suite-'));
    return new SqliteEventStore({ path: join(dir, 'lens.db') });
  },
});
