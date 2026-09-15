import type {
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
 * this interface and never on SQLite directly, which is what keeps a Postgres
 * backend a drop-in addition rather than a rewrite.
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
   * Decode and persist raw RPC events.
   * @returns how many rows were newly inserted (duplicates are not counted).
   */
  insertEvents(events: RawEventInput[]): Promise<number>;

  /** Persist already-decoded events, e.g. when replaying a fixture. */
  insertDecoded(events: LensEvent[]): Promise<number>;

  getEvent(id: string): Promise<LensEvent | null>;

  queryEvents(query: EventQuery): Promise<EventPage>;

  /** Contracts seen so far, most recently active first. */
  listContracts(limit?: number): Promise<ContractSummary[]>;

  /** Distinct first-topic values for a contract, for building filter UIs. */
  listTopics(contractId: string, limit?: number): Promise<{ topic: string; count: number }[]>;

  getStats(): Promise<StoreStats>;

  saveStreamState(state: StreamState): Promise<void>;
  loadStreamState(key: string): Promise<StreamState | null>;
  listStreamStates(): Promise<StreamState[]>;

  /** True when the backing store accepts writes. Used by `lens doctor`. */
  healthCheck(): Promise<{ ok: boolean; detail: string }>;

  close(): Promise<void>;
}

/** Ceiling on `limit`, enforced by every implementation. */
export const MAX_QUERY_LIMIT = 1000;
export const DEFAULT_QUERY_LIMIT = 50;

export function normaliseLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_QUERY_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_QUERY_LIMIT);
}
