import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MAX_QUERY_LIMIT, DEFAULT_MAX_QUERY_LIMIT, type EventStore } from '@soroban-lens/store';
import { ApiError } from './errors.js';
import { assertContractId, parseEventQuery, parseIds } from './params.js';

export interface ApiServerOptions {
  store: EventStore;
  /** Allowed CORS origin. Defaults to "*" — the API is read-only and unauthenticated. */
  corsOrigin?: string;
  /** Build/version string reported by /health. */
  version?: string;
  /**
   * Network this database was indexed from, reported by /health.
   * A store holds events from exactly one network, so a UI can use this to
   * confirm it is pointed where the user thinks it is.
   */
  network?: string;
  log?: (message: string) => void;
}

/** Matches "/contracts/{id}/events" and friends. */
type Route = { method: string; pattern: RegExp; handler: Handler };
type Handler = (ctx: {
  params: string[];
  query: URLSearchParams;
  store: EventStore;
  options: ApiServerOptions;
}) => Promise<{ status?: number; body: unknown; contentType?: string }>;

const routes: Route[] = [
  {
    // Liveness plus a real write probe against the store, so a read-only volume
    // shows up here rather than as a mysterious indexer failure later.
    method: 'GET',
    pattern: /^\/health$/,
    handler: async ({ store, options }) => {
      const health = await store.healthCheck();
      const stats = await store.getStats();
      return {
        status: health.ok ? 200 : 503,
        body: {
          status: health.ok ? 'ok' : 'degraded',
          detail: health.detail,
          version: options.version ?? '0.1.0',
          network: options.network ?? 'unknown',
          uptimeSeconds: Math.round(process.uptime()),
          events: stats.eventCount,
          contracts: stats.contractCount,
          schemaVersion: stats.schemaVersion,
        },
      };
    },
  },
  {
    method: 'GET',
    pattern: /^\/stats$/,
    handler: async ({ store }) => {
      // topTopics answers "what event types are in here at all" without
      // paging the whole table (#30).
      const [stats, topTopics] = await Promise.all([store.getStats(), store.countByTopic(10)]);
      return { body: { ...stats, topTopics } };
    },
  },
  {
    // Indexer progress, so the UI can show lag without talking to the RPC.
    method: 'GET',
    pattern: /^\/status$/,
    handler: async ({ store }) => {
      const [stats, streams] = await Promise.all([store.getStats(), store.listStreamStates()]);
      return { body: { ...stats, streams } };
    },
  },
  {
    method: 'GET',
    pattern: /^\/contracts$/,
    handler: async ({ store, query }) => {
      const limit = query.get('limit') ? Number(query.get('limit')) : undefined;
      return { body: { contracts: await store.listContracts(limit) } };
    },
  },
  {
    method: 'GET',
    pattern: /^\/contracts\/([^/]+)\/events$/,
    handler: async ({ params, query, store }) => {
      const contractId = assertContractId(decodeURIComponent(params[0] as string));
      const page = await store.queryEvents({ ...parseEventQuery(query), contractId });
      return { body: page };
    },
  },
  {
    method: 'GET',
    pattern: /^\/contracts\/([^/]+)\/stats$/,
    handler: async ({ params, store }) => {
      const contractId = assertContractId(decodeURIComponent(params[0] as string));
      // listContracts already computes exactly this summary per contract; the
      // route exists so a caller does not have to fetch them all and filter.
      const summary = (await store.listContracts(MAX_QUERY_LIMIT)).find(
        (c) => c.contractId === contractId,
      );
      if (!summary) {
        throw ApiError.notFound(
          `No indexed events for contract "${contractId}". ` +
            'The contract may exist on-chain but not be one this instance indexes — ' +
            'check LENS_CONTRACT_IDS.',
        );
      }
      return { body: summary };
    },
  },
  {
    method: 'GET',
    pattern: /^\/contracts\/([^/]+)\/topics$/,
    handler: async ({ params, query, store }) => {
      const contractId = assertContractId(decodeURIComponent(params[0] as string));
      const limit = query.get('limit') ? Number(query.get('limit')) : undefined;
      return { body: { contractId, topics: await store.listTopics(contractId, limit) } };
    },
  },
  {
    method: 'GET',
    pattern: /^\/events$/,
    handler: async ({ query, store }) => {
      // ?ids= is a batch lookup, not a filter: it resolves a known list in one
      // round trip rather than N. It short-circuits the filter path entirely,
      // since mixing "these exact events" with "events matching X" has no
      // sensible meaning.
      const ids = parseIds(query);
      if (ids) {
        const found = await Promise.all(ids.map((id) => store.getEvent(id)));
        return {
          body: {
            events: found.filter((e): e is NonNullable<typeof e> => e !== null),
            // Reported rather than silently dropped, so a caller can tell
            // "not indexed" from "I typo'd the id".
            missing: ids.filter((_, i) => found[i] === null),
          },
        };
      }
      return { body: await store.queryEvents(parseEventQuery(query)) };
    },
  },
  {
    method: 'GET',
    pattern: /^\/events\/([^/]+)$/,
    handler: async ({ params, store }) => {
      const id = decodeURIComponent(params[0] as string);
      const event = await store.getEvent(id);
      if (!event) throw ApiError.notFound(`No indexed event with id "${id}".`);
      return { body: event };
    },
  },
  {
    method: 'GET',
    pattern: /^\/openapi\.json$/,
    handler: async () => ({
      body: await servedSpec(),
      contentType: 'application/json; charset=utf-8',
    }),
  },
];

