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
  /** Extra headers for every RPC request. Values are secrets — never log them. */
  rpcHeaders: Record<string, string>;
  /** Retry tuning passed straight to the ingest client. */
  retry: { attempts: number; baseDelayMs: number; maxDelayMs: number };
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
  rpcHeaders?: string[] | undefined;
  retryAttempts?: number | undefined;
  retryBaseDelay?: number | undefined;
  retryMaxDelay?: number | undefined;
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
    rpcHeaders: parseHeaders(overrides.rpcHeaders, env.LENS_RPC_HEADERS),
    retry: {
      attempts: overrides.retryAttempts ?? numberOr(env.LENS_RETRY_ATTEMPTS, 5),
      baseDelayMs: overrides.retryBaseDelay ?? numberOr(env.LENS_RETRY_BASE_DELAY_MS, 250),
      maxDelayMs: overrides.retryMaxDelay ?? numberOr(env.LENS_RETRY_MAX_DELAY_MS, 30_000),
    },
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

/**
 * Parse `Name: value` header pairs from flags and `LENS_RPC_HEADERS`.
 *
 * Malformed entries are skipped rather than thrown, because this runs on every
 * command including `lens doctor`, whose whole job is to report a bad
 * configuration rather than crash on one.
 */
export function parseHeaders(
  flags: string[] | undefined,
  env: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const entry of [...splitList(env), ...(flags ?? [])]) {
    const split = entry.indexOf(':');
    if (split <= 0) continue;
    const name = entry.slice(0, split).trim();
    const value = entry.slice(split + 1).trim();
    if (name !== '' && value !== '') headers[name] = value;
  }
  return headers;
}

/**
 * Header names with their values masked.
 *
 * Every path that shows configuration to a human goes through this. A header
 * value is a provider API key, and `lens doctor` output is the single most
 * likely thing to be pasted into a bug report.
 */
export function redactHeaders(headers: Record<string, string>): string {
  const names = Object.keys(headers);
  return names.length === 0 ? 'none' : names.map((n) => `${n}: <redacted>`).join(', ');
}
