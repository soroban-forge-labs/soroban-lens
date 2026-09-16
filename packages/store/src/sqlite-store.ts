import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { decodeEvent, topicKey } from './decode.js';
import type { Logger } from './logger.js';
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from './schema.js';
import { normaliseLimit, type EventStore } from './store.js';
import type {
  ContractSummary,
  DecodedValue,
  EventPage,
  EventQuery,
  LensEvent,
  RawEventInput,
  StoreStats,
  StreamState,
  TopicCount,
} from './types.js';

export interface SqliteStoreOptions {
  /** File path, or ':memory:' for an ephemeral database. */
  path: string;
  /** Run migrations on construction. Defaults to true. */
  migrateOnOpen?: boolean;
  /**
   * Structured logger for migration events — the store and the API share the
   * same `Logger` shape from ./logger.js. Defaults to a no-op, so passing
   * nothing keeps a library consumer's stderr silent, exactly as before this
   * existed.
   */
  log?: Logger;
  /**
   * How long a filtered COUNT(*) result is reused before being recomputed, in
   * milliseconds. `total` on a page served from cache carries
   * `totalIsEstimate: true`. COUNT(*) with a WHERE clause is a full scan of
   * the matching rows — on a busy filter under repeated polling it dominates
   * response time for a number most UIs render as "about N", not read to the
   * row. 0 disables caching, for anything that genuinely needs an exact,
   * instant count on every call. Defaults to 2000ms.
   */
  countCacheTtlMs?: number;
  /** Clock for the count cache's TTL, swappable in tests. Defaults to Date.now. */
  now?: () => number;
}

const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * SQLite-backed `EventStore`, on Node's built-in `node:sqlite`.
 *
 * Built-in rather than `better-sqlite3` on purpose: no native compilation step,
 * so `npm install` works identically on a laptop, in CI, and in an Alpine
 * container. That is what makes the "zero setup" promise in the README true.
 */
export class SqliteEventStore implements EventStore {
  readonly #db: DatabaseSync;
  readonly #path: string;
  readonly #log: Logger;
  readonly #countCacheTtlMs: number;
  readonly #now: () => number;
  readonly #countCache = new Map<string, { total: number; expiresAt: number }>();
  #statements: Statements | null = null;

  constructor(options: SqliteStoreOptions) {
    this.#path = options.path;
    this.#log = options.log ?? noopLogger;
    this.#countCacheTtlMs = options.countCacheTtlMs ?? 2000;
    this.#now = options.now ?? Date.now;
    if (options.path !== ':memory:') mkdirSync(dirname(options.path), { recursive: true });
    this.#db = new DatabaseSync(options.path);

    // WAL lets the API read while the indexer writes, which is the whole point
    // of running both against one file. NORMAL trades an fsync per commit for
    // throughput; on a crash the worst case is replaying the last batch, which
    // is already the delivery guarantee we have from Module 1.
    if (options.path !== ':memory:') this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA synchronous = NORMAL');
    this.#db.exec('PRAGMA foreign_keys = ON');
    // Wait rather than fail when the indexer holds the write lock.
    this.#db.exec('PRAGMA busy_timeout = 5000');

    if (options.migrateOnOpen !== false) this.#migrateSync();
  }

  get path(): string {
    return this.#path;
  }

  async migrate(): Promise<void> {
    this.#migrateSync();
  }

  async migrateDown(toVersion: number): Promise<number[]> {
    const applied = (
      this.#db.prepare('SELECT version, name FROM schema_migrations ORDER BY version DESC').all() as {
        version: number;
        name: string;
      }[]
    ).filter((m) => m.version > toVersion);

    if (applied.length === 0) return [];

    // Refuse the whole batch up front if any step lacks a `down` — an
    // all-or-nothing check, so a database never ends up part-way through a
    // rollback it cannot finish, wondering which half of its schema it has.
    const byVersion = new Map(MIGRATIONS.map((m) => [m.version, m]));
    const missing = applied.filter((m) => !byVersion.get(m.version)?.down);
    if (missing.length > 0) {
      throw new Error(
        `cannot roll back: migration ${missing[0]!.version} (${missing[0]!.name}) has no down SQL. ` +
          `Nothing was rolled back.`,
      );
    }

