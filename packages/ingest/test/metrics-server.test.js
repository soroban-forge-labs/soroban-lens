import test from 'node:test';
import assert from 'node:assert/strict';
import { IngestMetrics, startMetricsServer, closeMetricsServer } from '../dist/index.js';

test('metrics endpoint serves live text, handles methods, and closes cleanly', async () => {
  const metrics = new IngestMetrics();
  const server = await startMetricsServer(metrics, 0);
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}`;
  try {
    metrics.eventsIngested(7);
    const response = await fetch(`${url}/metrics`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/plain; version=0.0.4; charset=utf-8');
    assert.match(await response.text(), /lens_events_ingested_total 7\n/);
    const head = await fetch(`${url}/metrics`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    const post = await fetch(`${url}/metrics`, { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET, HEAD');
    assert.equal((await fetch(`${url}/`)).status, 404);
    await assert.rejects(startMetricsServer(metrics, port), { code: 'EADDRINUSE' });
  } finally {
    await closeMetricsServer(server);
  }
  assert.equal(server.listening, false);
});
