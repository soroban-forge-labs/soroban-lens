# Monitoring ingestion

Metrics are opt-in and need no extra runtime dependency. Start the full indexer:

```bash
LENS_METRICS_PORT=9090 npm run index
curl http://localhost:9090/metrics
curl http://localhost:9090/healthz
curl http://localhost:9090/readyz
```

The standalone command also accepts `--metrics-port 9090` and
`--metrics-host 127.0.0.1`. Both commands read `LENS_METRICS_PORT` and
`LENS_METRICS_HOST`; standalone flags take precedence. The default bind address
is `127.0.0.1`. Set the host to `0.0.0.0` when scraping across a container
network, and configure access at the network boundary. The endpoint has no auth.
An invalid port or occupied bind address fails startup.

| Metric | Meaning |
| --- | --- |
| `lens_events_ingested_total{contract}` | Per-contract events acknowledged (label cardinality capped at 50 distinct contracts, later ones counted under `contract="other"`; series appear after a contract's first event). Events acknowledged when the consumer requests the next batch and the cursor saves successfully; includes replay across process restarts |
| `lens_current_ledger` | Last acknowledged page's event ledger; an empty page advances to the reported network tip |
| `lens_latest_ledger` | Latest ledger reported by that page |
| `lens_rpc_stalled` | 1 when the RPC-reported tip has not advanced for the configured threshold; resets to 0 when it advances |
| `lens_metrics_ready` | 1 after the first acknowledged page; 0 before that |
| `lens_rpc_request_duration_seconds` | Histogram per `method`, covering every successful or failed attempt, excluding retry waits |
| `lens_rpc_errors_total` | Failed attempts by `method` and `kind`: `rate_limit` (429), `http_4xx` (other client errors: a 401/403 is usually a wrong provider key), `http_5xx` (provider outage), `timeout`, `json_rpc`, or `transport` |
| `lens_rpc_active_provider{index}` | 1 for the provider currently serving requests, 0 for the others; `index` is the provider's position in the pool, never its URL |
| `lens_rpc_failovers_total` | Number of times the pool switched away from the active provider after an error |
| `lens_rpc_provider_errors_total{index}` | Failed attempts per provider `index`, so a flaky backup is visible even when the primary recovers |
| `lens_cursor_restarts_total` | Successful cursor clears following a retention gap |

The same server exposes `/healthz` and `/readyz` as JSON endpoints. Liveness
returns `200 {"status":"ok"}` while the process can serve requests. Readiness
returns `200 {"status":"ready"}` after a page fetch succeeds and for three
configured poll intervals (at least one second); it returns
`503 {"status":"not_ready"}` before the first page, after the RPC exhausts its
retries, or when the last successful page is stale. Empty pages count as
successful fetches, so a quiet contract at the network tip remains ready.
After exhausted retries, the poller waits one interval and tries again, allowing
readiness to recover when the RPC returns.

The Compose indexer enables this endpoint on its internal network. A healthcheck
can use it without publishing the metrics port to the host:

```yaml
services:
  indexer:
    environment:
      LENS_METRICS_PORT: 9090
      LENS_METRICS_HOST: 0.0.0.0
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:9090/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 15s
      timeout: 5s
      retries: 3
      start_period: 20s
```

Metrics live in memory and reset when the process restarts. The event counter is
an ingestion throughput measure, not the number of unique rows in storage.
A consumer that stops immediately after a yielded batch has not acknowledged
that page under the poller's cursor protocol. Metrics update on empty pages too.
The poller reports a stalled RPC tip after 60 seconds without advancement by
default; configure the threshold with `--stalled-threshold` or
`LENS_STALLED_THRESHOLD_MS`.
Ledger lag measures the most recent event on nonempty pages, so a quiet contract
can show lag even when the poller has caught up. Inspect the workload before
choosing an alert threshold.

Lag in seconds (#134), in the indexer's log line and `PollerProgress`, is
*measured*: the gap between the last event's ledger close time and now
(`measuredLagSeconds`). `lagSeconds` stays as the old ~5 s-per-ledger estimate,
and is what the log shows (marked `est.`) on an empty page, where no close time
is known.

`http_4xx` and `http_5xx` are separate error kinds. A 401 or 403 almost always
means a wrong or expired provider key, and retrying will not help. A 503 means
the provider is down. `docs/ingestion-alerts.yml` alerts on each separately.
Error labels never contain provider messages,
headers, URLs, cursors, or contract IDs.

Provider labels are positional (`index="0"`, `index="1"`, ...) and never include
URLs, so credentials or API keys in a provider URL or its query string cannot
leak through metrics. The active provider index is also persisted with indexer
progress, so `/status` reports which endpoint is currently serving requests and
how many failovers have occurred. A sustained `lens_rpc_active_provider{index="1"}`
of 1 means the indexer is running on a backup; watch `lens_rpc_failovers_total`
and `lens_rpc_provider_errors_total` to spot a flapping primary.

Run Prometheus with `--config.file=docs/prometheus.yml` from the repository root.
It loads `docs/ingestion-alerts.yml` and scrapes the local indexer every 15 seconds.
Choose a different Prometheus listening port (for example `--web.listen-address=:9091`)
because its default port is also 9090. For a remote or containerized Prometheus,
replace `127.0.0.1:9090` with the address reachable from that process.

The sample alert fires after ledger lag exceeds 120 ledgers for five minutes,
gated on the first acknowledged page. A separate alert detects an unavailable
endpoint. Route firing alerts through your existing Alertmanager configuration.

The endpoint uses the [Prometheus text exposition format](https://prometheus.io/docs/instrumenting/exposition_formats/).

## Grafana dashboard

`docs/grafana-dashboard.json` is a ready-made dashboard built only on the
metrics above: ingestion rate, ledger lag, RPC latency percentiles, RPC errors
by kind, and cursor restarts. It has no datasource baked in, so it binds to
whatever Prometheus datasource you pick at import time.

1. Start Prometheus with `--config.file=docs/prometheus.yml` as described above
   and confirm the `lens` target is `UP` under **Status → Targets**.
2. In Grafana, add a Prometheus datasource pointing at that Prometheus (for
   example `http://localhost:9091` if you moved Prometheus off port 9090). This
   is the only prerequisite; the dashboard does not create datasources.
3. Import the dashboard: **Dashboards → New → Import**, upload
   `docs/grafana-dashboard.json` (or paste its contents), then select the
   Prometheus datasource when prompted and click **Import**. The dashboard UID
   is fixed, so re-importing updates the existing copy instead of duplicating
   it.

Every panel needs a running indexer with `LENS_METRICS_PORT` set and at least
one acknowledged page, so that Prometheus has scraped the series. Until then
panels show "No data" rather than errors:

- Ingestion rate and cursor restarts need `lens_events_ingested_total` and
  `lens_cursor_restarts_total`; the restart panel stays empty until a retention
  gap forces a cursor clear.
- Lag panels read `lens_current_ledger` and `lens_latest_ledger`, which appear
  after the first page.
- RPC latency percentiles and errors by kind need
  `lens_rpc_request_duration_seconds` and `lens_rpc_errors_total`; the error
  panel is empty while no attempt fails.

Metrics reset on indexer restart, so rate panels need a couple of scrape
intervals (15 seconds each) to show a value after a restart.
