import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { SqliteEventStore } from '@soroban-lens/store';
import { createApiServer, isPrivateAddress, verifyWebhookSignature } from '../dist/index.js';

const fixture = JSON.parse(readFileSync(new URL('../../../fixtures/testnet-events.json', import.meta.url), 'utf8'));
const SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

const sacEvents = fixture.events.filter((e) => e.contractId === SAC).slice(0, 3);
const otherEvent = fixture.events.find((e) => e.contractId !== SAC);

const FAST = {
  enabled: true,
  allowPrivateNetworks: true, // the test receiver listens on 127.0.0.1
  pollIntervalMs: 15,
  retryBaseMs: 5,
  requestTimeoutMs: 1000,
  maxAttempts: 3,
  maxDeliveriesPerMinute: 60_000,
  maxDeliveriesPerMinutePerHost: 60_000,
};

async function waitFor(predicate, timeoutMs = 4000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A receiver whose answer to each request is decided by `responder(entry, n)`. */
async function withReceiver(responder, run) {
  const received = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      const entry = { headers: req.headers, body, json: JSON.parse(body) };
      received.push(entry);
      const { status = 200, headers = {} } = responder(entry, received.length);
      res.writeHead(status, headers);
      res.end();
    });
  });
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  try {
    await run({ received, url: `http://127.0.0.1:${srv.address().port}/hook` });
  } finally {
    srv.closeAllConnections?.();
    srv.close();
  }
}

async function withApi(webhooks, run) {
  const store = new SqliteEventStore({ path: ':memory:' });
  const server = createApiServer({ store, webhooks });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { res, body: text ? JSON.parse(text) : null };
  };
  try {
    await run({ store, call });
  } finally {
    server.closeAllConnections?.();
    server.close();
    await once(server, 'close');
    await store.close();
  }
}

test('a registered webhook receives matching events, signed, in order', async () => {
  await withReceiver(() => ({}), async ({ received, url }) => {
    await withApi(FAST, async ({ store, call }) => {
      const reg = await call('POST', '/webhooks', { url, filter: { contractId: SAC } });
      assert.equal(reg.res.status, 201);
      assert.match(reg.body.secret, /^[0-9a-f]{64}$/);

      // One event for another contract must be filtered out.
      await store.insertEvents([...sacEvents, otherEvent]);
      await waitFor(() => received.length >= sacEvents.length);
      await new Promise((r) => setTimeout(r, 100));

      const expectedIds = sacEvents.map((e) => e.id).sort();
      assert.deepEqual(received.map((r) => r.json.event.id), expectedIds);
      assert.ok(received.every((r) => r.json.event.contractId === SAC));
      for (const r of received) {
        assert.ok(verifyWebhookSignature(reg.body.secret, r.headers['x-lens-signature'], r.body));
        assert.ok(!verifyWebhookSignature('a-different-secret-value', r.headers['x-lens-signature'], r.body));
        assert.equal(r.json.subscriptionId, reg.body.id);
        assert.equal(r.headers['x-lens-event-id'], r.json.event.id);
        assert.equal(r.headers['x-lens-attempt'], '1');
      }

      const got = await call('GET', `/webhooks/${reg.body.id}`);
      assert.equal(got.body.delivered, sacEvents.length);
      assert.ok(!('secret' in got.body), 'the secret is only shown at registration');
    });
  });
});

test('a new subscription only sees events indexed after it registered', async () => {
  await withReceiver(() => ({}), async ({ received, url }) => {
    await withApi(FAST, async ({ store, call }) => {
      await store.insertEvents(sacEvents.slice(0, 1));
      await call('POST', '/webhooks', { url });
      await store.insertEvents(sacEvents.slice(1));
      await waitFor(() => received.length >= sacEvents.length - 1);
      await new Promise((r) => setTimeout(r, 100));
      assert.ok(received.every((r) => r.json.event.id !== sacEvents[0].id));
    });
  });
});

test('it survives a receiver being down: retries with the same delivery id, then succeeds', async () => {
  await withReceiver((_entry, n) => ({ status: n <= 2 ? 503 : 200 }), async ({ received, url }) => {
    await withApi(FAST, async ({ store, call }) => {
      const reg = await call('POST', '/webhooks', { url });
      await store.insertEvents(sacEvents.slice(0, 1));
      await waitFor(() => received.length >= 3);

      assert.deepEqual(received.map((r) => r.headers['x-lens-attempt']), ['1', '2', '3']);
      assert.equal(new Set(received.map((r) => r.headers['x-lens-delivery'])).size, 1);
      const dead = await call('GET', `/webhooks/${reg.body.id}/dead-letters`);
      assert.deepEqual(dead.body.deadLetters, []);
    });
  });
});

