# Running Lens on Postgres

Lens ships with a SQLite backend by default. The Postgres backend is selected
through the `EventStore` seam (see [`docs/architecture.md`](../architecture.md)),
so the API and web UI are unchanged — only the store implementation and its
connection settings differ.

This guide covers running Lens against Postgres: bringing it up with the
bundled compose file, tuning it, backing it up, and migrating an existing
SQLite database.

## Setup with `docker-compose.postgres.yml`

The repository ships a compose file that starts Postgres alongside the indexer
and API, wired to the Postgres backend.

```sh
# Start Postgres + Lens (indexer and API) in the background
docker compose -f docker-compose.postgres.yml up -d

# Follow logs
docker compose -f docker-compose.postgres.yml logs -f

# Check the API is serving
docker compose -f docker-compose.postgres.yml exec api lens doctor

# Stop everything, keeping the Postgres volume
docker compose -f docker-compose.postgres.yml down

# Stop and delete the Postgres volume (destroys all indexed data)
docker compose -f docker-compose.postgres.yml down -v
```

The compose file sets `LENS_DATABASE_URL` for the indexer and API. To point at
your own Postgres instead, override it:

```sh
export LENS_DATABASE_URL="postgres://lens:lens@db.example.com:5432/lens?sslmode=require"
```

## Recommended settings

### Sizing

Storage is dominated by the raw XDR kept on every row (see the data model in
[`docs/architecture.md`](../architecture.md)). As a rough starting point:

| Workload | vCPU | RAM | Disk |
|---|---|---|---|
| Single contract, light traffic | 2 | 4 GB | 20 GB |
| Up to ~25 contracts (concurrent chunks) | 4 | 8 GB | 100 GB |
| Heavy multi-contract indexing | 8 | 16 GB | 500 GB+ |

Give Postgres `shared_buffers` about 25% of RAM and leave headroom for the
indexer's decode buffers. Disk should be SSD; the keyset pagination and topic
filters are index-bound.

### Indexes

The schema creates the indexes the query paths need:

- the primary key on `events.id` (fixed-width, sorts in ledger order — this is
  what keyset pagination uses),
- indexes on the scalar topic projections `topic0`…`topic3` for prefix
  filtering,
- the `stream_state` primary key for per-chunk cursors.

Do not drop these. If you add ad-hoc indexes for your own queries, create them
`CONCURRENTLY` so the indexer is not blocked:

```sql
CREATE INDEX CONCURRENTLY idx_events_ledger ON events (ledger);
```

### Vacuum and autovacuum

The indexer writes continuously and the API reads, so dead tuples accumulate.
Keep autovacuum on and make it more aggressive than the defaults for the
`events` table:

```sql
ALTER TABLE events SET (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.02
);
```

Check bloat and last vacuum with:

```sql
SELECT relname, n_live_tup, n_dead_tup, last_autovacuum
FROM pg_stat_user_tables
WHERE relname IN ('events', 'stream_state');
```

### Connection limits

Each indexer worker and each API request holds a connection. Size
`max_connections` for the sum of both, plus headroom for admin sessions, and
cap the application pools rather than raising `max_connections` without bound.

```sql
SHOW max_connections;
SELECT count(*) FROM pg_stat_activity WHERE datname = 'lens';
```

If you run several Lens instances against one database, put PgBouncer in front
in transaction pooling mode and keep the per-instance pool small.

## Backup and restore

Use the standard Postgres tools. Take a consistent logical dump while the
indexer is running:

```sh
# Dump the whole database in custom format
docker compose -f docker-compose.postgres.yml exec -T db \
  pg_dump -U lens -Fc lens > lens-$(date +%Y%m%d).dump
```

Restore into a fresh database:

```sh
# Create the target database, then restore
docker compose -f docker-compose.postgres.yml exec -T db \
  createdb -U lens lens_restored

docker compose -f docker-compose.postgres.yml exec -T db \
  pg_restore -U lens -d lens_restored --no-owner < lens-20240101.dump
```

For a physical backup of a large deployment, use `pg_basebackup` against the
primary instead of `pg_dump`.

## Moving data from SQLite

If you already have a SQLite database, export it with the CLI and import into
Postgres. The export is the portable form of the `events` and `stream_state`
tables.

```sh
# 1. Export from the existing SQLite database
lens export --database ./data/lens.db --out lens-export.jsonl

# 2. Point at Postgres and import
LENS_DATABASE_URL="postgres://lens:lens@localhost:5432/lens" \
  lens import --in lens-export.jsonl

# 3. Verify the row counts match
lens doctor
```

Import is idempotent — it uses the same `INSERT OR IGNORE` semantics on the
event id as the indexer, so re-running it after a partial import is safe. The
imported `stream_state` cursors let the indexer resume where SQLite left off,
provided the cursors are still within RPC retention (about 7 days).
