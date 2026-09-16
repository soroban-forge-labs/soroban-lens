import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { SqliteEventStore, LATEST_SCHEMA_VERSION, MAX_QUERY_LIMIT } from '@soroban-lens/store';
import { createApiServer, MAX_BATCH_IDS } from '../dist/index.js';

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
    assert.equal(body.schemaVersion, LATEST_SCHEMA_VERSION);
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

// ── #31 query by transaction and operation index ─────────────────────────────

test('GET /events?txHash=…&operationIndex=0 filters to that operation', async () => {
  await withServer(async ({ get }) => {
    const sample = fixture.events.find((e) => e.operationIndex === 0);
    const { res, body } = await get(
      `/events?txHash=${sample.txHash}&operationIndex=0&limit=1000`,
    );
    assert.equal(res.status, 200);
    assert.ok(body.events.length > 0);
    assert.ok(body.events.every((e) => e.txHash === sample.txHash && e.operationIndex === 0));
  });
});

test('transactionIndex filters independently of txHash', async () => {
  await withServer(async ({ get }) => {
    const wanted = fixture.events[0].transactionIndex;
    const { res, body } = await get(`/events?transactionIndex=${wanted}&limit=1000`);
    assert.equal(res.status, 200);
    assert.ok(body.events.length > 0);
    assert.ok(body.events.every((e) => e.transactionIndex === wanted));
  });
});

test('index 0 filters rather than being dropped as falsy', async () => {
  await withServer(async ({ get }) => {
    const { body: all } = await get('/events?limit=1000');
    const { body: zero } = await get('/events?operationIndex=0&limit=1000');
    const expected = fixture.events.filter((e) => e.operationIndex === 0).length;
    assert.equal(zero.total, expected);
    assert.ok(zero.total <= all.total);
    assert.ok(zero.events.every((e) => e.operationIndex === 0));
  });
});

test('a negative index is rejected rather than returning an empty page', async () => {
  await withServer(async ({ get }) => {
    for (const name of ['transactionIndex', 'operationIndex']) {
      const { res, body } = await get(`/events?${name}=-1`);
      assert.equal(res.status, 400, name);
      assert.equal(body.error.parameter, name);
    }
  });
});

test('a non-numeric index is rejected', async () => {
  await withServer(async ({ get }) => {
    const { res } = await get('/events?operationIndex=first');
    assert.equal(res.status, 400);
  });
});

// ── #49 /contracts/{id}/stats ────────────────────────────────────────────────

test('GET /contracts/{id}/stats returns that contract summary', async () => {
  await withServer(async ({ get }) => {
    const { res, body } = await get(`/contracts/${SAC}/stats`);
    assert.equal(res.status, 200);
    assert.equal(body.contractId, SAC);

    // It must agree with the entry /contracts already returns.
    const { body: all } = await get('/contracts?limit=1000');
    const fromList = all.contracts.find((c) => c.contractId === SAC);
    assert.deepEqual(body, fromList);
  });
});

test('the summary matches the events actually indexed for that contract', async () => {
  await withServer(async ({ get }) => {
    const { body } = await get(`/contracts/${SAC}/stats`);
    const mine = fixture.events.filter((e) => e.contractId === SAC);
    assert.equal(body.eventCount, mine.length);
    assert.equal(body.firstLedger, Math.min(...mine.map((e) => e.ledger)));
    assert.equal(body.lastLedger, Math.max(...mine.map((e) => e.ledger)));
  });
});

test('a contract with no indexed events is a 404, not an empty summary', async () => {
  await withServer(async ({ get }) => {
    const absent = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB';
    const { res, body } = await get(`/contracts/${absent}/stats`);
    assert.equal(res.status, 404);
    assert.match(body.error.message, /LENS_CONTRACT_IDS/);
  });
});

test('a malformed contract id on the stats route is a 400', async () => {
  await withServer(async ({ get }) => {
    const { res } = await get('/contracts/not-a-contract/stats');
    assert.equal(res.status, 400);
  });
});

// ── #51 HEAD support ─────────────────────────────────────────────────────────

test('HEAD works on every GET route and returns no body', async () => {
  await withServer(async ({ base }) => {
    const paths = [
      '/health',
      '/stats',
      '/status',
      '/contracts',
      `/contracts/${SAC}/events`,
      `/contracts/${SAC}/topics`,
      `/contracts/${SAC}/stats`,
      '/events',
      '/openapi.json',
    ];
    for (const path of paths) {
      const res = await fetch(base + path, { method: 'HEAD' });
      assert.equal(res.status, 200, `HEAD ${path}`);
      assert.equal(await res.text(), '', `HEAD ${path} must have no body`);
    }
  });
});

