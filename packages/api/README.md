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
| `GET /status` | Stats plus every ingest stream's saved cursor, `lagLedgers` and `sampleAgeSeconds` — indexer lag without asking the RPC. |
| `GET /contracts` | Indexed contracts, most recently active first. |
| `GET /contracts/{id}/events` | Events for one contract. |
| `GET /contracts/{id}/activity` | Event counts per `minute`/`hour`/`day` bucket: `?bucket=hour&from=…&to=…`. Empty buckets are omitted. |
| `GET /contracts/{id}/topics` | Distinct first-topic values, ranked by frequency. |
| `GET /contracts/{id}/spec` | Where the contract's spec came from and which events it declares. `404` before any lookup. |
| `GET /events` | Events across all contracts. |
| `GET /events/stream` | Live events as Server-Sent Events, same filters as `/events` plus `contractId`. |
| `GET /events/{id}` | One event by RPC event id. |
| `GET /openapi.json` | The spec below, served from disk. |
| `GET`/`POST /graphql` | Optional GraphQL over the same data. **Off by default** — see below. |
| `POST`/`GET /webhooks`, `GET`/`DELETE /webhooks/{id}`, `GET /webhooks/{id}/dead-letters` | Optional webhook subscriptions. **Off by default** — see below. |

Every event-returning route accepts `?fields=id,ledger,topics,value` to return only
those event properties. Omitted, every property is returned. `topicsXdr` and
`valueXdr` roughly double the payload, so leaving them out shrinks it. Unknown
names are a `400`.

Query parameters on the two event-list routes: `limit` (1–1000, default 50),
`cursor`, `direction` (`forward`/`backward`), `order` (`asc`/`desc`), `topic` (repeatable), `fromLedger`,
`toLedger`, `txHash`, `successfulOnly`.

### Streaming NDJSON

Send `Accept: application/x-ndjson` to either event-list route to get every
matching event, one JSON object per line, paged internally by keyset so memory
stays flat for any range:

```sh
curl -sH 'Accept: application/x-ndjson' 'http://localhost:8080/events?fromLedger=4695000' \
  | jq -c 'select(.trailer == null) | {id, ledger}'

# did the row cap cut it short?
curl -sH 'Accept: application/x-ndjson' http://localhost:8080/events | tail -n 1 | jq .trailer
# { "rows": 1000000, "capped": true, "cap": 1000000 }
```

The last line is always `{"trailer":{"rows":N,"capped":bool,"cap":N}}`. The cap
is `LENS_NDJSON_MAX_ROWS` (default 1,000,000); `capped: true` means more events
matched. `?limit=` bounds the stream too, and `?format=json` overrides `Accept`.

### Lag on `/status`

Each stream carries `latestLedger` and `latestLedgerSeenAt` — the RPC's tip as
the indexer last saw it — plus `lagLedgers` (tip minus `ledger`) and
`sampleAgeSeconds`. The API never contacts the RPC. A stopped indexer keeps its
last `lagLedgers`, but `sampleAgeSeconds` keeps growing, so "0 behind, 120 s ago"
is distinguishable from "0 behind, now". Both are `null` until the indexer has
saved a sample.

### Errors as problem details

Errors are `{ "error": { code, message, parameter?, requestId? } }`. Send
`Accept: application/problem+json` to get RFC 9457 instead —
`{ type, title, status, detail, code, parameter?, requestId? }` with
`Content-Type: application/problem+json`.

Every event-returning route adds a `typed` field to events whose contract has
a spec and whose shape matches one of its declared events — the event's name
and its named, typed fields. It sits next to the generic `topics`/`value`,
never in place of them, and is simply absent otherwise. Typed views are
computed at read time from the stored raw XDR, so a spec fetched today applies
to events indexed last week.

### Empty pages: unknown contract vs. no events

`GET /contracts/{id}/events` distinguishes three cases that used to look alike:

