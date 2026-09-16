import { buildFilters, MAX_PAGE_SIZE, type LensRpcClient } from './rpc-client.js';
import { assertContractIds } from './contract-id.js';
import { MemoryCursorStore, type CursorStore } from './cursor.js';
import { sleep as defaultSleep } from './retry.js';
import type { EventBatch, PollerOptions } from './types.js';
import type { IngestMetrics } from './metrics.js';

export interface PollerDeps {
  client: LensRpcClient;
  cursors?: CursorStore;
  /** Stable id for the stream's saved position. Defaults to a hash of the config. */
  cursorKey?: string;
  sleep?: (ms: number) => Promise<void>;
  /** Set to stop the generator cleanly. */
  signal?: AbortSignal;
  log?: (message: string) => void;
  metrics?: IngestMetrics;
}

/**
 * Mean Stellar ledger close time, used to turn a ledger lag into a rough
 * wall-clock lag. Protocol target is ~5s and mainnet sits close to it, but it
 * is an average, not a guarantee — hence `lagSeconds` being documented as an
 * estimate everywhere it is surfaced.
 */
export const APPROX_LEDGER_SECONDS = 5;

/** Emitted alongside batches so callers can show progress without extra RPC calls. */
export interface PollerProgress {
  cursor: string;
  ledger: number;
  latestLedger: number;
  caughtUp: boolean;
  /** True on the final batch of a bounded `endLedger` run. */
  reachedEndLedger: boolean;
  /** Ledgers between the last event yielded and the node's latest ledger. */
  lagLedgers: number;
  /**
   * `lagLedgers` x ~5s. An **estimate**: ledger close time varies, so this is
   * for a human-readable "about a minute behind", never for correctness.
   */
  lagSeconds: number;
}

/**
 * One definition of lag, so the CLI, the metrics endpoint (#1) and the API
 * cannot each compute a slightly different number.
 */
export function ingestionLag(ledger: number, latestLedger: number): {
  lagLedgers: number;
  lagSeconds: number;
} {
  // Clamped at zero: a node can report a latestLedger behind the page it just
  // served us, and negative lag would be nonsense in a gauge.
  const lagLedgers = Math.max(0, latestLedger - ledger);
  return { lagLedgers, lagSeconds: lagLedgers * APPROX_LEDGER_SECONDS };
}

/**
 * Streams events for a set of contracts, forever, resuming from a stored cursor.
 *
 * Contract with callers: every batch this yields has already been recorded as
 * *not yet* processed — the cursor is only saved once the consumer asks for the
 * next batch. That gives at-least-once delivery: a crash mid-write replays the
 * last batch rather than losing it. Module 2 deduplicates on the event id, so
 * replay is harmless.
 */
export class EventPoller {
  readonly #client: LensRpcClient;
  readonly #cursors: CursorStore;
  readonly #key: string;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #signal: AbortSignal | undefined;
  readonly #log: (message: string) => void;
  readonly #options: PollerOptions;
  readonly #metrics: IngestMetrics | undefined;

  constructor(options: PollerOptions, deps: PollerDeps) {
    // Before anything reaches the network: a malformed id produces a doomed
    // request whose RPC-side error is far less clear than naming the problem.
    assertContractIds(options.contractIds);
    this.#options = options;
    this.#client = deps.client;
    this.#cursors = deps.cursors ?? new MemoryCursorStore();
    this.#key = deps.cursorKey ?? defaultCursorKey(deps.client.rpcUrl, options.contractIds);
    this.#sleep = deps.sleep ?? defaultSleep;
    this.#signal = deps.signal;
    this.#log = deps.log ?? (() => {});
    this.#metrics = deps.metrics;
  }

  get cursorKey(): string {
    return this.#key;
  }