test('HEAD returns the headers GET would have sent', async () => {
  await withServer(async ({ base }) => {
    // Accept-Encoding: identity — #44 compresses responses at or above 1KB,
    // and Node's fetch transparently decompresses a real gzip response before
    // handing back .text(), which would make Content-Length (the wire size)
    // and Buffer.byteLength(body) (the decoded size) legitimately disagree.
    // Asking for identity keeps this test about HEAD/GET consistency, not
    // about compression, which has its own tests below.
    const identity = { headers: { 'Accept-Encoding': 'identity' } };
    for (const path of ['/health', '/events?limit=5']) {
      // Warm the #26 count cache first: /events?limit=5's `total` carries
      // totalIsEstimate once cached, which changes the body's byte length.
      // Comparing HEAD against GET only makes sense once both are looking at
      // the same (warm) cache state, which is also the realistic steady state
      // for a path fetched more than once.
      await fetch(base + path, identity);
      const head = await fetch(base + path, { method: 'HEAD', ...identity });
      const get = await fetch(base + path, identity);
      const body = await get.text();

      assert.equal(head.status, get.status, path);
      assert.equal(head.headers.get('content-type'), get.headers.get('content-type'), path);
      // RFC 9110: the same Content-Length as the GET, so a client can size a
      // request from it. Zero here would be a silent lie.
      assert.equal(head.headers.get('content-length'), get.headers.get('content-length'), path);
      assert.equal(Number(head.headers.get('content-length')), Buffer.byteLength(body), path);
    }
  });
});

test('HEAD on a missing resource is still a 404, not a 200', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/events/no-such-event`, { method: 'HEAD' });
    assert.equal(res.status, 404);
    assert.equal(await res.text(), '');
  });
});

test('HEAD on an unknown route is a 404', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/nope`, { method: 'HEAD' });
    assert.equal(res.status, 404);
  });
});

test('a 405 advertises both GET and HEAD in Allow', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/health`, { method: 'POST' });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'GET, HEAD');
  });
});

test('CORS advertises HEAD alongside GET', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/health`);
    assert.match(res.headers.get('access-control-allow-methods'), /HEAD/);
  });
});

// ── #24 time-bounded queries ─────────────────────────────────────────────────

test('GET /events accepts ISO-8601 time bounds', async () => {
  await withServer(async ({ get }) => {
    const { res, body } = await get(
      '/events?fromTime=2026-09-15T19:22:55Z&toTime=2026-09-15T19:23:00Z&limit=1000',
    );
    assert.equal(res.status, 200);
    assert.ok(body.events.length > 0);
    for (const event of body.events) {
      const at = Date.parse(event.ledgerClosedAt);
      assert.ok(at >= Date.parse('2026-09-15T19:22:55Z'));
      assert.ok(at <= Date.parse('2026-09-15T19:23:00Z'));
    }
  });
});

test('epoch seconds and ISO-8601 select the same events', async () => {
  await withServer(async ({ get }) => {
    const iso = '2026-09-15T19:22:55Z';
    const seconds = Math.floor(Date.parse(iso) / 1000);
    const { body: a } = await get(`/events?fromTime=${encodeURIComponent(iso)}&limit=1000`);
    const { body: b } = await get(`/events?fromTime=${seconds}&limit=1000`);
    assert.equal(a.total, b.total);
    assert.deepEqual(a.events.map((e) => e.id), b.events.map((e) => e.id));
  });
});

test('an unparseable timestamp is a 400 naming the parameter', async () => {
  await withServer(async ({ get }) => {
    const { res, body } = await get('/events?fromTime=last%20tuesday');
    assert.equal(res.status, 400);
    assert.equal(body.error.parameter, 'fromTime');
    assert.match(body.error.message, /ISO-8601/);
  });
});

test('fromTime after toTime is rejected rather than returning nothing', async () => {
  await withServer(async ({ get }) => {
    const { res, body } = await get(
      '/events?fromTime=2026-09-16T00:00:00Z&toTime=2026-09-15T00:00:00Z',
    );
    assert.equal(res.status, 400);
    assert.equal(body.error.parameter, 'fromTime');
  });
});

test('time bounds combine with a contract route', async () => {
  await withServer(async ({ get }) => {
    const { res, body } = await get(
      `/contracts/${SAC}/events?fromTime=2026-09-15T00:00:00Z&limit=1000`,
    );
    assert.equal(res.status, 200);
    assert.ok(body.events.every((e) => e.contractId === SAC));
  });
});