| Situation | Response |
|---|---|
| The contract has never been seen (not indexed, or not a real contract) | `404` |
| The contract is indexed but nothing matches the filters | `200`, `events: []` and `emptyReason: "no_matching_events"` |
| The contract is indexed and has matching events | `200`, no `emptyReason` |

The web UI's empty state uses the distinction.

## GraphQL (optional)

Disabled by default: `/graphql` answers `404` until you start the API with
`LENS_GRAPHQL=1`. It is read-only and sits over the same `EventStore` as the REST
routes, which are untouched.

```bash
LENS_GRAPHQL=1 node packages/api/dist/bin.js
curl -s localhost:8080/graphql -H 'content-type: application/json' -d '{
  "query": "query($id: String!) { contract(id: $id) { eventCount events(limit: 3) { total events { id ledger topics { type value } } } } }",
  "variables": { "id": "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC" }
}'
```

The schema covers events, contracts and topics: `events(...)`, `event(id)`,
`contracts(limit)`, `contract(id)` and `topics(contractId, limit)`. `events`
takes the same filters as the REST routes (`topics`, `fromLedger`, `toLedger`,
`fromTime`, `toTime`, `txHash`, `address`, `search`, `successfulOnly`, `limit`,
`topicTypes`, `addressPosition`,
`cursor`, `order`) and validates them with the same code. `Event.contract`
joins an event to its contract summary; `Contract.events` and `Contract.topics`
go the other way. Queries only: mutations, subscriptions and introspection are
rejected.

**Unbounded queries are refused before the store is touched.** Every document is
analysed first and rejected with `400` if it is deeper than `maxDepth`
(`LENS_GRAPHQL_MAX_DEPTH`, default 8) or its estimated cost exceeds
`maxComplexity` (`LENS_GRAPHQL_MAX_COMPLEXITY`, default 5000). Cost counts every
field once and multiplies list fields by the number of items they can return, so
nested pagination is what gets expensive: `contracts(limit: 100) { events(limit: 100) { events { id } } }`
is far over the default, while one page of 50 events with a few fields is not.
Documents longer than 10 000 characters are refused too. Error codes appear in
`errors[].extensions.code`: `QUERY_TOO_DEEP`, `QUERY_TOO_COMPLEX`,
`QUERY_TOO_LARGE`, `GRAPHQL_PARSE_FAILED`, `GRAPHQL_VALIDATION_FAILED`,
`BAD_USER_INPUT`.

The implementation is a small hand-written parser and executor rather than
`graphql-js`, to keep the API free of new runtime dependencies.

## Webhook subscriptions (optional)

Disabled by default: the `/webhooks` routes answer `404` until you start the API
with `LENS_WEBHOOKS=1`. Enabling them makes the server send HTTP requests to
URLs that clients choose, so set `LENS_WEBHOOKS_TOKEN` too if the API is reachable
by anyone you do not trust — every `/webhooks` route then requires
`Authorization: Bearer <token>`.

```bash
curl -s localhost:8080/webhooks -H 'content-type: application/json' -d '{
  "url": "https://example.org/hooks/lens",
  "filter": { "contractId": "CDLZ…", "topics": ["transfer"] }
}'
```

The response includes a `secret`, shown only once. `filter` takes `contractId`,
`topics` (a prefix; `null` is a wildcard) and `address`, with the same meaning as
on the event routes. A new subscription receives events indexed **after** it was
registered, in order.

Each matching event is POSTed as `{ "deliveryId", "subscriptionId", "event" }` with:

| Header | Meaning |
|---|---|
| `X-Lens-Signature` | `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`, keyed with the secret. Reject old `t` values to limit replay. `verifyWebhookSignature` (exported) implements the check. |
| `X-Lens-Delivery` | Stable across retries of one delivery — de-duplicate on it. |
| `X-Lens-Event-Id` | The event id. |
| `X-Lens-Attempt` | 1-based attempt number. |

