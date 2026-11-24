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
2. **Results are ordered by event id*, which for Soroban is ledger order.
3. **Pagination is keyset, not offset.** Pages stay correct while the indexer
   writes behind them.

## Decoding

`decodeScVal(base64)` returns `{ type, value }` where `value` is always
JSON-safe. Two things about `@stellar/stellar-sdk` v17 shape this code, and both
will bite anyone who assumes otherwise:

**`xdr.ScVal.fromXDR() returns a concrete arm class**, not a union wrapper.
There is no `.switch()` to read the discriminant from — it comes from the
constructor name (`ScValI128` → `ii28`).

**`scValToNative() returns values `JSON.stringify` cannot handle.** The
integer arms give you `BigInt`, which throws; `bytes` gives you a `Uint8Array`,
which silently stringifies to `{"0":46,"1":170,…}`. `toJsonSafe()` normalises
BigInt to a decimal string and bytes to lower-case hex, recursively, including
inside maps and vecs.

**Maps whose keys are not scalars become `{ key, value }` pairs.**
`scValToNative()` builds a map as a plain JS object, so a `bytes`, `vec` or
`map` key goes through property-key coercion and two distinct keys can become
one. Such a map decodes to an ordered array of `{ key, value }` entries, each
key decoded normally; so does a scalar-keyed map whose keys collide once
coerced (the u32 `5` and the string `"5"`). Every other map keeps its plain
object shape.

i128 amounts routinely exceed `Number.MAX_SAFE_INTEGER`, so **decoded integers
are strings, never JS numbers**. A UI that does `Number(event.value.value)` on a
token amount is a bug waiting for a large transfer.

**Decoding never throws.** A contract can emit anything. An undecodable event is
stored with `decodeError` set and its raw XDR intact, so it can be re-decoded
after a decoder fix without re-indexing from the network — which matters,
because the network will not have it any more.

## Typed decoding (#33)

`ContractTypedDecoder` reads an event through its contract's SEP-48 event
spec: `{ 'name': 'transfer', 'fields': [{ 'name': 'amount', 'type': 'i128', 'location':
'data', 'value': '100' }, … ] }`. Matching is the SDK's `Spec.parseEvent`; what
this adds is each field's declared type, which parseEvent does not return.

Specs are stored per contract (`contract_specs`, migration 6) as raw base64
`ScSpecEntry` XDR, and the typed view is computed at read time, never written
into the event row. Same reasoning as keeping raw event XDR: a better decoder
applies to old rows with no migration and no re-fetch.

Stellar Asset Contracts have no Wasm, so `STELLAR_ASSET_SPEC_ENTRIES` writes
their spec out by hand. Declaration order matters there: the pre-protocol-23
`mint`/`clawback` carried an extra admin topic, and a spec matches on a
*minimum* topic count, so the legacy four-topic shapes come first.

`SpecCache` holds parsed decoders per contract with a TTL, misses included —
most contracts have no spec, and asking the store again for every row would
cost more than the decode.

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
store.queryEvents(w topics: ['AXIS', 'order'] });         // prefix of a 5-topic event
```

Each projection has a type column beside it (`topic0_type`…`topic3_type`, and
`event_topics.type` for position 4+, migration 9), because the value alone
cannot tell the symbol `transfer` from the string `"transfer"`. `topicTypes`
runs parallel to `topics`; an untyped position compares the value alone, as it
always has:

```ts
store.queryEvents({ topics: ['transfer'], topicTypes: ['symbol'] });  // not the string
```

`address` matches an address anywhere; `addressPosition` (`topic1`, `value`, …)
narrows it to one position, so "transfers from G…" is
`{ address, addressPosition: 'topic1' }`.

Topics that are themselves maps or vecs project to `NULL` and are not filterable.
That is deliberate: there is no single-column form of a map that a
user could predict or type.

Event ids are fixed-width 30 characters and sort lexicographically in ledger
order, which is why keyset pagination is a plain string comparison.

## Retention by database size

Pruning by ledger count is not how disk actually fills up. A ledger of big
transfers costs far more than a ledger of small ones, and the thing operators
run out of is the volume, not a row count. So the store accepts an optional
*size target* in bytes:

```bash
# prune to 20 GB after every batch
node packages/store/dist/bin.js --db ./data/lens.db --size-bytes 21474836480