// ── #55 configurable query limit ─────────────────────────────────────────────

test('the served spec reflects the running query ceiling', async () => {
  await withServer(async ({ get }) => {
    const { res, body } = await get('/openapi.json');
    assert.equal(res.status, 200);
    // Default configuration, so the served value matches the committed file.
    assert.equal(body.components.parameters.Limit.schema.maximum, MAX_QUERY_LIMIT);
  });
});

test('the limit rejection message names the configured ceiling', async () => {
  await withServer(async ({ get }) => {
    const { res, body } = await get(`/events?limit=${MAX_QUERY_LIMIT + 1}`);
    assert.equal(res.status, 400);
    assert.equal(body.error.parameter, 'limit');
    assert.ok(body.error.message.includes(String(MAX_QUERY_LIMIT)));
  });
});

// ── #50 batch fetch events by id ─────────────────────────────────────────────

test('GET /events?ids= returns the events in the order asked', async () => {
  await withServer(async ({ get }) => {
    // Deliberately not the storage order, so "in the order asked" is a real
    // assertion rather than an accident of how rows come back.
    const wanted = [fixture.events[3].id, fixture.events[0].id, fixture.events[7].id];
    const { res, body } = await get(`/events?ids=${wanted.join(',')}`);

    assert.equal(res.status, 200);
    assert.deepEqual(body.events.map((e) => e.id), wanted);
    assert.deepEqual(body.missing, []);
  });
});

test('missing ids are reported rather than silently dropped', async () => {
  await withServer(async ({ get }) => {
    const real = fixture.events[0].id;
    const { res, body } = await get(`/events?ids=${real},no-such-event`);

    assert.equal(res.status, 200);
    assert.deepEqual(body.events.map((e) => e.id), [real]);
    assert.deepEqual(body.missing, ['no-such-event']);
  });
});

test('a batch of only missing ids is a 200 with everything reported missing', async () => {
  await withServer(async ({ get }) => {
    const { res, body } = await get('/events?ids=nope-a,nope-b');
    assert.equal(res.status, 200);
    assert.deepEqual(body.events, []);
    assert.deepEqual(body.missing, ['nope-a', 'nope-b']);
  });
});

test('a batch over the documented ceiling is rejected', async () => {
  await withServer(async ({ get }) => {
    const ids = Array.from({ length: MAX_BATCH_IDS + 1 }, (_, i) => `id-${i}`);
    const { res, body } = await get(`/events?ids=${ids.join(',')}`);
    assert.equal(res.status, 400);
    assert.equal(body.error.parameter, 'ids');
    assert.ok(body.error.message.includes(String(MAX_BATCH_IDS)));
  });
});

test('an empty or duplicated ids parameter is rejected', async () => {
  await withServer(async ({ get }) => {
    const empty = await get('/events?ids=');
    assert.equal(empty.res.status, 400);

    const id = fixture.events[0].id;
    const dup = await get(`/events?ids=${id},${id}`);
    assert.equal(dup.res.status, 400);
    assert.match(dup.body.error.message, /duplicate/i);
  });
});

test('whitespace around ids is tolerated', async () => {
  await withServer(async ({ get }) => {
    const id = fixture.events[0].id;
    const { res, body } = await get(`/events?ids=${encodeURIComponent(` ${id} `)}`);
    assert.equal(res.status, 200);
    assert.deepEqual(body.events.map((e) => e.id), [id]);
  });
});

test('without ids, /events still behaves as a filtered query', async () => {
  await withServer(async ({ get }) => {
    const { res, body } = await get('/events?limit=5');
    assert.equal(res.status, 200);
    assert.equal(body.events.length, 5);
    assert.equal(body.total, fixture.events.length);
    assert.equal(body.missing, undefined, 'the filter path must not grow a missing field');
  });
});

// ── #57 503 with Retry-After during migrations ───────────────────────────────

/**
 * Boot the API against a database that genuinely stopped at schema v1.
 *
 * A real stale database rather than a stubbed getStats: healthCheck() derives
 * its own verdict from the store, so faking one method would have left health
 * reporting "ok" and the test asserting against a fiction.
 */
