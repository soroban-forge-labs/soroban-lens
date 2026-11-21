import test from 'node:test';
import assert from 'node:assert/strict';
import { describeEmptyState } from '../.test-build/emptyState.js';
import { en } from '../.test-build/i18n/en.js';
import { es } from '../.test-build/i18n/es.js';
import { translate } from '../.test-build/i18n/translate.js';

// #78: an empty table is one of several situations, each with its own remedy.

const STREAM = { key: 'main', cursor: '0020166232959352832-0000000000', ledger: 4695317, updatedAt: '2026-11-21T10:00:00Z' };
const status = (eventCount, streams = []) => ({
  eventCount,
  contractCount: eventCount > 0 ? 1 : 0,
  minLedger: null,
  maxLedger: null,
  schemaVersion: 6,
  streams,
});
const base = { loadErrorStatus: null, status: null, contractUnknown: false, emptyReason: null };

test('the four states from the issue are told apart', () => {
  const states = {
    filterMatchesNothing: describeEmptyState({ ...base, status: status(60, [STREAM]) }),
    apiUnreachable: describeEmptyState({ ...base, loadErrorStatus: 0 }),
    indexerCatchingUp: describeEmptyState({ ...base, status: status(0, [STREAM]) }),
    nothingIndexed: describeEmptyState({ ...base, status: status(0) }),
  };
  assert.deepEqual(
    Object.fromEntries(Object.entries(states).map(([k, v]) => [k, v.kind])),
    {
      filterMatchesNothing: 'no-matching',
      apiUnreachable: 'unreachable',
      indexerCatchingUp: 'catching-up',
      nothingIndexed: 'nothing-indexed',
    },
  );
  const messages = Object.values(states).map((s) => translate(en, s.key, s.vars));
  assert.equal(new Set(messages).size, 4, 'four distinct messages');
});

test('catching up names the ledger the indexer has reached, from its newest stream', () => {
  const older = { ...STREAM, key: 'other', ledger: 100 };
  const state = describeEmptyState({ ...base, status: status(0, [older, STREAM]) });
  assert.deepEqual(state.vars, { ledger: 4695317 });
  assert.match(translate(en, state.key, state.vars), /ledger 4695317/);
});

test('an unreachable API wins over anything stale we still hold', () => {
  const state = describeEmptyState({
    loadErrorStatus: 0,
    status: status(0),
    contractUnknown: true,
    emptyReason: 'no_matching_events',
  });
  assert.equal(state.kind, 'unreachable');
});

test('an error response is not passed off as "no events match"', () => {
  assert.equal(describeEmptyState({ ...base, loadErrorStatus: 500, status: status(60) }).kind, 'request-failed');
  assert.equal(describeEmptyState({ ...base, loadErrorStatus: 400 }).kind, 'request-failed');
});

test('in an empty database a contract is not blamed for being unknown', () => {
  // Every contract 404s when nothing is indexed; the remedy is the indexer, not the id.
  const state = describeEmptyState({ ...base, contractUnknown: true, status: status(0) });
  assert.equal(state.kind, 'nothing-indexed');
});

test("#58's distinctions still apply once there is data", () => {
  assert.equal(describeEmptyState({ ...base, contractUnknown: true, status: status(60) }).key, 'emptyContractUnknown');
  assert.equal(
    describeEmptyState({ ...base, emptyReason: 'no_matching_events', status: status(60) }).key,
    'emptyNoMatchingEvents',
  );
});

test('without /status, it falls back to the filter message rather than guessing "nothing indexed"', () => {
  assert.equal(describeEmptyState(base).key, 'emptyNoResults');
});

test('every empty-state message exists in Spanish too', () => {
  for (const key of ['emptyApiUnreachable', 'emptyRequestFailed', 'emptyIndexerCatchingUp', 'emptyNothingIndexed', 'emptyNoResults']) {
    assert.ok(es[key], key);
  }
  assert.match(translate(es, 'emptyIndexerCatchingUp', { ledger: 7 }), /ledger 7/);
});
