import { isContractId, CONTRACT_ID_HINT } from '@soroban-lens/ingest';
import { parseMuxedAddress } from '@soroban-lens/store';
import type { DecodedValue, EventQuery, EventStore, LensEvent } from '@soroban-lens/store';

/**
 * `lens tail` (#86): follow newly indexed events from a terminal.
 *
 * Reads the database directly rather than going through the API. The whole
 * point is not having to run the API to watch events, and the indexer is
 * already writing to the same file, so there is nothing to subscribe to; like
 * the API's live stream, this polls for the newest id and only queries when it
 * has moved.
 */

/** The filter flags `lens tail` accepts, as they arrive from the command line. */
export interface TailFlags {
  contract?: string[] | undefined;
  topic?: string[] | undefined;
  address?: string | undefined;
  txHash?: string | undefined;
  search?: string | undefined;
  successfulOnly?: boolean | undefined;
  fromLedger?: string | undefined;
  fromTime?: string | undefined;
}

export class TailUsageError extends Error {
  override readonly name = 'TailUsageError';
}

const TX_HASH = /^[0-9a-fA-F]{64}$/;
const ADDRESS = /^(?:[GC][A-Z2-7]{55}|M[A-Z2-7]{68})$/;

/**
 * Translate flags into the store query, with the API's rules for each filter
 * (`packages/api/src/params.ts`): the same topic prefix and `*` wildcard, the
 * same four-topic ceiling, the same shape checks. A filter that the API would
 * reject is rejected here too, rather than silently following nothing.
 *
 * `--from-ledger` and `--from-time` are the API's inclusive lower bounds. They
 * also mean "start from history" rather than from the present, because a lower
 * bound on events that have not been indexed yet would be meaningless.
 */
export function buildTailQuery(flags: TailFlags): { query: EventQuery; fromStart: boolean } {
  const contracts = flags.contract ?? [];
  if (contracts.length > 1) {
    throw new TailUsageError('lens tail follows one contract at a time (or every contract, with no -c).');
  }
  const contractId = contracts[0];
  if (contractId !== undefined && !isContractId(contractId)) {
    throw new TailUsageError(`"${contractId}" is not a contract id. ${CONTRACT_ID_HINT}`);
  }

  const topics = flags.topic ?? [];
  if (topics.length > 4) {
    throw new TailUsageError(
      'At most 4 --topic filters, because only the first four topic positions are indexed.',
    );
  }

  if (flags.address !== undefined) {
    let valid = ADDRESS.test(flags.address);
    if (valid && flags.address.startsWith('M')) {
      try {
        valid = parseMuxedAddress(flags.address) !== null;
      } catch {
        valid = false;
      }
    }
    if (!valid) {
      throw new TailUsageError(
        '--address must be a valid G/C StrKey with 56 characters or M muxed-account StrKey with 69 characters.',
      );
    }
  }
  if (flags.txHash !== undefined && !TX_HASH.test(flags.txHash)) {
    throw new TailUsageError('--tx-hash must be a 64-character hex string.');
  }

  let fromLedger: number | undefined;
  if (flags.fromLedger !== undefined) {
    fromLedger = Number(flags.fromLedger);
    if (!Number.isInteger(fromLedger) || fromLedger < 0) {
      throw new TailUsageError(`--from-ledger must be a non-negative integer, got "${flags.fromLedger}".`);
    }
  }
  const fromTime = flags.fromTime === undefined ? undefined : parseTime(flags.fromTime);

  const query: EventQuery = {
    ...(contractId !== undefined ? { contractId } : {}),
    ...(topics.length > 0 ? { topics: topics.map((t) => (t === '*' || t === '' ? null : t)) } : {}),
    ...(flags.address !== undefined ? { address: flags.address } : {}),
    ...(flags.txHash !== undefined ? { txHash: flags.txHash } : {}),
    ...(flags.search ? { search: flags.search } : {}),
    ...(flags.successfulOnly ? { successfulOnly: true } : {}),
    ...(fromLedger !== undefined ? { fromLedger } : {}),
    ...(fromTime !== undefined ? { fromTime } : {}),
  };
  return { query, fromStart: fromLedger !== undefined || fromTime !== undefined };
}

/** ISO-8601 or epoch seconds, as the API's `fromTime` accepts. */
function parseTime(raw: string): number {
  const value = raw.trim();
  if (/^-?\d+$/.test(value)) return Number(value);
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new TailUsageError(`--from-time must be an ISO-8601 timestamp or epoch seconds, got "${value}".`);
  }
  return Math.floor(parsed / 1000);
}

