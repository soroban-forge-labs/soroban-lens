import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { nativeToScVal } from '@stellar/stellar-sdk';
import { SqliteEventStore, LATEST_SCHEMA_VERSION, MAX_QUERY_LIMIT } from '@soroban-lens/store';
import { createApiServer, shutdownApiServer, MAX_BATCH_IDS } from '../dist/index.js';

/** Whether this process's SQLite build has FTS5 compiled in — see the store's own note for why this can vary. */
const FTS5_AVAILABLE = (() => {
  try {
    const probe = new DatabaseSync(':memory:');
    probe.exec("CREATE VIRTUAL TABLE t USING fts5(x)");
    probe.close();
    return true;
  } catch {
    return false;
  }
})();

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
    assert.deepEqual(events.body, { events: [], nextCursor: null, prevCursor: null, total: 0 });
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
describe('search (#32)', { skip: !FTS5_AVAILABLE && 'this SQLite build has no FTS5' }, () => {

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

});
// ── #44 response compression ─────────────────────────────────────────────────

test('a large page is compressed when the client advertises gzip support', async () => {
  await withServer(async ({ base }) => {
    const compressed = await fetch(`${base}/events?limit=1000`, { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(compressed.headers.get('content-encoding'), 'gzip');
    // Accept as well: the event lists negotiate JSON versus CSV on it (#41).
    assert.equal(compressed.headers.get('vary'), 'Accept, Accept-Encoding');

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

// ── #45 GET /docs ─────────────────────────────────────────────────────────────

test('GET /docs renders an HTML page pointing Redoc at the live spec', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/docs`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.match(html, /<redoc spec-url="\/openapi\.json">/);
    assert.match(html, /redoc\.standalone\.js/);
    // Pinned, not @latest — an unrelated Redoc release must not change this route.
    assert.ok(!html.includes('redoc@latest'));
  });
});

test('/docs reads the same spec /openapi.json serves — no duplicated content', async () => {
  await withServer(async ({ base }) => {
    const docs = await fetch(`${base}/docs`);
    const html = await docs.text();
    // The page references the live route rather than embedding a copy of the
    // spec, so it can never drift from what /openapi.json actually serves.
    assert.match(html, /spec-url="\/openapi\.json"/);
    assert.ok(!html.includes('"openapi"'), 'the spec must not be embedded inline');
  });
});

test('HEAD /docs works, matching every other GET route', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/docs`, { method: 'HEAD' });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '');
  });
});

// ── #46 structured request logging with request ids ─────────────────────────

test('every response carries an X-Request-Id header', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/health`);
    const id = res.headers.get('x-request-id');
    assert.ok(id && id.length > 0);
  });
});

test('an inbound X-Request-Id is honoured rather than replaced', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/health`, { headers: { 'X-Request-Id': 'upstream-abc-123' } });
    assert.equal(res.headers.get('x-request-id'), 'upstream-abc-123');
  });
});

test('an error response body carries the same request id as the header', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/events?limit=not-a-number`);
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.equal(body.error.requestId, res.headers.get('x-request-id'));
    assert.ok(body.error.requestId.length > 0);
  });
});

test('a request_handled log record carries the same id as the response header', async () => {
  const records = [];
  const store = new SqliteEventStore({ path: ':memory:' });
  await store.insertEvents(fixture.events);
  const log = { debug() {}, info: (e, m, f) => records.push({ event: e, fields: f }), warn() {}, error() {} };
  const server = createApiServer({ store, log });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/health`);
    const headerId = res.headers.get('x-request-id');
    const record = records.find((r) => r.event === 'request_handled');
    assert.equal(record.fields.requestId, headerId);
  } finally {
    server.close();
    await once(server, 'close');
    await store.close();
  }
});

