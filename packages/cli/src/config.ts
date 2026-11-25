import { resolveClockSkewThreshold, resolveNetwork, type NetworkConfig } from '@soroban-lens/ingest';

/** Everything the CLI needs, resolved from flags then environment then defaults. */
export interface LensConfig {
  network: NetworkConfig;
  rpcUrls: string[];
  archiveUrl: string | undefined;
  contractIds: string[];
  dbPath: string;
  dataDir: string;
  apiPort: number;
  startLedger: number | undefined;
  pageSize: number;
  /**
   * Bounds for an adaptive page size (#14), from `LENS_PAGE_SIZE_MIN` and
   * `LENS_PAGE_SIZE_MAX`. Undefined keeps the page size fixed at `pageSize`.
   */
  pageSizeBounds: { min: number; max: number } | undefined;
  /** Recent ledgers re-read each time the tip moves, to catch reorgs (#3). `LENS_REORG_DEPTH`, default 3; 0 is off. */
  reorgDepth: number;
  pollIntervalMs: number;
  maxPollIntervalMs: number;
  /** Extra headers for every RPC request. Values are secrets — never log them. */
  rpcHeaders: Record<string, string>;
  /** Retry tuning passed straight to the ingest client. */
  retry: { attempts: number; baseDelayMs: number; maxDelayMs: number };
  /**
   * Look up each indexed contract's spec for typed decoding (#33). On by
   * default; off for an air-gapped RPC proxy that only forwards getEvents.
   */
  fetchSpecs: boolean;
  /**
   * Local-versus-ledger clock difference, in seconds, beyond which `lens doctor`
   * and the indexer's startup warn (#18). `LENS_CLOCK_SKEW_THRESHOLD_SECONDS`.
   */
  clockSkewThresholdSeconds: number;
  /**
   * Optional disk target for the database (`db.size` + its WAL), in bytes.
   * When set, the indexer prunes oldest ledgers in chunks until the total
   * fits, then checkpoints. Undefined disables size-based pruning.
   * `LENS_MAX_DB_SIZE_BYTES`.
   */
  maxDbSizeBytes: number | undefined;
  /** How often the indexer checks the size target, in milliseconds. `LENS_PRIUN_INTERVAL_MS`. */
  pruneIntervalMs: number;
}

/** Where a resolved setting's value came from: a flag, an environment variable, or the built-in default. */
export type ConfigSource = 'flag' | 'env' | 'default';

/** Per-setting provenance, keyed by the setting name in `LensConfig`. */
export type ConfigSources = Record<string, ConfigSource>;

export interface ConfigOverrides {
  network?: string | undefined;
  rpcUrl?: string | undefined;
  rpcUrls?: string[] | undefined;
  archiveUrl?: string | undefined;
  contracts?: string[] | undefined;
  db?: string | undefined;
  dataDir?: string | undefined;
  port?: number | undefined;
  startLedger?: number | undefined;
  pageSize?: number | undefined;
  pageSizeMin?: number | undefined;
  pageSizeMax?: number | undefined;
  reorgDepth?: number | undefined;
  pollInterval?: number | undefined;
  maxPollInterval?: number | undefined;
  rpcHeaders?: string[] | undefined;
  retryAttempts?: number | undefined;
  retryBaseDelay?: number | undefined;
  retryMaxDelay?: number | undefined;
  maxDbSize?: number | undefined;
  pruneInterval?: number | undefined;
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
  return resolveConfigWithSources(overrides, env).config;
}

/**
 * Resolve the configuration and record, per setting, whether a flag, an
 * environment variable or the built-in default won. `lens config` prints this;
 * `resolveConfig` is the thin wrapper for callers that only need the values.
 */
