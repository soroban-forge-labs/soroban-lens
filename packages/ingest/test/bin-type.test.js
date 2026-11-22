import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

test('--type diagnostic is rejected before any network call (#144)', async () => {
  try {
    await run('node', [BIN, '-c', SAC, '--type', 'diagnostic', '--no-resume'], {
      timeout: 10_000,
    });
    assert.fail('expected the bin to reject --type diagnostic');
  } catch (error) {
    assert.equal(error.code, 2);
    assert.match(error.stderr, /--type must be contract or system/);
    assert.doesNotMatch(error.stderr, /diagnostic/);
  }
});

test('--type system is still documented and accepted (#144)', async () => {
  // --help exits before any network call, so this is the cheap proof that the
  // flag surface still offers system.
  const { stdout } = await run('node', [BIN, '--help']);
  assert.match(stdout, /--type <kind>\s+contract \| system/);
  assert.doesNotMatch(stdout, /diagnostic/);
});
