import test from 'node:test';
import assert from 'node:assert/strict';
import { truncate, summarise, topicPath, relativeTime, prettyJson } from '../.test-build/format.js';

const SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

test('truncate shortens a contract id but leaves both ends readable', () => {
  const short = truncate(SAC);
  assert.equal(short, 'CDLZFC3S…2HHGCYSC');
  assert.ok(SAC.startsWith(short.slice(0, 8)));
  assert.ok(SAC.endsWith(short.slice(-8)));
});

test('truncate leaves a value that already fits untouched', () => {
  assert.equal(truncate('transfer'), 'transfer');
  // Exactly at the boundary: head + tail + 1 characters still fit.
  const boundary = 'x'.repeat(17);
  assert.equal(truncate(boundary), boundary);
  assert.equal(truncate('y'.repeat(18)).length, 17);
});

test('summarise renders scalars as themselves', () => {
  assert.equal(summarise({ type: 'symbol', value: 'transfer' }), 'transfer');
  assert.equal(summarise({ type: 'u32', value: 4695324 }), '4695324');
  assert.equal(summarise({ type: 'bool', value: false }), 'false');
});

test('summarise keeps a large i128 exact, since it arrives as a string', () => {
  // The whole reason decoded integers are strings: this must not go near Number.
  const huge = '170141183460469231731687303715884105727';
  assert.equal(summarise({ type: 'i128', value: huge }), huge);
});

test('summarise collapses structured values to a shape, not a dump', () => {
  assert.equal(summarise({ type: 'vec', value: ['20000000', 4695422] }), 'vec[2]');
  assert.equal(summarise({ type: 'map', value: { amount: '1018', token: 'CD4M' } }), 'map{2}');
  assert.equal(summarise({ type: 'vec', value: [] }), 'vec[0]');
});

test('summarise reports a missing value as null rather than crashing', () => {
  assert.equal(summarise({ type: 'void', value: null }), 'null');
  assert.equal(summarise({ type: 'void', value: undefined }), 'null');
});

test('summarise keeps a row to one line', () => {
  const long = 'a'.repeat(200);
  const out = summarise({ type: 'string', value: long });
  assert.equal(out.length, 58, 'truncated to 57 characters plus the ellipsis');
  assert.ok(out.endsWith('…'));
  // A value that exactly fits is not truncated.
  assert.equal(summarise({ type: 'string', value: 'b'.repeat(60) }), 'b'.repeat(60));
});

test('topicPath joins topics into a readable path', () => {
  assert.equal(
    topicPath([
      { type: 'symbol', value: 'transfer' },
      { type: 'address', value: 'GABC' },
      { type: 'address', value: 'GXYZ' },
    ]),
    'transfer / GABC / GXYZ',
  );
  assert.equal(topicPath([]), '');
});

test('topicPath handles the >4-topic events the fixture actually contains', () => {
  const five = topicPath([
    { type: 'symbol', value: 'approve' },
    { type: 'address', value: 'GA' },
    { type: 'address', value: 'GB' },
    { type: 'string', value: 'USDC' },
    { type: 'u32', value: 7 },
  ]);
  assert.equal(five, 'approve / GA / GB / USDC / 7');
});

test('relativeTime scales through seconds, minutes, hours and days', () => {
  const now = Date.parse('2026-09-16T12:00:00Z');
  const ago = (ms) => relativeTime(new Date(now - ms).toISOString(), now);

  assert.equal(ago(0), '0s ago');
  assert.equal(ago(30_000), '30s ago');
  assert.equal(ago(5 * 60_000), '5m ago');
  assert.equal(ago(2 * 3_600_000), '2h ago');
  assert.equal(ago(2 * 86_400_000), '2d ago');
});

test('relativeTime never renders a future timestamp as negative', () => {
  const now = Date.parse('2026-09-16T12:00:00Z');
  // Clock skew between the indexer and the browser is ordinary, not an error.
  assert.equal(relativeTime(new Date(now + 30_000).toISOString(), now), '0s ago');
});

test('relativeTime falls back to the raw value it cannot parse', () => {
  assert.equal(relativeTime('not a timestamp'), 'not a timestamp');
  assert.equal(relativeTime(''), '');
});

test('prettyJson indents for the expanded row', () => {
  assert.equal(prettyJson({ a: 1 }), '{\n  "a": 1\n}');
});