export function resolveConfigWithSources(
  overrides: ConfigOverrides = {},
  env: NodeJS.ProcessEnv = process.env,
): { config: LensConfig; sources: ConfigSources } {
  const sources: ConfigSources = {};
  const pick = <T>(key: string, flag: T | undefined, envValue: T | undefined, fallback: T): T => {
    if (flag !== undefined) {
      sources[key] = 'flag';
      return flag;
    }
    if (envValue !== undefined) {
      sources[key] = 'env';
      return envValue;
    }
    sources[key] = 'default';
    return fallback;
  };

  const contractIds =
    overrides.contracts && overrides.contracts.length > 0
      ? overrides.contracts
      : splitList(env.LENS_CONTRACT_IDS);
  sources.contractIds =
    overrides.contracts && overrides.contracts.length > 0
      ? 'flag'
      : splitList(env.LENS_CONTRACT_IDS).length > 0
        ? 'env'
        : 'default';

  const pollIntervalMs = pick(
    'pollIntervalMs',
    overrides.pollInterval,
    optionalNumber(env.LENS_POLL_INTERVAL_MS),
    2000,
  );
  const maxPollIntervalMs = pick(
    'maxPollIntervalMs',
    overrides.maxPollInterval,
    optionalNumber(env.LENS_POLL_MAX_INTERVAL_MS),
    Math.max(pollIntervalMs, 30_000),
  );

  const networkName = pick('network', overrides.network, env.LENS_NETWORK, 'testnet');
  const rpcUrls = pick(
    'rpcUrls',
    overrides.rpcUrls,
    splitList(env.LENS_RPC_URLS || overrides.rpcUrl || env.LENS_RPC_URL).length > 0
      ? splitList(env.LENS_RPC_URLS || overrides.rpcUrl || env.LENS_RPC_URL)
      : undefined,
    [],
  );
  const resolvedRpcUrls =
    rpcUrls.length > 0 ? rpcUrls : [resolveNetwork(networkName).rpcUrl];

  const pageSize = pick('pageSize', overrides.pageSize, optionalNumber(env.LENS_PAGE_SIZE), 200);
  const pageSizeMin = overrides.pageSizeMin ?? optionalNumber(env.LENS_PAGE_SIZE_MIN);
  const pageSizeMax = overrides.pageSizeMax ?? optionalNumber(env.LENS_PAGE_SIZE_MAX);
  sources.pageSizeBounds =
    overrides.pageSizeMin !== undefined || overrides.pageSizeMax !== undefined
      ? 'flag'
      : pageSizeMin !== undefined || pageSizeMax !== undefined
        ? 'env'
        : 'default';

  const rpcHeaders = parseHeaders(overrides.rpcHeaders, env.LENS_RPC_HEADERS);
  sources.rpcHeaders =
    overrides.rpcHeaders && overrides.rpcHeaders.length > 0
      ? 'flag'
      : splitList(env.LENS_RPC_HEADERS).length > 0
        ? 'env'
        : 'default';

  const config: LensConfig = {
    network: resolveNetwork(networkName, (overrides.rpcUrls ?? splitList(overrides.rpcUrl ?? env.LENS_RPC_URL))[0]),
    rpcUrls: resolvedRpcUrls,
    archiveUrl: pick('archiveUrl', overrides.archiveUrl, env.LENS_ARCHIVE_URL, undefined),
    contractIds,
    dbPath: pick('dbPath', overrides.db, env.LENS_DB_PATH, './data/lens.db'),
    dataDir: pick('dataDir', overrides.dataDir, env.LENS_DATA_DIR, './data'),
    apiPort: pick('apiPort', overrides.port, optionalNumber(env.LENS_API_PORT), 8080),
    startLedger: pick('startLedger', overrides.startLedger, optionalNumber(env.LENS_START_LEDGER), undefined),
    pageSize,
    pageSizeBounds: pageSizeBounds(pageSizeMin, pageSizeMax, pageSize),
    reorgDepth: pick('reorgDepth', overrides.reorgDepth, optionalNumber(env.LENS_REORG_DEPTH), 3),
    pollIntervalMs,
    maxPollIntervalMs,
    rpcHeaders,
    retry: {
      attempts: pick('retry.attempts', overrides.retryAttempts, optionalNumber(env.LENS_RETRY_ATTEMPTS), 5),
      baseDelayMs: pick('retry.baseDelayMs', overrides.retryBaseDelay, optionalNumber(env.LENS_RETRY_BASE_DELAY_MS), 250),
      maxDelayMs: pick('retry.maxDelayMs', overrides.retryMaxDelay, optionalNumber(env.LENS_RETRY_MAX_DELAY_MS), 30_000),
    },
    fetchSpecs: pick(
      'fetchSpecs',
      undefined,
      env.LENS_FETCH_SPECS !== undefined && env.LENS_FETCH_SPECS !== ''
        ? !/^(0|false|no|off)$/i.test(env.LENS_FETCH_SPECS.trim())
        : undefined,
      true,
    ),
    clockSkewThresholdSeconds: pick(
      'clockSkewThresholdSeconds',
      undefined,
      env.LENS_CLOCK_SKEW_THRESHOLD_SECONDS !== undefined && env.LENS_CLOCK_SKEW_THRESHOLD_SECONDS !== ''
        ? resolveClockSkewThreshold(env.LENS_CLOCK_SKEW_THRESHOLD_SECONDS)
        : undefined,
      resolveClockSkewThreshold(undefined),
    ),
    maxDbSizeBytes: pick('maxDbSizeBytes', overrides.maxDbSize, optionalNumber(env.LENS_MAX_DB_SIZE_BYTES), undefined),
    pruneIntervalMs: pick('pruneIntervalMs', overrides.pruneInterval, optionalNumber(env.LENS_PRUNE_INTERVAL_MS), 60_000),
  };

  return { config, sources };
}

/**
 * Either bound alone is enough to opt in: the other defaults to the fixed page
 * size, so `LENS_PAGE_SIZE_MAX=10000` means "start at LENS_PAGE_SIZE, grow up to
 * 10 000". Neither set keeps today's fixed size.
 */
function pageSizeBounds(
  min: number | undefined,
  max: number | undefined,
  pageSize: number,
): { min: number; max: number } | undefined {
  if (min === undefined && max === undefined) return undefined;
  return { min: min ?? Math.min(pageSize, max ?? pageSize), max: max ?? Math.max(pageSize, min ?? pageSize) };
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
 * command including `lens doctor`, whose whole job is to report a bad configuration
 * rather than crash on one.
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
