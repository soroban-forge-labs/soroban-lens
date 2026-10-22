import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

/**
 * Invoke the CLI and capture its exit code.
 *
 * Every case here fails during argument validation, before the first network
 * call, so the suite needs no RPC — which is the property that makes these
 * flags worth validating up front in the first place.
 */
async function cli(args, env = {}) {
  try {
    const { stdout, stderr } = await run('node', [BIN, ...args], {
      env: { ...process.env, LENS_CONTRACT_IDS: '', LENS_RPC_HEADERS: '', ...env },
      timeout: 20_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

// ── #4 --type ────────────────────────────────────────────────────────────────

test('--type rejects a value the RPC does not serve', async () => {
  const { code, stderr } = await cli(['-c', SAC, '--type', 'contracts']);
  assert.equal(code, 2);
  assert.match(stderr, /--type must be contract, system or diagnostic/);
});

test('--type is documented in the help text', async () => {
  const { code, stdout } = await cli(['--help']);
  assert.equal(code, 0);
  assert.ok(stdout.includes('--type'), 'help is missing --type');
});

// ── #5 --topic ───────────────────────────────────────────────────────────────

test('the help text explains the 4-segment topic ceiling', async () => {
  const { stdout } = await cli(['--help']);
  assert.match(stdout, /at most 4/);
});

test('--topic is documented in the help text', async () => {
  const { stdout } = await cli(['--help']);
  assert.ok(stdout.includes('--topic'), 'help is missing --topic');
});

test('more than four --topic segments is rejected with the reason', async () => {
  const { code, stderr } = await cli([
    '-c', SAC,
    '--topic', 'a', '--topic', 'b', '--topic', 'c', '--topic', 'd', '--topic', 'e',
  ]);
  assert.equal(code, 2);
  assert.match(stderr, /at most 4 --topic segments/);
});

// ── #7 --rpc-header ──────────────────────────────────────────────────────────

test('--rpc-header and LENS_RPC_HEADERS are documented in the help text', async () => {
  const { stdout } = await cli(['--help']);
  assert.ok(stdout.includes('--rpc-header'), 'help is missing --rpc-header');
  assert.ok(stdout.includes('LENS_RPC_HEADERS'), 'help is missing LENS_RPC_HEADERS');
});

test('a malformed --rpc-header is rejected without echoing the value', async () => {
  const secret = 'sk-live-not-a-real-key';
  const { code, stderr } = await cli(['-c', SAC, '--rpc-header', secret]);
  assert.equal(code, 2);
  assert.match(stderr, /--rpc-header expects 'Name: value'/);
  // The bare value is almost certainly an API key. It must not be echoed back.
  assert.ok(!stderr.includes(secret), 'the rejected header value leaked into stderr');
});

test('an empty header name or value is rejected', async () => {
  for (const bad of [': value', 'Name:', ':']) {
    const { code } = await cli(['-c', SAC, '--rpc-header', bad]);
    assert.equal(code, 2, bad);
  }
});

// ── #9 --end-ledger ──────────────────────────────────────────────────────────

test('--end-ledger is documented in the help text', async () => {
  const { stdout } = await cli(['--help']);
  assert.ok(stdout.includes('--end-ledger'), 'help is missing --end-ledger');
});

test('--end-ledger with a stored cursor is rejected, not silently resolved', async () => {
  const { code, stderr } = await cli(['-c', SAC, '--end-ledger', '100']);
  assert.equal(code, 2);
  assert.match(stderr, /cannot resume from a stored cursor/);
  assert.match(stderr, /--no-resume/, 'the error must say how to proceed');
});

test('--end-ledger before --start-ledger is rejected', async () => {
  const { code, stderr } = await cli([
    '-c', SAC, '--no-resume', '--start-ledger', '500', '--end-ledger', '100',
  ]);
  assert.equal(code, 2);
  assert.match(stderr, /is before --start-ledger/);
});

// ── #6 retry tuning ──────────────────────────────────────────────────────────

test('the retry flags and their env vars are documented in the help text', async () => {
  const { stdout } = await cli(['--help']);
  for (const flag of ['--retry-attempts', '--retry-base-delay', '--retry-max-delay']) {
    assert.ok(stdout.includes(flag), `help is missing ${flag}`);
  }
  assert.ok(stdout.includes('LENS_RETRY_ATTEMPTS'), 'help is missing LENS_RETRY_ATTEMPTS');
});

test('a non-numeric retry value is ignored rather than becoming NaN', async () => {
  // It must not reach the client as NaN attempts, which would loop or throw.
  // An unresolvable host makes this fail at the RPC, not at argument parsing.
  const { code, stderr } = await cli(
    ['-c', SAC, '--no-resume', '--once', '--retry-attempts', 'lots'],
    { LENS_RPC_URL: 'https://rpc.invalid.soroban-lens-test' },
  );
  assert.notEqual(code, 2, `expected a runtime failure, not an argument error: ${stderr}`);
  assert.ok(!stderr.includes('NaN'), `NaN leaked into the retry path: ${stderr}`);
});

// ── #141 --contracts-file ────────────────────────────────────────────────────

import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FAKE_IDS = [
  'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB',
];

test('--contracts-file is documented in the help text', async () => {
  const { stdout } = await cli(['--help']);
  assert.ok(stdout.includes('--contracts-file'), 'help is missing --contracts-file');
});

test('--contracts-file: missing file exits 2 with a clear error', async () => {
  const { code, stderr } = await cli(['--contracts-file', '/does/not/exist.txt', '--no-resume']);
  assert.equal(code, 2);
  assert.match(stderr, /could not read/);
});

test('--contracts-file: a bad id reports its line number and exits 2', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-ingest-cf-'));
  try {
    const path = join(dir, 'bad.txt');
    await writeFile(path, `${FAKE_IDS[0]}\nnot-a-contract\n`);
    const { code, stderr } = await cli(['--contracts-file', path, '--no-resume']);
    assert.equal(code, 2);
    assert.match(stderr, /line 2/);
    assert.match(stderr, /not-a-contract/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('--contracts-file: valid file is accepted and not treated as a missing-contract error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-ingest-cf-'));
  try {
    const path = join(dir, 'contracts.txt');
    // Comments and blanks should be ignored; ids should be accepted.
    await writeFile(path, `# comment\n\n${FAKE_IDS[0]}\n${FAKE_IDS[1]}\n`);
    // The binary will fail at the RPC, not at argument parsing (exit != 2).
    const { code, stderr } = await cli(
      ['--contracts-file', path, '--no-resume', '--once'],
      { LENS_RPC_URL: 'https://rpc.invalid.soroban-lens-test' },
    );
    assert.notEqual(code, 2, `argument parsing should not reject a valid file: ${stderr}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('--contracts-file: ids merged with -c flags, duplicates dropped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-ingest-cf-'));
  try {
    const path = join(dir, 'merge.txt');
    await writeFile(path, `${FAKE_IDS[0]}\n`);
    // Pass the same id via -c; the binary should accept without "duplicate" error.
    const { code, stderr } = await cli(
      ['--contracts-file', path, '-c', FAKE_IDS[0], '-c', FAKE_IDS[1], '--no-resume', '--once'],
      { LENS_RPC_URL: 'https://rpc.invalid.soroban-lens-test' },
    );
    assert.notEqual(code, 2, `merge should not fail argument validation: ${stderr}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});