import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { SqliteEventStore } from '@soroban-lens/store';
import { createApiServer } from '../dist/index.js';

const fixture = JSON.parse(readFileSync(new URL('../../../fixtures/testnet-events.json', import.meta.url), 'utf8'));
const fixtureSpecs = JSON.parse(readFileSync(new URL('../../../fixtures/testnet-specs.json', import.meta.url), 'utf8')).specs;
const SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

/** A store wrapper that counts reads, to prove rejected queries never reach it. */
function spyOn(store) {
  const calls = { count: 0 };
  const proxy = new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      if (['queryEvents', 'listContracts', 'listTopics', 'getEvent'].includes(prop)) {
        return (...args) => {
          calls.count += 1;
          return value.apply(target, args);
        };
      }
      return value.bind(target);
    },
  });
  return { proxy, calls };
}

async function withGraphQL(run, graphql = { enabled: true }, { typedFieldIndex = false } = {}) {
  const real = new SqliteEventStore({ path: ':memory:', typedFieldIndex });
  await real.insertEvents(fixture.events);
  const { proxy, calls } = spyOn(real);
  const server = createApiServer({ store: proxy, graphql });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (query, variables, extra = {}) => {
    const res = await fetch(`${base}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables, ...extra }),
    });
    return { res, body: await res.json() };
  };
  try {
    await run({ base, post, calls, store: real });
  } finally {
    server.close();
    await once(server, 'close');
    await real.close();
  }
}

test('the schema covers events, contracts and topics, and matches REST', async () => {
  await withGraphQL(async ({ base, post }) => {
    const rest = await (await fetch(`${base}/contracts/${SAC}/events?limit=3`)).json();
    const { res, body } = await post(
      `query($id: String!) { events(contractId: $id, limit: 3) { total nextCursor events { id ledger txHash } } }`,
      { id: SAC },
    );
    assert.equal(res.status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.events.events.map((e) => e.id), rest.events.map((e) => e.id));
    assert.equal(body.data.events.total, rest.total);
    assert.equal(body.data.events.nextCursor, rest.nextCursor);

    const topics = await post(`{ topics(contractId: "${SAC}", limit: 5) { topic count } }`);
    const restTopics = await (await fetch(`${base}/contracts/${SAC}/topics?limit=5`)).json();
    assert.deepEqual(topics.body.data.topics, restTopics.topics);

    const contracts = await post(`{ contracts(limit: 100) { contractId eventCount } }`);
    const restContracts = await (await fetch(`${base}/contracts?limit=100`)).json();
    assert.deepEqual(contracts.body.data.contracts.map((c) => c.contractId), restContracts.contracts.map((c) => c.contractId));
  });
});

test('events can be joined to their contract summary', async () => {
  await withGraphQL(async ({ post }) => {
    const { body } = await post(`{ events(limit: 2) { events { id contract { contractId eventCount } } } }`);
    for (const event of body.data.events.events) {
      assert.ok(event.contract.contractId);
      assert.ok(event.contract.eventCount >= 1);
    }
    const nested = await post(
      `{ contract(id: "${SAC}") { contractId events(limit: 2) { events { id contractId } } topics(limit: 3) { topic } } }`,
    );
    assert.equal(nested.body.data.contract.contractId, SAC);
    assert.ok(nested.body.data.contract.events.events.every((e) => e.contractId === SAC));
    assert.ok(nested.body.data.contract.topics.length <= 3);
  });
});

test('typed field filters are available through GraphQL event queries', async () => {
  await withGraphQL(async ({ post, store }) => {
    const spec = fixtureSpecs.find((record) => record.contractId === SAC);
    await store.saveContractSpec(spec);
    const expected = await store.queryEvents({
      contractId: SAC,
      typedField: 'amount',
      typedGte: '1000000',
      limit: 2,
    });
    const { body } = await post(
      `query($field: String!, $minimum: String!) {
        events(contractId: "${SAC}", typedField: $field, typedGte: $minimum, limit: 2) {
          events { id }
        }
      }`,
      { field: 'amount', minimum: '1000000' },
    );
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.events.events.map((event) => event.id), expected.events.map((event) => event.id));
  }, { enabled: true }, { typedFieldIndex: true });
});

test('aliases, fragments, variables, @skip/@include and __typename work', async () => {
  await withGraphQL(async ({ post }) => {
    const { body } = await post(
      `query Q($skip: Boolean = false) {
         first: events(limit: 1) { ...Page }
         second: events(limit: 2, order: asc) { ...Page }
       }
       fragment Page on EventPage {
         __typename
         total @skip(if: $skip)
         events { id ... on Event { ledger } }
       }`,
      { skip: true },
    );
    assert.equal(body.errors, undefined);
    assert.equal(body.data.first.__typename, 'EventPage');
    assert.equal(body.data.first.events.length, 1);
    assert.equal(body.data.second.events.length, 2);
    assert.ok(!('total' in body.data.first));
  });
});

test('GET /graphql accepts the query in the URL', async () => {
  await withGraphQL(async ({ base }) => {
    const url = `${base}/graphql?query=${encodeURIComponent('{ events(limit: 1) { total } }')}`;
    const res = await fetch(url);
    assert.equal(res.status, 200);
    assert.equal(typeof (await res.json()).data.events.total, 'number');
  });
});

// ── limits ───────────────────────────────────────────────────────────────────

test('a too-deep query is rejected before the store is read', async () => {
  await withGraphQL(async ({ post, calls }) => {
    const deep = '{ contracts(limit: 1) { events(limit: 1) { events { contract { events(limit: 1) { events { contract { events(limit: 1) { events { id } } } } } } } } } }';
    const { res, body } = await post(deep);
    assert.equal(res.status, 400);
    assert.equal(body.errors[0].extensions.code, 'QUERY_TOO_DEEP');
    assert.equal(calls.count, 0);
  });
});

test('query-complexity limit: nested pagination is rejected, a plain page is not', async () => {
  await withGraphQL(async ({ post, calls }) => {
    const heavy = await post('{ contracts(limit: 100) { events(limit: 100) { events { id } } } }');
    assert.equal(heavy.res.status, 400);
    assert.equal(heavy.body.errors[0].extensions.code, 'QUERY_TOO_COMPLEX');
    assert.equal(calls.count, 0, 'a rejected query must not touch the store');

    const plain = await post('{ events(limit: 50) { total events { id topics { type value } contract { contractId } } } }');
    assert.equal(plain.res.status, 200);
    assert.equal(plain.body.errors, undefined);
  });
});

test('the limits are configurable and actually hold', async () => {
  await withGraphQL(
    async ({ post }) => {
      const ok = await post('{ events(limit: 1) { events { id } } }');
      assert.equal(ok.res.status, 200);

      const tooDeep = await post('{ events(limit: 1) { events { contract { contractId } } } }');
      assert.equal(tooDeep.body.errors[0].extensions.code, 'QUERY_TOO_DEEP');

      const tooCostly = await post('{ events(limit: 1000) { events { id ledger } } }');
      assert.equal(tooCostly.body.errors[0].extensions.code, 'QUERY_TOO_COMPLEX');
    },
    { enabled: true, maxDepth: 3, maxComplexity: 100 },
  );
});

test('oversized documents are rejected', async () => {
  await withGraphQL(
    async ({ post }) => {
      const { res, body } = await post(`{ events { total } } # ${'x'.repeat(200)}`);
      assert.equal(res.status, 400);
      assert.equal(body.errors[0].extensions.code, 'QUERY_TOO_LARGE');
    },
    { enabled: true, maxQueryLength: 100 },
  );
});

