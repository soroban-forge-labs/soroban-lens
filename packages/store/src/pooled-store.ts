import { Worker } from 'node:worker_threads';
import { SqliteEventStore, type SqliteStoreOptions } from './sqlite-store.js';
import {
  reviveError,
  type PoolRequest,
  type PoolResponse,
  type ReadMethod,
  type ReadWorkerData,
} from './pool-protocol.js';
import type { EventStore, PruneToSizeResult } from './store.js';
import type {
  AddressContractSummary,
  ContractPage,
  ContractSpecRecord,
  ContractSummary,
  EventPage,
  EventQuery,
  LensEvent,
  RawEventInput,
  StoreStats,
  StreamState,
  TimeBucket,
  TimeBucketCount,
  TopicCount,
} from './types.js';

export interface PooledStoreOptions extends SqliteStoreOptions {
  /**
   * How many read threads to run. Defaults to 2, which is enough to stop one
   * expensive query monopolising the store: one worker grinds, the other serves
   * everything else.
   *
   * Each worker is a thread and its own SQLite connection, so this is not free
   * — and because `node:sqlite` is synchronous, a worker serves exactly one
   * query at a time. More workers buy concurrency, not throughput per query.
   */
  poolSize?: number;
}

const DEFAULT_POOL_SIZE = 2;

interface Pending {
  readonly request: PoolRequest;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

interface Slot {
  readonly worker: Worker;
  /** The job this worker is running, or null when it is idle. */
  inFlight: Pending | null;
  alive: boolean;
}

/**
 * An `EventStore` that runs reads on a small pool of worker threads, each with
 * its own read-only connection, and keeps writes on the calling thread (#159).
 *
 * `node:sqlite` is synchronous, so every method of `SqliteEventStore` does its
 * work on the event loop of whichever thread calls it. In the API that is the
 * thread serving HTTP: one full-text search or `COUNT(*)` over a large table and
 * health checks, other requests and the SSE poll tick all wait behind it.
 * Moving reads to threads does not make any single query faster — it stops one
 * query from being everyone else's problem.
 *
 * Writes are not pooled. SQLite has one writer, the schema belongs to it, and
 * the issue asked only for reads to move; `insertEvents` and friends run on the
 * calling thread exactly as before.
 */
export class PooledSqliteEventStore implements EventStore {
  readonly #writer: SqliteEventStore;
  readonly #slots: Slot[] = [];
  /** Jobs waiting for a worker, oldest first. */
  readonly #queue: Pending[] = [];
  readonly #inFlight = new Map<number, Pending>();
  #seq = 0;
  #closed = false;

  private constructor(writer: SqliteEventStore) {
    this.#writer = writer;
  }

