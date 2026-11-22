import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { SqliteEventStore } from '@soroban-lens/store';
import { createApiServer } from '../dist/index.js';
import { assertConforms, validate } from './support/openapi-validate.js';

const spec = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'));
const fixture = JSON.parse(readFileSync(new URL('../../../fixtures/testnet-events.json', import.meta.url), 'utf8'));
const CONTRACT = fixture.events[0].contractId;
const EVENT_ID = fixture.events[0].id;
const UNKNOWN_CONTRACT = 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR';

// Routes the spec documents that are exercised elsewhere or are not JSON bodies:
// the SSE stream's success case, and the opt-in POST/DELETE/GraphQL surfaces.
const NOT_COVERED_HERE = new Set(['/openapi.json', '/graphql', '/webhooks', '/webhooks/{webhookId}', '/webhooks/{webhookId}/dead-letters']);

// [template, concrete path, expected status]
const CASES = [
  ['/health', '/health', 200],
  ['/stats', '/stats', 200],
  ['/status', '/status', 200],
  ['/contracts', '/contracts', 200],
  ['/contracts/{contractId}/events', `/contracts/${CONTRACT}/events`, 200],
  ['/contracts/{contractId}/events', '/contracts/nope/events', 400],
  ['/contracts/{contractId}/activity', `/contracts/${CONTRACT}/activity`, 200],
  ['/contracts/{contractId}/stats', `/contracts/${CONTRACT}/stats`, 200],
  ['/contracts/{contractId}/stats', `/contracts/${UNKNOWN_CONTRACT}/stats`, 404],
  ['/contracts/{contractId}/spec', `/contracts/${UNKNOWN_CONTRACT}/spec`, 404],
  ['/contracts/{contractId}/topics', `/contracts/${CONTRACT}/topics`, 200],
  ['/events', '/events', 200],
  ['/events', '/events?limit=abc', 400],
  ['/events/{eventId}', `/events/${EVENT_ID}`, 200],
  ['/events/{eventId}', '/events/does-not-exist', 404],
  ['/events/stream', '/events/stream?limit=abc', 400],
  ['/transactions/{txHash}', `/transactions/${fixture.events[0].txHash}`, 200],
  ['/transactions/{txHash}', `/transactions/${'0'.repeat(64)}`, 404],
  ['/transactions/{txHash}', '/transactions/nope', 400],
  ['/addresses/{address}', `/addresses/G${'A'.repeat(55)}`, 200],
  ['/addresses/{address}', '/addresses/bogus', 400],
];

async function withServer(run) {
  const store = new SqliteEventStore({ path: ':memory:' });
  await store.insertEvents(fixture.events);
  await store.saveStreamState({
    key: 'testnet-abc',
    cursor: 'c1',
    ledger: 100,
    updatedAt: new Date().toISOString(),
    latestLedger: 105,
    latestLedgerSeenAt: new Date().toISOString(),
  });
  const server = createApiServer({ store });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
    await once(server, 'close');
    await store.close();
  }
}

test('every documented route has a validated response, and each matches its schema', async () => {
  const covered = new Set();
  await withServer(async (base) => {
    for (const [template, path, expected] of CASES) {
      for (const accept of ['application/json', 'application/problem+json']) {
        const res = await fetch(base + path, { headers: { accept } });
        assert.equal(res.status, expected, `${path} (${accept})`);
        const contentType = res.headers.get('content-type').split(';')[0];
        // Problem details are only negotiated on errors; successes stay JSON.
        if (expected < 400 && accept !== 'application/json') continue;
        if (path === '/events/stream?limit=abc' && expected === 200) continue;
        assertConforms(spec, { path: template, status: expected, contentType, body: await res.json() });
        covered.add(template);
      }
    }
  });
  const documented = Object.keys(spec.paths).filter((p) => !NOT_COVERED_HERE.has(p));
  assert.deepEqual(documented.filter((p) => !covered.has(p)), [], 'routes without a validated response');
});

test('problem details are served for application/problem+json, the default body is unchanged', async () => {
  await withServer(async (base) => {
    for (const [path, status, parameter] of [['/events?limit=abc', 400, 'limit'], ['/events/does-not-exist', 404, undefined]]) {
      const plain = await fetch(base + path);
      assert.equal(plain.status, status);
      assert.match(plain.headers.get('content-type'), /^application\/json/);
      const legacy = await plain.json();
      assert.deepEqual(Object.keys(legacy), ['error']);
      assert.equal(legacy.error.parameter, parameter);

      const res = await fetch(base + path, { headers: { accept: 'application/problem+json' } });
      assert.equal(res.status, status);
      assert.match(res.headers.get('content-type'), /^application\/problem\+json/);
      const problem = await res.json();
      assert.equal(problem.status, status);
      assert.equal(problem.title, status === 400 ? 'Bad Request' : 'Not Found');
      assert.equal(problem.detail, legacy.error.message);
      assert.equal(problem.code, legacy.error.code);
      assert.equal(problem.parameter, parameter);
      assert.ok(problem.requestId);
      assert.match(problem.type, /^urn:soroban-lens:problem:/);
      assert.equal(problem.error, undefined);
    }
    // A wildcard does not opt in.
    const wildcard = await fetch(`${base}/events/nope`, { headers: { accept: '*/*' } });
    assert.match(wildcard.headers.get('content-type'), /^application\/json/);
  });
});

test('removing a field from a schema, or adding one the schema forbids, fails validation', async () => {
  await withServer(async (base) => {
    const body = await (await fetch(`${base}/status`)).json();
    assertConforms(spec, { path: '/status', status: 200, body });

    const trimmed = structuredClone(spec);
    delete trimmed.components.schemas.StreamState.properties.lagLedgers;
    trimmed.components.schemas.StreamState.additionalProperties = false;
    assert.throws(() => assertConforms(trimmed, { path: '/status', status: 200, body }), /lagLedgers/);

    const problem = await (await fetch(`${base}/events/nope`, { headers: { accept: 'application/problem+json' } })).json();
    assert.deepEqual(validate(spec, spec.components.schemas.Problem, { ...problem, surprise: 1 }), [
      '$: property "surprise" is not in the schema',
    ]);
  });
});

test('/status reports lag from the saved sample, and a stale sample ages', async () => {
  await withServer(async (base) => {
    const [stream] = (await (await fetch(`${base}/status`)).json()).streams;
    assert.equal(stream.lagLedgers, 5);
    assert.ok(stream.sampleAgeSeconds >= 0 && stream.sampleAgeSeconds < 5);
  });
  const store = new SqliteEventStore({ path: ':memory:' });
  const old = new Date(Date.now() - 120_000).toISOString();
  await store.saveStreamState({ key: 'a', cursor: 'c', ledger: 10, updatedAt: old, latestLedger: 10, latestLedgerSeenAt: old });
  await store.saveStreamState({ key: 'b', cursor: 'c', ledger: 10, updatedAt: old });
  const server = createApiServer({ store });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { streams } = await (await fetch(`http://127.0.0.1:${server.address().port}/status`)).json();
    // Zero behind — but the sample is two minutes old, and says so.
    assert.equal(streams[0].lagLedgers, 0);
    assert.ok(streams[0].sampleAgeSeconds >= 119);
    assert.equal(streams[1].lagLedgers, null);
    assert.equal(streams[1].sampleAgeSeconds, null);
  } finally {
    server.close();
    await once(server, 'close');
    await store.close();
  }
});
