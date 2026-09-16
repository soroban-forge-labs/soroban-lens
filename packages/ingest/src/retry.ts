/** Error thrown when every retry attempt has been used up. */
export class RetryExhaustedError extends Error {
  override readonly cause: unknown;
  readonly attempts: number;
  constructor(message: string, attempts: number, cause: unknown) {
    super(message);
    this.name = 'RetryExhaustedError';
    this.attempts = attempts;
    this.cause = cause;
  }
}

export interface RetryOptions {
  /** Total attempts including the first. Defaults to 5. */
  attempts?: number;
  /** Delay before the first retry, in ms. Defaults to 250. */
  baseDelayMs?: number;
  /** Upper bound on any single delay, in ms. Defaults to 30_000. */
  maxDelayMs?: number;
  /** Deterministic jitter source in [0, 1). Defaults to Math.random. */
  random?: () => number;
  /** Sleep implementation, swappable in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Called before each retry, for logging. */
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
  /** Clock for interpreting an HTTP-date `Retry-After`. Swappable in tests. */
  now?: () => number;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Upper bound on a server-supplied delay, so a bad header cannot park us for hours. */
export const MAX_RETRY_AFTER_MS = 300_000;

/**
 * Extract the wait a rate limiter explicitly asked for.
 *
 * Only consulted for 429. RFC 9110 allows `Retry-After` in two forms, and
 * providers use both: delta-seconds, or an HTTP date. Returns null when the
 * error is not a 429, when no usable header is present, or when the value is
 * malformed — in which case the caller falls back to ordinary backoff.
 */
export function retryAfterMs(error: unknown, now: number = Date.now()): number | null {
  if (statusOf(error) !== 429) return null;

  const raw = headerOf(error, 'retry-after');
  if (raw === null) return null;

  const value = raw.trim();
  if (value === '') return null;

  // delta-seconds. Integer per the spec; tolerate a fractional value rather
  // than discarding a usable hint.
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    if (seconds < 0) return null;
    return clampRetryAfter(seconds * 1000);
  }

  // HTTP-date.
  const when = Date.parse(value);
  if (Number.isNaN(when)) return null;
  return clampRetryAfter(when - now);
}

function clampRetryAfter(ms: number): number {
  // A date already in the past means "retry now", not "retry in the past".
  return Math.min(Math.max(0, Math.round(ms)), MAX_RETRY_AFTER_MS);
}

/** HTTP status, wherever the transport happened to put it. */
function statusOf(error: unknown): number | undefined {
  const e = error as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  for (const candidate of [e?.status, e?.statusCode, e?.response?.status]) {
    if (typeof candidate === 'number') return candidate;
  }
  return undefined;
}

/**
 * Read one header case-insensitively from the shapes axios, undici and a plain
 * fetch Response each use.
 */
function headerOf(error: unknown, name: string): string | null {
  const response = (error as { response?: unknown; headers?: unknown })?.response;
  const containers = [
    (response as { headers?: unknown })?.headers,
    (error as { headers?: unknown })?.headers,
  ];

  for (const headers of containers) {
    if (!headers) continue;
    // fetch's Headers, and anything else exposing a get().
    if (typeof (headers as Headers).get === 'function') {
      const value = (headers as Headers).get(name);
      if (typeof value === 'string') return value;
      continue;
    }
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      if (key.toLowerCase() !== name) continue;
      if (typeof value === 'string') return value;
      if (typeof value === 'number') return String(value);
      if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
    }
  }
  return null;
}

/**
 * Full-jitter exponential backoff: delay = random(0, min(max, base * 2^n)).
 * Full jitter avoids the thundering herd you get when several indexers restart
 * against the same RPC node at once.
 */
export function backoffDelay(attempt: number, opts: RetryOptions = {}): number {
  const base = opts.baseDelayMs ?? 250;
  const max = opts.maxDelayMs ?? 30_000;
  const random = opts.random ?? Math.random;
  const ceiling = Math.min(max, base * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

/** Retry `fn` with exponential backoff until it resolves or attempts run out. */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const attempts = opts.attempts ?? 5;
  const doSleep = opts.sleep ?? sleep;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1) break;
      // A rate limiter that tells us how long to wait knows better than our
      // jitter does: backing off less earns another 429, backing off more
      // wastes throughput. Honour it exactly; fall back to backoff otherwise.
      const serverDelay = retryAfterMs(error, (opts.now ?? Date.now)());
      const delay = serverDelay ?? backoffDelay(attempt, opts);
      opts.onRetry?.(attempt + 1, delay, error);
      await doSleep(delay);
    }
  }

  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new RetryExhaustedError(
    `Gave up after ${attempts} attempt(s): ${reason}`,
    attempts,
    lastError,
  );
}