  /**
   * Resolve where to begin: a stored cursor wins, otherwise an explicit
   * `startLedger`, otherwise the oldest ledger the node still retains.
   * An explicit start ledger outside the retention window is clamped, because
   * the RPC errors rather than returning an empty page.
   */
  async #resolveStart(): Promise<{ cursor?: string; startLedger?: number }> {
    const saved = await this.#cursors.load(this.#key);
    if (saved) {
      this.#log(`resuming from cursor ${saved.cursor} (ledger ${saved.ledger})`);
      return { cursor: saved.cursor };
    }
    const { latestLedger, oldestLedger } = await this.#client.retention();
    const requested = this.#options.startLedger ?? oldestLedger;
    const startLedger = Math.min(Math.max(requested, oldestLedger), latestLedger);
    if (startLedger !== requested) {
      this.#log(
        `startLedger ${requested} is outside the node's retention window ` +
          `[${oldestLedger}, ${latestLedger}]; clamped to ${startLedger}`,
      );
    }
    return { startLedger };
  }

  /** Yields pages of events until aborted. */
  async *stream(): AsyncGenerator<EventBatch & { progress: PollerProgress }> {
    const pageSize = this.#options.pageSize ?? 200;
    const idleMs = this.#options.pollIntervalMs ?? 2000;
    const filters = buildFilters(
      this.#options.contractIds,
      this.#options.topics,
      this.#options.eventType,
    );
    // At-least-once delivery means a crash mid-write replays the last batch.
    // Module 2 absorbs that with INSERT OR IGNORE, but every other consumer —
    // the NDJSON stdout path, for one — would emit the repeat. Drop repeats
    // here so "at least once" is not every consumer's problem to solve.
    const seen = new RecentIds(pageSize * RECENT_ID_WINDOW_PAGES);

    const endLedger = this.#options.endLedger;
    let { cursor, startLedger } = await this.#resolveStart();

    while (!this.#signal?.aborted) {
      let batch: EventBatch;
      try {
        batch = await this.#client.getEvents({
          filters,
          limit: pageSize,
          ...(endLedger !== undefined ? { endLedger } : {}),
          ...(cursor ? { cursor } : { startLedger: startLedger as number }),
        });
      } catch (error) {
        // A cursor can fall out of the retention window if the indexer was off
        // for longer than the node keeps history. Restart from the oldest
        // ledger still available rather than wedging forever.
        if (cursor && isCursorOutOfRange(error)) {
          const { oldestLedger } = await this.#client.retention();
          this.#log(
            `stored cursor is outside the retention window; restarting at ledger ${oldestLedger}. ` +
              'Events between the old cursor and that ledger are unrecoverable from this node.',
          );
          await this.#cursors.clear(this.#key);
          this.#metrics?.cursorRestarted();
          cursor = undefined;
          startLedger = oldestLedger;
          continue;
        }
        throw error;
      }

      // caughtUp reflects what the RPC returned, not what survived dedup: a
      // full page of repeats still means there is more history to walk.
      const caughtUp = batch.events.length < pageSize;
      const fresh = batch.events.filter((event) => seen.add(event.id));
      const lastLedger = batch.events.at(-1)?.ledger ?? 0;

      // A page that came back exactly at the RPC's own ceiling is different
      // from one that merely filled the configured page size: it means a single
      // request straddled more events than the node will ever return at once,
      // so the page boundary is the node's limit rather than ours.
      if (!caughtUp && pageSize >= MAX_PAGE_SIZE) {
        this.#log(
          `page hit the RPC ceiling of ${MAX_PAGE_SIZE} events at ledger ${lastLedger}; ` +
            'this ledger range emits more events than one request can return. ' +
            'Progress is still correct — the cursor advances — but consider a narrower contract filter.',
        );
      }

      // A bounded run is finished when the RPC stops filling pages: it will
      // not serve anything past endLedger, so a short page is the end of the
      // range rather than the tip of the chain.
      const reachedEndLedger = endLedger !== undefined && caughtUp;

      if (fresh.length > 0) {
        yield {
          ...batch,
          events: fresh,
          progress: {
            cursor: batch.cursor,
            ledger: lastLedger,
            latestLedger: batch.latestLedger,
            caughtUp,
            reachedEndLedger,
            ...ingestionLag(lastLedger, batch.latestLedger),
          },
        };
      }

      // Saved only after the consumer has come back for more, so a crash while
      // writing replays the batch instead of dropping it.
      await this.#cursors.save(this.#key, {
        cursor: batch.cursor,
        ledger: lastLedger || batch.latestLedger,
        updatedAt: new Date().toISOString(),
      });
      this.#metrics?.eventsIngested(fresh.length);
      this.#metrics?.progress(lastLedger || batch.latestLedger, batch.latestLedger);

      cursor = batch.cursor;
      startLedger = undefined;

      // End the generator rather than idling forever on a finished range.
      if (reachedEndLedger) return;
      if (caughtUp) await this.#sleep(idleMs);
    }
  }
}