test('a request_failed (5xx) log record carries the same id as the error body', async () => {
  const records = [];
  const dir = await mkdtemp(join(tmpdir(), 'lens-stale-'));
  const path = join(dir, 'lens.db');
  const seed = new SqliteEventStore({ path });
  await seed.insertEvents(fixture.events);
  await seed.migrateDown(1);
  await seed.close();

  const store = new SqliteEventStore({ path, migrateOnOpen: false });
  const log = { debug() {}, info() {}, warn() {}, error: (e, m, f) => records.push({ event: e, fields: f }) };
  const server = createApiServer({ store, log });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // #57's stale-schema 503 is not itself a 5xx the error-log path fires on
    // (only status >= 500 triggers log.error) — 503 IS >= 500, so this is
    // exactly the request_failed path.
    const res = await fetch(`${base}/events`);
    const body = await res.json();
    assert.equal(res.status, 503);
    const record = records.find((r) => r.event === 'request_failed');
    assert.ok(record, 'expected a request_failed log record for a 503');
    assert.equal(record.fields.requestId, body.error.requestId);
  } finally {
    server.close();
    await once(server, 'close');
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ── #33 typed decoding ────────────────────────────────────────────────────────

const specFixture = JSON.parse(
  readFileSync(new URL('../../../fixtures/testnet-specs.json', import.meta.url), 'utf8'),
).specs;

async function withSpecs(run) {
  await withServer(async (ctx) => {
    for (const record of specFixture) await ctx.store.saveContractSpec(record);
    await run(ctx);
  });
}

test('events from a contract with a spec carry a typed view next to the generic decoding', async () => {
  await withSpecs(async ({ get }) => {
    const { body } = await get(`/contracts/${SAC}/events?topic=transfer&limit=1`);
    const [event] = body.events;
    assert.equal(event.typed.name, 'transfer');
    assert.equal(event.typed.source, 'stellar-asset');
    assert.deepEqual(event.typed.fields.map((f) => f.name), ['from', 'to', 'sep0011_asset', 'amount']);
    assert.equal(event.topics[0].value, 'transfer', 'the generic view is still there, untouched');
  });
});

test('the typed view is on every event-returning route', async () => {
  await withSpecs(async ({ get }) => {
    const { body: page } = await get('/events?limit=100');
    const typedEvent = page.events.find((e) => e.typed);
    assert.ok(typedEvent);
    const { body: single } = await get(`/events/${typedEvent.id}`);
    assert.deepEqual(single.typed, typedEvent.typed);
    const { body: batch } = await get(`/events?ids=${typedEvent.id}`);
    assert.deepEqual(batch.events[0].typed, typedEvent.typed);
  });
});

test('events from a contract with no spec have no typed field at all', async () => {
  await withServer(async ({ get }) => {
    const { body } = await get('/events?limit=100');
    assert.ok(body.events.every((e) => !('typed' in e)));
  });
});

test('GET /contracts/{id}/spec summarises the spec, and 404s before any lookup', async () => {
  await withServer(async ({ get, store }) => {
    const missing = await get(`/contracts/${SAC}/spec`);
    assert.equal(missing.res.status, 404);
    assert.match(missing.body.error.message, /lens spec fetch/);

    await store.saveContractSpec(specFixture.find((s) => s.contractId === SAC));
    const { res, body } = await get(`/contracts/${SAC}/spec`);
    assert.equal(res.status, 200);
    assert.equal(body.source, 'stellar-asset');
    assert.ok(body.events.includes('transfer'));
    assert.ok(!('entriesXdr' in body), 'raw entries are not part of the public response');
  });
});

test('the OpenAPI spec documents the typed view and the spec route', async () => {
  await withServer(async ({ get }) => {
    const { body } = await get('/openapi.json');
    assert.ok(body.paths['/contracts/{contractId}/spec']);
    assert.equal(body.components.schemas.Event.properties.typed.$ref, '#/components/schemas/TypedEvent');
  });
});

// ── #58 "no such contract" vs "no events" ────────────────────────────────────

test('events for a contract that was never indexed are a 404, not an empty page', async () => {
  await withServer(async ({ get }) => {
    const absent = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB';
    const { res, body } = await get(`/contracts/${absent}/events`);
    assert.equal(res.status, 404);
    assert.equal(body.error.code, 'not_found');
    assert.match(body.error.message, /LENS_CONTRACT_IDS/);
  });
});

test('a known contract with no matching events is an empty page that says why', async () => {
  await withServer(async ({ get }) => {
    const { res, body } = await get(`/contracts/${SAC}/events?fromLedger=2000000000`);
    assert.equal(res.status, 200);
    assert.deepEqual(body.events, []);
    assert.equal(body.total, 0);
    assert.equal(body.emptyReason, 'no_matching_events');
  });
});

test('a non-empty contract page carries no emptyReason', async () => {
  await withServer(async ({ get }) => {
    const { body } = await get(`/contracts/${SAC}/events?limit=1`);
    assert.ok(body.events.length > 0);
    assert.ok(!('emptyReason' in body));
  });
});

test('the OpenAPI spec documents the 404, emptyReason, /graphql and /webhooks', async () => {
  await withServer(async ({ get }) => {
    const { body } = await get('/openapi.json');
    assert.ok(body.paths['/contracts/{contractId}/events'].get.responses['404']);
    assert.ok(body.components.schemas.EventPage.properties.emptyReason);
    for (const path of ['/graphql', '/webhooks', '/webhooks/{webhookId}', '/webhooks/{webhookId}/dead-letters']) {
      assert.ok(body.paths[path], `spec is missing ${path}`);
    }
  });
});

test('/graphql and /webhooks do not exist unless enabled', async () => {
  await withServer(async ({ base }) => {
    const gql = await fetch(`${base}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ topics(contractId: "x") { topic } }' }),
    });
    assert.equal(gql.status, 404);
    const hooks = await fetch(`${base}/webhooks`);
    assert.equal(hooks.status, 404);
  });
});

test('a 405 on a multi-method route lists every method', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/graphql`, { method: 'DELETE' });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'GET, HEAD, POST');
  });
});

test('?fields= returns only the selected event properties; the default is unchanged', async () => {
  await withServer(async ({ get }) => {
    const full = await get(`/contracts/${SAC}/events?limit=5`);
    const sparse = await get(`/contracts/${SAC}/events?limit=5&fields=id,ledger,topics,value`);
    assert.equal(sparse.res.status, 200);
    assert.equal(sparse.body.events.length, full.body.events.length);
    for (const event of sparse.body.events) {
      assert.deepEqual(Object.keys(event).sort(), ['id', 'ledger', 'topics', 'value']);
    }
    assert.ok('topicsXdr' in full.body.events[0] && 'valueXdr' in full.body.events[0]);
    assert.ok(JSON.stringify(sparse.body).length < JSON.stringify(full.body).length);

    const one = await get(`/events/${encodeURIComponent(full.body.events[0].id)}?fields=id,txHash`);
    assert.deepEqual(Object.keys(one.body).sort(), ['id', 'txHash']);

    const batch = await get(`/events?ids=${encodeURIComponent(full.body.events[0].id)}&fields=id`);
    assert.deepEqual(batch.body.events, [{ id: full.body.events[0].id }]);
  });
});

test('?fields= rejects unknown or empty field names', async () => {
  await withServer(async ({ get }) => {
    const unknown = await get('/events?fields=id,nope');
    assert.equal(unknown.res.status, 400);
    assert.equal(unknown.body.error.parameter, 'fields');
    const empty = await get('/events?fields=');
    assert.equal(empty.res.status, 400);
  });
});

test('GET /contracts/{id}/activity returns correct counts per bucket', async () => {
  await withServer(async ({ get }) => {
    const mine = fixture.events.filter((e) => e.contractId === SAC);
    const expected = new Map();
    for (const e of mine) {
      const start = Math.floor(Date.parse(e.ledgerClosedAt) / 1000 / 3600) * 3600;
      const bucket = expected.get(start) ?? {
        count: 0,
        firstLedger: e.ledger,
        lastLedger: e.ledger,
      };
      bucket.count += 1;
      bucket.firstLedger = Math.min(bucket.firstLedger, e.ledger);
      bucket.lastLedger = Math.max(bucket.lastLedger, e.ledger);
      expected.set(start, bucket);
    }

    const { res, body } = await get(`/contracts/${SAC}/activity?bucket=hour`);
    assert.equal(res.status, 200);
    assert.equal(body.contractId, SAC);
    assert.equal(body.bucket, 'hour');
    const actual = new Map(body.buckets.map((b) => [
      Date.parse(b.start) / 1000,
      { count: b.count, firstLedger: b.firstLedger, lastLedger: b.lastLedger },
    ]));
    assert.deepEqual(actual, expected);
    assert.equal(body.buckets.reduce((n, b) => n + b.count, 0), mine.length);
    const starts = body.buckets.map((b) => b.start);
    assert.deepEqual(starts, [...starts].sort());
  });
});

test('activity honours from/to and rejects bad parameters', async () => {
  await withServer(async ({ get }) => {
    const all = await get(`/contracts/${SAC}/activity?bucket=day`);
    const first = Date.parse(all.body.buckets[0].start) / 1000;

    const none = await get(`/contracts/${SAC}/activity?bucket=day&to=${first - 1}`);
    assert.deepEqual(none.body.buckets, []);

    assert.equal((await get(`/contracts/${SAC}/activity?bucket=week`)).res.status, 400);
    assert.equal((await get(`/contracts/${SAC}/activity?from=2026-09-02&to=2026-09-01`)).res.status, 400);
    assert.equal((await get(`/contracts/${SAC}/activity?from=garbage`)).res.status, 400);
    assert.equal((await get('/contracts/nope/activity')).res.status, 400);
  });
});

test('shutdownApiServer waits for an in-flight request before resolving', async () => {
  const store = new SqliteEventStore({ path: ':memory:' });
  await store.insertEvents(fixture.events);
  const realCount = store.getStats.bind(store);
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let entered;
  const started = new Promise((resolve) => (entered = resolve));
  store.getStats = async () => {
    entered();
    await gate;
    return realCount();
  };

  const server = createApiServer({ store });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  const pending = fetch(`${base}/stats`);
  await started;

  let shutDown = false;
  const shutdown = shutdownApiServer(server, { timeoutMs: 5000 }).then((r) => {
    shutDown = true;
    return r;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(shutDown, false, 'must not finish while a request is in flight');

  release();
  const res = await pending;
  assert.equal(res.status, 200);
  assert.deepEqual(await shutdown, { forced: false });
  await store.close();
});

test('shutdownApiServer drops requests still running after the timeout', async () => {
  const store = new SqliteEventStore({ path: ':memory:' });
  store.getStats = () => new Promise(() => {});
  const server = createApiServer({ store });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const pending = fetch(`http://127.0.0.1:${server.address().port}/stats`).catch((e) => e);
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.deepEqual(await shutdownApiServer(server, { timeoutMs: 100 }), { forced: true });
  assert.ok((await pending) instanceof Error);
  await store.close();
});

// ---------------------------------------------------------------------------
// CSV export (#41)
// ---------------------------------------------------------------------------

/** Minimal RFC 4180 parser: quoted fields, doubled quotes, CRLF or LF rows. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

const asObjects = (rows) => rows.slice(1).map((r) => Object.fromEntries(rows[0].map((h, i) => [h, r[i]])));

const I128_MAX = '170141183460469231731687303715884105727';
const I128_MIN = '-170141183460469231731687303715884105728';

/** A decoded event with the given topics/value, valid XDR included so the store can index it. */
function syntheticEvent(n, { topics, value, contractId = SAC } = {}) {
  const scv = (d) => nativeToScVal(d.native, { type: d.type }).toXDR('base64');
  const decoded = (d) => ({ type: d.type, value: d.value });
  return {
    id: `${String(n).padStart(19, '0')}-0000000000`,
    contractId,
    type: 'contract',
    ledger: 1000 + n,
    ledgerClosedAt: '2026-01-01T00:00:00Z',
    txHash: 'ab'.repeat(32),
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    topics: topics.map(decoded),
    topicsXdr: topics.map(scv),
    value: decoded(value),
    valueXdr: scv(value),
    indexedAt: '2026-01-01T00:00:01Z',
  };
}

const sym = (v) => ({ type: 'symbol', native: v, value: v });
const i128 = (v) => ({ type: 'i128', native: BigInt(v), value: v });

describe('CSV export', () => {
  test('?format=csv streams one row per event, in the same order as the JSON list', async () => {
    await withServer(async ({ base, get }) => {
      const json = await get('/events?limit=1000');
      const res = await fetch(`${base}/events?format=csv`);

      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /^text\/csv/);
      assert.match(res.headers.get('content-disposition'), /attachment; filename="events\.csv"/);
      assert.equal(res.headers.get('content-length'), null, 'a streamed body has no Content-Length');

      const rows = asObjects(parseCsv(await res.text()));
      assert.deepEqual(rows.map((r) => r.id), json.body.events.map((e) => e.id));
    });
  });

  test('the header names the documented columns and one column per topic position', async () => {
    await withServer(async ({ base }) => {
      const [header] = parseCsv(await (await fetch(`${base}/events?format=csv`)).text());
      assert.deepEqual(header.slice(0, 9), [
        'id', 'contractId', 'type', 'ledger', 'ledgerClosedAt', 'txHash',
        'transactionIndex', 'operationIndex', 'inSuccessfulContractCall',
      ]);
      assert.deepEqual(header.slice(9, 13), ['topic0', 'topic1', 'topic2', 'topic3']);
      assert.deepEqual(header.slice(-3), ['valueType', 'value', 'decodeError']);
    });
  });

  test('Accept: text/csv selects CSV; */* and a browser Accept stay JSON; ?format wins over Accept', async () => {
    await withServer(async ({ base }) => {
      const ct = async (path, accept) =>
        (await fetch(base + path, { headers: accept ? { Accept: accept } : {} })).headers.get('content-type');

      assert.match(await ct('/events', 'text/csv'), /^text\/csv/);
      assert.match(await ct('/events', 'text/csv, application/json;q=0.5'), /^text\/csv/);
      assert.match(await ct('/events', 'application/json;q=0.5, text/csv'), /^text\/csv/);
      assert.match(await ct('/events', '*/*'), /^application\/json/);
      assert.match(await ct('/events'), /^application\/json/);
      assert.match(
        await ct('/events', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'),
        /^application\/json/,
      );
      assert.match(await ct('/events', 'text/csv;q=0.1, application/json'), /^application\/json/);
      assert.match(await ct('/events?format=json', 'text/csv'), /^application\/json/);
      assert.match(await ct('/events?format=csv', 'application/json'), /^text\/csv/);
    });
  });

  test('an unknown ?format is a 400 JSON error, not a silent fallback', async () => {
    await withServer(async ({ get }) => {
      const { res, body } = await get('/events?format=xml');
      assert.equal(res.status, 400);
      assert.equal(body.error.parameter, 'format');
    });
  });

  test('works on /contracts/{id}/events too, filtered, and names the file after the contract', async () => {
    await withServer(async ({ base, get }) => {
      const json = await get(`/contracts/${SAC}/events?limit=1000`);
      const res = await fetch(`${base}/contracts/${SAC}/events?format=csv`);

      assert.match(res.headers.get('content-disposition'), new RegExp(`filename="${SAC}-events\\.csv"`));
      const rows = asObjects(parseCsv(await res.text()));
      assert.equal(rows.length, json.body.events.length);
      assert.ok(rows.every((r) => r.contractId === SAC));
    });
  });

  test('filters apply to the export, and `limit` caps the total rows', async () => {
    await withServer(async ({ base }) => {
      const limited = asObjects(parseCsv(await (await fetch(`${base}/events?format=csv&limit=3`)).text()));
      assert.equal(limited.length, 3);

      const none = parseCsv(await (await fetch(`${base}/events?format=csv&txHash=${'f'.repeat(64)}`)).text());
      assert.equal(none.length, 1, 'no matches: the header row alone');
    });
  });

  test('the ?ids= batch lookup exports as CSV too', async () => {
    await withServer(async ({ base }) => {
      const ids = fixture.events.slice(0, 2).map((e) => e.id);
      const rows = asObjects(parseCsv(await (await fetch(`${base}/events?format=csv&ids=${ids.join(',')}`)).text()));
      assert.deepEqual(rows.map((r) => r.id), ids);
    });
  });

  test('large integers survive a round trip: i128 topics and values are quoted and exact', async () => {
    await withServer(async ({ base, store }) => {
      await store.insertDecoded([
        syntheticEvent(1, { topics: [sym('transfer'), i128(I128_MAX)], value: i128(I128_MIN) }),
      ]);

      const text = await (await fetch(`${base}/events?format=csv&txHash=${'ab'.repeat(32)}`)).text();
      // The raw file carries the digits in full, never an exponent or a rounded float.
      assert.ok(text.includes(I128_MAX));
      assert.ok(text.includes(I128_MIN));

      const [row] = asObjects(parseCsv(text));
      assert.equal(row.topic0, 'transfer');
      // The cell holds JSON text: a quoted string, which a spreadsheet leaves as text.
      assert.equal(row.topic1, `"${I128_MAX}"`);
      assert.equal(JSON.parse(row.topic1), I128_MAX);
      assert.equal(JSON.parse(row.value), I128_MIN);
      assert.equal(row.valueType, 'i128');
      // And Number() would have destroyed it, which is the whole point.
      assert.notEqual(String(Number(I128_MAX)), I128_MAX);
    }, { seed: false });
  });

  test('the header is sized to the widest event, so every row has the same number of fields', async () => {
    await withServer(async ({ base, store }) => {
      await store.insertDecoded([
        syntheticEvent(1, { topics: [sym('a')], value: sym('x') }),
        syntheticEvent(2, { topics: [sym('a'), sym('b'), sym('c'), sym('d'), sym('e'), sym('f')], value: sym('y') }),
      ]);

      const rows = parseCsv(await (await fetch(`${base}/events?format=csv`)).text());
      assert.ok(rows[0].includes('topic5'), 'a six-topic event needs topic0..topic5');
      assert.ok(rows.every((r) => r.length === rows[0].length), 'no ragged rows');
    }, { seed: false });
  });

  test('a text topic that looks like a spreadsheet formula is neutralised', async () => {
    await withServer(async ({ base, store }) => {
      await store.insertDecoded([
        syntheticEvent(1, {
          topics: [{ type: 'string', native: '=HYPERLINK("http://evil")', value: '=HYPERLINK("http://evil")' }],
          value: sym('ok'),
        }),
      ]);
      const [row] = asObjects(parseCsv(await (await fetch(`${base}/events?format=csv`)).text()));
      assert.equal(row.topic0, `'=HYPERLINK("http://evil")`);
    }, { seed: false });
  });

  test('an export larger than one internal page streams completely and once', async () => {
    await withServer(async ({ base, store }) => {
      const events = Array.from({ length: 1234 }, (_, i) => syntheticEvent(i + 1, { topics: [sym('t')], value: sym('v') }));
      await store.insertDecoded(events);

      const rows = asObjects(parseCsv(await (await fetch(`${base}/events?format=csv`)).text()));
      assert.equal(rows.length, 1234);
      assert.equal(new Set(rows.map((r) => r.id)).size, 1234, 'no event repeated across pages');

      const asc = asObjects(parseCsv(await (await fetch(`${base}/events?format=csv&order=asc`)).text()));
      assert.deepEqual(asc.map((r) => r.id), [...rows.map((r) => r.id)].reverse());
    }, { seed: false });
  });

  test('HEAD returns the CSV headers without a body', async () => {
    await withServer(async ({ base }) => {
      const res = await fetch(`${base}/events?format=csv`, { method: 'HEAD' });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /^text\/csv/);
      assert.equal(await res.text(), '');
    });
  });

  test('Vary names Accept, since the same URL can answer JSON or CSV', async () => {
    await withServer(async ({ base }) => {
      for (const path of ['/events', '/events?format=csv']) {
        assert.match((await fetch(base + path)).headers.get('vary'), /\bAccept\b/);
      }
    });
  });

  test('a gzip-capable client receives a compressed CSV that decodes to the same rows', async () => {
    await withServer(async ({ base }) => {
      // fetch sends Accept-Encoding and transparently decodes, so asserting on
      // the decoded rows proves the compressed stream was well-formed.
      const res = await fetch(`${base}/events?format=csv`, { headers: { 'Accept-Encoding': 'gzip' } });
      assert.equal(res.headers.get('content-encoding'), 'gzip');
      assert.equal(asObjects(parseCsv(await res.text())).length, fixture.events.length);
    });
  });
});

// ── helpers for the access-control, caching and streaming tests below ────────

/** Like withServer, but lets a test configure the server and the seed. */
async function withConfiguredServer({ options = {}, seed = fixture.events } = {}, run) {
  const store = new SqliteEventStore({ path: ':memory:' });
  if (seed.length > 0) await store.insertEvents(seed);
  const server = createApiServer({ store, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ base, store });
  } finally {
    server.close();
    await once(server, 'close');
    await store.close();
  }
}

const eventsByIdAscending = [...fixture.events].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/** Read an SSE response until `count` messages have arrived, then hang up. */
async function readSse(res, count, timeoutMs = 5000) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const messages = [];
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  while (messages.length < count) {
    if (Date.now() > deadline) throw new Error(`timed out with ${messages.length}/${count} messages: ${buffer}`);
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const id = /^id: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (id !== undefined && data !== undefined) messages.push({ id, event: JSON.parse(data) });
    }
  }
  await reader.cancel();
  return messages;
}

