# API cookbook

Copy-paste recipes for answering real questions with the Soroban Lens HTTP API.
Every command below runs as written against the data produced by `lens seed`.

---

## 0. Setup

Start from a clean database, load the fixture, and start the API:

```sh
# 1. Create / migrate the database and load the bundled fixture data.
lens seed

# 2. Start the API server (defaults to http://127.0.0.1:8080).
lens serve
```

All recipes assume the server is reachable at `$API`:

```sh
export API=http://127.0.0.1:8080
```

The fixture data lives in `fixtures/testnet-events.json`. The recipes below use
the contract id, address, and transaction hash that appear in that file. If you
regenerate the fixture, substitute the values from your copy.

### Environment variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `LENS_API_KEY` | If set, every request must send `Authorization: Bearer $LENS_API_KEY`. | unset (auth disabled) |
| `LENS_RATE_LIMIT` | Requests per minute per client. `0` disables limiting. | `0` |
| `LENS_DATABASE_URL` | Database the API reads from. Must match what `lens seed` wrote. | local default |

If you enabled an API key, add the header to every `curl` below:

```sh
export AUTH="Authorization: Bearer $LENS_API_KEY"
# then pass -H "$AUTH" to each curl invocation.
```

The recipes omit `-H "$AUTH"` for readability; add it when auth is on.

---

## 1. Latest transfers for a token

Question: *what are the most recent transfer events emitted by a token contract?*

Filter `/contracts/{id}/events` by the `transfer` topic, newest first, and cap
the page:

```sh
curl -s "$API/contracts/CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC/events?topic=transfer&order=desc&limit=5" \
  | jq '.events[] | {ledger, txHash, topics, value}'
```

Expected output shape (one object per event, newest ledger first):

```json
{
  "ledger": 1234,
  "txHash": "ab12...",
  "topics": ["transfer", "GAAA...", "GBBB..."],
  "value": "1000000"
}
```

Notes:

- `topic=transfer` matches events whose first topic is the symbol `transfer`.
- `order=desc` sorts by ledger descending; `limit=5` caps the page size.
- Drop `limit` to use the server default page size.

---

## 2. Everything an address did

Question: *what did this account do across the whole fixture?*

Use the address-events route with the fixture's known address:

```sh
curl -s "$API/addresses/GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF/events?limit=100" \
  | jq '.events[] | {ledger, contractId, txHash, topics}'
```

Expected output shape:

```json
{
  "ledger": 1234,
  "contractId": "CDLZ...",
  "txHash": "ab12...",
  "topics": ["transfer", "GAAA...", "GBBB..."]
}
```

Notes:

- The address is matched against event topics, so both sender and receiver
  positions are returned.
- If the result is truncated, follow `nextCursor` as shown in recipe 4.

---

## 3. One transaction's events

Question: *what events did this specific transaction emit?*

Look up the transaction by hash (taken from `fixtures/testnet-events.json`):

```sh
curl -s "$API/transactions/ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12" \
  | jq '{txHash, ledger, successful, events: [.events[] | {topics, value}]}'
```

Expected output shape:

```json
{
  "txHash": "ab12...",
  "ledger": 1234,
  "successful": true,
  "events": [
    { "topics": ["transfer", "GAAA...", "GBBB..."], "value": "1000000" }
  ]
}
```

Notes:

- A transaction that emitted no events returns `"events": []`.
- An unknown hash returns `404` with `{"error": "transaction not found"}`.

---

## 4. Paging through a ledger range

Question: *give me every event between two ledgers, a page at a time.*

Request the first page of a bounded range:

```sh
curl -s "$API/events?startLedger=1000&endLedger=2000&limit=50" \
  | jq '{count: (.events | length), nextCursor, events: [.events[] | {ledger, txHash}]}'
```

Expected output shape:

```json
{
  "count": 50,
  "nextCursor": "eyJsZWRnZXIiOjEwNTB9",
  "events": [
    { "ledger": 1000, "txHash": "ab12..." }
  ]
}
```

To fetch the next page, pass the returned `nextCursor` back as `cursor` and keep
the same range bounds:

```sh
CURSOR=$(curl -s "$API/events?startLedger=1000&endLedger=2000&limit=50" | jq -r '.nextCursor')

while [ "$CURSOR" != "null" ] && [ -n "$CURSOR" ]; do
  PAGE=$(curl -s "$API/events?startLedger=1000&endLedger=2000&limit=50&cursor=$CURSOR")
  echo "$PAGE" | jq -c '.events[] | {ledger, txHash}'
  CURSOR=$(echo "$PAGE" | jq -r '.nextCursor')
done
```

Notes:

- `nextCursor` is `null` on the last page; the loop stops there.
- `startLedger` and `endLedger` are inclusive.
- Keep `limit` stable across pages so the cursor stays aligned.

---

## 5. Incremental sync

Question: *on each run, fetch only what is new since last time.*

Save the newest ledger you have seen, then re-query from it on the next run.
The first run starts from the beginning of the fixture:

```sh
STATE=.lens-sync-cursor

# Read the last processed ledger (default to 0 on first run).
FROM=$(cat "$STATE" 2>/dev/null || echo 0)

# Fetch everything at or after FROM, newest last.
curl -s "$API/events?startLedger=$FROM&order=asc&limit=1000" \
  | jq -c '.events[] | {ledger, txHash, topics}' \
  | tee /dev/stderr \
  | jq -s 'if length == 0 then empty else max_by(.ledger) | .ledger + 1 end' \
  | { read NEXT; echo "${NEXT:-$FROM}" > "$STATE"; }
```

Expected behavior:

- First run: `FROM=0`, prints every fixture event, writes the highest ledger + 1.
- Later runs: `FROM` is the saved value, so only newer events are printed.
- If nothing is new, the state file is left unchanged.

Notes:

- `order=asc` guarantees the last event is the newest, so `max_by(.ledger)` is
  the high-water mark.
- Storing `ledger + 1` avoids re-reading the boundary ledger on the next run.
- For a long backlog, page with `nextCursor` (recipe 4) inside the loop before
  advancing the saved ledger.

---

## Reference

- Full parameter reference: `openapi.json`, or the interactive `/docs` page at
  `$API/docs`.
- Fixture data: `fixtures/testnet-events.json`.
- API overview and setup: [`docs/api.md`](./api.md).