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
