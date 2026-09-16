/**
 * Module 1 public data contract.
 *
 * `RawEvent` mirrors, field for field, one entry of the `events` array returned
 * by the Soroban RPC `getEvents` method with the default `xdrFormat: "base64"`.
 * It is deliberately a *transport* type: topics and values stay base64-encoded
 * XDR here. Decoding is Module 2's job (`@soroban-lens/store`).
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
  /** RPC only emits "contract" and "system" event types. */
  type: 'contract' | 'system';
  /** Ledger sequence number the event was emitted in. */
  ledger: number;
  /** RFC3339 close time of that ledger, e.g. "2026-09-15T19:22:52Z". */
  ledgerClosedAt: string;
  /** StrKey contract address ("C...") that emitted the event. */
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

export interface RetentionState {
  latestLedger: number;
  oldestLedger: number;
  latestLedgerCloseTime: string;
  oldestLedgerCloseTime: string;
}

/** A topic filter segment: an exact base64 ScVal, or "*" to match any one segment. */
export type TopicSegment = string;

/**
 * Event classes the RPC serves. `contract` is what almost everyone wants and
 * stays the default; `system` and `diagnostic` are what this package used to
 * make unreachable by hardcoding the filter.
 */
export type EventType = 'contract' | 'system' | 'diagnostic';

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
   * Which class of events to stream. Defaults to `contract`, which is the
   * behaviour every existing caller already gets.
   */
  eventType?: EventType;
  /** Ledger to start from when no cursor is stored. Defaults to "as far back as retention allows". */
  startLedger?: number;
  /**
   * Last ledger to read, inclusive. The stream ends cleanly once the range is
   * exhausted, which is what makes indexing a bounded historical window
   * possible without watching the log and killing the process.
   */
  endLedger?: number;
  /** Events per RPC page, 1..10000. Defaults to 200. */
  pageSize?: number;
  /** Milliseconds to wait after catching up to the tip. Defaults to 2000. */
  pollIntervalMs?: number;
  /** Extra topic filters, base64 ScVal segments or "*". */
  topics?: TopicSegment[][];
}
