import { MAX_QUERY_LIMIT } from '@soroban-lens/store';
import type { EventQuery, TimeBucket } from '@soroban-lens/store';
import { ApiError } from './errors.js';

/** Contract ids are StrKey: 'C' followed by 55 base32 characters. */
const CONTRACT_ID = /^C[A-Z2-7]{55}$/;
/** Transaction hashes are 32 bytes, hex encoded. */
const TX_HASH = /^[0-9a-fA-F]{64}$/;
// StrKey: 'G' (account) or 'C' (contract) followed by 55 base32 characters.
// Both are valid ScVal addresses, and #23's index does not distinguish them.
const ADDRESS = /^[GC][A-Z2-7]{55}$/;
/** Where event_addresses records an address: a topic position, or the value. */
const ADDRESS_POSITION = /^(topic(0|[1-9][0-9]{0,2})|value)$/;
/** A lower-cased ScVal arm name, as `DecodedValue.type` reports it. */
const SCVAL_TYPE = /^[a-z][A-Za-z0-9]{0,31}$/;
const TYPED_INTEGER = /^-?(?:0|[1-9]\d*)$/;
const MIN_TYPED_INTEGER = -(1n << 63n);
const MAX_TYPED_INTEGER = (1n << 63n) - 1n;

export function assertAddress(value: string): string {
  if (!ADDRESS.test(value)) {
    throw ApiError.badRequest(
      `"${value}" is not an address. Expected a StrKey starting with G or C, 56 characters long.`,
      'address',
    );
  }
  return value;
}

export function assertTxHash(value: string): string {
  if (!TX_HASH.test(value)) {
    throw ApiError.badRequest('The transaction hash must be a 64-character hex string.', 'txHash');
  }
  return value;
}

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
export function parseLimit(params: URLSearchParams): number | undefined {
  const limit = intParam(params, 'limit');
  if (limit !== undefined && (limit < 1 || limit > MAX_QUERY_LIMIT)) {
    throw ApiError.badRequest(`"limit" must be between 1 and ${MAX_QUERY_LIMIT}, got ${limit}.`, 'limit');
  }
  return limit;
}