/**
 * The committed spec with the live query ceiling patched in.
 *
 * MAX_QUERY_LIMIT is configurable (#55), so a spec that always claimed 1000
 * would be wrong on any instance that changed it — and the spec is what a
 * generated client trusts. The file on disk stays the documented default; only
 * what is served reflects the running configuration.
 */
async function servedSpec(): Promise<string> {
  const raw = await readFile(join(packageRoot(), 'openapi.json'), 'utf8');
  if (MAX_QUERY_LIMIT === DEFAULT_MAX_QUERY_LIMIT) return raw;

  const spec = JSON.parse(raw) as {
    components?: { parameters?: Record<string, { schema?: { maximum?: number } }> };
  };
  const limit = spec.components?.parameters?.['Limit'];
  if (limit?.schema) limit.schema.maximum = MAX_QUERY_LIMIT;
  return JSON.stringify(spec, null, 2);
}

function packageRoot(): string {
  // dist/server.js -> package root
  return join(dirname(fileURLToPath(import.meta.url)), '..');
}

/**
 * Build the HTTP server.
 *
 * Plain `node:http` with a regex table rather than a framework: the whole
 * surface is eight read-only GET routes, and a dependency-light stack is a
 * stated goal of the project. If this ever grows auth, rate limiting or
 * content negotiation, that is the moment to reach for a framework.
 */
export function createApiServer(options: ApiServerOptions): Server {
  const { store } = options;
  const log = options.log ?? (() => {});
  const corsOrigin = options.corsOrigin ?? '*';

  return createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    // The base is a placeholder; only pathname and search are ever read.
    const url = new URL(req.url ?? '/', 'http://localhost');

    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    // HEAD is GET without the body. RFC 9110 requires the headers to be the
    // ones GET would have sent, so it runs the real handler and drops the
    // payload at the end rather than short-circuiting to an empty 200 —
    // Content-Length, Content-Type and the status all stay truthful, including
    // on a 404. Monitoring tools use HEAD routinely and used to get a 405.
    const isHead = req.method === 'HEAD';
    const method = isHead ? 'GET' : req.method;

    try {
      const path = url.pathname.replace(/\/+$/, '') || '/';
      const route = routes.find((r) => r.pattern.test(path));

      if (!route) {
        throw ApiError.notFound(`No route for ${req.method} ${path}. See GET /openapi.json.`);
      }
      if (route.method !== method) {
        throw new ApiError(
          405,
          'method_not_allowed',
          `${path} accepts ${route.method} only.`,
          undefined,
          route.method === 'GET' ? 'GET, HEAD' : route.method,
        );
      }

      const match = route.pattern.exec(path);
      const result = await route.handler({
        params: match ? match.slice(1) : [],
        query: url.searchParams,
        store,
        options,
      });

      send(res, result.status ?? 200, result.body, result.contentType, isHead);
      log(`${req.method} ${url.pathname}${url.search} -> ${result.status ?? 200} (${Date.now() - started}ms)`);
    } catch (error) {
      const apiError =
        error instanceof ApiError
          ? error
          : new ApiError(500, 'internal_error', error instanceof Error ? error.message : String(error));
      if (apiError.allow) res.setHeader('Allow', apiError.allow);
      if (apiError.status >= 500) {
        log(`${req.method} ${url.pathname} -> ${apiError.status}: ${error instanceof Error ? error.stack : error}`);
      }
      send(res, apiError.status, apiError.toBody(), undefined, isHead);
    }
  }
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  contentType?: string,
  headOnly = false,
): void {
  // A handler that already produced a JSON string (the OpenAPI document) passes
  // it through untouched rather than being re-serialised.
  const payload = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': contentType ?? 'application/json; charset=utf-8',
    // Deliberately the length the body *would* have had. RFC 9110 says a HEAD
    // response carries the same Content-Length as the GET, and a client that
    // sizes a request from it would otherwise read zero.
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(headOnly ? undefined : payload);
}
