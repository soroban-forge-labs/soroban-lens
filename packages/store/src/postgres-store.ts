import { createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { decodeEvent, topicKey, extractAddresses } from './decode.js';
import type { Logger } from './logger.js';
import { LATEST_SCHEMA_VERSION } from './schema.js';
import { POSTGRES_MIGRATIONS } from './postgres-schema.js';
import { normaliseLimit, type EventStore } from './store.js';
import type {
  ContractSpecRecord,
  ContractSummary,
  DecodedValue,
  EventPage,
  EventQuery,
  LensEvent,
  RawEventInput,
  StoreStats,
  StreamState,
  TopicCount,
  TimeBucket,
  TimeBucketCount,
} from './types.js';

/**
 * The slice of `pg` this store uses. Declared here rather than imported so the
 * package compiles, and its offline test suite runs, without `pg` installed —
 * it is an optional peer dependency, loaded only when a Postgres store is
 * actually opened.
 */
export interface PgQueryResult {
  rows: Record<string, unknown>[];
  rowCount: number | null;
}
export interface PgQueryable {
  query(text: string, values?: unknown[]): Promise<PgQueryResult>;
}
export interface PgClient extends PgQueryable {
  release(error?: Error | boolean): void;
}
export interface PgPool extends PgQueryable {
  connect(): Promise<PgClient>;
  end(): Promise<void>;
}

export interface PostgresStoreOptions {
  /** `postgres://user:pass@host:5432/db`. Required unless `pool` is given. */
  connectionString?: string;
  /** An existing pool to use instead of opening one. It is not ended by `close()`. */
  pool?: PgPool;
  /**
   * Keep every table in this schema (created if missing) instead of `public`.
   * Only honoured together with `connectionString`. Lets several stores — or a
   * test run — share one database without seeing each other's rows.
   */
  schema?: string;
  /** Maximum pool size when opening one. Defaults to the `pg` default (10). */
  max?: number;
  /** Run migrations on connect. Defaults to true. */
  migrateOnOpen?: boolean;
  /** Structured logger for migration events. Defaults to a no-op. */
  log?: Logger;
  /** How long a filtered COUNT(*) is reused, in ms; see `SqliteStoreOptions.countCacheTtlMs`. Defaults to 2000. */
  countCacheTtlMs?: number;
  /** Clock for the count cache's TTL, swappable in tests. Defaults to Date.now. */
  now?: () => number;
  /** Prune oldest ledgers when `sizeBytes + walSizeBytes` exceeds this. Optional. */
  maxSizeBytes?: number;
}

const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** Serialises concurrent migrators (two indexers starting together). */
const MIGRATION_LOCK_KEY = 7_265_810_221;

const SCHEMA_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

async function loadPg(): Promise<{ Pool: new (config: Record<string, unknown>) => PgPool }> {
  // A variable specifier keeps TypeScript from resolving 'pg' at build time.
  const specifier = 'pg';
  let mod: { Pool?: unknown; default?: { Pool?: unknown } };
  try {
    mod = (await import(specifier)) as typeof mod;
  } catch (cause) {
    throw new Error(
      "The Postgres backend needs the 'pg' package, which is an optional peer dependency: run `npm install pg`.",
      { cause },
    );
  }
  const Pool = mod.Pool ?? mod.default?.Pool;
  if (typeof Pool !== 'function') throw new Error("the 'pg' package did not export a Pool");
  return { Pool: Pool as new (config: Record<string, unknown>) => PgPool };
}

/**
 * Postgres-backed `EventStore` (#22).
 *
 * Implements the same trait as `SqliteEventStore`, so nothing above Module 2
 * changes. Decoding is backend-independent: rows are produced by `decodeEvent`
 * and read back into the same `LensEvent` shape.
 *
 * Open one with {@link PostgresEventStore.connect}; the constructor is for a
 * caller that already owns a pool and has migrated it.
 */
export class PostgresEventStore implements EventStore {
  readonly #pool: PgPool;
  readonly #ownsPool: boolean;
  readonly #log: Logger;
  readonly #countCacheTtlMs: number;
  readonly #now: () => number;
  readonly #maxSizeBytes: number | undefined;
  readonly #countCache = new Map<string, { total: number; expiresAt: number }>();

  constructor(pool: PgPool, options: PostgresStoreOptions = {}, ownsPool = false) {
    this.#pool = pool;
    this.#ownsPool = ownsPool;
    this.#log = options.log ?? noopLogger;
    this.#countCacheTtlMs = options.countCacheTtlMs ?? 2000;
    this.#now = options.now ?? Date.now;
    this.#maxSizeBytes = options.maxSizeBytes;
  }

  /** Open a pool, apply pending migrations (unless disabled) and return the store. */
  static async connect(options: PostgresStoreOptions): Promise<PostgresEventStore> {
    let pool: PgPool;
    let ownsPool = false;

    if (options.pool) {
      pool = options.pool;
    } else {
      if (!options.connectionString) {
        throw new Error('PostgresEventStore.connect needs a `connectionString` or a `pool`');
      }
      if (options.schema !== undefined && !SCHEMA_NAME.test(options.schema)) {
        throw new Error(`invalid schema name "${options.schema}": use letters, digits and underscores`);
      }
      const { Pool } = await loadPg();
      const base: Record<string, unknown> = {
        connectionString: options.connectionString,
        ...(options.max !== undefined ? { max: options.max } : {}),
      };
      if (options.schema) {
        const admin = new Pool({ ...base, max: 1 });
        try {
          await admin.query(`CREATE SCHEMA IF NOT EXISTS "${options.schema}"`);
        } finally {
          await admin.end();
        }
        // public stays on the path so extensions installed there (pg_trgm) resolve.
        pool = new Pool({ ...base, options: `-c search_path="${options.schema}",public` });
      } else {
        pool = new Pool(base);
      }
      ownsPool = true;
    }

    const store = new PostgresEventStore(pool, options, ownsPool);
    if (options.migrateOnOpen !== false) {
      try {
        await store.migrate();
      } catch (error) {
        await store.close();
        throw error;
      }
    }
    return store;
  }

  // ---------------------------------------------------------------------------
  // transactions and migrations
  // ---------------------------------------------------------------------------

  async #tx<T>(fn: (client: PgQueryable) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      try {
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    } finally {
      client.release();
    }
  }

  async migrate(): Promise<void> {
    await this.#tx(async (db) => {
      await db.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
      await db.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version    INTEGER PRIMARY KEY,
          name       TEXT NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);
      const applied = new Set(
        (await db.query('SELECT version FROM schema_migrations')).rows.map((r) => Number(r['version'])),
      );
      const pending = POSTGRES_MIGRATIONS.filter((m) => !applied.has(m.version)).sort(
        (a, b) => a.version - b.version,
      );

      for (const migration of pending) {
        let skipped = false;
        if (migration.optional) {
          // A savepoint, so a failed optional step does not poison the transaction.
          await db.query('SAVEPOINT optional_migration');
          try {
            await db.query(migration.up);
            await db.query('RELEASE SAVEPOINT optional_migration');
          } catch (error) {
            await db.query('ROLLBACK TO SAVEPOINT optional_migration');
            skipped = true;
            const reason = error instanceof Error ? error.message : String(error);
            this.#log.warn(
              'migration_skipped',
              `skipped migration ${migration.version} (${migration.name}): ${reason}. Search still works, without its trigram index.`,
              { version: migration.version, name: migration.name },
            );
          }
        } else {
          await db.query(migration.up);
        }
        if (!skipped) {
          this.#log.info('migration_applied', `applied migration ${migration.version}: ${migration.name}`, {
            version: migration.version,
            name: migration.name,
          });
        }
        await db.query('INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1, $2, $3)', [
          migration.version,
          migration.name,
          new Date().toISOString(),
        ]);
      }
    });
  }

  async migrateDown(toVersion: number): Promise<number[]> {
    return this.#tx(async (db) => {
      await db.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
      const applied = (
        await db.query('SELECT version, name FROM schema_migrations ORDER BY version DESC')
      ).rows
        .map((r) => ({ version: Number(r['version']), name: String(r['name']) }))
        .filter((m) => m.version > toVersion);

      if (applied.length === 0) return [];

      // All-or-nothing, as in the SQLite store: refuse up front rather than
      // roll back half of a range.
      const byVersion = new Map(POSTGRES_MIGRATIONS.map((m) => [m.version, m]));
      const missing = applied.filter((m) => !byVersion.get(m.version)?.down);
      if (missing.length > 0) {
        throw new Error(
          `cannot roll back: migration ${missing[0]!.version} (${missing[0]!.name}) has no down SQL. ` +
            `Nothing was rolled back.`,
        );
      }

      for (const { version } of applied) {
        const migration = byVersion.get(version)!;
        await db.query(migration.down!);
        await db.query('DELETE FROM schema_migrations WHERE version = $1', [version]);
        this.#log.info('migration_rolled_back', `rolled back migration ${version}: ${migration.name}`, {
          version,
          name: migration.name,
        });
      }
      return applied.map((m) => m.version);
    });
  }

  // ---------------------------------------------------------------------------
  // writes
  // ---------------------------------------------------------------------------

  async insertEvents(events: RawEventInput[]): Promise<number> {
    return this.insertDecoded(events.map((e) => decodeEvent(e)));
  }

  async insertDecoded(events: LensEvent[]): Promise<number> {
    if (events.length === 0) return 0;

    // One transaction per batch: an interrupted batch leaves no partial page,
    // and Module 1 replays it on restart.
    return this.#tx(async (db) => {
      let inserted = 0;
      for (const e of events) {
        // ON CONFLICT DO NOTHING gives idempotency on the event id, which is what
        // makes Module 1's at-least-once delivery safe to replay.
        const result = await db.query(INSERT_EVENT, insertParams(e));
        const changed = result.rowCount ?? 0;
        inserted += changed;
        if (changed > 0) await this.#insertAddresses(db, e.id, e);
      }
      return inserted;
    });
  }

  /** Mirrors `SqliteEventStore`: topics beyond the indexed four still get a `topicN` position. */
  async #insertAddresses(db: PgQueryable, eventId: string, e: LensEvent): Promise<void> {
    const insert = (address: string, position: string): Promise<PgQueryResult> =>
      db.query(
        'INSERT INTO event_addresses (event_id, address, position) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [eventId, address, position],
      );
    for (const [i, topicXdr] of e.topicsXdr.entries()) {
      for (const address of extractAddresses(topicXdr)) await insert(address, `topic${i}`);
    }
    for (const address of extractAddresses(e.valueXdr)) await insert(address, 'value');
  }

  // ---------------------------------------------------------------------------
  // reads
  // ---------------------------------------------------------------------------

  async getEvent(id: string): Promise<LensEvent | null> {
    const { rows } = await this.#pool.query('SELECT * FROM events WHERE id = $1', [id]);
    return rows[0] ? rowToEvent(rows[0]) : null;
  }

  async queryEvents(query: EventQuery): Promise<EventPage> {
    const limit = normaliseLimit(query.limit);
    const order = query.order === 'asc' ? 'ASC' : 'DESC';
    const backward = query.direction === 'backward';
    const where = buildWhere(query);
    const { total, isEstimate } = query.skipTotal
      ? { total: 0, isEstimate: false }
      : await this.#countCached(where);

    // Keyset pagination on the event id, which `COLLATE "C"` makes sort
    // chronologically — see postgres-schema.ts. Same semantics as the SQLite
    // store: paging backward scans against `order` and flips the rows back.
    const afterOp = order === 'DESC' ? '<' : '>';
    const beforeOp = order === 'DESC' ? '>' : '<';
    const scanOrder = backward ? (order === 'DESC' ? 'ASC' : 'DESC') : order;
    const values: unknown[] = [...where.values];
    let keyset = '';
    if (query.cursor) {
      values.push(query.cursor);
      keyset = `${where.clause ? 'AND' : 'WHERE'} id ${backward ? beforeOp : afterOp} $${values.length}`;
    }
    values.push(limit + 1);
    const { rows } = await this.#pool.query(
      `SELECT * FROM events ${where.clause} ${keyset} ORDER BY id ${scanOrder} LIMIT $${values.length}`,
      values,
    );

    const hasMore = rows.length > limit;
    const scanned = hasMore ? rows.slice(0, limit) : rows;
    const page = backward ? scanned.reverse() : scanned;
    const first = page[0] ? String(page[0]['id']) : undefined;
    const lastRow = page.at(-1);
    const last = lastRow ? String(lastRow['id']) : undefined;

    const nextCursor = backward
      ? last !== undefined && (await this.#existsBeyond(where, afterOp, last))
        ? last
        : null
      : hasMore
        ? (last ?? null)
        : null;
    const prevCursor = backward
      ? hasMore
        ? (first ?? null)
        : null
      : first !== undefined && (await this.#existsBeyond(where, beforeOp, first))
        ? first
        : null;

    return {
      events: page.map(rowToEvent),
      nextCursor,
      prevCursor,
      total,
      ...(isEstimate ? { totalIsEstimate: true as const } : {}),
    };
  }

  /** Is there any matching row past `id` in the direction of `op`? */
  async #existsBeyond(
    where: { clause: string; values: unknown[] },
    op: '<' | '>',
    id: string,
  ): Promise<boolean> {
    const values = [...where.values, id];
    const { rows } = await this.#pool.query(
      `SELECT 1 FROM events ${where.clause} ${where.clause ? 'AND' : 'WHERE'} id ${op} $${values.length} LIMIT 1`,
      values,
    );
    return rows.length > 0;
  }

  async countByTimeBucket(query: EventQuery, bucket: TimeBucket): Promise<TimeBucketCount[]> {
    const width = { minute: 60, hour: 3600, day: 86400 }[bucket];
    const where = buildWhere(query);
    // Integer division on BIGINT floors for the non-negative epochs stored here,
    // matching the SQLite store's bucket starts exactly.
    const { rows } = await this.#pool.query(
      `SELECT (closed_at_unix / ${width}) * ${width} AS start, COUNT(*)::int AS count
       FROM events
       ${where.clause}
       GROUP BY start
       ORDER BY start ASC`,
      where.values,
    );
    return rows.map((r) => ({ start: Number(r['start']), count: Number(r['count']) }));
  }

  async getLatestEventId(): Promise<string | null> {
    const { rows } = await this.#pool.query('SELECT MAX(id) AS id FROM events');
    const id = rows[0]?.['id'];
    return id === null || id === undefined ? null : String(id);
  }


  async #countCached(where: { clause: string; values: unknown[] }): Promise<{ total: number; isEstimate: boolean }> {
    const key = `${where.clause}\u0000${JSON.stringify(where.values)}`;
    if (this.#countCacheTtlMs > 0) {
      const cached = this.#countCache.get(key);
      if (cached && cached.expiresAt > this.#now()) return { total: cached.total, isEstimate: true };
    }
    const { rows } = await this.#pool.query(`SELECT COUNT(*)::int AS n FROM events ${where.clause}`, where.values);
    const total = Number(rows[0]?.['n'] ?? 0);
    if (this.#countCacheTtlMs > 0) {
      this.#countCache.set(key, { total, expiresAt: this.#now() + this.#countCacheTtlMs });
    }
    return { total, isEstimate: false };
  }

  async listContracts(limit = 100): Promise<ContractSummary[]> {
    const { rows } = await this.#pool.query(
      `SELECT contract_id,
              COUNT(*)::int         AS event_count,
              MIN(ledger)           AS first_ledger,
              MAX(ledger)           AS last_ledger,
              MAX(ledger_closed_at) AS last_seen_at
       FROM events
       GROUP BY contract_id
       ORDER BY last_ledger DESC, contract_id ASC
       LIMIT $1`,
      [normaliseLimit(limit)],
    );
    return rows.map((r) => ({
      contractId: String(r['contract_id']),
      eventCount: Number(r['event_count']),
      firstLedger: Number(r['first_ledger']),
      lastLedger: Number(r['last_ledger']),
      lastSeenAt: String(r['last_seen_at']),
    }));
  }

  async listTopics(contractId: string, limit = 50): Promise<{ topic: string; count: number }[]> {
    const { rows } = await this.#pool.query(
      `SELECT topic0 AS topic, COUNT(*)::int AS count
       FROM events
       WHERE contract_id = $1 AND topic0 IS NOT NULL
       GROUP BY topic0
       ORDER BY count DESC, topic COLLATE "C" ASC
       LIMIT $2`,
      [contractId, normaliseLimit(limit)],
    );
    return rows.map((r) => ({ topic: String(r['topic']), count: Number(r['count']) }));
  }

  async countByTopic(limit = 50): Promise<TopicCount[]> {
    const { rows } = await this.#pool.query(
      `SELECT topic0 AS topic, COUNT(*)::int AS count
       FROM events
       WHERE topic0 IS NOT NULL
       GROUP BY topic0
       ORDER BY count DESC, topic COLLATE "C" ASC
       LIMIT $1`,
      [normaliseLimit(limit)],
    );
    return rows.map((r) => ({ topic: String(r['topic']), count: Number(r['count']) }));
  }

  async getStats(): Promise<StoreStats> {
    const { rows } = await this.#pool.query(
      `SELECT COUNT(*)::int AS event_count,
              COUNT(DISTINCT contract_id)::int AS contract_count,
              MIN(ledger) AS min_ledger,
              MAX(ledger) AS max_ledger
       FROM events`,
    );
    const version = await this.#pool.query('SELECT COALESCE(MAX(version), 0)::int AS v FROM schema_migrations');
    const size = await this.#pool.query('SELECT pg_database_size(current_database())::text AS bytes');
    const row: Record<string, unknown> = rows[0] ?? {};
    const nullable = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

    return {
      eventCount: Number(row['event_count'] ?? 0),
      contractCount: Number(row['contract_count'] ?? 0),
      minLedger: nullable(row['min_ledger']),
      maxLedger: nullable(row['max_ledger']),
      schemaVersion: Number(version.rows[0]?.['v'] ?? 0),
      // The whole database, not just this schema: Postgres has no cheaper figure.
      sizeBytes: nullable(size.rows[0]?.['bytes']),
      // Postgres' WAL is cluster-wide and managed by the server, not a file beside the data.
      walSizeBytes: null,
    };
  }

  // ---------------------------------------------------------------------------
  // contract specs and stream state
  // ---------------------------------------------------------------------------

  async saveContractSpec(record: ContractSpecRecord): Promise<void> {
    await this.#pool.query(
      `INSERT INTO contract_specs (contract_id, source, wasm_hash, entries_xdr, event_count, error, fetched_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (contract_id) DO UPDATE SET source = EXCLUDED.source,
                                               wasm_hash = EXCLUDED.wasm_hash,
                                               entries_xdr = EXCLUDED.entries_xdr,
                                               event_count = EXCLUDED.event_count,
                                               error = EXCLUDED.error,
                                               fetched_at = EXCLUDED.fetched_at`,
      [
        record.contractId,
        record.source,
        record.wasmHash ?? null,
        JSON.stringify(record.entriesXdr),
        record.eventCount,
        record.error ?? null,
        record.fetchedAt,
      ],
    );
  }

  async getContractSpec(contractId: string): Promise<ContractSpecRecord | null> {
    const { rows } = await this.#pool.query('SELECT * FROM contract_specs WHERE contract_id = $1', [contractId]);
    const row = rows[0];
    return row ? { ...specSummary(row), entriesXdr: JSON.parse(String(row['entries_xdr'])) as string[] } : null;
  }

  async listContractSpecs(): Promise<Omit<ContractSpecRecord, 'entriesXdr'>[]> {
    const { rows } = await this.#pool.query(
      `SELECT contract_id, source, wasm_hash, event_count, error, fetched_at
       FROM contract_specs ORDER BY contract_id COLLATE "C"`,
    );
    return rows.map(specSummary);
  }

  async saveStreamState(state: StreamState): Promise<void> {
    await this.#pool.query(
      `INSERT INTO stream_state (key, cursor, ledger, updated_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO UPDATE SET cursor = EXCLUDED.cursor,
                                       ledger = EXCLUDED.ledger,
                                       updated_at = EXCLUDED.updated_at`,
      [state.key, state.cursor, state.ledger, state.updatedAt],
    );
  }

  async loadStreamState(key: string): Promise<StreamState | null> {
    const { rows } = await this.#pool.query('SELECT * FROM stream_state WHERE key = $1', [key]);
    return rows[0] ? streamState(rows[0]) : null;
  }

  async listStreamStates(): Promise<StreamState[]> {
    const { rows } = await this.#pool.query('SELECT * FROM stream_state ORDER BY key COLLATE "C"');
    return rows.map(streamState);
  }

  // ---------------------------------------------------------------------------
  // health and maintenance
  // ---------------------------------------------------------------------------

  /** Read-only, safe on every `/health` request. */
  async healthCheck(): Promise<{ ok: boolean; detail: string }> {
    try {
      const { schemaVersion, eventCount } = await this.getStats();
      return {
        ok: schemaVersion === LATEST_SCHEMA_VERSION,
        detail:
          schemaVersion === LATEST_SCHEMA_VERSION
            ? `schema v${schemaVersion}, ${eventCount} event(s)`
            : `schema is v${schemaVersion}, expected v${LATEST_SCHEMA_VERSION} — run migrate()`,
      };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Proves the database accepts writes by writing a temporary table inside a
   * transaction that is always rolled back — a read-only replica or a revoked
   * privilege fails here rather than in the indexer.
   */
  async writeProbe(): Promise<{ ok: boolean; detail: string }> {
    try {
      const client = await this.#pool.connect();
      try {
        await client.query('BEGIN');
        try {
          await client.query('CREATE TEMP TABLE _lens_write_probe (id INTEGER PRIMARY KEY)');
          await client.query('INSERT INTO _lens_write_probe (id) VALUES (1)');
        } finally {
          await client.query('ROLLBACK');
        }
      } finally {
        client.release();
      }
      const health = await this.healthCheck();
      return { ok: health.ok, detail: `writable, ${health.detail}` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async pruneBefore(ledger: number): Promise<number> {
    // No VACUUM: autovacuum reclaims the space, and a manual one would block
    // other writers for no benefit. event_addresses rows go via ON DELETE CASCADE.
    const result = await this.#pool.query('DELETE FROM events WHERE ledger < $1', [ledger]);
    return result.rowCount ?? 0;
  }

  /**
   * Prune the oldest ledgers in chunks until `sizeBytes + walSizeBytes` fits
   * under `maxSizeBytes`, then checkpoint. Returns the number of rows removed.
   * A no-op when no size target is configured.
   */
  async pruneToSize(maxSizeBytes = this.#maxSizeBytes): Promise<number> {
    if (maxSizeBytes === undefined) return 0;
    const CHUNK = 1000;
    let removed = 0;
    for (;;) {
      const stats = await this.getStats();
      const size = (stats.sizeBytes ?? 0) + (stats.walSizeBytes ?? 0);
      if (size <= maxSizeBytes) break;
      const { rows } = await this.#pool.query(
        'SELECT ledger FROM events ORDER BY ledger ASC LIMIT 1',
      );
      const oldest = rows[0]?.['ledger'];
      if (oldest === null || oldest === undefined) break;
      const nextRow = await this.#pool.query(
        'SELECT ledger FROM events WHERE ledger > $1 ORDER BY ledger ASC LIMIT 1',
        [Number(oldest)],
      );
      const next = nextRow.rows[0]?.['ledger'];
      const upper = next === null || next === undefined ? Number(oldest) + 1 : Number(next);
      const result = await this.#pool.query(
        'DELETE FROM events WHERE id IN (SELECT id FROM events WHERE ledger < $1 ORDER BY ledger ASC, id ASC LIMIT $2)',
        [upper, CHUNK],
      );
      const deleted = result.rowCount ?? 0;
      removed += deleted;
      this.#log.info(
        'prune_by_size',
        `pruned ${deleted} event(s) below ledger ${upper} to fit ${maxSizeBytes} bytes`,
        { removed: deleted, ledger: upper, sizeBytes: size, maxSizeBytes },
      );
      if (deleted === 0) break;
    }
    if (removed > 0) await this.checkpoint();
    return removed;
  }

  async redecode(all = false): Promise<number> {
    const rows = await this.#rawRows(all ? '' : 'WHERE decode_error IS NOT NULL');
    if (rows.length === 0) return 0;

    await this.#tx(async (db) => {
      for (const row of rows) await this.#rewrite(db, row);
    });
    return rows.length;
  }

  async repairRow(id: string): Promise<void> {
    const rows = await this.#rawRows('WHERE id = $1', [id]);
    if (rows.length === 0) return;
    await this.#tx((db) => this.#rewrite(db, rows[0]!));
  }

  async #rawRows(whereClause: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    const { rows } = await this.#pool.query(
      `SELECT id, contract_id, type, ledger, ledger_closed_at, tx_hash,
              transaction_index, operation_index, in_successful_call,
              topics_xdr_json, value_xdr, indexed_at
       FROM events
       ${whereClause}`,
      params,
    );
    return rows;
  }

  /** Re-decode one row from its raw XDR and rewrite its derived columns and address index. */
  async #rewrite(db: PgQueryable, row: Record<string, unknown>): Promise<void> {
    const raw: RawEventInput = {
      id: String(row['id']),
      contractId: String(row['contract_id']),
      type: row['type'] as 'contract' | 'system',
      ledger: Number(row['ledger']),
      ledgerClosedAt: String(row['ledger_closed_at']),
      txHash: String(row['tx_hash']),
      transactionIndex: Number(row['transaction_index']),
      operationIndex: Number(row['operation_index']),
      inSuccessfulContractCall: row['in_successful_call'] === true,
      topic: JSON.parse(String(row['topics_xdr_json'])) as string[],
      value: String(row['value_xdr']),
    };
    // indexedAt is left as stored: it records first ingestion, not repair.
    const event = decodeEvent(raw, new Date(String(row['indexed_at'])));
    await db.query(
      `UPDATE events SET
         topics_json = $1::jsonb, topics_xdr_json = $2, topic_count = $3,
         topic0 = $4, topic1 = $5, topic2 = $6, topic3 = $7,
         value_type = $8, value_json = $9::jsonb, value_xdr = $10, decode_error = $11
       WHERE id = $12`,
      [
        JSON.stringify(event.topics),
        JSON.stringify(event.topicsXdr),
        event.topics.length,
        topicKey(event.topics[0]),
        topicKey(event.topics[1]),
        topicKey(event.topics[2]),
        topicKey(event.topics[3]),
        event.value.type,
        JSON.stringify(event.value),
        event.valueXdr,
        event.decodeError ?? null,
        raw.id,
      ],
    );
    await db.query('DELETE FROM event_addresses WHERE event_id = $1', [raw.id]);
    await this.#insertAddresses(db, raw.id, event);
  }

  async checkIntegrity(): Promise<{ id: string; problems: string[] }[]> {
    const { rows } = await this.#pool.query(
      `SELECT id, topics_json, topics_xdr_json, value_json, topic_count,
              topic0, topic1, topic2, topic3
       FROM events`,
    );

    const results: { id: string; problems: string[] }[] = [];
    for (const row of rows) {
      const problems: string[] = [];
      // JSONB guarantees the columns parse; what is left to check is their shape.
      const topics = parseJson(row['topics_json']) as DecodedValue[] | undefined;
      if (!Array.isArray(topics)) problems.push('topics_json is not a JSON array');
      try {
        JSON.parse(String(row['topics_xdr_json']));
      } catch {
        problems.push('topics_xdr_json is not valid JSON');
      }
      if (parseJson(row['value_json']) === undefined) problems.push('value_json is not valid JSON');

      if (Array.isArray(topics)) {
        const count = Number(row['topic_count']);
        if (topics.length !== count) {
          problems.push(`topic_count (${count}) does not match topics_json length (${topics.length})`);
        }
        [0, 1, 2, 3].forEach((i) => {
          const expected = topicKey(topics[i]);
          const actual = (row[`topic${i}`] as string | null) ?? null;
          if (expected !== actual) problems.push(`topic${i} is "${actual}", expected "${expected}" from topics_json`);
        });
      }
      if (problems.length > 0) results.push({ id: String(row['id']), problems });
    }
    return results;
  }

  /**
   * Rebuilds the trigram indexes that back `search`. Unlike SQLite's separate
   * FTS table these are ordinary indexes kept in sync by Postgres itself, so
   * this is only for recovery; it is a no-op when the optional migration was skipped.
   */
  async rebuildSearchIndex(): Promise<void> {
    const { rows } = await this.#pool.query(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = current_schema() AND indexname IN ('idx_events_topics_trgm', 'idx_events_value_trgm')`,
    );
    for (const row of rows) await this.#pool.query(`REINDEX INDEX "${String(row['indexname'])}"`);
  }

  /** No-op: there is no per-database WAL file to checkpoint; the server manages it. */
  async checkpoint(): Promise<void> {}

  // ---------------------------------------------------------------------------
  // snapshots
  // ---------------------------------------------------------------------------

  async exportSnapshot(destPath: string): Promise<number> {
    const BATCH = 1000;
    const client = await this.#pool.connect();
    const out = createWriteStream(destPath, { encoding: 'utf8' });
    let written = 0;
    try {
      // REPEATABLE READ gives one point-in-time view across every batch, even
      // while the indexer keeps writing — the Postgres counterpart of VACUUM INTO.
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      let after = '';
      for (;;) {
        const { rows } = await client.query(
          'SELECT * FROM events WHERE id > $1 ORDER BY id ASC LIMIT $2',
          [after, BATCH],
        );
        if (rows.length === 0) break;
        for (const row of rows) {
          if (!out.write(`${JSON.stringify(rowToEvent(row))}\n`)) await once(out, 'drain');
          written++;
        }
        after = String(rows.at(-1)!['id']);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
      await new Promise<void>((resolve, reject) => {
        out.end((error: unknown) => (error ? reject(error) : resolve()));
      });
    }
    return written;
  }

  async importSnapshot(srcPath: string): Promise<number> {
    const lines = createInterface({ input: createReadStream(srcPath, { encoding: 'utf8' }) });
    const BATCH_SIZE = 500;
    let batch: LensEvent[] = [];
    let inserted = 0;

    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      inserted += await this.insertDecoded(batch);
      batch = [];
    };

    for await (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '') continue; // NDJSON: a blank line is not a record
      batch.push(JSON.parse(trimmed) as LensEvent);
      if (batch.length >= BATCH_SIZE) await flush();
    }
    await flush();
    return inserted;
  }

  async close(): Promise<void> {
    if (this.#ownsPool) await this.#pool.end();
  }
}

