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
import { AdaptivePageSize } from './page-size.js';
import { DEFAULT_REORG_DEPTH, describeReorg, diffLedgerWindow, isEmptyDiff, type ReorgStore } from './reorg.js';

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
  /**
   * Where stored events are read back for reorg checks (#3). Without one there
   * is nothing to compare against, so no check runs.
   */
  reorgStore?: ReorgStore;
  /**
   * Called after every completed poll, including polls that yield no events
   * (#207). Lets a caller refresh a heartbeat on a quiet contract, where the
   * stream yields nothing for minutes at a time.
   */
  onPoll?: (progress: PollerPollProgress) => void;
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
  /**
   * Measured lag (#134): seconds between the last event's ledger close time
   * and now. Null on an empty page, where no close time is known — use
   * `lagSeconds` then.
   */
  measuredLagSeconds: number | null;
}

/**
 * Reported after every completed poll, whether or not it produced events
 * (#207). Carries the stream identity so a caller can key per-stream state
 * such as a heartbeat file.
 */
export interface PollerPollProgress extends PollerProgress {
  /** The stream's saved-position key; unique per contract stream. */
  cursorKey: string;
  /** The contract this poll covered, or `*` for an unfiltered stream. */
  contractId: string;
  /** Events yielded by this poll; zero on a quiet contract. */
  eventCount: number;
}

/**
 * One definition of lag, so the CLI, the metrics endpoint (#1) and the API
 * cannot each compute a slightly different number.
 */
export function ingestionLag(
  ledger: number,
  latestLedger: number,
  lastClosedAt?: string,
  now: number = Date.now(),
): {
  lagLedgers: number;
  lagSeconds: number;
  measuredLagSeconds: number | null;
} {
  const lagLedgers = Math.max(0, latestLedger - ledger);
  // Every event carries its ledger's close time, so the real age of the last
  // event is free; the 5 s estimate is only the fallback for empty pages.
  const closed = lastClosedAt ? Date.parse(lastClosedAt) : Number.NaN;
  const measuredLagSeconds = Number.isNaN(closed) ? null : Math.max(0, Math.round((now - closed) / 1000));
  return { lagLedgers, lagSeconds: lagLedgers * APPROX_LEDGER_SECONDS, measuredLagSeconds };
}

/**
 * The key stored cursors are saved under. Covers the contract ids plus the
 * filter knobs that change what "the stream" is (#127): switching --topic or
 * --type must start a new stream rather than resume mid-history with a
 * different filter.
 */
export function defaultCursorKey(
  rpcUrl: string,
  contractIds: readonly string[] = [],
  filters: { eventType?: string | undefined; topics?: readonly (readonly string[])[] | undefined } = {},
): string {
  const host = safeHost(rpcUrl);
  const ids = [...contractIds].sort().join(',') || 'all-contracts';
  const eventType = filters.eventType ?? 'contract';
  const topics = filters.topics ?? [];
  if (eventType === 'contract' && topics.length === 0) return `${host}-${shortHash(ids)}`;
  // Topic filters are order-sensitive within a filter (positional) but not
  // between filters (any may match), so each is kept as is and the list sorted.
  const topicPart = topics.map((t) => t.join('/')).sort().join('|');
  return `${host}-${shortHash(`${ids};type=${eventType};topics=${topicPart}`)}`;
}

