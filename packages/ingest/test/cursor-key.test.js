import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultCursorKey, EventPoller } from '../dist/index.js';

// #127: the cursor key covers the event type and topic filters.

const RPC = 'https://soroban-testnet.stellar.org';
const SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const TRANSFER = 'AAAADwAAAAh0cmFuc2Zlcg==';

test('an unfiltered default config keeps exactly the key earlier versions produced', () => {
  // Pinned literals, computed by the pre-#127 implementation. If these change,
  // every existing indexer silently restarts from the oldest retained ledger.
  assert.equal(defaultCursorKey(RPC, [SAC]), 'soroban-testnet.stellar.org-027abf07');
  assert.equal(defaultCursorKey(RPC, []), 'soroban-testnet.stellar.org-cacdd8d2');
  assert.equal(defaultCursorKey(RPC, [SAC], { eventType: 'contract', topics: [] }), defaultCursorKey(RPC, [SAC]));
});

test('changing --topic or --type starts a new stream', () => {
  const base = defaultCursorKey(RPC, [SAC]);
  const topic = defaultCursorKey(RPC, [SAC], { topics: [[TRANSFER]] });
  const system = defaultCursorKey(RPC, [SAC], { eventType: 'system' });
  const both = defaultCursorKey(RPC, [SAC], { eventType: 'system', topics: [[TRANSFER]] });
  assert.equal(new Set([base, topic, system, both]).size, 4);
  assert.notEqual(defaultCursorKey(RPC, [SAC], { topics: [[TRANSFER, '*']] }), topic, 'segments are positional');
});

test('the order of separate topic filters does not matter', () => {
  assert.equal(
    defaultCursorKey(RPC, [SAC], { topics: [['a'], ['b']] }),
    defaultCursorKey(RPC, [SAC], { topics: [['b'], ['a']] }),
  );
});

test('the poller derives its key from its own filters', () => {
  const client = { rpcUrl: RPC };
  assert.equal(new EventPoller({ contractIds: [SAC] }, { client }).cursorKey, defaultCursorKey(RPC, [SAC]));
  assert.equal(
    new EventPoller({ contractIds: [SAC], topics: [[TRANSFER]] }, { client }).cursorKey,
    defaultCursorKey(RPC, [SAC], { topics: [[TRANSFER]] }),
  );
});
