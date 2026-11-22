import {
  buildFilters,
  compareRawEvents,
  MAX_PAGE_SIZE,
  type GetEventsArgs,
  type RpcReadClient,
} from './rpc-client.js';
import { assertContractIds } from './contract-id.js';
import { MemoryCursorStore, type CursorState, type CursorStore } from './cursor.js';
import { compareRetention, describeRetentionGap } from './retention.js';
import { RetryExhaustedError, sleep as defaultSleep } from './retry.js';
import type { EventBatch, EventFilter, PollerOptions, RawEvent, RetentionState } from './types.js';
import type { IngestMetrics } from './metrics.js';

/**
 * The poller refuses to start when the node's passphrase does not match the
 * one for the configured network (#139).
 */
export class NetworkPassphraseMismatchError extends Error {
  readonly expected: string;
  readonly actual: string;
  readonly rpcUrl: string;
  constructor(expected: string, actual: string, rpcUrl: string) {
    super(
      `Network passphrase mismatch at ${rpcUrl}: the node reports "${actual}", ` +
        `but the configured network expects "${expected}". ` +
        `Refusing to index because every stored event would be labelled with ` +
        `the wrong network. Point the RPC URL at a node on the selected network, ` +
        `or select the network the node is actually on.`,
    );
    this.name = 'NetworkPassphraseMismatchError';
    this.expected = expected;
    this.actual = actual;
    this.rpcUrl = rpcUrl;
  }
}

export interface PollerDeps {
  /** Narrow read surface (#143): LensRpcClient, FailoverRpcClient, or a replay client. */
  client: RpcReadClient;
  cursors?: CursorStore;
  /**
   * Base id for the stream's saved position. Every contract derives its own
   * key from this prefix (`<base>:<contractId>`), so adding or removing a
   * contract does not shift anyone else's position (#142).
   *
   * Defaults to the host of the RPC URL.
   */
  cursorKey?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  signal?: AbortSignal;
  log?: (message: string) => void;
  metrics?: IngestMetrics;
}

export const APPROX_LEDGER_SECONDS = 5;
export const DEFAULT_POLL_INTERVAL_MS = 2000;
export const DEFAULT_MAX_POLL_INTERVAL_MS = 30_000;
export const DEFAULT_STALLED_THRESHOLD_MS = 60_000;
export const DEFAULT_CHUNK_CONCURRENCY = 4;

export interface PollerProgress {
  cursor: string;
  ledger: number;
  latestLedger: number;
  caughtUp: boolean;
  reachedEndLedger: boolean;
  lagLedgers: number;
  lagSeconds: number;
}

export function ingestionLag(ledger: number, latestLedger: number): {
  lagLedgers: number;
  lagSeconds: number;
} {
  const lagLedgers = Math.max(0, latestLedger - ledger);
  return { lagLedgers, lagSeconds: lagLedgers * APPROX_LEDGER_SECONDS };
}

/** Base key derived from the RPC URL only (see #142 for why it excludes the set). */
export function defaultCursorKey(rpcUrl: string): string {
  return safeHost(rpcUrl);
}

/** Derive a per-contract cursor key from the base key. */
export function contractCursorKey(baseKey: string, contractId: string): string {
  return `${baseKey}:${contractId}`;
}

export class EventPoller {
  readonly #client: RpcReadClient;
  readonly #cursors: CursorStore;
  readonly #key: string;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #signal: AbortSignal | undefined;
  readonly #log: (message: string) => void;
  readonly #options: PollerOptions;
  readonly #metrics: IngestMetrics | undefined;

  constructor(options: PollerOptions, deps: PollerDeps) {
    assertContractIds(options.contractIds);
    this.#options = options;
    this.#client = deps.client;
    this.#cursors = deps.cursors ?? new MemoryCursorStore();
    this.#key = deps.cursorKey ?? defaultCursorKey(deps.client.rpcUrl);
    this.#sleep = deps.sleep ?? defaultSleep;
    this.#now = deps.now ?? Date.now;
    this.#signal = deps.signal;
    this.#log = deps.log ?? (() => {});
    this.#metrics = deps.metrics;
  }

  get cursorKey(): string {
    return this.#key;
  }

  async #verifyNetworkPassphraseIfConfigured(): Promise<void> {
    const expected = this.#options.networkPassphrase;
    if (!expected) return;
    const { passphrase } = await this.#client.getNetwork();
    if (passphrase !== expected) {
      throw new NetworkPassphraseMismatchError(expected, passphrase, this.#client.rpcUrl);
    }
  }