// ---------------------------------------------------------------------------
// row mapping
// ---------------------------------------------------------------------------

const INSERT_EVENT = `
  INSERT INTO events (
    id, contract_id, type, ledger, ledger_closed_at, closed_at_unix,
    tx_hash, transaction_index, operation_index, in_successful_call,
    topics_json, topics_xdr_json, topic_count, topic0, topic1, topic2, topic3,
    value_type, value_json, value_xdr, decode_error, indexed_at
  ) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
    $11::jsonb, $12, $13, $14, $15, $16, $17,
    $18, $19::jsonb, $20, $21, $22
  )
  ON CONFLICT (id) DO NOTHING
`;

function insertParams(e: LensEvent): unknown[] {
  const closedAtUnix = Math.floor(new Date(e.ledgerClosedAt).getTime() / 1000);
  return [
    e.id,
    e.contractId,
    e.type,
    e.ledger,
    e.ledgerClosedAt,
    Number.isFinite(closedAtUnix) ? closedAtUnix : 0,
    e.txHash,
    e.transactionIndex,
    e.operationIndex,
    e.inSuccessfulContractCall,
    JSON.stringify(e.topics),
    JSON.stringify(e.topicsXdr),
    e.topics.length,
    topicKey(e.topics[0]),
    topicKey(e.topics[1]),
    topicKey(e.topics[2]),
    topicKey(e.topics[3]),
    e.value.type,
    JSON.stringify(e.value),
    e.valueXdr,
    e.decodeError ?? null,
    e.indexedAt,
  ];
}

