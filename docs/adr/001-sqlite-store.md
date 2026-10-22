# ADR-001: SQLite is the v0.1 event store

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

soroban-lens v0.1 indexes one contract set on one network and serves a read-only
explorer. The deployment target is a single container with a local data volume,
operated by contributors rather than a database team. The store must support
concurrent indexing and API reads, durable restarts, and cheap local setup.

## Decision

Use SQLite in WAL mode through the `EventStore` trait. The database is a file on
the `/app/data` volume (`LENS_DB_PATH`), with `events` and `stream_state` tables.
WAL lets the API read while the indexer writes. The API never imports a SQLite
driver directly; it codes against `EventStore`.

## Alternatives considered

- **PostgreSQL.** The right answer for multi-writer or multi-node deployments,
  but it adds a second service, credentials, migrations and operational work
  that v0.1 does not need. Keeping storage behind a trait makes it additive
  later rather than a rewrite.
- **In-memory storage.** Fast and simple, but an indexer exists to survive
  restarts; losing the cursor and events on deploy defeats the purpose.
- **DuckDB.** Strong for analytical scans, but the workload is many small
  point/range reads and concurrent writes, not columnar analytics.
- **JSON files.** Easy to start, but no durable indexes, no transactional cursor
  updates, and no safe concurrent reader/writer story.

## Consequences

- Single-writer semantics are acceptable because one indexer process owns the
  database. The API volume cannot be mounted read-only because WAL writes the
  `-wal` and `-shm` sidecars even for readers.
- Backups are file copies made with SQLite's backup mechanism, not a `cp` of a
  live database.
- Postgres support means implementing the existing `EventStore` interface and
  running the conformance suite, not changing API code.

## References

- [`docs/architecture.md`](../architecture.md)
- `packages/store/src/store.ts`
- `packages/store/src/sqlite-store.ts`
