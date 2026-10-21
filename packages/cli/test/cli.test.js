import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteEventStore } from '@soroban-lens/store';
import {
  resolveConfig,
  splitList,
  runDoctor,
  formatReport,
  redactHeaders,
  StoreBackedCursors,
} from '../dist/index.js';

const SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
/** A host that cannot resolve, so the RPC check fails fast on or offline. */
const DEAD_RPC = 'https://rpc.invalid.soroban-lens-test';

const find = (results, name) => results.find((r) => r.name === name);

test('config falls back to documented defaults', () => {
  const config = resolveConfig({}, {});
  assert.equal(config.network.name, 'testnet');
  assert.equal(config.network.rpcUrl, 'https://soroban-testnet.stellar.org');
  assert.equal(config.dbPath, './data/lens.db');
  assert.equal(config.apiPort, 8080);
  assert.equal(config.pageSize, 200);
  assert.equal(config.pollIntervalMs, 2000);
  assert.deepEqual(config.contractIds, []);
  assert.equal(config.startLedger, undefined);
});

test('environment overrides defaults', () => {
  const config = resolveConfig({}, {
    LENS_NETWORK: 'futurenet',
    LENS_DB_PATH: '/data/x.db',
    LENS_API_PORT: '9000',
    LENS_CONTRACT_IDS: `${SAC}, ${SAC}`,
    LENS_START_LEDGER: '4695317',
  });
  assert.equal(config.network.name, 'futurenet');
  assert.equal(config.dbPath, '/data/x.db');
  assert.equal(config.apiPort, 9000);
  assert.equal(config.contractIds.length, 2);
  assert.equal(config.startLedger, 4695317);
});

test('flags override environment', () => {
  const config = resolveConfig(
    { network: 'testnet', db: '/flag.db', port: 1234, contracts: [SAC] },
    { LENS_NETWORK: 'mainnet', LENS_DB_PATH: '/env.db', LENS_API_PORT: '9999', LENS_CONTRACT_IDS: 'CENV' },
  );
  assert.equal(config.network.name, 'testnet');
  assert.equal(config.dbPath, '/flag.db');
  assert.equal(config.apiPort, 1234);
  assert.deepEqual(config.contractIds, [SAC]);
});

test('an explicit rpc-url wins over the network preset', () => {
  const config = resolveConfig({ rpcUrl: 'http://localhost:8000/rpc' }, { LENS_NETWORK: 'mainnet' });
  assert.equal(config.network.rpcUrl, 'http://localhost:8000/rpc');
  assert.equal(config.network.name, 'mainnet', 'the passphrase must still come from the preset');
});

test('non-numeric env values fall back instead of becoming NaN', () => {
  const config = resolveConfig({}, { LENS_API_PORT: 'eighty', LENS_PAGE_SIZE: '', LENS_START_LEDGER: 'soon' });
  assert.equal(config.apiPort, 8080);
  assert.equal(config.pageSize, 200);
  assert.equal(config.startLedger, undefined);
});

test('splitList trims and drops empty entries', () => {
  assert.deepEqual(splitList(' A , B ,, C '), ['A', 'B', 'C']);
  assert.deepEqual(splitList(undefined), []);
  assert.deepEqual(splitList(''), []);
});

test('doctor passes the local checks on a writable directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-doctor-'));
  const config = resolveConfig({ dataDir: dir, db: join(dir, 'lens.db'), rpcUrl: DEAD_RPC, contracts: [SAC] }, {});
  const results = await runDoctor(config);

  assert.equal(find(results, 'Node.js version').status, 'pass');
  assert.equal(find(results, 'Data directory').status, 'pass');
  assert.equal(find(results, 'Database').status, 'pass');
  assert.equal(find(results, 'Contract IDs').status, 'pass');
});

test('doctor fails when the RPC endpoint is unreachable, and says what to do', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-doctor-'));
  const config = resolveConfig({ dataDir: dir, db: join(dir, 'lens.db'), rpcUrl: DEAD_RPC, contracts: [SAC] }, {});
  const rpc = find(await runDoctor(config), 'Soroban RPC');
  assert.equal(rpc.status, 'fail');
  assert.match(rpc.fix, /LENS_RPC_URL/);
});