  async #warnAboutRetentionGap(saved: CursorState): Promise<void> {
    let current: RetentionState;
    try {
      current = await this.#client.retention();
    } catch (error) {
      this.#log(
        `could not read the node's retention window before resuming: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    const warning = describeRetentionGap(
      compareRetention(saved, current),
      saved.updatedAt || undefined,
    );
    if (warning) this.#log(warning);
  }

  async *stream(): AsyncGenerator<EventBatch & { progress: PollerProgress }> {
    const pageSize = this.#options.pageSize ?? 200;
    const baseIdleMs = this.#options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const maxIdleMs = this.#options.maxPollIntervalMs ?? Math.max(baseIdleMs, DEFAULT_MAX_POLL_INTERVAL_MS);
    assertIdlePollingIntervals(baseIdleMs, maxIdleMs);
    await this.#verifyNetworkPassphraseIfConfigured();
    let idleMs = baseIdleMs;

    const eventType = this.#options.eventType ?? 'contract';
    const contractIds = this.#options.contractIds;

    interface PerContractStream {
      contractId: string;
      filter: EventFilter;
      key: string;
      cursor: string | undefined;
      startLedger: number | undefined;
    }

    const streams: PerContractStream[] = contractIds.length > 0
      ? contractIds.map((id) => ({
          contractId: id,
          filter: buildFilters([id], this.#options.topics, eventType)[0]!,
          key: contractCursorKey(this.#key, id),
          cursor: undefined as string | undefined,
          startLedger: undefined as number | undefined,
        }))
      : [{
          contractId: '*',
          filter: buildFilters([], this.#options.topics, eventType)[0]!,
          key: this.#key,
          cursor: undefined as string | undefined,
          startLedger: undefined as number | undefined,
        }];

    let anyNeedBackfill = false;
    for (const s of streams) {
      const saved = await this.#cursors.load(s.key);
      if (saved) {
        await this.#warnAboutRetentionGap(saved);
        this.#log(`resuming from cursor ${saved.cursor} (ledger ${saved.ledger}) [${s.contractId}]`);
        s.cursor = saved.cursor;
      } else {
        anyNeedBackfill = true;
      }
    }
    if (anyNeedBackfill) {
      const { latestLedger, oldestLedger } = await this.#client.retention();
      const requested = this.#options.startLedger ?? oldestLedger;
      const startLedger = Math.min(Math.max(requested, oldestLedger), latestLedger);
      if (startLedger !== requested) {
        this.#log(
          `startLedger ${requested} is outside the node's retention window ` +
            `[${oldestLedger}, ${latestLedger}]; clamped to ${startLedger}`,
        );
      }
      for (const s of streams) {
        if (!s.cursor) s.startLedger = startLedger;
      }
    }

    const seen = new RecentIds(pageSize * RECENT_ID_WINDOW_PAGES);
    const stalledThresholdMs = this.#options.stalledThresholdMs ?? DEFAULT_STALLED_THRESHOLD_MS;
    let observedLatestLedger: number | undefined;
    let latestLedgerUnchangedSince: number | undefined;
    let stallReported = false;
    const endLedger = this.#options.endLedger;

    while (!this.#signal?.aborted) {
      let results: Array<{ stream: PerContractStream; batch: EventBatch }>;
      try {
        results = await Promise.all(streams.map(async (s) => {
          const args: GetEventsArgs & { fallbackLedger?: number } = {
            filters: [s.filter],
            limit: pageSize,
            ...(endLedger !== undefined ? { endLedger } : {}),
            ...(s.cursor
              ? { cursor: s.cursor, ...(s.startLedger !== undefined ? { fallbackLedger: s.startLedger } : {}) }
              : { startLedger: s.startLedger! }),
          };
          const batch = await this.#client.getEvents(args);
          return { stream: s, batch };
        }));
      } catch (error) {
        if (isCursorOutOfRange(error) && streams.some((s) => s.cursor)) {
          const { oldestLedger } = await this.#client.retention();
          this.#log(
            `stored cursor is outside the retention window; restarting at ledger ${oldestLedger}. ` +
              'Events between the old cursor and that ledger are unrecoverable from this node.',
          );
          for (const s of streams) {
            if (s.cursor) {
              await this.#cursors.clear(s.key);
              this.#metrics?.cursorRestarted();
              s.cursor = undefined;
              s.startLedger = oldestLedger;
            }
          }
          continue;
        }
        if (error instanceof RetryExhaustedError) {
          this.#metrics?.rpcExhausted();
          this.#log(`RPC unavailable after ${error.attempts} attempts: ${error.message}`);
          await this.#sleep(idleMs);
          continue;
        }
        throw error;
      }

      this.#metrics?.pageFetched();

      const allEvents: RawEvent[] = [];
      let latestLedger = 0;
      let oldestLedger = Number.POSITIVE_INFINITY;
      for (const r of results) {
        for (const e of r.batch.events) allEvents.push(e);
        latestLedger = Math.max(latestLedger, r.batch.latestLedger);
        oldestLedger = Math.min(oldestLedger, r.batch.oldestLedger);
      }
      allEvents.sort(compareRawEvents);
      if (oldestLedger === Number.POSITIVE_INFINITY) oldestLedger = 0;

      const now = this.#now();
      if (observedLatestLedger === undefined || latestLedger !== observedLatestLedger) {
        observedLatestLedger = latestLedger;
        latestLedgerUnchangedSince = now;
        stallReported = false;
        this.#metrics?.rpcStalled(false);
      } else if (
        !stallReported &&
        latestLedgerUnchangedSince !== undefined &&
        now - latestLedgerUnchangedSince >= stalledThresholdMs
      ) {
        const stalledSeconds = Math.floor((now - latestLedgerUnchangedSince) / 1000);
        this.#log(
          `RPC latest ledger has not advanced beyond ${latestLedger} for ${stalledSeconds}s; ` +
            'the node may be stalled.',
        );
        this.#metrics?.rpcStalled(true);
        stallReported = true;
      }

      const caughtUp = results.every((r) => r.batch.events.length < pageSize);
      const fresh = allEvents.filter((event) => seen.add(event.id));
      const lastLedger = allEvents.at(-1)?.ledger ?? 0;

      if (!caughtUp && pageSize >= MAX_PAGE_SIZE) {
        this.#log(
          `page hit the RPC ceiling of ${MAX_PAGE_SIZE} events at ledger ${lastLedger}; ` +
            'this ledger range emits more events than one request can return. ' +
            'Progress is still correct — the cursor advances — but consider a narrower contract filter.',
        );
      }

      const reachedEndLedger = endLedger !== undefined && caughtUp;

      if (fresh.length > 0) {
        const firstCursor = results[0]?.batch.cursor ?? '';
        yield {
          events: fresh,
          cursor: firstCursor,
          latestLedger,
          oldestLedger,
          progress: {
            cursor: firstCursor,
            ledger: lastLedger,
            latestLedger,
            caughtUp,
            reachedEndLedger,
            ...ingestionLag(lastLedger, latestLedger),
          },
        };
      }

      for (const r of results) {
        await this.#cursors.save(r.stream.key, {
          cursor: r.batch.cursor,
          ledger: r.batch.events.at(-1)?.ledger ?? r.batch.latestLedger,
          updatedAt: new Date().toISOString(),
          retention: { latestLedger: r.batch.latestLedger, oldestLedger: r.batch.oldestLedger },
        });
        r.stream.cursor = r.batch.cursor;
        r.stream.startLedger = undefined;
      }

      if (this.#metrics) {
        const perContract = new Map<string, number>();
        for (const e of fresh) perContract.set(e.contractId, (perContract.get(e.contractId) ?? 0) + 1);
        for (const [id, n] of perContract) this.#metrics.eventsIngested(n, id);
      }
      this.#metrics?.progress(lastLedger || latestLedger, latestLedger);

      if (allEvents.length > 0) idleMs = baseIdleMs;
      if (reachedEndLedger) return;
      if (caughtUp) {
        await this.#sleep(idleMs);
        if (allEvents.length === 0) idleMs = Math.min(maxIdleMs, Math.max(baseIdleMs, idleMs * 2));
      }
    }
  }
}

