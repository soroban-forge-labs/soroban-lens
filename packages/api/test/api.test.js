import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { SqliteEventStore } from '@soroban-lens/store';
import { createApiServer } from '../dist/index.js';

const fixture = JSON.parse(readFileSync(new URL('../../../fixtures/testnet-events.json', import.meta.url), 'utf8'));
const SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

/** Boot a real HTTP server on an ephemeral port, seeded from the fixture. */
async function withServer(run, { seed = true } = {}) {
  const store = new SqliteEventStore({ path: ':memory:' });
  if (seed) await store.insertEvents(fixture.events);
  const server = createApiServer({ store });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ base, store, get: async (path) => {
      const res = await fetch(base + path);
      const text = await res.text();
      return { res, body: text ? JSON.parse(text) : null };
    } });
  } finally {
    server.close();
    await once(server, 'close');
    await store.close();
  }
}

test('GET /health reports a writable store', async () => {
  await withServer(async ({ get }) => {
    const { res, body } = await get('/health');
    assert.equal(res.status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(body.events, fixture.events.length);
    assert.equal(body.schemaVersion, 1);
    assert.equal(typeof body.uptimeSeconds, 'number');
  });
});

test('the documented deliverable works: GET /contracts/{id}/events?limit=50', async () => {
  await withServer(async ({ get }) => {
    const { res, body } = await get(`/contracts/${SAC}/events?limit=50`);
    assert.equal(res.status, 200);
    assert.ok(body.events.length > 0);
    assert.ok(body.events.length <= 50);
    assert.ok(body.events.every((e) => e.contractId === SAC));
    assert.equal(typeof body.total, 'number');
    assert.ok('nextCursor' in body);
  });
});

test('events carry decoded topics and value alongside raw XDR', async () => {
  await withServer(async ({ get }) => {
    const { body } = await get(`/contracts/${SAC}/events?limit=1`);
    const event = body.events[0];
    assert.equal(typeof event.topics[0].type, 'string');
    assert.equal(typeof event.value.type, 'string');
    assert.equal(event.topicsXdr.length, event.topics.length);
    assert.match(event.valueXdr, /^[A-Za-z0-9+/=]+$/);
  });
});

test('i128 values are serialised as strings, not numbers', async () => {
  await withServer(async ({ get }) => {
    const { body } = await get(`/contracts/${SAC}/events?limit=50`);
    const i128 = body.events.find((e) => e.value.type === 'i128');
    assert.ok(i128, 'fixture should contain an i128 event');
    assert.equal(typeof i128.value.value, 'string');
  });
});

test('CORS headers allow a browser UI on another origin', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    const preflight = await fetch(`${base}/health`, { method: 'OPTIONS' });
    assert.equal(preflight.status, 204);
  });
});

test('keyset pagination via nextCursor covers every event exactly once', async () => {
  await withServer(async ({ get }) => {
    const seen = [];
    let path = '/events?limit=8';
    for (let guard = 0; guard < 50; guard++) {
      const { body } = await get(path);
      seen.push(...body.events.map((e) => e.id));
      if (!body.nextCursor) break;
      path = `/events?limit=8&cursor=${encodeURIComponent(body.nextCursor)}`;
    }
    assert.equal(seen.length, fixture.events.length);
    assert.equal(new Set(seen).size, seen.length);
  });
});

test('topic filtering uses a positional prefix', async () => {
  await withServer(async ({ get }) => {
    const { body } = await get('/events?topic=transfer&limit=100');
    assert.ok(body.events.length > 0);
    assert.ok(body.events.every((e) => e.topics[0].value === 'transfer'));
  });
});

test('a * topic segment is a wildcard', async () => {
  await withServer(async ({ get }) => {
    const { res, body } = await get('/events?topic=*&topic=order&limit=10');
    assert.equal(res.status, 200);
    assert.ok(body.events.length > 0);
    assert.ok(body.events.every((e) => e.topics[1].value === 'order'));
  });
});

test('ledger range filters are applied', async () => {
  await withServer(async ({ get }) => {
    const { body } = await get('/events?fromLedger=4695318&toLedger=4695320&limit=100');
    assert.ok(body.events.length > 0);
    assert.ok(body.events.every((e) => e.ledger >= 4695318 && e.ledger <= 4695320));
  });
});

test('successfulOnly=true drops failed contract calls', async () => {
  await withServer(async ({ get }) => {
    const all = await get('/events?limit=1000');
    const ok = await get('/events?limit=1000&successfulOnly=true');
    assert.ok(ok.body.total < all.body.total);
    assert.ok(ok.body.events.every((e) => e.inSuccessfulContractCall));
  });
});