test('doctor rejects an account id given where a contract id belongs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-doctor-'));
  const account = 'GBQHHOH72M522QBF7SMY57JH6FIN7YKTZUWSO4S5IFBXV3B7FI2UQLIQ';
  const config = resolveConfig({ dataDir: dir, db: join(dir, 'lens.db'), rpcUrl: DEAD_RPC, contracts: [account] }, {});
  const check = find(await runDoctor(config), 'Contract IDs');
  assert.equal(check.status, 'fail');
  assert.match(check.fix, /Account ids start with 'G'/);
});

test('doctor warns, but does not fail, when no contract is configured', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-doctor-'));
  const config = resolveConfig({ dataDir: dir, db: join(dir, 'lens.db'), rpcUrl: DEAD_RPC }, {});
  const check = find(await runDoctor(config), 'Contract IDs');
  assert.equal(check.status, 'warn');
  assert.match(check.detail, /every contract/);
});

test('doctor fails on a read-only data directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-doctor-ro-'));
  const readOnly = join(dir, 'locked');
  const config = resolveConfig({ dataDir: readOnly, db: join(dir, 'lens.db'), rpcUrl: DEAD_RPC }, {});
  await (await import('node:fs/promises')).mkdir(readOnly);
  await chmod(readOnly, 0o500);
  try {
    const check = find(await runDoctor(config), 'Data directory');
    assert.equal(check.status, 'fail');
    assert.match(check.fix, /writable/);
  } finally {
    await chmod(readOnly, 0o700);
  }
});

test('formatReport exits non-zero only when a check failed', () => {
  const pass = formatReport([{ name: 'A', status: 'pass', detail: 'ok' }]);
  assert.equal(pass.exitCode, 0);
  assert.match(pass.text, /All checks passed/);

  const warn = formatReport([{ name: 'A', status: 'warn', detail: 'hmm', fix: 'do this' }]);
  assert.equal(warn.exitCode, 0, 'a warning is not a failure');
  assert.match(warn.text, /1 warning/);

  const fail = formatReport([{ name: 'A', status: 'fail', detail: 'bad', fix: 'do that' }]);
  assert.equal(fail.exitCode, 1);
  assert.match(fail.text, /1 check\(s\) failed/);
  assert.match(fail.text, /do that/, 'the fix hint must reach the operator');
});

test('StoreBackedCursors keeps resume state in the events database', async () => {
  const store = new SqliteEventStore({ path: ':memory:' });
  const cursors = new StoreBackedCursors(store);

  assert.equal(await cursors.load('k'), null);
  await cursors.save('k', { cursor: 'c1', ledger: 4695317, updatedAt: '2026-09-15T19:00:00Z' });

  const loaded = await cursors.load('k');
  assert.equal(loaded.cursor, 'c1');
  assert.equal(loaded.ledger, 4695317);

  // The same state is visible through the store, which is what /status serves.
  assert.equal((await store.listStreamStates())[0].ledger, 4695317);

  await cursors.clear('k');
  assert.equal(await cursors.load('k'), null, 'a cleared cursor must read back as absent');
  await store.close();
});

// ── #6 retry tuning ──────────────────────────────────────────────────────────

test('retry tuning falls back to the documented defaults', () => {
  const config = resolveConfig({}, {});
  assert.deepEqual(config.retry, { attempts: 5, baseDelayMs: 250, maxDelayMs: 30_000 });
});

test('retry tuning comes from the environment and flags beat it', () => {
  const env = {
    LENS_RETRY_ATTEMPTS: '9',
    LENS_RETRY_BASE_DELAY_MS: '100',
    LENS_RETRY_MAX_DELAY_MS: '5000',
  };
  assert.deepEqual(resolveConfig({}, env).retry, {
    attempts: 9,
    baseDelayMs: 100,
    maxDelayMs: 5000,
  });
  assert.equal(resolveConfig({ retryAttempts: 2 }, env).retry.attempts, 2);
});

test('a non-numeric retry value falls back rather than becoming NaN', () => {
  const config = resolveConfig({}, { LENS_RETRY_ATTEMPTS: 'lots' });
  assert.equal(config.retry.attempts, 5);
});

// ── #7 RPC headers ───────────────────────────────────────────────────────────

