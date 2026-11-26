# Indexing mainnet through a provider

The `mainnet` preset in `lens` is deliberately incomplete. SDF does not run a free public mainnet RPC with useful retention, so there is no default `--rpc-url` you can point at and expect to work. Mainnet is where most real use happens, so this guide walks through picking a provider, wiring its key in safely, understanding what its retention window means for backfill, tuning page size against cost, and proving the whole thing works with `lens doctor` before you index a single contract.

## 1. Why the mainnet preset is not usable as-is

Soroban Lens ships network presets (`testnet`, `futurenet`, `mainnet`) that fill in sensible defaults for passphrase, friendbot, and RPC endpoint. For `mainnet` the preset carries a warning rather than a working endpoint: SDF does not operate a free public mainnet RPC with retention deep enough to backfill history. A public endpoint that only serves the last few ledgers will let `lens doctor` pass and then fail the moment you ask it to catch up from `oldestLedger`.

So on mainnet you bring your own provider. The preset still supplies the network passphrase and other non-endpoint defaults; you override the endpoint.

### Choosing a provider

Compare providers on four axes before you commit:

- **Retention window.** How many ledgers of history does the provider keep and serve? This is the single most important number — it determines how far back you can backfill and how long a paused indexer can stay down before its cursor falls out of the window. Ask for the retention in ledgers, not "days", and convert (mainnet closes a ledger roughly every 5 seconds, so ~17,280 ledgers/day).
- **Rate limits.** Requests per second and per day, and whether limits are per-key or per-IP. Backfill is request-heavy; a low per-second cap turns a one-hour backfill into a day-long one.
- **Pricing.** Most providers bill per request or per compute unit. Page size (below) is your main cost lever, so understand whether a larger page costs more per request or is flat.
- **Auth scheme.** How the key is presented: a bearer token (`Authorization: Bearer <key>`), a custom header (`X-API-Key: <key>`), or a query parameter. Prefer header-based schemes — they work cleanly with `--rpc-header` and stay out of URLs and logs.

Pick a provider whose retention comfortably exceeds the history you need to index, and whose auth is header-based.

## 2. Passing the provider key with `--rpc-header`

Never put the key in the URL. A URL ends up in shell history, process listings, proxy logs, and error messages; a header does not. Pass credentials with `--rpc-header` (repeatable) or the `LENS_RPC_HEADERS` environment variable.

On the command line:

```bash
export PROVIDER_KEY=...            # from your provider dashboard
lens doctor \
  --network mainnet \
  --rpc-url https://rpc.example-provider.com \
  --rpc-header "Authorization: Bearer $PROVIDER_KEY"
```

Or via the environment, which keeps the key out of your shell history entirely:

```bash
export LENS_RPC_HEADERS="Authorization: Bearer $PROVIDER_KEY"
lens doctor --network mainnet --rpc-url https://rpc.example-provider.com
```

`--rpc-header` takes a `Name: Value` pair and may be repeated for providers that need more than one header. `LENS_RPC_HEADERS` accepts the same pairs (newline- or comma-separated, depending on your shell). Command-line flags take precedence over the environment variable.

`lens doctor` **redacts header values** in its output — you will see the header name with the value masked, so it is safe to paste doctor output into an issue or a chat. The key is still sent to the provider; it is only hidden from what `lens` prints.

## 3. Retention and backfill

Your provider serves a sliding window of the most recent N ledgers. Two things follow.

**Backfill is bounded by retention.** When you start indexing a contract, `lens` needs to walk from the contract's first relevant ledger (or from `oldestLedger`) forward to the chain head. If the contract's history predates the provider's window, you cannot backfill it through this provider — you will only capture events from `oldestLedger` onward. Check the contract's creation ledger against the provider's retention before you start, and set expectations accordingly.

**A cursor can fall out of the window.** If an indexer is paused longer than the retention window, its saved cursor points at a ledger the provider no longer serves. When `lens` detects this it emits a **retention-gap warning** and restarts from the provider's `oldestLedger`, skipping the ledgers it can no longer fetch. That is a data gap, not a crash — but it means events in the skipped range are lost for that run. To avoid it, keep the indexer running, or resume before the cursor ages past the window. If you see the retention-gap warning, treat the affected range as missing and re-index from a source that still has it if you need those events.

## 4. Page size and cost

`lens` fetches events in pages. `--page-size` (or `LENS_PAGE_SIZE`) sets how many events/ledgers a single RPC request asks for. The flag is clamped to adaptive bounds — `lens` will not send a page size the provider is known to reject, and it adjusts within the allowed range rather than failing outright.

Page size trades request count against per-request cost:

- **Larger pages** mean fewer RPC calls for the same backfill — good for per-request rate limits and latency — but each request may cost more (per compute unit) and risks hitting a provider's maximum response size.
- **Smaller pages** mean more calls — heavier on per-second rate limits — but cheaper per request and gentler on memory.

Start at the default. If you are rate-limited on requests-per-second, raise `--page-size`; if you are hitting per-request cost or response-size limits, lower it. Watch your provider's usage dashboard during the first backfill and adjust once, rather than tuning blind.

## 5. Worked example: index one mainnet contract

This walks through proving the provider works, then indexing a single contract and confirming events arrived.

### Step 1 — prove the provider works with `lens doctor`

```bash
export PROVIDER_KEY=...            # your provider key
lens doctor \
  --network mainnet \
  --rpc-url https://rpc.example-provider.com \
  --rpc-header "Authorization: Bearer $PROVIDER_KEY"
```

Expected output (header value redacted, as `lens doctor` always does):

```
network:      mainnet
rpc url:      https://rpc.example-provider.com
rpc headers:  Authorization: ****
passphrase:   Public Global Stellar Network ; September 2015
latest ledger: 5xxxxxxxx
oldest ledger: 5yyyyyyyy        # provider retention floor
status:       ok
```

If `status` is not `ok`, stop here — fix the URL, the header name, or the key before indexing. A passing doctor run confirms the endpoint is reachable, the passphrase matches mainnet, and the provider reports a usable ledger range.

### Step 2 — index one contract

```bash
export LENS_RPC_HEADERS="Authorization: Bearer $PROVIDER_KEY"
lens index \
  --network mainnet \
  --rpc-url https://rpc.example-provider.com \
  -c <CONTRACT_ID>
```

`-c` scopes the indexer to a single contract, so you are not backfilling the whole chain. `lens` starts from the contract's first relevant ledger (clamped to the provider's `oldestLedger`) and walks forward to the head, paging according to `--page-size` / `LENS_PAGE_SIZE`. If the contract predates the retention window you will see the retention-gap warning described above.

### Step 3 — confirm events arrived

Query the local API for the contract you just indexed:

```bash
curl -s "http://localhost:8080/events?contract=<CONTRACT_ID>&limit=5"
```

A non-empty JSON array of events means the pipeline works end to end: provider reachable, key accepted, backfill completed, events stored and served. If the array is empty, check that the contract actually emitted events within the provider's retention window, and re-run `lens doctor` to confirm the endpoint is still healthy.

Once this works for one contract, widen the scope (drop `-c`, or add more contracts) and keep an eye on the retention window so your cursor never ages out.