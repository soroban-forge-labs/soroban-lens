import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
