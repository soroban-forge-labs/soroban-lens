import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { resolveClockSkewThreshold, resolveNetwork, type NetworkConfig } from '@soroban-lens/ingest';

/** Everything the CLI needs, resolved from flags then environment then file then defaults. */
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
  /** Persist typed event fields for equality/range filters. `LENS_TYPED_FIELD_INDEX=true` opts in. */
  typedFieldIndex: boolean;
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
  /**
   * Where each resolved key came from — `flag`, `env`, `file`, or `default`.
   * Populated by `resolveConfig` so `lens config` can show the winning source
   * per key (#215).
   */
  sources: ConfigSources;
  /** Absolute path of the config file that was loaded, if any. */
  configFile: string | undefined;
}

/** The four layers a value can come from, in precedence order. */
export type ConfigSource = 'flag' | 'env' | 'file' | 'default';

/** Winning source per resolved key. Keys mirror the `LensConfig` fields. */
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
 * The shape of `lens.config.json`. Keys mirror the `LENS_*` environment
 * variables (lowercased, without the prefix) so a deployment can move values
 * between the file and the environment without renaming anything. The
 * published JSON Schema lives in `docs/lens.config.schema.json`.
 */
export interface LensConfigFile {
  network?: string;
  rpcUrl?: string;
  rpcUrls?: string[];
  archiveUrl?: string;
  contractIds?: string[];
  dbPath?: string;
  dataDir?: string;
  apiPort?: number;
  startLedger?: number;
  pageSize?: number;
  pageSizeMin?: number;
  pageSizeMax?: number;
  reorgDepth?: number;
  pollIntervalMs?: number;
  pollMaxIntervalMs?: number;
  rpcHeaders?: string[];
  retryAttempts?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  fetchSpecs?: boolean;
  clockSkewThresholdSeconds?: number;
  maxDbSizeBytes?: number;
  pruneIntervalMs?: number;
}

/** Default config file name, looked up in the current working directory. */
export const CONFIG_FILE_NAME = 'lens.config.json';

/** Environment variable that points at an explicit config file. */
export const CONFIG_FILE_ENV = 'LENS_CONFIG_FILE';

/**
 * Locate the config file: `LENS_CONFIG_FILE` if set, otherwise
 * `lens.config.json` in the current working directory. Returns undefined when
 * no file exists (the file is optional).
 */