// ── #48 prevCursor ───────────────────────────────────────────────────────────

test('paging forward then back over HTTP returns the original page exactly', async () => {
  await withServer(async ({ get }) => {
    const first = await get('/events?limit=8');
    assert.equal(first.body.prevCursor, null, 'the first page has no previous page');

    const second = await get(`/events?limit=8&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    assert.notEqual(second.body.prevCursor, null);

    const back = await get(
      `/events?limit=8&direction=backward&cursor=${encodeURIComponent(second.body.prevCursor)}`,
    );
    assert.deepEqual(back.body.events.map((e) => e.id), first.body.events.map((e) => e.id));
    assert.equal(back.body.prevCursor, null);
    assert.notEqual(back.body.nextCursor, null);
  });
});

test('paging both directions across a whole contract walks the same pages each way', async () => {
  await withServer(async ({ get }) => {
    const pages = [];
    let path = `/contracts/${SAC}/events?limit=5&order=asc`;
    for (let guard = 0; guard < 100; guard++) {
      const { body } = await get(path);
      pages.push(body);
      if (!body.nextCursor) break;
      path = `/contracts/${SAC}/events?limit=5&order=asc&cursor=${encodeURIComponent(body.nextCursor)}`;
    }
    assert.ok(pages.length > 2);

    let current = pages.at(-1);
    for (let i = pages.length - 1; i > 0; i--) {
      const { body } = await get(
        `/contracts/${SAC}/events?limit=5&order=asc&direction=backward&cursor=${encodeURIComponent(current.prevCursor)}`,
      );
      assert.deepEqual(body.events.map((e) => e.id), pages[i - 1].events.map((e) => e.id));
      current = body;
    }
    assert.equal(current.prevCursor, null);
  });
});

test('direction must be forward or backward', async () => {
  await withServer(async ({ get }) => {
    const { res, body } = await get('/events?direction=sideways');
    assert.equal(res.status, 400);
    assert.equal(body.error.parameter, 'direction');
  });
});

// ── #47 ETag and conditional requests ────────────────────────────────────────

test('list responses carry an ETag, and an unchanged poll gets 304 with no body', async () => {
  await withConfiguredServer({}, async ({ base }) => {
    const first = await fetch(`${base}/events?limit=10`);
    const etag = first.headers.get('etag');
    assert.match(etag, /^W\/"/);
    assert.equal(first.headers.get('cache-control'), 'no-cache');
    await first.text();

    const again = await fetch(`${base}/events?limit=10`, { headers: { 'If-None-Match': etag } });
    assert.equal(again.status, 304);
    assert.equal(again.headers.get('etag'), etag);
    assert.equal(await again.text(), '');
    assert.equal(again.headers.get('content-length'), null);
  });
});

test('If-None-Match honours lists, strong forms and *', async () => {
  await withConfiguredServer({}, async ({ base }) => {
    const etag = (await fetch(`${base}/events`)).headers.get('etag');
    const strong = etag.replace(/^W\//, '');
    for (const header of [`"other", ${etag}`, strong, '*']) {
      const res = await fetch(`${base}/events`, { headers: { 'If-None-Match': header } });
      assert.equal(res.status, 304, header);
    }
    const stale = await fetch(`${base}/events`, { headers: { 'If-None-Match': 'W/"stale"' } });
    assert.equal(stale.status, 200);
  });
});

test('the ETag depends on the filter, and on the order of positional topic parameters', async () => {
  await withConfiguredServer({}, async ({ base }) => {
    const tag = async (path) => (await fetch(`${base}${path}`)).headers.get('etag');
    const all = await tag('/events?limit=10');
    assert.notEqual(all, await tag('/events?limit=11'));
    assert.notEqual(all, await tag(`/contracts/${SAC}/events?limit=10`));
    assert.equal(await tag('/events?limit=10&order=asc'), await tag('/events?order=asc&limit=10'));
    assert.notEqual(await tag('/events?topic=a&topic=b'), await tag('/events?topic=b&topic=a'));
  });
});

test('a newly indexed event changes the ETag, so the next poll is a full 200', async () => {
  const seed = eventsByIdAscending.slice(0, -1);
  await withConfiguredServer({ seed }, async ({ base, store }) => {
    const etag = (await fetch(`${base}/events`)).headers.get('etag');
    assert.equal((await fetch(`${base}/events`, { headers: { 'If-None-Match': etag } })).status, 304);

    await store.insertEvents([eventsByIdAscending.at(-1)]);

    const after = await fetch(`${base}/events`, { headers: { 'If-None-Match': etag } });
    assert.equal(after.status, 200);
    assert.notEqual(after.headers.get('etag'), etag);
    assert.equal((await after.json()).events[0].id, eventsByIdAscending.at(-1).id);
  });
});

test('HEAD and error responses behave: HEAD gets the ETag, a 400 does not', async () => {
  await withConfiguredServer({}, async ({ base }) => {
    const head = await fetch(`${base}/events`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.match(head.headers.get('etag'), /^W\//);

    const bad = await fetch(`${base}/events?limit=0`);
    assert.equal(bad.status, 400);
    assert.equal(bad.headers.get('etag'), null);
    assert.equal(bad.headers.get('cache-control'), 'no-store');
  });
});

test('non-list routes are unchanged: no ETag, still no-store', async () => {
  await withConfiguredServer({}, async ({ base }) => {
    const res = await fetch(`${base}/stats`);
    assert.equal(res.headers.get('etag'), null);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });
});

// ── #43 rate limiting and API keys ───────────────────────────────────────────

test('an unconfigured instance has no limit and needs no key', async () => {
  await withConfiguredServer({}, async ({ base }) => {
    for (let i = 0; i < 60; i++) {
      const res = await fetch(`${base}/stats`);
      assert.equal(res.status, 200);
      await res.text();
    }
    assert.equal((await fetch(`${base}/events`, { method: 'OPTIONS' })).status, 204);
  });
});

test('the rate limiter answers 429 with Retry-After once the bucket is empty', async () => {
  await withConfiguredServer({ options: { rateLimit: { requestsPerSecond: 0.5, burst: 3 } } }, async ({ base }) => {
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${base}/stats`);
      assert.equal(res.status, 200, `request ${i + 1} is within the burst`);
      await res.text();
    }
    const limited = await fetch(`${base}/stats`);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
    const body = await limited.json();
    assert.equal(body.error.code, 'rate_limited');
  });
});