export function parseEventQuery(params: URLSearchParams): EventQuery {
  const limit = parseLimit(params);

  const indexedAfterRaw = params.get('indexedAfter');
  let indexedAfter: string | undefined;
  if (indexedAfterRaw !== null && indexedAfterRaw !== '') {
    const t = Date.parse(indexedAfterRaw);
    if (Number.isNaN(t)) {
      throw ApiError.badRequest(`"indexedAfter" must be an ISO-8601 timestamp, got "${indexedAfterRaw}".`, 'indexedAfter');
    }
    indexedAfter = new Date(t).toISOString();
  }

  const order = params.get('order') ?? undefined;
  if (order !== undefined && order !== 'asc' && order !== 'desc') {
    throw ApiError.badRequest(`"order" must be "asc" or "desc", got "${order}".`, 'order');
  }

  const direction = params.get('direction') ?? undefined;
  if (direction !== undefined && direction !== 'forward' && direction !== 'backward') {
    throw ApiError.badRequest(`"direction" must be "forward" or "backward", got "${direction}".`, 'direction');
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

  const address = params.get('address') ?? undefined;
  if (address !== undefined && !ADDRESS.test(address)) {
    throw ApiError.badRequest(
      "\"address\" must be a StrKey: 'G' or 'C' followed by 55 characters (A-Z, 2-7).",
      'address',
    );
  }

  const addressPosition = params.get('addressPosition') ?? undefined;
  if (addressPosition !== undefined) {
    if (!ADDRESS_POSITION.test(addressPosition)) {
      throw ApiError.badRequest(
        `"addressPosition" must be "topic0".."topicN" or "value", got "${addressPosition}".`,
        'addressPosition',
      );
    }
    // Without an address there is nothing for the position to narrow; saying
    // so beats silently returning every event.
    if (address === undefined) {
      throw ApiError.badRequest('"addressPosition" needs "address".', 'addressPosition');
    }
  }

  // No minimum-length rejection: a 1-2 character search is a valid request
  // that the trigram index simply cannot match anything with, which is
  // honest behaviour (an empty page), not an error.
  const search = params.get('search') ?? undefined;

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

  const typedField = params.get('typedField') ?? undefined;
  const typedValue = params.get('typedValue') ?? undefined;
  const typedGt = typedIntegerParam(params, 'typedGt');
  const typedGte = typedIntegerParam(params, 'typedGte');
  const typedLt = typedIntegerParam(params, 'typedLt');
  const typedLte = typedIntegerParam(params, 'typedLte');
  const hasTypedConstraint = [typedValue, typedGt, typedGte, typedLt, typedLte].some(
    (value) => value !== undefined,
  );
  if ((typedField === undefined) !== !hasTypedConstraint || typedField === '') {
    throw ApiError.badRequest(
      '"typedField" is required with at least one of "typedValue", "typedGt", "typedGte", "typedLt" or "typedLte".',
      'typedField',
    );
  }

  const successfulOnly = boolParam(params, 'successfulOnly');
  const topics = parseTopics(params);
  const topicTypes = parseTopicTypes(params);
  const cursor = params.get('cursor');

  return {
    ...(limit !== undefined ? { limit } : {}),
    ...(order !== undefined ? { order: order as 'asc' | 'desc' } : {}),
    ...(direction !== undefined ? { direction: direction as 'forward' | 'backward' } : {}),
    ...(fromLedger !== undefined ? { fromLedger } : {}),
    ...(toLedger !== undefined ? { toLedger } : {}),
    ...(fromTime !== undefined ? { fromTime } : {}),
    ...(toTime !== undefined ? { toTime } : {}),
    ...(txHash !== undefined ? { txHash } : {}),
    ...(address !== undefined ? { address } : {}),
    ...(addressPosition !== undefined ? { addressPosition } : {}),
    ...(search !== undefined && search !== '' ? { search } : {}),
    ...(transactionIndex !== undefined ? { transactionIndex } : {}),
    ...(operationIndex !== undefined ? { operationIndex } : {}),
    ...(typedField !== undefined ? { typedField } : {}),
    ...(typedValue !== undefined ? { typedValue } : {}),
    ...(typedGt !== undefined ? { typedGt } : {}),
    ...(typedGte !== undefined ? { typedGte } : {}),
    ...(typedLt !== undefined ? { typedLt } : {}),
    ...(typedLte !== undefined ? { typedLte } : {}),
    ...(cursor ? { cursor } : {}),
    ...(successfulOnly !== undefined ? { successfulOnly } : {}),
    ...(topics ? { topics } : {}),
    ...(topicTypes ? { topicTypes } : {}),
    ...(indexedAfter !== undefined ? { indexedAfter } : {}),
  };
}

function typedIntegerParam(params: URLSearchParams, name: string): string | undefined {
  const raw = params.get(name);
  if (raw === null) return undefined;
  if (!TYPED_INTEGER.test(raw)) {
    throw ApiError.badRequest(`"${name}" must be an integer, got "${raw}".`, name);
  }
  const value = BigInt(raw);
  if (value < MIN_TYPED_INTEGER || value > MAX_TYPED_INTEGER) {
    throw ApiError.badRequest(`"${name}" must fit a signed 64-bit integer.`, name);
  }
  return value.toString();
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
 * whose second topic is `order`. Any depth works: positions 4+ are served by
 * the event_topics side table (#164).
 */
export function parseTopics(params: URLSearchParams): (string | null)[] | undefined {
  const topics = params.getAll('topic');
  if (topics.length === 0) return undefined;
  return topics.map((t) => (t === '*' || t === '' ? null : t));
}

/**
 * Repeated `?topicType=` parameters, positional like `?topic=` (#146):
 * `?topic=transfer&topicType=symbol` matches the symbol `transfer` and not the
 * string `"transfer"`. `*` or an empty value leaves a position untyped, so a
 * request without `topicType` behaves exactly as it always has.
 */
export function parseTopicTypes(params: URLSearchParams): (string | null)[] | undefined {
  const types = params.getAll('topicType');
  if (types.length === 0) return undefined;
  return types.map((t) => {
    if (t === '*' || t === '') return null;
    if (!SCVAL_TYPE.test(t)) {
      throw ApiError.badRequest(
        `"topicType" must be a ScVal type such as symbol, string, address, u32 or i128, got "${t}".`,
        'topicType',
      );
    }
    return t;
  });
}

/** Top-level properties of an event that `?fields=` can select. */
export const EVENT_FIELDS = [
  'id',
  'contractId',
  'type',
  'ledger',
  'ledgerClosedAt',
  'txHash',
  'transactionIndex',
  'operationIndex',
  'inSuccessfulContractCall',
  'topics',
  'topicsXdr',
  'value',
  'valueXdr',
  'decodeError',
  'indexedAt',
  'typed',
] as const;

/**
 * Parse `?fields=id,ledger,topics` into the event properties to return.
 *
 * Returns undefined when absent, which keeps the default (everything) and so
 * the response unchanged for existing clients. Unknown names are rejected
 * rather than ignored: a typo would otherwise silently return fewer fields.
 */
export function parseFields(params: URLSearchParams): Set<string> | undefined {
  const raw = params.get('fields');
  if (raw === null) return undefined;

  const fields = raw
    .split(',')
    .map((f) => f.trim())
    .filter((f) => f !== '');
  if (fields.length === 0) {
    throw ApiError.badRequest('"fields" was empty. Omit it to return every field.', 'fields');
  }
  const unknown = fields.filter((f) => !(EVENT_FIELDS as readonly string[]).includes(f));
  if (unknown.length > 0) {
    throw ApiError.badRequest(
      `Unknown "fields": ${unknown.join(', ')}. Valid fields: ${EVENT_FIELDS.join(', ')}.`,
      'fields',
    );
  }
  return new Set(fields);
}

/** Keep only the selected properties of each event. A no-op when `fields` is undefined. */
export function selectFields<T extends object>(events: T[], fields: Set<string> | undefined): Partial<T>[] {
  if (!fields) return events;
  return events.map(
    (event) => Object.fromEntries(Object.entries(event).filter(([key]) => fields.has(key))) as Partial<T>,
  );
}

const BUCKETS: readonly TimeBucket[] = ['minute', 'hour', 'day'];

export interface ActivityQuery {
  bucket: TimeBucket;
  /** Inclusive lower bound, epoch seconds. */
  from?: number;
  /** Inclusive upper bound, epoch seconds. */
  to?: number;
  topics?: (string | null)[];
  successfulOnly?: boolean;
}

/** Parse `?bucket=hour&from=…&to=…` for the activity endpoint. */
export function parseActivityQuery(params: URLSearchParams): ActivityQuery {
  const bucket = params.get('bucket') ?? 'hour';
  if (!(BUCKETS as readonly string[]).includes(bucket)) {
    throw ApiError.badRequest(
      `"bucket" must be one of ${BUCKETS.join(', ')}, got "${bucket}".`,
      'bucket',
    );
  }
  const from = timeParam(params, 'from');
  const to = timeParam(params, 'to');
  if (from !== undefined && to !== undefined && from > to) {
    throw ApiError.badRequest('"from" must not be after "to".', 'from');
  }
  const topics = parseTopics(params);
  const successfulOnly = boolParam(params, 'successfulOnly');
  return {
    bucket: bucket as TimeBucket,
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(topics ? { topics } : {}),
    ...(successfulOnly !== undefined ? { successfulOnly } : {}),
  };
}
