import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteEventStore } from '@soroban-lens/store';
import {
  lookupContractSpec,
  recordFromWasm,
  describeSpecRecord,
  SpecFetcher,
  resolveConfig,
} from '../dist/index.js';

const SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const OTHER = 'CB3IUO2Y5NFH7LDX5EOLA63WO7QSYJSOBMMZESLBC62DEPNQJPOYDULC';

/** A fake RPC: per contract, an executable type or an error to throw. */
function fakeSource(behaviour, calls = []) {
  return {
    async getContractInstance(id) {
      calls.push(['instance', id]);
      const b = behaviour[id];
      if (b instanceof Error || b?.code) throw b;
      return { executable: { type: b?.executable ?? 'contractExecutableWasm' } };
    },
    async getContractWasmByContractId(id) {
      calls.push(['wasm', id]);
      const b = behaviour[id];
      if (b?.wasmError) throw b.wasmError;
      return b?.wasm ?? new Uint8Array([0, 1, 2]);
    },
  };
}

test('a Stellar Asset Contract resolves to the built-in spec without fetching Wasm', async () => {
  const calls = [];
  const record = await lookupContractSpec(fakeSource({ [SAC]: { executable: 'contractExecutableStellarAsset' } }, calls), SAC);
  assert.equal(record.source, 'stellar-asset');
  assert.ok(record.eventCount > 0);
  assert.deepEqual(calls.map((c) => c[0]), ['instance']);
});

test('a contract that does not exist is a definite "none", worth remembering', async () => {
  const record = await lookupContractSpec(
    fakeSource({ [SAC]: { code: 404, message: 'Could not obtain contract instance from server' } }),
    SAC,
  );
  assert.equal(record.source, 'none');
  assert.match(record.error, /not found/);
});

test('a network failure rejects instead of recording a wrong "none"', async () => {
  await assert.rejects(
    () => lookupContractSpec(fakeSource({ [SAC]: new Error('fetch failed') }), SAC),
    /fetch failed/,
  );
});

test('Wasm with no spec section is recorded as none, with its hash', () => {
  const record = recordFromWasm(SAC, new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
  assert.equal(record.source, 'none');
  assert.match(record.wasmHash, /^[0-9a-f]{64}$/);
  assert.match(describeSpecRecord(record), /no spec/);
});

test('SpecFetcher looks each contract up once, and skips ones the store already knows', async () => {
  const store = new SqliteEventStore({ path: ':memory:' });
  await store.saveContractSpec({ contractId: OTHER, source: 'stellar-asset', entriesXdr: [], eventCount: 1, fetchedAt: new Date().toISOString() });
  const calls = [];
  const fetcher = new SpecFetcher(store, fakeSource({ [SAC]: { executable: 'contractExecutableStellarAsset' } }, calls));
  fetcher.enqueue([SAC, SAC, OTHER]);
  fetcher.enqueue([SAC]);
  await fetcher.idle();
  assert.deepEqual(calls, [['instance', SAC]]);
  assert.equal((await store.getContractSpec(SAC)).source, 'stellar-asset');
  await store.close();
});

test('SpecFetcher retries a transient failure on a later batch, and never throws into the indexer', async () => {
  const store = new SqliteEventStore({ path: ':memory:' });
  const behaviour = { [SAC]: new Error('fetch failed') };
  const logs = [];
  const fetcher = new SpecFetcher(store, fakeSource(behaviour), { log: (m) => logs.push(m) });
  fetcher.enqueue([SAC]);
  await fetcher.idle();
  assert.equal(await store.getContractSpec(SAC), null);
  assert.match(logs.join('\n'), /will retry/);

  behaviour[SAC] = { executable: 'contractExecutableStellarAsset' };
  fetcher.enqueue([SAC]);
  await fetcher.idle();
  assert.equal((await store.getContractSpec(SAC)).source, 'stellar-asset');
  await store.close();
});

test('SpecFetcher re-checks a stale "none", but not a fresh one', async () => {
  const store = new SqliteEventStore({ path: ':memory:' });
  const calls = [];
  const source = fakeSource({ [SAC]: { executable: 'contractExecutableStellarAsset' } }, calls);
  await store.saveContractSpec({ contractId: SAC, source: 'none', entriesXdr: [], eventCount: 0, error: 'x', fetchedAt: new Date().toISOString() });
  let fetcher = new SpecFetcher(store, source);
  fetcher.enqueue([SAC]);
  await fetcher.idle();
  assert.equal(calls.length, 0);

  fetcher = new SpecFetcher(store, source, { retryNoneAfterMs: 0 });
  fetcher.enqueue([SAC]);
  await fetcher.idle();
  assert.equal(calls.length, 1);
  assert.equal((await store.getContractSpec(SAC)).source, 'stellar-asset');
  await store.close();
});

test('LENS_FETCH_SPECS=false turns spec fetching off; it is on by default', () => {
  assert.equal(resolveConfig({}, {}).fetchSpecs, true);
  assert.equal(resolveConfig({}, { LENS_FETCH_SPECS: 'false' }).fetchSpecs, false);
  assert.equal(resolveConfig({}, { LENS_FETCH_SPECS: '0' }).fetchSpecs, false);
});
