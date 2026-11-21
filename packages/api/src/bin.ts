#!/usr/bin/env node
/** `soroban-lens-api` — serve the query API over an indexed database. */
import { parseArgs } from 'node:util';
import { SqliteEventStore, createLogger } from '@soroban-lens/store';
import { createApiServer, shutdownApiServer } from './server.js';

const USAGE = `
soroban-lens-api — HTTP query API over indexed Soroban events

Usage:
  soroban-lens-api [--db ./data/lens.db] [--port 8080]

Options:
  -d, --db <path>     SQLite file (default: ./data/lens.db, env LENS_DB_PATH)
  -p, --port <n>      Port to listen on (default: 8080, env LENS_API_PORT)
      --host <addr>   Bind address (default: 0.0.0.0, env LENS_API_HOST)
      --cors <origin> Access-Control-Allow-Origin (default: *, env LENS_CORS_ORIGIN)
      --shutdown-timeout <ms>
                      How long to wait for in-flight requests on SIGINT/SIGTERM
                      before dropping them (default: 10000, env LENS_SHUTDOWN_TIMEOUT_MS)
  -h, --help          Show this help.

Access control (all off unless set):
  LENS_RATE_LIMIT_RPS    Requests per second allowed per client IP (token bucket).
  LENS_RATE_LIMIT_BURST  Bucket size (default: LENS_RATE_LIMIT_RPS, rounded up).
  LENS_API_KEYS          Comma-separated API keys; when set, requests must send
                         X-API-Key or Authorization: Bearer <key>.
  LENS_TRUST_PROXY       1 to read the client IP from X-Forwarded-For (behind a proxy).

Optional features (both off by default):
  LENS_GRAPHQL=1                 Serve GraphQL at /graphql.
  LENS_GRAPHQL_MAX_DEPTH=<n>     Deepest query allowed (default 8).
  LENS_GRAPHQL_MAX_COMPLEXITY=<n> Highest estimated query cost (default 5000).
  LENS_WEBHOOKS=1                Serve webhook subscriptions at /webhooks.
  LENS_WEBHOOKS_TOKEN=<secret>   Require this bearer token on /webhooks (recommended).
  LENS_WEBHOOKS_ALLOW_PRIVATE=1  Allow loopback/private targets. Development only.
`;

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    db: { type: 'string', short: 'd' },
    port: { type: 'string', short: 'p' },
    host: { type: 'string' },
    cors: { type: 'string' },
    'shutdown-timeout': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}

const log = createLogger({ prefix: '[api]' });

const dbPath = values.db ?? process.env.LENS_DB_PATH ?? './data/lens.db';
const rawPort = values.port ?? process.env.LENS_API_PORT ?? '8080';
const port = Number(rawPort);
if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
  process.stderr.write(`soroban-lens-api: --port must be an integer from 1 to 65535, got "${rawPort}".\n`);
  process.exit(2);
}
const host = values.host ?? process.env.LENS_API_HOST ?? '0.0.0.0';

const shutdownTimeoutMs = Number(
  values['shutdown-timeout'] ?? process.env.LENS_SHUTDOWN_TIMEOUT_MS ?? 10_000,
);

const rateLimit = parseRateLimit();
const apiKeys = (process.env.LENS_API_KEYS ?? '')
  .split(',')
  .map((key) => key.trim())
  .filter((key) => key !== '');

function parseRateLimit(): { requestsPerSecond: number; burst?: number } | undefined {
  const rawRate = process.env.LENS_RATE_LIMIT_RPS;
  if (rawRate === undefined || rawRate.trim() === '') return undefined;
  const requestsPerSecond = Number(rawRate);
  if (!Number.isFinite(requestsPerSecond) || requestsPerSecond <= 0) {
    log.error('config', `LENS_RATE_LIMIT_RPS must be a positive number, got "${rawRate}".`);
    process.exit(1);
  }
  const rawBurst = process.env.LENS_RATE_LIMIT_BURST;
  if (rawBurst === undefined || rawBurst.trim() === '') return { requestsPerSecond };
  const burst = Number(rawBurst);
  if (!Number.isFinite(burst) || burst < 1) {
    log.error('config', `LENS_RATE_LIMIT_BURST must be at least 1, got "${rawBurst}".`);
    process.exit(1);
  }
  return { requestsPerSecond, burst };
}

const store = new SqliteEventStore({ path: dbPath, log });

/** A positive integer from the environment, or undefined when unset or unusable. */
function envInt(name: string): number | undefined {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}
const graphqlMaxDepth = envInt('LENS_GRAPHQL_MAX_DEPTH');
const graphqlMaxComplexity = envInt('LENS_GRAPHQL_MAX_COMPLEXITY');
const webhookToken = process.env.LENS_WEBHOOKS_TOKEN;
const server = createApiServer({
  store,
  ...(rateLimit ? { rateLimit } : {}),
  ...(apiKeys.length > 0 ? { apiKeys } : {}),
  trustProxy: ['1', 'true'].includes((process.env.LENS_TRUST_PROXY ?? '').toLowerCase()),
  network: process.env.LENS_NETWORK ?? 'testnet',
  ...(values.cors ?? process.env.LENS_CORS_ORIGIN
    ? { corsOrigin: values.cors ?? (process.env.LENS_CORS_ORIGIN as string) }
    : {}),
  log,
  graphql: {
    enabled: process.env.LENS_GRAPHQL === '1',
    ...(graphqlMaxDepth !== undefined ? { maxDepth: graphqlMaxDepth } : {}),
    ...(graphqlMaxComplexity !== undefined ? { maxComplexity: graphqlMaxComplexity } : {}),
  },
  webhooks: {
    enabled: process.env.LENS_WEBHOOKS === '1',
    allowPrivateNetworks: process.env.LENS_WEBHOOKS_ALLOW_PRIVATE === '1',
    ...(webhookToken ? { authToken: webhookToken } : {}),
  },
});

server.listen(port, host, () => {
  log.info('listening', `listening on http://${host}:${port} (db: ${dbPath})`, { host, port, dbPath });
  log.info('listening', `openapi: http://${host}:${port}/openapi.json`);
});

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutdown', `${signal}, draining in-flight requests`, { signal, shutdownTimeoutMs });
    // Close the store only after the server has drained, so a request being
    // served never has the database closed out from under it.
    void shutdownApiServer(server, { timeoutMs: shutdownTimeoutMs })
      .then(({ forced }) => {
        if (forced) log.warn('shutdown', 'timed out waiting for in-flight requests; dropped them');
        return store.close();
      })
      .finally(() => process.exit(0));
  });
}