export function findConfigFile(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string | undefined {
  const explicit = env[CONFIG_FILE_ENV];
  if (explicit !== undefined && explicit.trim() !== '') {
    return resolvePath(cwd, explicit.trim());
  }
  return resolvePath(cwd, CONFIG_FILE_NAME);
}

/**
 * Load and validate `lens.config.json`. Returns an empty object when the file
 * is absent. Throws a descriptive error when the file exists but is not valid
 * JSON or fails schema validation, so a typo surfaces immediately rather than
 * silently falling back to defaults.
 */
export function loadConfigFile(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): { file: string | undefined; values: LensConfigFile } {
  const path = findConfigFile(env, cwd);
  if (path === undefined) return { file: undefined, values: {} };

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { file: undefined, values: {} };
    throw new Error(`could not read config file ${path}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`config file ${path} is not valid JSON: ${(err as Error).message}`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`config file ${path} must contain a JSON object`);
  }

  const errors = validateConfigFile(parsed as Record<string, unknown>);
  if (errors.length > 0) {
    throw new Error(`config file ${path} is invalid:\n  - ${errors.join('\n  - ')}`);
  }

  return { file: path, values: parsed as LensConfigFile };
}

/** Keys accepted in `lens.config.json`, with their expected JSON type. */
const CONFIG_FILE_KEYS: Record<keyof LensConfigFile, 'string' | 'number' | 'boolean' | 'string[]'> = {
  network: 'string',
  rpcUrl: 'string',
  rpcUrls: 'string[]',
  archiveUrl: 'string',
  contractIds: 'string[]',
  dbPath: 'string',
  dataDir: 'string',
  apiPort: 'number',
  startLedger: 'number',
  pageSize: 'number',
  pageSizeMin: 'number',
  pageSizeMax: 'number',
  reorgDepth: 'number',
  pollIntervalMs: 'number',
  pollMaxIntervalMs: 'number',
  rpcHeaders: 'string[]',
  retryAttempts: 'number',
  retryBaseDelayMs: 'number',
  retryMaxDelayMs: 'number',
  fetchSpecs: 'boolean',
  clockSkewThresholdSeconds: 'number',
  maxDbSizeBytes: 'number',
  pruneIntervalMs: 'number',
};

/**
 * Validate a parsed config file against the published schema. Returns a list
 * of human-readable errors; empty means valid. Kept dependency-free so the
 * CLI has no runtime schema library.
 */
export function validateConfigFile(value: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const [key, raw] of Object.entries(value)) {
    const expected = CONFIG_FILE_KEYS[key as keyof LensConfigFile];
    if (expected === undefined) {
      errors.push(`unknown key "${key}"`);
      continue;
    }
    if (raw === undefined) continue;
    if (expected === 'string[]') {
      if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string')) {
        errors.push(`"${key}" must be an array of strings`);
      }
    } else if (expected === 'number') {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        errors.push(`"${key}" must be a number`);
      }
    } else if (typeof raw !== expected) {
      errors.push(`"${key}" must be a ${expected}`);
    }
  }
  return errors;
}

/**
 * Flags beat environment beats the config file beats defaults — the usual
 * precedence, and the one that lets `docker compose` set the environment while
 * a developer overrides a single value on the command line, and lets a
 * deployment keep its bulk settings in `lens.config.json`.
 */
export function resolveConfig(
  overrides: ConfigOverrides = {},
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): LensConfig {
  const { file: configFile, values: file } = loadConfigFile(env, cwd);
  const sources: ConfigSources = {};

  /**
   * Pick the first defined value across flag, env, file, default, and record
   * which layer won. `flag`/`env`/`file` are the candidate values (undefined
   * when absent); `fallback` is the default.
   */
  function pick<T>(
    key: string,
    flag: T | undefined,
    envValue: T | undefined,
    fileValue: T | undefined,
    fallback: T,
  ): T {
    if (flag !== undefined) {
      sources[key] = 'flag';
      return flag;
    }
    if (envValue !== undefined) {
      sources[key] = 'env';
      return envValue;
    }
    if (fileValue !== undefined) {
      sources[key] = 'file';
      return fileValue;
    }
    sources[key] = 'default';
    return fallback;
  }

  const networkName = pick(
    'network',
    overrides.network,
    env.LENS_NETWORK,
    file.network,
    'testnet',
  );

  const rpcUrlsFlag = overrides.rpcUrls ?? (overrides.rpcUrl !== undefined ? splitList(overrides.rpcUrl) : undefined);
  const rpcUrlsEnv = splitList(env.LENS_RPC_URLS || env.LENS_RPC_URL);
  const rpcUrlsFile = file.rpcUrls ?? (file.rpcUrl !== undefined ? splitList(file.rpcUrl) : undefined);
  const rpcUrlsResolved = pick<string[]>(
    'rpcUrls',
    rpcUrlsFlag && rpcUrlsFlag.length > 0 ? rpcUrlsFlag : undefined,
    rpcUrlsEnv.length > 0 ? rpcUrlsEnv : undefined,
    rpcUrlsFile && rpcUrlsFile.length > 0 ? rpcUrlsFile : undefined,
    [],
  );
  const rpcUrls = rpcUrlsResolved.length > 0 ? rpcUrlsResolved : [resolveNetwork(networkName).rpcUrl];

  const contractIdsFlag = overrides.contracts && overrides.contracts.length > 0 ? overrides.contracts : undefined;
  const contractIdsEnv = splitList(env.LENS_CONTRACT_IDS);
  const contractIds = pick<string[]>(
    'contractIds',
    contractIdsFlag,
    contractIdsEnv.length > 0 ? contractIdsEnv : undefined,
    file.contractIds,
    [],
  );

  const pollIntervalMs = pick(
    'pollIntervalMs',
    overrides.pollInterval,
    optionalNumber(env.LENS_POLL_INTERVAL_MS),
    file.pollIntervalMs,
    2000,
  );
  const maxPollIntervalMs = pick(
    'maxPollIntervalMs',
    overrides.maxPollInterval,
    optionalNumber(env.LENS_POLL_MAX_INTERVAL_MS),
    file.pollMaxIntervalMs,
    Math.max(pollIntervalMs, 30_000),
  );

  const pageSize = pick(
    'pageSize',
    overrides.pageSize,
    optionalNumber(env.LENS_PAGE_SIZE),
    file.pageSize,
    200,
  );

  const pageSizeMin = pick(
    'pageSizeMin',
    overrides.pageSizeMin,
    optionalNumber(env.LENS_PAGE_SIZE_MIN),
    file.pageSizeMin,
    undefined as number | undefined,
  );
  const pageSizeMax = pick(
    'pageSizeMax',
    overrides.pageSizeMax,
    optionalNumber(env.LENS_PAGE_SIZE_MAX),
    file.pageSizeMax,
    undefined as number | undefined,
  );

  const fetchSpecsEnv = env.LENS_FETCH_SPECS !== undefined && env.LENS_FETCH_SPECS !== ''
    ? !/^(0|false|no|off)$/i.test(env.LENS_FETCH_SPECS.trim())
    : undefined;

  const clockSkewEnv = env.LENS_CLOCK_SKEW_THRESHOLD_SECONDS !== undefined && env.LENS_CLOCK_SKEW_THRESHOLD_SECONDS !== ''
    ? resolveClockSkewThreshold(env.LENS_CLOCK_SKEW_THRESHOLD_SECONDS)
    : undefined;

  const rpcHeadersFlag = overrides.rpcHeaders;
  const rpcHeadersEnv = env.LENS_RPC_HEADERS;
  const rpcHeadersFile = file.rpcHeaders;
  // Headers merge rather than replace: file, then env, then flags, so a flag
  // overrides a single header without dropping the others.
  const headerLayers: [string, Record<string, string> | undefined][] = [
    ['file', rpcHeadersFile && rpcHeadersFile.length > 0 ? parseHeaders(rpcHeadersFile, undefined) : undefined],
    ['env', rpcHeadersEnv !== undefined && rpcHeadersEnv !== '' ? parseHeaders(undefined, rpcHeadersEnv) : undefined],
    ['flag', rpcHeadersFlag && rpcHeadersFlag.length > 0 ? parseHeaders(rpcHeadersFlag, undefined) : undefined],
  ];
  const rpcHeaders: Record<string, string> = {};
  for (const [source, layer] of headerLayers) {
    if (layer === undefined) continue;
    Object.assign(rpcHeaders, layer);
    sources.rpcHeaders = source as ConfigSources[string];
  }

  return {
    network: resolveNetwork(networkName, rpcUrls[0]),
    rpcUrls,
    archiveUrl: pick(
      'archiveUrl',
      overrides.archiveUrl,
      env.LENS_ARCHIVE_URL,
      file.archiveUrl,
      undefined as string | undefined,
    ),
    contractIds,
    dbPath: pick('dbPath', overrides.db, env.LENS_DB_PATH, file.dbPath, './data/lens.db'),
    dataDir: pick('dataDir', overrides.dataDir, env.LENS_DATA_DIR, file.dataDir, './data'),
    apiPort: pick('apiPort', overrides.port, optionalNumber(env.LENS_API_PORT), file.apiPort, 8080),
    startLedger: pick(
      'startLedger',
      overrides.startLedger,
      optionalNumber(env.LENS_START_LEDGER),
      file.startLedger,
      undefined as number | undefined,
    ),
    pageSize,
    pageSizeBounds: pageSizeBounds(pageSizeMin, pageSizeMax, pageSize),
    reorgDepth: pick('reorgDepth', overrides.reorgDepth, optionalNumber(env.LENS_REORG_DEPTH), file.reorgDepth, 3),
    pollIntervalMs,
    maxPollIntervalMs,
    rpcHeaders,
    retry: {
      attempts: pick(
        'retryAttempts',
        overrides.retryAttempts,
        optionalNumber(env.LENS_RETRY_ATTEMPTS),
        file.retryAttempts,
        5,
      ),
      baseDelayMs: pick(
        'retryBaseDelayMs',
        overrides.retryBaseDelay,
        optionalNumber(env.LENS_RETRY_BASE_DELAY_MS),
        file.retryBaseDelayMs,
        250,
      ),
      maxDelayMs: pick(
        'retryMaxDelayMs',
        overrides.retryMaxDelay,
        optionalNumber(env.LENS_RETRY_MAX_DELAY_MS),
        file.retryMaxDelayMs,
        30_000,
      ),
    },
    typedFieldIndex: /^(1|true|yes|on)$/i.test((env.LENS_TYPED_FIELD_INDEX ?? '').trim()),
    fetchSpecs: pick('fetchSpecs', undefined, fetchSpecsEnv, file.fetchSpecs, true),
    clockSkewThresholdSeconds: pick(
      'clockSkewThresholdSeconds',
      undefined,
      clockSkewEnv,
      file.clockSkewThresholdSeconds,
      resolveClockSkewThreshold(undefined),
    ),
    maxDbSizeBytes: pick(
      'maxDbSizeBytes',
      overrides.maxDbSize,
      optionalNumber(env.LENS_MAX_DB_SIZE_BYTES),
      file.maxDbSizeBytes,
      undefined as number | undefined,
    ),
    pruneIntervalMs: pick(
      'pruneIntervalMs',
      overrides.pruneInterval,
      optionalNumber(env.LENS_PRUNE_INTERVAL_MS),
      file.pruneIntervalMs,
      60_000,
    ),
    sources,
    configFile,
  };
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
 * Parse `Name: value` header pairs from flags, `LENS_RPC_HEADERS`, and the
 * config file.
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
/**
 * Render a resolved config as `name = value (source)` lines for `lens config`
 * (#213). RPC header values are always redacted.
 */
export function describeConfig(config: LensConfig): { text: string } {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(config)) {
    if (key === 'sources') continue;
    const source = config.sources[key] ?? 'default';
    let rendered: string;
    if (key === 'rpcHeaders') {
      rendered = redactHeaders(value as Record<string, string>);
    } else if (Array.isArray(value)) {
      rendered = value.length === 0 ? '[]' : value.join(', ');
    } else if (value !== null && typeof value === 'object') {
      rendered = JSON.stringify(value);
    } else {
      rendered = String(value);
    }
    lines.push(`${key} = ${rendered} (${source})`);
  }
  return { text: lines.join('\n') };
}
