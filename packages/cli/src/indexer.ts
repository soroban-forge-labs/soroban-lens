import { writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventPoller, LensRpcClient, defaultCursorKey } from '@soroban-lens/ingest';
import type { CursorStore, CursorState } from '@soroban-lens/ingest';
import { SqliteEventStore } from '@soroban-lens/store';
import type { EventStore } from '@soroban-lens/store';
import type { LensConfig } from './config.js';

export const INDEXER_HEARTBEAT_FILE = join(tmpdir(), 'lens-indexer-heartbeat');


/**
 * Adapts the `EventStore` to Module 1's `CursorStore` interface, so resume
 * state lives in the same database as the events.
 *
 * One file to back up, one file to delete when starting over, and the API can
 * report indexer lag from `/status` without reading Module 1's cursor files.
 */
export class StoreBackedCursors implements CursorStore {
  readonly #store: EventStore;
  constructor(store: EventStore) {
    this.#store = store;
  }
  async load(key: string): Promise<CursorState | null> {
    const state = await this.#store.loadStreamState(key);
    // An empty cursor is the tombstone `clear()` leaves behind, and it means
    // "no position", not "position is the empty string". Returning it as a
    // valid state would leave the poller with neither a cursor nor a start
    // ledger on the next restart. FileCursorStore guards this the same way.
    if (!state || state.cursor === '') return null;
    return { cursor: state.cursor, ledger: state.ledger, updatedAt: state.updatedAt };
  }
  async save(key: string, state: CursorState): Promise<void> {
    await this.#store.saveStreamState({ key, ...state });
  }
  async clear(key: string): Promise<void> {
    await this.#store.saveStreamState({ key, cursor: '', ledger: 0, updatedAt: new Date().toISOString() });
  }
}

export interface IndexerOptions {
  config: LensConfig;
  signal?: AbortSignal;
  log?: (message: string) => void;
  /** Stop after this many events. Used by `--once` and by tests. */
  maxEvents?: number;
  /** Stop as soon as the stream reaches the network tip. */
  stopWhenCaughtUp?: boolean;
}

export interface IndexerResult {
  inserted: number;
  seen: number;
  lastLedger: number;
}

/**
 * The full pipeline: Module 1 polls, Module 2 decodes and stores.
 *
 * This is the only place the two modules meet. `RawEvent` and `RawEventInput`
 * are structurally identical by design, so nothing has to be converted here —
 * if that ever stops type-checking, the data contract has drifted and both
 * READMEs need updating.
 */
export async function runIndexer(options: IndexerOptions): Promise<IndexerResult> {
  const { config } = options;
  const log = options.log ?? (() => {});

  const store = new SqliteEventStore({ path: config.dbPath });
  const client = new LensRpcClient({
    rpcUrl: config.network.rpcUrl,
    ...(Object.keys(config.rpcHeaders).length > 0 ? { headers: config.rpcHeaders } : {}),
    retry: {
      ...config.retry,
      onRetry: (attempt, delay, error) =>
        log(`rpc retry ${attempt} in ${delay}ms: ${error instanceof Error ? error.message : String(error)}`),
    },
  });

  const cursorKey = defaultCursorKey(config.network.rpcUrl, config.contractIds);
  const poller = new EventPoller(
    {
      contractIds: config.contractIds,
      pageSize: config.pageSize,
      pollIntervalMs: config.pollIntervalMs,
      ...(config.startLedger !== undefined ? { startLedger: config.startLedger } : {}),
    },
    {
      client,
      cursors: new StoreBackedCursors(store),
      cursorKey,
      ...(options.signal ? { signal: options.signal } : {}),
      log,
    },
  );

  let inserted = 0;
  let seen = 0;
  let lastLedger = 0;

  try {
    log(
      `indexing ${config.network.name} (${config.network.rpcUrl}) into ${config.dbPath}; ` +
        `${config.contractIds.length || 'all'} contract(s), stream "${cursorKey}"`,
    );

    for await (const batch of poller.stream()) {
      try {
        writeFileSync(INDEXER_HEARTBEAT_FILE, Date.now().toString());
      } catch {}

      const added = await store.insertEvents(batch.events);
      inserted += added;
      seen += batch.events.length;
      lastLedger = batch.progress.ledger;

      // Lag comes from the poller rather than being recomputed here, so the
      // CLI, the metrics endpoint and the API all report the same number.
      const { lagLedgers, lagSeconds } = batch.progress;
      log(
        `ledger ${batch.progress.ledger}/${batch.progress.latestLedger}: ` +
          `+${added} new of ${batch.events.length} (${inserted} total)` +
          (lagLedgers > 0 ? `, ~${lagLedgers} ledgers behind (~${lagSeconds}s)` : ', caught up'),
      );

      if (options.maxEvents !== undefined && seen >= options.maxEvents) {
        log(`reached maxEvents (${options.maxEvents})`);
        break;
      }
      if (options.stopWhenCaughtUp && batch.progress.caughtUp) {
        log(`caught up at ledger ${batch.progress.latestLedger}`);
        break;
      }
    }
  } finally {
    await store.close();
  }

  return { inserted, seen, lastLedger };
}
