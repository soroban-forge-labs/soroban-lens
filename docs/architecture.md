# Architecture

## Data pipeline

```
   Soroban RPC node
          │  getEvents(startLedger | cursor, filters, pagination)
          ▼
   ┌──────────────────┐
   │ Module 1: ingest │  polls, retries with backoff, tracks a cursor
   └──────────────────┘  emits RawEvent — base64 XDR, undecoded
          │
          │  RawEvent  ◀── the data contract
          ▼
   ┌──────────────────┐
   │ Module 2: store  │  decodes XDR, writes SQLite, owns EventStore
   └──────────────────┘
          │
          │  EventStore  ◀── the storage trait
          ▼
   ┌──────────────────┐
   │ Module 3: api    │  HTTP + OpenAPI, read-only
   └──────────────────┘
          │
          │  HTTP/JSON  ◀── openapi.json
          ▼
   ┌──────────────────┐
   │ Module 4: web    │  single-page explorer
   └──────────────────┘

   Module 5 (cli, deploy, docs) wires 1+2 into a process, and ships the lot.
```

## Why the seams are where they are

### Modules 1 and 2 do not import each other

Module 1 emits `RawEvent`. Module 2 declares a structurally identical
`RawEventInput` of its own. No shared package, no build ordering, so Person A
and Person B never wait on each other.

The cost is that the two types must stay identical, enforced where they meet in
`packages/cli/src/indexer.ts`: that file passes Module 1's output straight into
Module 2's input, so drift becomes a compile error rather than a runtime
surprise.

### Raw XDR is kept, not discarded

Every row stores the original base64 topics and value alongside the decoding.
It costs disk, and it buys the ability to re-decode after a decoder fix without
re-indexing — which matters, because by then the RPC node will have forgotten
the ledgers. It also means the UI can show exactly what the network emitted,
not just what we made of it.

### Decoding never throws

A contract can emit anything. An undecodable event is stored with
`decodeError` set and its raw bytes intact. One malformed event must not stall
the indexer or lose the batch around it.

### Delivery is at-least-once

Module 1 saves its cursor only *after* the consumer asks for the next page. A
crash mid-write replays the last batch rather than losing it. Module 2 makes
that safe by using `INSERT OR IGNORE` on the event id, so replay is a no-op.

At-most-once would mean saving the cursor first and silently dropping events on
a crash. For an indexer, duplicate work is cheap and missing data is not
recoverable — the RPC will have moved on.

### Pagination is keyset, never offset

Soroban event ids are fixed-width, 30 characters, and sort lexicographically in
ledger order. So "the next page" is `WHERE id < ?`, a plain string comparison.

Offset pagination would skip or repeat rows as the indexer writes behind the
reader — which it always is.

### The API depends on a trait, not a database

`EventStore` is the only thing Module 3 knows about storage. Postgres means a
second implementation of that interface; the API does not change. The same seam
is where a Rust ingestion path would land if this ever needs to index all of
mainnet.

## Data model

One table, `events`, plus `stream_state` for indexer progress.

The topic columns are the interesting part:

| Column | Purpose |
|---|---|
| `topics_json` | **Full** decoded topic array, however long |
| `topics_xdr_json` | Original base64 topics |
| `topic0`…`topic3` | Scalar projections, indexed, for filtering |

That is not redundancy. The RPC's `getEvents` topic filter takes at most four
segments, but **emitted events are not bound by that limit** — the fixture holds
real 5-topic events. Storing only `topic0..topic3` would truncate them. So the
full array is authoritative and the four columns are a filtering index.

Filtering is therefore a *prefix* match, with `null`/`*` as a wildcard. A topic
that is itself a map or vec projects to `NULL` and is not filterable — there is
no single-column form of a map that a user could predict or type.

## Decoding rules

`scValToNative()` returns real JS values, two of which JSON cannot carry:

| ScVal arm | `scValToNative` | Stored as | Why |
|---|---|---|---|
| `i128`, `u128`, `i64`, `u64`, … | `BigInt` | decimal **string** | Exceeds `Number.MAX_SAFE_INTEGER`; `JSON.stringify` throws on BigInt |
| `bytes` | `Uint8Array` | lower-case **hex** | Otherwise stringifies to `{"0":46,"1":170,…}` |
| `address` | StrKey string | string | — |
| `map` | plain object | object | Recursively normalised |
| `vec` | array | array | Recursively normalised |

Also worth knowing: in `@stellar/stellar-sdk` v17, `xdr.ScVal.fromXDR()`
returns a **concrete arm class** (`ScValSymbol`, `ScValI128`, …), not a union
wrapper. There is no `.switch()` — the arm name comes from the constructor.

## Operational notes

**RPC retention is about 7 days** (120 960 ledgers). A cursor older than that is
unusable; the poller logs the gap as unrecoverable and restarts from
`oldestLedger` rather than wedging. Deeper history needs an archive source,
which v0.1 does not have.

**Retries use full jitter**: `delay = random(0, min(max, base · 2ⁿ))`. Full
rather than equal jitter, so several indexers restarting against the same node
do not resynchronise into a thundering herd.

**SQLite runs in WAL mode**, so the API reads while the indexer writes. That is
also why the API's volume cannot be mounted read-only: WAL needs to write the
`-wal` and `-shm` sidecars even for readers.

## Deliberate v0.1 limitations

- **Polling, not streaming.** `getEvents` is the supported interface. Ingesting
  from ledger-close metadata would be lower-latency and much more work.
- **No backfill beyond RPC retention.**
- **No authentication.** Read-only, assumes a trusted network.
- **SQLite only.** The trait exists so this is additive later.
- **One network per database.** The UI switches by pointing at a different API.