test('after repeated failure the event is dead-lettered and delivery moves on', async () => {
  const sorted = sacEvents.map((e) => e.id).sort();
  const failing = sorted[0];
  const last = sorted[sorted.length - 1];
  await withReceiver((entry) => ({ status: entry.json.event.id === failing ? 500 : 200 }), async ({ received, url }) => {
    await withApi(FAST, async ({ store, call }) => {
      const reg = await call('POST', '/webhooks', { url });
      await store.insertEvents(sacEvents);
      await waitFor(() => received.some((r) => r.json.event.id === last));

      const dead = await call('GET', `/webhooks/${reg.body.id}/dead-letters`);
      assert.equal(dead.body.deadLetters.length, 1);
      assert.equal(dead.body.deadLetters[0].eventId, failing);
      assert.equal(dead.body.deadLetters[0].attempts, 3);
      assert.equal(dead.body.deadLetters[0].lastError, 'HTTP 500');
      assert.equal(received.filter((r) => r.json.event.id === failing).length, 3);

      const hook = await call('GET', `/webhooks/${reg.body.id}`);
      assert.equal(hook.body.deadLettered, 1);
    });
  });
});

test('a permanent 4xx is not retried, and redirects are not followed', async () => {
  for (const status of [400, 410, 302]) {
    await withReceiver(() => ({ status, headers: { location: 'http://127.0.0.1:1/elsewhere' } }), async ({ received, url }) => {
      await withApi(FAST, async ({ store, call }) => {
        const reg = await call('POST', '/webhooks', { url });
        await store.insertEvents(sacEvents.slice(0, 1));
        await waitFor(() => received.length >= 1);
        await new Promise((r) => setTimeout(r, 150));
        assert.equal(received.length, 1, `status ${status} must not be retried`);
        const dead = await call('GET', `/webhooks/${reg.body.id}/dead-letters`);
        assert.equal(dead.body.deadLetters.length, 1);
        assert.equal(dead.body.deadLetters[0].lastError, `HTTP ${status}`);
      });
    });
  }
});

test('it cannot be used to flood a receiver: deliveries are rate limited', async () => {
  await withReceiver(() => ({}), async ({ received, url }) => {
    // 60/minute: a burst of 6, then one a second.
    await withApi({ ...FAST, maxDeliveriesPerMinute: 60 }, async ({ store, call }) => {
      const reg = await call('POST', '/webhooks', { url });
      await store.insertEvents(fixture.events.slice(0, 20));
      await new Promise((r) => setTimeout(r, 700));
      assert.ok(received.length >= 1, 'some deliveries go out');
      assert.ok(received.length <= 7, `expected at most the burst, got ${received.length}`);
      await call('DELETE', `/webhooks/${reg.body.id}`);
    });
  });
});

test('the per-host limit applies across subscriptions', async () => {
  await withReceiver(() => ({}), async ({ received, url }) => {
    await withApi({ ...FAST, maxDeliveriesPerMinute: 60_000, maxDeliveriesPerMinutePerHost: 60 }, async ({ store, call }) => {
      for (let i = 0; i < 3; i++) await call('POST', '/webhooks', { url });
      await store.insertEvents(fixture.events.slice(0, 10));
      await new Promise((r) => setTimeout(r, 700));
      // Three subscriptions would deliver 30 without the shared host budget.
      assert.ok(received.length <= 7, `expected at most the host burst, got ${received.length}`);
    });
  });
});

test('registration limits: total and per host', async () => {
  await withApi({ ...FAST, maxSubscriptions: 2, maxSubscriptionsPerHost: 1 }, async ({ call }) => {
    const one = await call('POST', '/webhooks', { url: 'http://127.0.0.1:9/a' });
    assert.equal(one.res.status, 201);
    const sameHost = await call('POST', '/webhooks', { url: 'http://127.0.0.1:9/b' });
    assert.equal(sameHost.res.status, 429);
    assert.equal(sameHost.body.error.code, 'too_many_webhooks');
    const other = await call('POST', '/webhooks', { url: 'http://127.0.0.2:9/c' });
    assert.equal(other.res.status, 201);
    const total = await call('POST', '/webhooks', { url: 'http://127.0.0.3:9/d' });
    assert.equal(total.res.status, 429);
  });
});

