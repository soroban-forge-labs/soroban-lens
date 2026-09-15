import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { decodeEvent, topicKey } from './decode.js';
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from './schema.js';
import { DEFAULT_QUERY_LIMIT, normaliseLimit, type EventStore } from './store.js';
import type {
  ContractSummary,
  DecodedValue,
  EventPage,
  EventQuery,
  LensEvent,
  RawEventInput,
  StoreStats,
  StreamState,
} from './types.js';

export interface SqliteStoreOptions {
  /** File path, or ':memory:' for an ephemeral database. */
  path: string;
  /** Run migrations on construction. Defaults to true. */
  migrateOnOpen?: boolean;
}

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
  #statements: Statements | null = null;

  constructor(options: SqliteStoreOptions) {
    this.#path = options.path;
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
    const { where, params } = buildWhere(query);

    const totalRow = this.#db
      .prepare(`SELECT COUNT(*) AS n FROM events ${where.clause}`)
      .get(...where.values) as { n: number };

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
    void params;

    return {
      events: page.map(rowToEvent),
      nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
      total: totalRow.n,
    };
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

  async healthCheck(): Promise<{ ok: boolean; detail: string }> {
    try {
      // A real write, not just a read: a read-only mount or a full disk only
      // shows up on write, which is exactly the failure `lens doctor` exists
      // to catch before the indexer starts.
      this.#db.exec('CREATE TABLE IF NOT EXISTS _lens_write_probe (id INTEGER PRIMARY KEY)');
      this.#db.exec('INSERT INTO _lens_write_probe (id) VALUES (1) ON CONFLICT DO NOTHING');
      this.#db.exec('DROP TABLE _lens_write_probe');
      const { schemaVersion, eventCount } = await this.getStats();
      return {
        ok: schemaVersion === LATEST_SCHEMA_VERSION,
        detail:
          schemaVersion === LATEST_SCHEMA_VERSION
            ? `writable, schema v${schemaVersion}, ${eventCount} event(s)`
            : `schema is v${schemaVersion}, expected v${LATEST_SCHEMA_VERSION} — run migrate()`,
      };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async close(): Promise<void> {
    this.#db.close();
  }
}

// ---------------------------------------------------------------------------
// row mapping
// ---------------------------------------------------------------------------

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
function buildWhere(query: EventQuery): {
  where: { clause: string; values: SqlParam[] };
  params: EventQuery;
} {
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
  if (query.fromLedger !== undefined) {
    conditions.push('ledger >= ?');
    values.push(query.fromLedger);
  }
  if (query.toLedger !== undefined) {
    conditions.push('ledger <= ?');
    values.push(query.toLedger);
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
    where: {
      clause: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
      values,
    },
    params: { ...query, limit: query.limit ?? DEFAULT_QUERY_LIMIT },
  };
}

/** Number of topic positions that can be filtered on. */
export const INDEXED_TOPIC_DEPTH = 4;
