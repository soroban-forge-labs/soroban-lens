import {
  EventPoller, FailoverRpcClient, StellarArchiveSource, buildFilters, describeClockSkew, IngestMetrics,
  startMetricsServer, closeMetricsServer, parseMetricsPort,
} from '@soroban-lens/ingest';
import { createHash } from 'node:crypto';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CursorStore, CursorState, ReorgDiff, ReorgStore, StoredEventRef } from '@soroban-lens/ingest';
import { SqliteEventStore, MAX_QUERY_LIMIT } from '@soroban-lens/store';
import type { EventStore } from '@soroban-lens/store';
import type { LensConfig } from './config.js';
import { SpecFetcher, rpcSpecSource } from './specs.js';

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
    const { retention, ...position } = state;
    await this.#store.saveStreamState({
      key,
      ...position,
      // The RPC's tip and when it was seen, so /status can report lag (#181).
      ...(retention ? { latestLedger: retention.latestLedger, latestLedgerSeenAt: state.updatedAt } : {}),
    });
  }
  async clear(key: string): Promise<void> {
    await this.#store.saveStreamState({ key, cursor: '', ledger: 0, updatedAt: new Date().toISOString() });
  }
}

/**
 * Adapts the `EventStore` to Module 1's `ReorgStore` (#3): the poller reads
 * back what was stored for its newest ledgers, and hands over repairs.
 */
export class StoreBackedReorgs implements ReorgStore {
  readonly #store: EventStore;
  readonly #contracts: Set<string> | null;
  constructor(store: EventStore, contractIds: string[]) {
    this.#store = store;
    // Only this stream's contracts: rows another configuration indexed into
    // the same database are not this poller's to judge.
    this.#contracts = contractIds.length > 0 ? new Set(contractIds) : null;
  }

