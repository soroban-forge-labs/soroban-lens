# ADR-002: Poll `getEvents` instead of streaming

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

The indexer needs every contract event in ledger order. Soroban RPC exposes
`getEvents` with a cursor and pagination. There is no supported push
subscription that provides the same completeness guarantees for v0.1.

## Decision

Poll `getEvents` with `startLedger` or an opaque cursor, page through results,
and persist the cursor only after the consumer accepts the page. Use exponential
backoff with full jitter on RPC errors. Treat retention gaps explicitly: when the
cursor is older than the node's retention window, log the gap as unrecoverable
and restart from `oldestLedger` instead of wedging.

## Alternatives considered

- **Streaming from ledger-close metadata.** Lower latency and no polling, but it
  requires a different infrastructure path and substantially more code. It
  remains the natural next step if latency becomes a product requirement.
- **WebSocket subscriptions.** Not a supported, completeness-guaranteeing
  interface for this workload.
- **Fixed-interval polling with equal jitter.** Simpler, but several indexers
  restarting against the same RPC synchronise into a thundering herd. Full
  jitter spreads the retries.

## Consequences

- Events appear after the poll interval, not instantly. That is acceptable for
  an explorer.
- RPC retention (roughly seven days of ledgers) bounds how far behind the
  indexer may fall. Deeper history needs an archive source, which v0.1 does not
  have.
- Polling is at-least-once by design (see ADR-004), so the store must be
  idempotent.

## References

- [`docs/architecture.md`](../architecture.md)
- `packages/ingest/src/poller.ts`
- `packages/ingest/test/poller.test.js`
