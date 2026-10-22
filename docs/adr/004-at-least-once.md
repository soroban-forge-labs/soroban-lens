# ADR-004: Deliver events at least once

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

The indexer writes events and advances a cursor. A crash can happen between those
two operations. RPC nodes forget old ledgers, so losing an acknowledged event may
be permanent, while replaying one is cheap.

## Decision

Advance the cursor only after the consumer accepts the next page. Delivery is
at-least-once. The store makes replay harmless with `INSERT OR IGNORE` keyed on
the Soroban event id; event ids are unique and sort in ledger order.

## Alternatives considered

- **At-most-once (cursor first).** Avoids duplicates, but a crash between cursor
  and write silently drops events that the RPC may no longer serve. Missing data
  is not recoverable; duplicate work is.
- **Exactly-once.** Requires a distributed transaction across the RPC cursor and
  the local database, which neither side offers. The complexity is not justified
  for a read-only indexer.
- **Deduplicate in the API.** Moves the problem downstream and still stores
  duplicate rows. Idempotent inserts are simpler and keep query counts honest.

## Consequences

- Consumers must not assume insertion order equals delivery order; order by event
  id for ledger order.
- `insertEvents` must remain idempotent on event id. The conformance suite
  enforces this for every `EventStore` implementation.
- Replays after a crash redo decoding work, which is acceptable at this scale.

## References

- [`CONTRIBUTING.md`](../../CONTRIBUTING.md)
- `packages/store/src/store.ts`
- `packages/store/test/conformance.test.js`
