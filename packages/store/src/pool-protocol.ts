/**
 * Wire format between `PooledSqliteEventStore` and its read workers.
 *
 * Kept in its own module so neither side imports the other: the pool spawns
 * `read-worker.js` by URL, and importing that file from the parent would run a
 * worker's top-level on the main thread.
 */
import type { EventStore } from './store.js';

/**
 * The `EventStore` methods a read worker may serve.
 *
 * Every entry must be safe on a connection opened `readOnly: true`, which rules
 * out more than it looks: `exportSnapshot` does `VACUUM INTO` plus a nested
 * connection, `checkpoint` is a write pragma, and `writeProbe` writes on
 * purpose. `getLatestEventId` is absent deliberately — see `pooled-store.ts`.
 */
export const READ_METHODS = [
  'getEvent',
  'queryEvents',
  'listContracts',
  'listContractsPage',
  'summarizeAddress',
  'listTopics',
  'countByTopic',
  'countByTimeBucket',
  'getStats',
  'healthCheck',
  'getContractSpec',
  'listContractSpecs',
  'loadStreamState',
  'listStreamStates',
  'checkIntegrity',
] as const satisfies readonly (keyof EventStore)[];

export type ReadMethod = (typeof READ_METHODS)[number];

export interface PoolRequest {
  seq: number;
  method: ReadMethod;
  args: unknown[];
}

/**
 * An `Error` flattened for `postMessage`.
 *
 * The message is carried verbatim because callers match on it: the conformance
 * suite asserts on rejection messages, and `queryEvents` explains a missing
 * FTS5 build in prose that a user is meant to read.
 */
export interface SerialisedError {
  name: string;
  message: string;
  stack?: string | undefined;
}

export type PoolResponse =
  /** Sent once, when the worker's connection is open and usable. */
  | { kind: 'ready' }
  /** Sent once, when opening the connection threw: `open()` rejects with it. */
  | { kind: 'failed'; error: SerialisedError }
  | { kind: 'result'; seq: number; value: unknown }
  | { kind: 'error'; seq: number; error: SerialisedError };

export interface ReadWorkerData {
  path: string;
  countCacheTtlMs?: number | undefined;
  forceDisableFts5?: boolean | undefined;
}

export function serialiseError(error: unknown): SerialisedError {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { name: 'Error', message: String(error), stack: undefined };
}

/**
 * Rebuild a worker-side error on the main thread.
 *
 * The original stack is appended rather than replaced: a stack that stops at
 * the pool's own `postMessage` tells you nothing about which query failed.
 */
export function reviveError(error: SerialisedError): Error {
  const revived = new Error(error.message);
  revived.name = error.name;
  if (error.stack !== undefined) revived.stack = error.stack;
  return revived;
}
