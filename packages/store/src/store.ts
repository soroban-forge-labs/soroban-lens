import type {
  ContractSpecRecord,
  TimeBucket,
  TimeBucketCount,
  TopicCount,
  ContractSummary,
  EventPage,
  EventQuery,
  LensEvent,
  RawEventInput,
  StoreStats,
  StreamState,
} from './types.js';

/**
 * The storage trait. Everything above Module 2 — the API, the CLI — depends on
 * this interface and never on SQLite directly, which is what keeps a Postgres is a
 * drop-in addition rather than a rewrite.
 *
 * Implementations must guarantee:
 *
 * - `insertEvents` is idempotent on `LensEvent.id`. Module 1 delivers
 *   at-least-once, so the same event will arrive twice and must not duplicate.
 * - `queryEvents` returns events ordered by `id`, which for Soroban event ids
 *   is the same as ledger order.
 * - Pagination is keyset, not offset: a page boundary stays correct while new
 *   events are being written behind it.
 */
export interface EventStore {
  /** Apply any pending migrations. Safe to call repeatedly. */
  migrate(): Promise<void>;

  /**
   * Roll back every applied migration above `toVersion`, most recent first.
   * @returns the versions actually rolled back, in the order they were undone.
   * @throws if any migration in that range has no `down` — nothing is rolled
   *   back, not even the ones that could be, so a database never ends up
   *   between two supposedly-atomic states.
   */
  migrateDown(toVersion: number): Promise<number[]>;

  /**
   * Fully repopulate the full-text search index from `events`, from scratch.
   *
   * Triggers keep events_fts in sync automatically on every write, so this is
   * for recovery — the tokenizer changed, the index is suspected corrupt — not
   * something a normal write path needs to call.
   */
  rebuildSearchIndex(): Promise<void>;

  /**
   * Write every event as NDJSON (one decoded LensEvent per line) to
   * `destPath` — a format that outlives this backend, unlike a raw copy of
   * the database file. Consistent even while the indexer is writing:
   * internally takes a point-in-time snapshot before reading from it.
   * @returns how many events were written.
   */
  exportSnapshot(destPath: string): Promise<number>;

  /**
   * Read an NDJSON snapshot written by exportSnapshot() (or `lens seed`'s
   * fixture format is not this — see the CLI) and insert every event.
   * Idempotent the same way insertEvents() is: importing the same snapshot
   * twice does not duplicate rows.
   * @returns how many rows were newly inserted.
   */
  importSnapshot(srcPath: string): Promise<number>;

