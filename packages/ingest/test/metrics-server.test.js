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
    assert.match(await response.text(), /lens_events_ingested_total\{contract="other"\} 7\n/);
    const head = await fetch(`${url}/metrics`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    const post = await fetch(`${url}/metrics`, { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET, HEAD');
    const live = await fetch(`${url}/healthz`);
    assert.equal(live.status, 200);
    assert.deepEqual(await live.json(), { status: 'ok' });
    const notReady = await fetch(`${url}/readyz`);
    assert.equal(notReady.status, 503);
    assert.deepEqual(await notReady.json(), { status: 'not_ready' });
    metrics.pageFetched();
    const ready = await fetch(`${url}/readyz`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { status: 'ready' });
    metrics.rpcExhausted();
    assert.equal((await fetch(`${url}/readyz`)).status, 503);
    metrics.pageFetched();
    assert.equal((await fetch(`${url}/readyz`)).status, 200);
    assert.equal((await fetch(`${url}/`)).status, 404);
    await assert.rejects(startMetricsServer(metrics, port), { code: 'EADDRINUSE' });
  } finally {
    await closeMetricsServer(server);
  }
  assert.equal(server.listening, false);
});
