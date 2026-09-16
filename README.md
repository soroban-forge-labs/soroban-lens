# soroban-lens

[![CI](https://github.com/soroban-forge-labs/soroban-lens/actions/workflows/ci.yml/badge.svg)](https://github.com/soroban-forge-labs/soroban-lens/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-green.svg)](./LICENSE)

**See what your Soroban contracts are actually emitting.**

An event indexer and explorer for [Stellar](https://developers.stellar.org)
smart contracts. Point it at a contract id, and within a minute you are looking
at that contract's decoded events in a browser — no custom scripts, no
hand-rolled XDR parsing.

Sibling project to **soroban-forge**, which scaffolds a contract. soroban-forge
helps you start one; soroban-lens helps you watch it once it is deployed. The
two are independent and share no code.

```
  Soroban RPC ──▶ ingest ──▶ store ──▶ api ──▶ web
                    │          │        │       │
                 Module 1   Module 2  Module 3  Module 4
                 polling,   decode,   HTTP +    explorer
                 cursors    SQLite    OpenAPI   UI
```

---

## Quickstart (5 minutes)

### With Docker

```bash
git clone https://github.com/soroban-forge-labs/soroban-lens
cd soroban-lens
cp .env.example .env
docker compose up
```

Open **http://localhost:5173**.

It starts pre-configured against the testnet Stellar Asset Contract for native
XLM, which is always emitting events, so you see real data immediately. Edit
`LENS_CONTRACT_IDS` in `.env` to watch your own contract.

`docker compose up` runs `lens doctor` first and refuses to start the indexer
or API if the RPC is unreachable or the volume is not writable.

### Without Docker

Needs **Node 22.13+** — the version where `node:sqlite` stopped requiring the
`--experimental-sqlite` flag. No native compilation either way.

```bash
npm install
npm run build

# 1. check everything before you wait on a silent failure
npm run doctor -- -c CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC

# 2. index — leave this running
npm run index -- -c CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC

# 3. in a second terminal: serve and explore
npm run api &
npm run web
```

In a hurry, or offline? `npm run seed` loads the committed testnet fixture into
the database so the API and UI have real data with no network at all.

---

## Why TypeScript

The brief allowed Rust or TypeScript with the official SDK. TypeScript, for
three reasons that were checked rather than assumed (2026-09-15):

1. **The JS SDK ships more often.** `@stellar/stellar-sdk` was at **17.1.0**,
   published the day before. The Rust `stellar-rpc-client` crate's newest
   release was **28.0.0-rc.1** (a release candidate, 2026-08-25), with
   **27.0.0** the newest stable, from June. Both work; the JS release cadence
   tracks protocol changes more tightly.
2. **One language across all five modules.** Module 4 is a browser UI, so
   TypeScript is already in the repo. Choosing Rust would mean two toolchains,
   two CI setups and two sets of reviewers for a project whose whole premise is
   that five people can work in parallel.
3. **Decoding is the hard part, and the JS SDK does it well.**
   `scValToNative()` handles the full `ScVal` tree. The work left is making the
   result JSON-safe, which is 40 lines.

The honest trade-off: a Rust indexer would use less memory and could ingest
from ledger-close metadata rather than polling. If soroban-lens ever needs to
index all of mainnet rather than a handful of contracts, that is the rewrite to
plan for — the `EventStore` trait is the seam it would happen behind.

---

## What "working" means here

Point it at a contract id on testnet, and within a minute you see that
contract's events in the UI. That is the v0.1 bar, and it is enforced by CI:
every push builds the images, seeds the fixture, and asserts the API returns
events.

---

## The five modules

Each has its own directory, README, tests, and a documented interface. See
[CONTRIBUTING.md](./CONTRIBUTING.md) for the ownership map.

| Module | Package | Owner | What it does |
|---|---|---|---|
| 1 | [`packages/ingest`](./packages/ingest) | A | Soroban RPC client, polling, retries, cursor tracking, network switching |
| 2 | [`packages/store`](./packages/store) | B | XDR decoding, schema, migrations, the `EventStore` trait, SQLite backend |
| 3 | [`packages/api`](./packages/api) | C | HTTP query API + committed OpenAPI spec |
| 4 | [`apps/web`](./apps/web) | D | Single-page explorer |
| 5 | [`packages/cli`](./packages/cli), [`deploy/`](./deploy), [`docs/`](./docs) | E | `lens` CLI, `lens doctor`, Docker, docs |

---

## Three things that will bite you

These are not edge cases. They come from the real testnet data in
[`fixtures/`](./fixtures), and each one shapes the code.

**Decoded integers are strings, not numbers.** Soroban `i128`/`u128` values
routinely exceed `Number.MAX_SAFE_INTEGER`. `{"type":"i128","value":"4300000000"}`
is a string on purpose. `Number(...)` on a large token amount loses precision
silently. Use `BigInt`.

**Events can carry more topics than a filter can match.** The RPC's `getEvents`
topic filter accepts at most 4 segments, but emitted events are not bound by
that — the fixture contains real 5-topic events. Anything assuming "at most 4
topics, first one is a symbol" will mangle those contracts. soroban-lens stores
the full topic array and filters on a prefix.

**RPC nodes forget.** Retention is about **7 days** (120 960 ledgers). An
indexer that is off for longer than that cannot catch up from an RPC node, and
soroban-lens says so in the log rather than pretending. Backfilling deeper
history needs an archive source, which v0.1 does not have.

---

## Configuration

Every option is documented in [`.env.example`](./.env.example). The essentials:

| Variable | Default | Notes |
|---|---|---|
| `LENS_NETWORK` | `testnet` | `testnet` / `mainnet` / `futurenet` |
| `LENS_RPC_URL` | network preset | **Required for mainnet** — no free public endpoint with useful retention |
| `LENS_CONTRACT_IDS` | testnet XLM SAC | Comma separated. Empty indexes *every* contract |
| `LENS_DB_PATH` | `./data/lens.db` | SQLite file |
| `LENS_API_PORT` | `8080` | |
| `LENS_WEB_PORT` | `5173` | |

---

## Storage

SQLite by default, so anyone can run it locally with zero setup — Node's
built-in `node:sqlite`, so `npm install` compiles nothing.

The API depends only on the [`EventStore`](./packages/store/src/store.ts)
interface, never on SQLite. Adding Postgres means writing a second
implementation of that interface; nothing above it changes.

---

## Development

```bash
npm install
npm run build          # all workspaces, in dependency order
npm test               # all suites — no network required
npm run typecheck
```

Every test runs against `fixtures/testnet-events.json`, real captured testnet
data, so the suite cannot be broken by a testnet outage.

Working on one module:

```bash
npm test -w @soroban-lens/store
npm run build -w @soroban-lens/api
```

---

## Project docs

- [CONTRIBUTING.md](./CONTRIBUTING.md) — module ownership, interface rules, PR process
- [CONTRIBUTORS.md](./CONTRIBUTORS.md) — everyone who has contributed code
- [docs/index-your-first-contract.md](./docs/index-your-first-contract.md) — the 5-minute walkthrough
- [docs/architecture.md](./docs/architecture.md) — how data flows, and why
- [docs/troubleshooting.md](./docs/troubleshooting.md) — when it does not work
- [ISSUES.md](./ISSUES.md) — 100 scoped follow-up issues, 20 per module (also [filed on GitHub](https://github.com/soroban-forge-labs/soroban-lens/issues), numbers matching)
- [packages/api/openapi.json](./packages/api/openapi.json) — API contract, browsable at `/docs` on a running instance

## Security

v0.1 is **read-only and unauthenticated**, with `Access-Control-Allow-Origin: *`
by default. It assumes a trusted network. Put a reverse proxy in front and set
`LENS_CORS_ORIGIN` before exposing it.

## License

[Apache-2.0](./LICENSE).
