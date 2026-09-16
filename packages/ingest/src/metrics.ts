const BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
type RpcMethod = 'getHealth' | 'getLatestLedger' | 'getEvents';
type Histogram = { count: number; sum: number; buckets: number[] };

/** Process-local metrics; event counts include at-least-once replay. */
export class IngestMetrics {
  #events = 0;
  #restarts = 0;
  #ledger = 0;
  #latest = 0;
  #ready = false;
  #durations = new Map<RpcMethod, Histogram>();
  #errors = new Map<string, number>();

  rpcError(method: RpcMethod, error: unknown): void {
    const e = error as { code?: unknown; status?: unknown; response?: { status?: unknown } } | null;
    const status = e?.response?.status ?? e?.status;
    const kind = status === 429 ? 'rate_limit'
      : typeof status === 'number' ? 'http'
      : e?.code === 'ETIMEDOUT' || e?.code === 'ECONNABORTED' ? 'timeout'
      : typeof e?.code === 'number' ? 'json_rpc' : 'transport';
    const key = `method="${method}",kind="${kind}"`;
    this.#errors.set(key, (this.#errors.get(key) ?? 0) + 1);
  }

  rpcDuration(method: RpcMethod, seconds: number): void {
    const h = this.#durations.get(method) ?? {
      count: 0, sum: 0, buckets: BUCKETS.map(() => 0),
    };
    h.count++;
    h.sum += seconds;
    BUCKETS.forEach((bound, i) => {
      if (seconds <= bound) h.buckets[i] = (h.buckets[i] ?? 0) + 1;
    });
    this.#durations.set(method, h);
  }

  eventsIngested(count: number): void { this.#events += count; }
  cursorRestarted(): void { this.#restarts++; }
  progress(ledger: number, latestLedger: number): void {
    this.#ledger = ledger;
    this.#latest = latestLedger;
    this.#ready = true;
  }

  render(): string {
    return [
      '# HELP lens_events_ingested_total Events acknowledged by the consumer, including replay.',
      '# TYPE lens_events_ingested_total counter',
      `lens_events_ingested_total ${this.#events}`,
      '# HELP lens_cursor_restarts_total Cursor restarts after retention gaps.',
      '# TYPE lens_cursor_restarts_total counter',
      `lens_cursor_restarts_total ${this.#restarts}`,
      '# HELP lens_current_ledger Last acknowledged ledger or scanned tip on an empty page.',
      '# TYPE lens_current_ledger gauge',
      `lens_current_ledger ${this.#ledger}`,
      '# HELP lens_latest_ledger Latest ledger reported by the RPC node.',
      '# TYPE lens_latest_ledger gauge',
      `lens_latest_ledger ${this.#latest}`,
      '# HELP lens_metrics_ready Whether a page has been acknowledged.',
      '# TYPE lens_metrics_ready gauge',
      `lens_metrics_ready ${Number(this.#ready)}`,
      '# HELP lens_rpc_errors_total Failed RPC attempts by bounded error kind.',
      '# TYPE lens_rpc_errors_total counter',
      ...[...this.#errors].sort(([a], [b]) => a.localeCompare(b))
        .map(([labels, count]) => `lens_rpc_errors_total{${labels}} ${count}`),
      '# HELP lens_rpc_request_duration_seconds RPC attempt duration excluding retry waits.',
      '# TYPE lens_rpc_request_duration_seconds histogram',
      ...[...this.#durations].sort(([a], [b]) => a.localeCompare(b)).flatMap(([method, h]) => [
        ...BUCKETS.map((bound, i) =>
          `lens_rpc_request_duration_seconds_bucket{method="${method}",le="${bound}"} ${h.buckets[i]}`),
        `lens_rpc_request_duration_seconds_bucket{method="${method}",le="+Inf"} ${h.count}`,
        `lens_rpc_request_duration_seconds_sum{method="${method}"} ${h.sum}`,
        `lens_rpc_request_duration_seconds_count{method="${method}"} ${h.count}`,
      ]),
      '',
    ].join('\n');
  }
}
