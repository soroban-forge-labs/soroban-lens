/** JSON-safe value. Decoded payloads are always representable in plain JSON. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

/**
 * Module 1's `RawEvent`, redeclared structurally.
 *
 * Module 2 does not import `@soroban-lens/ingest`: keeping the two packages
 * free of a build dependency is what lets Person A and Person B work in
 * parallel. The shape must stay identical — see CONTRIBUTING.md.
 */
export interface RawEventInput {
  id: string;
  type: 'contract' | 'system';
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  topic: string[];
  value: string;
  txHash: string;
  transactionIndex: number;
  operationIndex: number;
  inSuccessfulContractCall: boolean;
}

/** One decoded XDR `ScVal`. */
export interface DecodedValue {
  /** ScVal arm, lower-cased: "symbol", "i128", "address", "map", "vec", "bytes", ... */
  type: string;
  /** JSON-safe rendering. BigInts become decimal strings, bytes become hex. */
  value: JsonValue;
}

/**
 * A stored, decoded event. This is the record the API serves and the UI renders.
 *
 * Raw XDR is kept alongside the decoding so that a decoder bug is always
 * recoverable: re-run the decode over `topicsXdr` / `valueXdr` without
 * re-indexing from the network.
 */
export interface LensEvent {
  id: string;
  contractId: string;
  type: 'contract' | 'system';
  ledger: number;
  /** RFC3339, exactly as the RPC reported it. */
  ledgerClosedAt: string;
  txHash: string;
  transactionIndex: number;
  operationIndex: number;
  inSuccessfulContractCall: boolean;
  /** Full decoded topic list. May be longer than 4 — see fixtures/README.md. */
  topics: DecodedValue[];
  /** Original base64 XDR topics. */
  topicsXdr: string[];
  value: DecodedValue;
  /** Original base64 XDR value. */
  valueXdr: string;
  /** Set when XDR decoding failed; the raw fields are still populated. */
  decodeError?: string | undefined;
  /** When this row was written, ISO 8601. */
  indexedAt: string;
}

/** Filter for `EventStore.queryEvents`. All fields are ANDed. */
export interface EventQuery {
  contractId?: string | undefined;
  /**
   * Match a topic prefix: `['transfer']` matches any event whose first topic is
   * `transfer`. A `null` entry is a wildcard for that position.
   * Prefix rather than exact match, because events may carry more topics than
   * a filter can name.
   */
  topics?: (string | null)[] | undefined;
  /** Inclusive lower bound on ledger sequence. */
  fromLedger?: number | undefined;
  /** Inclusive upper bound on ledger sequence. */
  toLedger?: number | undefined;
  /**
   * Inclusive lower bound on ledger close time, as seconds since the epoch.
   * Backed by the indexed `closed_at_unix` column.
   */
  fromTime?: number | undefined;
  /** Inclusive upper bound on ledger close time, as seconds since the epoch. */
  toTime?: number | undefined;
  txHash?: string | undefined;
  /**
   * Match any event mentioning this address — anywhere: a topic segment
   * (indexed or beyond the 4-segment ceiling) or nested inside the decoded
   * value. Backed by the event_addresses side table (#23), not the topic0..3
   * columns, so this finds addresses a topic filter structurally cannot.
   */
  address?: string | undefined;
  /**
   * Substring match against a decoded event's topics and value, via the
   * trigram full-text index (#32). At least 3 characters — trigram indexes
   * 3-character runs, so anything shorter matches nothing by construction.
   */
  search?: string | undefined;
  /**
   * Position of the transaction within its ledger. Paired with `txHash` or a
   * ledger bound it pins down one transaction's events exactly.
   */
  transactionIndex?: number | undefined;
  /** Position of the operation within its transaction. */
  operationIndex?: number | undefined;
  /** Restrict to successful contract calls. Omitted means "both". */
  successfulOnly?: boolean | undefined;
  /** 1..1000. Defaults to 50. */
  limit?: number | undefined;
  /** Keyset cursor: return events strictly before/after this event id. */
  cursor?: string | undefined;
  /** "desc" (newest first, the default) or "asc". */
  order?: 'asc' | 'desc' | undefined;
}

/** A page of query results plus the token for the next page. */
export interface EventPage {
  events: LensEvent[];
  /** Pass back as `cursor` for the next page. `null` when the page is the last. */
  nextCursor: string | null;
  /** Total rows matching the filter, ignoring limit/cursor. */
  total: number;
  /**
   * True when `total` came from a short-lived cache rather than a fresh
   * COUNT(*) — accurate as of up to `countCacheTtlMs` ago, not this instant.
   * COUNT(*) with a filter is a full scan of the matching rows; caching it is
   * what keeps a busy filter's response time from being dominated by a number
   * most callers show as "about N", not read to the row. Omitted (not false)
   * on an exact, freshly-computed count, so `total` on every page from before
   * this existed is unchanged.
   */
  totalIsEstimate?: true;
}

/** Aggregate view of one indexed contract. */
export interface ContractSummary {
  contractId: string;
  eventCount: number;
  firstLedger: number;
  lastLedger: number;
  lastSeenAt: string;
}

/** Progress of one ingest stream, mirrored into storage so the API can report it. */
export interface StreamState {
  key: string;
  cursor: string;
  ledger: number;
  updatedAt: string;
}

/** One topic and how many events carry it in the first position. */
export interface TopicCount {
  topic: string;
  count: number;
}

export interface StoreStats {
  eventCount: number;
  contractCount: number;
  minLedger: number | null;
  maxLedger: number | null;
  /** Schema version the database is currently migrated to. */
  schemaVersion: number;
  /**
   * Size of the database file on disk, in bytes. `null` for a backend with no
   * file (`:memory:`), which is different from a file that is genuinely 0 bytes.
   */
  sizeBytes: number | null;
  /**
   * Size of the write-ahead log, in bytes, or `null` when there is no WAL.
   * Reported separately because a WAL that never checkpoints (#28) is exactly
   * the case where the total on disk surprises someone whose volume filled up.
   */
  walSizeBytes: number | null;
}