  /**
   * Force a WAL checkpoint. A continuously-writing indexer with a long-lived
   * reader (the API, kept open by an in-flight request) can grow `-wal`
   * without bound between natural checkpoints, which looks like a disk leak.
   * `'TRUNCATE'` — the default — is the only mode that actually shrinks the
   * file on disk; the others merely flush into the main database.
   */
  checkpoint(mode?: 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE'): Promise<void>;

  /**
   * Decode and persist raw RPC events.
   * @returns how many rows were newly inserted (duplicates are not counted).
   */
  insertEvents(events: RawEventInput[]): Promise<number>;

  /** Persist already-decoded events, e.g. when replaying a fixture. */
  insertDecoded(events: LensEvent[]): Promise<number>;

  getEvent(id: string): Promise<LensEvent | null>;

  queryEvents(query: EventQuery): Promise<EventPage>;

  /**
   * The greatest event id in the store, or `null` when it is empty. Cheap enough
   * to call on every request: the API derives its `ETag` from it and the live
   * stream polls it to learn whether anything new was indexed.
   */
  getLatestEventId(): Promise<string | null>;

  /** Contracts seen so far, most recently active first. */
  listContracts(limit?: number): Promise<ContractSummary[]>;

  /** Distinct first-topic values for a contract, for building filter UIs. */
  listTopics(contractId: string, limit?: number): Promise<{ topic: string; count: number }[]>;

  /**
   * Distinct first-topic values across every indexed contract, most frequent
   * first — "what event types exist in here at all", without paging the table.
   */
  countByTopic(limit?: number): Promise<TopicCount[]>;

  /**
   * Count events matching `query` per fixed-width time bucket, by ledger close
   * time (`fromTime`/`toTime` bound the range, as for `queryEvents`).
   * Buckets are aligned to the epoch, ordered oldest first, and sparse: a
   * bucket with no events is omitted. `limit`, `cursor` and `order` are ignored.
   */
  countByTimeBucket(query: EventQuery, bucket: TimeBucket): Promise<TimeBucketCount[]>;

  getStats(): Promise<StoreStats>;

  /**
   * Record what a spec lookup found for one contract (#33), replacing any
   * earlier record — a refresh after a Wasm upgrade overwrites, not appends.
   */
  saveContractSpec(record: ContractSpecRecord): Promise<void>;

  /** The stored spec record for a contract, or `null` if it was never looked up. */
  getContractSpec(contractId: string): Promise<ContractSpecRecord | null>;

  /** Every stored spec record, without the entries themselves, ordered by contract id. */
  listContractSpecs(): Promise<Omit<ContractSpecRecord, 'entriesXdr'>[]>;

  saveStreamState(state: StreamState): Promise<void>;
  loadStreamState(key: string): Promise<StreamState | null>;
  listStreamStates(): Promise<StreamState[]>;

  /**
   * Read-only liveness: the store is readable and at the expected schema.
   *
   * Safe to call on every request, so this is what the API's `/health` serves.
   * It deliberately does not test writability — see `writeProbe`.
   */
  healthCheck(): Promise<{ ok: boolean; detail: string }>;

  /**
   * Verify the store actually accepts writes, by performing one.
   *
   * A read-only mount, a full disk or a uid mismatch on a bind mount is
   * invisible to a read, so `lens doctor` runs this before the indexer starts.
   * It is a preflight check, not a request handler: it mutates the database and
   * takes the write lock, so nothing on a hot path should call it.
   */
  writeProbe(): Promise<{ ok: boolean; detail: string }>;

  /**
   * Delete every event with `ledger < before`, returning the row count removed.
   *
   * Does not touch `stream_state`: pruning is about disk, not about where the
   * indexer resumes from, and the two must stay independent — a pruned
   * database is still a valid place to keep polling forward from.
   */
  pruneBefore(ledger: number): Promise<number>;

  /**
   * Delete the oldest events in ledger chunks until the on-disk size
   * (`bytes` + its WAL) fits under `targetBytes`, then checkpoint.
   *
   * This is the size-based counterpart to `pruneBefore`, for operators who
   * care about disk rather than a ledger horizon. It always prunes the
   * oldest rows first and stops as soon as the target is met.
   *
   * @param targetBytes Maximum combined size of the database and its WAL.
   * @param chunkLedgers How many ledgers to remove per pass. Defaults to
   *   a small chunk so a single pass never deletes more than needed.
   * @returns a summary of what was removed.
   */
  pruneToSize(targetBytes: number, chunkLedgers?: number): Promise<PruneToSizeResult>;

  /**
   * Re-run the decoder over stored rows and rewrite their decoded columns in
   * place, from the raw XDR that was always kept for exactly this.
   *
   * `decodeEvent` never throws — a bad event is stored with `decodeError` set
   * rather than dropped — so this is how a decoder fix actually reaches
   * already-indexed rows, without re-indexing from the network.
   *
   * @param all Re-decode every row, not only ones with `decodeError` set.
   *   For a decoder change that fixes the *shape* of previously-successful
   *   output rather than an outright failure.
   * @returns how many rows were rewritten.
   */
  redecode(all?: boolean): Promise<number>;

  /**
   * Check stored invariants: `topics_json` parses and its length matches
   * `topic_count`; `topic0..3` match a fresh projection of the parsed
   * topics; `value_json` and `topics_xdr_json` parse at all. Nothing writes
   * these bugs today, but nothing has ever checked for them either — a disk
   * fault, a hand edit, or a future migration bug could leave one behind.
   * @returns one entry per row with a problem, empty when the database is clean.
   */
  checkIntegrity(): Promise<{ id: string; problems: string[] }[]>;

  /** Recompute one row's derived columns from its stored raw XDR. */
  repairRow(id: string): Promise<void>;

  close(): Promise<void>;
}

/** Result of a size-based prune pass. */
export interface PruneToSizeResult {
  /** How many event rows were deleted. */
  rowsRemoved: number;
  /** How many ledgers were deleted (at least one row each). */
  ledgersRemoved: number;
  /** The highest ledger that was pruned, `null` if nothing was. */
  highestPrunedLedger: number | null;
  /** Combined database + WAL bytes after the pass. */
  sizeBytesAfter: number;
  /** Whether the store fits under the target after the pass. */
  withinTarget: boolean;
}

/** Ceiling on `limit`, enforced by every implementation. */
export const DEFAULT_MAX_QUERY_LIMIT = 1000;

/**
 * Ceiling on `limit`, overridable with `LENS_MAX_QUERY_LIMIT`.
 *
 * Read once at module load rather than per call, so every layer — the store's
 * clamp, the API's rejection message and the served OpenAPI spec — agree on
 * one number for the life of the process.
 *
 * An unusable value falls back to the default: an operator who typo'd this
 * wants the documented behaviour, not a ceiling of NaN that rejects every
 * request.
 */
export const MAX_QUERY_LIMIT: number = resolveMaxQueryLimit(process.env.LENS_MAX_QUERY_LIMIT);

export function resolveMaxQueryLimit(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_QUERY_LIMIT;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return DEFAULT_MAX_QUERY_LIMIT;
  return Math.trunc(value);
}
export const DEFAULT_QUERY_LIMIT = 50;

export function normaliseLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_QUERY_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_QUERY_LIMIT);
}
