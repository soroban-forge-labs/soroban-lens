import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteEventStore } from '@soroban-lens/store';
import { buildTailQuery, followEvents, formatEvent, TailUsageError, wantsColor } from '../dist/index.js';

// #86 lens tail. Everything runs against the committed fixture; nothing here
// needs the network.

const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const FIXTURE = fileURLToPath(new URL('../../../fixtures/testnet-events.json', import.meta.url));
const SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

const fixtureEvents = async () => JSON.parse(await readFile(FIXTURE, 'utf8')).events;

/**
 * The fixture split at a ledger, so a test can index the second half "live".
 * The cut is the last SAC transfer, so both halves are non-empty
 * and the live half always has something for a `-c SAC --topic transfer` tail.
 */
async function splitFixture() {
  const events = await fixtureEvents();
  const probe = new SqliteEventStore({ path: ':memory:' });
  await probe.insertEvents(events);
  const [last] = (await probe.queryEvents({ contractId: SAC, topics: ['transfer'], order: 'desc', limit: 1 })).events;
  await probe.close();
  // By id, not ledger: the fixture's SAC transfers all close in its first ledger.
  return { before: events.filter((e) => e.id < last.id), after: events.filter((e) => e.id >= last.id) };
}

// ── filters ──────────────────────────────────────────────────────────────────

test('flags map onto the same EventQuery the API builds', () => {
  const { query, fromStart } = buildTailQuery({
    contract: [SAC],
    topic: ['transfer', '*', 'GDVFO2G543H3RYG4H66OX36ESWAP6H5CHP2QN7E3D3CTYJBSNOJB5GSA'],
    successfulOnly: true,
  });
  assert.deepEqual(query, {
    contractId: SAC,
    topics: ['transfer', null, 'GDVFO2G543H3RYG4H66OX36ESWAP6H5CHP2QN7E3D3CTYJBSNOJB5GSA'],
    successfulOnly: true,
  });
  assert.equal(fromStart, false);
});

test('a lower bound means replay from history', () => {
  assert.equal(buildTailQuery({ fromLedger: '0' }).fromStart, true);
  const { query, fromStart } = buildTailQuery({ fromTime: '2026-01-01T00:00:00Z' });
  assert.equal(query.fromTime, 1767225600);
  assert.equal(fromStart, true);
});

test('filters the API would reject are rejected, not followed silently', () => {
  for (const flags of [
    { contract: ['not-a-contract'] },
    { contract: [SAC, SAC] },
    { topic: ['a', 'b', 'c', 'd', 'e'] },
    { address: 'GSHORT' },
    { txHash: 'abc' },
    { fromLedger: '-1' },
    { fromTime: 'yesterday-ish' },
  ]) {
    assert.throws(() => buildTailQuery(flags), TailUsageError, JSON.stringify(flags));
  }
});

// ── following ────────────────────────────────────────────────────────────────

test('starts at the present: only events indexed after it starts are delivered', async () => {
  const { before, after } = await splitFixture();
  assert.ok(before.length > 0 && after.length > 0);
  const store = new SqliteEventStore({ path: ':memory:' });
  await store.insertEvents(before);

  const controller = new AbortController();
  const seen = [];
  const following = followEvents({
    store,
    query: {},
    fromStart: false,
    pollIntervalMs: 10,
    signal: controller.signal,
    onEvent: (e) => seen.push(e.id),
  });

  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(seen, [], 'nothing already in the store is replayed');

  await store.insertEvents(after);
  const afterIds = new Set(after.map((e) => e.id));
  const expected = (await store.queryEvents({ order: 'asc', limit: 1000 })).events.map((e) => e.id).filter((id) => afterIds.has(id));
  while (seen.length < expected.length) await new Promise((r) => setTimeout(r, 10));
  controller.abort();
  await following;

  assert.deepEqual(seen, expected, 'every new event, once, in ledger order');
  await store.close();
});

test('a topic filter delivers only matching events, across batch boundaries', async () => {
  const store = new SqliteEventStore({ path: ':memory:' });
  await store.insertEvents(await fixtureEvents());
  const transfers = (await store.queryEvents({ topics: ['transfer'], order: 'asc', limit: 1000 })).events;
  assert.ok(transfers.length > 2, 'fixture has several transfers');

  const seen = [];
  const delivered = await followEvents({
    store,
    query: { topics: ['transfer'] },
    fromStart: true,
    batchSize: 2,
    maxEvents: transfers.length,
    onEvent: (e) => seen.push(e),
  });
  assert.equal(delivered, transfers.length);
  assert.deepEqual(seen.map((e) => e.id), transfers.map((e) => e.id));
  assert.ok(seen.every((e) => e.topics[0].value === 'transfer'));
  await store.close();
});