export interface FollowOptions {
  store: EventStore;
  query: EventQuery;
  /** Replay matching history first, instead of starting at the newest event. */
  fromStart: boolean;
  onEvent: (event: LensEvent) => void;
  /** How long to wait between looks at the database. @default 1000 */
  pollIntervalMs?: number;
  /** Stop after this many matching events. */
  maxEvents?: number | undefined;
  signal?: AbortSignal | undefined;
  /** Events fetched per query while catching up. @default 200 */
  batchSize?: number;
}

/**
 * Follow events matching `query` until aborted (or `maxEvents` is reached).
 * @returns how many events were delivered.
 *
 * The position is a single event id. It advances past every event delivered
 * and — once a query comes back with nothing more — to the newest id seen
 * before that query, so a filter that matches nothing does not rescan the same
 * rows on every poll.
 */
export async function followEvents(options: FollowOptions): Promise<number> {
  const { store, query, onEvent, signal } = options;
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const batchSize = options.batchSize ?? 200;
  let lastId = options.fromStart ? '' : ((await store.getLatestEventId()) ?? '');
  let delivered = 0;

  while (!signal?.aborted) {
    const latest = await store.getLatestEventId();
    if (latest !== null && latest > lastId) {
      for (;;) {
        const page = await store.queryEvents({
          ...query,
          order: 'asc',
          direction: 'forward',
          limit: batchSize,
          skipTotal: true,
          ...(lastId ? { cursor: lastId } : {}),
        });
        for (const event of page.events) {
          onEvent(event);
          lastId = event.id;
          delivered++;
          if (options.maxEvents !== undefined && delivered >= options.maxEvents) return delivered;
        }
        if (!page.nextCursor || signal?.aborted) break;
      }
      if (latest > lastId) lastId = latest;
    }
    await sleep(pollIntervalMs, signal);
  }
  return delivered;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

// ── Output ───────────────────────────────────────────────────────────────────

/** Should output be coloured? `NO_COLOR` and `FORCE_COLOR` win over the TTY check. */
export function wantsColor(stream: { isTTY?: boolean }, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0') return true;
  return stream.isTTY === true;
}

const ANSI = { dim: 2, bold: 1, red: 31, yellow: 33, cyan: 36, magenta: 35 } as const;
type Style = keyof typeof ANSI;

/** Longest rendered value before it is cut; a full event is one `--json` away. */
const MAX_VALUE_CHARS = 200;

/**
 * One event as one line:
 *
 *   12:01:07  L20166232  CDLZ…GCYSC  transfer  GBYR…  GDVF…  "native"  =  11000000
 *
 * Time and ledger first, because tailing is about "what just happened"; the
 * first topic is highlighted because it is nearly always the event's name.
 */
export function formatEvent(event: LensEvent, options: { color: boolean }): string {
  const paint = (style: Style, text: string): string =>
    options.color ? `\u001b[${ANSI[style]}m${text}\u001b[0m` : text;

  const [name, ...rest] = event.topics;
  const parts = [
    paint('dim', clockTime(event.ledgerClosedAt)),
    paint('dim', `L${event.ledger}`),
    paint('cyan', shorten(event.contractId)),
    paint('bold', paint('yellow', name ? renderDecoded(name) : '(no topics)')),
    ...rest.map((t) => paint('magenta', renderDecoded(t))),
    paint('dim', '='),
    truncate(renderDecoded(event.value)),
  ];
  if (!event.inSuccessfulContractCall) parts.push(paint('red', '[failed call]'));
  if (event.decodeError) parts.push(paint('red', `[decode error: ${event.decodeError}]`));
  return parts.join('  ');
}

/** NDJSON: one complete event per line, for `| jq`. */
export function formatEventJson(event: LensEvent): string {
  return JSON.stringify(event);
}

function renderDecoded(decoded: DecodedValue): string {
  const { type, value } = decoded;
  if (type === 'symbol' && typeof value === 'string') return value;
  if (type === 'address' && typeof value === 'string') return shorten(value);
  // i128, u64 and bytes arrive as strings only to stay JSON-safe; quoting
  // them would make an amount look like text. A real `string` keeps its quotes.
  if (type !== 'string' && typeof value === 'string') return value;
  return JSON.stringify(value) ?? 'null';
}

/** `CDLZ…GCYSC`: enough to tell contracts apart at a glance. */
function shorten(strkey: string): string {
  return strkey.length > 12 ? `${strkey.slice(0, 4)}…${strkey.slice(-5)}` : strkey;
}

function truncate(text: string): string {
  return text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS - 1)}…` : text;
}

function clockTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toISOString().slice(11, 19);
}
