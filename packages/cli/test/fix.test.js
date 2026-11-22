import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteEventStore, LATEST_SCHEMA_VERSION } from '@soroban-lens/store';
import { applyFixes, formatFixes, resolveConfig } from '../dist/index.js';

// #81 lens doctor --fix. These call applyFixes directly: the doctor checks
// that follow it in `lens doctor --fix` reach the RPC, and tests stay offline.

async function freshClone() {
  const dir = await mkdtemp(join(tmpdir(), 'lens-fix-'));
  await writeFile(join(dir, '.env.example'), 'LENS_NETWORK=testnet\n');
  const config = resolveConfig({ dataDir: join(dir, 'data'), db: join(dir, 'data', 'lens.db') }, {});
  return { dir, config };
}

const exists = (path) => access(path).then(() => true, () => false);

test('a fresh clone gets .env and data/, and says so', async () => {
  const { dir, config } = await freshClone();
  const actions = await applyFixes(config, { cwd: dir });

  assert.equal(await readFile(join(dir, '.env'), 'utf8'), 'LENS_NETWORK=testnet\n');
  assert.ok(await exists(join(dir, 'data')));
  assert.deepEqual(
    actions.map((a) => a.description.split(' ').slice(0, 2).join(' ')),
    ['created .env', 'created data'],
  );
  assert.match(formatFixes(actions), /\+  created \.env from \.env\.example/);
  await rm(dir, { recursive: true, force: true });
});

test('a second run has nothing to do', async () => {
  const { dir, config } = await freshClone();
  await applyFixes(config, { cwd: dir });
  const again = await applyFixes(config, { cwd: dir });
  assert.deepEqual(again, []);
  assert.match(formatFixes(again), /nothing to fix/);
  await rm(dir, { recursive: true, force: true });
});

test('an existing .env is never overwritten', async () => {
  const { dir, config } = await freshClone();
  await writeFile(join(dir, '.env'), 'LENS_RPC_URL=https://my-node.example\n');
  const actions = await applyFixes(config, { cwd: dir });
  assert.equal(await readFile(join(dir, '.env'), 'utf8'), 'LENS_RPC_URL=https://my-node.example\n');
  assert.ok(!actions.some((a) => a.description.includes('.env')));
  await rm(dir, { recursive: true, force: true });
});

test('with no .env.example there is nothing to copy, and no .env is invented', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-fix-'));
  const config = resolveConfig({ dataDir: join(dir, 'data'), db: join(dir, 'data', 'lens.db') }, {});
  await applyFixes(config, { cwd: dir });
  assert.equal(await exists(join(dir, '.env')), false);
  await rm(dir, { recursive: true, force: true });
});

test('pending migrations on an existing database are applied, and reported', async () => {
  const { dir, config } = await freshClone();
  await applyFixes(config, { cwd: dir });
  const store = new SqliteEventStore({ path: config.dbPath });
  await store.migrateDown(LATEST_SCHEMA_VERSION - 1);
  await store.close();

  const actions = await applyFixes(config, { cwd: dir });
  assert.deepEqual(actions.map((a) => a.description), [
    `migrated ${config.dbPath} from schema v${LATEST_SCHEMA_VERSION - 1} to v${LATEST_SCHEMA_VERSION}`,
  ]);

  const reopened = new SqliteEventStore({ path: config.dbPath, migrateOnOpen: false });
  assert.equal((await reopened.getStats()).schemaVersion, LATEST_SCHEMA_VERSION);
  await reopened.close();
  await rm(dir, { recursive: true, force: true });
});

test('a database that does not exist yet is left for the first open to create', async () => {
  const { dir, config } = await freshClone();
  const actions = await applyFixes(config, { cwd: dir });
  assert.equal(await exists(config.dbPath), false);
  assert.ok(!actions.some((a) => a.description.startsWith('migrated')));
  await rm(dir, { recursive: true, force: true });
});
