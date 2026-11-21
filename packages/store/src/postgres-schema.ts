/**
 * Postgres port of the schema migrations in ./schema.ts (#22).
 *
 * Versions and names are kept identical to the SQLite list on purpose: the API
 * compares `getStats().schemaVersion` with `LATEST_SCHEMA_VERSION`, so both
 * backends must reach the same number. Append-only, like the SQLite list — add
 * a migration to *both* files in the same change.
 *
 * Differences from the SQLite schema, and why:
 *
 * - `topics_json` / `value_json` are `JSONB`, with a GIN index on `topics_json`
 *   so topic containment (`topics_json @> '[{"value":"transfer"}]'`) is
 *   indexable. Note JSONB does not preserve object key order.
 * - `id` is `COLLATE "C"`. Keyset pagination compares ids as strings, and the
 *   fixed-width id only sorts chronologically under a byte-wise collation; a
 *   locale collation such as en_US ignores punctuation and would misorder it.
 * - The raw XDR columns are plain `TEXT`. SQLite gzips them by hand (#35);
 *   Postgres already compresses large values through TOAST.
 * - Full-text search (#32) uses `pg_trgm` instead of FTS5: trigram GIN indexes
 *   over the JSONB text accelerate the `ILIKE` the query uses. The query works
 *   without the extension, only slower, so that migration may be skipped.
 */
import type { Migration } from './schema.js';

export interface PostgresMigration extends Omit<Migration, 'requiresFts5'> {
  /**
   * `up` needs an extension the connecting role may not be allowed to create.
   * Failing to apply it is logged and the migration still recorded, rather than
   * failing every store open over an optimisation.
   */
  optional?: boolean;
}

