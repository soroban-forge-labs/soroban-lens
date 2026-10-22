import { rpc } from '@stellar/stellar-sdk';
import type { EventBatch, EventFilter, EventType, RawEvent, RetentionState } from './types.js';
import { withRetry, type RetryOptions } from './retry.js';
import type { IngestMetrics } from './metrics.js';
import { measureClockSkew, type ClockSkew } from './clock-skew.js';

export interface RpcClientOptions {
  rpcUrl: string;
  /** Required for plain-http endpoints such as a local quickstart node. */
  allowHttp?: boolean;
  /** Per-request timeout in seconds, passed through to the SDK. 0 disables. */
  timeoutSeconds?: number;
  headers?: Record<string, string>;
  retry?: RetryOptions;
  metrics?: IngestMetrics;
}

export interface GetEventsArgs {
  filters: EventFilter[];
  /** Mutually exclusive with `cursor` — the RPC rejects requests carrying both. */
  startLedger?: number;
  endLedger?: number;
  cursor?: string;
  limit?: number;
}

/** RPC page size ceiling, hardcoded in stellar-rpc for performance reasons. */
export const MAX_PAGE_SIZE = 10_000;
/** Each `getEvents` filter accepts at most 5 contract ids and 5 topic filters. */
export const MAX_CONTRACT_IDS_PER_FILTER = 5;

/**
 * Thin, retrying wrapper over the Soroban RPC `getEvents` / `getHealth` /
 * `getLatestLedger` methods.
 *
 * It deliberately calls the SDK's `_getEvents`, which returns topics and values
 * as base64 XDR strings rather than parsed `ScVala` objects. Keeping the wire
 * format intact is what lets Module 2 own all decoding and lets us persist the
 * exact bytes the network produced.
 */
export class LensRpcClient {
  readonly rpcUrl: string;
  readonly #retry: RetryOptions;
  readonly #metrics: IngestMetrics | undefined;
  readonly #server: rpc.Server;

