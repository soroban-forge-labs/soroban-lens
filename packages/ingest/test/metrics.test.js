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

test('histogram buckets are cumulative with an infinite bucket equal to count', () => {
  const metrics = new IngestMetrics();
  metrics.rpcDuration('getEvents', 0.05);
  metrics.rpcDuration('getEvents', 40);
  const text = metrics.render();
  assert.match(text, /bucket\{method="getEvents",le="0.01"\} 0\n/);
  assert.match(text, /bucket\{method="getEvents",le="0.05"\} 1\n/);
  assert.match(text, /bucket\{method="getEvents",le="30"\} 1\n/);
  assert.match(text, /bucket\{method="getEvents",le="\+Inf"\} 2\n/);
  assert.match(text, /duration_seconds_sum\{method="getEvents"\} 40.05\n/);
  assert.match(text, /duration_seconds_count\{method="getEvents"\} 2\n/);
  assert.ok(text.endsWith('\n'));
});

test('error labels classify failures without exposing provider messages', () => {
  const metrics = new IngestMetrics();
  for (const error of [
    { response: { status: 429 } }, { status: 503 }, { code: 'ETIMEDOUT' },
    { code: -32600 }, new Error('secret provider token'), null,
  ]) metrics.rpcError('getEvents', error);
  const text = metrics.render();
  for (const kind of ['rate_limit', 'http', 'timeout', 'json_rpc']) {
    assert.ok(text.includes(`kind="${kind}"} 1\n`));
  }
  assert.ok(text.includes('kind="transport"} 2\n'));
  assert.ok(!text.includes('secret'));
});