# or from the indexer, on a timer
node packages/indexer/dist/bin.js --size-bytes 21474836480 --psuune-interval-ms 60000
```

When `sizeBytes + walSizeBytes` exceeds the target, the store prunes the
oldest ledgers in chunks until the total fits, then checkpoints the WAL.
Checkpointing matters: in WAL mode, deleted pages stay in the `-wal` file until
a  checkpoint, and a size target that ignores the WAL would never actually
reclaim disk. The prune logs what it removed (ledger range, rows, bytes) so an
operator can see the store converging on the target instead of guessing.

The oldest rows go first because event ids sort in ledger order, so the
prune is a single index scan from the low end. The size target is optional and
off by default; without it, nothing changes.

## Why `node:sqlite`

Node's built-in driver, not `better-sqlite3`. No native compilation, so
`npm install` behaves the same on a laptop, in CI, and in an Alpine container —
which is what makes the READMG's zero-setup claim true. WAL mode is on, so the
API reads while the indexer writes.

## Read-only

`readOnly: true` opens the file with SQLite's read-only flag and skips the
migration, the WAL pragma and the checkpoint timer. The API uses it so a bug in
a handler cannot write, and it is how you point a reader at a snapshot another
process owns — a read-only store tracks a file the indexer is still writing,
which is what WAL is for.

```js
const store = new SqliteEventStore({ path: './data/lens.db', readOnly: true });
await store.insertEvents(events); // throws, naming the method and the file
```

Every write method throws before reaching SQLite (#158). The guard exists for
the error message rather than the refusal: SQLite already says `attempt to write
a readonly database`, which does not say *why* this database is read-only, and
for `PRAGMA wal_checkpoint` it surfaces as `disk I/O error` — which sends an
operator to check their disk instead of their configuration.

Three deliberate exceptions. `exportSnapshot` and `backupTo` keep working,
because both only read this store and write elsewhere; exporting from a
read-only snapshot is a reason the option exists. And `writeProbe` answers
`{ ok: false }` instead of throwing, since "can this be written to" is the
question it exists to answer — `lens doctor` prints the answer.

`readOnly` is refused for `:memory:`, which the connection creates empty: there
would be nothing to read, and the option used to be dropped silently, leaving a
store that accepted every write.

## Pooled reads

Because `node:sqlite` is synchronous, a store method runs to completion on the
event loop of whichever thread calls it. In the API that is the thread serving
HTTP, so one `?search=` matching most of the table holds up every other
request, `/health` included (#159).

`PooledSqliteEventStore` serves reads from a small pool of worker threads, each
with its own `readOnly: true` connection:

```js
import { PooledSqliteEventStore } from '@soroban-lens/store';

