/**
 * Unit tests for loadContractIdsFromFile() and ContractFileParseError.
 * Issue #141 — Load contract ids from a file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadContractIdsFromFile, ContractFileParseError } from '../dist/index.js';

// 22 valid synthetic contract ids (C + 55 base32 chars).
const IDS = [
  'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB',
  'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC',
  'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD',
  'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE',
  'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAF',
  'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAG',
  'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH',
  'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAI',
  'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJ',
  'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK',
  'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAL',
  'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM',
  'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAN',
  'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAO',
  'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP',
  'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQ',
  'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAR',
  'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAS',
  'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAT',
];
const SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

let tmpDir;
test.before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'lens-cid-'));
});
test.after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── happy path ───────────────────────────────────────────────────────────────

test('loadContractIdsFromFile: reads a simple list of ids', async () => {
  const path = join(tmpDir, 'simple.txt');
  await writeFile(path, `${IDS[0]}\n${IDS[1]}\n${IDS[2]}\n`);
  const result = await loadContractIdsFromFile(path);
  assert.deepEqual(result, [IDS[0], IDS[1], IDS[2]]);
});

test('loadContractIdsFromFile: skips blank lines and # comments', async () => {
  const path = join(tmpDir, 'comments.txt');
  const content = [
    '# This is a header comment',
    '',
    IDS[0],
    '',
    '  # indented comment',
    IDS[1],
    '# trailing comment',
    '',
  ].join('\n');
  await writeFile(path, content);
  const result = await loadContractIdsFromFile(path);
  assert.deepEqual(result, [IDS[0], IDS[1]]);
});

test('loadContractIdsFromFile: 20-id file with comments loads all ids', async () => {
  const path = join(tmpDir, 'twenty.txt');
  const lines = [
    '# soroban-lens contracts file',
    '# generated for testing',
    '',
    ...IDS, // 20 ids
    '',
    '# end of file',
  ];
  await writeFile(path, lines.join('\n'));
  const result = await loadContractIdsFromFile(path);
  assert.equal(result.length, 20);
  assert.deepEqual(result, IDS);
});

test('loadContractIdsFromFile: duplicate ids are silently dropped', async () => {
  const path = join(tmpDir, 'dupes.txt');
  await writeFile(path, `${IDS[0]}\n${IDS[1]}\n${IDS[0]}\n${IDS[2]}\n${IDS[1]}\n`);
  const result = await loadContractIdsFromFile(path);
  assert.deepEqual(result, [IDS[0], IDS[1], IDS[2]]);
});

test('loadContractIdsFromFile: returns empty array for a file with only comments/blanks', async () => {
  const path = join(tmpDir, 'empty.txt');
  await writeFile(path, '# nothing here\n\n  \n');
  const result = await loadContractIdsFromFile(path);
  assert.deepEqual(result, []);
});

test('loadContractIdsFromFile: real SAC contract id is accepted', async () => {
  const path = join(tmpDir, 'sac.txt');
  await writeFile(path, `# native XLM SAC\n${SAC}\n`);
  const result = await loadContractIdsFromFile(path);
  assert.deepEqual(result, [SAC]);
});

test('loadContractIdsFromFile: preserves insertion order', async () => {
  const path = join(tmpDir, 'order.txt');
  const ordered = [IDS[4], IDS[2], IDS[9], IDS[0]];
  await writeFile(path, ordered.join('\n'));
  const result = await loadContractIdsFromFile(path);
  assert.deepEqual(result, ordered);
});

// ── error: missing file ──────────────────────────────────────────────────────

test('loadContractIdsFromFile: missing file throws ContractFileParseError', async () => {
  const path = join(tmpDir, 'does-not-exist.txt');
  await assert.rejects(
    () => loadContractIdsFromFile(path),
    (error) => {
      assert.ok(error instanceof ContractFileParseError, `expected ContractFileParseError, got ${error.constructor.name}`);
      assert.match(error.message, /could not read/);
      assert.match(error.message, /does-not-exist/);
      return true;
    },
  );
});

// ── error: bad id with line number ───────────────────────────────────────────

test('loadContractIdsFromFile: bad id reports its 1-based line number', async () => {
  const path = join(tmpDir, 'bad-id.txt');
  await writeFile(path, `${IDS[0]}\n# comment\n\nnot-a-contract-id\n${IDS[1]}\n`);
  await assert.rejects(
    () => loadContractIdsFromFile(path),
    (error) => {
      assert.ok(error instanceof ContractFileParseError, `expected ContractFileParseError, got ${error.constructor.name}`);
      // The bad id is on line 4 (1=id, 2=comment, 3=blank, 4=bad)
      assert.equal(error.line, 4);
      assert.match(error.message, /line 4/);
      assert.match(error.message, /not-a-contract-id/);
      return true;
    },
  );
});

test('loadContractIdsFromFile: account id (G...) on line 1 reports line 1', async () => {
  const path = join(tmpDir, 'account-id.txt');
  const accountId = 'GBQHHOH72M522QBF7SMY57JH6FIN7YKTZUWSO4S5IFBXV3B7FI2UQLIQ';
  await writeFile(path, `${accountId}\n`);
  await assert.rejects(
    () => loadContractIdsFromFile(path),
    (error) => {
      assert.ok(error instanceof ContractFileParseError);
      assert.equal(error.line, 1);
      assert.match(error.message, /line 1/);
      assert.match(error.message, /Account ids start with 'G'/);
      return true;
    },
  );
});

test('loadContractIdsFromFile: bad id on first line reports line 1', async () => {
  const path = join(tmpDir, 'bad-first.txt');
  await writeFile(path, `NOTACONTRACT\n${IDS[0]}\n`);
  await assert.rejects(
    () => loadContractIdsFromFile(path),
    (error) => {
      assert.ok(error instanceof ContractFileParseError);
      assert.equal(error.line, 1);
      return true;
    },
  );
});

test('ContractFileParseError: name is ContractFileParseError', () => {
  const err = new ContractFileParseError('test', 5);
  assert.equal(err.name, 'ContractFileParseError');
  assert.equal(err.line, 5);
  assert.ok(err instanceof Error);
});

test('ContractFileParseError: line is undefined when not provided', () => {
  const err = new ContractFileParseError('I/O error');
  assert.equal(err.line, undefined);
});