export const POSTGRES_MIGRATIONS: PostgresMigration[] = [
  {
    version: 1,
    name: 'initial-events-schema',
    up: `
      CREATE TABLE events (
        id                   TEXT COLLATE "C" PRIMARY KEY,
        contract_id          TEXT    NOT NULL,
        type                 TEXT    NOT NULL CHECK (type IN ('contract', 'system')),
        ledger               INTEGER NOT NULL,
        ledger_closed_at     TEXT    NOT NULL,
        closed_at_unix       BIGINT  NOT NULL,
        tx_hash              TEXT    NOT NULL,
        transaction_index    INTEGER NOT NULL,
        operation_index      INTEGER NOT NULL,
        in_successful_call   BOOLEAN NOT NULL,

        topics_json          JSONB   NOT NULL,
        topics_xdr_json      TEXT    NOT NULL,
        topic_count          INTEGER NOT NULL,

        topic0               TEXT,
        topic1               TEXT,
        topic2               TEXT,
        topic3               TEXT,

        value_type           TEXT    NOT NULL,
        value_json           JSONB   NOT NULL,
        value_xdr            TEXT    NOT NULL,

        decode_error         TEXT,
        indexed_at           TEXT    NOT NULL
      );

      CREATE INDEX idx_events_contract_id_desc ON events (contract_id, id DESC);
      CREATE INDEX idx_events_ledger           ON events (ledger);
      CREATE INDEX idx_events_topic0           ON events (topic0, id DESC);
      CREATE INDEX idx_events_contract_topic0  ON events (contract_id, topic0, id DESC);
      CREATE INDEX idx_events_tx_hash          ON events (tx_hash);

      -- Topic containment: topics_json @> '[{"type":"symbol","value":"transfer"}]'
      CREATE INDEX idx_events_topics_gin ON events USING GIN (topics_json jsonb_path_ops);

      CREATE TABLE stream_state (
        key        TEXT PRIMARY KEY,
        cursor     TEXT NOT NULL,
        ledger     INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
    down: `
      DROP TABLE IF EXISTS stream_state;
      DROP TABLE IF EXISTS events;
    `,
  },
  {
    version: 2,
    name: 'index-indexed-at',
    up: `CREATE INDEX idx_events_indexed_at ON events (indexed_at DESC);`,
    down: `DROP INDEX IF EXISTS idx_events_indexed_at;`,
  },
  {
    version: 3,
    name: 'index-closed-at-unix',
    up: `CREATE INDEX idx_events_closed_at_unix ON events (closed_at_unix, id DESC);`,
    down: `DROP INDEX IF EXISTS idx_events_closed_at_unix;`,
  },
  {
    version: 4,
    name: 'index-decoded-addresses',
    up: `
      CREATE TABLE event_addresses (
        event_id TEXT COLLATE "C" NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        address  TEXT NOT NULL,
        position TEXT NOT NULL,  -- 'topic0'..'topic3', 'topicN' (4+), or 'value'
        PRIMARY KEY (event_id, address, position)
      );

      CREATE INDEX idx_event_addresses_address  ON event_addresses (address, event_id);
      CREATE INDEX idx_event_addresses_event_id ON event_addresses (event_id);
    `,
    down: `DROP TABLE IF EXISTS event_addresses;`,
  },
  {
    version: 5,
    name: 'full-text-search',
    optional: true,
    up: `
      CREATE EXTENSION IF NOT EXISTS pg_trgm;

      CREATE INDEX idx_events_topics_trgm ON events USING GIN ((topics_json::text) gin_trgm_ops);
      CREATE INDEX idx_events_value_trgm  ON events USING GIN ((value_json::text) gin_trgm_ops);
    `,
    // The extension is left installed: it may be shared with other schemas.
    down: `
      DROP INDEX IF EXISTS idx_events_value_trgm;
      DROP INDEX IF EXISTS idx_events_topics_trgm;
    `,
  },
  {
    version: 6,
    name: 'contract-specs',
    up: `
      CREATE TABLE contract_specs (
        contract_id  TEXT    PRIMARY KEY,
        source       TEXT    NOT NULL CHECK (source IN ('wasm', 'stellar-asset', 'none')),
        wasm_hash    TEXT,
        entries_xdr  TEXT    NOT NULL DEFAULT '[]',
        event_count  INTEGER NOT NULL DEFAULT 0,
        error        TEXT,
        fetched_at   TEXT    NOT NULL
      );
    `,
    down: `DROP TABLE IF EXISTS contract_specs;`,
  },
  {
    version: 7,
    name: 'stream-state-latest-ledger',
    up: `
      -- The RPC's latestLedger and when the indexer saw it (#181), so the API
      -- can report lag without ever talking to the RPC. Nullable: rows
      -- written before this carry no sample.
      ALTER TABLE stream_state ADD COLUMN latest_ledger INTEGER;
      ALTER TABLE stream_state ADD COLUMN latest_ledger_seen_at TEXT;
    `,
    down: `
      ALTER TABLE stream_state DROP COLUMN latest_ledger_seen_at;
      ALTER TABLE stream_state DROP COLUMN latest_ledger;
    `,
  },
  {
    version: 8,
    name: 'event-deep-topics',
    up: `
      CREATE TABLE event_topics (
        event_id TEXT COLLATE "C" NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        topic    TEXT NOT NULL,
        PRIMARY KEY (event_id, position)
      );
      CREATE INDEX idx_event_topics_lookup ON event_topics (position, topic, event_id);

      INSERT INTO event_topics (event_id, position, topic)
      SELECT e.id, (j.ord - 1)::int,
             CASE WHEN jsonb_typeof(j.val->'value') = 'string' THEN j.val->>'value' ELSE (j.val->'value')::text END
        FROM events e, jsonb_array_elements(e.topics_json) WITH ORDINALITY AS j(val, ord)
       WHERE j.ord > 4 AND jsonb_typeof(j.val->'value') IN ('string', 'number', 'boolean')
      ON CONFLICT DO NOTHING;
    `,
    down: `DROP TABLE IF EXISTS event_topics;`,
  },
];
