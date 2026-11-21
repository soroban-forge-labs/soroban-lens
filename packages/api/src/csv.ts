import type { DecodedValue, LensEvent } from '@soroban-lens/store';
import { ApiError } from './errors.js';

/**
 * CSV export for the two event-list routes (#41).
 *
 * Shape: one row per event; `topic0..topicN` columns, one per topic position;
 * `value` as the JSON text of the decoded value. The point of the format is
 * getting events into a spreadsheet or a pandas frame, so the rules below are
 * about not corrupting what lands there.
 */

/**
 * Fewest topic columns ever written, so the header is stable for the common
 * case (four indexed topics) even when a given export's events carry fewer.
 */
export const MIN_TOPIC_COLUMNS = 4;

/** Rows are separated with CRLF, as RFC 4180 specifies. */
const EOL = '\r\n';

/**
 * Quote a field when it needs it — or always, when `force` is set.
 * Embedded quotes are doubled (RFC 4180).
 */
export function csvCell(text: string, force = false): string {
  return force || /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Decoded types whose value is already human text and is written as-is. */
const TEXT_TYPES = new Set(['symbol', 'string', 'address']);

/**
 * Characters a spreadsheet treats as the start of a formula. Event data is
 * written by arbitrary contracts, so a `string` topic of `=HYPERLINK(...)` is
 * attacker-controlled text that would otherwise execute on opening the file.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

function guardFormula(text: string): string {
  return FORMULA_START.test(text) ? `'${text}` : text;
}

/**
 * One decoded value as a cell.
 *
 * Text-like types (`symbol`, `string`, `address`) are written as-is. Everything
 * else is written as JSON text. That is what protects large integers: `i128`,
 * `u128`, `i64` and friends are decoded to decimal *strings* (a JS number would
 * lose precision), so their JSON text is `"340282366920938463463374607431768211455"`
 * — quoted, which a spreadsheet leaves as text instead of coercing the digits
 * into a float and rounding them. `JSON.parse` of the cell recovers the exact
 * string.
 */
export function valueCell(decoded: DecodedValue): string {
  if (TEXT_TYPES.has(decoded.type) && typeof decoded.value === 'string') {
    return csvCell(guardFormula(decoded.value));
  }
  return csvCell(JSON.stringify(decoded.value));
}

export function eventCsvHeader(topicColumns: number): string {
  const topics = Array.from({ length: topicColumns }, (_, i) => `topic${i}`);
  return (
    [
      'id',
      'contractId',
      'type',
      'ledger',
      'ledgerClosedAt',
      'txHash',
      'transactionIndex',
      'operationIndex',
      'inSuccessfulContractCall',
      ...topics,
      'valueType',
      'value',
      'decodeError',
    ].join(',') + EOL
  );
}

export function eventCsvRow(event: LensEvent, topicColumns: number): string {
  // A topic beyond the header's width is still written rather than dropped: the
  // header is sized by a scan that can be overtaken by a newer event, and a
  // ragged row is better than a silently lost topic.
  const width = Math.max(topicColumns, event.topics.length);
  const topics = Array.from({ length: width }, (_, i) => {
    const topic = event.topics[i];
    return topic ? valueCell(topic) : '';
  });
  return (
    [
      csvCell(event.id),
      csvCell(event.contractId),
      csvCell(event.type),
      String(event.ledger),
      csvCell(event.ledgerClosedAt),
      csvCell(event.txHash),
      String(event.transactionIndex),
      String(event.operationIndex),
      String(event.inSuccessfulContractCall),
      ...topics,
      csvCell(event.value.type),
      valueCell({ type: 'json', value: event.value.value }),
      event.decodeError ? csvCell(guardFormula(event.decodeError)) : '',
    ].join(',') + EOL
  );
}

/**
 * Whether the caller asked for CSV.
 *
 * `?format=` wins over the `Accept` header, because a query parameter is what a
 * browser link or a `curl` without `-H` can express. Otherwise `Accept` is
 * honoured with its q-values, and JSON stays the answer for a bare `*\/*` —
 * `text/csv` has to be asked for by name (or by `text/*`) and outrank JSON.
 */
export function wantsCsv(params: URLSearchParams, accept: string | string[] | undefined): boolean {
  const format = params.get('format');
  if (format !== null && format !== '') {
    const normalised = format.toLowerCase();
    if (normalised === 'csv') return true;
    if (normalised === 'json') return false;
    throw ApiError.badRequest(`"format" must be "json" or "csv", got "${format}".`, 'format');
  }

  return acceptQuality(accept, 'text/csv') > acceptQuality(accept, 'application/json');
}

/**
 * The q-value an `Accept` header gives `type`: that of the most specific
 * matching range, or 0 when none matches (or the header is absent).
 */
export function acceptQuality(accept: string | string[] | undefined, type: string): number {
  const header = Array.isArray(accept) ? accept.join(',') : (accept ?? '');
  if (header.trim() === '') return 0;

  const ranges = header.split(',').map((part) => {
    const [range = '', ...rest] = part.trim().split(';');
    const qParam = rest.map((p) => p.trim()).find((p) => /^q\s*=/i.test(p));
    const q = qParam ? Number(qParam.split('=')[1]) : 1;
    return { range: range.trim().toLowerCase(), q: Number.isFinite(q) ? q : 0 };
  });

  const [major = ''] = type.split('/');
  const exact = ranges.find((r) => r.range === type);
  if (exact) return exact.q;
  const wildcard = ranges.find((r) => r.range === `${major}/*`);
  if (wildcard) return wildcard.q;
  return ranges.find((r) => r.range === '*/*')?.q ?? 0;
}
