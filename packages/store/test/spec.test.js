import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { xdr, nativeToScVal, Address } from '@stellar/stellar-sdk';
import {
  ContractTypedDecoder,
  SpecCache,
  STELLAR_ASSET_SPEC_ENTRIES,
  decodeEvent,
  typeName,
} from '../dist/index.js';

const fixture = JSON.parse(readFileSync(new URL('../../../fixtures/testnet-events.json', import.meta.url), 'utf8'));
const specs = JSON.parse(readFileSync(new URL('../../../fixtures/testnet-specs.json', import.meta.url), 'utf8')).specs;
const specFor = (id) => specs.find((s) => s.contractId === id);
const eventsOf = (id) => fixture.events.filter((e) => e.contractId === id).map((raw) => decodeEvent(raw));

const SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const USDC_SAC = 'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU';
const ORACLE = 'CB3IUO2Y5NFH7LDX5EOLA63WO7QSYJSOBMMZESLBC62DEPNQJPOYDULC';
const NO_EVENTS = 'CBSWA5P75NGV2LP5KOY7A7LOAX2CENI5OYBSJ5IVLHENKQJF2I3ZBSYE';
const G1 = 'GBYRNL77SLMBVGJLFYVWB762E7ZJJVSGEDOU626FPOCGOMPG776JQHHT';
const G2 = 'GDVFO2G543H3RYG4H66OX36ESWAP6H5CHP2QN7E3D3CTYJBSNOJB5GSA';

const sac = new ContractTypedDecoder('stellar-asset', STELLAR_ASSET_SPEC_ENTRIES);
const b64 = (scv) => scv.toXDR('base64');
const sym = (s) => b64(nativeToScVal(s, { type: 'symbol' }));
const addr = (a) => b64(new Address(a).toScVal());
const str = (s) => b64(nativeToScVal(s, { type: 'string' }));
const i128 = (n) => b64(nativeToScVal(n, { type: 'i128' }));

test('a native XLM transfer from the fixture reads as transfer { from, to, sep0011_asset, amount }', () => {
  const transfer = eventsOf(SAC).find((e) => e.topics[0].value === 'transfer');
  assert.ok(transfer, 'the fixture has a native transfer');
  const typed = sac.decode(transfer);
  assert.equal(typed.name, 'transfer');
  assert.equal(typed.source, 'stellar-asset');
  assert.deepEqual(typed.fields.map((f) => [f.name, f.type, f.location]), [
    ['from', 'Address', 'topic'],
    ['to', 'Address', 'topic'],
    ['sep0011_asset', 'String', 'topic'],
    ['amount', 'i128', 'data'],
  ]);
  assert.equal(typed.fields[2].value, 'native');
  assert.equal(typeof typed.fields[3].value, 'string', 'i128 stays a decimal string in the typed view too');
});

test('every SAC event in the fixture gets a typed view', () => {
  for (const id of [SAC, USDC_SAC]) {
    for (const event of eventsOf(id)) {
      assert.ok(sac.decode(event), `${event.id} (${event.topics[0].value}) did not match the SAC spec`);
    }
  }
});

test('an approve carries its vec data as two named fields', () => {
  const approve = eventsOf(USDC_SAC).find((e) => e.topics[0].value === 'approve');
  const typed = sac.decode(approve);
  assert.deepEqual(typed.fields.slice(3).map((f) => [f.name, f.type]), [['amount', 'i128'], ['expiration_ledger', 'u32']]);
  assert.equal(typed.fields[4].value, 4695815);
});

test('a muxed transfer (map data) still decodes, with to_muxed_id', () => {
  const data = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: nativeToScVal('amount', { type: 'symbol' }), val: nativeToScVal(5n, { type: 'i128' }) }),
    new xdr.ScMapEntry({ key: nativeToScVal('to_muxed_id', { type: 'symbol' }), val: nativeToScVal(7n, { type: 'u64' }) }),
  ]);
  const typed = sac.decode({ topicsXdr: [sym('transfer'), addr(G1), addr(G2), str('native')], valueXdr: b64(data) });
  assert.equal(typed.name, 'transfer');
  assert.deepEqual(typed.fields.map((f) => f.name), ['from', 'to', 'sep0011_asset', 'amount', 'to_muxed_id']);
  assert.equal(typed.fields.at(-1).type, 'Option<u64>');
  assert.equal(typed.fields.at(-1).value, '7');
});

test('a legacy four-topic mint labels the admin as admin, not as the recipient', () => {
  const legacy = sac.decode({ topicsXdr: [sym('mint'), addr(G1), addr(G2), str('native')], valueXdr: i128(1n) });
  assert.deepEqual(legacy.fields.map((f) => [f.name, f.value]).slice(0, 2), [['admin', G1], ['to', G2]]);
  const current = sac.decode({ topicsXdr: [sym('mint'), addr(G2), str('native')], valueXdr: i128(1n) });
  assert.deepEqual(current.fields.map((f) => [f.name, f.value]).slice(0, 1), [['to', G2]]);
});

