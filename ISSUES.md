# Follow-up issues

Fifteen scoped issues for v0.2, three per module, tagged **trivial** /
**medium** / **high** by implementation effort — not by importance.

New to the project? Start with a trivial one: **#4**, **#7** and **#10** each
touch one file and have an obvious finished state.

Each issue says what to change and how to know it worked. If you take one,
comment on it so two people do not start the same thing.

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
(the `history` buckets published by SDF and mirrored on GCS/S3) rather than from
`getEvents`. Verify the current archive layout against the official docs before
designing this. It needs to share the cursor model with the RPC poller so a
backfill and a live tail can run against one database.

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

---

## Module 2 — Decoding & Storage (`packages/store`) · Person B

### 4. Add a `--vacuum` / retention policy command — `trivial`

An indexer left running on a busy contract grows without bound, and there is no
supported way to prune.

Add `pruneBefore(ledger: number): Promise<number>` to `EventStore`, implement it
for SQLite (delete plus `VACUUM`), and expose it as `lens prune --before-ledger`.

**Done when:** pruning reduces the file size on disk, and a test confirms rows
below the threshold are gone while the stream cursor is untouched.

### 5. Postgres storage backend — `high`

SQLite is the right default and the wrong choice for several indexers writing
concurrently, or for a dataset past a few tens of GB.

Implement `EventStore` against Postgres. The trait exists precisely for this, so
no code above Module 2 should change. Reuse `decodeEvent()` — decoding is
backend-independent. Port the migrations, and use `JSONB` for `topics_json` and
`value_json` so topic containment queries can be indexed with GIN.

**Done when:** the existing store suite passes against both backends from one
parameterised run, and `docker-compose.postgres.yml` demonstrates it.

### 6. Index events by decoded address — `medium`

"Every transfer involving account G…" is the single most common question people
ask of a contract, and today it needs a full scan plus client-side filtering.

Addresses appear in topics *and* nested inside values. Extract every address
from a decoded event into a side table (`event_id`, `address`, `position`) and
add a query filter for it.

**Done when:** `GET /events?address=G…` returns every event mentioning that
address anywhere, and a benchmark over ≥1M rows shows it uses the index.

---

## Module 3 — Query API (`packages/api`) · Person C

### 7. CSV export — `trivial`

Getting indexed events into a spreadsheet or a pandas notebook currently means
writing a jq incantation.

Support `Accept: text/csv` and `?format=csv` on both event-list routes. Flatten
topics to `topic0..topicN` columns and the value to its JSON text. Stream the
response rather than buffering — an export can be far larger than a page.

Quote `i128` values so spreadsheets do not coerce them into floats and destroy
the precision the API went out of its way to preserve.

**Done when:** `curl -H 'Accept: text/csv' …/events > out.csv` opens correctly,
and a test asserts large integers survive a round trip.

### 8. Server-sent events for live updates — `medium`

The UI polls every 5 seconds: latency nobody wants and load nobody needs.

Add `GET /events/stream` as an SSE endpoint accepting the same filters, emitting
each new event as it is indexed. Include the last event id in each message so a
dropped connection can resume with `Last-Event-ID` rather than re-reading.

**Done when:** the UI switches to SSE with polling as a fallback, and the server
handles 100 concurrent streams without unbounded memory growth.

### 9. Rate limiting and optional API keys — `medium`

The API is unauthenticated with `Access-Control-Allow-Origin: *`. That is a
reasonable default for localhost and an unreasonable one for anything reachable.

Add a token-bucket limiter keyed by client IP, plus optional API keys via
`LENS_API_KEYS`. Both off by default — the local experience must not regress.
Return `429` with `Retry-After`, and document the whole thing in `openapi.json`
with a `security` scheme.

**Done when:** a load test confirms limits are enforced, keys gate access when
configured, and an unconfigured instance behaves exactly as it does today.

---

## Module 4 — Web UI (`apps/web`) · Person D

### 10. Dark mode — `trivial`

The CSS already uses custom properties on `:root`, so this is mostly one
`@media (prefers-color-scheme: dark)` block redefining the palette.

Add an explicit toggle as well — respecting the system setting is right by
default, but people reading a terminal-adjacent tool often want to override it.
Persist the choice in `localStorage` next to the existing UI state.

**Done when:** both themes are legible (contrast ≥ 4.5:1 for body text), the
toggle overrides the system setting in both directions, and there is no flash of
the wrong theme on load.

### 11. Component tests — `medium`

The UI has no test runner. `npm test` runs the production build, which
type-checks but proves nothing about behaviour. **This is the most valuable
contribution anyone could make to this module.**

Add Vitest with Testing Library. Cover the cases most likely to break quietly:
`summarise()` and `truncate()`, the topic-prefix query builder, row expansion,
the request-versioning logic that stops a slow response overwriting a newer one,
and the network-mismatch warning.

**Done when:** `npm test -w @soroban-lens/web` runs real component tests in CI
and covers each item above.

### 12. Shareable URLs and deep links — `medium`

Filter state lives in `localStorage`, so you cannot send a colleague a link to
what you are looking at — the main thing anyone wants from an explorer.

Move contract, topic, network and expanded-event state into the query string,
with `localStorage` only as the fallback for a bare visit. Add `/events/{id}` as
a route that opens that event expanded.

**Done when:** copying the URL reproduces the exact view in a fresh browser, and
back/forward move through filter history.

---

## Module 5 — Deployment, Docs & DX (`packages/cli`, `deploy/`, `docs/`) · Person E

### 13. `lens doctor --fix` for common failures — `trivial`

Doctor diagnoses and then leaves you to it. Several failures have one obvious
remedy: create a missing data directory, run pending migrations, write a `.env`
from `.env.example`.

Add `--fix` to apply exactly those, printing each action. Never touch anything
destructive, and never guess at network configuration.

**Done when:** a fresh clone with no `.env` and no `data/` reaches all-green
from a single `lens doctor --fix`.

### 14. Multi-network compose profile — `medium`

Running testnet and mainnet side by side is a supported idea — the UI has a
network switcher — but nothing in `deploy/` sets it up, so the switcher ships
with one entry.

Add compose profiles running a second indexer/API pair against mainnet on a
separate volume and port, with `LENS_WEB_NETWORKS` wired to both. Document that
mainnet needs a user-supplied `LENS_RPC_URL`.

**Done when:** `docker compose --profile mainnet up` yields a UI whose switcher
moves between two live networks.

### 15. Publish images and a release workflow — `high`

Installing means cloning and building. There is no released artifact, so there
is no way to pin a version or roll one back.

Add a tag-triggered workflow that builds multi-arch images (amd64 + arm64),
publishes to GHCR, publishes the packages to npm, generates a changelog from
conventional commits, and attaches the OpenAPI spec to the GitHub release.
Provide a `docker-compose.release.yml` that pulls published images rather than
building.

**Done when:** `docker compose -f docker-compose.release.yml up` works on a
machine that has never cloned the repo, on both architectures.

---

## Not planned for v0.2

Recorded so nobody spends a weekend on something we would decline:

- **Writing to the network.** soroban-lens observes; it does not submit
  transactions. Keeping it read-only is what makes it safe to point at mainnet.
- **A hosted public instance.** Operating one is a different project with
  different obligations.
- **Contract source verification or ABI decoding.** Decoding events into
  contract-specific types needs a spec source and belongs with soroban-forge,
  which already knows about contract interfaces.
