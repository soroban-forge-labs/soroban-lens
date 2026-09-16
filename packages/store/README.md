# `@soroban-lens/store` — Module 2: Decoding & Storage

Owner: **Person B**

Turns the base64 XDR that Module 1 pulls off the network into structured,
queryable records. Owns the schema, the migrations, and the `EventStore` trait
that Module 3 codes against.

## Deliverable

```bash
npm run build -w @soroban-lens/store

# live: Module 1 straight into Module 2
node packages/ingest/dist/bin.js -c CDLZFC3S...CYSC --max-events 40 --no-resume \
  | node packages/store/dist/bin.js --db ./data/lens.db

# offline: replay the committed fixture, no network needed
node packages/store/dist/bin.js --db ./data/lens.db --fixture fixtures/testnet-events.json

node packages/store/dist/bin.js --db ./data/lens.db --stats
```

## The storage trait

[`EventStore`](./src/store.ts) is the only thing Modules 3 and 5 are allowed to
depend on. `SqliteEventStore` is one implementation; adding Postgres means
writing a second one, not touching the API.

```ts
interface EventStore {
  migrate(): Promise<void>;
  insertEvents(events: RawEventInput[]): Promise<number>;   // decodes, then writes
  insertDecoded(events: LensEvent[]): Promise<number>;
  getEvent(id: string): Promise<LensEvent | null>;
  queryEvents(query: EventQuery): Promise<EventPage>;
  listContracts(limit?: number): Promise<ContractSummary[]>;
  listTopics(contractId: string, limit?: number): Promise<{ topic: string; count: number }[]>;
  getStats(): Promise<StoreStats>;
  saveStreamState(state: StreamState): Promise<void>;
  loadStreamState(key: string): Promise<StreamState | null>;
  listStreamStates(): Promise<StreamState[]>;
  healthCheck(): Promise<{ ok: boolean; detail: string }>;
  close(): Promise<void>;
}
```

Three guarantees an implementation has to keep:

1. **`insertEvents` is idempotent on event id.** Module 1 delivers
   at-least-once and will replay a batch after a crash.
2. **Results are ordered by event id**, which for Soroban is ledger order.
3. **Pagination is keyset, not offset.** Pages stay correct while the indexer
   writes behind them.

## Decoding

`decodeScVal(base64)` returns `{ type, value }` where `value` is always
JSON-safe. Two things about `@stellar/stellar-sdk` v17 shape this code, and both
will bite anyone who assumes otherwise:

**`xdr.ScVal.fromXDR()` returns a concrete arm class**, not a union wrapper.
There is no `.switch()` to read the discriminant from — it comes from the
constructor name (`ScValI128` → `i128`).

**`scValToNative()` returns values `JSON.stringify` cannot handle.** The
integer arms give you `BigInt`, which throws; `bytes` gives you a `Uint8Array`,
which silently stringifies to `{"0":46,"1":170,…}`. `toJsonSafe()` normalises
BigInt to a decimal string and bytes to lower-case hex, recursively, including
inside maps and vecs.

i128 amounts routinely exceed `Number.MAX_SAFE_INTEGER`, so **decoded integers
are strings, never JS numbers**. A UI that does `Number(event.value.value)` on a
token amount is a bug waiting for a large transfer.

**Decoding never throws.** A contract can emit anything. An undecodable event is
stored with `decodeError` set and its raw XDR intact, so it can be re-decoded
after a decoder fix without re-indexing from the network — which matters,
because the network will not have it any more.

## Schema notes

`events` keeps the full decoded topic array in `topics_json`, *plus* scalar
projections `topic0..topic3` for indexed filtering.

That split is not redundancy. The RPC's `getEvents` topic filter accepts at most
four segments, but **emitted events are not bound by that limit** — the fixture
contains real 5-topic events. A fixed `topic0..topic3` schema alone would
silently truncate them. Filtering is therefore a *prefix* match over the first
four positions, and `null` is a wildcard:

```ts
store.queryEvents({ topics: ['transfer', null, null] });  // any transfer
store.queryEvents({ topics: ['AXIS', 'order'] });         // prefix of a 5-topic event
```

