import { createServer, type Server } from 'node:http';

/**
 * Request metrics for the query API (#184), in the same hand-written
 * Prometheus text format as `packages/ingest/src/metrics.ts`.
 *
 * Every label is drawn from a closed set so the series count stays bounded
 * whatever clients send:
 *
 * - `route` is the matched route's pattern (`/contracts/{id}/events`), never
 *   the raw path. A path no route matches is `unmatched`, a single series, so
 *   probing random URLs cannot mint new ones.
 * - `method` is one of the methods the API serves, or `other`.
 * - `status` is the status class: `2xx`, `3xx`, `4xx` or `5xx`.
 */

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const METHODS = new Set(['GET', 'HEAD', 'POST', 'DELETE', 'OPTIONS']);
/** Route label for a request no route matched. */
export const UNMATCHED_ROUTE = 'unmatched';

type Histogram = { count: number; sum: number; buckets: number[] };

/** `/^\/contracts\/([^/]+)\/events$/` -> `/contracts/{id}/events`. */
export function routeLabel(pattern: RegExp): string {
  return pattern.source
    .replace(/^\^/, '')
    .replace(/\$$/, '')
    // A capture group is one path segment; `[^/]` may or may not come back
    // from `source` with its slash escaped.
    .replace(/\(\[\^\\?\/\]\+\)/g, '{id}')
    .replace(/\\(.)/g, '$1');
}

export function statusClass(status: number): string {
  if (status >= 200 && status < 600) return `${Math.floor(status / 100)}xx`;
  // Below 200 only when a response never got a status; count it as a failure.
  return '5xx';
}

function methodLabel(method: string | undefined): string {
  return method !== undefined && METHODS.has(method) ? method : 'other';
}

/** Process-local request metrics. Pass one to `createApiServer({ metrics })`. */
export class ApiMetrics {
  #requests = new Map<string, number>();
  #durations = new Map<string, Histogram>();

  /** Record one finished (or aborted) request. */
  observe(route: string, method: string | undefined, status: number, seconds: number): void {
    const base = `route="${route}",method="${methodLabel(method)}"`;
    const counted = `${base},status="${statusClass(status)}"`;
    this.#requests.set(counted, (this.#requests.get(counted) ?? 0) + 1);

    const h = this.#durations.get(base) ?? { count: 0, sum: 0, buckets: BUCKETS.map(() => 0) };
    h.count++;
    h.sum += seconds;
    BUCKETS.forEach((bound, i) => {
      if (seconds <= bound) h.buckets[i] = (h.buckets[i] ?? 0) + 1;
    });
    this.#durations.set(base, h);
  }

  render(): string {
    const sorted = <T>(map: Map<string, T>): [string, T][] => [...map].sort(([a], [b]) => a.localeCompare(b));
    return [
      '# HELP lens_api_requests_total HTTP requests served, by route pattern, method and status class.',
      '# TYPE lens_api_requests_total counter',
      ...sorted(this.#requests).map(([labels, count]) => `lens_api_requests_total{${labels}} ${count}`),
      '# HELP lens_api_request_duration_seconds Time from receiving a request to its response ending.',
      '# TYPE lens_api_request_duration_seconds histogram',
      ...sorted(this.#durations).flatMap(([labels, h]) => [
        ...BUCKETS.map((bound, i) => `lens_api_request_duration_seconds_bucket{${labels},le="${bound}"} ${h.buckets[i]}`),
        `lens_api_request_duration_seconds_bucket{${labels},le="+Inf"} ${h.count}`,
        `lens_api_request_duration_seconds_sum{${labels}} ${h.sum}`,
        `lens_api_request_duration_seconds_count{${labels}} ${h.count}`,
      ]),
      '',
    ].join('\n');
  }
}

/** `LENS_API_METRICS_PORT` / `--metrics-port`; undefined (off) when unset. */
export function parseMetricsPort(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('metrics port must be an integer from 1 to 65535');
  }
  return port;
}

/**
 * Serve `/metrics` on its own port, separate from the API so it is never
 * behind the API's auth or rate limit and never exposed with it. Binds to
 * loopback by default. A bind failure rejects, rather than losing monitoring
 * silently.
 */
export async function startApiMetricsServer(metrics: ApiMetrics, port: number, host = '127.0.0.1'): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    if (request.url !== '/metrics') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
    response.end(request.method === 'HEAD' ? undefined : metrics.render());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return server;
}