test('targets must be public http(s) hosts', async () => {
  await withApi({ enabled: true }, async ({ call }) => {
    for (const url of [
      'http://127.0.0.1:8080/x',
      'http://localhost/x',
      'http://foo.localhost/x',
      'http://169.254.169.254/latest/meta-data',
      'http://10.0.0.5/x',
      'http://192.168.1.1/x',
      'http://172.16.0.1/x',
      'http://[::1]/x',
      'http://[fd00::1]/x',
      'http://[::ffff:127.0.0.1]/x',
      'http://0.0.0.0/x',
      'ftp://example.com/x',
      'file:///etc/passwd',
      'https://user:pass@example.com/x',
      'not a url',
    ]) {
      const { res, body } = await call('POST', '/webhooks', { url });
      assert.equal(res.status, 400, url);
      assert.equal(body.error.parameter, 'url', url);
    }
  });
});

test('isPrivateAddress classifies loopback, private and reserved ranges', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.31.255.255', '192.168.0.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fc00::1', 'ff02::1', '::ffff:10.0.0.1', '::ffff:7f00:1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test('filters are validated like the REST parameters', async () => {
  await withApi(FAST, async ({ call }) => {
    for (const filter of [{ contractId: 'nope' }, { address: 'nope' }, { topics: [1] }, { unknown: 1 }, 'string']) {
      const { res } = await call('POST', '/webhooks', { url: 'http://127.0.0.1:9/x', filter });
      assert.equal(res.status, 400, JSON.stringify(filter));
    }
    const ok = await call('POST', '/webhooks', { url: 'http://127.0.0.1:9/x', filter: { contractId: SAC, topics: ['transfer', null] } });
    assert.equal(ok.res.status, 201);
    assert.deepEqual(ok.body.filter, { contractId: SAC, topics: ['transfer', null] });
    // Topic positions past the fourth are filterable since #164, so a deep filter is valid.
    const deep = await call('POST', '/webhooks', { url: 'http://127.0.0.1:9/x', filter: { topics: ['a', 'b', 'c', 'd', 'e'] } });
    assert.equal(deep.res.status, 201);
  });
});

test('an invalid body or secret is rejected', async () => {
  await withApi(FAST, async ({ call }) => {
    assert.equal((await call('POST', '/webhooks', [])).res.status, 400);
    assert.equal((await call('POST', '/webhooks', {})).res.status, 400);
    assert.equal((await call('POST', '/webhooks', { url: 'http://127.0.0.1:9/x', secret: 'short' })).res.status, 400);
    const custom = await call('POST', '/webhooks', { url: 'http://127.0.0.1:9/x', secret: 'a-secret-of-sufficient-length' });
    assert.equal(custom.body.secret, 'a-secret-of-sufficient-length');
  });
});

test('a bearer token can be required, and deleting a webhook stops deliveries', async () => {
  await withReceiver(() => ({}), async ({ received, url }) => {
    await withApi({ ...FAST, authToken: 'letmein-letmein' }, async ({ store, call }) => {
      const noAuth = await call('POST', '/webhooks', { url });
      assert.equal(noAuth.res.status, 401);
      const wrong = await call('GET', '/webhooks', undefined, { authorization: 'Bearer nope' });
      assert.equal(wrong.res.status, 401);

      const auth = { authorization: 'Bearer letmein-letmein' };
      const reg = await call('POST', '/webhooks', { url }, auth);
      assert.equal(reg.res.status, 201);
      assert.equal((await call('GET', '/webhooks', undefined, auth)).body.webhooks.length, 1);

      const del = await call('DELETE', `/webhooks/${reg.body.id}`, undefined, auth);
      assert.deepEqual(del.body, { deleted: true, id: reg.body.id });
      assert.equal((await call('GET', `/webhooks/${reg.body.id}`, undefined, auth)).res.status, 404);

      await store.insertEvents(sacEvents);
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(received.length, 0);
    });
  });
});

test('verifyWebhookSignature rejects stale timestamps and malformed headers', () => {
  const secret = 'a-secret-of-sufficient-length';
  assert.equal(verifyWebhookSignature(secret, 'garbage', '{}'), false);
  assert.equal(verifyWebhookSignature(secret, 't=1,v1=00', '{}'), false);
});
