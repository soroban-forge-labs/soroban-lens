# `@soroban-lens/api` — Module 3: Query API

Owner: **Person C**

Read-only HTTP API over the indexed events. Depends on Module 2's `EventStore`
trait and nothing else — it never touches SQLite or the RPC directly.

## Deliverable

```bash
npm run build -w @soroban-lens/api
node packages/api/dist/bin.js --db ./data/lens.db --port 8080

curl "localhost:8080/contracts/CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC/events?limit=50"
```

## Routes

| Route | Purpose |
|---|---|
| `GET /health` | Liveness + a real write probe against the store. `503` when degraded. |
| `GET /stats` | Row counts, indexed ledger range, schema version. |
| `GET /status` | Stats plus every ingest stream's saved cursor — indexer lag without asking the RPC. |
| `GET /contracts` | Indexed contracts, most recently active first. |
| `GET /contracts/{id}/events` | Events for one contract. |
| `GET /contracts/{id}/topics` | Distinct first-topic values, ranked by frequency. |
| `GET /events` | Events across all contracts. |
| `GET /events/{id}` | One event by RPC event id. |
| `GET /openapi.json` | The spec below, served from disk. |

Query parameters on the two event-list routes: `limit` (1–1000, default 50),
`cursor`, `order` (`asc`/`desc`), `topic` (repeatable), `fromLedger`,
`toLedger`, `txHash`, `successfulOnly`.

## OpenAPI

[`openapi.json`](./openapi.json) is the committed spec and the source of truth;
the server reads that same file to serve `/openapi.json`, so the two cannot
drift. Generate a client with any OpenAPI 3.1 generator:

```bash
npx @openapitools/openapi-generator-cli generate \
  -i packages/api/openapi.json -g typescript-fetch -o ./generated-client
```

It is authored as JSON rather than YAML so that serving it needs no YAML parser
— a dependency the API would otherwise carry for one route.

A test asserts every implemented route appears in the spec, so adding a route
without documenting it fails CI.

## Things worth knowing before you build a client

**Decoded integers are strings.** `{"type":"i128","value":"4300000000"}`.
Soroban i128/u128 amounts exceed `Number.MAX_SAFE_INTEGER`, so a JSON number
would quietly lose precision on large transfers. Decoded `bytes` are hex
strings. Use `BigInt(event.value.value)` for arithmetic.

**Pagination is keyset.** Pass `nextCursor` back as `cursor`. `nextCursor` is
`null` on the last page — that is the termination condition, not an empty
`events` array. Offset pagination would skip or repeat rows while the indexer
writes behind you; this does not.

**Topic filters are a positional prefix**, and `*` is a wildcard:
`?topic=transfer` matches any event whose first topic is `transfer`;
`?topic=*&topic=order` matches any event whose *second* topic is `order`.
At most four, because only four positions are indexed — but events can carry
more than four topics, so a prefix filter may need client-side narrowing to
become an exact match.

**Bad parameters are rejected, not clamped.** `?limit=5000` is a `400` naming
the offending parameter, not a silently truncated page. Errors are always
`{"error":{"code","message","parameter?"}}`.

**No auth, and `Access-Control-Allow-Origin: *` by default.** v0.1 is read-only
and assumes a trusted network. Set `LENS_CORS_ORIGIN` to tighten it, and put a
reverse proxy in front before exposing this publicly.

## Why plain `node:http`

Eight read-only GET routes and a regex table. A dependency-light stack is a
stated goal, and nothing here needs a framework. Auth, rate limiting or content
negotiation would be the moment to reconsider.

## Configuration

| Flag | Env | Default |
|---|---|---|
| `--db`, `-d` | `LENS_DB_PATH` | `./data/lens.db` |
| `--port`, `-p` | `LENS_API_PORT` | `8080` |
| `--host` | `LENS_API_HOST` | `0.0.0.0` |
| `--cors` | `LENS_CORS_ORIGIN` | `*` |

## Tests

```bash
npm test -w @soroban-lens/api
```

21 tests. They boot a real HTTP server on an ephemeral port against an in-memory
store seeded from `fixtures/testnet-events.json`, so the suite exercises real
routing, status codes and JSON — no network, no mocked request objects.