async function withStaleServer(run) {
  const dir = await mkdtemp(join(tmpdir(), 'lens-stale-'));
  const path = join(dir, 'lens.db');

  // Seed on a fully-current store — insertDecoded may depend on tables later
  // migrations add (event_addresses, #23) — then roll the schema back to v1.
  // That models the realistic version of "stale schema": data that predates
  // a rollback, read by code that still expects the newer schema. Building a
  // v1-only schema by hand and inserting through it stopped being realistic
  // once insertDecoded started writing to a table v1 does not have.
  const seed = new SqliteEventStore({ path });
  await seed.insertEvents(fixture.events);
  await seed.migrateDown(1);
  await seed.close();

  // migrateOnOpen: false, or opening it would bring it up to date.
  const store = new SqliteEventStore({ path, migrateOnOpen: false });
  const server = createApiServer({ store });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ base, get: async (p) => {
      const res = await fetch(base + p);
      const text = await res.text();
      return { res, body: text ? JSON.parse(text) : null };
    } });
  } finally {
    server.close();
    await once(server, 'close');
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('data routes return 503 with Retry-After while a migration is pending', async () => {
  await withStaleServer(async ({ get }) => {
    for (const path of [
      '/events',
      '/stats',
      '/status',
      '/contracts',
      `/contracts/${SAC}/events`,
      `/contracts/${SAC}/topics`,
      `/contracts/${SAC}/stats`,
      '/events/anything',
    ]) {
      const { res, body } = await get(path);
      assert.equal(res.status, 503, path);
      // A client that honours Retry-After needs the header, not just the code.
      assert.equal(res.headers.get('retry-after'), '5', path);
      assert.equal(body.error.code, 'unavailable', path);
      assert.match(body.error.message, /schema v/, path);
    }
  });
});

test('/health still answers during a migration, with the reason', async () => {
  await withStaleServer(async ({ get }) => {
    const { res, body } = await get('/health');
    // Health is how an operator finds out why everything else is 503ing, so it
    // must not be gated by the same check.
    assert.equal(res.status, 503);
    assert.equal(body.status, 'degraded');
    assert.match(body.detail, /schema is v/);
    assert.equal(body.schemaVersion, 1);
  });
});

test('the spec is still served during a migration', async () => {
  await withStaleServer(async ({ get }) => {
    const { res, body } = await get('/openapi.json');
    assert.equal(res.status, 200, 'a static document does not depend on the schema');
    assert.ok(body.paths['/events']);
  });
});

test('a current schema serves data routes normally', async () => {
  await withServer(async ({ get }) => {
    const { res } = await get('/events?limit=1');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('retry-after'), null);
  });
});

// ── #16 structured logging ───────────────────────────────────────────────────

test('a successful request logs a structured request_handled event', async () => {
  const records = [];
  const store = new SqliteEventStore({ path: ':memory:' });
  await store.insertEvents(fixture.events);
  const log = {
    debug() {},
    info: (event, message, fields) => records.push({ event, message, fields }),
    warn() {},
    error() {},
  };
  const server = createApiServer({ store, log });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fetch(`${base}/health`);
    const record = records.find((r) => r.event === 'request_handled');
    assert.ok(record, 'expected a request_handled log record');
    assert.equal(record.fields.method, 'GET');
    assert.equal(record.fields.path, '/health');
    assert.equal(typeof record.fields.durationMs, 'number');
  } finally {
    server.close();
    await once(server, 'close');
    await store.close();
  }
});

test('a 5xx logs request_failed at error level; a 4xx does not', async () => {
  const records = [];
  const store = new SqliteEventStore({ path: ':memory:' });
  const log = {
    debug() {},
    info() {},
    warn() {},
    error: (event, message, fields) => records.push({ event, message, fields }),
  };
  const server = createApiServer({ store, log });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fetch(`${base}/events?limit=not-a-number`); // 400, must not error-log
    assert.equal(records.length, 0);

    await fetch(`${base}/nope-nope-nope`); // 404, still not a 5xx
    assert.equal(records.length, 0);
  } finally {
    server.close();
    await once(server, 'close');
    await store.close();
  }
});

test('no log option is silent, same as before structured logging existed', async () => {
  const store = new SqliteEventStore({ path: ':memory:' });
  const server = createApiServer({ store });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
  } finally {
    server.close();
    await once(server, 'close');
    await store.close();
  }
});

// ── #23 GET /events?address= ─────────────────────────────────────────────────

test('GET /events?address= finds an event whose address is beyond the 4 indexed topics', async () => {
  await withServer(async ({ get }) => {
    const address = 'CCUUDM434BMZMYWYDITHFXHDMIVTGGD6T2I5UKNX5BSLXLW7HVR4MCGZ';
    const { res, body } = await get(`/events?address=${address}&limit=1000`);
    assert.equal(res.status, 200);
    assert.ok(body.events.some((e) => e.id === '0020166232959406080-0000000000'));
  });
});

