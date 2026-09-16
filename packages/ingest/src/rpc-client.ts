import { rpc } from '@stellar/stellar-sdk';
import type { EventBatch, EventFilter, EventType, RawEvent, RetentionState } from './types.js';
import { withRetry, type RetryOptions } from './retry.js';
import type { IngestMetrics } from './metrics.js';

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
 * as base64 XDR strings rather than parsed `ScVal` objects. Keeping the wire
 * format intact is what lets Module 2 own all decoding and lets us persist the
 * exact bytes the network produced.
 */
export class LensRpcClient {
  readonly rpcUrl: string;
  readonly #server: rpc.Server;
  readonly #retry: RetryOptions;
  readonly #metrics: IngestMetrics | undefined;

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

  /** Current retention window, used to clamp a start ledger into range. */
  async retention(): Promise<RetentionState> {
    const h = await this.health();
    return {
      latestLedger: h.latestLedger,
      oldestLedger: h.oldestLedger,
      latestLedgerCloseTime: '',
      oldestLedgerCloseTime: '',
    };
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
 * Build `getEvents` filters for a set of contract ids, splitting into chunks of
 * 5 because that is the per-filter ceiling the RPC enforces.
 */
export function buildFilters(
  contractIds: string[],
  topics?: string[][],
  eventType: EventType = 'contract',
): EventFilter[] {
  if (contractIds.length === 0) {
    return [{ type: eventType, ...(topics?.length ? { topics } : {}) }];
  }
  const filters: EventFilter[] = [];
  for (let i = 0; i < contractIds.length; i += MAX_CONTRACT_IDS_PER_FILTER) {
    filters.push({
      type: eventType,
      contractIds: contractIds.slice(i, i + MAX_CONTRACT_IDS_PER_FILTER),
      ...(topics?.length ? { topics } : {}),
    });
  }
  return filters;
}
