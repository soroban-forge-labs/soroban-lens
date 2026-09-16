import { access, constants, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { LensRpcClient, isContractId, CONTRACT_ID_HINT } from '@soroban-lens/ingest';
import { SqliteEventStore, LATEST_SCHEMA_VERSION } from '@soroban-lens/store';
import type { LensConfig } from './config.js';

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  /** What to actually do about it. Present whenever status is not "pass". */
  fix?: string;
}

/**
 * Minimum Node version.
 *
 * `node:sqlite` was added in 22.5 behind `--experimental-sqlite`, and the flag
 * was dropped in **22.13**. Anything earlier throws ERR_UNKNOWN_BUILTIN_MODULE
 * on import, so 22.13 is the real floor rather than "22.x".
 */
const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 13;

/**
 * Preflight checks, run before anyone waits on a silent failure.
 *
 * Every check answers a question a newcomer would otherwise have to debug from
 * source: is my Node new enough, can I reach the RPC, is my contract id shaped
 * right, can I actually write to the database file.
 */
export async function runDoctor(config: LensConfig): Promise<CheckResult[]> {
  const checks = await Promise.all([
    checkNodeVersion(),
    checkDataDirWritable(config.dataDir),
    checkDatabase(config.dbPath),
    checkRpc(config),
  ]);
  return [...checks, checkContractIds(config.contractIds)];
}

function checkNodeVersion(): CheckResult {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  const ok = major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR);
  return {
    name: 'Node.js version',
    status: ok ? 'pass' : 'fail',
    detail: `v${process.versions.node}`,
    ...(ok
      ? {}
      : {
          fix: `soroban-lens needs Node >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} for the built-in node:sqlite module. Upgrade Node, or use the Docker path.`,
        }),
  };
}

async function checkDataDirWritable(dataDir: string): Promise<CheckResult> {
  const probe = join(dataDir, `.lens-write-probe-${process.pid}`);
  try {
    await mkdir(dataDir, { recursive: true });
    await writeFile(probe, 'probe');
    await rm(probe, { force: true });
    return { name: 'Data directory', status: 'pass', detail: `${dataDir} is writable` };
  } catch (error) {
    return {
      name: 'Data directory',
      status: 'fail',
      detail: `${dataDir}: ${message(error)}`,
      fix: 'Create the directory and make it writable by this user. In Docker this usually means a volume mounted read-only, or a uid mismatch on a bind mount.',
    };
  }
}

async function checkDatabase(dbPath: string): Promise<CheckResult> {
  try {
    await mkdir(dirname(dbPath), { recursive: true });
    const store = new SqliteEventStore({ path: dbPath });
    // writeProbe, not healthCheck: doctor's whole job is catching a database
    // that reads fine but cannot be written to before the indexer starts.
    const health = await store.writeProbe();
    const stats = await store.getStats();
    await store.close();

    if (!health.ok) {
      return {
        name: 'Database',
        status: 'fail',
        detail: health.detail,
        fix: `Expected schema v${LATEST_SCHEMA_VERSION}. Delete ${dbPath} to rebuild from scratch, or run the migration.`,
      };
    }
    return {
      name: 'Database',
      status: 'pass',
      detail: `${dbPath}: ${health.detail}, ledgers ${stats.minLedger ?? '-'}..${stats.maxLedger ?? '-'}`,
    };
  } catch (error) {
    return {
      name: 'Database',
      status: 'fail',
      detail: `${dbPath}: ${message(error)}`,
      fix: 'Check the path is writable and is not on a filesystem without file locking (some network mounts break SQLite).',
    };
  }
}

async function checkRpc(config: LensConfig): Promise<CheckResult> {
  const client = new LensRpcClient({
    rpcUrl: config.network.rpcUrl,
    // One quick attempt: doctor reports a problem, it does not wait one out.
    retry: { attempts: 1 },
    timeoutSeconds: 10,
  });
  try {
    const health = await client.health();
    const windowLedgers = health.latestLedger - health.oldestLedger;
    const approxDays = Math.round((windowLedgers * 5) / 86_400);
    return {
      name: 'Soroban RPC',
      status: 'pass',
      detail:
        `${config.network.name} ${config.network.rpcUrl} — ${health.status}, ` +
        `ledger ${health.latestLedger}, retains ${windowLedgers} ledgers (~${approxDays}d)`,
    };
  } catch (error) {
    return {
      name: 'Soroban RPC',
      status: 'fail',
      detail: `${config.network.rpcUrl}: ${message(error)}`,
      fix:
        config.network.name === 'mainnet'
          ? 'There is no free public mainnet RPC with useful retention. Set LENS_RPC_URL to your own node or a provider.'
          : 'Check network access and that LENS_RPC_URL is correct. The public testnet endpoint is https://soroban-testnet.stellar.org.',
    };
  }
}

/** Contract ids are StrKey: 'C' followed by 55 base32 characters. */

function checkContractIds(contractIds: string[]): CheckResult {
  if (contractIds.length === 0) {
    return {
      name: 'Contract IDs',
      status: 'warn',
      detail: 'none configured — the indexer will watch every contract on the network',
      fix: 'Set LENS_CONTRACT_IDS to narrow it down. On a busy network, watching everything fills the database fast.',
    };
  }

  const invalid = contractIds.filter((id) => !isContractId(id));
  if (invalid.length > 0) {
    return {
      name: 'Contract IDs',
      status: 'fail',
      detail: `not contract StrKeys: ${invalid.join(', ')}`,
      fix: CONTRACT_ID_HINT,
    };
  }

  const tooMany = contractIds.length > 5;
  return {
    name: 'Contract IDs',
    status: 'pass',
    detail:
      `${contractIds.length} configured` +
      (tooMany ? ' (split across multiple RPC filters, 5 per filter)' : ''),
  };
}

/** Render results as a human-readable report. Returns the process exit code. */
export function formatReport(results: CheckResult[]): { text: string; exitCode: number } {
  const icon: Record<CheckStatus, string> = { pass: '✔', warn: '!', fail: '✘' };
  const lines = ['', 'lens doctor', ''];

  for (const r of results) {
    lines.push(`  ${icon[r.status]}  ${r.name.padEnd(16)} ${r.detail}`);
    if (r.fix) lines.push(`     ↳ ${r.fix}`);
  }

  const failed = results.filter((r) => r.status === 'fail').length;
  const warned = results.filter((r) => r.status === 'warn').length;

  lines.push('');
  lines.push(
    failed > 0
      ? `  ${failed} check(s) failed. Fix the above, then run lens doctor again.`
      : warned > 0
        ? `  All checks passed, with ${warned} warning(s).`
        : '  All checks passed. Run `lens index` to start indexing.',
  );
  lines.push('');

  return { text: lines.join('\n'), exitCode: failed > 0 ? 1 : 0 };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