/** `pg` parses JSONB itself; accept a string too, for a pool configured not to. */
function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function rowToEvent(row: Record<string, unknown>): LensEvent {
  return {
    id: String(row['id']),
    contractId: String(row['contract_id']),
    type: row['type'] as 'contract' | 'system',
    ledger: Number(row['ledger']),
    ledgerClosedAt: String(row['ledger_closed_at']),
    txHash: String(row['tx_hash']),
    transactionIndex: Number(row['transaction_index']),
    operationIndex: Number(row['operation_index']),
    inSuccessfulContractCall: row['in_successful_call'] === true,
    topics: parseJson(row['topics_json']) as DecodedValue[],
    topicsXdr: JSON.parse(String(row['topics_xdr_json'])) as string[],
    value: parseJson(row['value_json']) as DecodedValue,
    valueXdr: String(row['value_xdr']),
    decodeError: (row['decode_error'] as string | null) ?? undefined,
    indexedAt: String(row['indexed_at']),
  };
}

function specSummary(row: Record<string, unknown>): Omit<ContractSpecRecord, 'entriesXdr'> {
  const wasmHash = row['wasm_hash'] as string | null;
  const error = row['error'] as string | null;
  return {
    contractId: String(row['contract_id']),
    source: row['source'] as ContractSpecRecord['source'],
    ...(wasmHash !== null && wasmHash !== undefined ? { wasmHash } : {}),
    eventCount: Number(row['event_count']),
    ...(error !== null && error !== undefined ? { error } : {}),
    fetchedAt: String(row['fetched_at']),
  };
}