test('a load of concurrent requests is held to the burst', async () => {
  await withConfiguredServer({ options: { rateLimit: { requestsPerSecond: 0.1, burst: 10 } } }, async ({ base }) => {
    const statuses = await Promise.all(
      Array.from({ length: 50 }, async () => {
        const res = await fetch(`${base}/stats`);
        await res.text();
        return res.status;
      }),
    );
    assert.equal(statuses.filter((s) => s === 200).length, 10);
    assert.equal(statuses.filter((s) => s === 429).length, 40);
  });
});

test('health, the spec and the docs are never rate limited', async () => {
  await withConfiguredServer({ options: { rateLimit: { requestsPerSecond: 0.1, burst: 1 } } }, async ({ base }) => {
    await (await fetch(`${base}/stats`)).text(); // spends the only token
    for (const path of ['/health', '/openapi.json', '/docs']) {
      for (let i = 0; i < 5; i++) {
        const res = await fetch(`${base}${path}`);
        assert.equal(res.status, 200, path);
        await res.text();
      }
    }
    assert.equal((await fetch(`${base}/stats`)).status, 429);
  });
});

test('X-Forwarded-For only keys the limiter when trustProxy is set', async () => {
  const hit = (base, ip) => fetch(`${base}/stats`, { headers: { 'X-Forwarded-For': ip } }).then(async (r) => (await r.text(), r.status));

  await withConfiguredServer({ options: { rateLimit: { requestsPerSecond: 0.1, burst: 1 } } }, async ({ base }) => {
    assert.equal(await hit(base, '1.1.1.1'), 200);
    assert.equal(await hit(base, '2.2.2.2'), 429, 'a spoofed header must not mint a fresh bucket');
  });
  await withConfiguredServer(
    { options: { rateLimit: { requestsPerSecond: 0.1, burst: 1 }, trustProxy: true } },
    async ({ base }) => {
      assert.equal(await hit(base, '1.1.1.1'), 200);
      assert.equal(await hit(base, '2.2.2.2'), 200);
      assert.equal(await hit(base, '1.1.1.1'), 429);
    },
  );
});

