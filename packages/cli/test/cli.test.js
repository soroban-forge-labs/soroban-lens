import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteEventStore } from '@soroban-lens/store';
import { resolveConfig, splitList, runDoctor, formatReport, StoreBackedCursors } from '../dist/index.js';

const SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
/** A host that cannot resolve, so the RPC check fails fast on or offline. */
const DEAD_RPC = 'https://rpc.invalid.soroban-lens-test';

const find = (results, name) => results.find((r) => r.name === name);

test('config falls back to documented defaults', () => {
  const config = resolveConfig({}, {});
  assert.equal(config.network.name, 'testnet');
  assert.equal(config.network.rpcUrl, 'https://soroban-testnet.stellar.org');
  assert.equal(config.dbPath, './data/lens.db');
  assert.equal(config.apiPort, 8080);
  assert.equal(config.pageSize, 200);
  assert.equal(config.pollIntervalMs, 2000);
  assert.deepEqual(config.contractIds, []);
  assert.equal(config.startLedger, undefined);
});

test('environment overrides defaults', () => {
  const config = resolveConfig({}, {
    LENS_NETWORK: 'futurenet',
    LENS_DB_PATH: '/data/x.db',
    LENS_API_PORT: '9000',
    LENS_CONTRACT_IDS: `${SAC}, ${SAC}`,
    LENS_START_LEDGER: '4695317',
  });
  assert.equal(config.network.name, 'futurenet');
  assert.equal(config.dbPath, '/data/x.db');
  assert.equal(config.apiPort, 9000);
  assert.equal(config.contractIds.length, 2);
  assert.equal(config.startLedger, 4695317);
});

test('flags override environment', () => {
  const config = resolveConfig(
    { network: 'testnet', db: '/flag.db', port: 1234, contracts: [SAC] },
    { LENS_NETWORK: 'mainnet', LENS_DB_PATH: '/env.db', LENS_API_PORT: '9999', LENS_CONTRACT_IDS: 'CENV' },
  );
  assert.equal(config.network.name, 'testnet');
  assert.equal(config.dbPath, '/flag.db');
  assert.equal(config.apiPort, 1234);
  assert.deepEqual(config.contractIds, [SAC]);
});

test('an explicit rpc-url wins over the network preset', () => {
  const config = resolveConfig({ rpcUrl: 'http://localhost:8000/rpc' }, { LENS_NETWORK: 'mainnet' });
  assert.equal(config.network.rpcUrl, 'http://localhost:8000/rpc');
  assert.equal(config.network.name, 'mainnet', 'the passphrase must still come from the preset');
});

test('non-numeric env values fall back instead of becoming NaN', () => {
  const config = resolveConfig({}, { LENS_API_PORT: 'eighty', LENS_PAGE_SIZE: '', LENS_START_LEDGER: 'soon' });
  assert.equal(config.apiPort, 8080);
  assert.equal(config.pageSize, 200);
  assert.equal(config.startLedger, undefined);
});

test('splitList trims and drops empty entries', () => {
  assert.deepEqual(splitList(' A , B ,, C '), ['A', 'B', 'C']);
  assert.deepEqual(splitList(undefined), []);
  assert.deepEqual(splitList(''), []);
});

test('doctor passes the local checks on a writable directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-doctor-'));
  const config = resolveConfig({ dataDir: dir, db: join(dir, 'lens.db'), rpcUrl: DEAD_RPC, contracts: [SAC] }, {});
  const results = await runDoctor(config);

  assert.equal(find(results, 'Node.js version').status, 'pass');
  assert.equal(find(results, 'Data directory').status, 'pass');
  assert.equal(find(results, 'Database').status, 'pass');
  assert.equal(find(results, 'Contract IDs').status, 'pass');
});

test('doctor fails when the RPC endpoint is unreachable, and says what to do', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-doctor-'));
  const config = resolveConfig({ dataDir: dir, db: join(dir, 'lens.db'), rpcUrl: DEAD_RPC, contracts: [SAC] }, {});
  const rpc = find(await runDoctor(config), 'Soroban RPC');
  assert.equal(rpc.status, 'fail');
  assert.match(rpc.fix, /LENS_RPC_URL/);
});

test('doctor rejects an account id given where a contract id belongs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-doctor-'));
  const account = 'GBQHHOH72M522QBF7SMY57JH6FIN7YKTZUWSO4S5IFBXV3B7FI2UQLIQ';
  const config = resolveConfig({ dataDir: dir, db: join(dir, 'lens.db'), rpcUrl: DEAD_RPC, contracts: [account] }, {});
  const check = find(await runDoctor(config), 'Contract IDs');
  assert.equal(check.status, 'fail');
  assert.match(check.fix, /Account ids start with 'G'/);
});

test('doctor warns, but does not fail, when no contract is configured', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-doctor-'));
  const config = resolveConfig({ dataDir: dir, db: join(dir, 'lens.db'), rpcUrl: DEAD_RPC }, {});
  const check = find(await runDoctor(config), 'Contract IDs');
  assert.equal(check.status, 'warn');
  assert.match(check.detail, /every contract/);
});

test('doctor fails on a read-only data directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-doctor-ro-'));
  const readOnly = join(dir, 'locked');
  const config = resolveConfig({ dataDir: readOnly, db: join(dir, 'lens.db'), rpcUrl: DEAD_RPC }, {});
  await (await import('node:fs/promises')).mkdir(readOnly);
  await chmod(readOnly, 0o500);
  try {
    const check = find(await runDoctor(config), 'Data directory');
    assert.equal(check.status, 'fail');
    assert.match(check.fix, /writable/);
  } finally {
    await chmod(readOnly, 0o700);
  }
});

test('formatReport exits non-zero only when a check failed', () => {
  const pass = formatReport([{ name: 'A', status: 'pass', detail: 'ok' }]);
  assert.equal(pass.exitCode, 0);
  assert.match(pass.text, /All checks passed/);

  const warn = formatReport([{ name: 'A', status: 'warn', detail: 'hmm', fix: 'do this' }]);
  assert.equal(warn.exitCode, 0, 'a warning is not a failure');
  assert.match(warn.text, /1 warning/);

  const fail = formatReport([{ name: 'A', status: 'fail', detail: 'bad', fix: 'do that' }]);
  assert.equal(fail.exitCode, 1);
  assert.match(fail.text, /1 check\(s\) failed/);
  assert.match(fail.text, /do that/, 'the fix hint must reach the operator');
});

test('StoreBackedCursors keeps resume state in the events database', async () => {
  const store = new SqliteEventStore({ path: ':memory:' });
  const cursors = new StoreBackedCursors(store);

  assert.equal(await cursors.load('k'), null);
  await cursors.save('k', { cursor: 'c1', ledger: 4695317, updatedAt: '2026-09-15T19:00:00Z' });

  const loaded = await cursors.load('k');
  assert.equal(loaded.cursor, 'c1');
  assert.equal(loaded.ledger, 4695317);

  // The same state is visible through the store, which is what /status serves.
  assert.equal((await store.listStreamStates())[0].ledger, 4695317);

  await cursors.clear('k');
  assert.equal(await cursors.load('k'), null, 'a cleared cursor must read back as absent');
  await store.close();
});
