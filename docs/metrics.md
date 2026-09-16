# Monitoring ingestion

Metrics are opt-in and need no extra runtime dependency. Start the full indexer:

```bash
LENS_METRICS_PORT=9090 npm run index
curl http://localhost:9090/metrics
```

The standalone command also accepts `--metrics-port 9090` and
`--metrics-host 127.0.0.1`. Both commands read `LENS_METRICS_PORT` and
`LENS_METRICS_HOST`; standalone flags take precedence. The default bind address
is `127.0.0.1`. Set the host to `0.0.0.0` when scraping across a container
network, and configure access at the network boundary. The endpoint has no auth.
An invalid port or occupied bind address fails startup.

| Metric | Meaning |
| --- | --- |
| `lens_events_ingested_total` | Events acknowledged when the consumer requests the next batch and the cursor saves successfully; includes replay across process restarts |
| `lens_current_ledger` | Last acknowledged page's event ledger; an empty page advances to the reported network tip |
| `lens_latest_ledger` | Latest ledger reported by that page |
| `lens_metrics_ready` | 1 after the first acknowledged page; 0 before that |
| `lens_rpc_request_duration_seconds` | Histogram per `method`, covering every successful or failed attempt, excluding retry waits |
| `lens_rpc_errors_total` | Failed attempts by `method` and `kind`: `rate_limit`, `http`, `timeout`, `json_rpc`, or `transport` |
| `lens_cursor_restarts_total` | Successful cursor clears following a retention gap |

Metrics live in memory and reset when the process restarts. The event counter is
an ingestion throughput measure, not the number of unique rows in storage.
A consumer that stops immediately after a yielded batch has not acknowledged
that page under the poller's cursor protocol. Metrics update on empty pages too.
Ledger lag measures the most recent event on nonempty pages, so a quiet contract
can show lag even when the poller has caught up. Inspect the workload before
choosing an alert threshold. Error labels never contain provider messages,
headers, URLs, cursors, or contract IDs.

Run Prometheus with `--config.file=docs/prometheus.yml` from the repository root.
It loads `docs/ingestion-alerts.yml` and scrapes the local indexer every 15 seconds.
Choose a different Prometheus listening port (for example `--web.listen-address=:9091`)
because its default port is also 9090. For a remote or containerized Prometheus,
replace `127.0.0.1:9090` with the address reachable from that process.

The sample alert fires after ledger lag exceeds 120 ledgers for five minutes,
gated on the first acknowledged page. A separate alert detects an unavailable
endpoint. Route firing alerts through your existing Alertmanager configuration.

The endpoint uses the [Prometheus text exposition format](https://prometheus.io/docs/instrumenting/exposition_formats/).