function streamState(row: Record<string, unknown>): StreamState {
  return {
    key: String(row['key']),
    cursor: String(row['cursor']),
    ledger: Number(row['ledger']),
    updatedAt: String(row['updated_at']),
  };
}

/** Build the WHERE clause for a query, with `$n` placeholders. All conditions are ANDed. */
function buildWhere(query: EventQuery): { clause: string; values: unknown[] } {
  const conditions: string[] = [];
  const values: unknown[] = [];
  const param = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };

  if (query.contractId) conditions.push(`contract_id = ${param(query.contractId)}`);
  if (query.txHash) conditions.push(`tx_hash = ${param(query.txHash)}`);
  if (query.search) {
    // A substring match over the stored JSON text, case-insensitive like the
    // SQLite trigram index; LIKE metacharacters in the input are escaped so they
    // match literally.
    const p = param(`%${likeEscape(query.search)}%`);
    conditions.push(`(topics_json::text ILIKE ${p} OR value_json::text ILIKE ${p})`);
  }
  if (query.address) {
    // IN (subquery), as in the SQLite store: a JOIN would multiply an event that
    // mentions the address at several positions before LIMIT sees it.
    conditions.push(`id IN (SELECT event_id FROM event_addresses WHERE address = ${param(query.address)})`);
  }
  // Compared against undefined, not truthiness: index 0 is a real, common value.
  if (query.transactionIndex !== undefined) conditions.push(`transaction_index = ${param(query.transactionIndex)}`);
  if (query.operationIndex !== undefined) conditions.push(`operation_index = ${param(query.operationIndex)}`);
  if (query.fromLedger !== undefined) conditions.push(`ledger >= ${param(query.fromLedger)}`);
  if (query.toLedger !== undefined) conditions.push(`ledger <= ${param(query.toLedger)}`);
  if (query.fromTime !== undefined) conditions.push(`closed_at_unix >= ${param(query.fromTime)}`);
  if (query.toTime !== undefined) conditions.push(`closed_at_unix <= ${param(query.toTime)}`);
  if (query.successfulOnly === true) conditions.push('in_successful_call = TRUE');

  const columns = ['topic0', 'topic1', 'topic2', 'topic3'] as const;
  query.topics?.forEach((topic, i) => {
    if (topic === null || topic === undefined) return;
    const column = columns[i];
    if (!column) return;
    conditions.push(`${column} = ${param(topic)}`);
  });

  return { clause: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '', values };
}

function likeEscape(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}
