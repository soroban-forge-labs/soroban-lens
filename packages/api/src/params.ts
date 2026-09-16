import { MAX_QUERY_LIMIT } from '@soroban-lens/store';
import type { EventQuery } from '@soroban-lens/store';
import { ApiError } from './errors.js';

/** Contract ids are StrKey: 'C' followed by 55 base32 characters. */
const CONTRACT_ID = /^C[A-Z2-7]{55}$/;
/** Transaction hashes are 32 bytes, hex encoded. */
const TX_HASH = /^[0-9a-fA-F]{64}$/;

export function assertContractId(value: string): string {
  if (!CONTRACT_ID.test(value)) {
    throw ApiError.badRequest(
      `"${value}" is not a contract id. Expected a StrKey starting with C, 56 characters long.`,
      'contractId',
    );
  }
  return value;
}

function intParam(params: URLSearchParams, name: string): number | undefined {
  const raw = params.get(name);
  if (raw === null || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw ApiError.badRequest(`"${name}" must be an integer, got "${raw}".`, name);
  }
  return value;
}

function boolParam(params: URLSearchParams, name: string): boolean | undefined {
  const raw = params.get(name);
  if (raw === null || raw === '') return undefined;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw ApiError.badRequest(`"${name}" must be true or false, got "${raw}".`, name);
}

/**
 * An ISO-8601 timestamp, or epoch seconds, as epoch seconds.
 *
 * Both forms are accepted because both are natural: a UI has a Date, a shell
 * script has `date +%s`. A bare integer is unambiguous — no ISO-8601 timestamp
 * is all digits — so accepting it costs nothing.
 */
function timeParam(params: URLSearchParams, name: string): number | undefined {
  const raw = params.get(name);
  if (raw === null || raw.trim() === '') return undefined;
  const value = raw.trim();

  if (/^-?\d+$/.test(value)) return Number(value);

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw ApiError.badRequest(
      `"${name}" must be an ISO-8601 timestamp or epoch seconds, got "${value}".`,
      name,
    );
  }
  // Floor, not round: an inclusive lower bound must not skip an event that
  // closed in the same second.
  return Math.floor(parsed / 1000);
}

/**
 * Translate query-string parameters into an `EventQuery`.
 *
 * Unparseable or out-of-range values are rejected rather than clamped silently.
 * A caller who asks for `limit=5000` has a wrong mental model of the API, and a
 * 400 teaches them faster than a quietly truncated page.
 */
export function parseEventQuery(params: URLSearchParams): EventQuery {
  const limit = intParam(params, 'limit');
  if (limit !== undefined && (limit < 1 || limit > MAX_QUERY_LIMIT)) {
    throw ApiError.badRequest(`"limit" must be between 1 and ${MAX_QUERY_LIMIT}, got ${limit}.`, 'limit');
  }

  const order = params.get('order') ?? undefined;
  if (order !== undefined && order !== 'asc' && order !== 'desc') {
    throw ApiError.badRequest(`"order" must be "asc" or "desc", got "${order}".`, 'order');
  }

  const fromLedger = intParam(params, 'fromLedger');
  const toLedger = intParam(params, 'toLedger');
  if (fromLedger !== undefined && toLedger !== undefined && fromLedger > toLedger) {
    throw ApiError.badRequest(
      `"fromLedger" (${fromLedger}) must not be greater than "toLedger" (${toLedger}).`,
      'fromLedger',
    );
  }

  // ISO-8601 in, epoch seconds out. Callers think in timestamps; the column is
  // an integer, and doing the conversion here keeps that an implementation
  // detail rather than something every client has to know.
  const fromTime = timeParam(params, 'fromTime');
  const toTime = timeParam(params, 'toTime');
  if (fromTime !== undefined && toTime !== undefined && fromTime > toTime) {
    throw ApiError.badRequest('"fromTime" must not be after "toTime".', 'fromTime');
  }

  const txHash = params.get('txHash') ?? undefined;
  if (txHash !== undefined && !TX_HASH.test(txHash)) {
    throw ApiError.badRequest('"txHash" must be a 64-character hex string.', 'txHash');
  }

  // Both are ledger-relative positions, so negatives are meaningless rather
  // than merely unusual — reject instead of returning a guaranteed empty page.
  const transactionIndex = intParam(params, 'transactionIndex');
  if (transactionIndex !== undefined && transactionIndex < 0) {
    throw ApiError.badRequest(
      `"transactionIndex" must not be negative, got ${transactionIndex}.`,
      'transactionIndex',
    );
  }
  const operationIndex = intParam(params, 'operationIndex');
  if (operationIndex !== undefined && operationIndex < 0) {
    throw ApiError.badRequest(
      `"operationIndex" must not be negative, got ${operationIndex}.`,
      'operationIndex',
    );
  }

  const successfulOnly = boolParam(params, 'successfulOnly');
  const topics = parseTopics(params);
  const cursor = params.get('cursor');

  return {
    ...(limit !== undefined ? { limit } : {}),
    ...(order !== undefined ? { order: order as 'asc' | 'desc' } : {}),
    ...(fromLedger !== undefined ? { fromLedger } : {}),
    ...(toLedger !== undefined ? { toLedger } : {}),
    ...(fromTime !== undefined ? { fromTime } : {}),
    ...(toTime !== undefined ? { toTime } : {}),
    ...(txHash !== undefined ? { txHash } : {}),
    ...(transactionIndex !== undefined ? { transactionIndex } : {}),
    ...(operationIndex !== undefined ? { operationIndex } : {}),
    ...(cursor ? { cursor } : {}),
    ...(successfulOnly !== undefined ? { successfulOnly } : {}),
    ...(topics ? { topics } : {}),
  };
}

/** Ceiling on a batch lookup, so one request cannot ask for unbounded work. */
export const MAX_BATCH_IDS = 100;

/**
 * Parse `?ids=a,b,c` into the list to resolve, preserving the caller's order.
 *
 * Returns undefined when the parameter is absent, which is what keeps the
 * ordinary filter path untouched. An explicitly empty `ids=` is a caller
 * mistake rather than "every event", so it is rejected.
 */
export function parseIds(params: URLSearchParams): string[] | undefined {
  const raw = params.get('ids');
  if (raw === null) return undefined;

  const ids = raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');

  if (ids.length === 0) {
    throw ApiError.badRequest('"ids" was empty. Omit it to query without a batch.', 'ids');
  }
  if (ids.length > MAX_BATCH_IDS) {
    throw ApiError.badRequest(
      `At most ${MAX_BATCH_IDS} "ids" per request, got ${ids.length}.`,
      'ids',
    );
  }
  // Duplicates would make the response shorter than the request for no stated
  // reason, so they are rejected rather than quietly collapsed.
  const unique = new Set(ids);
  if (unique.size !== ids.length) {
    throw ApiError.badRequest('"ids" contained duplicates.', 'ids');
  }
  return ids;
}

/**
 * Repeated `?topic=` parameters form a topic *prefix*, positionally.
 * `*` is a wildcard for one position: `?topic=*&topic=order` matches any event
 * whose second topic is `order`.
 */
export function parseTopics(params: URLSearchParams): (string | null)[] | undefined {
  const topics = params.getAll('topic');
  if (topics.length === 0) return undefined;
  if (topics.length > 4) {
    throw ApiError.badRequest(
      'At most 4 "topic" parameters are supported, because only the first four ' +
        'topic positions are indexed. Events may carry more topics than that; ' +
        'filter on the prefix and narrow client-side.',
      'topic',
    );
  }
  return topics.map((t) => (t === '*' || t === '' ? null : t));
}
