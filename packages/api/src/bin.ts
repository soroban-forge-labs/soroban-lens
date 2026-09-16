#!/usr/bin/env node
/** `soroban-lens-api` — serve the query API over an indexed database. */
import { parseArgs } from 'node:util';
import { SqliteEventStore, createLogger } from '@soroban-lens/store';
import { createApiServer } from './server.js';

const USAGE = `
soroban-lens-api — HTTP query API over indexed Soroban events

Usage:
  soroban-lens-api [--db ./data/lens.db] [--port 8080]

Options:
  -d, --db <path>     SQLite file (default: ./data/lens.db, env LENS_DB_PATH)
  -p, --port <n>      Port to listen on (default: 8080, env LENS_API_PORT)
      --host <addr>   Bind address (default: 0.0.0.0, env LENS_API_HOST)
      --cors <origin> Access-Control-Allow-Origin (default: *, env LENS_CORS_ORIGIN)
  -h, --help          Show this help.
`;

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    db: { type: 'string', short: 'd' },
    port: { type: 'string', short: 'p' },
    host: { type: 'string' },
    cors: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}

const log = createLogger({ prefix: '[api]' });

const dbPath = values.db ?? process.env.LENS_DB_PATH ?? './data/lens.db';
const port = Number(values.port ?? process.env.LENS_API_PORT ?? 8080);
const host = values.host ?? process.env.LENS_API_HOST ?? '0.0.0.0';

const store = new SqliteEventStore({ path: dbPath, log });
const server = createApiServer({
  store,
  network: process.env.LENS_NETWORK ?? 'testnet',
  ...(values.cors ?? process.env.LENS_CORS_ORIGIN
    ? { corsOrigin: values.cors ?? (process.env.LENS_CORS_ORIGIN as string) }
    : {}),
  log,
});

server.listen(port, host, () => {
  log.info('listening', `listening on http://${host}:${port} (db: ${dbPath})`, { host, port, dbPath });
  log.info('listening', `openapi: http://${host}:${port}/openapi.json`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log.info('shutdown', `${signal}, shutting down`, { signal });
    server.close(() => {
      void store.close().then(() => process.exit(0));
    });
  });
}
