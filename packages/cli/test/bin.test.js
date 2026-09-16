import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
// seed's default fixture path is relative; run from the repo root so it resolves
// the same way it would for a real user, regardless of the test runner's own cwd.
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * Invoke `lens` as a real subprocess.
 *
 * A regression this file guards specifically: `main()` calls `process.exit()`
 * and is not exported, so testing its argument parsing means actually
 * spawning the binary rather than calling an internal function directly.
 */
async function cli(args, options = {}) {
  try {
    const { stdout, stderr } = await run('node', [BIN, ...args], { timeout: 20_000, cwd: REPO_ROOT, ...options });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

// ── regression: allowPositionals: false broke every subcommand taking one ────

test('lens completion <shell> does not crash on the positional argument', async () => {
  // Broke before this fix: parseArgs was called with allowPositionals: false
  // on the very same args array a positional shell name was read from, so
  // parseArgs threw ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL before the switch
  // statement ever ran.
  for (const shell of ['bash', 'zsh', 'fish']) {
    const { code, stdout } = await cli(['completion', shell]);
    assert.equal(code, 0, `completion ${shell}`);
    assert.ok(stdout.length > 0);
  }
});

test('lens completion with no shell argument defaults to bash rather than crashing', async () => {
  const { code, stdout } = await cli(['completion']);
  assert.equal(code, 0);
  assert.match(stdout, /_lens_completions/);
});

// ── #37 lens export / lens import ────────────────────────────────────────────

test('export then import round-trips through a real subprocess invocation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-cli-snap-'));
  const dbPath = join(dir, 'source.db');
  const snapshotPath = join(dir, 'snap.ndjson');
  const targetPath = join(dir, 'target.db');

  const seeded = await cli(['seed', '--db', dbPath]);
  assert.equal(seeded.code, 0, seeded.stderr);

  const exported = await cli(['export', '--db', dbPath, snapshotPath]);
  assert.equal(exported.code, 0, exported.stderr);
  assert.match(exported.stderr, /exported 60 event\(s\)/);

  const contents = await readFile(snapshotPath, 'utf8');
  assert.equal(contents.trim().split('\n').length, 60);

  const imported = await cli(['import', '--db', targetPath, snapshotPath]);
  assert.equal(imported.code, 0, imported.stderr);
  assert.match(imported.stderr, /imported 60 new event\(s\)/);

  const stats = await cli(['stats', '--db', targetPath]);
  assert.equal(JSON.parse(stats.stdout).eventCount, 60);

  await rm(dir, { recursive: true, force: true });
});

test('export requires a destination path', async () => {
  const { code, stderr } = await cli(['export', '--db', ':memory:']);
  assert.equal(code, 2);
  assert.match(stderr, /requires a destination path/);
});

test('import requires a source path', async () => {
  const { code, stderr } = await cli(['import', '--db', ':memory:']);
  assert.equal(code, 2);
  assert.match(stderr, /requires a source path/);
});

test('the destination path can come before or after --db — positionals are not order-dependent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-cli-snap-'));
  const dbPath = join(dir, 'source.db');
  const snapshotPath = join(dir, 'snap.ndjson');

  await cli(['seed', '--db', dbPath]);
  // Path first, then the flag — the order lens completion's own examples use.
  const a = await cli(['export', snapshotPath, '--db', dbPath]);
  assert.equal(a.code, 0, a.stderr);

  await rm(dir, { recursive: true, force: true });
});