**Retries and dead letters.** A network error, timeout, `5xx`, `408` or `429` is
retried with exponential backoff (1 s, 2 s, 4 s … capped at 5 minutes, at most 5
attempts). Any other non-2xx answer, including redirects (never followed), is
final. After that the event is recorded as a dead letter —
`GET /webhooks/{id}/dead-letters` — and delivery continues with the next event,
so one dead receiver stalls only its own subscription.

**It cannot be used to flood a third party:**

- Targets must be public `http`/`https` hosts: no credentials in the URL, and no
  loopback, private, link-local, CGNAT, multicast or reserved addresses. The name
  is resolved and checked at registration *and* again on the connection that is
  actually made, which defeats DNS rebinding.
- Deliveries are rate limited per webhook (60 attempts/minute) and per target
  host across all webhooks (120/minute), and retries count against both. A
  backlog is metered out, never sent in a burst.
- At most 100 webhooks in total and 5 per host.

`LENS_WEBHOOKS_ALLOW_PRIVATE=1` lifts the private-network restriction for local
development only.

Webhooks and dead letters are held in memory: they are lost when the API
restarts, and clients re-register. The dispatcher polls the store, because the
indexer is a separate process.

## Cookbook

The [API cookbook](../../docs/api-cookbook.md) answers the questions clients
actually ask — latest transfers for a token, everything an address did, one
transaction's events, paging through a ledger range, and an incremental sync —
with copy-paste `curl | jq` recipes that run as written against `lens seed`
data. Start there before reading the spec.

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
`events` array. To page back, pass `prevCursor` as `cursor` with
`direction=backward`: paging forward and then back returns the original page
exactly. `prevCursor` is `null` on the first page. Offset pagination would skip or repeat rows while the indexer
writes behind you; this does not.

**Polling is cheap: `ETag` and `If-None-Match`.** `/events` and
`/contracts/{id}/events` send a weak `ETag` derived from the newest indexed
event id and the request's filter. Send it back as `If-None-Match` and an
unchanged poll is a `304` with no body, without running the query. These
responses are `Cache-Control: no-cache` (store, but revalidate), so a browser
sends the validator on its own. The tag tracks new events: pruning or
re-decoding rows without indexing anything new does not change it.

**Which routes are cacheable.** `GET /events/{id}` and `/openapi.json` send
`Cache-Control: public, max-age=60` (an event never changes short of a
redecode; the spec changes only with a deploy). `/events` and
`/contracts/{id}/events` are `no-cache` (ETag revalidation, above); every other
route, including `/status` and `/health`, is `no-store`. Browsers can read
`X-Request-Id` and `Retry-After` cross-origin. Responses are compressed with
`br`, `gzip` or `deflate` above 1 KB. `soroban-lens-api` opens the database
read-only, so it needs an already-migrated file (otherwise 503).

**Or don't poll: `GET /events/stream`.** A Server-Sent Events stream that takes
the same filters as `/events` (and `contractId`) and writes each newly indexed
event as it appears. Every message's `id` is the event id, so a dropped
connection resumes with `Last-Event-ID` (a browser `EventSource` does this by
itself; `?lastEventId=` is there for clients that cannot set headers) rather
than re-reading. With no `Last-Event-ID` the stream starts at the present.
The indexer is a separate process, so the API looks for new rows once per
second (not per stream) and keeps one id per stream, which is what keeps
memory flat across many streams. At most 1000 streams are open at once; more
get `503`.

**Topic filters are a positional prefix**, and `*` is a wildcard:
`?topic=transfer` matches any event whose first topic is `transfer`;
`?topic=*&topic=order` matches any event whose *second* topic is `order`.
At most four, because only four positions are indexed — but events can carry
more than four topics, so a prefix filter may need client-side narrowing to
become an exact match.