test('API keys gate every data route when configured', async () => {
  await withConfiguredServer({ options: { apiKeys: ['secret-one', 'secret-two'] } }, async ({ base }) => {
    const missing = await fetch(`${base}/events`);
    assert.equal(missing.status, 401);
    assert.match(missing.headers.get('www-authenticate'), /^Bearer/);
    assert.equal((await missing.json()).error.code, 'unauthorized');

    assert.equal((await fetch(`${base}/events`, { headers: { 'X-API-Key': 'wrong' } })).status, 401);
    assert.equal((await fetch(`${base}/events`, { headers: { 'X-API-Key': 'secret-two' } })).status, 200);
    assert.equal((await fetch(`${base}/stats`, { headers: { Authorization: 'Bearer secret-one' } })).status, 200);
    assert.equal((await fetch(`${base}/stats`, { headers: { Authorization: 'Basic secret-one' } })).status, 401);
    assert.equal((await fetch(`${base}/no-such-route`)).status, 401, 'an unknown route does not reveal itself');
  });
});

test('keys do not gate health, the spec, the docs or CORS preflight', async () => {
  await withConfiguredServer({ options: { apiKeys: ['secret'] } }, async ({ base }) => {
    for (const path of ['/health', '/openapi.json', '/docs']) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 200, path);
      await res.text();
    }
    const preflight = await fetch(`${base}/events`, { method: 'OPTIONS' });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get('access-control-allow-headers'), /X-API-Key/);
  });
});