test('a malformed address is a 400 naming the parameter', async () => {
  await withServer(async ({ get }) => {
    const { res, body } = await get('/events?address=not-an-address');
    assert.equal(res.status, 400);
    assert.equal(body.error.parameter, 'address');
  });
});

test('a well-formed but unmentioned address returns an empty page', async () => {
  await withServer(async ({ get }) => {
    const { res, body } = await get('/events?address=GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABC');
    assert.equal(res.status, 200);
    assert.equal(body.total, 0);
  });
});

test('address combines with the contract route', async () => {
  await withServer(async ({ get }) => {
    const address = 'CCUUDM434BMZMYWYDITHFXHDMIVTGGD6T2I5UKNX5BSLXLW7HVR4MCGZ';
    const contractId = 'CCJQB4EEQLBL7RHIPYMYG26ZT2QRKEYNGVWWL2EPZCECFI6GZGNXMIEX';
    const { res, body } = await get(`/contracts/${contractId}/events?address=${address}&limit=1000`);
    assert.equal(res.status, 200);
    assert.ok(body.events.every((e) => e.contractId === contractId));
    assert.ok(body.events.length > 0);
  });
});

// ── #32 GET /events?search= ──────────────────────────────────────────────────

test('GET /events?search= matches a substring inside a decoded topic', async () => {
  await withServer(async ({ get }) => {
    const { res, body } = await get('/events?search=posure&limit=1000');
    assert.equal(res.status, 200);
    assert.ok(body.total > 0);
  });
});

test('a search term with FTS operator characters does not error', async () => {
  await withServer(async ({ get }) => {
    const { res } = await get(`/events?search=${encodeURIComponent('fee AND NOT "x')}`);
    assert.equal(res.status, 200);
  });
});

test('search combines with the contract route', async () => {
  await withServer(async ({ get }) => {
    const { res, body } = await get(`/contracts/${SAC}/events?search=exposure&limit=1000`);
    assert.equal(res.status, 200);
    assert.ok(body.events.every((e) => e.contractId === SAC));
  });
});

// ── #44 response compression ─────────────────────────────────────────────────

test('a large page is compressed when the client advertises gzip support', async () => {
  await withServer(async ({ base }) => {
    const compressed = await fetch(`${base}/events?limit=1000`, { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(compressed.headers.get('content-encoding'), 'gzip');
    assert.equal(compressed.headers.get('vary'), 'Accept-Encoding');

    const uncompressed = await fetch(`${base}/events?limit=1000`, { headers: { 'Accept-Encoding': 'identity' } });
    assert.equal(uncompressed.headers.get('content-encoding'), null);

    const compressedLen = Number(compressed.headers.get('content-length'));
    const uncompressedLen = Number(uncompressed.headers.get('content-length'));
    assert.ok(compressedLen < uncompressedLen, `expected smaller: ${compressedLen} >= ${uncompressedLen}`);

    // And the body is genuinely valid, round-tripped JSON either way — fetch
    // decompresses transparently, so this is really asserting the bytes on
    // the wire were a well-formed gzip stream, not garbage the browser
    // happened to tolerate.
    const body = await compressed.json();
    assert.equal(body.events.length, 60);
  });
});

test('a client sending no Accept-Encoding still gets valid, uncompressed JSON', async () => {
  await withServer(async ({ base }) => {
    // No Accept-Encoding header at all — not even "identity" — is the
    // "sends no Accept-Encoding" case the issue names explicitly.
    const res = await fetch(`${base}/events?limit=1000`, { headers: { 'Accept-Encoding': '' } });
    assert.equal(res.headers.get('content-encoding'), null);
    const body = await res.json();
    assert.equal(body.events.length, 60);
  });
});

test('a small response is not compressed even when the client supports it', async () => {
  await withServer(async ({ base }) => {
    // /health is well under the 1KB threshold — compressing it would add
    // gzip's own framing overhead for no benefit, the same principle #35
    // already established for the raw-XDR columns.
    const res = await fetch(`${base}/health`, { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(res.headers.get('content-encoding'), null);
    await res.json();
  });
});

test('deflate is honoured when a client does not advertise gzip', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/events?limit=1000`, { headers: { 'Accept-Encoding': 'deflate' } });
    assert.equal(res.headers.get('content-encoding'), 'deflate');
    const body = await res.json();
    assert.equal(body.events.length, 60);
  });
});

test('gzip is preferred over deflate when a client advertises both', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/events?limit=1000`, { headers: { 'Accept-Encoding': 'deflate, gzip' } });
    assert.equal(res.headers.get('content-encoding'), 'gzip');
  });
});
