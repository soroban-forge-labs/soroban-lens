/** Process-local metrics; event counts include at-least-once replay. */
export class IngestMetrics {
  #events = 0;
  #restarts = 0;
  #ledger = 0;
  #latest = 0;
  #ready = false;

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
      '',
    ].join('\n');
  }
}
