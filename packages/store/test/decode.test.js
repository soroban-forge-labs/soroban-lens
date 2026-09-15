import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeScVal, decodeEvent, toJsonSafe, scValTypeName, topicKey } from '../dist/index.js';

const fixture = JSON.parse(readFileSync(new URL('../../../fixtures/testnet-events.json', import.meta.url), 'utf8'));
const byContract = (id) => fixture.events.filter((e) => e.contractId === id);

test('decodes a symbol topic from real testnet XDR', () => {
  assert.deepEqual(decodeScVal('AAAADwAAAAh0cmFuc2Zlcg=='), { type: 'symbol', value: 'transfer' });
});

test('decodes an i128 value to a decimal string, not a number', () => {
  const decoded = decodeScVal('AAAACgAAAAAAAAAAAAAAAAAAAGQ=');
  assert.equal(decoded.type, 'i128');
  assert.equal(decoded.value, '100');
  assert.equal(typeof decoded.value, 'string',
    'i128 exceeds Number.MAX_SAFE_INTEGER in general, so it must never be a JS number');
});

test('decodes an address topic to a StrKey', () => {
  const decoded = decodeScVal('AAAAEgAAAAAAAAAAcRav/5LYGpkrLitg/9on8pTWRiDdT2vFe4RnMeb//Jg=');
  assert.equal(decoded.type, 'address');
  assert.match(decoded.value, /^G[A-Z2-7]{55}$/);
});

test('every event in the fixture decodes without error', () => {
  for (const raw of fixture.events) {
    const event = decodeEvent(raw);
    assert.equal(event.decodeError, undefined, `${raw.id} failed: ${event.decodeError}`);
    assert.equal(event.topics.length, raw.topic.length);
  }
});

test('the fixture exercises every value arm we claim to cover', () => {
  const types = new Set(fixture.events.map((e) => decodeScVal(e.value).type));
  for (const expected of ['i128', 'map', 'vec', 'bytes']) {
    assert.ok(types.has(expected), `fixture no longer covers ScVal "${expected}"`);
  }
});

test('the fixture exercises non-symbol topic arms', () => {
  const types = new Set(fixture.events.flatMap((e) => e.topic.map((t) => decodeScVal(t).type)));
  for (const expected of ['symbol', 'address', 'string', 'u32', 'bool']) {
    assert.ok(types.has(expected), `fixture no longer covers topic arm "${expected}"`);
  }
});

test('events may carry more topics than a getEvents filter can match', () => {
  // The RPC topic filter accepts at most 4 segments, but emitted events are not
  // bound by that. Losing this property would mean the schema is under-built.
  const deep = fixture.events.filter((e) => e.topic.length > 4);
  assert.ok(deep.length > 0, 'fixture must retain at least one >4-topic event');
  const event = decodeEvent(deep[0]);
  assert.equal(event.topics.length, 5);
  assert.deepEqual(event.topics.map((t) => t.value).slice(0, 3), ['AXIS', 'order', 'created']);
});

test('bytes decode to hex, never to a numeric-keyed object', () => {
  const bytesEvent = byContract('CD4KFB23CQLJ47RIPESVBTQ444R75M6QVEZULWXHHFYYZT7SS2VGXOPW')[0];
  const decoded = decodeScVal(bytesEvent.value);
  assert.equal(decoded.type, 'bytes');
  assert.match(decoded.value, /^[0-9a-f]+$/);
  assert.ok(!JSON.stringify(decoded).includes('"0":'), 'Uint8Array leaked as an object');
});

test('bytes nested inside a map are also hex-encoded', () => {
  const event = fixture.events.find((e) => e.contractId === 'CBF2LTEN5LBXAMLH7J7MMUG6P7VAKGEVRXXGLBAESKTGLAF4RXPG2DWE');
  const decoded = decodeScVal(event.value);
  assert.equal(decoded.type, 'map');
  assert.match(decoded.value.new_block_hash, /^[0-9a-f]{64}$/);
});

test('decoded payloads survive a JSON round trip unchanged', () => {
  for (const raw of fixture.events) {
    const event = decodeEvent(raw);
    assert.deepEqual(JSON.parse(JSON.stringify(event)), JSON.parse(JSON.stringify(event)));
    assert.doesNotThrow(() => JSON.stringify(event), `${raw.id} is not JSON-serialisable`);
  }
});

test('toJsonSafe normalises BigInt, bytes, Map and nesting', () => {
  assert.equal(toJsonSafe(123n), '123');
  assert.equal(toJsonSafe(new Uint8Array([0xde, 0xad])), 'dead');
  assert.deepEqual(toJsonSafe(new Map([['a', 1n]])), { a: '1' });
  assert.deepEqual(toJsonSafe({ a: [1n, new Uint8Array([1])] }), { a: ['1', '01'] });
  assert.equal(toJsonSafe(undefined), null);
  assert.equal(toJsonSafe(null), null);
});

test('scValTypeName strips the ScVal prefix and lower-cases the arm', () => {
  assert.equal(scValTypeName({ constructor: { name: 'ScValSymbol' } }), 'symbol');
  assert.equal(scValTypeName({ constructor: { name: 'ScValI128' } }), 'i128');
  assert.equal(scValTypeName({}), 'unknown');
});

test('malformed XDR is recorded, never thrown', () => {
  const event = decodeEvent({
    id: 'bad', type: 'contract', ledger: 1, ledgerClosedAt: '2026-09-15T19:22:52Z',
    contractId: 'CA', topic: ['not-valid-xdr!!'], value: 'also-bad!!',
    txHash: 'ff', transactionIndex: 0, operationIndex: 0, inSuccessfulContractCall: true,
  });
  assert.match(event.decodeError, /topic\[0\]/);
  assert.match(event.decodeError, /value/);
  assert.equal(event.topics[0].type, 'undecodable');
  assert.equal(event.valueXdr, 'also-bad!!', 'raw XDR is preserved so the row can be re-decoded');
});

test('topicKey projects only scalars, leaving structured topics unindexed', () => {
  assert.equal(topicKey({ type: 'symbol', value: 'transfer' }), 'transfer');
  assert.equal(topicKey({ type: 'u32', value: 29 }), '29');
  assert.equal(topicKey({ type: 'bool', value: false }), 'false');
  assert.equal(topicKey({ type: 'vec', value: [1, 2] }), null);
  assert.equal(topicKey(undefined), null);
});