// ── output ───────────────────────────────────────────────────────────────────

test('the readable line leads with time, ledger, contract and event name', async () => {
  const store = new SqliteEventStore({ path: ':memory:' });
  await store.insertEvents(await fixtureEvents());
  const [event] = (await store.queryEvents({ contractId: SAC, topics: ['transfer'], order: 'asc', limit: 1 })).events;
  await store.close();

  const line = formatEvent(event, { color: false });
  assert.match(line, /^\d\d:\d\d:\d\d {2}L\d+ {2}CDLZ…GCYSC {2}transfer {2}GBYR…JQHHT {2}GDVF…B5GSA {2}"native" {2}= {2}11000000$/);
  assert.doesNotMatch(line, /\u001b\[/, 'no escape codes without colour');
  assert.match(formatEvent(event, { color: true }), /\u001b\[33mtransfer/);
});

test('colour follows NO_COLOR, FORCE_COLOR and the TTY', () => {
  assert.equal(wantsColor({ isTTY: true }, {}), true);
  assert.equal(wantsColor({ isTTY: false }, {}), false);
  assert.equal(wantsColor({ isTTY: true }, { NO_COLOR: '1' }), false);
  assert.equal(wantsColor({ isTTY: false }, { FORCE_COLOR: '1' }), true);
});

// ── the real binary ──────────────────────────────────────────────────────────

/** Spawn `lens tail`, resolving once `lines` lines of stdout have arrived (or it exits). */
function tail(args, lines) {
  const child = spawn('node', [BIN, 'tail', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    // --json asserts stderr is empty; node's own ExperimentalWarning for
    // node:sqlite is runtime noise, not the program's output.
    env: { ...process.env, NODE_OPTIONS: '--disable-warning=ExperimentalWarning' },
  });
  let stdout = '';
  let stderr = '';
  const done = new Promise((resolve) => {
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.split('\n').filter(Boolean).length >= lines) child.kill('SIGINT');
    });
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
  return { child, done };
}

test('done when: lens tail -c … --topic transfer --json prints matching events as they are indexed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-tail-'));
  const db = join(dir, 'lens.db');
  const { before, after } = await splitFixture();
  const writer = new SqliteEventStore({ path: db });
  await writer.insertEvents(before);

  const verify = new SqliteEventStore({ path: ':memory:' });
  await verify.insertEvents(after);
  const expected = (await verify.queryEvents({ contractId: SAC, topics: ['transfer'], order: 'asc', limit: 100 })).events;
  await verify.close();
  assert.ok(expected.length > 0, 'the "live" half of the fixture has SAC transfers');

  const { done } = tail(['--db', db, '-c', SAC, '--topic', 'transfer', '--json', '--poll-interval', '50'], expected.length);
  // Index the second half only once tail is up and positioned at the present.
  await new Promise((r) => setTimeout(r, 500));
  await writer.insertEvents(after);
  const { stdout } = await done;
  await writer.close();

  // Every line is a complete event — exactly what `| jq` needs.
  const parsed = stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(parsed.map((e) => e.id), expected.map((e) => e.id));
  assert.ok(parsed.every((e) => e.contractId === SAC && e.topics[0].value === 'transfer'));
  await rm(dir, { recursive: true, force: true });
});

test('--max-events stops on its own, and --json keeps stderr chatter out of stdout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-tail-'));
  const db = join(dir, 'lens.db');
  const store = new SqliteEventStore({ path: db });
  await store.insertEvents(await fixtureEvents());
  await store.close();

  const { done } = tail(['--db', db, '--from-ledger', '0', '--max-events', '3', '--json'], Infinity);
  const { code, stdout, stderr } = await done;
  assert.equal(code, 0, stderr);
  assert.equal(stdout.trim().split('\n').length, 3);
  assert.equal(stderr, '');
  await rm(dir, { recursive: true, force: true });
});

test('a missing database is an error, not an empty database followed forever', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-tail-'));
  const { done } = tail(['--db', join(dir, 'missing.db')], Infinity);
  const { code, stderr } = await done;
  assert.equal(code, 1);
  assert.match(stderr, /no database at/);
  await rm(dir, { recursive: true, force: true });
});

test('a bad filter exits 2 with the reason', async () => {
  const { done } = tail(['-c', 'nope'], Infinity);
  const { code, stderr } = await done;
  assert.equal(code, 2);
  assert.match(stderr, /not a contract id/);
});
