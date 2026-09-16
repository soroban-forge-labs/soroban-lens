/**
 * Schema migrations.
 *
 * Append-only: never edit a migration that has shipped, add a new one. The
 * runner records each applied version in `schema_migrations` and applies only
 * what is missing, inside a transaction.
 *
 * `down` is optional and, when present, is the exact inverse of `up` for
 * schema structure — it is not a promise to recover data `up` never captured.
 * Migration 1's down drops the tables outright: rolling back the initial
 * schema is irreversible in the data sense no matter what SQL runs, because
 * there is no earlier schema for the data to live in. A migration with no
 * `down` at all cannot be rolled back through `lens migrate --down`; the
 * runner reports exactly that rather than guessing at one.
 */
export interface Migration {
  version: number;
  name: string;
  up: string;
  down?: string;
  /**
   * This migration's `up` needs the FTS5 extension. Not every SQLite build
   * has it compiled in — notably, the exact Node 22.13 floor this project
   * documents does not, while Node 24 does; both ship "node:sqlite", and
   * nothing about the module's own API says which extensions its underlying
   * SQLite was built with. A store on a build without FTS5 skips this
   * migration's `up` (recorded as applied regardless, so it is never retried
   * every time the store opens) rather than failing every single
   * SqliteEventStore construction over one feature.
   */
  requiresFts5?: boolean;
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
    // Drops everything this migration created. There is no earlier schema to
    // preserve the data in, so this is a full, deliberate data loss — the one
    // genuinely irreversible step, structural SQL notwithstanding.
    down: `
      DROP TABLE IF EXISTS stream_state;
      DROP TABLE IF EXISTS events;
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
    down: `DROP INDEX IF EXISTS idx_events_indexed_at;`,
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
    down: `DROP INDEX IF EXISTS idx_events_closed_at_unix;`,
  },
  {
    version: 4,
    name: 'index-decoded-addresses',
    up: `
      -- One row per (address, position) an address appears at inside an
      -- event — a topic segment or anywhere in the decoded value. An event
      -- can mention the same address more than once (sender and recipient
      -- can differ, but a self-transfer mentions one address at two
      -- positions), so this is not a simple many-to-one.
      -- A composite primary key, not a synthetic id: it is what makes
      -- INSERT OR IGNORE here idempotent, matching how the events table
      -- itself absorbs Module 1's at-least-once delivery. The same address
      -- can never legitimately appear twice at the same position for the
      -- same event — extraction already de-duplicates within one position.
      CREATE TABLE event_addresses (
        event_id TEXT    NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        address  TEXT    NOT NULL,
        position TEXT    NOT NULL,  -- 'topic0'..'topic3', 'topicN' (4+), or 'value'
        PRIMARY KEY (event_id, address, position)
      ) WITHOUT ROWID;

      -- The address lookup this table exists for.
      CREATE INDEX idx_event_addresses_address ON event_addresses (address, event_id);
      -- Cleanup and re-extraction (prune, redecode) look up by event_id.
      CREATE INDEX idx_event_addresses_event_id ON event_addresses (event_id);
    `,
    down: `DROP TABLE IF EXISTS event_addresses;`,
  },
  {
    version: 5,
    name: 'full-text-search',
    requiresFts5: true,
    up: `
      -- trigram, not the default unicode61 tokenizer: "searching a substring"
      -- means matching 'ick br' inside 'quick brown', which a token-based
      -- tokenizer cannot do (it only matches whole tokens or a token prefix).
      -- Trigram indexes every 3-character run, so any substring of at least
      -- 3 characters is findable. Shorter search terms simply match nothing,
      -- a limitation of the technique rather than a bug — documented on the
      -- API parameter rather than left for someone to discover.
      --
      -- Standalone rather than an external-content table: events' primary key
      -- is TEXT, and FTS5's content= mapping needs an INTEGER rowid to alias.
      -- Kept in sync by trigger instead, which also means every write path —
      -- insert, redecode's UPDATE, prune's DELETE — updates this table for
      -- free, with no code changes to any of them.
      CREATE VIRTUAL TABLE events_fts USING fts5(
        event_id UNINDEXED,
        topics_text,
        value_text,
        tokenize = 'trigram'
      );

      CREATE TRIGGER trg_events_fts_insert AFTER INSERT ON events BEGIN
        INSERT INTO events_fts (event_id, topics_text, value_text)
        VALUES (new.id, new.topics_json, new.value_json);
      END;

      CREATE TRIGGER trg_events_fts_update AFTER UPDATE ON events BEGIN
        DELETE FROM events_fts WHERE event_id = old.id;
        INSERT INTO events_fts (event_id, topics_text, value_text)
        VALUES (new.id, new.topics_json, new.value_json);
      END;

      CREATE TRIGGER trg_events_fts_delete AFTER DELETE ON events BEGIN
        DELETE FROM events_fts WHERE event_id = old.id;
      END;
    `,
    down: `
      DROP TRIGGER IF EXISTS trg_events_fts_delete;
      DROP TRIGGER IF EXISTS trg_events_fts_update;
      DROP TRIGGER IF EXISTS trg_events_fts_insert;
      DROP TABLE IF EXISTS events_fts;
    `,
  },
];

export const LATEST_SCHEMA_VERSION: number = MIGRATIONS.reduce(
  (max, m) => Math.max(max, m.version),
  0,
);
