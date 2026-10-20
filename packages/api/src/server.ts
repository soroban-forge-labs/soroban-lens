import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { gzipSync, deflateSync, createGzip, createDeflate } from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  MAX_QUERY_LIMIT,
  DEFAULT_MAX_QUERY_LIMIT,
  LATEST_SCHEMA_VERSION,
  ContractTypedDecoder,
  SpecCache,
  type EventQuery,
  type EventStore,
  type LensEvent,
  type Logger,
} from '@soroban-lens/store';
import { ApiError } from './errors.js';
import { MIN_TOPIC_COLUMNS, eventCsvHeader, eventCsvRow, wantsCsv } from './csv.js';
import {
  assertContractId,
  parseActivityQuery,
  parseEventQuery,
  parseFields,
  parseIds,
  selectFields,
} from './params.js';
import { executeGraphQL, type GraphQLOptions } from './graphql.js';
import { WebhookManager, type WebhookOptions } from './webhooks.js';
import { ApiKeyAuthenticator } from './auth.js';
import { TokenBucketLimiter, clientKey, type RateLimitOptions } from './rate-limit.js';
import { EventStreamHub, type EventStreamOptions } from './stream.js';

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
  /** Structured logger, shared with the store's own logging (#16). Defaults to silent. */
  log?: Logger;
  /**
   * Per-client-IP token-bucket limiter (#43). Off by default: without it there is
   * no limit, exactly as before it existed. /health, /openapi.json and /docs are
   * never limited, so a probe or a newcomer reading the spec cannot be locked out.
   */
  rateLimit?: RateLimitOptions;
  /**
   * API keys accepted in `X-API-Key` or `Authorization: Bearer` (#43). Off by
   * default: with no keys every request is allowed. /health, /openapi.json and
   * /docs stay open either way.
   */
  apiKeys?: string[];
  /**
   * Take the client address from `X-Forwarded-For` for rate limiting. Only enable
   * behind a proxy that sets it; the header is otherwise client-controlled.
   */
  trustProxy?: boolean;
  /** Tuning for `GET /events/stream` (#42). */
  stream?: EventStreamOptions;
  /** Optional GraphQL endpoint at /graphql. Disabled unless `enabled: true` (#60). */
  graphql?: GraphQLOptions;
  /** Optional webhook subscriptions at /webhooks. Disabled unless `enabled: true` (#59). */
  webhooks?: WebhookOptions;
}

/** Largest request body accepted by the POST routes. */
const MAX_BODY_BYTES = 100 * 1024;

/** Read and parse a JSON request body, refusing anything over `MAX_BODY_BYTES`. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new ApiError(413, 'payload_too_large', `The request body must be at most ${MAX_BODY_BYTES} bytes.`);
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') throw ApiError.badRequest('A JSON request body is required.');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw ApiError.badRequest('The request body is not valid JSON.');
  }
}

/**
 * A response written incrementally rather than built in memory (#41).
 *
 * `open` is called only when a body is actually going to be sent — never for
 * HEAD — and runs before the status line is written, so a store failure while
 * preparing the export is still an ordinary JSON 500 rather than a truncated 200.
 */
interface StreamedCsv {
  filename: string;
  open: () => Promise<AsyncIterable<string>>;
}

type HandlerResult =
  | {
      status?: number;
      body: unknown;
      contentType?: string;
      /** The handler already wrote the response (a stream), so there is nothing to send. */
      handled?: true;
    }
  | { stream: StreamedCsv };

type Handler = (ctx: {
  params: string[];
  query: URLSearchParams;
  /** The request's `Accept` header, for content negotiation. */
  accept: string | string[] | undefined;
  store: EventStore;
  options: ApiServerOptions;
  /** Parsed contract specs, for the typed view of each event (#33). */
  specs: SpecCache;
  /** Present only when webhooks are enabled. */
  webhooks: WebhookManager | undefined;
  headers: IncomingMessage['headers'];
  /** Parse the request body as JSON, bounded to `MAX_BODY_BYTES`. */
  readJson: () => Promise<unknown>;
  /** The raw exchange, for the one route that streams instead of returning a body. */
  req: IncomingMessage;
  res: ServerResponse;
  streams: EventStreamHub;
}) => Promise<HandlerResult>;