/** Derive a per-contract cursor key from a caller-named base key (#142). */
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
  readonly #reorgStore: ReorgStore | undefined;
  readonly #onPoll: ((progress: PollerPollProgress) => void) | undefined;
  readonly #explicitCursorKey: boolean;

  constructor(options: PollerOptions, deps: PollerDeps) {
    assertContractIds(options.contractIds);
    this.#options = options;
    this.#client = deps.client;
    this.#cursors = deps.cursors ?? new MemoryCursorStore();
    this.#explicitCursorKey = deps.cursorKey !== undefined;
    this.#key = deps.cursorKey ?? defaultCursorKey(deps.client.rpcUrl, options.contractIds, {
      eventType: options.eventType,
      topics: options.topics,
    });
    this.#sleep = deps.sleep ?? defaultSleep;
    this.#now = deps.now ?? Date.now;
    this.#signal = deps.signal;
    this.#log = deps.log ?? (() => {});
    this.#metrics = deps.metrics;
    this.#reorgStore = deps.reorgStore;
    this.#onPoll = deps.onPoll;
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
    const bounds = this.#options.pageSizeBounds;
    const pager = new AdaptivePageSize({
      initial: this.#options.pageSize ?? 200,
      min: bounds?.min ?? this.#options.pageSize ?? 200,
      max: bounds?.max ?? this.#options.pageSize ?? 200,
      ...(bounds?.fastMs !== undefined ? { fastMs: bounds.fastMs } : {}),
      ...(bounds?.slowMs !== undefined ? { slowMs: bounds.slowMs } : {}),
    });
    const reorgDepth = this.#options.reorgDepth ?? DEFAULT_REORG_DEPTH;
    let lastReorgCheckTip: number | undefined;
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
      /** Bounded runs only: saw its short page, so it is never polled again. */
      done: boolean;
    }

    const filterOpts = { eventType, topics: this.#options.topics };
    const streams: PerContractStream[] = contractIds.length > 0
      ? contractIds.map((id) => ({
          contractId: id,
          filter: buildFilters([id], this.#options.topics, eventType)[0]!,
          // A contract's saved position is keyed to that contract alone, so
          // adding or removing a sibling does not shift it (#142). The key
          // also covers the shared filters, so a changed --topic or --type
          // starts every contract on a fresh stream (#127). An explicit
          // cursorKey names the whole stream; the contract id is appended.
          key: this.#explicitCursorKey
            ? contractCursorKey(this.#key, id)
            : defaultCursorKey(this.#client.rpcUrl, [id], filterOpts),
          cursor: undefined as string | undefined,
          startLedger: undefined as number | undefined,
          done: false,
        }))
      : [{
          contractId: '*',
          filter: buildFilters([], this.#options.topics, eventType)[0]!,
          key: this.#key,
          cursor: undefined as string | undefined,
          startLedger: undefined as number | undefined,
          done: false,
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

    // At-least-once delivery means a crash mid-write replays the last batch.
    // Module 2 absorbs that with INSERT OR IGNORE, but every other consumer —
    // the NDJSON stdout path, for one — would emit the repeat. Drop repeats
    // here so "at least once" is not every consumer's problem to solve.
    // Sized for the largest page the stream may ask for, not the current one.
    const seen = new RecentIds((bounds?.max ?? pager.size) * RECENT_ID_WINDOW_PAGES);
    const stalledThresholdMs = this.#options.stalledThresholdMs ?? DEFAULT_STALLED_THRESHOLD_MS;
    let observedLatestLedger: number | undefined;
    let latestLedgerUnchangedSince: number | undefined;
    let stallReported = false;
    const endLedger = this.#options.endLedger;

    while (!this.#signal?.aborted) {
      // A bounded stream that already saw its short page is done: it is not
      // asked for another page, so a sibling's backfill does not make it
      // re-read anything (#142).
      const active = streams.filter((s) => !s.done);
      if (active.length === 0) return;
      // Fixed for this round of requests: `pager.size` may change once it is measured.
      const pageSize = pager.size;
      let results: Array<{ stream: PerContractStream; batch: EventBatch }>;
      const requestedAt = this.#now();
      try {
        results = await Promise.all(active.map(async (s) => {
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
        pager.recordPage(results.reduce((n, r) => n + r.batch.events.length, 0), this.#now() - requestedAt);
        if (pager.size !== pageSize) this.#log(`page size ${pageSize} -> ${pager.size}`);
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
          // Retries exhausted is how a request too large for the node to answer
          // in time surfaces, so the next one asks for less.
          pager.recordFailure();
          if (pager.size !== pageSize) this.#log(`page size ${pageSize} -> ${pager.size} after a failed request`);
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

      // A short page marks a bounded stream finished; it drops out of the
      // next round entirely. Unbounded streams never mark themselves done.
      for (const r of results) {
        if (endLedger !== undefined && r.batch.events.length < pageSize) r.stream.done = true;
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

      // A bounded run finishes when every stream saw its short page — done
      // streams count because their last page was short by definition.
      const reachedEndLedger = endLedger !== undefined && streams.every((s) => s.done);

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
            ...ingestionLag(lastLedger, latestLedger, allEvents.at(-1)?.ledgerClosedAt, this.#now()),
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

      // Every completed poll reports, even when it yielded nothing: a quiet
      // contract must still look alive to whoever watches the heartbeat (#207).
      if (this.#onPoll) {
        const progressLedger = lastLedger || latestLedger;
        const report: PollerPollProgress = {
          cursor: results[0]?.batch.cursor ?? '',
          ledger: progressLedger,
          latestLedger,
          caughtUp,
          reachedEndLedger,
          ...ingestionLag(progressLedger, latestLedger, allEvents.at(-1)?.ledgerClosedAt, this.#now()),
          cursorKey: this.#key,
          contractId: streams.length === 1 ? streams[0]!.contractId : '*',
          eventCount: fresh.length,
        };
        try {
          this.#onPoll(report);
        } catch (error) {
          this.#log(`onPoll callback failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (allEvents.length > 0) idleMs = baseIdleMs;
      if (reachedEndLedger) return;

      // At the tip, and the tip has moved since the last look: re-read the
      // newest ledgers and make the stored rows match (#3). Once per new tip,
      // not once per idle poll, so a quiet node costs nothing extra.
      if (
        caughtUp &&
        this.#reorgStore &&
        reorgDepth > 0 &&
        endLedger === undefined &&
        latestLedger !== lastReorgCheckTip
      ) {
        lastReorgCheckTip = latestLedger;
        await this.#checkReorg(
          streams.map((s) => s.filter),
          latestLedger,
          oldestLedger,
          reorgDepth,
          pageSize,
        );
      }

      if (caughtUp) {
        await this.#sleep(idleMs);
        if (allEvents.length === 0) idleMs = Math.min(maxIdleMs, Math.max(baseIdleMs, idleMs * 2));
      }
    }
  }

  /**
   * Re-reads the last `depth` ledgers worth of events and reports the
   * difference to the store, so a chain re-org rewrites rows that no longer
   * match the node's view of history.
   *
   * Each contract stream has its own filter, so the truth page is fetched once
   * per stream; the store's window covers the whole contract set, and the
   * merged truth is what it is compared against.
   *
   * Never fatal: a failed check is logged and the stream carries on, because
   * an RPC blip during a reorg check must not stop indexing. The next new tip
   * checks the window again.
   */
  async #checkReorg(
    streamFilters: EventFilter[],
    tip: number,
    oldestLedger: number,
    depth: number,
    limit: number,
  ): Promise<void> {
    const store = this.#reorgStore;
    if (!store) return;
    const fromLedger = Math.max(oldestLedger, tip - depth + 1);
    try {
      const truth: RawEvent[] = [];
      for (const filter of streamFilters) {
        let page = await this.#client.getEvents({ filters: [filter], startLedger: fromLedger, limit });
        for (;;) {
          // The tip may have moved while paging; ledgers past it are the main
          // stream's business, and are not stored yet to compare against.
          truth.push(...page.events.filter((e) => e.ledger <= tip));
          const last = page.events.at(-1);
          if (page.events.length < limit || !last || last.ledger > tip) break;
          page = await this.#client.getEvents({ filters: [filter], cursor: page.cursor, limit });
        }
      }
      const stored = await store.eventsInLedgers(fromLedger, tip);
      const diff = diffLedgerWindow({ fromLedger, toLedger: tip }, stored, truth);
      if (isEmptyDiff(diff)) return;
      this.#log(describeReorg(diff));
      await store.applyReorg(diff);
    } catch (error) {
      this.#log(`reorg check for ledgers ${fromLedger}..${tip} failed: ${error instanceof Error ? error.message : String(error)}`);
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

/** FNV-1a, 8 hex chars — the same digest earlier releases used for cursor keys. */
function shortHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
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