  constructor(options: RpcClientOptions) {
    this.rpcUrl = options.rpcUrl;
    this.#server = new rpc.Server(options.rpcUrl, {
      allowHttp: options.allowHttp ?? options.rpcUrl.startsWith('http://'),
      timeout: options.timeoutSeconds ?? 30,
      ...(options.headers ? { headers: options.headers } : {}),
    });
    this.#retry = options.retry ?? {};
    this.#metrics = options.metrics;
  }

  async #attempt<T>(method: 'getHealth' | 'getLatestLedger' | 'getEvents', call: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await call();
    } catch (error) {
      this.#metrics?.rpcError(method, error);
      throw error;
    } finally {
      this.#metrics?.rpcDuration(method, (performance.now() - start) / 1000);
    }
  }

  /** Liveness plus the node's current retention window. */
  async health(): Promise<rpc.Api.GetHealthResponse> {
    return withRetry(() => this.#attempt('getHealth', () => this.#server.getHealth()), this.#retry);
  }

  async latestLedger(): Promise<number> {
    const res = await withRetry(() => this.#attempt('getLatestLedger', () => this.#server.getLatestLedger()), this.#retry);
    return res.sequence;
  }

  /**
   * Compare the local clock with the latest ledger's close time (#18).
   *
   * One attempt, no retry: this is a startup diagnostic, and waiting out a
   * flaky endpoint to report on it would delay the thing it is warning about.
   */
  async clockSkew(options: { thresholdSeconds?: number; now?: () => number } = {}): Promise<ClockSkew> {
    const latest = await withRetry(
      () => this.#attempt('getLatestLedger', () => this.#server._getLatestLedger()),
      { ...this.#retry, attempts: 1 },
    );
    return measureClockSkew(
      latest.sequence,
      latest.closeTime,
      (options.now ?? Date.now)(),
      options.thresholdSeconds,
    );
  }

  /**
   * Current retention window, used to clamp a start ledger into range and to
   * tell whether a saved cursor is still inside it (#17).
   */
  async retention(): Promise<RetentionState> {
    const h = await this.health();
    return { latestLedger: h.latestLedger, oldestLedger: h.oldestLedger };
  }

  /** Fetch one page of events. Never mixes cursor and ledger-range mode. */
  async getEvents(args: GetEventsArgs): Promise<EventBatch> {
    if (args.cursor && args.startLedger !== undefined) {
      throw new Error(
        'getEvents accepts either `cursor` or `startLedger`, never both (RPC rejects the mix).',
      );
    }
    if (!args.cursor && args.startLedger === undefined) {
      throw new Error('getEvents needs either a `cursor` or a `startLedger`.');
    }

    const limit = Math.min(args.limit ?? 200, MAX_PAGE_SIZE);
    const request = args.cursor
      ? { filters: args.filters, cursor: args.cursor, limit }
      : {
          filters: args.filters,
          startLedger: args.startLedger as number,
          ...(args.endLedger !== undefined ? { endLedger: args.endLedger } : {}),
          limit,
        };

    const raw = await withRetry(
      () => this.#attempt('getEvents', () => this.#server._getEvents(request as rpc.Api.GetEventsRequest)),
      this.#retry,
    );

    return {
      events: raw.events.map(toRawEvent),
      cursor: raw.cursor,
      latestLedger: raw.latestLedger,
      oldestLedger: raw.oldestLedger,
    };
  }

  /**
   * Poll each filter independently with its own cursor, bounded by `concurrency`.
   *
   * Ordering guarantees:
   *   - Within a chunk, events are returned in the RPC's natural order (the
   *     cursor semantics are per-request, so a chunk's page is always consistent).
   *   - Across chunks, the combined events are sorted by (ledger, transaction
   *     index, operation index, id) so callers see a deterministic global
   *     order regardless of which chunk finished first.
   *   - Each chunk advances its own cursor independently; a chunk that returns
   *     fewer than `limit` events is considered caught up for this page.
   */
  async getEventsChunked(args: GetEventsChunkedArgs): Promise<ChunkedEventBatch> {
    const { filters, cursors, startLedger, endLedger, limit, concurrency } = args;
    if (filters.length === 0) {
      throw new Error('getEventsChunked needs at least one filter.');
    }
    if (cursors && cursors.length !== filters.length) {
      throw new Error('`cursors` must have one entry per filter.');
    }
    const poolSize = Math.max(1, Math.min(concurrency ?? filters.length, filters.length));

    const results: EventBatch[] = new Array(filters.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const i = next++;
        if (i >= filters.length) return;
        const cursor = cursors?.[i];
        results[i] = await this.getEvents({
          filters: [filters[i]],
          ...(cursor ? { cursor: cursor } : { startLedger: startLedger as number }),
          ...(endLedger !== undefined ? { endLedger } : {}),
          ...(limit !== undefined ? { limit } : {}),
        });
      }
    };
    await Promise.all(Array.from({ length: poolSize }, () => worker()));

    const events: RawEvent[] = [];
    const nextCursors: string[] = [];
    let latestLedger = 0;
    let oldestLedger = Number.INFINITY;
    for (const batch of results) {
      for (const ev of batch.events) events.push(ev);
      nextCursors.push(batch.cursor);
      latestLedger = Math.max(latestLedger, batch.latestLedger);
      oldestLedger = Math.min(oldestLedger, batch.oldestLedger);
    }
    events.sort(compareRawEvents);
    return {
      events,
      cursors: nextCursors,
      latestLedger,
      oldestLedger: oldestLedger === Number.INFINITY ? 0 : oldestLedger,
    };
  }
}

export interface GetEventsChunkedArgs {
  filters: EventFilter[];
  /** One cursor per filter. Mutually exclusive with `startLedger`. */
  cursors?: string[];
  startLedger?: number;
  endLedger?: number;
  limit?: number;
  /** Maximum number of chunks in flight at once. Defaults to all chunks. */
  concurrency?: number;
}

export interface ChunkedEventBatch {
  events: RawEvent[];
  /** One next-cursor per input filter, in the same order as `filters`. */
  cursors: string[];
  latestLedger: number;
  oldestLedger: number;
}

/** Deterministic cross-chunk ordering: ledger, then tx index, operation index, then id. */
function compareRawEvents(a: RawEvent, b: RawEvent): number {
  if (a.ledger !== b.ledger) return a.ledger - b.ledger;
  if (a.transactionIndex !== b.transactionIndex) return a.transactionIndex - b.transactionIndex;
  if (a.operationIndex !== b.operationIndex) return a.operationIndex - b.operationIndex;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Normalise an SDK raw event into our `RawEvent` contract. */
function toRawEvent(e: rpc.Api.RawEventResponse): RawEvent {
  return {
    id: e.id,
    type: e.type,
    ledger: e.ledger,
    ledgerClosedAt: e.ledgerClosedAt,
    contractId: e.contractId,
    topic: e.topic ?? [],
    value: e.value,
    txHash: e.txHash,
    transactionIndex: e.transactionIndex,
    operationIndex: e.operationIndex,
    inSuccessfulContractCall: e.inSuccessfulContractCall,
  };
}

/**
 * Build `getEvents` filters for a set of contract ids, splitting into chunks
 * of at most `MAX_CONTRACT_IDS_PER_FILTER`. The RPC rejects a filter with more
 * than five contract ids, so a larger set must be split across multiple filters
 * in the same request.
 *
 * The single-filter case (one to five contracts) returns exactly one filter,
 * which is what keeps the single-contract path unchanged.
 */
export function buildFilters(
  contractIds: string[],
  topics?: string[][],
  eventType?: EventType,
): EventFilter[] {
  const base: EventFilter = {
    ...(eventType ? { type: eventType } : {}),
    ...(topics && topics.length > 0 ? { topics } : {}),
  };
  if (contractIds.length === 0) {
    return [base];
  }
  const filters: EventFilter[] = [];
  for (let i = 0; i < contractIds.length; i += MAX_CONTRACT_IDS_PER_FILTER) {
    filters.push({
      ...base,
      contractIds: contractIds.slice(i, i + MAX_CONTRACT_IDS_PER_FILTER),
    });
  }
  return filters;
}
