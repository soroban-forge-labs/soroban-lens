# Follow-up issues

One hundred scoped issues, twenty per module, tagged **trivial** / **medium** /
**high** by implementation effort — not by importance.

Every issue says what is wrong today, what to change, and how you know it
worked. They are grounded in code that exists: where an issue says "currently
hardcoded" or "stored but unused", that is a real line in this repo, not a
hypothetical.

**All 100 are also filed as GitHub issues, and the numbers match.** Issue #43
here is [issue #43 on GitHub](https://github.com/soroban-forge-labs/soroban-lens/issues/43).
This file is the readable index — one page, grouped by module, with the
cross-references between related issues intact. GitHub is where the discussion
and assignment happen. Labels there mirror this file: `module-1-ingest` …
`module-5-devx`, and `effort: trivial` / `medium` / `high`.

## Where to start

New here? These need one file each and have an obvious finished state:
[#13](https://github.com/soroban-forge-labs/soroban-lens/issues/13),
[#19](https://github.com/soroban-forge-labs/soroban-lens/issues/19),
[#29](https://github.com/soroban-forge-labs/soroban-lens/issues/29),
[#44](https://github.com/soroban-forge-labs/soroban-lens/issues/44),
[#61](https://github.com/soroban-forge-labs/soroban-lens/issues/61),
[#65](https://github.com/soroban-forge-labs/soroban-lens/issues/65),
[#66](https://github.com/soroban-forge-labs/soroban-lens/issues/66),
[#96](https://github.com/soroban-forge-labs/soroban-lens/issues/96) — or browse
the [`good first issue`](https://github.com/soroban-forge-labs/soroban-lens/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
label.

Want to move the needle most? **#2** (no history past ~7 days) and **#22**
(SQLite is the only backend) are the two real ceilings on what soroban-lens can
do. **#62** (the UI has no behavioural tests) is the biggest quality gap.

| Module | Issues | trivial | medium | high |
|---|---|---|---|---|
| 1 — Ingestion & RPC (`packages/ingest`) | 1–20 | 10 | 7 | 3 |
| 2 — Decoding & Storage (`packages/store`) | 21–40 | 6 | 12 | 2 |
| 3 — Query API (`packages/api`) | 41–60 | 9 | 9 | 2 |
| 4 — Web UI (`apps/web`) | 61–80 | 11 | 8 | 1 |
| 5 — Deployment, Docs & DX (Module 5) | 81–100 | 10 | 6 | 4 |
| **Total** | **100** | **46** | **42** | **12** |

If you take one, say so on the issue first — several of these overlap and two
people solving #7 and #12 independently will conflict.

---

## Module 1 — Ingestion & RPC Client (`packages/ingest`) · Person A

### 1. Prometheus metrics endpoint — `medium`

The indexer is a black box while it runs. Expose an HTTP `/metrics` endpoint in
Prometheus text format: events ingested (counter), current ledger vs. network
latest (gauges — the difference is the lag people actually want to alert on),
RPC request duration (histogram), RPC errors by kind (counter), cursor restarts
after a retention gap (counter).

Keep it dependency-free; the format is simple enough to emit by hand, and a
client library would be the first runtime dependency in this package.

**Done when:** `curl localhost:9090/metrics` returns valid Prometheus text and a
scrape config in `docs/` shows how to alert on indexer lag.

### 2. Backfill from an archive source — `high`

RPC nodes retain ~7 days. Anything older is permanently unavailable, so a
contract deployed months ago cannot be fully indexed today — the largest
functional gap in v0.1.

Add an ingestion source that reads history from Stellar's public ledger archives
rather than from `getEvents`. Verify the current archive layout against the
official docs before designing this. It needs to share the cursor model with the
RPC poller so a backfill and a live tail can run against one database.

**Done when:** a contract with history older than the retention window can be
indexed from its first event, and `lens doctor` reports which source covers
which ledger range.

### 3. Handle ledger reorgs — `medium`

Events are written as they arrive and never revisited. Stellar's consensus makes
deep reorgs very unlikely, but "very unlikely" is not "impossible", and right
now a reorg would leave permanently wrong rows with no way to detect them.

Re-poll the most recent N ledgers on each cycle and compare event ids against
what is stored. Deletions and changes should be logged loudly; N should be
configurable and default to something small.

**Done when:** a test using a scripted fake RPC that changes history proves the
stored rows converge on the new truth.

### 4. Expose system events — `trivial`

`buildFilters()` in `rpc-client.ts` hardcodes `type: 'contract'`. `RawEvent.type`
already allows `'system'`, and the RPC serves both, so system events are
silently unreachable through this package.

Thread an event-type option through `PollerOptions` and add `--type` to the
ingest CLI.

**Done when:** `--type system` streams system events and the default behaviour
is byte-for-byte unchanged.

### 5. Expose topic filters on the CLI — `trivial`

`PollerOptions.topics` and `buildFilters()` both support topic filtering, and
`bin.ts` never passes it. Server-side topic filtering is the cheapest way to cut
ingestion volume and it is currently unreachable from the command line.

Add a repeatable `--topic` flag taking base64 ScVals or `*`.

**Done when:** `--topic <base64> --topic '*'` reaches the RPC filter, and the
help text explains the 4-segment ceiling.

### 6. Expose retry tuning — `trivial`

`RetryOptions` supports `attempts`, `baseDelayMs` and `maxDelayMs`. None are
reachable from the CLI or environment, so the defaults are effectively hardcoded
for every operator regardless of how flaky their RPC provider is.

**Done when:** `--retry-attempts`, `--retry-base-delay` and `--retry-max-delay`
work and are documented in `.env.example`.

### 7. Expose custom RPC headers — `trivial`

`RpcClientOptions.headers` exists because commercial RPC providers authenticate
with a header, but nothing surfaces it. Anyone using a paid provider has to
patch the source.

Add `--rpc-header 'Name: value'` (repeatable) and `LENS_RPC_HEADERS`.

**Done when:** an authenticated provider works without code changes, and the
header values are redacted in logs and in `lens doctor` output.

### 8. Validate contract ids before the first RPC call — `trivial`

`lens doctor` validates contract id shape, but the ingest package does not.
Running `soroban-lens-ingest -c GABC…` sends a doomed request and surfaces
whatever the RPC says, which is usually less clear than "that is an account id".

**Done when:** malformed ids fail before any network call, with the same message
`lens doctor` gives.

### 9. Add `--end-ledger` — `trivial`

`GetEventsArgs.endLedger` is plumbed through the client and never exposed.
Indexing a bounded historical range — a single incident, a single day — means
watching the log and killing the process.

**Done when:** `--end-ledger N` exits cleanly once the range is exhausted, and
combining it with `--cursor`-based resume is rejected with a clear error.

### 10. Report ingestion lag in `PollerProgress` — `trivial`

`PollerProgress` carries `ledger` and `latestLedger`; every consumer computes
the difference itself. Put `lagLedgers` and an estimated `lagSeconds` (ledgers ×
~5s) on the struct so the CLI, the metrics endpoint (#1) and the API agree on
one definition.

**Done when:** all three report the same number, and the estimate is documented
as an estimate.

### 11. Dedupe within a batch before yielding — `trivial`

Deduplication happens at the storage layer via `INSERT OR IGNORE`. Any consumer
that is not Module 2 — the NDJSON stdout path, for one — sees duplicates after a
replay and has to handle them itself.

Track ids seen in the current cursor window and drop repeats before yielding.

**Done when:** a replayed batch emits each event once on stdout, and storage
dedup still works as the backstop.

### 12. Multiple RPC endpoints with failover — `high`

One `rpcUrl`, so a provider outage stops ingestion entirely until a human
notices. This is the single biggest operational weakness for anyone running
soroban-lens unattended.

Accept an ordered list, health-check them, fail over on repeated errors, and
fail back when the primary recovers. Cursors are provider-specific in principle,
so verify that a cursor from one node is accepted by another before assuming it
is portable — if it is not, failover has to fall back to a ledger number.

**Done when:** killing the primary endpoint mid-stream continues ingestion
against the secondary with no gap and no duplicates.

### 13. Honour `429` and `Retry-After` — `trivial`

`withRetry` treats every failure identically with full-jitter backoff. A
rate-limited provider tells you exactly how long to wait in `Retry-After`, and
ignoring it means backing off either too little (more 429s) or too much.

**Done when:** a `429` carrying `Retry-After` waits precisely that long, and a
test with a scripted client proves it.

### 14. Adaptive page size — `medium`

`pageSize` is fixed at 200. A quiet contract wastes round trips; a busy one
could pull 10 000 per request. Neither is knowable in advance.

Grow the page size while pages come back full and fast, shrink it on timeouts or
slow responses, within configured bounds.

**Done when:** a benchmark shows fewer round trips on a busy contract with no
increase in error rate, and the bounds are configurable.

### 15. Parallelise across filter chunks — `medium`

`buildFilters()` splits more than five contract ids across multiple filters, but
`getEvents` sends them in one request and the poller advances one cursor. For
large contract sets this serialises work that could overlap.

Investigate whether per-chunk cursors are workable; if they are, poll chunks
concurrently with a bounded pool.

**Done when:** indexing 25 contracts is measurably faster, ordering guarantees
are documented, and the single-contract path is unchanged.

### 16. Structured JSON logging — `medium`

Logging is freeform strings through a `log(message: string)` callback. Useful to
a human watching a terminal, useless to anything parsing it.

Move to structured records (level, event, ledger, cursor, duration) with a text
renderer for humans and JSON for `LENS_LOG_FORMAT=json`.

**Done when:** `LENS_LOG_FORMAT=json` emits one JSON object per line, the
default output is unchanged, and the store and API use the same logger.

### 17. Persist and compare retention state — `medium`

`LensRpcClient.retention()` returns `latestLedger`/`oldestLedger`, and the two
close-time fields are returned as empty strings — a stub that looks like data.
Either populate them from `getHealth` or drop them from the type.

Then persist the observed window so a restart can say "this node moved its
oldest ledger past your cursor while you were down" rather than discovering it
mid-stream.

**Done when:** `RetentionState` has no fake fields, and restarting after a long
outage warns about the gap before any events are fetched.

### 18. Detect clock skew — `medium`

`ledgerClosedAt` is trusted as-is and converted to a Unix timestamp on insert. A
badly skewed local clock silently produces nonsense in any time-based query
built on it (#40), and nothing notices.

Compare local time against `latestLedgerCloseTime` at startup and warn beyond a
threshold.

**Done when:** `lens doctor` reports skew, and a skew over the threshold is a
warning rather than a silent wrong answer.

### 19. Warn when a page hits the RPC ceiling — `trivial`

A response of exactly `limit` events is treated purely as "not caught up". It
can also mean the request straddled a ledger with more events than the page
size, which is worth knowing when tuning #14.

**Done when:** hitting the 10 000 ceiling logs a distinct warning naming the
ledger.

### 20. Integration test against a local quickstart node — `high`

Every ingest test uses a scripted fake client. That is the right call for
retention-gap and reorg simulation, but it means no test has ever exercised a
real JSON-RPC round trip, real XDR off the wire, or a real cursor.

Add an opt-in suite against `stellar/quickstart` in Docker, deploying a tiny
contract and asserting its events are indexed. Keep it out of the default `npm
test` so the offline guarantee holds.

**Done when:** `npm run test:integration` passes locally and in a nightly CI
job, and the default suite still needs no network.

---

## Module 2 — Decoding & Storage (`packages/store`) · Person B

### 21. Prune command and retention policy — `trivial`

An indexer left running on a busy contract grows without bound, and there is no
supported way to prune.

Add `pruneBefore(ledger: number): Promise<number>` to `EventStore`, implement it
for SQLite (delete plus `VACUUM`), and expose it as `lens prune --before-ledger`.

**Done when:** pruning reduces the file size on disk, and a test confirms rows
below the threshold are gone while the stream cursor is untouched.

### 22. Postgres storage backend — `high`

SQLite is the right default and the wrong choice for several indexers writing
concurrently, or for a dataset past a few tens of GB.

Implement `EventStore` against Postgres. The trait exists precisely for this, so
no code above Module 2 should change. Reuse `decodeEvent()` — decoding is
backend-independent. Port the migrations, and use `JSONB` for `topics_json` and
`value_json` so topic containment queries can be indexed with GIN.

**Done when:** the existing store suite passes against both backends from one
parameterised run (#38), and `docker-compose.postgres.yml` demonstrates it.

### 23. Index events by decoded address — `medium`

"Every transfer involving account G…" is the single most common question people
ask of a contract, and today it needs a full scan plus client-side filtering.

Addresses appear in topics *and* nested inside values. Extract every address
from a decoded event into a side table (`event_id`, `address`, `position`) and
add a query filter for it.

**Done when:** `GET /events?address=G…` returns every event mentioning that
address anywhere, and a benchmark over ≥1M rows shows it uses the index.

### 24. Use `closed_at_unix` for time queries — `trivial`

The column is populated on every insert and read by nothing. `EventQuery` has no
time bounds at all, so "events from last Tuesday" means converting timestamps to
ledger numbers by hand.

Add `fromTime`/`toTime` to `EventQuery`, backed by the existing column, and
index it.

**Done when:** time-bounded queries work end to end, or the column is dropped in
a migration — either is better than a field that only looks useful.

### 25. Re-decode rows that failed to decode — `medium`

`decodeEvent()` deliberately never throws: a bad event is stored with
`decodeError` set and its raw XDR intact, explicitly so it can be re-decoded
after a fix. Nothing implements the re-decoding.

Add `lens redecode` that re-runs the decoder over rows with `decode_error IS NOT
NULL` (and optionally over everything, after a decoder change).

**Done when:** a deliberately corrupted row is repaired in place after the
decoder is fixed, without re-indexing from the network.

### 26. Cache the total count — `medium`

`queryEvents` runs `COUNT(*)` with the full `WHERE` clause on every single
request, alongside the page query. On a large table that dominates the response
time, and the UI displays the number in a place where approximate is fine.

Cache per filter with a short TTL, or return an estimate above a threshold and
mark it as one.

**Done when:** a benchmark over ≥1M rows shows a large drop in query time, and
the API tells clients when a count is estimated.

### 27. Batch insert performance — `medium`

`insertDecoded` runs one `stmt.run()` per event inside a transaction. That is
correct, and it is not obviously fast. Nobody has measured it.

Benchmark it, then try multi-row `VALUES` batching and `PRAGMA` tuning.

**Done when:** a documented benchmark exists and either shows a real improvement
or records that the current approach is already fine — a measurement either way
is the deliverable.

### 28. WAL checkpoint management — `medium`

WAL mode is on with no checkpoint policy. A continuously-writing indexer with a
long-lived reader can grow `-wal` without bound, which looks like a disk leak.

Add periodic `wal_checkpoint(TRUNCATE)` and expose WAL size in stats.

**Done when:** a long soak test shows the WAL file staying bounded.

### 29. Report database size in `getStats` — `trivial`

`StoreStats` has counts and ledger ranges but nothing about size on disk, which
is the first thing anyone asks when a volume fills up.

Add `sizeBytes` (and WAL size, alongside #28), and surface it in `lens stats`
and `GET /stats`.

**Done when:** the reported size matches `du` on the database file.

### 30. Add a `countByTopic` aggregate — `trivial`

`listTopics` already groups by `topic0` for one contract. There is no global
equivalent, so "what event types exist across everything indexed" requires
paging the whole table.

**Done when:** `EventStore.countByTopic()` exists and `GET /stats` includes the
top topics across all contracts.

### 31. Query by transaction and operation index — `trivial`

`transaction_index` and `operation_index` are stored and indexed by nothing.
`EventQuery` cannot filter on them, so reconstructing the exact event order
inside one transaction means fetching by `txHash` and sorting client-side.

**Done when:** both are filterable, and `GET /events?txHash=…&operationIndex=0`
works.

### 32. Full-text search over decoded values — `medium`

Finding an event by something inside its payload means fetching and scanning
client-side.

Add an SQLite FTS5 virtual table over the decoded JSON, kept in sync by trigger,
and a `search` query parameter.

**Done when:** searching a substring of a decoded value returns the right events
on a table of ≥1M rows in reasonable time, and the index rebuild is documented.

### 33. Store contract specs for typed decoding — `high`

Events decode to generic ScVal shapes: a map with keys, a vec of values. With
the contract's spec, `{"amount":"100","to":"G…"}` could carry real field names
and types.

Fetch and store contract specs, then offer spec-aware decoding as an additional
view that never replaces the generic one.

**Done when:** an event from a contract with a known spec shows named, typed
fields, and a contract without a spec is unaffected.

### 34. Handle ScVal arms `scValToNative` does not cover — `medium`

`decodeScVal` derives its type tag from the constructor name and delegates the
value to `scValToNative`. Protocol upgrades add arms. Today an unknown arm
either throws into `decodeError` or produces something unhelpful, and we would
find out from a user.

Enumerate the arms in the current XDR definitions, add a test asserting each one
decodes, and make unknown arms degrade to a documented shape.

**Done when:** every arm in the current protocol has a decode test, and a new
arm produces a clear `decodeError` rather than a crash.

### 35. Compress the raw XDR columns — `medium`

`value_xdr` and `topics_xdr_json` store base64 — roughly a third larger than the
bytes they encode — and are read rarely, mostly by the UI's "Raw XDR" panel.

Store them as compressed blobs and decompress on read.

**Done when:** a documented benchmark shows the size reduction and quantifies
the read cost, so the trade can be judged rather than assumed.

### 36. Index `indexed_at` — `trivial`

The column is written on every row and has no index, so "what did we ingest in
the last hour" — the natural question when debugging a stalled indexer — is a
full scan.

**Done when:** the index exists in a new migration and a query ordering by
`indexed_at` uses it.

### 37. Snapshot export and import — `medium`

Sharing an indexed dataset, or seeding a new instance from an old one, means
copying the SQLite file and hoping nothing was mid-write.

Add `lens export` / `lens import` using SQLite's backup API (or `VACUUM INTO`)
for a consistent snapshot, in a format that survives a backend change.

**Done when:** a snapshot taken while the indexer is running restores to an
identical event set.

### 38. Parameterised suite for any `EventStore` — `medium`

`test/sqlite-store.test.js` is written against the trait but instantiates
`SqliteEventStore` directly, so a second backend (#22) cannot reuse it without a
copy-paste.

Extract the behavioural assertions into a suite taking a factory.

**Done when:** one exported function validates any `EventStore`, SQLite runs
through it, and the Postgres work can adopt it unchanged.

### 39. Detect and repair corrupt rows — `medium`

Nothing verifies that stored rows are internally consistent —
`topics_json` matching `topic_count`, `topic0..3` matching `topics_json`, JSON
columns parsing at all.

Add `lens verify` to check invariants and report (with `--repair` to recompute
derived columns from the raw XDR).

**Done when:** a row with a hand-corrupted `topic0` is detected and repaired.

### 40. Migration rollback — `medium`

Migrations are forward-only. A bad migration on a production database currently
has no supported path back except restoring a backup.

Add optional `down` SQL and `lens migrate --down --to <version>`, with the
append-only rule for `up` unchanged.

**Done when:** a migration can be applied and rolled back in a test, and the
docs say plainly which migrations are irreversible.

---

## Module 3 — Query API (`packages/api`) · Person C

### 41. CSV export — `trivial`

Getting indexed events into a spreadsheet or a pandas notebook currently means
writing a jq incantation.

Support `Accept: text/csv` and `?format=csv` on both event-list routes. Flatten
topics to `topic0..topicN` columns and the value to its JSON text. Stream the
response rather than buffering — an export can be far larger than a page.

Quote `i128` values so spreadsheets do not coerce them into floats and destroy
the precision the API went out of its way to preserve.

**Done when:** `curl -H 'Accept: text/csv' …/events > out.csv` opens correctly,
and a test asserts large integers survive a round trip.

### 42. Server-sent events for live updates — `medium`

The UI polls every 5 seconds: latency nobody wants and load nobody needs.

Add `GET /events/stream` as an SSE endpoint accepting the same filters, emitting
each new event as it is indexed. Include the last event id in each message so a
dropped connection can resume with `Last-Event-ID` rather than re-reading.

**Done when:** the UI switches to SSE with polling as a fallback, and the server
handles 100 concurrent streams without unbounded memory growth.

### 43. Rate limiting and optional API keys — `medium`

The API is unauthenticated with `Access-Control-Allow-Origin: *`. That is a
reasonable default for localhost and an unreasonable one for anything reachable.

Add a token-bucket limiter keyed by client IP, plus optional API keys via
`LENS_API_KEYS`. Both off by default — the local experience must not regress.
Return `429` with `Retry-After`, and document the whole thing in `openapi.json`
with a `security` scheme.

**Done when:** a load test confirms limits are enforced, keys gate access when
configured, an unconfigured instance behaves exactly as today, and
`security-defined` can be re-enabled in `redocly.yaml`.

### 44. Response compression — `trivial`

Every response is uncompressed JSON. A 1000-event page is largely repeated field
names and base64, which gzip handles extremely well.

Add gzip/deflate based on `Accept-Encoding`, using `node:zlib`, with a minimum
size threshold.

**Done when:** a large page is materially smaller over the wire and a client
sending no `Accept-Encoding` still gets valid JSON.

### 45. Serve interactive API docs — `trivial`

`/openapi.json` is served as raw JSON. Newcomers get a wall of text where a
browsable page would answer their question.

Serve Redoc or Swagger UI at `/docs`, pinned to a CDN version — with the
existing CSP-free posture this is a `<script src>` and a div.

**Done when:** `/docs` renders the live spec and the quickstart links to it.

### 46. Structured request logging with request ids — `trivial`

The access log is a formatted string, and nothing correlates a client error
report with a server-side log line.

Generate a request id, return it as `X-Request-Id`, include it in every log
record for that request, and share the structured logger from #16.

**Done when:** an error response carries an id that finds every related log line.

### 47. ETag and conditional requests — `medium`

The UI re-fetches the same first page every 5 seconds, and the server serialises
and sends it in full every time even when nothing changed.

Emit an `ETag` derived from the newest event id and the filter, and honour
`If-None-Match` with `304`.

**Done when:** an unchanged poll returns `304` with no body, and the UI's
polling traffic drops sharply.

### 48. `prevCursor` for backwards pagination — `medium`

Pagination is forward-only: `nextCursor` and nothing else. A UI that has paged
forward cannot page back without re-walking from the start.

Add `prevCursor` to `EventPage`, and support a direction flag in the store's
keyset query.

**Done when:** paging forward then back returns the original page exactly, with
a test walking both directions.

### 49. `/contracts/{id}/stats` — `trivial`

Getting one contract's event count, ledger range and last-seen time means
fetching `/contracts` and filtering client-side. `listContracts` already
computes exactly this per contract.

**Done when:** the route returns that summary and 404s for a contract with no
indexed events (see #58).

### 50. Batch fetch events by id — `trivial`

`GET /events/{id}` is one round trip per event. A client resolving a list of ids
— from a log, from an export — makes N requests.

Add `GET /events?ids=a,b,c` with a documented ceiling.

**Done when:** a batch request returns the events in the order asked, with
missing ids reported rather than silently dropped.

### 51. `HEAD` support — `trivial`

The router matches on exact method, so `HEAD /health` returns `405` where any
HTTP client would expect the `GET` headers with no body. Monitoring tools use
`HEAD` routinely.

**Done when:** `HEAD` works on every `GET` route, returning identical headers
and an empty body.

### 52. Sparse field selection — `medium`

Every response includes `topicsXdr` and `valueXdr`, which roughly double the
payload and which most clients never read — the UI shows them only in a
collapsed panel.

Add `?fields=` to select which to return, defaulting to everything for
compatibility.

**Done when:** `?fields=id,ledger,topics,value` measurably shrinks the response
and the default is unchanged.

### 53. Time-bucketed aggregate endpoint — `medium`

Answering "how many events per hour this week" means paging every event and
counting client-side.

Add `GET /contracts/{id}/activity?bucket=hour&from=…&to=…` returning counts per
bucket, built on #24.

**Done when:** the endpoint returns correct counts and #75's chart is built on
it rather than on raw events.

### 54. Publish a generated client to npm — `medium`

The README tells people to generate their own client from `openapi.json`. That
is fine, and a published, versioned package is what most people actually want.

Generate a typed TS client in CI and publish it alongside the release (#83).

**Done when:** `npm i @soroban-lens/client` gives a typed client whose version
tracks the spec, and drift fails CI.

### 55. Configurable query limit — `trivial`

`MAX_QUERY_LIMIT` is a hardcoded 1000. An operator running this on a big machine
for internal use has no way to raise it; the API rejects the request with a
message about a constant they cannot change.

**Done when:** `LENS_MAX_QUERY_LIMIT` works, defaults to 1000, and is reflected
in the served spec.

### 56. Graceful shutdown that drains requests — `medium`

`SIGTERM` calls `server.close()` and then closes the store, without waiting for
in-flight handlers. Under load a rolling restart can close the database out from
under a request being served.

Track in-flight requests, stop accepting new ones, drain with a timeout, then
close.

**Done when:** a restart under sustained load produces zero failed responses.

### 57. `503` with `Retry-After` during migrations — `trivial`

If the schema is behind, `/health` reports `degraded` while every data route
keeps serving from a half-migrated database.

Return `503` with `Retry-After` from data routes while a migration is pending.

**Done when:** a store at an older schema version serves `503` on data routes
and still answers `/health` with the reason.

### 58. Distinguish "no such contract" from "no events" — `medium`

`GET /contracts/{id}/events` returns an empty page for a contract that is not
indexed, for a contract that is indexed but quiet, and for a valid id that has
never existed. Three very different situations, one response.

Return `404` when the contract has never been seen, and an empty page with an
explanatory field when it is known but has no matching events.

**Done when:** the three cases are distinguishable, and the UI's empty state
(#78) uses the distinction.

### 59. Webhook subscriptions — `high`

Reacting to an event means polling. Every consumer reimplements the same loop.

Let clients register a URL plus filter, and POST matching events to it with
retries, a signature header, and a dead-letter record after repeated failure.

**Done when:** a registered webhook receives matching events, survives a
receiver being down, and cannot be used to make the server flood a third party.

### 60. GraphQL endpoint — `high`

The REST shape is fixed. Clients wanting one field per event, or events joined
to contract summaries, over-fetch or make several calls.

Add an optional `/graphql` over the same `EventStore`, disabled by default.
Guard against unbounded queries with depth and complexity limits.

**Done when:** the schema covers events, contracts and topics, REST is
untouched, and a query-complexity test proves the limits hold.

---

## Module 4 — Web UI (`apps/web`) · Person D

### 61. Dark mode — `trivial`

The CSS already uses custom properties on `:root`, so this is mostly one
`@media (prefers-color-scheme: dark)` block redefining the palette.

Add an explicit toggle as well — respecting the system setting is right by
default, but people reading a terminal-adjacent tool often want to override it.
Persist the choice in `localStorage` next to the existing UI state.

**Done when:** both themes are legible (contrast ≥ 4.5:1 for body text), the
toggle overrides the system setting in both directions, and there is no flash of
the wrong theme on load.

### 62. Component tests — `medium`

The UI has no test runner. `npm test` runs the production build, which
type-checks but proves nothing about behaviour. **This is the most valuable
contribution anyone could make to this module.**

Add Vitest with Testing Library. Cover the cases most likely to break quietly:
`summarise()` and `truncate()`, the topic-prefix query builder, row expansion,
the request-versioning logic that stops a slow response overwriting a newer one,
and the network-mismatch warning.

**Done when:** `npm test -w @soroban-lens/web` runs real component tests in CI
and covers each item above.

### 63. Shareable URLs and deep links — `medium`

Filter state lives in `localStorage`, so you cannot send a colleague a link to
what you are looking at — the main thing anyone wants from an explorer.

Move contract, topic, network and expanded-event state into the query string,
with `localStorage` only as the fallback for a bare visit. Add `/events/{id}` as
a route that opens that event expanded.

**Done when:** copying the URL reproduces the exact view in a fresh browser, and
back/forward move through filter history.

### 64. Virtualise the table — `medium`

"Load more" appends 50 rows at a time into a plain `<table>` with no ceiling.
Several thousand rows of expandable DOM will make scrolling miserable, and it is
easy to get there on a busy contract.

Add row virtualisation, keeping expansion and keyboard navigation (#69) working.

**Done when:** 10 000 loaded rows scroll smoothly, with a measurement recorded.

### 65. Copy buttons for ids and hashes — `trivial`

Contract ids, tx hashes and event ids are displayed truncated with the full
value in a `title` attribute. Copying one means expanding the row and selecting
text precisely — and a mis-selected 56-character StrKey is a silent wrong query.

Add copy-to-clipboard buttons with visible confirmation.

**Done when:** every truncated identifier can be copied in one click, including
from the collapsed row.

### 66. Link out to a block explorer — `trivial`

The UI shows a tx hash and stops. Investigating almost always means going to
Stellar Expert or Horizon, which right now is copy, switch tab, paste.

Add per-network outbound links for transactions, contracts and accounts, driven
by a config map so self-hosted explorers work too.

**Done when:** transaction and contract links open the right page for the
selected network, and an unknown network simply shows no link.

### 67. Absolute vs relative timestamps — `trivial`

Rows show only `relativeTime()` — "3h ago". Correlating with a log or a support
ticket needs the actual timestamp, which today means expanding the row.

Add a toggle, and a `title` with the exact time on the relative form.

**Done when:** the toggle switches every row, persists, and the exact time is
always available on hover.

### 68. Ledger range filter in the UI — `trivial`

`fromLedger`/`toLedger` work in the store and the API and appear nowhere in the
interface, so narrowing to an incident window means hand-writing a curl.

**Done when:** ledger bounds are settable in the UI, validated as integers, and
included in the shareable URL from #63.

### 69. Keyboard navigation — `medium`

Rows are `<tr>` elements with an `onClick`. There is no `tabindex`, no `role`,
and no key handling, so the table is unusable without a mouse and invisible to
assistive technology.

Make rows focusable, support arrow keys, Enter/Space to expand, Escape to
collapse, and `/` to focus the contract field.

**Done when:** the whole table is operable from the keyboard, with correct
`aria-expanded` and focus management.

### 70. Accessibility audit — `medium`

Beyond #69: colour contrast has never been measured, the live-updating table has
no `aria-live` announcement, and the topic chips inside clickable rows are
nested interactive controls.

Run axe, fix what it finds, and add a CI check.

**Done when:** axe reports no violations on the main view in both themes, and
the check runs in CI.

### 71. Export the current view — `trivial`

Getting the filtered set out means rebuilding the same filters against the API
by hand.

Add an export button producing CSV or JSON for the current filters, using #41.

**Done when:** the export matches exactly what the filters describe — not just
the rows currently loaded — and says so if it is truncated.

### 72. Error boundary — `trivial`

One render error in `EventRow` — an unexpected payload shape from an unusual
contract — unmounts the whole app and leaves a blank page with no explanation.

Add an error boundary with a readable fallback and a reload affordance.

**Done when:** a component throwing on one row leaves the rest of the page
usable, and the error is visible rather than silent.

### 73. Loading skeletons — `trivial`

The empty state renders the word "Loading…", so switching contracts flashes an
empty box. It reads as "nothing here" rather than "working".

Add skeleton rows, and keep previous results visible while refetching.

**Done when:** changing filters no longer flashes an empty table.

### 74. Contract picker — `trivial`

The contract field is free text, while `/contracts` already lists everything
indexed with event counts. New users have to find a contract id elsewhere before
the tool shows them anything.

Add a dropdown of indexed contracts, keeping free text for anything else.

**Done when:** a user with a populated database can pick a contract without
typing, showing counts and last activity.

### 75. Activity chart — `medium`

Spotting a burst or a gap means reading timestamps down a table.

Add a small events-per-bucket chart above the table, backed by #53, with
click-to-filter on a bucket.

**Done when:** the chart matches the active filters and clicking a bucket
narrows the ledger range.

### 76. Keep rows expanded when they leave and re-enter the page — `trivial`

`EventRow` keeps `expanded` in its own `useState`. Rows are keyed by `event.id`,
so React does preserve that correctly across a live refresh — the state is only
lost when the component unmounts.

Which it does, routinely: `loadFirstPage` replaces the whole list every 5
seconds, so on a busy contract an expanded row gets pushed off the first page by
newer events, unmounts, and silently returns collapsed. Changing a filter and
changing back does the same.

Lift expansion into a set of event ids held by the parent.

**Done when:** a row expanded, then pushed off the first page by new events,
then brought back into view, is still expanded.

### 77. Bundle size budget — `trivial`

The bundle is ~236 kB and nothing watches it. A casual dependency could double
it and nobody would notice until a user on a slow link complained.

Add a CI check against a committed budget.

**Done when:** exceeding the budget fails CI with the before/after sizes.

### 78. Honest empty and error states — `medium`

The empty state guesses: it shows "Nothing indexed yet" whenever the store is
empty, even when the real cause is a filter matching nothing, an unreachable
API, or an indexer still working through history.

Use `/status` and #58 to tell the user which of those it actually is, and what
to do about each.

**Done when:** all four states produce distinct, accurate messages.

### 79. Internationalisation scaffolding — `medium`

Every string is inline in JSX. Translating anything means touching every
component, so in practice nobody will.

Extract strings into a catalogue with a minimal `t()` and a locale switch.
English only to start — the point is that the second language is cheap.

**Done when:** no user-facing string is inline, and a stub locale demonstrates
switching.

### 80. Compare two events side by side — `high`

Debugging "why did this call behave differently from that one" means expanding
two rows far apart and scrolling between them.

Add multi-select and a diff view highlighting differing topics and value fields,
with structural diffing for maps and vecs.

**Done when:** two events can be compared with differences highlighted, and the
comparison is linkable via #63.

---

## Module 5 — Deployment, Docs & DX (`packages/cli`, `deploy/`, `docs/`) · Person E

### 81. `lens doctor --fix` for common failures — `trivial`

Doctor diagnoses and then leaves you to it. Several failures have one obvious
remedy: create a missing data directory, run pending migrations, write a `.env`
from `.env.example`.

Add `--fix` to apply exactly those, printing each action. Never touch anything
destructive, and never guess at network configuration.

**Done when:** a fresh clone with no `.env` and no `data/` reaches all-green
from a single `lens doctor --fix`.

### 82. Multi-network compose profile — `medium`

Running testnet and mainnet side by side is a supported idea — the UI has a
network switcher — but nothing in `deploy/` sets it up, so the switcher ships
with one entry.

Add compose profiles running a second indexer/API pair against mainnet on a
separate volume and port, with `LENS_WEB_NETWORKS` wired to both. Document that
mainnet needs a user-supplied `LENS_RPC_URL`.

**Done when:** `docker compose --profile mainnet up` yields a UI whose switcher
moves between two live networks.

### 83. Publish images and a release workflow — `high`

Installing means cloning and building. There is no released artifact, so there
is no way to pin a version or roll one back.

Add a tag-triggered workflow that builds multi-arch images (amd64 + arm64),
publishes to GHCR, publishes the packages to npm, generates a changelog from
conventional commits, and attaches the OpenAPI spec to the GitHub release.
Provide a `docker-compose.release.yml` that pulls published images rather than
building.

**Done when:** `docker compose -f docker-compose.release.yml up` works on a
machine that has never cloned the repo, on both architectures.

### 84. Healthcheck for the indexer container — `trivial`

The `api` service has a healthcheck; `indexer` has none. A wedged indexer that
has not advanced its cursor in an hour still reports as `Up`, which is the exact
failure most worth catching.

Add a healthcheck comparing the stored cursor's `updatedAt` against a threshold.

**Done when:** an indexer that stops advancing is reported unhealthy, and a
legitimately quiet contract is not.

### 85. Check disk space in `lens doctor` — `trivial`

Doctor checks that the data directory is writable, not that there is room. A
volume with 10 MB free passes every check and then fails at 3am.

Warn below a configurable threshold, and include the current database size
(#29).

**Done when:** a nearly-full volume produces a warning with the numbers, and
`--fix` never tries to delete anything.

### 86. `lens tail` — follow events in the terminal — `medium`

Watching events live means running the API and opening a browser. For someone
already in a terminal deploying a contract, that is a lot of ceremony.

Add `lens tail` that follows new events for a contract with readable
colourised output, `--json` for piping, and the same filters as the API.

**Done when:** `lens tail -c C… --topic transfer` prints matching events as they
are indexed, and `--json | jq` works.

### 87. Shell completions — `trivial`

The CLI has a lot of flags and no completion, so `--start-ledger` versus
`--startLedger` is a guess every time.

Generate bash, zsh and fish completions via `lens completions <shell>`.

**Done when:** completions work in all three shells and installation is
documented.

### 88. Issue and PR templates — `trivial`

CONTRIBUTING.md asks for the module and the user-visible symptom. Nothing
prompts for either at the moment someone files, so most reports will omit them.

Add `.github/ISSUE_TEMPLATE/` forms for bug and feature, a PR template with the
module-prefix convention, and `CODEOWNERS` matching the ownership map.

**Done when:** filing an issue prompts for module, network and version, and
`CODEOWNERS` routes reviews to the right owner.

### 89. Dependency update automation — `trivial`

Dependencies are pinned and nothing watches them. `@stellar/stellar-sdk` tracks
protocol releases closely, so this project goes stale faster than most.

Add Renovate or Dependabot, grouping dev dependencies and flagging SDK updates
individually for review.

**Done when:** update PRs open automatically and run the full CI suite.

### 90. Security scanning in CI — `trivial`

No CodeQL, no `npm audit`, no image scanning — on a public repo that ingests
untrusted data from the network.

Add CodeQL for JS/TS, `npm audit` at a sensible threshold, and Trivy on the
built images.

**Done when:** all three run on pull requests and a known-vulnerable dependency
fails the build.

### 91. Backup and restore — `medium`

`docs/troubleshooting.md` explains how to delete everything and start over. It
says nothing about keeping anything, and re-indexing cannot recover data past
the retention window — so a lost volume can be permanent data loss.

Document a backup procedure using #37, add `lens backup`/`lens restore`, and
cover the Docker volume case.

**Done when:** a documented procedure restores a working instance from a backup
taken while the indexer was running.

### 92. Shrink the runtime image — `medium`

`Dockerfile.node` is single-stage: source, dev dependencies and the TypeScript
compiler all ship in the final image. The web image is already multi-stage and
much smaller.

Split build and runtime, copying only `dist/` and production dependencies.

**Done when:** the image is substantially smaller with the before/after recorded,
and all four services still work.

### 93. Log rotation and retention guidance — `trivial`

The indexer logs a line per batch, forever, with no rotation configured and no
mention of it in the docs. On a busy contract that fills a disk.

Configure compose logging limits and document the systemd and Kubernetes cases.

**Done when:** the default compose setup cannot fill a disk with logs, and the
docs say how to change it.

### 94. Architecture decision records — `medium`

`docs/architecture.md` explains the current design well. It does not record what
was rejected, so every future contributor re-litigates SQLite, polling, and the
duplicated `RawEvent` type from scratch.

Add short ADRs for the decisions already made, and a template for new ones.

**Done when:** each major decision has an ADR stating the alternatives and why
they lost.

### 95. Systemd units — `trivial`

Docker and bare `npm run` are documented. Running this as a service on a plain
VM — a very normal thing to want — is left as an exercise.

Add `deploy/systemd/` units for indexer and API, with hardening directives and
an install guide.

**Done when:** both services install, start on boot, restart on failure, and run
unprivileged.

### 96. Screenshot and demo in the README — `trivial`

The README describes a UI that nobody can see without cloning and building.
For a public repo, that is the difference between a project people try and one
they scroll past.

Add a screenshot and a short demo GIF of indexing a testnet contract.

**Done when:** the README shows the UI above the fold and the images are
committed at a sensible size.

### 97. Kubernetes manifests and a Helm chart — `high`

Compose is the only supported deployment. Anyone running this alongside other
infrastructure has to write their own manifests from the Dockerfiles.

Provide manifests and a chart covering the indexer Deployment, the API
Deployment with an HPA, a PVC (or Postgres from #22), and config via ConfigMap
and Secret.

**Done when:** `helm install` produces a working instance on a test cluster, and
the chart is linted in CI.

### 98. Benchmark suite and performance CI — `high`

Several issues here promise "a benchmark shows…" and there is no harness to
write one in, so those claims cannot be checked and performance can regress
invisibly.

Build a suite with a generated dataset of ≥1M events covering insert throughput,
query latency by filter, and API response times, reporting against a baseline.

**Done when:** `npm run bench` produces comparable numbers, CI tracks them, and
a significant regression is flagged on the PR.

### 99. Terraform module for a cloud deploy — `high`

Going from laptop to a hosted instance means hand-building everything.

Provide a module for at least one provider covering compute, persistent storage,
networking and secrets, with the mainnet RPC URL as a required input.

**Done when:** `terraform apply` yields a reachable instance, and `destroy`
leaves nothing behind.

### 100. Documentation site — `medium`

Docs are four markdown files plus seven READMEs. That is genuinely fine to read
on GitHub, and it has no search, no versioning and no API reference alongside
the prose.

Publish a site from the existing markdown with the OpenAPI reference (#45)
included, built in CI to GitHub Pages.

**Done when:** the site builds from the same sources — no duplicated content —
and search finds content in the module READMEs.

---

## Not planned

Recorded so nobody spends a weekend on something we would decline:

- **Writing to the network.** soroban-lens observes; it does not submit
  transactions. Keeping it read-only is what makes it safe to point at mainnet.
- **A hosted public instance.** Operating one is a different project with
  different obligations.
- **Contract source verification.** Out of scope; that belongs with
  soroban-forge, which already knows about contract interfaces. Note that #33
  (reading a contract *spec* to decode events) is in scope and different.
- **Indexing non-Soroban Stellar operations.** Payments, offers and trustlines
  are Horizon's job and it does it well. This project is about contract events.
- **A general-purpose Stellar block explorer.** Stellar Expert exists.