Topics that are themselves maps or vecs project to `NULL` and are not
filterable. That is deliberate: there is no single-column form of a map that a
user could predict or type.

Event ids are fixed-width 30 characters and sort lexicographically in ledger
order, which is why keyset pagination is a plain string comparison.

### Why `node:sqlite`

Node's built-in driver, not `better-sqlite3`. No native compilation, so
`npm install` behaves the same on a laptop, in CI, and in an Alpine container —
which is what makes the README's zero-setup claim true. WAL mode is on, so the
API reads while the indexer writes.

## Adding a backend

1. Implement `EventStore`.
2. Reuse `decodeEvent()` — decoding is backend-independent.
3. Run the same suite against it; the tests in `test/sqlite-store.test.js` are
   written against the trait, not against SQLite.

Migrations are append-only. Never edit a shipped migration; add the next
version to `MIGRATIONS` in [`src/schema.ts`](./src/schema.ts).

Each migration may carry an optional `down`. `lens migrate --down --to <n>`
rolls back every applied migration above `<n>`, most recent first, refusing
the whole batch up front if any step in the range has no `down` — nothing is
rolled back partway. **Migration 1's `down` drops the tables outright: rolling
back to version 0 is a genuine, irreversible data loss, no matter what SQL
runs, because there is no earlier schema for the data to live in.** Every
later migration's `down` is structural only (dropping an index it added) and
loses nothing.

## Performance

Two benchmarks live in `bench/`, not `test/` — they insert hundreds of
thousands to a million synthetic rows, which is slow and irrelevant to
correctness, so they never run in `npm test` or CI:

```bash
npm run bench:count-cache -w @soroban-lens/store       # #26
npm run bench:insert -w @soroban-lens/store            # #27
npm run bench:xdr-compression -w @soroban-lens/store   # #35
npm run bench:address-index -w @soroban-lens/store     # #23
npm run bench:fts-search -w @soroban-lens/store         # #32
```

`insert-strategies.bench.js` (#27) measured `insertDecoded`'s one-prepared-
statement-per-row approach against multi-row `VALUES` batching and PRAGMA
tuning. Neither alternative reliably beat it — the spread between candidates
was consistently smaller than one candidate's own run-to-run variance across
repeated trials. `insertDecoded` is unchanged as a result: this was a
measurement, not an assumption, and the measurement said the current code is
already fine.

`xdr-compression.bench.js` (#35) measured `value_xdr`/`topics_xdr_json`
compression at 200,000 rows of real fixture data, cycled: a 10.4% reduction on
those two columns specifically (`encodeXdrColumn` only keeps the compressed
form when it is actually smaller, so short values — a bare symbol topic, a
small integer — are stored as plain text rather than paying gzip's ~18-20
byte fixed overhead to grow). Decompression costs about 1.7µs per call, which
is irrelevant next to the UI's "Raw XDR" panel being a one-event, one-click
fetch rather than a hot path.

`address-index.bench.js` (#23) inserted 1,000,000 synthetic rows and queried
`?address=` for two shapes: an address mentioned in ~0.1% of rows (a specific
account) and one mentioned in every single row (a token contract's own
address inside every transfer it emits). The rare address resolves in under a
millisecond regardless of table size — `idx_event_addresses_address` drives
straight to the matching rows. The common address takes several seconds: it
is the honest worst case for any b-tree index, where a small page over a
filter matching nearly everything has nowhere to push the pagination `LIMIT`
down to. The extraction itself is not free either — inserting the same
1,000,000 rows costs roughly 8x what it does without address extraction,
since every topic and value gets parsed a second time (decodeEvent's own
parse, plus extractAddresses' walk of the raw ScVal tree) to find what it
mentions. Both numbers are reported as measured, not smoothed over — the
address filter is for the selective case, and the benchmark shows both where
it wins and where it does not.

## Tests

```bash
npm test -w @soroban-lens/store
```

39 tests, no network. They run against `fixtures/testnet-events.json` — real
captured testnet data — and several assert on specific event ids, so replacing
the fixture means re-running them.
