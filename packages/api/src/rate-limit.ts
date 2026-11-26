import type { IncomingMessage } from 'node:http';

export interface RateLimitOptions {
  /** Steady-state refill rate, in requests per second per client. */
  requestsPerSecond: number;
  /** Bucket size: how many requests a client may make back to back. Defaults to `ceil(requestsPerSecond)`, at least 1. */
  burst?: number;
}

export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/** Run a sweep for idle buckets once per this many calls to `take`. */
const SWEEP_EVERY = 1024;

/**
 * A token bucket per key.
 *
 * Each key starts with a full bucket of `burst` tokens that refills continuously
 * at `requestsPerSecond`; a request spends one. A bucket that has refilled to
 * capacity is indistinguishable from a key never seen, so a periodic sweep
 * drops those and memory stays proportional to the clients active recently,
 * not every address ever seen.
 */
export class TokenBucketLimiter {
  readonly #rate: number;
  readonly #capacity: number;
  readonly #now: () => number;
  readonly #buckets = new Map<string, { tokens: number; updatedAt: number }>();
  #calls = 0;

  constructor(options: RateLimitOptions, now: () => number = Date.now) {
    if (!Number.isFinite(options.requestsPerSecond) || options.requestsPerSecond <= 0) {
      throw new Error(`rateLimit.requestsPerSecond must be a positive number, got ${options.requestsPerSecond}.`);
    }
    const burst = options.burst ?? Math.max(1, Math.ceil(options.requestsPerSecond));
    if (!Number.isFinite(burst) || burst < 1) {
      throw new Error(`rateLimit.burst must be at least 1, got ${burst}.`);
    }
    this.#rate = options.requestsPerSecond;
    this.#capacity = Math.floor(burst);
    this.#now = now;
  }

  take(key: string): RateLimitDecision {
    const now = this.#now();
    if (++this.#calls % SWEEP_EVERY === 0) this.#sweep(now);

    const bucket = this.#buckets.get(key) ?? { tokens: this.#capacity, updatedAt: now };
    bucket.tokens = this.#refilled(bucket, now);
    bucket.updatedAt = now;
    this.#buckets.set(key, bucket);

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true };
    }
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - bucket.tokens) / this.#rate)) };
  }

  /** Buckets currently tracked. Exposed so a test can assert memory stays bounded. */
  get size(): number {
    return this.#buckets.size;
  }

  #refilled(bucket: { tokens: number; updatedAt: number }, now: number): number {
    const elapsedSeconds = Math.max(0, now - bucket.updatedAt) / 1000;
    return Math.min(this.#capacity, bucket.tokens + elapsedSeconds * this.#rate);
  }

  #sweep(now: number): void {
    for (const [key, bucket] of this.#buckets) {
      if (this.#refilled(bucket, now) >= this.#capacity) this.#buckets.delete(key);
    }
  }
}

/**
 * The address a request counts against.
 *
 * `X-Forwarded-For` is client-controlled, so it is only read when the operator
 * says a trusted proxy sets it (`trustProxy`); otherwise any caller could mint
 * a fresh bucket per request by sending a different value.
 */
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/**
 * The bucket a request counts against.
 *
 * When the request presents a valid API key, the bucket is keyed by that key so
 * that distinct keys behind one NAT get separate budgets and a single key spread
 * across many addresses shares one. Anonymous requests fall back to the client
 * IP (see `clientIp`).
 */
export function clientKey(req: IncomingMessage, trustProxy: boolean, apiKey?: string | null): string {
  if (apiKey) return `key:${apiKey}`;
  return `ip:${clientIp(req, trustProxy)}`;
}