/** Matches "/contracts/{id}/events" and friends. */
interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
  /** Serves without reading event rows, so a pending migration does not block it. */
  exemptFromSchemaCheck?: boolean;
  /** Open to everyone: skips the rate limiter and API-key check (#43). */
  public?: boolean;
  /**
   * Carries an `ETag` and answers `If-None-Match` with 304 (#47). Such a route
   * is sent `Cache-Control: no-cache` — store it, but revalidate every time —
   * instead of `no-store`, which would stop a browser sending the validator.
   */
  etag?: boolean;
}

/**
 * How long a client should wait before retrying during a migration.
 *
 * A migration on a SQLite file is seconds, not minutes. Short enough that a
 * poller recovers promptly; long enough that it does not hammer the API while
 * the migration holds the write lock.
 */
const MIGRATION_RETRY_AFTER_SECONDS = 5;

/**
 * Data routes refuse to serve from a half-migrated database.
 *
 * /health and /openapi.json are deliberately exempt: health is how an operator
 * finds out *why* everything else is 503ing, and a spec is static. Returning
 * rows from a schema the code does not expect is worse than being briefly
 * unavailable — the rows would look plausible and be wrong.
 */
async function assertSchemaCurrent(store: EventStore): Promise<void> {
  const { schemaVersion } = await store.getStats();
  if (schemaVersion === LATEST_SCHEMA_VERSION) return;
  throw ApiError.unavailable(
    `The database is at schema v${schemaVersion}, expected v${LATEST_SCHEMA_VERSION}. ` +
      'A migration is pending; see GET /health.',
    MIGRATION_RETRY_AFTER_SECONDS,
  );
}

/** Rows fetched per store query while exporting. Bounded by the configured query ceiling. */
const CSV_PAGE_SIZE = Math.min(500, MAX_QUERY_LIMIT);

/**
 * Every event matching `query`, a page at a time.
 *
 * Walks the keyset cursor so memory stays at one page however large the export.
 * `limit`, when given, caps the total rows (it is the page size everywhere
 * else); without it the export is everything that matches. `cursor` and `order`
 * are honoured, so an export can resume where an earlier page ended.
 */
async function* eachEventPage(store: EventStore, query: EventQuery): AsyncGenerator<LensEvent[]> {
  let remaining = query.limit ?? Number.POSITIVE_INFINITY;
  let cursor = query.cursor;
  while (remaining > 0) {
    const page = await store.queryEvents({
      ...query,
      limit: Math.min(remaining, CSV_PAGE_SIZE),
      ...(cursor ? { cursor } : {}),
    });
    if (page.events.length > 0) yield page.events;
    remaining -= page.events.length;
    if (!page.nextCursor) return;
    cursor = page.nextCursor;
  }
}

function topicColumnsOf(events: LensEvent[]): number {
  return events.reduce((max, e) => Math.max(max, e.topics.length), MIN_TOPIC_COLUMNS);
}

async function* csvRows(events: LensEvent[], topicColumns: number): AsyncGenerator<string> {
  yield eventCsvHeader(topicColumns);
  for (const event of events) yield eventCsvRow(event, topicColumns);
}

/**
 * Stream a filtered export as CSV.
 *
 * The header names one column per topic position, so its width has to be known
 * before the first row — and events can carry more topics than the four
 * indexed ones. One scan sizes the columns; the second writes the rows. That
 * trades a second read for a header that is correct for every row, which a
 * spreadsheet or pandas needs (a row wider than its header fails to parse).
 */
function csvExport(store: EventStore, query: EventQuery, filename: string): StreamedCsv {
  return {
    filename,
    open: async () => {
      let topicColumns = MIN_TOPIC_COLUMNS;
      for await (const events of eachEventPage(store, query)) {
        topicColumns = Math.max(topicColumns, topicColumnsOf(events));
      }
      return (async function* () {
        yield eventCsvHeader(topicColumns);
        for await (const events of eachEventPage(store, query)) {
          for (const event of events) yield eventCsvRow(event, topicColumns);
        }
      })();
    },
  };
}

