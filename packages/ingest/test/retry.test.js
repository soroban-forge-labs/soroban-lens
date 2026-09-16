import test from 'node:test';
import assert from 'node:assert/strict';
import {
  withRetry,
  backoffDelay,
  retryAfterMs,
  MAX_RETRY_AFTER_MS,
  RetryExhaustedError,
} from '../dist/index.js';

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

// ── #13 honour 429 and Retry-After ───────────────────────────────────────────

/** A 429 shaped the way axios surfaces one. */
const rateLimited = (headers) =>
  Object.assign(new Error('Too Many Requests'), { response: { status: 429, headers } });

test('a 429 with delta-seconds waits precisely that long', async () => {
  const slept = [];
  const client = { calls: 0 };
  await withRetry(
    async () => {
      client.calls++;
      if (client.calls === 1) throw rateLimited({ 'retry-after': '7' });
      return 'ok';
    },
    { sleep: async (ms) => void slept.push(ms), random: () => 0.99 },
  );

  // Exactly the server's number — not jittered backoff, which would be ~247ms.
  assert.deepEqual(slept, [7000]);
});

test('a 429 with an HTTP-date waits until that moment', async () => {
  const now = Date.parse('2026-09-16T12:00:00Z');
  const slept = [];
  let first = true;
  await withRetry(
    async () => {
      if (first) {
        first = false;
        throw rateLimited({ 'Retry-After': 'Wed, 16 Sep 2026 12:00:30 GMT' });
      }
      return 'ok';
    },
    { sleep: async (ms) => void slept.push(ms), now: () => now },
  );

  assert.deepEqual(slept, [30_000]);
});

test('Retry-After is read case-insensitively and from fetch Headers', () => {
  assert.equal(retryAfterMs(rateLimited({ 'RETRY-AFTER': '3' })), 3000);
  assert.equal(retryAfterMs(rateLimited(new Headers({ 'retry-after': '4' }))), 4000);
  // Some transports hang headers off the error itself rather than a response.
  assert.equal(
    retryAfterMs(Object.assign(new Error('429'), { status: 429, headers: { 'retry-after': '5' } })),
    5000,
  );
});

test('a Retry-After date already in the past means retry now, not a negative wait', () => {
  const now = Date.parse('2026-09-16T12:00:00Z');
  const error = rateLimited({ 'retry-after': 'Wed, 16 Sep 2026 11:59:00 GMT' });
  assert.equal(retryAfterMs(error, now), 0);
});

test('an absurd Retry-After is capped rather than parking the indexer for hours', () => {
  assert.equal(retryAfterMs(rateLimited({ 'retry-after': '86400' })), MAX_RETRY_AFTER_MS);
});

test('Retry-After is ignored on anything that is not a 429', () => {
  const error = Object.assign(new Error('Service Unavailable'), {
    response: { status: 503, headers: { 'retry-after': '30' } },
  });
  // 503 also carries Retry-After, but honouring it here is out of scope for
  // this issue — #57 covers the API's own 503. Ordinary backoff applies.
  assert.equal(retryAfterMs(error), null);
});

test('a malformed or missing Retry-After falls back to ordinary backoff', () => {
  assert.equal(retryAfterMs(rateLimited({ 'retry-after': 'soon' })), null);
  assert.equal(retryAfterMs(rateLimited({ 'retry-after': '  ' })), null);
  assert.equal(retryAfterMs(rateLimited({ 'retry-after': '-5' })), null);
  assert.equal(retryAfterMs(rateLimited({})), null);
  assert.equal(retryAfterMs(new Error('plain failure')), null);
});

test('a 429 without Retry-After still uses jittered backoff', async () => {
  const slept = [];
  let first = true;
  await withRetry(
    async () => {
      if (first) {
        first = false;
        throw rateLimited({});
      }
      return 'ok';
    },
    { sleep: async (ms) => void slept.push(ms), random: () => 0.5, baseDelayMs: 200 },
  );
  assert.deepEqual(slept, [100]);
});