    this.#db.exec('BEGIN');
    try {
      for (const { version } of applied) {
        const migration = byVersion.get(version)!;
        this.#db.exec(migration.down!);
        this.#db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(version);
        this.#log.info('migration_rolled_back', `rolled back migration ${version}: ${migration.name}`, {
          version,
          name: migration.name,
        });
      }
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }

    this.#statements = null;
    return applied.map((m) => m.version);
  }

  #migrateSync(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    INTEGER PRIMARY KEY,
        name       TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    const applied = new Set(
      (this.#db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map(
        (r) => r.version,
      ),
    );
    const pending = MIGRATIONS.filter((m) => !applied.has(m.version)).sort(
      (a, b) => a.version - b.version,
    );
    if (pending.length === 0) return;

    this.#db.exec('BEGIN');
    try {
      for (const migration of pending) {
        this.#db.exec(migration.up);
        this.#db
          .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(migration.version, migration.name, new Date().toISOString());
        this.#log.info(
          'migration_applied',
          `applied migration ${migration.version}: ${migration.name}`,
          { version: migration.version, name: migration.name },
        );
      }
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
    this.#statements = null;
  }

  #prepared(): Statements {
    this.#statements ??= buildStatements(this.#db);
    return this.#statements;
  }

  async insertEvents(events: RawEventInput[]): Promise<number> {
    return this.insertDecoded(events.map((e) => decodeEvent(e)));
  }

  async insertDecoded(events: LensEvent[]): Promise<number> {
    if (events.length === 0) return 0;
    const stmt = this.#prepared().insert;

    // One transaction per batch: an interrupted batch leaves no partial page,
    // and Module 1 replays it on restart.
    this.#db.exec('BEGIN');
    try {
      let inserted = 0;
      for (const e of events) {
        const result = stmt.run(...insertParams(e));
        inserted += Number(result.changes ?? 0);
      }
      this.#db.exec('COMMIT');
      return inserted;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  async getEvent(id: string): Promise<LensEvent | null> {
    const row = this.#prepared().byId.get(id) as unknown as EventRow | undefined;
    return row ? rowToEvent(row) : null;
  }

  async queryEvents(query: EventQuery): Promise<EventPage> {
    const limit = normaliseLimit(query.limit);
    const order = query.order === 'asc' ? 'ASC' : 'DESC';
    const where = buildWhere(query);
    const { total, isEstimate } = this.#countCached(where);

    // Keyset pagination. The cursor is an event id; because ids are fixed-width
    // and sort chronologically, a plain string comparison is the whole
    // implementation, and inserts behind the cursor cannot shift a page.
    const keyset = query.cursor
      ? `${where.clause ? 'AND' : 'WHERE'} id ${order === 'DESC' ? '<' : '>'} ?`
      : '';
    const rows = this.#db
      .prepare(
        `SELECT * FROM events ${where.clause} ${keyset} ORDER BY id ${order} LIMIT ?`,
      )
      .all(...where.values, ...(query.cursor ? [query.cursor] : []), limit + 1) as unknown as EventRow[];

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return {
      events: page.map(rowToEvent),
      nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
      total,
      ...(isEstimate ? { totalIsEstimate: true as const } : {}),
    };
  }

  /**
   * Cache key is the WHERE clause text plus its bound values — order, limit
   * and cursor never affect a count, so they are deliberately excluded and
   * two pages of the same filter share one cache entry.
   */
  #countCached(where: { clause: string; values: SqlParam[] }): { total: number; isEstimate: boolean } {
    const key = `${where.clause}\u0000${JSON.stringify(where.values)}`;
    if (this.#countCacheTtlMs > 0) {
      const cached = this.#countCache.get(key);
      if (cached && cached.expiresAt > this.#now()) {
        return { total: cached.total, isEstimate: true };
      }
    }

    const row = this.#db
      .prepare(`SELECT COUNT(*) AS n FROM events ${where.clause}`)
      .get(...where.values) as { n: number };

    if (this.#countCacheTtlMs > 0) {
      this.#countCache.set(key, { total: row.n, expiresAt: this.#now() + this.#countCacheTtlMs });
    }
    return { total: row.n, isEstimate: false };
  }

  async listContracts(limit = 100): Promise<ContractSummary[]> {
    const rows = this.#db
      .prepare(
        `SELECT contract_id,
                COUNT(*)        AS event_count,
                MIN(ledger)     AS first_ledger,
                MAX(ledger)     AS last_ledger,
                MAX(ledger_closed_at) AS last_seen_at
         FROM events
         GROUP BY contract_id
         ORDER BY last_ledger DESC
         LIMIT ?`,
      )
      .all(normaliseLimit(limit)) as {
      contract_id: string;
      event_count: number;
      first_ledger: number;
      last_ledger: number;
      last_seen_at: string;
    }[];

    return rows.map((r) => ({
      contractId: r.contract_id,
      eventCount: r.event_count,
      firstLedger: r.first_ledger,
      lastLedger: r.last_ledger,
      lastSeenAt: r.last_seen_at,
    }));
  }

  async listTopics(contractId: string, limit = 50): Promise<{ topic: string; count: number }[]> {
    const rows = this.#db
      .prepare(
        `SELECT topic0 AS topic, COUNT(*) AS count
         FROM events
         WHERE contract_id = ? AND topic0 IS NOT NULL
         GROUP BY topic0
         ORDER BY count DESC
         LIMIT ?`,
      )
      .all(contractId, normaliseLimit(limit)) as { topic: string; count: number }[];
    return rows.map((r) => ({ topic: r.topic, count: r.count }));
  }

  async countByTopic(limit = 50): Promise<TopicCount[]> {
    const rows = this.#db
      .prepare(
        `SELECT topic0 AS topic, COUNT(*) AS count
         FROM events
         WHERE topic0 IS NOT NULL
         GROUP BY topic0
         ORDER BY count DESC, topic ASC
         LIMIT ?`,
      )
      .all(normaliseLimit(limit)) as { topic: string; count: number }[];
    return rows.map((r) => ({ topic: r.topic, count: r.count }));
  }

  /**
   * Bytes on disk for the database and its write-ahead log.
   *
   * Read from the filesystem rather than `page_count * page_size`, because the
   * issue's bar is "matches du", and SQLite's own page maths excludes the WAL
   * and any free pages the file still occupies.
   */
  #sizes(): { sizeBytes: number | null; walSizeBytes: number | null } {
    if (this.#path === ':memory:') return { sizeBytes: null, walSizeBytes: null };
    return { sizeBytes: fileSize(this.#path), walSizeBytes: fileSize(`${this.#path}-wal`) };
  }

  async getStats(): Promise<StoreStats> {
    const row = this.#db
      .prepare(
        `SELECT COUNT(*) AS event_count,
                COUNT(DISTINCT contract_id) AS contract_count,
                MIN(ledger) AS min_ledger,
                MAX(ledger) AS max_ledger
         FROM events`,
      )
      .get() as {
      event_count: number;
      contract_count: number;
      min_ledger: number | null;
      max_ledger: number | null;
    };
    const version = this.#db
      .prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations')
      .get() as { v: number };

    return {
      eventCount: row.event_count,
      contractCount: row.contract_count,
      minLedger: row.min_ledger,
      maxLedger: row.max_ledger,
      schemaVersion: version.v,
      ...this.#sizes(),
    };
  }

  async saveStreamState(state: StreamState): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO stream_state (key, cursor, ledger, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET cursor = excluded.cursor,
                                        ledger = excluded.ledger,
                                        updated_at = excluded.updated_at`,
      )
      .run(state.key, state.cursor, state.ledger, state.updatedAt);
  }

  async loadStreamState(key: string): Promise<StreamState | null> {
    const row = this.#db.prepare('SELECT * FROM stream_state WHERE key = ?').get(key) as
      | { key: string; cursor: string; ledger: number; updated_at: string }
      | undefined;
    return row ? { key: row.key, cursor: row.cursor, ledger: row.ledger, updatedAt: row.updated_at } : null;
  }

  async listStreamStates(): Promise<StreamState[]> {
    const rows = this.#db
      .prepare('SELECT * FROM stream_state ORDER BY key')
      .all() as { key: string; cursor: string; ledger: number; updated_at: string }[];
    return rows.map((r) => ({ key: r.key, cursor: r.cursor, ledger: r.ledger, updatedAt: r.updated_at }));
  }

  /** Read-only. Serves the API's `/health`, so it must not take the write lock. */
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
   * Writes, to prove the database is writable — a read-only mount or a full
   * disk only shows up on write. Preflight only; `lens doctor` calls this.
   *
   * The probe writes inside a transaction it always rolls back, so it takes the
   * write lock briefly but leaves no trace in the file and never runs DDL that
   * a concurrent reader could observe half-applied.
   */
  async writeProbe(): Promise<{ ok: boolean; detail: string }> {
    try {
      this.#db.exec('BEGIN IMMEDIATE');
      try {
        this.#db.exec('CREATE TABLE _lens_write_probe (id INTEGER PRIMARY KEY)');
        this.#db.exec('INSERT INTO _lens_write_probe (id) VALUES (1)');
      } finally {
        this.#db.exec('ROLLBACK');
      }
      const health = await this.healthCheck();
      return { ok: health.ok, detail: `writable, ${health.detail}` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async pruneBefore(ledger: number): Promise<number> {
    // A separate count-then-delete rather than reading `changes` off the
    // DELETE: `changes` after a DELETE is exact too, but a second statement
    // that only counts what will go lets us log or reject a huge prune before
    // it happens if we ever want to; today it just returns the number.
    const before = (this.#db.prepare('SELECT COUNT(*) AS n FROM events WHERE ledger < ?').get(ledger) as {
      n: number;
    }).n;
    if (before === 0) return 0;

    this.#db.exec('BEGIN');
    try {
      this.#db.prepare('DELETE FROM events WHERE ledger < ?').run(ledger);
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }

    // VACUUM cannot run inside a transaction and reclaims the space the
    // deleted rows held — without it the file never shrinks, which defeats
    // the entire point of pruning for disk usage. It takes an exclusive lock
    // and rewrites the whole file, so it is deliberately synchronous with the
    // delete rather than deferred: a caller running `lens prune` wants the
    // file smaller when the command returns, not eventually.
    //
    // In WAL mode VACUUM writes its result through the WAL rather than
    // truncating the main file directly — the file on disk does not actually
    // shrink until a checkpoint flushes and truncates that WAL, so both run
    // together here.
    if (this.#path !== ':memory:') {
      this.#db.exec('VACUUM');
      this.#db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    }

    return before;
  }

  async redecode(all = false): Promise<number> {
    const rows = this.#rawRows(all ? '' : 'WHERE decode_error IS NOT NULL');
    if (rows.length === 0) return 0;

    const update = this.#recomputeStatement();
    this.#db.exec('BEGIN');
    try {
      for (const row of rows) update.run(...this.#recomputeParams(row));
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }

    return rows.length;
  }

  async checkIntegrity(): Promise<{ id: string; problems: string[] }[]> {
    const rows = this.#db
      .prepare(
        `SELECT id, topics_json, topics_xdr_json, value_json, topic_count,
                topic0, topic1, topic2, topic3
         FROM events`,
      )
      .all() as {
      id: string;
      topics_json: string;
      topics_xdr_json: string;
      value_json: string;
      topic_count: number;
      topic0: string | null;
      topic1: string | null;
      topic2: string | null;
      topic3: string | null;
    }[];

    const results: { id: string; problems: string[] }[] = [];
    for (const row of rows) {
      const problems: string[] = [];

      let topics: DecodedValue[] | undefined;
      try {
        topics = JSON.parse(row.topics_json) as DecodedValue[];
        if (!Array.isArray(topics)) problems.push('topics_json is not a JSON array');
      } catch {
        problems.push('topics_json is not valid JSON');
      }
      try {
        JSON.parse(row.topics_xdr_json);
      } catch {
        problems.push('topics_xdr_json is not valid JSON');
      }
      try {
        JSON.parse(row.value_json);
      } catch {
        problems.push('value_json is not valid JSON');
      }

      if (topics && Array.isArray(topics)) {
        if (topics.length !== row.topic_count) {
          problems.push(`topic_count (${row.topic_count}) does not match topics_json length (${topics.length})`);
        }
        const expected = [topicKey(topics[0]), topicKey(topics[1]), topicKey(topics[2]), topicKey(topics[3])];
        const actual = [row.topic0, row.topic1, row.topic2, row.topic3];
        expected.forEach((exp, i) => {
          if (exp !== actual[i]) {
            problems.push(`topic${i} is "${actual[i]}", expected "${exp}" from topics_json`);
          }
        });
      }

      if (problems.length > 0) results.push({ id: row.id, problems });
    }
    return results;
  }

  async repairRow(id: string): Promise<void> {
    const rows = this.#rawRows('WHERE id = ?', [id]);
    if (rows.length === 0) return;
    this.#recomputeStatement().run(...this.#recomputeParams(rows[0]!));
  }

  /** Shared shape read by both redecode() and repairRow() to recompute derived columns. */
  #rawRows(whereClause: string, params: SqlParam[] = []): RawRow[] {
    return this.#db
      .prepare(
        `SELECT id, contract_id, type, ledger, ledger_closed_at, tx_hash,
                transaction_index, operation_index, in_successful_call,
                topics_xdr_json, value_xdr, indexed_at
         FROM events
         ${whereClause}`,
      )
      .all(...params) as unknown as RawRow[];
  }

  #recomputeStatement(): StatementSync {
    return this.#db.prepare(`
      UPDATE events SET
        topics_json = ?, topics_xdr_json = ?, topic_count = ?,
        topic0 = ?, topic1 = ?, topic2 = ?, topic3 = ?,
        value_type = ?, value_json = ?, value_xdr = ?, decode_error = ?
      WHERE id = ?
    `);
  }

  #recomputeParams(row: RawRow): SqlParam[] {
    const raw: RawEventInput = {
      id: row.id,
      contractId: row.contract_id,
      type: row.type,
      ledger: row.ledger,
      ledgerClosedAt: row.ledger_closed_at,
      txHash: row.tx_hash,
      transactionIndex: row.transaction_index,
      operationIndex: row.operation_index,
      inSuccessfulContractCall: row.in_successful_call === 1,
      topic: JSON.parse(row.topics_xdr_json) as string[],
      value: row.value_xdr,
    };
    // Re-decode with the current decoder, from the raw XDR every row keeps for
    // exactly this — indexedAt is left untouched, since it records when the
    // event was first ingested, not when it was decoded or repaired.
    const redecoded = decodeEvent(raw, new Date(row.indexed_at));
    return [
      JSON.stringify(redecoded.topics),
      JSON.stringify(redecoded.topicsXdr),
      redecoded.topics.length,
      topicKey(redecoded.topics[0]),
      topicKey(redecoded.topics[1]),
      topicKey(redecoded.topics[2]),
      topicKey(redecoded.topics[3]),
      redecoded.value.type,
      JSON.stringify(redecoded.value),
      redecoded.valueXdr,
      redecoded.decodeError ?? null,
      row.id,
    ];
  }

  async close(): Promise<void> {
    this.#db.close();
  }
}

// ---------------------------------------------------------------------------
// row mapping
// ---------------------------------------------------------------------------

interface RawRow {
  id: string;
  contract_id: string;
  type: 'contract' | 'system';
  ledger: number;
  ledger_closed_at: string;
  tx_hash: string;
  transaction_index: number;
  operation_index: number;
  in_successful_call: number;
  topics_xdr_json: string;
  value_xdr: string;
  indexed_at: string;
}

interface EventRow {
  id: string;
  contract_id: string;
  type: 'contract' | 'system';
  ledger: number;
  ledger_closed_at: string;
  closed_at_unix: number;
  tx_hash: string;
  transaction_index: number;
  operation_index: number;
  in_successful_call: number;
  topics_json: string;
  topics_xdr_json: string;
  topic_count: number;
  topic0: string | null;
  topic1: string | null;
  topic2: string | null;
  topic3: string | null;
  value_type: string;
  value_json: string;
  value_xdr: string;
  decode_error: string | null;
  indexed_at: string;
}

interface Statements {
  insert: StatementSync;
  byId: StatementSync;
}

function buildStatements(db: DatabaseSync): Statements {
  return {
    // INSERT OR IGNORE gives idempotency on the event id, which is what makes
    // Module 1's at-least-once delivery safe to replay.
    insert: db.prepare(`
      INSERT OR IGNORE INTO events (
        id, contract_id, type, ledger, ledger_closed_at, closed_at_unix,
        tx_hash, transaction_index, operation_index, in_successful_call,
        topics_json, topics_xdr_json, topic_count, topic0, topic1, topic2, topic3,
        value_type, value_json, value_xdr, decode_error, indexed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    byId: db.prepare('SELECT * FROM events WHERE id = ?'),
  };
}

type SqlParam = string | number | null;

function insertParams(e: LensEvent): SqlParam[] {
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
    e.inSuccessfulContractCall ? 1 : 0,
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

function rowToEvent(row: EventRow): LensEvent {
  return {
    id: row.id,
    contractId: row.contract_id,
    type: row.type,
    ledger: row.ledger,
    ledgerClosedAt: row.ledger_closed_at,
    txHash: row.tx_hash,
    transactionIndex: row.transaction_index,
    operationIndex: row.operation_index,
    inSuccessfulContractCall: row.in_successful_call === 1,
    topics: JSON.parse(row.topics_json) as DecodedValue[],
    topicsXdr: JSON.parse(row.topics_xdr_json) as string[],
    value: JSON.parse(row.value_json) as DecodedValue,
    valueXdr: row.value_xdr,
    decodeError: row.decode_error ?? undefined,
    indexedAt: row.indexed_at,
  };
}

/** Build the WHERE clause for a query. All conditions are ANDed. */
function buildWhere(query: EventQuery): { clause: string; values: SqlParam[] } {
  const conditions: string[] = [];
  const values: SqlParam[] = [];

  if (query.contractId) {
    conditions.push('contract_id = ?');
    values.push(query.contractId);
  }
  if (query.txHash) {
    conditions.push('tx_hash = ?');
    values.push(query.txHash);
  }
  // Compared against undefined, not truthiness: index 0 is the first
  // transaction in a ledger and the first operation in a transaction, so it is
  // the single most likely value anyone filters on.
  if (query.transactionIndex !== undefined) {
    conditions.push('transaction_index = ?');
    values.push(query.transactionIndex);
  }
  if (query.operationIndex !== undefined) {
    conditions.push('operation_index = ?');
    values.push(query.operationIndex);
  }
  if (query.fromLedger !== undefined) {
    conditions.push('ledger >= ?');
    values.push(query.fromLedger);
  }
  if (query.toLedger !== undefined) {
    conditions.push('ledger <= ?');
    values.push(query.toLedger);
  }
  // Seconds since the epoch against the indexed integer column, rather than
  // lexicographic comparison on the ISO text — the column exists for this.
  if (query.fromTime !== undefined) {
    conditions.push('closed_at_unix >= ?');
    values.push(query.fromTime);
  }
  if (query.toTime !== undefined) {
    conditions.push('closed_at_unix <= ?');
    values.push(query.toTime);
  }
  if (query.successfulOnly === true) {
    conditions.push('in_successful_call = 1');
  }

  // Topic prefix match. `null` is a wildcard for that position; only the first
  // four positions are indexed, and positions beyond that are rejected by the
  // caller rather than silently ignored.
  const columns = ['topic0', 'topic1', 'topic2', 'topic3'] as const;
  query.topics?.forEach((topic, i) => {
    if (topic === null || topic === undefined) return;
    const column = columns[i];
    if (!column) return;
    conditions.push(`${column} = ?`);
    values.push(topic);
  });

  return {
    clause: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    values,
  };
}

/** Number of topic positions that can be filtered on. */
export const INDEXED_TOPIC_DEPTH = 4;

/**
 * Size of one file, or null when it does not exist.
 *
 * A missing `-wal` is the normal state for a database that has checkpointed or
 * was never opened in WAL mode, so it is absence rather than an error.
 */
function fileSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}
