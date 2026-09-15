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

  const txHash = params.get('txHash') ?? undefined;
  if (txHash !== undefined && !TX_HASH.test(txHash)) {
    throw ApiError.badRequest('"txHash" must be a 64-character hex string.', 'txHash');
  }

  const successfulOnly = boolParam(params, 'successfulOnly');
  const topics = parseTopics(params);
  const cursor = params.get('cursor');

  return {
    ...(limit !== undefined ? { limit } : {}),
    ...(order !== undefined ? { order: order as 'asc' | 'desc' } : {}),
    ...(fromLedger !== undefined ? { fromLedger } : {}),
    ...(toLedger !== undefined ? { toLedger } : {}),
    ...(txHash !== undefined ? { txHash } : {}),
    ...(cursor ? { cursor } : {}),
    ...(successfulOnly !== undefined ? { successfulOnly } : {}),
    ...(topics ? { topics } : {}),
  };
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