  async eventsInLedgers(fromLedger: number, toLedger: number): Promise<StoredEventRef[]> {
    const out: StoredEventRef[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.#store.queryEvents({
        fromLedger,
        toLedger,
        order: 'asc',
        limit: MAX_QUERY_LIMIT,
        skipTotal: true,
        ...(cursor ? { cursor } : {}),
      });
      for (const e of page.events) {
        if (this.#contracts && !this.#contracts.has(e.contractId)) continue;
        out.push({
          id: e.id,
          ledger: e.ledger,
          txHash: e.txHash,
          inSuccessfulContractCall: e.inSuccessfulContractCall,
          topicsXdr: e.topicsXdr,
          valueXdr: e.valueXdr,
        });
      }
      if (!page.nextCursor) return out;
      cursor = page.nextCursor;
    }
  }

  async applyReorg(diff: ReorgDiff): Promise<void> {
    // Delete before insert: insertEvents is idempotent on id, so a changed row
    // has to go before its corrected version can land.
    await this.#store.deleteEvents([...diff.removed, ...diff.changed.map((e) => e.id)]);
    await this.#store.insertEvents([...diff.added, ...diff.changed]);
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
 * Returns the current on-disk size of the database file plus its WAL, in
 * bytes. Missing files count as zero so a fresh database does not throw.
 */
export function databaseSizeBytes(dbPath: string): number {
  const sizeOf = (path: string): number => {
    try {
      return existsSync(path) ? statSync(path).size : 0;
    } catch {
      return 0;
    }
  };
  return sizeOf(dbPath) + sizeOf(`${dbPath}-wal`);
}

/**
 * Path of the heartbeat file for one stream. Keyed by the stream/cursor key so
 * two indexers on one machine never overwrite each other's heartbeat (#207).
 */
export function heartbeatPath(streamKey: string): string {
  const hash = createHash('sha256').update(streamKey).digest('hex').slice(0, 16);
  return join(tmpdir(), `lens-heartbeat-${hash}.json`);
}

/**
 * Writes the heartbeat file for a stream. Called on every completed poll, not
 * every yielded batch, so a quiet contract at the tip stays healthy (#207).
 */
export function writeHeartbeat(streamKey: string, ledger: number, latestLedger: number): void {
  try {
    writeFileSync(
      heartbeatPath(streamKey),
      JSON.stringify({ stream: streamKey, ledger, latestLedger, at: new Date().toISOString() }),
    );
  } catch {
    // A heartbeat that cannot be written must never stop indexing.
  }
}

/**
 * Prunes oldest ledgers in chunks until the database (+ WAL) fits under
 * `sizeBytes`, then checkpoints to reclaim space. Returns the number of
 * ledgers removed. The store stops on its own once a chunk removes nothing,
 * so a store that cannot shrink further does not loop forever.
 */
export async function pruneToSize(
  store: EventStore,
  dbPath: string,
  sizeBytes: number,
  options: {
    chunkLedgers?: number;
    log?: (message: string) => void;
  } = {},
): Promise<number> {
  const log = options.log ?? (() => {});
  const before = databaseSizeBytes(dbPath);
  if (before <= sizeBytes) return 0;
  const result = await store.pruneToSize(sizeBytes, options.chunkLedgers);
  if (result.ledgersRemoved > 0) {
    log(
      `size target ${sizeBytes}B: pruned ${result.rowsRemoved} event(s) across ${result.ledgersRemoved} ledger(s), ` +
        `${before} -> ${databaseSizeBytes(dbPath)} bytes` +
        (result.withinTarget ? '' : ' (still over target)'),
    );
  }
  return result.ledgersRemoved;
}

/**
 * Runs the full pipeline: Module 1 polls, Module 2 decodes and stores.
 *
 * This is the only place the two modules meet. `RawEvent` and `RawEventInput`
 * are structurally identical by design, so nothing has to be converted here —
 * if that ever stops type-checking, the data contract has drifted and both
 * READMEs need updating.
 */
export async function runIndexer(options: IndexerOptions): Promise<IndexerResult> {
  const { config } = options;
  const log = options.log ?? (() => {});
  const metricsPort = parseMetricsPort(process.env.LENS_METRICS_PORT);
  const metrics = new IngestMetrics();

  const store = new SqliteEventStore({ path: config.dbPath, typedFieldIndex: config.typedFieldIndex });
  const client = new FailoverRpcClient({
    metrics,
    rpcUrls: config.rpcUrls,
    ...(Object.keys(config.rpcHeaders).length > 0 ? { headers: config.rpcHeaders } : {}),
    retry: {
      ...config.retry,
      onRetry: (attempt, delay, error) =>
        log(`rpc retry ${attempt} in ${delay}ms: ${error instanceof Error ? error.message : String(error)}`),
    },
  });

  // No cursorKey override: the poller keys each contract's saved position to
  // that contract plus the shared filters, so adding a contract does not
  // disturb anyone else's resume point (#142) and a single-contract run keeps
  // the key earlier versions produced (#127).
  const poller = new EventPoller(
    {
      contractIds: config.contractIds,
      pageSize: config.pageSize,
      pollIntervalMs: config.pollIntervalMs,
      maxPollIntervalMs: config.maxPollIntervalMs,
      // Fail fast when `--network` and the node disagree (#139). This is the
      // exact combination that otherwise indexes testnet data as mainnet.
      networkPassphrase: config.network.networkPassphrase,
      reorgDepth: config.reorgDepth,
      ...(config.pageSizeBounds ? { pageSizeBounds: config.pageSizeBounds } : {}),
      ...(config.startLedger !== undefined ? { startLedger: config.startLedger } : {}),
      ...(config.endLedger !== undefined ? { endLedger: config.endLedger } : {}),
      ...(config.topics && config.topics.length > 0 ? { topics: config.topics } : {}),
      ...(config.eventType !== undefined ? { eventType: config.eventType } : {}),
    },
    {
      client,
      metrics,
      cursors: new StoreBackedCursors(store),
      reorgStore: new StoreBackedReorgs(store, config.contractIds),
      ...(options.signal ? { signal: options.signal } : {}),
      log,
      // Written on every completed poll, even when the page yielded no events,
      // so a quiet contract at the tip does not look unhealthy (#207).
      onPoll: (progress) => writeHeartbeat(progress.cursorKey, progress.ledger, progress.latestLedger),
    },
  );

  const specs = config.fetchSpecs
    ? new SpecFetcher(store, rpcSpecSource(config.network.rpcUrl, config.rpcHeaders), { log })
    : undefined;
  specs?.enqueue(config.contractIds);

  let inserted = 0;
  let seen = 0;
  let lastLedger = 0;
  let metricsServer: Awaited<ReturnType<typeof startMetricsServer>> | undefined;
  let sizeTimer: ReturnType<typeof setInterval> | undefined;
  let sizePruning = false;

  try {
    if (metricsPort !== undefined) {
      metricsServer = await startMetricsServer(
        metrics,
        metricsPort,
        process.env.LENS_METRICS_HOST ?? '127.0.0.1',
        Math.max(config.pollIntervalMs * 3, 1000),
      );
      log(`metrics listening on ${process.env.LENS_METRICS_HOST ?? '127.0.0.1'}:${metricsPort}/metrics`);
    }
    log(
      `indexing ${config.network.name} (${config.network.rpcUrl}) tinto ${config.dbPath}; ` +
        `${config.contractIds.length || 'all'} contract(s), stream "${poller.cursorKey}"`,
    );

    if (config.archiveUrl && config.startLedger !== undefined) {
      const archive = new StellarArchiveSource({ archiveUrl: config.archiveUrl });
      const retention = await client.retention();
      const archiveEnd = Math.min(config.startLedger < retention.oldestLedger ? retention.oldestLedger - 1 : 0, retention.latestLedger);
      if (archiveEnd >= config.startLedger) {
        log(`backfilling ledgers ${config.startLedger}..${archiveEnd} from archive ${config.archiveUrl}`);
        const archived = await archive.getEvents({ startLedger: config.startLedger, endLedger: archiveEnd, filters: buildFilters(config.contractIds), limit: 10000 });
        const added = await store.insertEvents(archived.events);
        log(`archive backfill: +${added} new of ${archived.events.length} events through ledger ${archiveEnd}`);
      }
    }
    // A skewed local clock does not stop indexing, it makes every time-based
    // query misleading (#18) — so it is a warning, and it must not block startup.
    try {
      const skew = await client.clockSkew({ thresholdSeconds: config.clockSkewThresholdSeconds });
      if (skew.exceedsThreshold) {
        log(
          `WARNING: ${describeClockSkew(skew)}, beyond the ${skew.thresholdSeconds}s threshold. ` +
            'fromTime/toTime queries use ledger close time and will be misleading; sync this machine with NTP, ' +
            'or set LENS_CLOCK_SKEW_THRESHOLD_SECONDS to silence this. Run `lens doctor` for details.',
        );
      }
    } catch (error) {
      log(`could not check clock skew: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Optional size target: when the database grows past the cap, prune the
    // oldest ledgers in chunks until it fits, then checkpoint. Runs on an
    // interval so a long-running indexer stays within the operator's disk budget.
    if (config.maxDbSizeBytes !== undefined) {
      const target = config.maxDbSizeBytes;
      const intervalMs = config.pruneIntervalMs;
      const runSizePrune = async (): Promise<void> => {
        if (sizePruning) return;
        sizePruning = true;
        try {
          await pruneToSize(store, config.dbPath, target, { log });
        } catch (error) {
          log(`size prune failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          sizePruning = false;
        }
      };
      log(`size target ${target}B enabled; checking every ${intervalMs}ms`);
      sizeTimer = setInterval(() => void runSizePrune(), intervalMs);
      // Do not hold the process open just for the timer.
      sizeTimer.unref?.();
      void runSizePrune();
    }

    // Write an initial heartbeat so the healthcheck passes before the first
    // poll completes.
    writeHeartbeat(poller.cursorKey, config.startLedger ?? 0, 0);

    for await (const batch of poller.stream()) {
      const added = await store.insertEvents(batch.events);
      // Watching every contract, the configured list is empty, so specs are
      // looked up as contracts first appear. Already-seen ids are a Set hit.
      specs?.enqueue(batch.events.map((e) => e.contractId));
      inserted += added;
      seen += batch.events.length;
      lastLedger = batch.progress.ledger;

      // Lag comes from the poller rather than being recomputed here, so the
      // CLI, the metrics endpoint and the API all report the same number.
      const { lagLedgers, lagSeconds, measuredLagSeconds } = batch.progress;
      // Measured from the last event's close time when there is one (#134);
      // the ~5 s-per-ledger estimate only stands in when there is not.
      const lagText = measuredLagSeconds !== null ? `${measuredLagSeconds}s` : `~${lagSeconds}s est.`;
      log(
        `ledger ${batch.progress.ledger}/${batch.progress.latestLedger}: ` +
          `+${added} new of ${batch.events.length} (${inserted} total)` +
          (lagLedgers > 0 ? `, ~${lagLedgers} ledgers behind (${lagText})` : ', caught up'),
      );

      if (options.maxEvents !== undefined && seen >= options.maxEvents) {
        log(`reached maxEvents (${options.maxEvents})`);
        break;
      }
      if (options.stopWhenCaughtUp && batch.progress.caughtUp) {
        log(`caught up at ledger ${batch.progress.latestLedger}`);
        break;
      }
      if (config.endLedger !== undefined && batch.progress.ledger >= config.endLedger) {
        log(`reached endLedger (${config.endLedger})`);
        break;
      }
    }
  } finally {
    if (sizeTimer) clearInterval(sizeTimer);
    // A lookup still queued is cheap to redo next run; one in flight is
    // allowed to finish so it never writes to a closed store.
    specs?.stop();
    await specs?.idle();
    try {
      if (metricsServer) await closeMetricsServer(metricsServer);
    } finally {
      await store.close();
    }
  }

  return { inserted, seen, lastLedger };
}
