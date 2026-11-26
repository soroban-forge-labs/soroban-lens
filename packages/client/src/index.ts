import createClient, { type ClientOptions } from 'openapi-fetch';
import type { paths } from './schema.js';

export type { paths, components, operations } from './schema.js';

/**
 * Options for {@link createLensClient}.
 *
 * Extends the underlying `openapi-fetch` options with resilience controls:
 * a client-wide default timeout, and configurable retries for idempotent
 * GET requests.
 */
export interface LensClientOptions extends Omit<ClientOptions, 'baseUrl'> {
  /**
   * Default request timeout in milliseconds applied to every method that does
   * not pass its own `signal`. `0` (or `undefined`) disables the timeout.
   */
  timeout?: number;
  /**
   * Retry policy for idempotent GET requests. Pass `false` to disable retries
   * entirely, or an object to tune the behaviour.
   */
  retry?: false | LensRetryOptions;
}

export interface LensRetryOptions {
  /** Maximum number of retries after the initial attempt. Defaults to `2`. */
  retries?: number;
  /** Base backoff in milliseconds, doubled on each attempt. Defaults to `250`. */
  backoff?: number;
  /** Upper bound for a single backoff delay in milliseconds. Defaults to `10_000`. */
  maxBackoff?: number;
}

const DEFAULT_RETRIES = 2;
const DEFAULT_BACKOFF = 250;
const DEFAULT_MAX_BACKOFF = 10_000;

function resolveRetry(retry: LensClientOptions['retry']): Required<LensRetryOptions> | null {
  if (retry === false) return null;
  return {
    retries: retry?.retries ?? DEFAULT_RETRIES,
    backoff: retry?.backoff ?? DEFAULT_BACKOFF,
    maxBackoff: retry?.maxBackoff ?? DEFAULT_MAX_BACKOFF,
  };
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 503;
}

/**
 * A typed client for the soroban-lens query API.
 *
 * Paths, parameters and response bodies are all derived from
 * `packages/api/openapi.json` at build time, so a change to the spec that this
 * wrapper no longer fits fails the build instead of shipping a stale client.
 *
 * Every method accepts an optional `signal` for cancellation. A client-wide
 * `timeout` applies when no `signal` is supplied, and idempotent GET requests
 * are retried on network errors, `429` and `503`, honouring `Retry-After`.
 *
 * @example
 * ```ts
 * const lens = createLensClient('http://localhost:8080', { timeout: 5_000 });
 * const { data } = await lens.GET('/contracts/{contractId}/events', {
 *   params: { path: { contractId }, query: { limit: 50 } },
 * });
 * ```
 */
export function createLensClient(baseUrl: string, options: LensClientOptions = {}) {
  const { timeout, retry, ...rest } = options;
  const retryPolicy = resolveRetry(retry);

  const client = createClient<paths>({ ...rest, baseUrl });

  const originalFetch = client.GET;
  void originalFetch;

  const fetchImpl = (input: Request): Promise<Response> => {
    const signal = input.signal;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const onAbort = () => controller.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    if (timeout && timeout > 0) {
      timer = setTimeout(() => controller.abort(new DOMException('Timeout', 'TimeoutError')), timeout);
    }

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    const attempt = async (remaining: number): Promise<Response> => {
      try {
        const response = await fetch(input, { signal: controller.signal });
        if (remaining > 0 && isRetryableStatus(response.status)) {
          const retryAfter = parseRetryAfter(response.headers.get('Retry-After'));
          const delay = retryAfter ?? Math.min(retryPolicy!.backoff * 2 ** (retryPolicy!.retries - remaining), retryPolicy!.maxBackoff);
          await sleep(delay, controller.signal);
          return attempt(remaining - 1);
        }
        return response;
      } catch (error) {
        if (remaining > 0 && !controller.signal.aborted) {
          const delay = Math.min(retryPolicy!.backoff * 2 ** (retryPolicy!.retries - remaining), retryPolicy!.maxBackoff);
          await sleep(delay, controller.signal);
          return attempt(remaining - 1);
        }
        throw error;
      }
    };

    const maxRetries = retryPolicy?.retries ?? 0;
    return attempt(maxRetries).finally(cleanup);
  };

  return createClient<paths>({ ...rest, baseUrl, fetch: fetchImpl });
}
