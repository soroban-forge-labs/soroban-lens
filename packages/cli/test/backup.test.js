import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteEventStore } from '@soroban-lens/store';

// #91 lens backup / lens restore.

const run = promisify(execFile);
const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
// seed's default fixture path is relative to the repo root.
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const FIXTURE = fileURLToPath(new URL('../../../fixtures/testnet-events.json', import.meta.url));

async function cli(args) {
  try {
    const { stdout, stderr } = await run('node', [BIN, ...args], { timeout: 30_000, cwd: REPO_ROOT });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

test('done when: a backup taken while the indexer writes restores a working instance', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-backup-'));
  const live = join(dir, 'live.db');
  const backup = join(dir, 'backup.db');
  const restored = join(dir, 'restored.db');
  const events = JSON.parse(await readFile(FIXTURE, 'utf8')).events;

  // The "indexer": its own connection, mid-stream, with a cursor saved.
  const indexer = new SqliteEventStore({ path: live });
  await indexer.insertEvents(events.slice(0, 30));
  await indexer.saveStreamState({ key: 'main', cursor: events[29].id, ledger: events[29].ledger, updatedAt: '2026-11-21T00:00:00Z' });

  // Keep writing while the backup runs in another process.
  let writing = true;
  const writer = (async () => {
    for (let i = 30; writing && i < events.length; i++) {
      await indexer.insertEvents([events[i]]);
      await new Promise((r) => setTimeout(r, 2));
    }
  })();
  const backedUp = await cli(['backup', '--db', live, backup]);
  writing = false;
  await writer;
  await indexer.close();
  assert.equal(backedUp.code, 0, backedUp.stderr);

  const restoredRun = await cli(['restore', '--db', restored, backup]);
  assert.equal(restoredRun.code, 0, restoredRun.stderr);

  const store = new SqliteEventStore({ path: restored });
  const stats = await store.getStats();
  assert.ok(stats.eventCount >= 30, `at least what was there when the backup started, got ${stats.eventCount}`);
  assert.deepEqual(await store.checkIntegrity(), []);
  // The cursor came with it, so the indexer resumes instead of re-reading history.
  assert.equal((await store.loadStreamState('main')).cursor, events[29].id);
  await store.close();

  const verify = await cli(['verify', '--db', restored]);
  assert.equal(verify.code, 0, verify.stderr);
  await rm(dir, { recursive: true, force: true });
});

test('restore will not replace an existing database without --force', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-backup-'));
  const db = join(dir, 'lens.db');
  const backup = join(dir, 'backup.db');
  assert.equal((await cli(['seed', '--db', db])).code, 0);
  assert.equal((await cli(['backup', '--db', db, backup])).code, 0);

  const refused = await cli(['restore', '--db', db, backup]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /already exists.*--force/);
  assert.equal((await cli(['restore', '--db', db, backup, '--force'])).code, 0);
  await rm(dir, { recursive: true, force: true });
});

test('backup never overwrites, and restore rejects a file that is not a database', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-backup-'));
  const db = join(dir, 'lens.db');
  const junk = join(dir, 'junk.db');
  await writeFile(junk, 'not sqlite');
  assert.equal((await cli(['seed', '--db', db])).code, 0);

  const overwrite = await cli(['backup', '--db', db, junk]);
  assert.equal(overwrite.code, 1);
  assert.match(overwrite.stderr, /refusing to overwrite/);

  const target = join(dir, 'target.db');
  const bad = await cli(['restore', '--db', target, junk]);
  assert.equal(bad.code, 1);
  assert.equal(await access(target).then(() => true, () => false), false, 'nothing written');
  await rm(dir, { recursive: true, force: true });
});
