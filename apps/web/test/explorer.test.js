import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_EXPLORERS, explorerUrl, resolveExplorerUrl } from '../.test-build/explorer.js';

const TX = 'ab'.repeat(32);
const CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const ACCOUNT = 'GBYRNL77SLMBVGJLFYVWB762E7ZJJVSGEDOU626FPOCGOMPG776JQHHT';

test('the defaults point testnet at Stellar Expert testnet', () => {
  assert.equal(
    explorerUrl('testnet', 'tx', TX),
    `https://stellar.expert/explorer/testnet/tx/${TX}`,
  );
  assert.equal(
    explorerUrl('testnet', 'contract', CONTRACT),
    `https://stellar.expert/explorer/testnet/contract/${CONTRACT}`,
  );
  assert.equal(
    explorerUrl('testnet', 'account', ACCOUNT),
    `https://stellar.expert/explorer/testnet/account/${ACCOUNT}`,
  );
});

test('mainnet uses Stellar Expert\'s "public" path, under either label', () => {
  const expected = `https://stellar.expert/explorer/public/contract/${CONTRACT}`;
  assert.equal(explorerUrl('mainnet', 'contract', CONTRACT), expected);
  assert.equal(explorerUrl('public', 'contract', CONTRACT), expected);
});

test('an unknown network shows no link at all', () => {
  assert.equal(explorerUrl('devnet', 'tx', TX), null);
  assert.equal(explorerUrl('', 'tx', TX), null);
});

test('a label is matched regardless of case', () => {
  assert.equal(
    explorerUrl('TestNet', 'tx', TX),
    `https://stellar.expert/explorer/testnet/tx/${TX}`,
  );
});

test('a self-hosted explorer is just a base URL in the map', () => {
  const map = { 'local-testnet': 'https://explorer.internal/stellar/testnet' };
  assert.equal(
    explorerUrl('local-testnet', 'tx', TX, map),
    `https://explorer.internal/stellar/testnet/tx/${TX}`,
  );
});

test('a trailing slash in a self-hosted base URL does not double up', () => {
  const map = { testnet: 'https://explorer.internal/testnet//' };
  assert.equal(
    explorerUrl('testnet', 'tx', TX, map),
    `https://explorer.internal/testnet/tx/${TX}`,
  );
});

test('an explorer with different routes uses per-entity templates', () => {
  const map = {
    horizon: {
      tx: 'https://horizon.internal/transactions/{value}',
      account: 'https://horizon.internal/accounts/{value}',
    },
  };
  assert.equal(
    explorerUrl('horizon', 'tx', TX, map),
    `https://horizon.internal/transactions/${TX}`,
  );
  assert.equal(
    explorerUrl('horizon', 'account', ACCOUNT, map),
    `https://horizon.internal/accounts/${ACCOUNT}`,
  );
  // No contract route configured means no contract link.
  assert.equal(explorerUrl('horizon', 'contract', CONTRACT, map), null);
});

test('an empty string turns links off for that network', () => {
  const map = { ...DEFAULT_EXPLORERS, testnet: '' };
  assert.equal(explorerUrl('testnet', 'tx', TX, map), null);
  // Other networks keep their defaults.
  assert.ok(explorerUrl('mainnet', 'tx', TX, map));
});

test('a value of the wrong shape produces no link rather than a 404', () => {
  // A contract id is not an account, a hash must be 64 hex characters, and an
  // address that is still being typed is not either.
  assert.equal(explorerUrl('testnet', 'account', CONTRACT), null);
  assert.equal(explorerUrl('testnet', 'contract', ACCOUNT), null);
  assert.equal(explorerUrl('testnet', 'tx', 'not-a-hash'), null);
  assert.equal(explorerUrl('testnet', 'tx', 'zz'.repeat(32)), null);
  assert.equal(explorerUrl('testnet', 'account', ACCOUNT.slice(0, 55)), null);
});

test('a map without the label is the same as an unknown network', () => {
  assert.equal(resolveExplorerUrl({}, 'testnet', 'tx', TX), null);
});

test('the same id resolves against whichever network is selected', () => {
  const first = explorerUrl('testnet', 'tx', TX);
  const second = explorerUrl('mainnet', 'tx', TX);
  assert.notEqual(first, second);
  assert.ok(first?.includes('/testnet/'));
  assert.ok(second?.includes('/public/'));
});
