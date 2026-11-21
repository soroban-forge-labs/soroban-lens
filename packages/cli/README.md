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
lens tail      # follow new events as they are indexed
lens spec      # contract specs for typed events: list | fetch | import
```

Run them from the repo with `npm run doctor`, `npm run index`, `npm run seed`.

Set `LENS_METRICS_PORT=9090` when running `lens index` to enable Prometheus
metrics. `LENS_METRICS_HOST` defaults to `127.0.0.1`; metrics are disabled when
no port is configured. See [monitoring](../../docs/metrics.md) for scraping and alerts.

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

#### `lens doctor --fix`

Applies the failures that have one obvious remedy, prints each action, then
runs the usual report:

```
lens doctor --fix

  +  created .env from .env.example (docker compose reads it; review LENS_CONTRACT_IDS)
  +  created data directory ./data
```

It only ever adds what is missing: `.env` is never overwritten, the database is
only migrated forward, and nothing is deleted. Network settings — RPC URL,
headers, contracts — are choices rather than fixes, so it leaves those to the
report's advice. A fresh clone reaches a passing report from this one command.

### `lens tail`

Follows events as the indexer writes them, without the API or a browser:

```bash
lens tail -c CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC --topic transfer
# 12:01:07  L4695317  CDLZ…GCYSC  transfer  GBYR…JQHHT  GDVF…B5GSA  "native"  =  11000000

lens tail --topic transfer --json | jq -r '.value.value'
```

Filters are the API's, with the API's rules: `--topic` (positional prefix,
repeatable, `*` for any one position), `--address`, `--tx-hash`, `--search`,
`--successful-only`. It starts at the newest event; `--from-ledger` or
`--from-time` replays matching history from that point first. `--json` writes
one complete event per line; the readable form is coloured on a terminal and
honours `NO_COLOR`/`FORCE_COLOR`. `--max-events <n>` stops after `n`.

It reads the database directly (`--db`, `LENS_DB_PATH`), so it runs wherever
the indexer's database is reachable: next to `lens index`, or inside the
container with `docker compose exec indexer node packages/cli/dist/bin.js tail`.

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
