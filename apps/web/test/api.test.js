import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEventPath, ApiRequestError } from '../.test-build/api.js';

const SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

/** Parse a built path back into something assertable. */
function parse(path) {
  const url = new URL(path, 'http://localhost:8080');
  return { pathname: url.pathname, params: url.searchParams };
}

test('no parameters asks for every contract, with no query string', () => {
  assert.equal(buildEventPath({}), '/events');
});

test('a contract id selects the per-contract route', () => {
  const { pathname } = parse(buildEventPath({ contractId: SAC }));
  assert.equal(pathname, `/contracts/${SAC}/events`);
});

test('a contract id is encoded rather than interpolated raw', () => {
  const { pathname } = parse(buildEventPath({ contractId: 'a/b?c' }));
  assert.equal(pathname, '/contracts/a%2Fb%3Fc/events');
});

test('paging and range parameters are passed through', () => {
  const { params } = parse(
    buildEventPath({ limit: 50, cursor: '0020166263024140288-0000000000', fromLedger: 1, toLedger: 9 }),
  );
  assert.equal(params.get('limit'), '50');
  assert.equal(params.get('cursor'), '0020166263024140288-0000000000');
  assert.equal(params.get('fromLedger'), '1');
  assert.equal(params.get('toLedger'), '9');
});

test('a zero ledger bound is sent, not dropped as falsy', () => {
  const { params } = parse(buildEventPath({ fromLedger: 0, toLedger: 0 }));
  assert.equal(params.get('fromLedger'), '0');
  assert.equal(params.get('toLedger'), '0');
});

test('successfulOnly is sent only when it is on', () => {
  assert.equal(parse(buildEventPath({ successfulOnly: true })).params.get('successfulOnly'), 'true');
  // The API defaults to including failed calls; sending false would be noise.
  assert.equal(parse(buildEventPath({ successfulOnly: false })).params.has('successfulOnly'), false);
});

test('topics are appended in order, so the prefix match stays positional', () => {
  const { params } = parse(buildEventPath({ topics: ['transfer', 'GABC'] }));
  assert.deepEqual(params.getAll('topic'), ['transfer', 'GABC']);
});

test('a null topic segment becomes the wildcard the API expects', () => {
  // Position matters: null in the middle must not collapse the list, or every
  // later segment would silently shift one place left.
  const { params } = parse(buildEventPath({ topics: ['transfer', null, 'GXYZ'] }));
  assert.deepEqual(params.getAll('topic'), ['transfer', '*', 'GXYZ']);
});

test('an empty topic list adds no topic parameter', () => {
  assert.equal(parse(buildEventPath({ topics: [] })).params.has('topic'), false);
});

test('a contract id combines with filters', () => {
  const { pathname, params } = parse(
    buildEventPath({ contractId: SAC, topics: ['transfer'], limit: 10, successfulOnly: true }),
  );
  assert.equal(pathname, `/contracts/${SAC}/events`);
  assert.deepEqual(params.getAll('topic'), ['transfer']);
  assert.equal(params.get('limit'), '10');
  assert.equal(params.get('successfulOnly'), 'true');
});

test('ApiRequestError surfaces the server error over the fallback', () => {
  const error = new ApiRequestError(
    400,
    { error: { code: 'invalid_parameter', message: 'limit must be between 1 and 1000', parameter: 'limit' } },
    'Request failed with 400.',
  );
  assert.equal(error.message, 'limit must be between 1 and 1000');
  assert.equal(error.code, 'invalid_parameter');
  assert.equal(error.parameter, 'limit');
  assert.equal(error.status, 400);
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'ApiRequestError');
});

test('ApiRequestError falls back when the body is not the documented shape', () => {
  const error = new ApiRequestError(502, null, 'Request failed with 502.');
  assert.equal(error.message, 'Request failed with 502.');
  assert.equal(error.code, 'unknown');
  assert.equal(error.parameter, undefined);
  assert.equal(error.status, 502);
});
