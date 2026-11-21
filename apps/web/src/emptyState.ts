import type { IndexerStatus } from './types.js';
import type { Catalogue } from './i18n/en.js';

/**
 * Why the event table is empty (#78).
 *
 * The old empty state guessed "Nothing indexed yet" from an empty store. These
 * are the situations it was standing in for, each with a different remedy:
 *
 * - `unreachable`     the API did not answer, so we know nothing about the data
 * - `request-failed`  the API answered with an error, shown in the banner above
 * - `catching-up`     the indexer has started, but has not stored an event yet
 * - `nothing-indexed` the indexer has never run against this database
 * - `contract-unknown` this indexer has never seen the contract (#58's 404)
 * - `no-matching`     there is data, and the filters exclude all of it
 */
export type EmptyStateKind =
  | 'unreachable'
  | 'request-failed'
  | 'catching-up'
  | 'nothing-indexed'
  | 'contract-unknown'
  | 'no-matching';

export interface EmptyStateInput {
  /** HTTP status of a failed events request; 0 is a network failure (no response at all). */
  loadErrorStatus: number | null;
  /** `GET /status`, or null when it failed or has not loaded. */
  status: IndexerStatus | null;
  /** The events request 404'd for a contract: never seen by this indexer (#58). */
  contractUnknown: boolean;
  /** The API's `emptyReason` on an empty page for a known contract (#58). */
  emptyReason: 'no_matching_events' | null;
}

export interface EmptyState {
  kind: EmptyStateKind;
  key: keyof Catalogue;
  vars?: Record<string, string | number>;
}

/**
 * Decide which empty state is true. Pure, so the precedence is testable:
 *
 * 1. No answer (or an error) from the API beats everything — any other
 *    message would be a claim about data we could not read.
 * 2. An empty database comes next, because in an empty database every
 *    contract is "unknown" and every filter "matches nothing"; saying either
 *    would send the user to check an id or a filter that is not the problem.
 *    Whether the indexer has a stored cursor tells "started" from "never ran".
 * 3. Then #58's distinction for a contract, then a plain filter miss.
 */
export function describeEmptyState(input: EmptyStateInput): EmptyState {
  if (input.loadErrorStatus === 0) return { kind: 'unreachable', key: 'emptyApiUnreachable' };
  // The banner carries the API's own message; the table must not contradict
  // it by claiming the filters simply matched nothing.
  if (input.loadErrorStatus !== null) return { kind: 'request-failed', key: 'emptyRequestFailed' };

  const { status } = input;
  if (status && status.eventCount === 0) {
    const newest = newestStream(status);
    return newest
      ? { kind: 'catching-up', key: 'emptyIndexerCatchingUp', vars: { ledger: newest.ledger } }
      : { kind: 'nothing-indexed', key: 'emptyNothingIndexed' };
  }

  if (input.contractUnknown) return { kind: 'contract-unknown', key: 'emptyContractUnknown' };
  if (input.emptyReason === 'no_matching_events') return { kind: 'no-matching', key: 'emptyNoMatchingEvents' };
  return { kind: 'no-matching', key: 'emptyNoResults' };
}

function newestStream(status: IndexerStatus): IndexerStatus['streams'][number] | undefined {
  return [...status.streams].sort((a, b) => b.ledger - a.ledger)[0];
}
