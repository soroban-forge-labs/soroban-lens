import test from 'node:test';
import assert from 'node:assert/strict';
import { withRetry, backoffDelay, RetryExhaustedError } from '../dist/index.js';

const noSleep = async () => {};

test('backoffDelay grows exponentially and respects maxDelayMs', () => {
  const opts = { baseDelayMs: 100, maxDelayMs: 1000, random: () => 0.999 };
  assert.equal(backoffDelay(0, opts), 99);
  assert.equal(backoffDelay(1, opts), 199);
  assert.equal(backoffDelay(2, opts), 399);
  // 100 * 2^4 = 1600, clamped to the 1000ms ceiling
  assert.equal(backoffDelay(4, opts), 999);
  assert.equal(backoffDelay(10, opts), 999);
});

test('backoffDelay applies full jitter', () => {
  const opts = { baseDelayMs: 100, maxDelayMs: 1000, random: () => 0 };
  assert.equal(backoffDelay(5, opts), 0, 'jitter can shrink a delay to zero');
});

test('withRetry returns the first successful value without sleeping', async () => {
  let sleeps = 0;
  const value = await withRetry(async () => 'ok', {
    sleep: async () => { sleeps++; },
  });
  assert.equal(value, 'ok');
  assert.equal(sleeps, 0);
});

test('withRetry retries transient failures then succeeds', async () => {
  const seen = [];
  const value = await withRetry(
    async (attempt) => {
      seen.push(attempt);
      if (attempt < 2) throw new Error('503 upstream');
      return 'recovered';
    },
    { sleep: noSleep, random: () => 0 },
  );
  assert.equal(value, 'recovered');
  assert.deepEqual(seen, [0, 1, 2]);
});

test('withRetry throws RetryExhaustedError carrying the last cause', async () => {
  const boom = new Error('connection reset');
  await assert.rejects(
    () => withRetry(async () => { throw boom; }, { attempts: 3, sleep: noSleep, random: () => 0 }),
    (err) => {
      assert.ok(err instanceof RetryExhaustedError);
      assert.equal(err.attempts, 3);
      assert.equal(err.cause, boom);
      assert.match(err.message, /connection reset/);
      return true;
    },
  );
});

test('withRetry reports each retry through onRetry', async () => {
  const calls = [];
  await assert.rejects(() =>
    withRetry(async () => { throw new Error('nope'); }, {
      attempts: 3,
      sleep: noSleep,
      random: () => 0,
      onRetry: (attempt, delay) => calls.push([attempt, delay]),
    }),
  );
  // 3 attempts means 2 retries announced
  assert.deepEqual(calls, [[1, 0], [2, 0]]);
});