test('RPC headers are parsed from flags and the environment', () => {
  const config = resolveConfig(
    { rpcHeaders: ['X-Api-Key: flag-value'] },
    { LENS_RPC_HEADERS: 'Authorization: Bearer env-token' },
  );
  assert.deepEqual(config.rpcHeaders, {
    Authorization: 'Bearer env-token',
    'X-Api-Key': 'flag-value',
  });
});

test('a header value containing a colon survives intact', () => {
  // "Bearer a:b" and any URL-valued header would break on a naive split(':').
  const config = resolveConfig({ rpcHeaders: ['X-Origin: https://rpc.example.com:8000'] }, {});
  assert.equal(config.rpcHeaders['X-Origin'], 'https://rpc.example.com:8000');
});

test('a malformed header is skipped rather than crashing doctor', () => {
  const config = resolveConfig({ rpcHeaders: ['no-colon-here', 'Good: value'] }, {});
  assert.deepEqual(config.rpcHeaders, { Good: 'value' });
});

test('redactHeaders never reveals a value', () => {
  const secret = 'Bearer sk-live-do-not-log-me';
  const rendered = redactHeaders({ Authorization: secret, 'X-Api-Key': 'another-secret' });
  assert.ok(!rendered.includes(secret));
  assert.ok(!rendered.includes('another-secret'));
  // The names are the debugging value and are safe to show.
  assert.match(rendered, /Authorization: <redacted>/);
  assert.match(rendered, /X-Api-Key: <redacted>/);
  assert.equal(redactHeaders({}), 'none');
});

test('doctor reports header names without their values', async () => {
  const secret = 'Bearer sk-live-do-not-log-me';
  const config = resolveConfig(
    { rpcHeaders: [`Authorization: ${secret}`], db: ':memory:', dataDir: tmpdir() },
    { LENS_RPC_URL: 'https://rpc.invalid.soroban-lens-test' },
  );
  const { text } = formatReport(await runDoctor(config));

  assert.ok(!text.includes(secret), 'doctor leaked a header value into its report');
  assert.match(text, /RPC headers/);
  assert.match(text, /Authorization: <redacted>/);
});

// ── #21 lens prune ───────────────────────────────────────────────────────────

test('prune removes rows below the ledger and shrinks the database', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-prune-'));
  const dbPath = join(dir, 'lens.db');
  const store = new SqliteEventStore({ path: dbPath });
  const many = Array.from({ length: 8000 }, (_, i) => ({
    id: `p-${String(i).padStart(6, '0')}`,
    type: 'contract',
    ledger: 1000 + i,
    ledgerClosedAt: '2026-01-01T00:00:00Z',
    contractId: SAC,
    topic: ['AAAADwAAAAh0cmFuc2Zlcg=='],
    value: 'AAAACgAAAAAAAAAAAAAAAAAAAGQ=',
    txHash: 'a'.repeat(64),
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
  }));
  await store.insertEvents(many);
  const before = await store.getStats();
  const removed = await store.pruneBefore(8900);
  const after = await store.getStats();
  await store.close();

  assert.equal(removed, 7900);
  assert.equal(after.eventCount, 100);
  assert.ok(after.sizeBytes < before.sizeBytes);
  await rm(dir, { recursive: true, force: true });
});

/** A fake RPC answering getHealth and getLatestLedger, the two calls doctor makes. */
async function fakeRpc(closeTimeSeconds) {
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const { method, id } = JSON.parse(body);
    response.setHeader('content-type', 'application/json');
    const result =
      method === 'getHealth'
        ? { status: 'healthy', latestLedger: 500, oldestLedger: 100, ledgerRetentionWindow: 400 }
        : { id: 'x', sequence: 500, protocolVersion: 23, closeTime: String(closeTimeSeconds) };
    response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

test('doctor reports clock skew beyond the threshold as a warning, not a failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-doctor-skew-'));
  // A ledger that "closed" two hours ago: the local clock is two hours ahead.
  const rpc = await fakeRpc(Math.floor(Date.now() / 1000) - 7200);
  try {
    const config = resolveConfig({ dataDir: dir, db: join(dir, 'lens.db'), rpcUrl: rpc.url, contracts: [SAC] }, {});
    const results = await runDoctor(config);

    const skew = find(results, 'Clock skew');
    assert.equal(skew.status, 'warn');
    assert.match(skew.detail, /ahead of ledger 500/);
    assert.match(skew.fix, /NTP/);
    assert.match(skew.fix, /LENS_CLOCK_SKEW_THRESHOLD_SECONDS/);

    const { text, exitCode } = formatReport(results);
    assert.match(text, /Clock skew/);
    assert.equal(exitCode, 0, 'skew is a warning: it must not fail the preflight');
  } finally {
    await rpc.close();
  }
});