test('GET /contracts summarises indexed contracts', async () => {
  await withServer(async ({ get }) => {
    const { body } = await get('/contracts');
    assert.equal(body.contracts.length, new Set(fixture.events.map((e) => e.contractId)).size);
    assert.ok(body.contracts.every((c) => c.eventCount > 0));
  });
});

test('GET /contracts/{id}/topics ranks topics by frequency', async () => {
  await withServer(async ({ get }) => {
    const { body } = await get(`/contracts/${SAC}/topics`);
    assert.equal(body.contractId, SAC);
    assert.ok(body.topics.map((t) => t.topic).includes('transfer'));
  });
});

test('GET /events/{id} returns one event, and 404s for an unknown id', async () => {
  await withServer(async ({ get }) => {
    const id = fixture.events[0].id;
    const found = await get(`/events/${encodeURIComponent(id)}`);
    assert.equal(found.res.status, 200);
    assert.equal(found.body.id, id);

    const missing = await get('/events/0000000000000000000-0000000000');
    assert.equal(missing.res.status, 404);
    assert.equal(missing.body.error.code, 'not_found');
  });
});

test('GET /status exposes indexer stream progress', async () => {
  await withServer(async ({ get, store }) => {
    await store.saveStreamState({ key: 'testnet-abc', cursor: 'c1', ledger: 4695324, updatedAt: '2026-09-15T19:30:00Z' });
    const { body } = await get('/status');
    assert.equal(body.streams.length, 1);
    assert.equal(body.streams[0].ledger, 4695324);
    assert.equal(body.eventCount, fixture.events.length);
  });
});

test('an invalid contract id is rejected with a useful message', async () => {
  await withServer(async ({ get }) => {
    const { res, body } = await get('/contracts/not-a-contract/events');
    assert.equal(res.status, 400);
    assert.equal(body.error.code, 'invalid_parameter');
    assert.equal(body.error.parameter, 'contractId');
    assert.match(body.error.message, /StrKey/);
  });
});

test('out-of-range and malformed parameters are rejected, not silently clamped', async () => {
  await withServer(async ({ get }) => {
    const cases = [
      ['/events?limit=5000', 'limit'],
      ['/events?limit=0', 'limit'],
      ['/events?limit=abc', 'limit'],
      ['/events?order=sideways', 'order'],
      ['/events?fromLedger=200&toLedger=100', 'fromLedger'],
      ['/events?txHash=nothex', 'txHash'],
      ['/events?successfulOnly=maybe', 'successfulOnly'],
      ['/events?topic=a&topic=b&topic=c&topic=d&topic=e', 'topic'],
    ];
    for (const [path, parameter] of cases) {
      const { res, body } = await get(path);
      assert.equal(res.status, 400, `${path} should be a 400`);
      assert.equal(body.error.parameter, parameter, `${path} should blame "${parameter}"`);
    }
  });
});

test('unknown routes 404 and point at the spec', async () => {
  await withServer(async ({ get }) => {
    const { res, body } = await get('/nope');
    assert.equal(res.status, 404);
    assert.match(body.error.message, /openapi\.json/);
  });
});

test('a non-GET method on a known route is a 405', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/events`, { method: 'DELETE' });
    assert.equal(res.status, 405);
    assert.equal((await res.json()).error.code, 'method_not_allowed');
  });
});

test('trailing slashes resolve to the same route', async () => {
  await withServer(async ({ get }) => {
    assert.equal((await get('/contracts/')).res.status, 200);
  });
});

test('GET /openapi.json serves the committed spec and describes every route', async () => {
  await withServer(async ({ get }) => {
    const { res, body } = await get('/openapi.json');
    assert.equal(res.status, 200);
    assert.equal(body.openapi, '3.1.0');
    for (const path of ['/health', '/stats', '/status', '/contracts', '/contracts/{contractId}/events',
      '/contracts/{contractId}/topics', '/events', '/events/{eventId}']) {
      assert.ok(body.paths[path], `spec is missing ${path}`);
    }
  });
});

test('an empty database still answers rather than erroring', async () => {
  await withServer(async ({ get }) => {
    const health = await get('/health');
    assert.equal(health.res.status, 200);
    assert.equal(health.body.events, 0);
    const events = await get('/events');
    assert.deepEqual(events.body, { events: [], nextCursor: null, total: 0 });
  }, { seed: false });
});
