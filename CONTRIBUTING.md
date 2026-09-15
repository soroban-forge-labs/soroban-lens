# Contributing to soroban-lens

The repo is deliberately split so that **five people can work at once without
tripping over each other**. Most of the rules below exist to protect that.

## Module ownership map

| Module | Directory | Owner | Depends on | Depended on by |
|---|---|---|---|---|
| 1 — Ingestion & RPC | `packages/ingest` | **Person A** | `@stellar/stellar-sdk` | Module 5 |
| 2 — Decoding & Storage | `packages/store` | **Person B** | `@stellar/stellar-sdk` | Modules 3, 5 |
| 3 — Query API | `packages/api` | **Person C** | Module 2 | Module 4 (over HTTP) |
| 4 — Web UI | `apps/web` | **Person D** | *nothing* — HTTP only | — |
| 5 — Deployment, Docs & DX | `packages/cli`, `deploy/`, `docs/`, `.github/` | **Person E** | Modules 1, 2 | — |

Note that `packages/cli` belongs to **Module 5**, not to a sixth module. It is
where `lens doctor` and the indexer runner live — operator-facing tooling, which
is Person E's remit.

Owner means "reviews changes and owns the interface". Anyone can open a PR
against any module.

### Why the graph is this shape

**Module 1 and Module 2 do not depend on each other.** That is the single most
important structural decision in the repo. Module 1 emits `RawEvent`; Module 2
accepts a structurally identical `RawEventInput` that it declares itself. There
is no shared package and no build ordering between them, so Person A and
Person B are never blocked on each other.

The price: **`RawEvent` and `RawEventInput` must stay identical**. Changing
either is a breaking change to the whole pipeline. If you change one:

1. Change both, in the same PR.
2. Update both READMEs.
3. Say so in the PR title: `breaking(contract): …`.

`packages/cli/src/indexer.ts` is where the two meet, and it passes Module 1's
output straight into Module 2's input. If that ever stops type-checking, the
contract has drifted — that compile error is the guard rail, so do not paper
over it with a cast.

**Module 4 depends on nothing in the repo.** The UI talks HTTP and mirrors the
response types by hand in `apps/web/src/types.ts`. Person D can work against
`npm run seed` data while Person C is mid-refactor.

## The interfaces

Three contracts hold the system together. Keep them small; changing them costs
everyone.

| Contract | Defined in | Consumed by |
|---|---|---|
| `RawEvent` | `packages/ingest/src/types.ts` | Module 2 (structurally) |
| `EventStore` | `packages/store/src/store.ts` | Module 3, Module 5 |
| `openapi.json` | `packages/api/openapi.json` | Module 4, third parties |

### `EventStore`

The storage trait. The API codes against it and never touches SQLite. Adding
Postgres means a second implementation, not a rewrite. Implementations must
guarantee:

1. `insertEvents` is idempotent on event id — Module 1 is at-least-once and
   *will* replay after a crash.
2. Results are ordered by event id, which for Soroban is ledger order.
3. Pagination is keyset, not offset — pages stay correct while the indexer
   writes behind them.

### `openapi.json`

Committed, and the same file the server serves at `/openapi.json`, so the two
cannot drift. A test asserts every implemented route appears in the spec: add a
route without documenting it and CI fails.

## Getting set up

```bash
npm install          # Node 22.12+
npm run build
npm test
```

No network needed. Every suite runs against `fixtures/testnet-events.json`,
which is real captured testnet data.

## Working on one module

```bash
npm test  -w @soroban-lens/store
npm run build -w @soroban-lens/api
```

Modules 3, 4 and 5 can all be developed with no RPC access at all:

```bash
npm run seed         # loads the fixture into ./data/lens.db
npm run api          # serve it
npm run web          # explore it
```

## Tests

- **`node:test`**, built in. No test framework dependency.
- Tests are plain JavaScript under `test/`, importing from the built `dist/`.
  `npm test` builds first. This keeps the toolchain at one compiler.
- **New behaviour needs a test.** Bug fixes need one that fails before the fix.
- **Tests must not need the network.** Use the fixture. If you are testing
  something the fixture cannot express — a node forgetting a ledger, an RPC
  timing out — use a scripted fake, as `packages/ingest/test/poller.test.js`
  does.

If you change `fixtures/testnet-events.json`, re-run everything: several suites
assert on specific event ids, and `fixtures/README.md` documents exactly which
decoding cases the file is there to cover.

## Style

- TypeScript `strict`, plus `noUncheckedIndexedAccess`. No `any`; prefer
  `unknown` and narrow.
- Comments explain **why**, not what. A comment restating the code is noise; a
  comment explaining why the code is surprising is the valuable kind.
- Keep module public surfaces in `src/index.ts`. Anything not exported there is
  internal.
- No new runtime dependencies without discussion. "Dependency light" is a
  stated project goal — `node:sqlite`, `node:http` and `node:test` are all used
  in preference to popular alternatives on purpose.

## Pull requests

1. Branch from `main`.
2. Prefix the title with the module: `ingest:`, `store:`, `api:`, `web:`,
   `deploy:`, `docs:`. Use `breaking(contract):` for the shared types.
3. Keep a PR inside one module wherever you can. A PR touching three modules
   needs three reviewers and blocks three people.
4. `npm test` and `npm run build` must pass. CI also builds the Docker images
   and runs the stack end to end against the fixture.
5. Update the module's README when you change its interface.

## Filing issues

[ISSUES.md](./ISSUES.md) has 15 scoped follow-ups, three per module, tagged
**trivial** / **medium** / **high**. Good places to start are the ones tagged
trivial.

For a new issue, say which module it belongs to and what the user-visible
symptom is. "The UI hangs on a contract with 10 000 events" beats "pagination is
slow".

## Verifying a change end to end

```bash
npm run build
npm test
docker compose up --build            # the whole stack
npm run doctor -- -c <YOUR_CONTRACT>  # preflight against a real network
```

## License

Contributions are accepted under [Apache-2.0](./LICENSE).
