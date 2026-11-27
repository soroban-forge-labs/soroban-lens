# ADR-009: Serve store reads from a worker thread pool

- **Status:** Accepted
- **Date:** 2026-11-24

## Context

`node:sqlite` is synchronous, so a query runs to completion on the event loop of
whichever thread calls it. ADR-001 accepted that for the engine; it did not
consider what one slow query does to a process serving many clients. The
expensive reads are not exotic — an unselective `?search=`, the `COUNT(*)` behind
`total`, `getStats` on every request — and while one runs, every other request
waits and `/health` cannot answer.

## Decision

Serve reads from a small pool of worker threads, each with its own connection
opened `readOnly: true`, behind the unchanged `EventStore` trait:
`PooledSqliteEventStore`. The API enables it by default at two workers
(`LENS_READ_POOL_SIZE`, `0` to disable). Dispatch is least-busy, because a worker
inside a synchronous call is fully occupied.

Writes do not move: SQLite has one writer, so writes, migrations and the
read-shaped methods that actually write (`exportSnapshot`, `checkpoint`,
`writeProbe`) stay on the calling thread, as does `getLatestEventId` — cheaper
than the round trip that would carry it.

## Alternatives considered

- **Accept the block.** One unauthenticated `?search=` degrades every other
  client: a denial of service needing no sophistication.
- **An asynchronous driver.** `better-sqlite3` needs native compilation, which
  breaks the zero-setup install ADR-001 protects — and it is synchronous too.
- **The whole store in one worker.** Serialises everything, so a slow read still
  delays a cheap one. Moves the stall rather than removing it.
- **A child process.** Costs more than a thread, and a read-only connection on
  an already-open file is not a new trust boundary.

## Consequences

- Per ADR-007 this is a third implementation, not a wider trait, so the
  conformance suite runs against it unmodified.
- Opening costs ~1.2s per worker, almost all of it the Stellar SDK loading in the
  thread — at startup, but also per store in the conformance suite. The fix is to
  stop `sqlite-store.ts` pulling `decode.ts` into a read-only thread.
- Pooling costs ~0.1ms per call, the count cache fragments per worker (so
  `totalIsEstimate` may differ between identical requests), and `:memory:` is
  rejected as private to one connection. `LENS_READ_POOL_SIZE=0` undoes all of it.
- The pool bounds how much one slow query hurts; with every worker busy, reads
  queue.

## References

- Issue [#159](https://github.com/soroban-forge-labs/soroban-lens/issues/159)
- `packages/store/src/pooled-store.ts`, `src/read-worker.ts`
- `packages/store/bench/read-pool.bench.js`, `test/pooled-store.test.js`
- ADR-001, ADR-007 — both upheld, neither superseded
