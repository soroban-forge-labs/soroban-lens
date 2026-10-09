# Typed events

soroban-lens decodes every event generically: each topic and the data value
become `{ type, value }` pairs — a `symbol`, an `address`, an `i128`, a `map`.
That works for any contract and needs nothing from it.

When a contract publishes a spec, the same event can also be read the way its
author wrote it:

```jsonc
"typed": {
  "name": "transfer",
  "source": "stellar-asset",
  "fields": [
    { "name": "from",          "type": "Address", "location": "topic", "value": "GBYR…JQHHT" },
    { "name": "to",            "type": "Address", "location": "topic", "value": "GDVF…5GSA" },
    { "name": "sep0011_asset", "type": "String",  "location": "topic", "value": "native" },
    { "name": "amount",        "type": "i128",    "location": "data",  "value": "11000000" }
  ]
}
```

## Where specs come from

| Contract | Spec source | What you get |
|---|---|---|
| Wasm built with soroban-sdk **23+** using `#[contractevent]` | SEP-48 event entries in the Wasm's `contractspecv0` section | Full typed view |
| Wasm built with an older SDK | A spec exists, but declares no events | Generic view only — `lens spec` says so |
| Stellar Asset Contract | Built in to soroban-lens (CAP-46-6, CAP-67) | `transfer`, `approve`, `mint`, `burn`, `clawback`, `set_admin`, `set_authorized`, `fee` |
| Not on this network / archived | Nothing to read | Generic view; `lens spec import` takes a local `.wasm` |

`lens index` looks each contract up once — on startup for the configured ids,
and as new contract ids appear when indexing every contract. Lookups run one
at a time off the ingest loop, so they never slow indexing down, and a network
failure is retried on a later batch rather than recorded as "no spec".

A definite "no spec" is remembered and re-checked after six hours, because a
contract that does not exist yet can be deployed, and one can be upgraded.
After an upgrade you know about, `lens spec fetch -c <id>` refreshes it now.

## What it never does

- **Replace the generic decoding.** `topics` and `value` are always present.
- **Force a shape.** A contract may emit events its spec does not declare —
  the committed fixture has one. Those get no `typed` field rather than a
  wrong one.
- **Rewrite stored rows.** The typed view is computed when the API reads the
  event, from the raw XDR that is always kept. A spec fetched today applies to
  events indexed last week.

## Checking it

```bash
$ lens spec
CB3IUO2Y5NFH…POYDULC: Wasm 247438c22fdb… declares 10 event(s) — typed decoding on
CBSWA5P75NGV…I3ZBSYE: Wasm b8c6819aacb6… has a spec but declares no events (built before soroban-sdk 23?) — generic decoding only
CDLZFC3SYJYD…2HHGCYSC: Stellar Asset Contract — built-in spec (transfer, mint, burn, …)

$ curl -s localhost:8080/contracts/CB3IUO2Y5NFH7LDX5EOLA63WO7QSYJSOBMMZESLBC62DEPNQJPOYDULC/spec
{ "source": "wasm", "eventCount": 10, "events": ["PriceFetch", "RoundPublished", …] }
```

`lens seed` loads `fixtures/testnet-specs.json` alongside the event fixture —
the real specs of the fixture's 20 contracts, captured from testnet — so a
seeded instance shows typed events with no network at all.