  /**
   * Open the writer connection, spawn the read workers and wait for each to
   * report its connection usable.
   *
   * A factory rather than a constructor because spawning a thread is async —
   * the same reason `PostgresEventStore.connect` exists.
   */
  static async open(options: PooledStoreOptions): Promise<PooledSqliteEventStore> {
    const poolSize = options.poolSize ?? DEFAULT_POOL_SIZE;
    if (!Number.isInteger(poolSize) || poolSize < 1) {
      throw new Error(`poolSize must be a positive integer, got ${String(options.poolSize)}`);
    }
    // Each worker opens the path independently, and ':memory:' means "a fresh
    // private database" to every one of them. A pool over it would read empty
    // tables while the writer's rows sat in another thread's heap.
    if (options.path === ':memory:') {
      throw new Error('PooledSqliteEventStore needs a file path; :memory: is private to one connection');
    }

    const { poolSize: _poolSize, ...writerOptions } = options;
    const writer = new SqliteEventStore(writerOptions);
    const store = new PooledSqliteEventStore(writer);

    try {
      await Promise.all(Array.from({ length: poolSize }, () => store.#spawn(options)));
    } catch (error) {
      // Leave nothing running behind a failed open.
      await store.close();
      throw error;
    }
    return store;
  }

  /** The database file every connection in this pool is open on. */
  get path(): string {
    return this.#writer.path;
  }

  /** How many read workers are alive. */
  get poolSize(): number {
    return this.#slots.filter((slot) => slot.alive).length;
  }

  async #spawn(options: PooledStoreOptions): Promise<void> {
    const workerData: ReadWorkerData = {
      path: options.path,
      countCacheTtlMs: options.countCacheTtlMs,
      forceDisableFts5: options.forceDisableFts5,
    };
    const worker = new Worker(new URL('./read-worker.js', import.meta.url), { workerData });
    // Tracked from the moment it is spawned, not from the moment it is usable:
    // a worker whose connection failed to open is still a live thread, and
    // close() has to be able to reach it. `alive` gates dispatch, not cleanup.
    const slot: Slot = { worker, inFlight: null, alive: false };
    this.#slots.push(slot);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error): void => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };

      worker.on('message', (message: PoolResponse) => {
        switch (message.kind) {
          case 'ready':
            slot.alive = true;
            settle();
            // An idle worker must not hold the process open; #assign refs it
            // again for the duration of a job.
            worker.unref();
            return;
          case 'failed':
            slot.alive = false;
            settle(reviveError(message.error));
            return;
          case 'result':
            this.#settle(slot, message.seq, (pending) => {
              pending.resolve(message.value);
            });
            return;
          case 'error':
            this.#settle(slot, message.seq, (pending) => {
              pending.reject(reviveError(message.error));
            });
            return;
        }
      });

      worker.on('error', (error: Error) => {
        this.#fail(slot, error);
        settle(error);
      });

      worker.on('exit', (code) => {
        this.#fail(slot, new Error(`read worker exited with code ${code}`));
        settle(new Error(`read worker exited with code ${code} before it was ready`));
      });
    });
  }

  #settle(slot: Slot, seq: number, finish: (pending: Pending) => void): void {
    const pending = this.#inFlight.get(seq);
    this.#inFlight.delete(seq);
    if (slot.inFlight?.request.seq === seq) slot.inFlight = null;
    slot.worker.unref();
    if (pending) finish(pending);
    this.#drain();
  }

  /** A worker died: fail whatever it was running and stop handing it work. */
  #fail(slot: Slot, error: Error): void {
    slot.alive = false;
    const pending = slot.inFlight;
    slot.inFlight = null;
    if (pending) {
      this.#inFlight.delete(pending.request.seq);
      pending.reject(error);
    }
    if (this.#closed) return;
    // With no workers left there is nothing to drain onto, and a queued job
    // would otherwise wait forever.
    if (this.#slots.every((other) => !other.alive)) {
      while (this.#queue.length > 0) {
        this.#queue.shift()?.reject(new Error(`every read worker has died: ${error.message}`));
      }
    }
  }

  /**
   * Hand queued jobs to idle workers.
   *
   * Least-busy, not round-robin: a worker inside a synchronous SQLite call is
   * fully occupied, so "idle" is binary. Round-robin would still park a cheap
   * read behind the slow one it happened to be queued behind, which is the
   * exact failure this class exists to remove.
   */
  #drain(): void {
    for (const slot of this.#slots) {
      if (this.#queue.length === 0) return;
      if (!slot.alive || slot.inFlight !== null) continue;
      const pending = this.#queue.shift();
      if (pending) this.#assign(slot, pending);
    }
  }

  #assign(slot: Slot, pending: Pending): void {
    slot.inFlight = pending;
    this.#inFlight.set(pending.request.seq, pending);
    slot.worker.ref();
    slot.worker.postMessage(pending.request);
  }

  #read<T>(method: ReadMethod, args: unknown[]): Promise<T> {
    if (this.#closed) return Promise.reject(new Error('store is closed'));
    if (this.#slots.every((slot) => !slot.alive)) {
      return Promise.reject(new Error('no read workers are alive'));
    }
    const request: PoolRequest = { seq: this.#seq++, method, args };
    return new Promise<T>((resolve, reject) => {
      const pending: Pending = {
        request,
        resolve: resolve as (value: unknown) => void,
        reject,
      };
      const idle = this.#slots.find((slot) => slot.alive && slot.inFlight === null);
      if (idle) this.#assign(idle, pending);
      else this.#queue.push(pending);
    });
  }

  // ---------------------------------------------------------------------------
  // Pooled reads.
  // ---------------------------------------------------------------------------

  async getEvent(id: string): Promise<LensEvent | null> {
    return this.#read('getEvent', [id]);
  }

  async queryEvents(query: EventQuery): Promise<EventPage> {
    return this.#read('queryEvents', [query]);
  }

  async listContracts(limit?: number): Promise<ContractSummary[]> {
    return this.#read('listContracts', [limit]);
  }

  async listContractsPage(limit?: number, cursor?: string): Promise<ContractPage> {
    return this.#read('listContractsPage', [limit, cursor]);
  }

  async summarizeAddress(address: string): Promise<AddressContractSummary[]> {
    return this.#read('summarizeAddress', [address]);
  }

  async listTopics(contractId: string, limit?: number): Promise<{ topic: string; count: number }[]> {
    return this.#read('listTopics', [contractId, limit]);
  }

  async countByTopic(limit?: number): Promise<TopicCount[]> {
    return this.#read('countByTopic', [limit]);
  }

  async countByTimeBucket(query: EventQuery, bucket: TimeBucket): Promise<TimeBucketCount[]> {
    return this.#read('countByTimeBucket', [query, bucket]);
  }

  async getStats(): Promise<StoreStats> {
    return this.#read('getStats', []);
  }

  async healthCheck(): Promise<{ ok: boolean; detail: string }> {
    return this.#read('healthCheck', []);
  }

  async getContractSpec(contractId: string): Promise<ContractSpecRecord | null> {
    return this.#read('getContractSpec', [contractId]);
  }

  async listContractSpecs(): Promise<Omit<ContractSpecRecord, 'entriesXdr'>[]> {
    return this.#read('listContractSpecs', []);
  }

  async loadStreamState(key: string): Promise<StreamState | null> {
    return this.#read('loadStreamState', [key]);
  }

  async listStreamStates(): Promise<StreamState[]> {
    return this.#read('listStreamStates', []);
  }

  async checkIntegrity(): Promise<{ id: string; problems: string[] }[]> {
    return this.#read('checkIntegrity', []);
  }

  // ---------------------------------------------------------------------------
  // Kept on the calling thread.
  // ---------------------------------------------------------------------------

  /**
   * Not pooled, deliberately. This is `SELECT MAX(id)` on an indexed column —
   * microseconds — and the API calls it once per request to build an `ETag`.
   * A worker round trip costs more than the query does, so pooling it would
   * make every conditional request slower to fix a stall it never caused.
   */
  async getLatestEventId(): Promise<string | null> {
    return this.#writer.getLatestEventId();
  }

  async migrate(): Promise<void> {
    return this.#writer.migrate();
  }

  async migrateDown(toVersion: number): Promise<number[]> {
    return this.#writer.migrateDown(toVersion);
  }

  async rebuildSearchIndex(): Promise<void> {
    return this.#writer.rebuildSearchIndex();
  }

  /** Writes: `VACUUM INTO` a temp file, then reads it back through a second connection. */
  async exportSnapshot(destPath: string): Promise<number> {
    return this.#writer.exportSnapshot(destPath);
  }

  async importSnapshot(srcPath: string): Promise<number> {
    return this.#writer.importSnapshot(srcPath);
  }

  /** `PRAGMA wal_checkpoint` is a write, whatever its shape suggests. */
  async checkpoint(mode?: 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE'): Promise<void> {
    return this.#writer.checkpoint(mode);
  }

  async insertEvents(events: RawEventInput[]): Promise<number> {
    return this.#writer.insertEvents(events);
  }

  async insertDecoded(events: LensEvent[]): Promise<number> {
    return this.#writer.insertDecoded(events);
  }

  async saveContractSpec(record: ContractSpecRecord): Promise<void> {
    return this.#writer.saveContractSpec(record);
  }

  async saveStreamState(state: StreamState): Promise<void> {
    return this.#writer.saveStreamState(state);
  }

  /** Writes on purpose, and takes the write lock. Never a read worker's job. */
  async writeProbe(): Promise<{ ok: boolean; detail: string }> {
    return this.#writer.writeProbe();
  }

  async pruneBefore(ledger: number): Promise<number> {
    return this.#writer.pruneBefore(ledger);
  }

  async deleteEvents(ids: string[]): Promise<number> {
    return this.#writer.deleteEvents(ids);
  }

  async pruneToSize(targetBytes: number, chunkLedgers?: number): Promise<PruneToSizeResult> {
    return this.#writer.pruneToSize(targetBytes, chunkLedgers);
  }

  async redecode(all?: boolean): Promise<number> {
    return this.#writer.redecode(all);
  }

  async repairRow(id: string): Promise<void> {
    return this.#writer.repairRow(id);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;

    while (this.#queue.length > 0) {
      this.#queue.shift()?.reject(new Error('store is closed'));
    }
    for (const pending of this.#inFlight.values()) {
      pending.reject(new Error('store is closed'));
    }
    this.#inFlight.clear();

    // Every spawned worker, not only the usable ones: one that failed to open
    // its connection is still a thread holding this process open.
    await Promise.all(
      this.#slots.map(async (slot) => {
        slot.inFlight = null;
        slot.alive = false;
        await slot.worker.terminate();
      }),
    );
    await this.#writer.close();
  }
}