test('the limiter runs before the key check, so key guessing is throttled', async () => {
  await withConfiguredServer(
    { options: { apiKeys: ['secret'], rateLimit: { requestsPerSecond: 0.1, burst: 2 } } },
    async ({ base }) => {
      assert.equal((await fetch(`${base}/events`, { headers: { 'X-API-Key': 'a' } })).status, 401);
      assert.equal((await fetch(`${base}/events`, { headers: { 'X-API-Key': 'b' } })).status, 401);
      assert.equal((await fetch(`${base}/events`, { headers: { 'X-API-Key': 'secret' } })).status, 429);
    },
  );
});

test('the served OpenAPI document declares the security scheme and the 401/429 responses', async () => {
  await withServer(async ({ get }) => {
    const { body } = await get('/openapi.json');
    assert.ok(body.components.securitySchemes.ApiKeyAuth, 'ApiKeyAuth scheme');
    assert.ok(body.components.securitySchemes.BearerAuth, 'BearerAuth scheme');
    assert.ok(body.components.responses.Unauthorized);
    assert.ok(body.components.responses.TooManyRequests);
    assert.ok(Array.isArray(body.security), 'a document-level security requirement');
    assert.deepEqual(body.paths['/health'].get.security, [], '/health is public');
  });
});

// ── #42 server-sent events ───────────────────────────────────────────────────

