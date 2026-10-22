# ADR-005: Paginate by event id, never by offset

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

The API pages through events while the indexer writes new rows behind it. Soroban
event ids are fixed-width (30 characters) and sort lexicographically in ledger
order.

## Decision

Use keyset pagination: the next page is `WHERE id < ?` ordered by `id DESC`,
with the last id from the previous page as the cursor. `EventStore` implementations
must return results ordered by event id and must not use offset pagination.

## Alternatives considered

- **`LIMIT`/`OFFSET`.** Simple, but rows inserted or deleted between requests
  shift the window, causing skipped or repeated events. The indexer is always
  writing, so this is not a rare edge case.
- **Composite cursor (ledger, tx, op).** Unnecessary: the fixed-width event id
  already provides a total order that matches ledger order.
- **Snapshot isolation or a read transaction per page.** Holds a long-lived read
  transaction against a WAL database and still cannot give stable offsets
  without versioning.

## Consequences

- Pages remain stable while ingestion continues.
- Cheap "total count" is a separate query; the API must not derive it from the
  page size.
- The cursor is opaque to clients, so the id format can stay an implementation
  detail of the API contract.

## References

- [`docs/architecture.md`](../architecture.md)
- `packages/api/src/routes/events.ts`
- `packages/store/src/store.ts`