function assertIdlePollingIntervals(baseMs: number, maxMs: number): void {
  if (!Number.isFinite(baseMs) || baseMs < 0) {
    throw new RangeError('pollIntervalMs must be a finite, non-negative number');
  }
  if (!Number.isFinite(maxMs) || maxMs < baseMs) {
    throw new RangeError('maxPollIntervalMs must be a finite number at least as large as pollIntervalMs');
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host.replace(/[^A-Za-z0-9._-]/g, '_');
  } catch {
    return 'rpc';
  }
}

const JSONRPC_INVALID_REQUEST = -32600;

function isCursorOutOfRange(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'number' && code !== JSONRPC_INVALID_REQUEST) return false;

  const message = error instanceof Error ? error.message : String(error);

  const aboutPosition = /\b(cursor|start\s*_?ledger)\b/i.test(message);
  const outOfRange =
    /\bmust be (?:between|within|greater|newer|at least)\b/i.test(message) ||
    /\b(?:is |was )?(?:before|older than|outside)\b.*\boldest\b/i.test(message) ||
    /\bledger range\b/i.test(message) ||
    /\bout(?:side)? of range\b/i.test(message) ||
    /\bno longer (?:available|retained|in the retention window)\b/i.test(message);

  return aboutPosition && outOfRange;
}

const RECENT_ID_WINDOW_PAGES = 3;

class RecentIds {
  readonly #capacity: number;
  readonly #ids = new Map<string, true>();

  constructor(capacity: number) {
    this.#capacity = Math.max(1, capacity);
  }

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