test('doctor passes the clock check when local time is close to the ledger close time', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-doctor-skew-'));
  const rpc = await fakeRpc(Math.floor(Date.now() / 1000) - 3);
  try {
    const config = resolveConfig({ dataDir: dir, db: join(dir, 'lens.db'), rpcUrl: rpc.url, contracts: [SAC] }, {});
    assert.equal(find(await runDoctor(config), 'Clock skew').status, 'pass');
  } finally {
    await rpc.close();
  }
});

test('LENS_CLOCK_SKEW_THRESHOLD_SECONDS moves the threshold', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-doctor-skew-'));
  const rpc = await fakeRpc(Math.floor(Date.now() / 1000) - 120);
  try {
    const overrides = { dataDir: dir, db: join(dir, 'lens.db'), rpcUrl: rpc.url, contracts: [SAC] };
    const strict = resolveConfig(overrides, {});
    assert.equal(find(await runDoctor(strict), 'Clock skew').status, 'warn');

    const lenient = resolveConfig(overrides, { LENS_CLOCK_SKEW_THRESHOLD_SECONDS: '600' });
    assert.equal(lenient.clockSkewThresholdSeconds, 600);
    assert.equal(find(await runDoctor(lenient), 'Clock skew').status, 'pass');
  } finally {
    await rpc.close();
  }
});

test('doctor warns that skew could not be measured when the RPC is unreachable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-doctor-skew-'));
  const config = resolveConfig({ dataDir: dir, db: join(dir, 'lens.db'), rpcUrl: DEAD_RPC, contracts: [SAC] }, {});
  const skew = find(await runDoctor(config), 'Clock skew');
  assert.equal(skew.status, 'warn');
  assert.match(skew.detail, /could not read/);
});


// ── #141 --contracts-file ────────────────────────────────────────────────────

import { loadContractIdsFromFile, ContractFileParseError } from '@soroban-lens/ingest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const runFile = promisify(execFile);
const CLI_BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const REPO_ROOT_CF = fileURLToPath(new URL('../../../', import.meta.url));

/** Run the lens binary as a real subprocess (same helper pattern as bin.test.js). */
async function runLens(args, options = {}) {
  try {
    const { stdout, stderr } = await runFile(process.execPath, [CLI_BIN, ...args], {
      timeout: 20_000,
      cwd: REPO_ROOT_CF,
      ...options,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

const SAC2 = 'CBIELTK6YBZJU5UP2WWQEQDYCUHCC2MUNSSSEKQ7QHFLC3WFG2UOEFMK';

test('loadContractIdsFromFile: happy path — loads ids and skips comments and blanks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-cf-'));
  const file = join(dir, 'contracts.txt');
  await writeFile(file, [
    '# This is a comment',
    '',
    SAC,
    '  # indented comment',
    '  ',
    SAC2,
    '',
  ].join('\n'));

  const ids = await loadContractIdsFromFile(file);
  assert.deepEqual(ids, [SAC, SAC2]);
  await rm(dir, { recursive: true, force: true });
});

test('loadContractIdsFromFile: deduplicates silently', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-cf-'));
  const file = join(dir, 'contracts.txt');
  await writeFile(file, [SAC, SAC, SAC2].join('\n'));

  const ids = await loadContractIdsFromFile(file);
  assert.deepEqual(ids, [SAC, SAC2]);
  await rm(dir, { recursive: true, force: true });
});

