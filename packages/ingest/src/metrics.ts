/** Process-local metrics; event counts include at-least-once replay. */
export class IngestMetrics {
  #events = 0;
  #restarts = 0;

  eventsIngested(count: number): void { this.#events += count; }
  cursorRestarted(): void { this.#restarts++; }

  render(): string {
    return [
      '# HELP lens_events_ingested_total Events acknowledged by the consumer, including replay.',
      '# TYPE lens_events_ingested_total counter',
      `lens_events_ingested_total ${this.#events}`,
      '# HELP lens_cursor_restarts_total Cursor restarts after retention gaps.',
      '# TYPE lens_cursor_restarts_total counter',
      `lens_cursor_restarts_total ${this.#restarts}`,
      '',
    ].join('\n');
  }
}
