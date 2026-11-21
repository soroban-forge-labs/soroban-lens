import { copyFile, rename, rm, access } from 'node:fs/promises';
import { SqliteEventStore } from '@soroban-lens/store';

/**
 * `lens restore` (#91): put a `lens backup` file in place of the database.
 *
 * The backup is checked before anything is touched — it must open, pass
 * SQLite's integrity check through the store's invariant check, and hold a
 * schema this build can read — so a bad file never replaces a good database.
 * The copy goes to a temporary name beside the database and is renamed into
 * place, so a crash mid-copy leaves the old database, not half of the new one.
 * Stale `-wal`/`-shm` sidecars belong to the old file and are removed.
 */
export async function restoreBackup(
  backupPath: string,
  dbPath: string,
  options: { force: boolean },
): Promise<{ ok: boolean; message: string }> {
  try {
    await access(backupPath);
  } catch {
    return { ok: false, message: `no backup at ${backupPath}` };
  }

  // Opened without migrating: a check must not modify the backup.
  const check = new SqliteEventStore({ path: backupPath, migrateOnOpen: false, checkpointIntervalMs: 0 });
  let events: number;
  try {
    const health = await check.healthCheck();
    const problems = await check.checkIntegrity();
    if (problems.length > 0) {
      return { ok: false, message: `${backupPath} has ${problems.length} inconsistent row(s); not restoring it` };
    }
    events = (await check.getStats()).eventCount;
    // An older schema is fine — it migrates forward on first open. A newer one is not.
    if (!health.ok && !/expected/.test(health.detail)) return { ok: false, message: `${backupPath}: ${health.detail}` };
  } catch (error) {
    return { ok: false, message: `${backupPath} is not a usable backup: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    await check.close();
  }

  const exists = await access(dbPath).then(() => true, () => false);
  if (exists && !options.force) {
    return {
      ok: false,
      message: `${dbPath} already exists. Stop the indexer and API, then re-run with --force to replace it.`,
    };
  }

  const temp = `${dbPath}.restoring-${process.pid}`;
  await copyFile(backupPath, temp);
  await rm(`${dbPath}-wal`, { force: true });
  await rm(`${dbPath}-shm`, { force: true });
  await rename(temp, dbPath);
  return { ok: true, message: `restored ${dbPath} from ${backupPath}: ${events} event(s)` };
}