test("a contract's own Wasm spec decodes its real fixture events with declared names and types", () => {
  const decoder = ContractTypedDecoder.fromRecord(specFor(ORACLE));
  assert.ok(decoder.eventCount > 0);
  const typed = eventsOf(ORACLE).map((e) => decoder.decode(e)).filter(Boolean);
  assert.ok(typed.length > 0, 'at least one oracle event matches its spec');
  const fetch = typed.find((t) => t.name === 'PriceFetch');
  assert.deepEqual(fetch.fields.map((f) => f.name), ['symbol', 'price', 'timestamp']);
  assert.equal(fetch.source, 'wasm');
});

test("every fixture event that its contract's spec declares gets a typed view", () => {
  // CBF2LTEN declares only its two ownership events; the fixture's event
  // from it is a new_block_event it emits without declaring. That one is
  // exactly the case that must fall back to the generic view.
  const UNDECLARED = 'CBF2LTEN5LBXAMLH7J7MMUG6P7VAKGEVRXXGLBAESKTGLAF4RXPG2DWE';
  let matched = 0;
  for (const record of specs.filter((s) => s.source === 'wasm' && s.eventCount > 0)) {
    const decoder = ContractTypedDecoder.fromRecord(record);
    for (const event of eventsOf(record.contractId)) {
      const typed = decoder.decode(event);
      if (record.contractId === UNDECLARED) {
        assert.equal(typed, null, 'an undeclared event must not be forced into a declared shape');
      } else {
        assert.ok(typed, `${record.contractId} ${event.id} did not match its own spec`);
        matched++;
      }
    }
  }
  assert.equal(matched, 8);
});

test('a contract without event specs, or a source of none, has no typed view', () => {
  assert.equal(ContractTypedDecoder.fromRecord(specFor(NO_EVENTS)), null);
  assert.equal(
    ContractTypedDecoder.fromRecord({ contractId: SAC, source: 'none', entriesXdr: [], eventCount: 0, fetchedAt: '' }),
    null,
  );
});

test('an event no declaration matches decodes to null rather than throwing', () => {
  assert.equal(sac.decode({ topicsXdr: [sym('something_else')], valueXdr: i128(1n) }), null);
  assert.equal(sac.decode({ topicsXdr: ['not xdr at all'], valueXdr: 'nor this' }), null);
});

test('typeName renders spec types the way a contract author writes them', () => {
  const T = xdr.ScSpecTypeDef;
  assert.equal(typeName(T.scSpecTypeI128()), 'i128');
  assert.equal(typeName(T.scSpecTypeAddress()), 'Address');
  assert.equal(typeName(T.scSpecTypeVec(new xdr.ScSpecTypeVec({ elementType: T.scSpecTypeAddress() }))), 'Vec<Address>');
  assert.equal(
    typeName(T.scSpecTypeMap(new xdr.ScSpecTypeMap({ keyType: T.scSpecTypeSymbol(), valueType: T.scSpecTypeI128() }))),
    'Map<Symbol, i128>',
  );
  assert.equal(typeName(T.scSpecTypeBytesN(new xdr.ScSpecTypeBytesN({ n: 32 }))), 'BytesN<32>');
  assert.equal(typeName(T.scSpecTypeUdt(new xdr.ScSpecTypeUdt({ name: 'Market' }))), 'Market');
  assert.equal(typeName(T.scSpecTypeVoid()), '()');
});

test('SpecCache annotates only events it has a spec for, and caches misses too', async () => {
  const loads = [];
  const cache = new SpecCache(async (id) => {
    loads.push(id);
    return id === SAC ? { contractId: SAC, source: 'stellar-asset', entriesXdr: [], eventCount: 0, fetchedAt: '' } : null;
  });
  const events = [...eventsOf(SAC).slice(0, 2), ...eventsOf(ORACLE).slice(0, 1)];
  const annotated = await cache.annotate(events);
  assert.ok(annotated[0].typed && annotated[1].typed);
  assert.equal(annotated[2].typed, undefined);
  assert.equal(annotated[2], events[2], 'an event with no typed view is returned unchanged');
  await cache.annotate(events);
  assert.deepEqual(loads.sort(), [ORACLE, SAC].sort(), 'one load per contract, not per event or per call');
});

test('SpecCache reloads after its TTL, so a spec fetched later shows up', async () => {
  let now = 0;
  let record = null;
  const cache = new SpecCache(async () => record, { ttlMs: 1000, now: () => now });
  assert.equal(await cache.get(SAC), null);
  record = { contractId: SAC, source: 'stellar-asset', entriesXdr: [], eventCount: 0, fetchedAt: '' };
  assert.equal(await cache.get(SAC), null, 'still cached');
  now = 1001;
  assert.ok(await cache.get(SAC));
});

test('SpecCache treats unparseable stored entries as no spec, not as a failure', async () => {
  const cache = new SpecCache(async () => ({
    contractId: SAC, source: 'wasm', entriesXdr: ['garbage'], eventCount: 1, fetchedAt: '',
  }));
  assert.equal(await cache.get(SAC), null);
});