// ── rejections ───────────────────────────────────────────────────────────────

test('mutations, unknown fields, unknown arguments and introspection are validation errors', async () => {
  await withGraphQL(async ({ post }) => {
    for (const query of [
      'mutation { events { total } }',
      '{ nope }',
      '{ events { nope } }',
      '{ events(bogus: 1) { total } }',
      '{ __schema { types { name } } }',
      '{ events { total { x } } }',
      '{ events }',
      '{ ...Missing }',
    ]) {
      const { res, body } = await post(query);
      assert.equal(res.status, 400, query);
      assert.equal(body.errors[0].extensions.code, 'GRAPHQL_VALIDATION_FAILED', query);
    }
  });
});

test('syntax errors are 400 parse failures', async () => {
  await withGraphQL(async ({ post }) => {
    for (const query of ['{ events ', '{ events(limit: ) { total } }', '', '{ events { total } } }']) {
      const { res, body } = await post(query);
      assert.equal(res.status, 400, query);
      assert.equal(body.errors[0].extensions.code, 'GRAPHQL_PARSE_FAILED', query);
    }
  });
});

test('bad argument values are BAD_USER_INPUT, and REST validation applies', async () => {
  await withGraphQL(async ({ post }) => {
    const wrongType = await post('{ events(limit: "ten") { total } }');
    assert.equal(wrongType.res.status, 400);
    assert.equal(wrongType.body.errors[0].extensions.code, 'BAD_USER_INPUT');

    const badId = await post('{ events(contractId: "nope") { total } }');
    assert.equal(badId.body.data, null);
    assert.equal(badId.body.errors[0].extensions.code, 'BAD_USER_INPUT');
    assert.match(badId.body.errors[0].message, /not a contract id/);

    const overLimit = await post('{ events(limit: 5000) { total } }');
    assert.equal(overLimit.body.data, null);
    assert.equal(overLimit.body.errors[0].extensions.code, 'BAD_USER_INPUT');
    assert.match(overLimit.body.errors[0].message, /"limit" must be between 1 and/);
  });
});

test('a missing required variable is rejected', async () => {
  await withGraphQL(async ({ post }) => {
    const { res, body } = await post('query($id: String!) { event(id: $id) { id } }', {});
    assert.equal(res.status, 400);
    assert.equal(body.errors[0].extensions.code, 'BAD_USER_INPUT');
  });
});

test('the REST routes are untouched when GraphQL is enabled', async () => {
  await withGraphQL(async ({ base }) => {
    const res = await fetch(`${base}/events?limit=1`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.events.length, 1);
    assert.ok(!('data' in body));
  });
});