test('GET /events/stream emits each newly indexed event with its id', async () => {
  const seed = eventsByIdAscending.slice(0, -3);
  const incoming = eventsByIdAscending.slice(-3);
  await withConfiguredServer({ seed, options: { stream: { pollIntervalMs: 20 } } }, async ({ base, store }) => {
    const res = await fetch(`${base}/events/stream`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/event-stream/);
    assert.equal(res.headers.get('cache-control'), 'no-cache');

    await store.insertEvents(incoming);

    const messages = await readSse(res, incoming.length);
    assert.deepEqual(messages.map((m) => m.id), incoming.map((e) => e.id));
    assert.deepEqual(messages.map((m) => m.event.id), incoming.map((e) => e.id));
  });
});

test('the stream carries only new events: nothing already indexed is replayed', async () => {
  const seed = eventsByIdAscending.slice(0, -1);
  const incoming = eventsByIdAscending.at(-1);
  await withConfiguredServer({ seed, options: { stream: { pollIntervalMs: 20 } } }, async ({ base, store }) => {
    const res = await fetch(`${base}/events/stream`);
    await store.insertEvents([incoming]);
    const [only] = await readSse(res, 1);
    assert.equal(only.id, incoming.id);
  });
});

test('Last-Event-ID resumes from just after that event, in order', async () => {
  await withConfiguredServer({ options: { stream: { pollIntervalMs: 20 } } }, async ({ base }) => {
    const resumeAfter = eventsByIdAscending.at(-4);
    const res = await fetch(`${base}/events/stream`, { headers: { 'Last-Event-ID': resumeAfter.id } });
    const messages = await readSse(res, 3);
    assert.deepEqual(messages.map((m) => m.id), eventsByIdAscending.slice(-3).map((e) => e.id));
  });
});

test('?lastEventId= resumes the same way, for clients that cannot set headers', async () => {
  await withConfiguredServer({ options: { stream: { pollIntervalMs: 20 } } }, async ({ base }) => {
    const resumeAfter = eventsByIdAscending.at(-3);
    const res = await fetch(`${base}/events/stream?lastEventId=${encodeURIComponent(resumeAfter.id)}`);
    const messages = await readSse(res, 2);
    assert.deepEqual(messages.map((m) => m.id), eventsByIdAscending.slice(-2).map((e) => e.id));
  });
});

test('the stream applies the same filters as /events', async () => {
  await withConfiguredServer({ options: { stream: { pollIntervalMs: 20 } } }, async ({ base }) => {
    const sample = eventsByIdAscending.at(-1);
    const res = await fetch(
      `${base}/events/stream?contractId=${sample.contractId}&lastEventId=${encodeURIComponent(eventsByIdAscending[0].id)}`,
    );
    const expected = eventsByIdAscending.slice(1).filter((e) => e.contractId === sample.contractId);
    const messages = await readSse(res, expected.length);
    assert.ok(messages.every((m) => m.event.contractId === sample.contractId));
    assert.deepEqual(messages.map((m) => m.id), expected.map((e) => e.id));
  });
});

