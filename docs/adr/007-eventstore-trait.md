# ADR-007: The API depends on `EventStore`, not SQLite

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

The query API needs storage, but the project may later add PostgreSQL or another
backend. Coupling routes to SQLite would make that a rewrite and would let
storage details leak into the HTTP contract.

## Decision

Define `EventStore` as the only storage interface the API knows. SQLite is one
implementation. Every implementation must guarantee idempotent inserts, event-id
ordering, and keyset pagination. The API never imports a database driver.

## Alternatives considered

- **Direct SQLite queries in route handlers.** Fastest for v0.1, but makes the
  API untestable without a database file and blocks a second backend.
- **A generic ORM.** Adds a dependency and still leaks query semantics; the
  interface is small enough to own.
- **Repository classes per backend in the API package.** Duplicates the seam and
  puts storage knowledge back in Module 3.

## Consequences

- New backends implement the trait and run the shared conformance suite; API code
  does not change.
- The trait must stay small. Adding method-level storage optimisations to it
  raises the cost for every implementation.
- Tests can use a fake store for route behaviour and the real store for
  conformance.

## References

- [`CONTRIBUTING.md`](../../CONTRIBUTING.md)
- `packages/store/src/store.ts`
- `packages/store/test/conformance.test.js`
