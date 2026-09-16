/**
 * Schema migrations.
 *
 * Append-only: never edit a migration that has shipped, add a new one. The
 * runner records each applied version in `schema_migrations` and applies only
 * what is missing, inside a transaction.
 */
export interface Migration {
  version: number;
  name: string;
  up: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial-events-schema',
    up: `
      CREATE TABLE events (
        -- RPC event id. Fixed 30-char width, and lexicographic order equals
        -- (ledger, txIndex, opIndex) order, which is what makes keyset
        -- pagination on this column alone correct.
        id                   TEXT    PRIMARY KEY,
        contract_id          TEXT    NOT NULL,
        type                 TEXT    NOT NULL CHECK (type IN ('contract', 'system')),
        ledger               INTEGER NOT NULL,
        ledger_closed_at     TEXT    NOT NULL,
        closed_at_unix       INTEGER NOT NULL,
        tx_hash              TEXT    NOT NULL,
        transaction_index    INTEGER NOT NULL,
        operation_index      INTEGER NOT NULL,
        in_successful_call   INTEGER NOT NULL CHECK (in_successful_call IN (0, 1)),

        -- Full decoded topic list as a JSON array of {type, value}. Stored
        -- whole because events may carry more topics than a filter can name.
        topics_json          TEXT    NOT NULL,
        topics_xdr_json      TEXT    NOT NULL,
        topic_count          INTEGER NOT NULL,

        -- Scalar projections of the first four topics, for indexed filtering.
        -- NULL where the topic is a map/vec, or simply absent.
        topic0               TEXT,
        topic1               TEXT,
        topic2               TEXT,
        topic3               TEXT,

        value_type           TEXT    NOT NULL,
        value_json           TEXT    NOT NULL,
        value_xdr            TEXT    NOT NULL,

        decode_error         TEXT,
        indexed_at           TEXT    NOT NULL
      );

      -- The API's main access path: one contract, newest first.
      CREATE INDEX idx_events_contract_id_desc ON events (contract_id, id DESC);
      CREATE INDEX idx_events_ledger           ON events (ledger);
      CREATE INDEX idx_events_topic0           ON events (topic0, id DESC);
      CREATE INDEX idx_events_contract_topic0  ON events (contract_id, topic0, id DESC);
      CREATE INDEX idx_events_tx_hash          ON events (tx_hash);

      -- Ingest progress, mirrored here so the API can report indexer lag
      -- without reading Module 1's cursor files.
      CREATE TABLE stream_state (
        key        TEXT PRIMARY KEY,
        cursor     TEXT NOT NULL,
        ledger     INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'index-indexed-at',
    up: `
      -- "What did we ingest in the last hour" is the first question anyone asks
      -- of a stalled indexer, and it was a full table scan: indexed_at was
      -- written on every row and indexed by nothing.
      --
      -- DESC because every use of this column is recent-first.
      CREATE INDEX idx_events_indexed_at ON events (indexed_at DESC);
    `,
  },
  {
    version: 3,
    name: 'index-closed-at-unix',
    up: `
      -- closed_at_unix was populated on every insert and read by nothing.
      -- Backing fromTime/toTime with it means time bounds are an integer
      -- comparison on an indexed column rather than string maths on
      -- ledger_closed_at.
      CREATE INDEX idx_events_closed_at_unix ON events (closed_at_unix, id DESC);
    `,
  },
];

export const LATEST_SCHEMA_VERSION: number = MIGRATIONS.reduce(
  (max, m) => Math.max(max, m.version),
  0,
);
