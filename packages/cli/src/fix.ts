import { access, constants, copyFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { SqliteEventStore, LATEST_SCHEMA_VERSION } from '@soroban-lens/store';
import type { LensConfig } from './config.js';

/** One remedy `lens doctor --fix` applied. */
export interface FixAction {
  /** What was done, phrased for the operator: "created data directory ./data". */
  description: string;
}

export interface FixOptions {
  /** Where `.env` and `.env.example` live. Defaults to the working directory. */
  cwd?: string;
}

/**
 * Apply the remedies that have exactly one right answer (#81), before the
 * doctor checks run, and say what was done.
 *
 * Deliberately short. Everything here only ever *adds* something that was
 * missing: an existing `.env` is never rewritten, an existing database is only
 * migrated forward, and nothing is deleted. Anything involving the network —
 * which RPC, which headers, which contracts — is a choice, not a fix, so it is
 * left to the report's advice rather than guessed at.
 */
export async function applyFixes(config: LensConfig, options: FixOptions = {}): Promise<FixAction[]> {
  const cwd = options.cwd ?? process.cwd();
  const actions: FixAction[] = [];

  const env = join(cwd, '.env');
  const example = join(cwd, '.env.example');
  if (!(await exists(env)) && (await exists(example))) {
    // COPYFILE_EXCL: if something writes .env between the check and the copy,
    // the copy fails instead of overwriting it.
    await copyFile(example, env, constants.COPYFILE_EXCL);
    actions.push({ description: 'created .env from .env.example (docker compose reads it; review LENS_CONTRACT_IDS)' });
  }

  for (const dir of unique([config.dataDir, dirname(config.dbPath)])) {
    if (await exists(dir)) continue;
    await mkdir(dir, { recursive: true });
    actions.push({ description: `created data directory ${dir}` });
  }

  // Only a database that already exists can have pending migrations; a missing
  // one is created at the latest schema the first time anything opens it.
  if (config.dbPath !== ':memory:' && (await exists(config.dbPath))) {
    const store = new SqliteEventStore({ path: config.dbPath, migrateOnOpen: false, checkpointIntervalMs: 0 });
    try {
      const before = await schemaVersion(store);
      if (before !== undefined && before < LATEST_SCHEMA_VERSION) {
        await store.migrate();
        actions.push({
          description: `migrated ${config.dbPath} from schema v${before} to v${LATEST_SCHEMA_VERSION}`,
        });
      }
    } finally {
      await store.close();
    }
  }

  return actions;
}

/**
 * The schema version, or undefined when it cannot be read.
 *
 * Unreadable is not "v0": a corrupt file or a database from a newer build is
 * exactly the case where migrating would be a guess, so it is left for the
 * Database check to report.
 */
async function schemaVersion(store: SqliteEventStore): Promise<number | undefined> {
  try {
    return (await store.getStats()).schemaVersion;
  } catch {
    return undefined;
  }
}

/** Render the actions `lens doctor --fix` took, ahead of the report. */
export function formatFixes(actions: FixAction[]): string {
  if (actions.length === 0) return '\nlens doctor --fix: nothing to fix\n';
  return ['', 'lens doctor --fix', '', ...actions.map((a) => `  +  ${a.description}`), ''].join('\n');
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function unique(paths: string[]): string[] {
  const seen = new Map<string, string>();
  for (const p of paths) if (!seen.has(resolve(p))) seen.set(resolve(p), p);
  return [...seen.values()];
}
