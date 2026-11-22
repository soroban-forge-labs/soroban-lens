import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUrl, stringifyUrl, sameFilterView } from '../.test-build/route.js';

const SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const ACCOUNT = 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI';
const EVENT_ID = '0020166232959352832-0000000000';

const EMPTY_FILTERS = {
  contractId: '', topic: '', address: '', search: '', successfulOnly: false,
  live: true, fromLedger: '', toLedger: '', timeRange: '', customFromTime: '', customToTime: '',
};
const filters = (overrides = {}) => ({ ...EMPTY_FILTERS, ...overrides });

const DEFAULTS = {
  filters: EMPTY_FILTERS,
  network: '',
  expandedEventId: null,
};

// ---------------------------------------------------------------------------
// parseUrl
// ---------------------------------------------------------------------------

test('a bare visit with no query returns null, signalling localStorage fallback', () => {
  assert.equal(parseUrl('/', ''), null);
  assert.equal(parseUrl('', ''), null);
});

test('any query parameter, even a default, is not a bare visit', () => {
  // `live=true` is the default, but its presence in the URL means someone
  // shared a link, so it should be parsed, not treated as bare.
  const state = parseUrl('/', '?live=true');
  assert.ok(state);
  assert.equal(state.filters.live, true);
});

test('contract and topic are read from the query string', () => {
  const state = parseUrl('/', `?contract=${SAC}&topic=transfer`);
  assert.ok(state);
  assert.equal(state.filters.contractId, SAC);
  assert.equal(state.filters.topic, 'transfer');
  assert.equal(state.filters.successfulOnly, false);
  assert.equal(state.filters.live, true);
  assert.equal(state.network, '');
  assert.equal(state.expandedEventId, null);
});

test('address, search, and time range are read from the query string', () => {
  const state = parseUrl('/', `?address=${ACCOUNT}&search=transfer&timeRange=custom&fromTime=2025-01-01T00%3A00&toTime=1704076800`);
  assert.ok(state);
  assert.equal(state.filters.address, ACCOUNT);
  assert.equal(state.filters.search, 'transfer');
  assert.equal(state.filters.timeRange, 'custom');
  assert.equal(state.filters.customFromTime, '2025-01-01T00:00');
  assert.equal(state.filters.customToTime, '1704076800');
});

test('successfulOnly and live=false are parsed from the query string', () => {
  const state = parseUrl('/', '?successfulOnly=true&live=false');
  assert.ok(state);
  assert.equal(state.filters.successfulOnly, true);
  assert.equal(state.filters.live, false);
});

test('live defaults to true; only live=false turns it off', () => {
  assert.equal(parseUrl('/', '?contract=X')?.filters.live, true);
  assert.equal(parseUrl('/', '?live=false')?.filters.live, false);
  // Absent means default true.
  assert.equal(parseUrl('/', '?contract=X')?.filters.live, true);
});

test('network is read from the query string', () => {
  assert.equal(parseUrl('/', '?network=testnet')?.network, 'testnet');
  assert.equal(parseUrl('/', '?network=mainnet')?.network, 'mainnet');
});

test('the /events/{id} path sets expandedEventId', () => {
  const state = parseUrl(`/events/${EVENT_ID}`, '');
  assert.ok(state);
  assert.equal(state.expandedEventId, EVENT_ID);
  // Filters still default when not in the URL.
  assert.equal(state.filters.contractId, '');
});

test('/events/{id} combines with query params for filters', () => {
  const state = parseUrl(`/events/${EVENT_ID}`, `?contract=${SAC}&topic=transfer&network=testnet`);
  assert.ok(state);
  assert.equal(state.expandedEventId, EVENT_ID);
  assert.equal(state.filters.contractId, SAC);
  assert.equal(state.filters.topic, 'transfer');
  assert.equal(state.network, 'testnet');
});

test('a trailing slash on /events/{id} is handled', () => {
  const state = parseUrl(`/events/${EVENT_ID}/`, '');
  assert.ok(state);
  assert.equal(state.expandedEventId, EVENT_ID);
});

test('an event id with special characters is decoded', () => {
  // Event ids are ledger-op format with a hyphen, but the path could carry
  // encoded characters if someone pastes a raw id.
  const state = parseUrl('/events/foo%2Fbar', '');
  assert.ok(state);
  assert.equal(state.expandedEventId, 'foo/bar');
});

test('a non-events path with query params is parsed as a normal view', () => {
  const state = parseUrl('/contracts', '?contract=X');
  assert.ok(state);
  assert.equal(state.expandedEventId, null);
  assert.equal(state.filters.contractId, 'X');
});

