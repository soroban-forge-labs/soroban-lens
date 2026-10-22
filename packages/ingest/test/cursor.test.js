import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileCursorStore, MemoryCursorStore, defaultCursorKey } from '../dist/index.js';

const state = (cursor, ledger) => ({ cursor, ledger, updatedAt: new Date().toISOString() });

test('MemoryCursorStore round-trips and clears', async () => {
  const store = new MemoryCursorStore();
  assert.equal(await store.load('k'), null);
  await store.save('k', state('abc', 42));
  assert.equal((await store.load('k')).cursor, 'abc');
  await store.clear('k');
  assert.equal(await store.load('k'), null);
});

test('FileCursorStore persists across instances', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-cursor-'));
  await new FileCursorStore(dir).save('testnet-abc', state('0020166232959352832-0000000000', 4695317));
  const reloaded = await new FileCursorStore(dir).load('testnet-abc');
  assert.equal(reloaded.cursor, '0020166232959352832-0000000000');
  assert.equal(reloaded.ledger, 4695317);
});

test('FileCursorStore round-trips the retention window saved with the position', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-cursor-'));
  const retention = { latestLedger: 4697317, oldestLedger: 4576358 };
  await new FileCursorStore(dir).save('k', { ...state('abc', 4695317), retention });
  const reloaded = await new FileCursorStore(dir).load('k');
  assert.deepEqual(reloaded.retention, retention);
});

test('FileCursorStore drops a malformed retention snapshot instead of failing the resume', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-cursor-'));
  await writeFile(
    join(dir, 'k.cursor.json'),
    JSON.stringify({
      cursor: 'abc',
      ledger: 4695317,
      updatedAt: '2026-10-01T00:00:00Z',
      retention: { latestLedger: 'nope', oldestLedger: 5 },
    }),
  );
  const loaded = await new FileCursorStore(dir).load('k');
  assert.equal(loaded.cursor, 'abc');
  assert.equal(loaded.retention, undefined, 'a corrupt snapshot costs the comparison, not the cursor');
});

// The window can only be trusted when it reads as a real range: oldest above
// latest is the shape a truncated write leaves behind.
test('FileCursorStore drops an inverted retention window', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-cursor-'));
  await writeFile(
    join(dir, 'k.cursor.json'),
    JSON.stringify({
      cursor: 'abc', ledger: 4695317, updatedAt: '',
      retention: { latestLedger: 10, oldestLedger: 20 },
    }),
  );
  assert.equal((await new FileCursorStore(dir).load('k')).retention, undefined);
});

test('FileCursorStore returns null for a missing key rather than throwing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-cursor-'));
  assert.equal(await new FileCursorStore(dir).load('never-written'), null);
});

test('FileCursorStore treats a cleared or empty file as no cursor', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-cursor-'));
  const store = new FileCursorStore(dir);
  await store.save('k', state('abc', 1));
  await store.clear('k');
  assert.equal(await store.load('k'), null);
  await assert.rejects(readFile(join(dir, 'k.cursor.json'), 'utf8'), { code: 'ENOENT' });
});

test('FileCursorStore removes orphaned temp files when constructed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-cursor-'));
  const tempName = 'k.cursor.json.999999999.tmp';
  await writeFile(join(dir, tempName), 'partial', 'utf8');

  const store = new FileCursorStore(dir);
  assert.equal(await store.load('k'), null);
  assert.ok(!(await readdir(dir)).includes(tempName));
});

test('FileCursorStore sanitises keys into safe filenames', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-cursor-'));
  const store = new FileCursorStore(dir);
  await store.save('https://host/../evil', state('x', 1));
  const written = await readFile(join(dir, 'https___host_.._evil.cursor.json'), 'utf8');
  assert.match(written, /"cursor": "x"/);
});

test('defaultCursorKey is stable regardless of contract order', () => {
  const a = defaultCursorKey('https://soroban-testnet.stellar.org', ['CB', 'CA']);
  const b = defaultCursorKey('https://soroban-testnet.stellar.org', ['CA', 'CB']);
  assert.equal(a, b);
  assert.match(a, /^soroban-testnet\.stellar\.org-[0-9a-f]{8}$/);
});

test('defaultCursorKey separates different networks and contract sets', () => {
  const testnet = defaultCursorKey('https://soroban-testnet.stellar.org', ['CA']);
  const mainnet = defaultCursorKey('https://mainnet.sorobanrpc.com', ['CA']);
  const other = defaultCursorKey('https://soroban-testnet.stellar.org', ['CZ']);
  assert.notEqual(testnet, mainnet);
  assert.notEqual(testnet, other);
});
