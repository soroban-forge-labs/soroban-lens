# Troubleshooting

Start here:

```bash
npm run doctor -- -c <YOUR_CONTRACT_ID>
# or, in Docker
docker compose run --rm doctor
```

It checks Node, the data directory, the database and the RPC endpoint, and
prints a specific fix for anything that fails.

---

## Nothing appears in the UI

**Is the API reachable?**

```bash
curl http://localhost:8080/health
```

No response means the API is not running, or the UI is pointed somewhere else.
The UI's status bar shows which URL it is using.

**Is the indexer making progress?**

```bash
curl http://localhost:8080/status | jq '.streams'
```

A `ledger` that climbs on each call means it is working. If `streams` is empty,
the indexer has not written a cursor yet — check its logs
(`docker compose logs indexer`).

**Is the contract actually emitting?** A quiet contract looks identical to a
broken indexer. Confirm against the RPC directly:

```bash
curl -s -X POST https://soroban-testnet.stellar.org \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getEvents","params":{
        "startLedger": 4697000,
        "filters":[{"type":"contract","contractIds":["<YOUR_CONTRACT_ID>"]}],
        "pagination":{"limit":5}}}' | jq '.result.events | length'
```

`0` means there is nothing to index, and soroban-lens is behaving correctly.

**Is it still working through history?** From a cold start the indexer walks
forward from ~7 days ago before reaching live events. Set `LENS_START_LEDGER`
near the current ledger to skip ahead.

---

## "start ledger is before the oldest ledger retained by this node"

The cursor has aged out of the RPC's retention window (~120 960 ledgers, about
7 days). The indexer handles this by itself: it logs the gap and restarts from
`oldestLedger`.

**The events in the gap are gone.** No RPC node can serve them. If continuous
history matters, keep the indexer running, or ingest from an archive — which
v0.1 does not do.

---

## `lens doctor` fails on the RPC check

**testnet/futurenet:** check network access and that `LENS_RPC_URL` is right.
The public endpoint is `https://soroban-testnet.stellar.org`.

**mainnet:** there is no free public mainnet RPC with useful retention. Set
`LENS_RPC_URL` to your own node or a commercial provider. This is the single
most common mainnet mistake.

---

## `Cannot find module 'node:sqlite'`

Node is too old. soroban-lens needs **22.13+** — that is the version where
`node:sqlite` became usable without the `--experimental-sqlite` flag. On 22.12
and earlier the module does not exist at all and you get
`ERR_UNKNOWN_BUILTIN_MODULE`.

```bash
node --version
```

The Docker images use Node 26, so `docker compose up` sidesteps this entirely.

---

## Contract id rejected

A contract id is `C` followed by 55 characters (`A–Z`, `2–7`), 56 total.

An id starting with `G` is an **account**, not a contract. Accounts do not emit
contract events. If you have an asset rather than a contract, derive its
Stellar Asset Contract id:

```js
import { Asset, Networks } from '@stellar/stellar-sdk';
Asset.native().contractId(Networks.TESTNET);
// CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC
```

---

## Database is locked / disk I/O error

SQLite needs real file locking. It misbehaves on some network filesystems
(NFS, certain Docker bind mounts on macOS/Windows). Put the database on a local
volume — which is what `docker-compose.yml` does with the named `lens-data`
volume.

The API's mount **cannot be read-only**: WAL mode writes `-wal` and `-shm`
sidecars even when only reading.

---

## Large numbers look wrong

Decoded integers are **strings**, on purpose:

```json
{ "type": "i128", "value": "4300000000" }
```

`i128`/`u128` exceed `Number.MAX_SAFE_INTEGER`, so a JSON number would lose
precision silently on large transfers. Use `BigInt(value)` for arithmetic. If
an amount is off by a rounding error somewhere, a `Number()` conversion is the
first thing to look for.

---

## A contract's topics look truncated

They are not — the full topic array is always stored. But *filtering* only
covers the first four positions, because that is what the RPC's topic filter
supports. Events with five or more topics exist (the fixture has real ones);
filter on a prefix and narrow the rest client-side.

---

## The UI warns about a network mismatch

The API reported a different `network` from the label you selected. One of the
two is misconfigured: the indexer's `LENS_NETWORK`, or the label in
`LENS_WEB_NETWORKS`. Worth fixing rather than dismissing — it is how testnet
data ends up being read as mainnet.

---

## Changing the API URL does not affect the UI

Vite inlines `VITE_*` variables at **build time**. In Docker:

```bash
docker compose build web && docker compose up -d web
```

Restarting alone will not pick it up.

---

## Starting over

```bash
docker compose down -v          # drops the volume, and all indexed data
# or, locally
rm -rf data/
```

The cursor lives in the same database, so this re-indexes from scratch.