test('loadContractIdsFromFile: throws ContractFileParseError with line number for a bad id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-cf-'));
  const file = join(dir, 'contracts.txt');
  await writeFile(file, [
    '# good comment',
    SAC,
    'NOT_A_CONTRACT_ID',
    SAC2,
  ].join('\n'));

  await assert.rejects(
    () => loadContractIdsFromFile(file),
    (err) => {
      assert.ok(err instanceof ContractFileParseError, 'should be ContractFileParseError');
      assert.equal(err.line, 3, 'line number must be 1-based');
      assert.equal(err.value, 'NOT_A_CONTRACT_ID');
      assert.match(err.message, /:3:/);
      assert.match(err.message, /NOT_A_CONTRACT_ID/);
      return true;
    },
  );
  await rm(dir, { recursive: true, force: true });
});

test('loadContractIdsFromFile: throws with message for a missing file', async () => {
  await assert.rejects(
    () => loadContractIdsFromFile('/tmp/this-file-does-not-exist-lens-141.txt'),
    (err) => {
      assert.match(err.message, /cannot read contracts file/);
      return true;
    },
  );
});

test('loadContractIdsFromFile: handles a 20-id file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-cf-'));
  const file = join(dir, 'contracts.txt');
  // Generate 20 syntactically valid contract StrKeys by varying the suffix.
  // Valid base32 chars for StrKey are A-Z and 2-7 only (no 0, 1, 8, 9).
  // Use letters only to stay well within the alphabet.
  const SUFFIXES = [
    'AA', 'AB', 'AC', 'AD', 'AE', 'AF', 'AG', 'AH', 'AI', 'AJ',
    'AK', 'AL', 'AM', 'AN', 'AO', 'AP', 'AQ', 'AR', 'AS', 'AT',
  ];
  const ids20 = SUFFIXES.map((s) => 'C' + ('A'.repeat(53) + s).slice(0, 55));
  await writeFile(file, [
    '# 20 contracts',
    '',
    ...ids20,
    '',
    '# end',
  ].join('\n'));

  const loaded = await loadContractIdsFromFile(file);
  assert.equal(loaded.length, 20);
  assert.deepEqual(loaded, ids20);
  await rm(dir, { recursive: true, force: true });
});

test('lens doctor with --contracts-file loads ids from file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-cf-cli-'));
  const file = join(dir, 'contracts.txt');
  const dbPath = join(dir, 'lens.db');
  await writeFile(file, `# watch the XLM SAC\n${SAC}\n`);

  const { code, stdout } = await runLens([
    'doctor',
    '--contracts-file', file,
    '--db', dbPath,
    '--data-dir', dir,
    '--rpc-url', DEAD_RPC,
  ]);
  // RPC will fail (dead endpoint) but contract id check should pass.
  assert.match(stdout, /1 configured/i);
  // Exit code 1 because RPC is unreachable, but not 2 (argument error).
  assert.ok(code === 0 || code === 1, `unexpected exit code ${code}`);
  await rm(dir, { recursive: true, force: true });
});

test('lens doctor: --contracts-file merged with -c flags', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-cf-merge-'));
  const file = join(dir, 'contracts.txt');
  const dbPath = join(dir, 'lens.db');
  await writeFile(file, `${SAC2}\n`);

  const { code, stdout } = await runLens([
    'doctor',
    '-c', SAC,
    '--contracts-file', file,
    '--db', dbPath,
    '--data-dir', dir,
    '--rpc-url', DEAD_RPC,
  ]);
  assert.match(stdout, /2 configured/i);
  assert.ok(code === 0 || code === 1, `unexpected exit code ${code}`);
  await rm(dir, { recursive: true, force: true });
});

test('lens: --contracts-file with a bad id exits 2 and reports line number', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-cf-bad-'));
  const file = join(dir, 'contracts.txt');
  await writeFile(file, `# comment\n${SAC}\nGBQHHOH72M522QBF7SMY57JH6FIN7YKTZUWSO4S5IFBXV3B7FI2UQLIQ\n`);

  const { code, stderr } = await runLens([
    'doctor',
    '--contracts-file', file,
    '--db', ':memory:',
    '--data-dir', dir,
  ]);
  assert.equal(code, 2);
  assert.match(stderr, /:3:/);
  await rm(dir, { recursive: true, force: true });
});

test('lens: --contracts-file with a missing file exits 2', async () => {
  const { code, stderr } = await runLens([
    'doctor',
    '--contracts-file', '/tmp/no-such-file-lens-141.txt',
    '--db', ':memory:',
  ]);
  assert.equal(code, 2);
  assert.match(stderr, /cannot read contracts file/);
});