// ---------------------------------------------------------------------------
// stringifyUrl
// ---------------------------------------------------------------------------

test('default state produces a bare root path', () => {
  assert.equal(stringifyUrl(DEFAULTS), '/');
});

test('only non-default values are written, keeping URLs short', () => {
  const url = stringifyUrl({
    filters: filters({ contractId: SAC }),
    network: '',
    expandedEventId: null,
  });
  assert.equal(url, `/?contract=${SAC}`);
});

test('all filters together produce a full query string', () => {
  const url = stringifyUrl({
    filters: filters({ contractId: SAC, topic: 'transfer', address: ACCOUNT, search: 'mint', successfulOnly: true, live: false, timeRange: '1h' }),
    network: 'testnet',
    expandedEventId: null,
  });
  // Parse it back to check each param is present.
  const { searchParams } = new URL(url, 'http://localhost');
  assert.equal(searchParams.get('contract'), SAC);
  assert.equal(searchParams.get('topic'), 'transfer');
  assert.equal(searchParams.get('address'), ACCOUNT);
  assert.equal(searchParams.get('search'), 'mint');
  assert.equal(searchParams.get('successfulOnly'), 'true');
  assert.equal(searchParams.get('live'), 'false');
  assert.equal(searchParams.get('timeRange'), '1h');
  assert.equal(searchParams.get('network'), 'testnet');
});

test('live=true (the default) is not written to the URL', () => {
  const url = stringifyUrl({
    filters: filters(),
    network: '',
    expandedEventId: null,
  });
  assert.equal(url, '/');
});

test('live=false is written, since it differs from the default', () => {
  const url = stringifyUrl({
    filters: filters({ live: false }),
    network: '',
    expandedEventId: null,
  });
  assert.equal(url, '/?live=false');
});

test('successfulOnly=false (the default) is not written', () => {
  const url = stringifyUrl({
    filters: filters(),
    network: '',
    expandedEventId: null,
  });
  assert.ok(!url.includes('successfulOnly'));
});

test('expandedEventId uses the /events/{id} path', () => {
  const url = stringifyUrl({
    filters: filters(),
    network: '',
    expandedEventId: EVENT_ID,
  });
  assert.equal(url, `/events/${EVENT_ID}`);
});

test('expandedEventId combines with filter query params', () => {
  const url = stringifyUrl({
    filters: filters({ contractId: SAC, topic: 'transfer' }),
    network: 'testnet',
    expandedEventId: EVENT_ID,
  });
  const { pathname, searchParams } = new URL(url, 'http://localhost');
  assert.equal(pathname, `/events/${EVENT_ID}`);
  assert.equal(searchParams.get('contract'), SAC);
  assert.equal(searchParams.get('topic'), 'transfer');
  assert.equal(searchParams.get('network'), 'testnet');
  // Defaults not written.
  assert.ok(!searchParams.has('successfulOnly'));
  assert.ok(!searchParams.has('live'));
});

test('an expandedEventId with special characters is encoded in the path', () => {
  const url = stringifyUrl({
    filters: filters(),
    network: '',
    expandedEventId: 'foo/bar',
  });
  assert.equal(url, '/events/foo%2Fbar');
});

// ---------------------------------------------------------------------------
// round-trip: stringify → parse → same state
// ---------------------------------------------------------------------------

test('round-tripping a full filter set preserves every field', () => {
  const original = {
    filters: filters({ contractId: SAC, topic: 'transfer', address: ACCOUNT, search: 'mint', successfulOnly: true, live: false }),
    network: 'mainnet',
    expandedEventId: null,
  };
  const url = stringifyUrl(original);
  const { pathname, search } = new URL(url, 'http://localhost');
  const parsed = parseUrl(pathname, search);
  assert.ok(parsed);
  assert.deepEqual(parsed, original);
});

test('round-tripping a deep link with filters preserves the event id and filters', () => {
  const original = {
    filters: filters({ contractId: SAC, topic: 'mint' }),
    network: 'testnet',
    expandedEventId: EVENT_ID,
  };
  const url = stringifyUrl(original);
  const { pathname, search } = new URL(url, 'http://localhost');
  const parsed = parseUrl(pathname, search);
  assert.ok(parsed);
  assert.deepEqual(parsed, original);
});

test('round-tripping default state gives back a bare visit (null)', () => {
  // The default state stringifies to '/', which parses as null — the bare
  // visit that falls back to localStorage. This is intentional: a user who
  // clears all filters should land on the default view, not a URL full of
  // defaults.
  const url = stringifyUrl(DEFAULTS);
  assert.equal(url, '/');
  const parsed = parseUrl('/', '');
  assert.equal(parsed, null);
});