/** Stable, readable cursor key so restarts with the same config resume. */
export function defaultCursorKey(rpcUrl: string, contractIds: string[]): string {
  const host = safeHost(rpcUrl);
  const ids = [...contractIds].sort().join(',') || 'all-contracts';
  return `${host}-${shortHash(ids)}`;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host.replace(/[^A-Za-z0-9._-]/g, '_');
  } catch {
    return 'rpc';
  }
}

/** FNV-1a, 32-bit. Not cryptographic — only needs to be stable and short. */
function shortHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** JSON-RPC "Invalid Request" — how stellar-rpc reports an unusable resume position. */
const JSONRPC_INVALID_REQUEST = -32600;

/**
 * Does this error mean "the position we asked to resume from is no longer
 * retained by this node"?
 *
 * Deliberately narrow, because the recovery path is destructive: it clears the
 * saved cursor and re-indexes from the oldest retained ledger, which is up to
 * seven days of replay. A false positive silently turns a transient blip into
 * a full re-index.
 *
 * The previous predicate matched a bare mention of "cursor" or "oldest"
 * anywhere in the message, so an unrelated proxy error, a malformed-request
 * rejection, or this client's own "accepts either `cursor` or `startLedger`"
 * guard would all trigger that replay. We now require the message to actually
 * be about a position falling outside a range, and — when the transport gives
 * us a JSON-RPC code — that the code is the one stellar-rpc uses for it.
 */
function isCursorOutOfRange(error: unknown): boolean {
  // A numeric JSON-RPC code is authoritative. A non-numeric `code` is an
  // axios/undici transport tag such as 'ECONNREFUSED', which tells us nothing
  // about retention, so it is ignored rather than treated as a mismatch.
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'number' && code !== JSONRPC_INVALID_REQUEST) return false;

  const message = error instanceof Error ? error.message : String(error);

  // What the complaint is about: our resume position.
  const aboutPosition = /\b(cursor|start\s*_?ledger)\b/i.test(message);
  // What is wrong with it: it sits outside the window the node still holds.
  const outOfRange =
    /\bmust be (?:between|within|greater|newer|at least)\b/i.test(message) ||
    /\b(?:is |was )?(?:before|older than|outside)\b.*\boldest\b/i.test(message) ||
    /\bledger range\b/i.test(message) ||
    /\bout(?:side)? of range\b/i.test(message) ||
    /\bno longer (?:available|retained|in the retention window)\b/i.test(message);

  return aboutPosition && outOfRange;
}

/**
 * How many pages of event ids to remember, as a multiple of the page size.
 *
 * A replay re-serves at most the page that was in flight, so one page would
 * technically do. Three gives room for an overlapping cursor window without
 * making the set unbounded — at the 10 000 ceiling that is 30 000 ids, a few
 * megabytes, which is the price of not making every consumer dedupe.
 */
const RECENT_ID_WINDOW_PAGES = 3;

/**
 * Fixed-capacity set of recently seen event ids, in insertion order.
 *
 * A plain Set would grow without bound over a long-running index. Map preserves
 * insertion order, so evicting the oldest key is O(1) and the window slides.
 */
class RecentIds {
  readonly #capacity: number;
  readonly #ids = new Map<string, true>();

  constructor(capacity: number) {
    this.#capacity = Math.max(1, capacity);
  }

  /** Records an id. Returns false when it had already been seen. */
  add(id: string): boolean {
    if (this.#ids.has(id)) return false;
    this.#ids.set(id, true);
    if (this.#ids.size > this.#capacity) {
      const oldest = this.#ids.keys().next();
      if (!oldest.done) this.#ids.delete(oldest.value);
    }
    return true;
  }

  get size(): number {
    return this.#ids.size;
  }
}