const routes: Route[] = [
  {
    // Liveness plus a real write probe against the store, so a read-only volume
    // shows up here rather than as a mysterious indexer failure later.
    method: 'GET',
    pattern: /^\/health$/,
    exemptFromSchemaCheck: true,
    public: true,
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
    etag: true,
    handler: async ({ params, query, accept, store, specs }) => {
      const contractId = assertContractId(decodeURIComponent(params[0] as string));
      const fields = parseFields(query);
      const eventQuery = { ...parseEventQuery(query), contractId };
      if (wantsCsv(query, accept)) {
        return { stream: csvExport(store, eventQuery, `${contractId}-events.csv`) };
      }
      const page = await store.queryEvents(eventQuery);
      const events = selectFields(await specs.annotate(page.events), fields);
      if (page.events.length > 0) return { body: { ...page, events } };

      // An empty page is three different situations (#58). Telling them apart
      // takes one more query, so it is only paid on the empty path: is there
      // *any* event for this contract, ignoring the filters?
      const known = await store.queryEvents({ contractId, limit: 1 });
      if (known.events.length === 0) {
        throw ApiError.notFound(
          `No indexed events for contract "${contractId}". ` +
            'The contract may not exist, or may exist on-chain but not be one this instance indexes — ' +
            'check LENS_CONTRACT_IDS.',
        );
      }
      return { body: { ...page, events, emptyReason: 'no_matching_events' } };
    },
  },
  {
    // Event counts per time bucket (#53), so "events per hour this week" is one
    // GROUP BY on closed_at_unix (#24) rather than paging every event.
    method: 'GET',
    pattern: /^\/contracts\/([^/]+)\/activity$/,
    handler: async ({ params, query, store }) => {
      const contractId = assertContractId(decodeURIComponent(params[0] as string));
      const { bucket, from, to, topics, successfulOnly } = parseActivityQuery(query);
      const counts = await store.countByTimeBucket(
        {
          contractId,
          ...(from !== undefined ? { fromTime: from } : {}),
          ...(to !== undefined ? { toTime: to } : {}),
          ...(topics ? { topics } : {}),
          ...(successfulOnly !== undefined ? { successfulOnly } : {}),
        },
        bucket,
      );
      return {
        body: {
          contractId,
          bucket,
          buckets: counts.map((c) => ({
            start: new Date(c.start * 1000).toISOString(),
            count: c.count,
            firstLedger: c.firstLedger,
            lastLedger: c.lastLedger,
          })),
        },
      };
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
    // What typed decoding knows about a contract (#33): where its spec came
    // from and which events it declares. 404 when it was never looked up,
    // which is different from a lookup that found nothing (source "none").
    method: 'GET',
    pattern: /^\/contracts\/([^/]+)\/spec$/,
    handler: async ({ params, store }) => {
      const contractId = assertContractId(decodeURIComponent(params[0] as string));
      const record = await store.getContractSpec(contractId);
      if (!record) {
        throw ApiError.notFound(
          `No spec has been looked up for contract "${contractId}". ` +
            'The indexer fetches specs for contracts it indexes; `lens spec fetch -c <id>` does it on demand.',
        );
      }
      let events: string[] = [];
      try {
        events = ContractTypedDecoder.fromRecord(record)?.eventNames() ?? [];
      } catch {
        // Unparseable stored entries: report the record, with no events.
      }
      const { entriesXdr: _entries, ...summary } = record;
      return { body: { ...summary, events } };
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
    etag: true,
    handler: async ({ query, accept, store, specs }) => {
      const csv = wantsCsv(query, accept);
      // ?ids= is a batch lookup, not a filter: it resolves a known list in one
      // round trip rather than N. It short-circuits the filter path entirely,
      // since mixing "these exact events" with "events matching X" has no
      // sensible meaning.
      const fields = parseFields(query);
      const ids = parseIds(query);
      if (ids) {
        const found = await Promise.all(ids.map((id) => store.getEvent(id)));
        if (csv) {
          const events = found.filter((e): e is NonNullable<typeof e> => e !== null);
          return { stream: { filename: 'events.csv', open: async () => csvRows(events, topicColumnsOf(events)) } };
        }
        return {
          body: {
            events: selectFields(
              await specs.annotate(found.filter((e): e is NonNullable<typeof e> => e !== null)),
              fields,
            ),
            // Reported rather than silently dropped, so a caller can tell
            // "not indexed" from "I typo'd the id".
            missing: ids.filter((_, i) => found[i] === null),
          },
        };
      }
      const eventQuery = parseEventQuery(query);
      if (csv) return { stream: csvExport(store, eventQuery, 'events.csv') };
      const page = await store.queryEvents(eventQuery);
      return { body: { ...page, events: selectFields(await specs.annotate(page.events), fields) } };
    },
  },
  {
    // Live updates (#42). Takes the same filters as /events, plus `contractId`
    // since there is no path segment to carry it. Declared before /events/{id},
    // which would otherwise read "stream" as an event id.
    method: 'GET',
    pattern: /^\/events\/stream$/,
    handler: async ({ query, req, res, streams }) => {
      const filter = parseEventQuery(query);
      const contractId = query.get('contractId');
      const resumeFrom = lastEventId(req, query);
      await streams.subscribe(
        req,
        res,
        { ...filter, ...(contractId ? { contractId: assertContractId(contractId) } : {}) },
        resumeFrom,
      );
      return { body: null, handled: true };
    },
  },
  {
    method: 'GET',
    pattern: /^\/events\/([^/]+)$/,
    handler: async ({ params, query, store, specs }) => {
      const id = decodeURIComponent(params[0] as string);
      const fields = parseFields(query);
      const event = await store.getEvent(id);
      if (!event) throw ApiError.notFound(`No indexed event with id "${id}".`);
      const [annotated] = await specs.annotate([event]);
      return { body: selectFields([annotated as object], fields)[0] };
    },
  },
  {
    // Optional GraphQL over the same store (#60). GET carries the query in the
    // URL, POST in a JSON body, per the GraphQL-over-HTTP convention.
    method: 'GET',
    pattern: /^\/graphql$/,
    handler: async ({ query, store, options }) => {
      requireGraphQL(options);
      const variables = query.get('variables');
      let parsed: unknown;
      if (variables) {
        try {
          parsed = JSON.parse(variables);
        } catch {
          throw ApiError.badRequest('"variables" must be a JSON object.', 'variables');
        }
      }
      const result = await executeGraphQL(
        { query: query.get('query') ?? '', variables: parsed, operationName: query.get('operationName') ?? undefined },
        store,
        options.graphql,
      );
      return { status: result.status, body: result.body };
    },
  },
  {
    method: 'POST',
    pattern: /^\/graphql$/,
    handler: async ({ store, options, readJson }) => {
      requireGraphQL(options);
      const body = await readJson();
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw ApiError.badRequest('The request body must be a JSON object with a "query" string.');
      }
      const { query, variables, operationName } = body as Record<string, unknown>;
      const result = await executeGraphQL(
        {
          query: typeof query === 'string' ? query : '',
          variables,
          operationName: typeof operationName === 'string' ? operationName : undefined,
        },
        store,
        options.graphql,
      );
      return { status: result.status, body: result.body };
    },
  },
  {
    method: 'POST',
    pattern: /^\/webhooks$/,
    handler: async ({ webhooks, headers, readJson }) => {
      const manager = requireWebhooks(webhooks, headers);
      return { status: 201, body: await manager.register(await readJson()) };
    },
  },
  {
    method: 'GET',
    pattern: /^\/webhooks$/,
    handler: async ({ webhooks, headers }) => {
      return { body: { webhooks: requireWebhooks(webhooks, headers).list() } };
    },
  },
  {
    method: 'GET',
    pattern: /^\/webhooks\/([^/]+)$/,
    handler: async ({ params, webhooks, headers }) => {
      return { body: requireWebhooks(webhooks, headers).get(decodeURIComponent(params[0] as string)) };
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/webhooks\/([^/]+)$/,
    handler: async ({ params, webhooks, headers }) => {
      const id = decodeURIComponent(params[0] as string);
      requireWebhooks(webhooks, headers).remove(id);
      return { body: { deleted: true, id } };
    },
  },
  {
    // Events that exhausted their retries. The record is how a receiver that
    // was down for longer than the retry window finds out what it missed.
    method: 'GET',
    pattern: /^\/webhooks\/([^/]+)\/dead-letters$/,
    handler: async ({ params, webhooks, headers }) => {
      const id = decodeURIComponent(params[0] as string);
      return { body: { deadLetters: requireWebhooks(webhooks, headers).deadLetters(id) } };
    },
  },
  {
    method: 'GET',
    pattern: /^\/openapi\.json$/,
    exemptFromSchemaCheck: true,
    public: true,
    handler: async () => ({
      body: await servedSpec(),
      contentType: 'application/json; charset=utf-8',
    }),
  },
  {
    // A browsable page over the same spec /openapi.json serves, for a
    // newcomer who would rather click through routes than read raw JSON.
    // Redoc reads /openapi.json client-side, same-origin, so this route
    // itself never needs to know the spec's content and stays exempt from
    // the schema-currency check the same way the JSON route already is.
    method: 'GET',
    pattern: /^\/docs$/,
    exemptFromSchemaCheck: true,
    public: true,
    handler: async () => ({
      body: DOCS_HTML,
      contentType: 'text/html; charset=utf-8',
    }),
  },
];

/** 404 rather than 403 while disabled: the endpoint simply does not exist. */
function requireGraphQL(options: ApiServerOptions): void {
  if (!options.graphql?.enabled) {
    throw ApiError.notFound('GraphQL is disabled. Start the API with LENS_GRAPHQL=1 to enable /graphql.');
  }
}

function requireWebhooks(
  webhooks: WebhookManager | undefined,
  headers: IncomingMessage['headers'],
): WebhookManager {
  if (!webhooks) {
    throw ApiError.notFound('Webhook subscriptions are disabled. Start the API with LENS_WEBHOOKS=1 to enable /webhooks.');
  }
  const auth = headers['authorization'];
  webhooks.authorize(Array.isArray(auth) ? auth[0] : auth);
  return webhooks;
}

/**
 * Redoc, pinned to an exact version from a CDN — not `@latest`, so an
 * unrelated Redoc release can never change what this route serves. Reads
 * /openapi.json itself, so this page carries no spec content of its own and
 * cannot drift from the committed spec the way a static copy could.
 */
const DOCS_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>soroban-lens API</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>body { margin: 0; padding: 0; }</style>
</head>
<body>
  <redoc spec-url="/openapi.json"></redoc>
  <script src="https://cdn.jsdelivr.net/npm/redoc@2.5.4/bundles/redoc.standalone.js"></script>
</body>
</html>
`;

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

/** Responses currently being served, per server, so shutdown can wait for them. */
const inFlight = new WeakMap<Server, Set<ServerResponse>>();
const draining = new WeakSet<Server>();

export interface ShutdownOptions {
  /** How long to wait for in-flight requests before dropping them. Default 10000. */
  timeoutMs?: number;
}

/**
 * Stop accepting connections and wait for in-flight requests to finish.
 *
 * Requests still running after `timeoutMs` have their connections destroyed so
 * shutdown cannot hang forever. Resolves only once the server is closed, so
 * the caller can then close the store without pulling it out from under a
 * request being served.
 *
 * @returns whether the timeout was hit and connections were force-closed.
 */
export async function shutdownApiServer(
  server: Server,
  options: ShutdownOptions = {},
): Promise<{ forced: boolean }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  draining.add(server);

  const closed = new Promise<void>((resolve) => {
    // The callback also fires with an error when the server was never
    // listening; either way there is nothing left to wait for.
    server.close(() => resolve());
  });
  // Idle keep-alive connections would otherwise hold close() open until they
  // time out. Busy ones are left alone and close after their response.
  server.closeIdleConnections();

  let forced = false;
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      forced = (inFlight.get(server)?.size ?? 0) > 0;
      server.closeAllConnections();
      resolve();
    }, timeoutMs);
  });

  await Promise.race([closed, timedOut]);
  clearTimeout(timer);
  await closed;
  return { forced };
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

/** The id a reconnecting EventSource sends, or `?lastEventId=` for a client that cannot set headers. */
function lastEventId(req: IncomingMessage, query: URLSearchParams): string | undefined {
  const header = req.headers['last-event-id'];
  const value = ((Array.isArray(header) ? header[0] : header) ?? query.get('lastEventId') ?? '').trim();
  return value !== '' && value.length <= 200 ? value : undefined;
}

/**
 * The validator for a list response (#47): newest event id + route + filter.
 *
 * Weak, because the representation is semantically the same across
 * `Accept-Encoding` variants. Repeated parameters keep their relative order —
 * `topic` is positional — and only the keys are sorted, so `?a=1&b=2` and
 * `?b=2&a=1` share a tag but `?topic=x&topic=y` and `?topic=y&topic=x` do not.
 */
async function entityTag(
  store: EventStore,
  path: string,
  params: URLSearchParams,
  representation: string,
): Promise<string> {
  const newest = (await store.getLatestEventId()) ?? '';
  const filter = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const hash = createHash('sha1')
    .update(`${newest}\n${path}\n${filter}\n${representation}`)
    .digest('base64url');
  return `W/"${hash}"`;
}

/** Weak comparison, per RFC 9110 §13.1.2: `If-None-Match` ignores the `W/` prefix. */
function matchesEntityTag(header: string | string[] | undefined, etag: string): boolean {
  const value = Array.isArray(header) ? header.join(',') : header;
  if (!value) return false;
  const opaque = (tag: string): string => tag.trim().replace(/^W\//, '');
  return value.split(',').some((candidate) => candidate.trim() === '*' || opaque(candidate) === opaque(etag));
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
  const log = options.log ?? { debug() {}, info() {}, warn() {}, error() {} };
  const corsOrigin = options.corsOrigin ?? '*';
  const limiter = options.rateLimit ? new TokenBucketLimiter(options.rateLimit) : undefined;
  const auth = new ApiKeyAuthenticator(options.apiKeys ?? []);
  const trustProxy = options.trustProxy ?? false;
  // One per server: specs are per database, and the TTL is what lets a spec
  // the indexer fetches after startup show up without restarting the API.
  const specs = new SpecCache((contractId) => store.getContractSpec(contractId));
  const webhooks = options.webhooks?.enabled ? new WebhookManager(store, options.webhooks, log) : undefined;
  const streams = new EventStreamHub(store, (events) => specs.annotate(events), log, options.stream);

  const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res);
  });
  if (webhooks) {
    webhooks.start();
    // The dispatcher's timer is unref'd, but stopping it explicitly also ends
    // any delivery that is sleeping between retries.
    server.on('close', () => webhooks.stop());
  }
  const active = new Set<ServerResponse>();
  inFlight.set(server, active);

  // An open event stream never ends on its own, so without this `close()` would
  // wait on it forever and a shutdown signal would hang.
  const closeServer = server.close.bind(server);
  server.close = ((callback?: (err?: Error) => void) => {
    streams.closeAll();
    return closeServer(callback);
  }) as Server['close'];

  return server;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    active.add(res);
    res.once('close', () => active.delete(res));
    // While draining, tell keep-alive clients to reconnect elsewhere instead of
    // reusing a connection that is about to go away.
    if (draining.has(server)) res.setHeader('Connection', 'close');

    const started = Date.now();
    // The base is a placeholder; only pathname and search are ever read.
    const url = new URL(req.url ?? '/', 'http://localhost');

    // Honour an id a trusted upstream (a gateway, a load balancer) already
    // assigned, so the same request keeps one id end to end rather than a
    // new one appearing at each hop; generate one otherwise. v0.1 already
    // assumes a trusted network for exactly this kind of header.
    const inbound = req.headers['x-request-id'];
    const requestId =
      (Array.isArray(inbound) ? inbound[0] : inbound)?.trim().slice(0, 200) || randomUUID();
    res.setHeader('X-Request-Id', requestId);

    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-API-Key, If-None-Match, Last-Event-ID',
    );
    // Without this a browser hides ETag and Retry-After from cross-origin scripts.
    res.setHeader('Access-Control-Expose-Headers', 'ETag, Retry-After, X-Request-Id');

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
      const candidates = routes.filter((r) => r.pattern.test(path));

      // Before the 404 and the schema check, so a caller who is throttled or
      // unauthenticated learns nothing about which routes exist or what state the
      // database is in. The limiter runs first: it is what stops key guessing.
      // Public only when every route on this path is (/health, /openapi.json, /docs).
      const isPublic = candidates.length > 0 && candidates.every((r) => r.public);
      if (!isPublic) {
        if (limiter) {
          const decision = limiter.take(clientKey(req, trustProxy));
          if (!decision.allowed) {
            throw ApiError.tooManyRequests(
              `Rate limit exceeded. Retry in ${decision.retryAfterSeconds}s.`,
              decision.retryAfterSeconds,
            );
          }
        }
        if (!auth.isAuthorized(req)) {
          throw ApiError.unauthorized(
            auth.presentedKey(req)
              ? 'The API key is not valid.'
              : 'This instance requires an API key: send X-API-Key or Authorization: Bearer <key>.',
          );
        }
      }

      if (candidates.length === 0) {
        throw ApiError.notFound(`No route for ${req.method} ${path}. See GET /openapi.json.`);
      }
      const route = candidates.find((r) => r.method === method);
      if (!route) {
        const allowed = [...new Set(candidates.map((r) => r.method))];
        throw new ApiError(
          405,
          'method_not_allowed',
          `${path} accepts ${allowed.join(', ')} only.`,
          undefined,
          // HEAD rides along with GET (RFC 9110), so Allow must say so.
          allowed.flatMap((m) => (m === 'GET' ? ['GET', 'HEAD'] : [m])).join(', '),
        );
      }

      // Everything except /health and /openapi.json reads rows, so everything
      // else waits for the schema to be current.
      if (!route.exemptFromSchemaCheck) await assertSchemaCurrent(store);

      // A poll that finds nothing new is answered from the validator alone,
      // without running the query or serialising a page (#47).
      // The event routes serve JSON or CSV from one URL, negotiated on Accept /
      // ?format=, so the validator must differ per representation.
      const etag = route.etag
        ? await entityTag(
            store,
            path,
            url.searchParams,
            wantsCsv(url.searchParams, req.headers.accept) ? 'csv' : 'json',
          )
        : undefined;
      if (etag && matchesEntityTag(req.headers['if-none-match'], etag)) {
        res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache', Vary: 'Accept, Accept-Encoding' });
        res.end();
        log.info(
          'request_handled',
          `${req.method} ${url.pathname}${url.search} -> 304 (${Date.now() - started}ms)`,
          { method: req.method, path: url.pathname, status: 304, durationMs: Date.now() - started, requestId },
        );
        return;
      }

      const match = route.pattern.exec(path);
      const result = await route.handler({
        params: match ? match.slice(1) : [],
        query: url.searchParams,
        accept: req.headers.accept,
        store,
        options,
        specs,
        webhooks,
        headers: req.headers,
        readJson: () => readJsonBody(req),
        req,
        res,
        streams,
      });

      if ('stream' in result) {
        await sendCsv(res, result.stream, isHead, req.headers['accept-encoding']);
        const durationMs = Date.now() - started;
        log.info(
          'request_handled',
          `${req.method} ${url.pathname}${url.search} -> 200 csv (${durationMs}ms)`,
          { method: req.method, path: url.pathname, status: 200, durationMs, requestId },
        );
        return;
      }

      if (!result.handled) {
        send(
          res,
          result.status ?? 200,
          result.body,
          result.contentType,
          isHead,
          req.headers['accept-encoding'],
          etag && (result.status ?? 200) === 200 ? { etag } : undefined,
        );
      }
      const status = result.status ?? 200;
      const durationMs = Date.now() - started;
      log.info(
        'request_handled',
        `${req.method} ${url.pathname}${url.search} -> ${status} (${durationMs}ms)`,
        { method: req.method, path: url.pathname, status, durationMs, requestId },
      );
    } catch (error) {
      // A failure after a streamed body has started cannot become a JSON error:
      // the status line is already sent. Cut the connection so the client sees
      // an aborted download rather than a CSV that quietly ends early.
      if (res.headersSent) {
        // The client hanging up on a long download is routine, not a server fault.
        const aborted = (error as NodeJS.ErrnoException)?.code === 'ERR_STREAM_PREMATURE_CLOSE';
        if (aborted) {
          log.info('request_aborted', `${req.method} ${url.pathname} aborted by the client`, {
            method: req.method,
            path: url.pathname,
            requestId,
          });
        } else {
          log.error(
            'request_failed',
            `${req.method} ${url.pathname} failed mid-stream: ${error instanceof Error ? error.stack : error}`,
            { method: req.method, path: url.pathname, requestId },
          );
        }
        // No argument: an error here would surface as an unhandled 'error' event on res.
        res.destroy();
        return;
      }
      const apiError =
        error instanceof ApiError
          ? error
          : new ApiError(500, 'internal_error', error instanceof Error ? error.message : String(error));
      if (apiError.allow) res.setHeader('Allow', apiError.allow);
      if (apiError.wwwAuthenticate) res.setHeader('WWW-Authenticate', apiError.wwwAuthenticate);
      if (apiError.retryAfterSeconds !== undefined) {
        res.setHeader('Retry-After', String(apiError.retryAfterSeconds));
      }
      if (apiError.status >= 500) {
        log.error(
          'request_failed',
          `${req.method} ${url.pathname} -> ${apiError.status}: ${error instanceof Error ? error.stack : error}`,
          { method: req.method, path: url.pathname, status: apiError.status, requestId },
        );
      }
      send(res, apiError.status, apiError.toBody(requestId), undefined, isHead, req.headers['accept-encoding']);
    }
  }
}

// Below this, gzip/deflate's own framing overhead can cost more than it
// saves — matches the same "measure before compressing unconditionally"
// finding #35 made for the raw-XDR columns, applied here rather than assumed.
const COMPRESSION_THRESHOLD_BYTES = 1024;

function pickEncoding(acceptEncoding: string | string[] | undefined): 'gzip' | 'deflate' | undefined {
  const header = Array.isArray(acceptEncoding) ? acceptEncoding.join(',') : (acceptEncoding ?? '');
  // Order of preference, not the client's — gzip is at least as well
  // supported as deflate and typically compresses slightly better, so it
  // wins when a client (correctly) advertises both with no explicit q-values.
  if (/(?:^|,)\s*gzip\s*(?:;|,|$)/i.test(header)) return 'gzip';
  if (/(?:^|,)\s*deflate\s*(?:;|,|$)/i.test(header)) return 'deflate';
  return undefined;
}

/**
 * Write a streamed CSV body with backpressure, gzipped when the client allows.
 *
 * No Content-Length — the size is unknown until the last page — so Node uses
 * chunked transfer. HEAD gets the headers a GET would, without reading the
 * store at all: scanning a large export to answer a HEAD would defeat its point.
 */
async function sendCsv(
  res: ServerResponse,
  csv: StreamedCsv,
  headOnly: boolean,
  acceptEncoding: string | string[] | undefined,
): Promise<void> {
  // Opened before any header is written, so a store failure is still a clean 500.
  const chunks = headOnly ? undefined : await csv.open();
  const encoding = pickEncoding(acceptEncoding);

  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${csv.filename}"`,
    ...(encoding ? { 'Content-Encoding': encoding } : {}),
    Vary: 'Accept, Accept-Encoding',
    'Cache-Control': 'no-store',
  });
  if (!chunks) {
    res.end();
    return;
  }

  const source = Readable.from(chunks);
  if (encoding === 'gzip') await pipeline(source, createGzip(), res);
  else if (encoding === 'deflate') await pipeline(source, createDeflate(), res);
  else await pipeline(source, res);
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  contentType?: string,
  headOnly = false,
  acceptEncoding?: string | string[],
  validator?: { etag: string },
): void {
  // A handler that already produced a JSON string (the OpenAPI document) passes
  // it through untouched rather than being re-serialised.
  const payload = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  const rawBytes = Buffer.byteLength(payload);

  const encoding = rawBytes >= COMPRESSION_THRESHOLD_BYTES ? pickEncoding(acceptEncoding) : undefined;
  const compressed = encoding === 'gzip' ? gzipSync(payload) : encoding === 'deflate' ? deflateSync(payload) : undefined;

  res.writeHead(status, {
    'Content-Type': contentType ?? 'application/json; charset=utf-8',
    // Deliberately the length the body *would* have had. RFC 9110 says a HEAD
    // response carries the same Content-Length as the GET, and a client that
    // sizes a request from it would otherwise read zero.
    'Content-Length': compressed ? compressed.length : rawBytes,
    ...(encoding ? { 'Content-Encoding': encoding } : {}),
    // A cache or proxy in front of this must know the body varies by this
    // header, or it can serve a gzipped response to a client that never asked
    // for one (or vice versa).
    // Accept too: the event-list routes negotiate JSON versus CSV on it.
    Vary: 'Accept, Accept-Encoding',
    ...(validator
      ? { ETag: validator.etag, 'Cache-Control': 'no-cache' }
      : { 'Cache-Control': 'no-store' }),
  });
  res.end(headOnly ? undefined : (compressed ?? payload));
}
