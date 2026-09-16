import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { IngestMetrics, LensRpcClient, closeMetricsServer } from '../dist/index.js';

test('RPC metrics include failed retries and successful calls without timing retry sleep', async () => {
  let calls = 0;
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const { method, id } = JSON.parse(body);
    response.setHeader('content-type', 'application/json');
    if (method === 'getEvents' && calls++ === 0) {
      response.writeHead(503).end('{}');
      return;
    }
    const result = method === 'getHealth'
      ? { status: 'healthy', latestLedger: 20, oldestLedger: 10, ledgerRetentionWindow: 10 }
      : method === 'getLatestLedger' ? { sequence: 20, id: 'ledger', protocolVersion: 23 }
      : { events: [], cursor: 'cursor', latestLedger: 20, oldestLedger: 10 };
    response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const metrics = new IngestMetrics();
  const client = new LensRpcClient({
    rpcUrl: `http://127.0.0.1:${server.address().port}`, metrics,
    retry: { attempts: 2, sleep: async () => {}, random: () => 0 },
  });
  try {
    assert.equal((await client.health()).latestLedger, 20);
    assert.equal(await client.latestLedger(), 20);
    assert.equal((await client.getEvents({ filters: [], startLedger: 10 })).cursor, 'cursor');
    const text = metrics.render();
    assert.match(text, /lens_rpc_errors_total\{method="getEvents",kind="http"\} 1\n/);
    assert.match(text, /duration_seconds_count\{method="getEvents"\} 2\n/);
    for (const method of ['getHealth', 'getLatestLedger']) {
      assert.ok(text.includes(`duration_seconds_count{method="${method}"} 1\n`));
    }
    const before = metrics.render();
    await assert.rejects(client.getEvents({ filters: [] }), /needs either/);
    assert.equal(metrics.render(), before, 'local validation is not an RPC attempt');
  } finally {
    await closeMetricsServer(server);
  }
});
