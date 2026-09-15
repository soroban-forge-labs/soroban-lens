# `@soroban-lens/cli` — Module 5: Deployment, Docs & DX

Owner: **Person E** (together with [`deploy/`](../../deploy) and [`docs/`](../../docs))

The `lens` command: preflight checks, the indexer runner, and fixture seeding.
This is the operator-facing surface of the project.

## Deliverable

A newcomer with Docker installed gets a working instance without reading source
code:

```bash
cp .env.example .env
docker compose up          # runs lens doctor first, then indexer + api + web
```

## Commands

```bash
lens doctor    # preflight: Node, data dir, database, RPC, contract ids
lens index     # run the pipeline: ingest -> decode -> store
lens seed      # load the committed testnet fixture
lens stats     # what is in the database
```

Run them from the repo with `npm run doctor`, `npm run index`, `npm run seed`.

### `lens doctor`

Checks the things that otherwise fail silently ten minutes later, and prints a
fix for each failure:

```
lens doctor

  ✔  Node.js version  v26.4.0
  ✔  Data directory   /app/data is writable
  ✔  Database         /app/data/lens.db: writable, schema v1, 100 event(s), ledgers 4576514..4695324
  ✔  Soroban RPC      testnet https://soroban-testnet.stellar.org — healthy, ledger 4697651, retains 120959 ledgers (~7d)
  ✔  Contract IDs     1 configured

  All checks passed. Run `lens index` to start indexing.
```

Exit code is `1` if any check failed, `0` otherwise — warnings do not fail it.
That is what lets `docker-compose.yml` gate the indexer and API behind
`service_completed_successfully`, so nothing starts into a broken environment.

The database check performs a real **write** probe, not a read: a read-only
volume or a full disk only shows up on write, and that is exactly the failure
worth catching before the indexer starts.

## Configuration precedence

Flags beat environment beats defaults — so compose can set the environment
while a developer overrides one value on the command line. Every variable is
documented in [`.env.example`](../../.env.example).

## Where the modules meet

[`src/indexer.ts`](./src/indexer.ts) is the only file where Module 1 and
Module 2 touch. It passes `RawEvent[]` from the poller straight into
`insertEvents(RawEventInput[])`.

Nothing is converted, because the two types are structurally identical by
design. **If that line ever stops type-checking, the data contract has
drifted** — that compile error is the guard rail. Fix the types, do not add a
cast.

`StoreBackedCursors` adapts `EventStore` to Module 1's `CursorStore`, so resume
state lives in the same database as the events: one file to back up, one file to
delete when starting over, and the API can report indexer lag from `/status`
without reading Module 1's cursor files.

## Tests

```bash
npm test -w @soroban-lens/cli
```

13 tests, no network. The RPC check is exercised against an unresolvable
hostname, so the result is the same whether or not CI has network egress.