test('an invalid stream filter is a 400 before any stream opens', async () => {
  await withServer(async ({ get }) => {
    const { res, body } = await get('/events/stream?contractId=nope');
    assert.equal(res.status, 400);
    assert.equal(body.error.parameter, 'contractId');
    assert.equal((await get('/events/stream?limit=0')).res.status, 400);
  });
});

test('/events/stream is not mistaken for an event id', async () => {
  await withConfiguredServer({}, async ({ base }) => {
    const res = await fetch(`${base}/events/stream`, { method: 'HEAD' });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/event-stream/);
  });
});

test('streams are subject to API keys', async () => {
  await withConfiguredServer({ options: { apiKeys: ['secret'] } }, async ({ base }) => {
    assert.equal((await fetch(`${base}/events/stream`)).status, 401);
    const ok = await fetch(`${base}/events/stream`, { headers: { 'X-API-Key': 'secret' } });
    assert.equal(ok.status, 200);
    await ok.body.cancel();
  });
});

test('more streams than maxStreams are refused with 503', async () => {
  await withConfiguredServer({ options: { stream: { maxStreams: 2 } } }, async ({ base }) => {
    const open = [await fetch(`${base}/events/stream`), await fetch(`${base}/events/stream`)];
    const refused = await fetch(`${base}/events/stream`);
    assert.equal(refused.status, 503);
    assert.ok(refused.headers.get('retry-after'));
    await refused.text();
    for (const res of open) await res.body.cancel();
  });
});

test('100 concurrent streams all receive a new event', async () => {
  const seed = eventsByIdAscending.slice(0, -1);
  const incoming = eventsByIdAscending.at(-1);
  await withConfiguredServer({ seed, options: { stream: { pollIntervalMs: 20 } } }, async ({ base, store }) => {
    const responses = await Promise.all(Array.from({ length: 100 }, () => fetch(`${base}/events/stream`)));
    assert.ok(responses.every((r) => r.status === 200));

    const before = process.memoryUsage().heapUsed;
    await store.insertEvents([incoming]);
    const received = await Promise.all(responses.map((r) => readSse(r, 1)));
    assert.ok(received.every(([m]) => m.id === incoming.id));

    // One shared poller, one id per stream: nothing is buffered per connection.
    const grewBy = process.memoryUsage().heapUsed - before;
    assert.ok(grewBy < 100 * 1024 * 1024, `heap grew by ${grewBy} bytes`);
  });
});

test('closing the server ends open streams instead of hanging', async () => {
  const store = new SqliteEventStore({ path: ':memory:' });
  await store.insertEvents(fixture.events);
  const server = createApiServer({ store });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const res = await fetch(`http://127.0.0.1:${server.address().port}/events/stream`);
  assert.equal(res.status, 200);

  server.close();
  await Promise.race([
    once(server, 'close'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('server.close() hung on an open stream')), 3000)),
  ]);
  await res.body.cancel().catch(() => {});
  await store.close();
});

// ── token bucket, with a fake clock ──────────────────────────────────────────

test('TokenBucketLimiter refills over time and forgets idle clients', async () => {
  const { TokenBucketLimiter } = await import('../dist/index.js');
  let now = 0;
  const limiter = new TokenBucketLimiter({ requestsPerSecond: 2, burst: 2 }, () => now);

  assert.deepEqual(limiter.take('a'), { allowed: true });
  assert.deepEqual(limiter.take('a'), { allowed: true });
  assert.deepEqual(limiter.take('a'), { allowed: false, retryAfterSeconds: 1 });

  now += 500; // one token back at 2/s
  assert.deepEqual(limiter.take('a'), { allowed: true });
  assert.equal(limiter.take('a').allowed, false);
  assert.equal(limiter.take('b').allowed, true, 'clients have separate buckets');

  // Enough distinct clients to trigger a sweep, then let them all refill.
  for (let i = 0; i < 2000; i++) limiter.take(`ip-${i}`);
  now += 10_000;
  for (let i = 0; i < 1024; i++) limiter.take('c');
  assert.ok(limiter.size < 10, `idle buckets must be dropped, still tracking ${limiter.size}`);
});

test('TokenBucketLimiter rejects a nonsensical rate', async () => {
  const { TokenBucketLimiter } = await import('../dist/index.js');
  assert.throws(() => new TokenBucketLimiter({ requestsPerSecond: 0 }), /positive/);
  assert.throws(() => new TokenBucketLimiter({ requestsPerSecond: 1, burst: 0 }), /at least 1/);
});

test('shutdownApiServer ends open event streams instead of waiting out the timeout', async () => {
  const store = new SqliteEventStore({ path: ':memory:' });
  await store.insertEvents(fixture.events);
  const server = createApiServer({ store });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const res = await fetch(`http://127.0.0.1:${server.address().port}/events/stream`);
  assert.equal(res.status, 200);
  const reader = res.body.getReader();

  const started = Date.now();
  const result = await shutdownApiServer(server, { timeoutMs: 5000 });
  assert.deepEqual(result, { forced: false });
  assert.ok(Date.now() - started < 2000, `shutdown took ${Date.now() - started}ms`);
  await reader.cancel().catch(() => {});
  await store.close();
});

test('a JSON ETag never validates a CSV request for the same URL', async () => {
  await withServer(async ({ base }) => {
    const json = await fetch(`${base}/events`);
    const etag = json.headers.get('etag');
    assert.ok(etag, 'the JSON list carries an ETag');
    await json.arrayBuffer();

    const sameJson = await fetch(`${base}/events`, { headers: { 'If-None-Match': etag } });
    assert.equal(sameJson.status, 304);

    // Same URL, other representation: must not be answered with 304.
    const csv = await fetch(`${base}/events`, { headers: { Accept: 'text/csv', 'If-None-Match': etag } });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /^text\/csv/);
    await csv.text();
  });
});
