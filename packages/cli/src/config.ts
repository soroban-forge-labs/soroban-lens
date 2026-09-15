import { resolveNetwork, type NetworkConfig } from '@soroban-lens/ingest';

/** Everything the CLI needs, resolved from flags then environment then defaults. */
export interface LensConfig {
  network: NetworkConfig;
  contractIds: string[];
  dbPath: string;
  dataDir: string;
  apiPort: number;
  startLedger: number | undefined;
  pageSize: number;
  pollIntervalMs: number;
}

export interface ConfigOverrides {
  network?: string | undefined;
  rpcUrl?: string | undefined;
  contracts?: string[] | undefined;
  db?: string | undefined;
  dataDir?: string | undefined;
  port?: number | undefined;
  startLedger?: number | undefined;
  pageSize?: number | undefined;
  pollInterval?: number | undefined;
}

/**
 * Flags beat environment beats defaults — the usual precedence, and the one
 * that lets `docker compose` set the environment while a developer overrides a
 * single value on the command line.
 */
export function resolveConfig(
  overrides: ConfigOverrides = {},
  env: NodeJS.ProcessEnv = process.env,
): LensConfig {
  const contractIds =
    overrides.contracts && overrides.contracts.length > 0
      ? overrides.contracts
      : splitList(env.LENS_CONTRACT_IDS);

  return {
    network: resolveNetwork(
      overrides.network ?? env.LENS_NETWORK ?? 'testnet',
      overrides.rpcUrl ?? env.LENS_RPC_URL,
    ),
    contractIds,
    dbPath: overrides.db ?? env.LENS_DB_PATH ?? './data/lens.db',
    dataDir: overrides.dataDir ?? env.LENS_DATA_DIR ?? './data',
    apiPort: overrides.port ?? numberOr(env.LENS_API_PORT, 8080),
    startLedger: overrides.startLedger ?? optionalNumber(env.LENS_START_LEDGER),
    pageSize: overrides.pageSize ?? numberOr(env.LENS_PAGE_SIZE, 200),
    pollIntervalMs: overrides.pollInterval ?? numberOr(env.LENS_POLL_INTERVAL_MS, 2000),
  };
}

export function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function numberOr(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) ? n : fallback;
}

function optionalNumber(value: string | undefined): number | undefined {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) ? n : undefined;
}