**Topic filters can be typed.** A topic filter compares the rendered value, so
the symbol `transfer` and the string `"transfer"` both match `?topic=transfer`,
as do the u32 `5` and the string `"5"` for `?topic=5`. `?topicType=` runs
parallel to `?topic=` and pins a position's ScVal type:
`?topic=transfer&topicType=symbol` excludes the string. `*` leaves a position
untyped, and a request without `topicType` behaves exactly as before.

**Address filters can be positional.** `?address=G…` matches the address
anywhere in an event. Add `?addressPosition=topic1` (or `topic2`, …, or `value`)
to ask where: for a SAC transfer, `topic1` is "transfers from" and `topic2` is
"transfers to".

**Bad parameters are rejected, not clamped.** `?limit=5000` is a `400` naming
the offending parameter, not a silently truncated page. Errors are always
`{"error":{"code","message","parameter?"}}`.

**Open by default, lockable when it is reachable.** Out of the box there is no
auth, no rate limit and `Access-Control-Allow-Origin: *`, which suits localhost.
Set `LENS_API_KEYS` to require a key (`X-API-Key` or `Authorization: Bearer`)
and `LENS_RATE_LIMIT_RPS` to cap each client IP with a token bucket; over the
limit is `429` with `Retry-After`. Both are off unless set, and an unconfigured
instance behaves exactly as before. `/health`, `/openapi.json` and `/docs` are
never gated, so probes and the spec keep working. Set `LENS_CORS_ORIGIN` to
tighten CORS. See the table below.

## Why plain `node:http`

Read-only GET routes and a regex table. A dependency-light stack is a stated
goal, and the key check, token bucket and event stream are each small enough
(see `auth.ts`, `rate-limit.ts`, `stream.ts`) not to need a framework.

## Configuration

| Flag | Env | Default |
|---|---|---|
| `--db`, `-d` | `LENS_DB_PATH` | `./data/lens.db` |
| `--port`, `-p` | `LENS_API_PORT` | `8080` |
| `--host` | `LENS_API_HOST` | `0.0.0.0` |
| `--cors` | `LENS_CORS_ORIGIN` | `*` |
| | `LENS_RATE_LIMIT_RPS` | off. Requests per second allowed per client IP. |
| | `LENS_RATE_LIMIT_BURST` | `ceil(LENS_RATE_LIMIT_RPS)`. Bucket size: requests allowed back to back. |
| | `LENS_API_KEYS` | off. Comma-separated keys; when set, data routes require one. |
| | `LENS_NDJSON_MAX_ROWS` | `1000000`. Most events one `application/x-ndjson` response carries. |
| | `LENS_TRUST_PROXY` | off. `1` to key the limiter on `X-Forwarded-For`; only behind a proxy that sets it. |
| `--shutdown-timeout` | `LENS_SHUTDOWN_TIMEOUT_MS` | `10000` |
| `--metrics-port` | `LENS_API_METRICS_PORT` | off. Serve Prometheus request metrics at `/metrics` on this separate port. |
| `--metrics-host` | `LENS_API_METRICS_HOST` | `127.0.0.1` |

### Request metrics

With a metrics port set, `/metrics` on that port (never the API port) serves
`lens_api_requests_total` and the `lens_api_request_duration_seconds`
histogram, in the same plain-text Prometheus format as the indexer's. Labels
are the matched route's pattern (`/contracts/{id}/events`, never the raw path),
the method and the status class (`2xx`…`5xx`). A path no route matches counts
under `route="unmatched"`, so unknown URLs cannot grow the series set.

On `SIGINT`/`SIGTERM` the API stops accepting connections, lets in-flight
requests finish (telling keep-alive clients to reconnect via `Connection: close`),
and only then closes the database. Requests still running after the shutdown
timeout are dropped.

## Tests

```bash
npm test -w @soroban-lens/api
```

21 tests. They boot a real HTTP server on an ephemeral port against an in-memory
store seeded from `fixtures/testnet-events.json`, so the suite exercises real
routing, status codes and JSON — no network, no mocked request objects.
