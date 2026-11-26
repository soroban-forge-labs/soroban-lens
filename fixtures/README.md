# Fixtures

Real data, captured from the network. Nothing here is synthetic — it is a
recorded Soroban RPC response, trimmed for coverage and readability.

## `testnet-events.json`

A `getEvents` result captured from `https://soroban-testnet.stellar.org` on
**2026-09-15** (protocol 28), from the request recorded in the file's `_source`
block. 60 events across 20 contracts, ledgers 4695317–4695324.

The top-level shape is exactly the RPC `result` object, so it can be fed to any
code that handles a real response:

```jsonc
{
  "latestLedger": 4697319,
  "oldestLedger": 4576358,
  "cursor": "...",
  "events": [ { "id": "...", "type": "contract", "ledger": 4695317, ... } ]
}
```

### Why these events

The selection deliberately covers the decoding cases Module 2 has to get right:

| Case | Example contract | Notes |
|---|---|---|
| `i128` value | `CDLZFC3S…CYSC` | Native XLM SAC `transfer` / `fee`; decodes to a JS `BigInt`, so it cannot round-trip through `JSON.parse` as a number |
| `map` value | `CBR6ZRV2…APDY` | Oracle `mktchk` payloads |
| `vec` value | `CBSWA5P7…BSYE` | `exposure_synced` tuples |
| `bytes` value | `CD4KFB23…XOPW` | Raw `REDSTONE` blob |
| Symbol topics | `CDLZFC3S…CYSC` | The common `transfer` / `fee` case |
| Address topics | `CDLZFC3S…CYSC` | Both `G…` account and `C…` contract addresses in topic position |
| `u32` + `bool` topics | `CB25X5IS…PSAY` | `open_fill` proves topics are not always symbols or addresses |
| String topic | `CCJQB4EE…MIEX` | `"AXIS"` is an `ScString`, not an `ScSymbol` — different XDR arm, same look when printed |
| **5-segment topics** | `CCJQB4EE…MIEX` | See the warning below |
| Unsuccessful calls | `CDLZFC3S…CYSC` | One event has `inSuccessfulContractCall: false` and must still be stored |

### A trap worth knowing about

`CCJQB4EEQLBL7RHIPYMYG26ZT2QRKEYNGVWWL2EPZCECFI6GZGNXMIEX` emits events with
**five** topic segments (`["AXIS", "order", "created", C…, C…]`).

The RPC's `getEvents` *topic filter* accepts at most **four** SegmentMatchers, so
there is no server-side filter that can match this event by its full topic list.
Emitted topic count and filterable topic count are simply not the same limit.
Anything that assumes "topics are at most 4, and the first one is a symbol" —
a fixed `topic0..topic3` schema, a UI that renders only four chips — will
silently mangle this contract. Module 2 stores the full topic array for exactly
this reason, and filters on a topic *prefix* rather than an exact match.

`CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` is the testnet
Stellar Asset Contract for native XLM — verified with
`Asset.native().contractId(Networks.TESTNET)`. It is the default demo contract
throughout this repo because it is always emitting events.

## `testnet-specs.json`

The contract specs of all 20 contracts in `testnet-events.json`, looked up on
testnet on **2026-10-09** with `lens spec fetch` — the same code path the
indexer uses. 7 are Wasm contracts that declare SEP-48 events, 6 are Stellar
Asset Contracts (built-in spec, no entries), and 7 are Wasm built before
soroban-sdk 23, with a spec but no events.

Trimmed for size, which the `_source` block records: function and error-enum
entries are dropped, since typed decoding reads only event and type
definitions, and contracts that declare no events keep their record but not
their entries. `lens seed` loads it, so a seeded instance shows typed events
offline. One fixture event (`CBF2LTEN…`'s `new_block_event`) is emitted
without being declared in its contract's spec — kept deliberately, as the case
that must fall back to the generic view.

## Refreshing

RPC nodes retain roughly 7 days of history (120 960 ledgers), so these ledgers
are long gone from the live node. That is the point: the fixture keeps Modules
2, 3 and 4 testable with no network at all.

Both `testnet-events.json` and `testnet-specs.json` are re-captured by a single
script, `scripts/refresh-fixtures.mjs`:

```bash
npm run fixtures:refresh
```

It talks to testnet, so it needs network access; everything else in the repo
stays offline. The script:

1. **Reads its configuration** from `scripts/fixtures.config.json`:
   - `rpcUrl` — the endpoint to capture from (defaults to
     `https://soroban-testnet.stellar.org`).
   - `contracts` — the contract ids to capture. This is the same set of 20
     contracts the current fixtures cover; add or remove ids here to change
     coverage.
   - `ledgerRange` — `{ "startLedger": …, "endLedger": … }` bounding the
     capture. The script pages `getEvents` from `startLedger` until it passes
     `endLedger` or the node runs out of events.
   - `pageSize` — events requested per `getEvents` page (the RPC caps this at
     10 000; the current fixture uses 200).
2. **Captures `getEvents`** for each configured contract, following the cursor
   page by page, and merges the results into one `result` object with the same
   top-level shape as the RPC response (`latestLedger`, `oldestLedger`,
   `cursor`, `events`).
3. **Trims the result the same way the current fixture is trimmed**: events are
   sorted by `(ledger, id)`, de-duplicated by `id`, and capped at the same
   per-contract event count the existing file uses, so the shape and coverage
   stay comparable.
4. **Fetches specs** for every contract in the capture via the same code path
   as `lens spec fetch` (the indexer's spec lookup), then trims them like the
   current `testnet-specs.json`: function and error-enum entries are dropped,
   and contracts that declare no events keep their record but not their
   entries.
5. **Writes deterministically**: object keys are emitted in a fixed order,
   arrays are sorted by stable keys, and the output is pretty-printed with a
   fixed indent and a trailing newline. Re-running the script against the same
   ledgers produces a byte-identical file, so a refresh shows up as a
   reviewable diff rather than a whole-file rewrite.

### Reviewing the diff

After running the script, inspect the diff before committing:

```bash
git diff --stat fixtures/
git diff fixtures/testnet-events.json
git diff fixtures/testnet-specs.json
```

Because the output is deterministic, unchanged contracts produce no diff at
all. Look for: new or removed contract ids (coverage change), events whose
`id` or `ledger` moved (the ledger range shifted), and spec entries that
appeared or disappeared (a contract was upgraded). If the diff is larger than
expected, check `scripts/fixtures.config.json` first — a wrong `ledgerRange`
is the usual cause.

### After refreshing

- Update the `_source` block in each file (capture date, protocol version,
  request parameters) to match the new run.
- Update the coverage table above if the set of contracts or the decoding
  cases they exercise changed.
- Re-run `npm test` — several suites assert against these exact ids, and the
  seeded-instance tests read `testnet-specs.json` directly.
=======

## `testnet-getevents-recording.json`

A recorded RPC interaction for the poller's replay test (#143): the startup
sequence (`getNetwork`, `retention`) and two `getEvents` pages, one full and
one short, from the same testnet capture as `testnet-events.json`.

Unlike `testnet-events.json`, which is a single `getEvents` result, this file
is a *sequence*: each entry pairs the method, its arguments, and either the
response or the error. It is replayed by `RecordedRpcClient` so a poller test
can drive the whole startup → backfill → caught-up cycle with no network.

Refresh it with the recorder (see `packages/ingest/README.md` → "Recording
RPC traffic"). The `_source` block records how the current file was produced;
if you regenerate against newer ledgers, update the request block to match
and re-run `npm test -w @soroban-lens/ingest`.