test('round-tripping with only network set', () => {
  const original = {
    filters: filters(),
    network: 'futurenet',
    expandedEventId: null,
  };
  const url = stringifyUrl(original);
  const { pathname, search } = new URL(url, 'http://localhost');
  const parsed = parseUrl(pathname, search);
  assert.ok(parsed);
  assert.deepEqual(parsed, original);
});

// ---------------------------------------------------------------------------
// sameFilterView
// ---------------------------------------------------------------------------

test('sameFilterView is true when only expandedEventId differs', () => {
  const a = { filters: filters({ contractId: 'X', topic: 't', successfulOnly: true, live: false }), network: 'n', expandedEventId: 'a' };
  const b = { filters: filters({ contractId: 'X', topic: 't', successfulOnly: true, live: false }), network: 'n', expandedEventId: 'b' };
  assert.ok(sameFilterView(a, b));
});

test('sameFilterView is false when any filter differs', () => {
  const base = { filters: filters({ contractId: 'X', topic: 't', successfulOnly: true, live: false }), network: 'n', expandedEventId: null };
  assert.ok(!sameFilterView(base, { ...base, filters: { ...base.filters, contractId: 'Y' } }));
  assert.ok(!sameFilterView(base, { ...base, filters: { ...base.filters, topic: 'u' } }));
  assert.ok(!sameFilterView(base, { ...base, filters: { ...base.filters, address: ACCOUNT } }));
  assert.ok(!sameFilterView(base, { ...base, filters: { ...base.filters, search: 'mint' } }));
  assert.ok(!sameFilterView(base, { ...base, filters: { ...base.filters, successfulOnly: false } }));
  assert.ok(!sameFilterView(base, { ...base, filters: { ...base.filters, live: true } }));
  assert.ok(!sameFilterView(base, { ...base, filters: { ...base.filters, timeRange: '1h' } }));
  assert.ok(!sameFilterView(base, { ...base, filters: { ...base.filters, customFromTime: '2025-01-01' } }));
  assert.ok(!sameFilterView(base, { ...base, network: 'm' }));
});

test('sameFilterView is true for identical states', () => {
  const a = { filters: filters(), network: '', expandedEventId: null };
  assert.ok(sameFilterView(a, { ...a }));
});

test('ledger bounds round-trip through the query string', () => {
  const original = {
    ...DEFAULTS,
    filters: { ...DEFAULTS.filters, contractId: SAC, fromLedger: '100', toLedger: '200' },
  };
  const url = stringifyUrl(original);
  assert.match(url, /fromLedger=100/);
  assert.match(url, /toLedger=200/);
  const [path, query = ''] = url.split('?');
  assert.deepEqual(parseUrl(path, query ? `?${query}` : ''), original);
});

test('a ledger-bound change is a filter change, not an expansion toggle', () => {
  const a = { ...DEFAULTS, filters: { ...DEFAULTS.filters, fromLedger: '1' } };
  const b = { ...DEFAULTS, filters: { ...DEFAULTS.filters, fromLedger: '2' } };
  assert.equal(sameFilterView(a, b), false);
});

// ---------------------------------------------------------------------------
// #188 / #189 / #190: new filter fields
// ---------------------------------------------------------------------------

test('address round-trips through the query string (#188)', () => {
  const original = { ...DEFAULTS, filters: filters({ address: ACCOUNT }) };
  const url = stringifyUrl(original);
  assert.match(url, new RegExp(`address=${ACCOUNT}`));
  const [path, query = ''] = url.split('?');
  assert.deepEqual(parseUrl(path, query ? `?${query}` : ''), original);
});

test('search text round-trips, including a two-character partial term (#189)', () => {
  const original = { ...DEFAULTS, filters: filters({ search: 'tr' }) };
  const url = stringifyUrl(original);
  assert.match(url, /search=tr/);
  const [path, query = ''] = url.split('?');
  assert.deepEqual(parseUrl(path, query ? `?${query}` : ''), original);
});

test('a time preset round-trips, and a custom range keeps both bounds (#190)', () => {
  const preset = { ...DEFAULTS, filters: filters({ timeRange: '15m' }) };
  const [p, pq = ''] = stringifyUrl(preset).split('?');
  assert.deepEqual(parseUrl(p, `?${pq}`), preset);

  const custom = {
    ...DEFAULTS,
    filters: filters({ timeRange: 'custom', customFromTime: '2025-01-01T00:00', customToTime: '2025-01-02T00:00' }),
  };
  const url = stringifyUrl(custom);
  assert.match(url, /timeRange=custom/);
  const [cp, cq = ''] = url.split('?');
  assert.deepEqual(parseUrl(cp, `?${cq}`), custom);
});
