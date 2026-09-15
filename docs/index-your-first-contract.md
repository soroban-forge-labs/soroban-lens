# Index your first contract in five minutes

From nothing to your contract's events on screen. Docker path first; the
Node-only path is at the bottom.

## What you need

- Docker, or Node 22.13+
- A Soroban contract id on testnet (`C…`, 56 characters)

No contract of your own yet? Use
`CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` — the testnet
Stellar Asset Contract for native XLM. It is always emitting events, which
makes it a good way to confirm the stack works before you point it at something
quieter.

---

## 1. Clone and configure (1 min)

```bash
git clone https://github.com/<your-org>/soroban-lens
cd soroban-lens
cp .env.example .env
```

Open `.env` and set your contract:

```bash
LENS_CONTRACT_IDS=CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC
```

Comma-separate several. Leave it empty to index *every* contract on testnet —
that works, and it fills the database quickly.

## 2. Start everything (2 min)

```bash
docker compose up
```

Four things happen, in order:

1. **`doctor`** checks Node, the data volume, the database and the RPC
   endpoint. If anything is wrong it fails here, with a specific fix, and
   nothing else starts.
2. **`indexer`** begins polling the RPC and writing decoded events.
3. **`api`** serves the query API on `http://localhost:8080`.
4. **`web`** serves the explorer on `http://localhost:5173`.

You should see the doctor report first:

```
lens doctor

  ✔  Node.js version  v26.4.0
  ✔  Data directory   /app/data is writable
  ✔  Database         /app/data/lens.db: writable, schema v1, 0 event(s)
  ✔  Soroban RPC      testnet https://soroban-testnet.stellar.org — healthy,
                      ledger 4697651, retains 120959 ledgers (~7d)
  ✔  Contract IDs     1 configured

  All checks passed.
```

then the indexer working through history:

```
[lens] ledger 4576400/4697651: +187 new of 200 (187 total)
```

## 3. Look at the events (1 min)

Open **http://localhost:5173**.

- Paste your contract id into **Contract ID**, or click
  *use the testnet XLM contract*.
- Click any row to expand its decoded topics and value, with the raw XDR
  underneath.
- Click a topic chip to filter by it.
- **Live updates** is on by default; the table refreshes every 5 seconds.

## 4. Query it directly (1 min)

```bash
curl "http://localhost:8080/contracts/CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC/events?limit=5" | jq

# only transfers
curl "http://localhost:8080/events?topic=transfer&limit=10" | jq '.events[].value'

# how far along is the indexer?
curl http://localhost:8080/status | jq
```

Full API: `http://localhost:8080/openapi.json`.

---

## The Node-only path

```bash
npm install
npm run build

npm run doctor -- -c CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC
npm run index  -- -c CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC

# second terminal
npm run api
# third terminal
npm run web
```

### Offline

No network, or you just want data immediately:

```bash
npm run seed    # loads fixtures/testnet-events.json — 60 real testnet events
npm run api &
npm run web
```

---

## What to expect

**History comes before live events.** Starting fresh, the indexer walks forward
from the oldest ledger the RPC still has (~7 days back) before it reaches the
tip. On a busy contract that is a lot of events. Skip ahead with
`LENS_START_LEDGER`, or set it near the current ledger to watch only new
activity.

**A quiet contract looks like nothing is happening.** Confirm the indexer is
alive with `curl localhost:8080/status` — `streams[].ledger` climbing means it
is working, there is simply nothing to record.

**Events older than about 7 days are not available.** RPC nodes retain roughly
120 960 ledgers. soroban-lens cannot index what the node has already forgotten,
and it will say so rather than silently returning less than you asked for.

## Next

- Something wrong? [troubleshooting.md](./troubleshooting.md)
- How it fits together: [architecture.md](./architecture.md)
- Want to help: [../CONTRIBUTING.md](../CONTRIBUTING.md)
