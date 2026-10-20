import { buildFilters, MAX_PAGE_SIZE, type LensRpcClient } from './rpc-client.js';
const assertContractIds = (ids: string[]) => {
  for (const id of ids) {
    if (!/^[0-9a-f]{56}$/i.test(id)) throw new Error(`invalid contract id: ${id}`);
  }
};
import { MemoryCursorStore, type CursorStore } from './cursor.js';
const defaultSleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));
import type { EventBatch, PollerOptions } from './types.js';
const isCursorOutOfRange = (_e: unknown) => false;
import type { StoredEvent } from './store.js';
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
  /**
   * Optional store used to detect and reconcile reorgs. When provided, the
   * poller re-polls the most recent `reorgWindow` ledgers each cycle and
   * compares event ids against what is stored, logging deletions/changes.
   */
  store?: ReorgStore;
}

/**
 * Minimal store surface needed for reorg detection. Module 2's SQLite store
 * satisfies this; tests can supply a fake.
 */
export interface ReorgStore {
  /** Return stored event ids for ledgers in [fromLedger, toLedger]. */
  eventIdsInRange(fromLedger: number, toLedger: number): Promise<Map<string, number>>;
  /** Delete a stored event by id. */
  deleteEvent(id: string): Promise<void>;
}

/**
 * Approximate Stellar ledger close time, used to turn a ledger lag into a rough
 * wall-clock lag. Protocol target is ~5s and mainnet sits close to it, but it
 * is an average, not a guarantee — hence `lagSeconds` being documented as
 * an estimate everywhere it is surfaced.
 */
export const APPROX_LEDGER_SECONDS = 5;

/** Default number of recent ledgers re-polled for reorg detection. */
export const DEFAULT_REORG_WINDOW = 10;

/** How many pages of ids to remember for dedup across replayed batches. */
const RECENT_ID_WINDOW_PAGES = 2;

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
  readonly #store: ReorgStore | undefined;
  readonly #reorgWindow: number;

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
    this.#store = deps.store;
    this.#reorgWindow = Math.max(0, options.reorgWindow ?? DEFAULT_REORG_WINDOW);
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
            lagLedgers: Math.max(0, batch.latestLedger - lastLedger),
            lagSeconds: Math.max(0, batch.latestLedger - lastLedger) * APPROX_LEDGER_SECONDS,
          },
        };
      }

      // Save the cursor only after the consumer has consumed (or skipped)
      // this batch. If nothing fresh came back, the cursor may still advance.
      if (batch.cursor) {
        await this.#cursors.save(this.#key, { cursor: batch.cursor, ledger: lastLedger });
        cursor = batch.cursor;
      } else if (lastLedger > 0) {
        startLedger = lastLedger + 1;
      }

      // Reconcile reorgs against the store on every cycle.
      await this.#reconcileRecent();

      if (caughtUp) {
        await this.#sleep(idleMs);
      }
    }
  }

  /**
   * Re-poll the most recent `reorgWindow` ledgers and compare the event ids
   * the RPC now reports against what is stored. Any stored id that the RPC
   * no longer reports is deleted and logged loudly. This is the reorg
   * convergence path: stored rows follow the new truth instead of drifting
   * permanently.
   */
  async #reconcileRecent(): Promise<void> {
    const store = this.#store;
    if (!store || this.#reorgWindow <= 0) return;

    let latestLedger: number;
    try {
      const retention = await this.#client.retention();
      latestLedger = retention.latestLedger;
    } catch (error) {
      this.#log(`reorg check skipped: could not read retention (${String(error)})`);
      return;
    }

    const fromLedger = Math.max(0, latestLedger - this.#reorgWindow + 1);
    const toLedger = latestLedger;
    if (toLedger < fromLedger) return;

    const stored = await store.eventIdsInRange(fromLedger, toLedger);
    if (stored.size === 0) return;

    const filters = buildFilters(
      this.#options.contractIds,
      this.#options.topics,
      this.#options.eventType,
    );
    const pageSize = this.#options.pageSize ?? 200;

    const current = new Set<string>();
    let cursor: string | undefined;
    let startLedger: number | undefined = fromLedger;
    // Bound the walk so a pathologically busy window cannot spin forever.
    for (let i = 0; i < 1000; i++) {
      const batch = await this.#client.getEvents({
        filters,
        limit: pageSize,
        endLedger: toLedger,
        ...(cursor ? { cursor } : { startLedger: startLedger as number }),
      });
      for (const event of batch.events) current.add(event.id);
      if (batch.events.length < pageSize) break;
      if (!batch.cursor) break;
      cursor = batch.cursor;
      startLedger = undefined;
    }

    for (const id of stored.keys()) {
      if (!current.has(id)) {
        this.#log(
          `REORG detected: deleting stored event ${id} in ledgers [${fromLedger}, ${toLedger}] no longer reported by the RPC`,
        );
        await store.deleteEvent(id);
      }
    }
  }
}

class RecentIds {
  private readonly capacity: number;
  private readonly order: string[] = [];
  private readonly set = new Set<string>();

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity);
  }

  add(id: string): boolean {
    if (this.set.has(id)) return false;
    this.set.add(id);
    this.order.push(id);
    if (this.order.length > this.capacity) {
      const evicted = this.order.shift();
      if (evicted !== undefined) this.set.delete(evicted);
    }
    return true;
  }
}

function defaultCursorKey(rpcUrl: string, contractIds: string[]): string {
  return `${rpcUrl}:${[...contractIds].sort().join(',')}`;
}

export type { StoredEvent };