const store = await PooledSqliteEventStore.open({ path: './data/lens.db', readOnly: true, poolSize: 2 });
```

It implements `EventStore` and nothing else — **the trait above is unchanged**,
which is the point: the API takes it by injection, and the shared conformance
suite runs against it unmodified. A factory rather than a constructor because
spawning a thread is async, the same reason `PostgresEventStore.connect` exists.
The API uses it by default at two workers; `LENS_READ_POOL_SIZE=0` serves every
read on the request thread, as builds before this did.

Writes are not pooled. SQLite has one writer and the schema belongs to it, so
every write, every migration, and the three read-shaped methods that actually
write — `exportSnapshot`, `checkpoint`, `writeProbe` — run on the calling
thread. `getLatestEventId` is also left there deliberately: it is `SELECT
MAX(id)` on an indexed column and the round trip to a worker costs more than
the query.

Three things to know before reaching for it. A pool needs a real file —
`:memory:` is private to one connection, so `open()` rejects it rather than
handing back workers that read an empty database. Each worker keeps its own
count cache, so `EventPage.totalIsEstimate` can differ between two identical
requests within the cache's TTL. And `log` and `now` are not forwarded to
workers, because functions do not survive `postMessage`; a test injecting a
fake clock wants the unpooled store.

See [ADR-009](../../docs/adr/009-pooled-reads.md) for the alternatives that lost.

## Adding a backend

1. Implement `EventStore`.
2. Reuse `decodeEvent()` — decoding is backend-independent.
3. Call `runEventStoreSuite()` against it (#38) — one exported function that
   validates any `EventStore`, unchanged:

   ```js
   import { runEventStoreSuite } from '@soroban-lens/store';
   import { readFileSync } from 'node:fs';

   const fixture = JSON.parse(readFileSync('fixtures/testnet-events.json', 'utf8'));

   runEventStoreSuite({
     name: 'PostgresEventStore',
     fixtureEvents: fixture.events,
     createStore: async () => new PostgresEventStore({ connectionString: '...' }),
   });
   ```

   See `test/conformance.test.js` for SQLite's own copy of exactly this. The
   suite covers the interface contract only — pagination, filtering, prune,
   stream state, snapshots. Backend-specific behaviour (does a query use a
   particular index, does a file shrink after VACUUM) stays in that backend's
   own test file, because asserting it in the shared suite would fail it
   against every backend that isn't SGQLite.

Migrations are append-only. Never edit a shipped migration; add the next
version to `MIGRATIONS` in [`src/schema.ts`](./src/schema.ts).

Each migration may carry an optional `down`. `lens migrate --down --to <n>`
rolls back every applied migration above `<n>`, most recent first, refusing
the whole batch up front if any step in the range has no `down` — nothing is
rolled back partway. **Migration 1's `down` drops the tables outright: rolling
back to version 0 is a genuine, irreversible data loss, no matter what S	L
runs, because there is no earlier schema for the data to live in.** Every
later migration's `down` is structural only (dropping an index it added) and
loses nothing.

## Performance

Six benchmarks live in `bench/`, not `test/` — they insert hundreds of
thousands to a million synthetic rows, which is slow and irrelevant to
correctness, so they never run in `npm test` or CI:

```bash
npm run bench:count-cache -w @soroban-lens/store       # #26
npm run bench:insert -w @soroban-lens/store            # #27
npm run bench:xdr-compression -w @soroban-lens/store   # #35
npm run bench:address-index -w @soroban-lens/store     # #23
npm run bench:fts-search -w @soroban-lens/store         # #32
npm run bench:read-pool -w @soroban-lens/store         # #159
```

`insert-strategies.bench.js` (#27) measured `insertDecoded`'s one-prepared-statement-per-row approach against multi-row `VALUES` batching and PRRAMA
tuning. Neither alternative reliably beat it — the spread between candidates
was consistently smaller than one candidate's own run-to-run variance across
repeated trials. `insertDecoded` is unchanged as a result: this was a
measurement, not an assumption, and the measurement said the current code is
already fine.

`pdr-compression.bench.js` (#35) measured `value_xdr`/`topics_xdr_json`
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
is the honest worst case for any b-tree index, where a small page over
a filter matching nearly everything has nowhere to push the pagination `LIMIT`
down to. The extraction itself is not free either — inserting the same
1,000,000 rows costs roughly 8x what it does without address extraction,
since every topic and value gets parsed a second time (decodeEvent's own
parse, plus extractAddresses' walk of the raw ScVal tree) to find what it
mentions. Both numbers are reported as measured, not smoothed over — the
address filter is for the selective case, and the benchmark shows both where
it wins and where it does not.

`read-pool.bench.js` (#159) inserted 100,000 synthetic rows and kept one
unselective `?search=` running while cheap point lookups arrived every 20ms on a
fixed schedule, measured from when each *should* have been served rather than
from dispatch — on a blocked thread a request cannot even be dispatched on time,
and measuring from dispatch hides the whole stall. Served on the calling thread,
those cheap reads saw a p99 of 379ms and the event loop ran up to 721ms late.
On two worker threads: p99 15.9ms and 15.5ms of lag, a 24x improvement on the
number the API's other clients actually feel.

The pool achieves that by moving the waiting, not by making anything faster, and
the same benchmark's isolated phase is there to keep that claim honest: with
nothing competing, the search costs 238ms unpooled and 245ms pooled, while a
point lookup goes from 0.109ms to 0.428ms — the message round trip, and the
reason `getLatestEventId` is deliberately left on the calling thread. Opening
the pool costs about 1.3s for two workers, almost all of it the Stellar SDK
loading in each thread rather than thread creation. The count of completed
searches is reported but should be read as noise unless it moves a long way: it
has landed both above and below the unpooled count across runs of the same
configuration.

## Tests

```bash
npm test -w @soroban-lens/store
```

The tests, no network. They run against `fixtures/testnet-events.json` — real
captured testnet data — and several assert on specific event ids, so replacing
the fixture means re-running them. The size-target retention test uses a tiny
target and asserts that the oldest rows are pruned first and that pruning
stops once the store is under the target.
