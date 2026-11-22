/*
 * Module 1 public data contract.
 *
 * `RawEvent` mirrors, field for field, one entry of the `events` array returned
 * by the Soroban RPC `getEvents` method with the default `xdrFormat: "base64"`.
 * It is deliberately a *transport* type: topics and values stay base64-encoded
 * XDR here. Decoding is Module 2's job (`soroban-lens/store`).
 *
 * Reference: https://developers.stellar.org/docs/data/apis/rpc/api-reference/methods/getEvents
 *
 * Downstream modules MUST NOT import this package just for the type — they
 * declare a structurally identical shape so that Person A and Person B can work
 * without a build-order dependency. Any change here is a breaking change to the
 * whole pipeline and needs a note in CONTRIBUTING.md.
 */
export interface RawEvent {
  /** Opaque unique event id, e.g. "0020166232959352832-0000000000". Sorts by ledger. */
  id: string;
  /**
   * RPC only emits "contract" and "system" event types. Verified against a
   * live node: since Protocol 23, `getEvents` no longer returns diagnostic
   * events at all (#144). See `EventType` below.
   */
  type: 'contract' | 'system';
  /** Ledger sequence number the event was emitted in. */
  ledger: number;
  /** RFC3339 close time of that ledger, e.g. "2026-09-15T19:22:52Z". */
  ledgerClosedAt: string;
  /** StrRink contract address ("C...") that emitted the event. */
  contractId: string;
  /** Event topics, each a base64-encoded XDR ScVal. */
  topic: string[];
  /** Event body, a base64-encoded XDR ScVal. */
  value: string;
  /** Hex transaction hash the event came from. */
  txHash: string;
  transactionIndex: number;
  operationIndex: number;
  inSuccessfulContractCall: boolean;
}

/** One page of events plus the cursor needed to fetch the next page. */
export interface EventBatch {
  events: RawEvent[];
  /** Opaque paging token; feed back as `cursor` to continue. */
  cursor: string;
  /** Latest ledger the RPC node knows about. */
  latestLedger: number;
  /** Oldest ledger still inside the node's retention window. */
  oldestLedger: number;
}

/**
 * The ledgers a node still serves, as `getHealth` reports them.
 *
 * Only the two ledgers the RPC actually reports: readers used to get
 * `latestLedgerCloseTime`/`oldestLedgerCloseTime` as permanent empty strings,
 * which looked like data and was not (#17). Nothing consumed them, so they are
 * gone rather than kept as a promise this module cannot keep.
 */
export interface RetentionState {
  /** Latest ledger the node knows about. */
  latestLedger: number;
  /** Oldest ledger still inside the node's retention window. */
  oldestLedger: number;
}

/** A topic filter segment: an exact base64 ScVal, or "*" to match any one segment. */
export type TopicSegment = string;

/**
 * Event classes `getEvents` actually serves.
 *
 * `diagnostic` was removed in #144. It was in this union, and in the
 * `--type` flag, but the RPC has not returned diagnostic events from
 * `getEvents` since Protocol 23 — they are only exposed through
 * `getTransaction`'s `diagnosticEventsXdr`, gated behind
 * `ENABLE_SOROBAN_DIAGNOSTIC_EVENTS=true` on the node. Keeping `diagnostic`
 * here meant `--type diagnostic` could never return anything, and any event it
 * *did* return would have fallen outside the store's two-valued `type` column.
 * The flag, this union, and the store now agree on the two types the RPC emits.
 *
 * Verified against:
 *   https://docs.rs/soroban-client/latest/soroban_client/soroban_rpc/enum.EventType.html
 *   ("Since protocol 23: Diagnostic events are no longer returned by get_events")
 */
export type EventType = 'contract' | 'system';

export interface EventFilter {
  type?: EventType;
  /** Max 5 contract ids per filter (RPC limit). */
  contractIds?: string[];
  /** Max 5 topic filters per filter, each 1-4 segments (RPC limit). */
  topics?: TopicSegment[][];
}

export interface PollerOptions {
  /** Contract ids to watch. RPC allows at most 5 per filter. */
  contractIds: string[];
  /**
   * Expected network passphrase, e.g. from `NETWORKS[network].networkPassphrase`.
   *
   * When set, the poller calls `getNetwork` once before the first poll and
   * throws `NetworkPassphraseMismatchError` if the node reports a different
   * passphrase (#139).
   */
  networkPassphrase?: string;
  /**
   * Which class of events to stream. Defaults to `contract`, which is the
   * behaviour every existing caller already gets. `diagnostic` is not a
   * valid value (#144).
   */
  eventType?: EventType;
  /** Ledger to start from when no cursor is stored. Defaults to "as far back as retention allows". */
  startLedger?: number;
  /**
   * Last ledger to read, inclusive. The stream ends cleanly once the range
   * is exhausted.
   */
  endLedger?: number;
  /** Events per RPC page, 1..10000. Defaults to 200. */
  pageSize?: number;
  /** Milliseconds to wait after catching up to the tip. Defaults to 2000. */
  pollIntervalMs?: number;
  /** Maximum idle-poll interval after repeated empty pages. Defaults to 30000. */
  maxPollIntervalMs?: number;
  /** Milliseconds without RPC tip advancement before reporting a stall. Defaults to 60000. */
  stalledThresholdMs?: number;
  /** Extra topic filters, base64 ScVal segments or "*". */
  topics?: TopicSegment[][];
  /**
   * Maximum number of filter chunks polled concurrently when the contract
   * set is split across more than one RPC filter. Defaults to 4.
   */
  chunkConcurrency?: number;
}

/**
 * Per-filter-chunk cursor state. When contract ids are split across more
 * than one RPC filter, each chunk advances its own cursor independently.
 */
export interface ChunkCursor {
  /** Index of the filter chunk this cursor belongs to. */
  chunkIndex: number;
  /** Contract ids covered by this chunk (max 5). */
  contractIds: string[];
  /** Opaque paging token for this chunk; empty means "start from ledger". */
  cursor: string;
  /** True once this chunk has reached `endLedger` or the tip. */
  exhausted: boolean;
}

/** Snapshot of all per-chunk cursors, suitable for persistence. */
export interface ChunkState {
  chunks: ChunkCursor[];
}
