import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveNetwork, isNetworkName, NETWORKS } from '../dist/index.js';

test('testnet preset matches the passphrase the live RPC reports', () => {
  const net = resolveNetwork('testnet');
  assert.equal(net.rpcUrl, 'https://soroban-testnet.stellar.org');
  assert.equal(net.networkPassphrase, 'Test SDF Network ; September 2015');
});

test('mainnet preset uses the public network passphrase', () => {
  assert.equal(
    resolveNetwork('mainnet').networkPassphrase,
    'Public Global Stellar Network ; September 2015',
  );
});

test('an explicit rpcUrl overrides the preset', () => {
  const net = resolveNetwork('testnet', 'http://localhost:8000/soroban/rpc');
  assert.equal(net.rpcUrl, 'http://localhost:8000/soroban/rpc');
  assert.equal(net.networkPassphrase, 'Test SDF Network ; September 2015');
});

test('unknown networks fail loudly and list the valid names', () => {
  assert.throws(() => resolveNetwork('mainnnet'), /Unknown network "mainnnet".*testnet/s);
});

test('isNetworkName narrows only to known presets', () => {
  assert.ok(isNetworkName('testnet'));
  assert.ok(!isNetworkName('toString'), 'must not be fooled by Object.prototype keys');
  assert.deepEqual(Object.keys(NETWORKS).sort(), ['futurenet', 'mainnet', 'testnet']);
});
