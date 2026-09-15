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

## Refreshing

RPC nodes retain roughly 7 days of history (120 960 ledgers), so these ledgers
are long gone from the live node. That is the point: the fixture keeps Modules
2, 3 and 4 testable with no network at all. To capture a newer one:

```bash
npm run build -w @soroban-lens/ingest
node packages/ingest/dist/bin.js -c <CONTRACT_ID> --max-events 200 --no-resume \
  > /tmp/events.ndjson
```

If you replace this file, update the `_source` block and the coverage table
above, and re-run `npm test` — several suites assert against these exact ids.
