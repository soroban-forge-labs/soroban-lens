import test from 'node:test';
import assert from 'node:assert/strict';
import { IngestMetrics, parseMetricsPort } from '../dist/index.js';

test('metrics start at zero and accumulate counters independently', () => {
  const metrics = new IngestMetrics();
  assert.match(metrics.render(), /lens_metrics_ready 0\n/);
  metrics.eventsIngested(3);
  metrics.eventsIngested(2);
  metrics.cursorRestarted();
  assert.match(metrics.render(), /lens_events_ingested_total 5\n/);
  assert.match(metrics.render(), /lens_cursor_restarts_total 1\n/);
  metrics.progress(10, 20);
  assert.match(metrics.render(), /lens_current_ledger 10\n/);
  assert.match(metrics.render(), /lens_latest_ledger 20\n/);
  assert.match(metrics.render(), /lens_metrics_ready 1\n/);
  assert.match(new IngestMetrics().render(), /lens_events_ingested_total 0\n/);
});

test('metrics port accepts TCP ports and rejects ambiguous configuration', () => {
  assert.equal(parseMetricsPort(undefined), undefined);
  assert.equal(parseMetricsPort('9090'), 9090);
  assert.equal(parseMetricsPort('65535'), 65535);
  for (const raw of ['', '0', '-1', '65536', '1.5', 'NaN', '1e3', ' 9090']) {
    assert.throws(() => parseMetricsPort(raw), /integer from 1 to 65535/);
  }
});
