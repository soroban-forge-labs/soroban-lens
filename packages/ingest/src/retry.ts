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
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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
      const delay = backoffDelay(attempt, opts);
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
