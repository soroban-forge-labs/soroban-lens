# ADR-003: Keep `RawEvent` and `RawEventInput` duplicated

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

Module 1 (ingestion) produces events and Module 2 (storage) consumes them. The
repository is split so different owners can work concurrently without shared
build ordering. A shared types package would make both modules depend on the
same package release and on each other's build.

## Decision

Module 1 declares `RawEvent` in `packages/ingest/src/types.ts`. Module 2 declares
a structurally identical `RawEventInput` in its own package. The two are kept in
sync by hand. `packages/cli/src/indexer.ts` passes one directly into the other,
so drift becomes a TypeScript error at the seam rather than a runtime surprise.

## Alternatives considered

- **A shared `@soroban-lens/types` package.** Removes duplication, but adds a
  build ordering: neither module can compile until the shared package does, and
  changing the contract requires coordinating releases. That is exactly the
  coupling the module split is meant to avoid.
- **Module 2 importing Module 1's type.** Storage would depend on ingestion,
  inverting the dependency graph and making the store unusable without the RPC
  client.
- **Code generation from a schema.** Solves drift, but adds a generator, a build
  step and generated files for a two-type contract.

## Consequences

- Changing either type is a breaking change to the pipeline. Update both in the
  same PR, update both READMEs, and mark the PR `breaking(contract): ...`.
- The compile-time handoff in `indexer.ts` is the guard rail. Do not replace it
  with a cast or `any`.
- The duplication is intentional and documented; "clean it up" is not a safe
  drive-by refactor.

## References

- [`CONTRIBUTING.md`](../../CONTRIBUTING.md)
- `packages/ingest/src/types.ts`
- `packages/store/src/types.ts`
- `packages/cli/src/indexer.ts`
