# ADR-008: v0.1 has no auth, one network per database, no deep backfill

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

v0.1 is a read-only explorer for a trusted deployment. Building authentication,
multi-network routing and archival backfill before the core pipeline is proven
would add surface area without validating the product.

## Decision

Ship v0.1 with these explicit boundaries:

1. No authentication or authorisation; deploy it on a trusted network.
2. One network per database/API instance; the UI switches networks by pointing at
   a different API.
3. Backfill only within the RPC node's retention window; older history needs an
   archive source that v0.1 does not include.

## Alternatives considered

- **API keys or user accounts.** Meaningful only once the API is exposed to
  untrusted clients or write operations exist. Neither is true for v0.1.
- **Multi-network routing in one process.** Multiplies configuration, cursor and
  schema concerns; separate deployments are simpler and isolate failures.
- **Archive backfill now.** Requires an archive data source, storage planning and
  a much longer initial sync, before the core indexing path is validated.

## Consequences

- Do not expose a v0.1 instance directly to the public internet without an
  authenticating proxy.
- A network switch means a different API URL, not a query parameter.
- A cursor older than retention is reported as an unrecoverable gap and restarts
  from `oldestLedger`; this is a documented limitation, not a bug.
- Revisiting any boundary requires a new ADR that supersedes this one.

## References

- [`docs/architecture.md`](../architecture.md)
- [`README.md`](../../README.md)
- `docs/troubleshooting.md`
