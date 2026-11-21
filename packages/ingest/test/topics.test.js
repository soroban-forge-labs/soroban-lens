import test from 'node:test';
import assert from 'node:assert/strict';
import { xdr, scValToNative, Address } from '@stellar/stellar-sdk';
import { encodeTopicSegment, parseTopicFilters, TopicFlagError, buildFilters, classifyRpcError, IngestMetrics, ingestionLag } from '../dist/index.js';

const SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const decode = (b64) => xdr.ScVal.fromXDR(b64, 'base64');

// ── #128 shorthands ──────────────────────────────────────────────────────────

test('sym:transfer encodes to the exact segment the SAC transfer topic carries', () => {
  // The fixture's SAC transfer events carry this first topic.
  assert.equal(encodeTopicSegment('sym:transfer'), 'AAAADwAAAAh0cmFuc2Zlcg==');
});

test('every shorthand encodes to the matching ScVal', () => {
  assert.equal(scValToNative(decode(encodeTopicSegment('str:hello'))), 'hello');
  assert.equal(Address.fromScVal(decode(encodeTopicSegment(`addr:${SAC}`))).toString(), SAC);
  const g = 'GBYRNL77SLMBVGJLFYVWB762E7ZJJVSGEDOU626FPOCGOMPG776JQHHT';
  assert.equal(Address.fromScVal(decode(encodeTopicSegment(`addr:${g}`))).toString(), g);
  assert.equal(scValToNative(decode(encodeTopicSegment('bool:true'))), true);
  assert.equal(scValToNative(decode(encodeTopicSegment('u32:5'))), 5);
  assert.equal(scValToNative(decode(encodeTopicSegment('i128:-10'))), -10n);
});

test('* and bare base64 pass through unchanged', () => {
  assert.equal(encodeTopicSegment('*'), '*');
  assert.equal(encodeTopicSegment('AAAADwAAAAh0cmFuc2Zlcg=='), 'AAAADwAAAAh0cmFuc2Zlcg==');
});

test('an unknown prefix is a usage error naming the accepted ones', () => {
  assert.throws(() => encodeTopicSegment('symbol:transfer'), (e) =>
    e instanceof TopicFlagError && /unknown topic prefix "symbol:"/.test(e.message) && /sym:.*i128:/.test(e.message));
  assert.throws(() => encodeTopicSegment('u32:five'), TopicFlagError);
  assert.throws(() => encodeTopicSegment('addr:nope'), TopicFlagError);
  assert.throws(() => encodeTopicSegment('bool:yes'), TopicFlagError);
});

// ── #129 several filters ─────────────────────────────────────────────────────

test('--topics adds ORed filters; repeated --topic stays one positional filter', () => {
  const filters = parseTopicFilters(undefined, ['sym:transfer,*', 'sym:mint,*']);
  assert.deepEqual(filters, [[encodeTopicSegment('sym:transfer'), '*'], [encodeTopicSegment('sym:mint'), '*']]);
  assert.deepEqual(parseTopicFilters(['sym:transfer', '*'], undefined), [[encodeTopicSegment('sym:transfer'), '*']]);
  // Both reach the RPC as separate topic filters on one event filter.
  const [filter] = buildFilters([SAC], filters);
  assert.equal(filter.topics.length, 2);
});

test('the RPC limits are enforced, naming the one hit', () => {
  const six = Array.from({ length: 6 }, (_, i) => `u32:${i}`);
  assert.throws(() => parseTopicFilters(undefined, six), /at most 5 topic filters per stream, got 6/);
  assert.throws(() => parseTopicFilters(['*', '*', '*', '*', '*'], undefined), /at most 4 segments per topic filter, got 5/);
  assert.throws(() => parseTopicFilters(undefined, ['sym:a,,*']), /empty segment/);
  assert.equal(parseTopicFilters(undefined, undefined), undefined);
});

// ── #136 4xx vs 5xx ──────────────────────────────────────────────────────────

const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { response: { status } });

test('a 401 and a 503 land in two different series', () => {
  assert.equal(classifyRpcError(httpError(401)).kind, 'http_4xx');
  assert.equal(classifyRpcError(httpError(503)).kind, 'http_5xx');
  const metrics = new IngestMetrics();
  metrics.rpcError('getEvents', httpError(401));
  metrics.rpcError('getEvents', httpError(503));
  const text = metrics.render();
  assert.match(text, /lens_rpc_errors_total\{method="getEvents",kind="http_4xx"\} 1\n/);
  assert.match(text, /lens_rpc_errors_total\{method="getEvents",kind="http_5xx"\} 1\n/);
});

// ── #134 measured lag ────────────────────────────────────────────────────────

test('lag is the age of the last event, to within a second', () => {
  const now = Date.parse('2026-11-21T12:00:00Z');
  const lag = ingestionLag(100, 160, '2026-11-21T11:58:20Z', now);
  assert.equal(lag.measuredLagSeconds, 100);
  assert.equal(lag.lagSeconds, 300, 'the estimate is still reported alongside');
});

test('an empty page still reports the estimate', () => {
  const lag = ingestionLag(0, 160, undefined, Date.now());
  assert.equal(lag.measuredLagSeconds, null);
  assert.equal(lag.lagSeconds, 800);
});
