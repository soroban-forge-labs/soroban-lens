/**
 * One read worker: a thread owning a single read-only SQLite connection.
 *
 * `node:sqlite` is synchronous, so a query here burns this thread's event loop
 * and not the parent's. That is the whole point (#159) — the parent stays free
 * to serve `/health` while a full-text search or a `COUNT(*)` grinds in here.
 *
 * Spawned only by `pooled-store.ts`; it is not part of the package's public
 * surface and must not be imported from the main thread, whose module graph
 * would then run this file's top level.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { SqliteEventStore } from './sqlite-store.js';
import {
  READ_METHODS,
  serialiseError,
  type PoolRequest,
  type PoolResponse,
  type ReadWorkerData,
} from './pool-protocol.js';

if (parentPort === null) {
  throw new Error('read-worker.js is a worker entry point and cannot be run directly');
}
const port = parentPort;
const data = workerData as ReadWorkerData;

/** Guards against a parent bug sending a write method down a read-only connection. */
const allowed = new Set<string>(READ_METHODS);

function reply(message: PoolResponse): void {
  port.postMessage(message);
}

/**
 * `log` and `now` are deliberately not forwarded from the parent's options:
 * both are functions, and functions do not survive `postMessage`. No read path
 * logs, and `now` only drives the count cache's TTL, so each worker uses the
 * default no-op logger and `Date.now`.
 */
function open(): SqliteEventStore | null {
  try {
    return new SqliteEventStore({
      path: data.path,
      readOnly: true,
      // The writer owns the schema. A worker that migrated would race it, and
      // a read-only connection could not anyway.
      migrateOnOpen: false,
      checkpointIntervalMs: 0,
      ...(data.countCacheTtlMs !== undefined ? { countCacheTtlMs: data.countCacheTtlMs } : {}),
      ...(data.forceDisableFts5 !== undefined ? { forceDisableFts5: data.forceDisableFts5 } : {}),
    });
  } catch (error) {
    reply({ kind: 'failed', error: serialiseError(error) });
    return null;
  }
}

async function handle(store: SqliteEventStore, request: PoolRequest): Promise<void> {
  try {
    if (!allowed.has(request.method)) {
      throw new Error(`read worker refused "${request.method}": not a pooled read method`);
    }
    const method = store[request.method] as unknown as (...args: unknown[]) => Promise<unknown>;
    const value = await method.apply(store, request.args);
    reply({ kind: 'result', seq: request.seq, value });
  } catch (error) {
    reply({ kind: 'error', seq: request.seq, error: serialiseError(error) });
  }
}

const store = open();
if (store !== null) {
  port.on('message', (request: PoolRequest) => {
    void handle(store, request);
  });
  port.on('close', () => {
    void store.close();
  });
  reply({ kind: 'ready' });
}
