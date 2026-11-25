import type {
  ApiErrorBody,
  ContractActivity,
  ContractSummary,
  EventPage,
  Health,
  IndexerStatus,
  LensEvent,
  TopicCount,
  WebhookSubscription,
  WebhookDelivery,
  WebhookDeadLetter,
} from './types.js';

/**
 * Networks the UI can point at.
 *
 * Each entry is an independent API instance, because one database holds events
 * from exactly one network. Configure with `VITE_LENS_NETWORKS`, a JSON object
 * of `{ label: apiBaseUrl }`.
 */
export interface NetworkOption {
  label: string;
  baseUrl: string; // URL of the API instance
}

const DEFAULT_NETWORKS: NetworkOption[] = [
  { label: 'testnet', baseUrl: 'http://localhost:8080' },
];

/**
 * Networks the container decided on at startup (#82), when it published any.
 *
 * `VITE_LENS_NETWORKS` is baked in at build time, so it cannot know whether a
 * compose profile started a second API. The web image's entrypoint writes
 * `/networks.json` when it starts instead, and that wins when present.
 */
let runtimeNetworks: NetworkOption[] | null = null;

/**
 * Parse a `{ label: apiBaseUrl }` map. Null for anything else — an object with
 * a non-string URL, an empty object, an array — so a bad file falls back to
 * the build-time list rather than leaving a switcher with no usable entry.
 */
export function parseNetworks(value: unknown): NetworkOption[] | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length === 0) return null;
  const networks: NetworkOption[] = [];
  for (const [label, baseUrl] of entries) {
    if (typeof baseUrl !== 'string' || baseUrl.trim() === '' || label.trim() === '') return null;
    networks.push({ label, baseUrl: baseUrl.replace(/\/+$/, '') });
  }
  return networks;
}

/**
 * Fetch `/networks.json` once, before the app renders. Absent (a dev server,
 * an image built before #82) or invalid, it is ignored: the build-time list
 * is still a correct answer, just not one that knows about profiles.
 */
export async function loadRuntimeNetworks(fetchImpl: typeof fetch = fetch): Promise<NetworkOption[] | null> {
  try {
    const response = await fetchImpl('/networks.json', { cache: 'no-store', headers: { Accept: 'application/json' } });
    // A single-page-app fallback serves index.html for unknown paths, so a
    // 200 is not enough: only a JSON body counts.
    if (!response.ok || !(response.headers.get('content-type') ?? '').includes('json')) return null;
    runtimeNetworks = parseNetworks(await response.json());
  } catch {
    runtimeNetworks = null;
  }
  return runtimeNetworks;
}

export function configuredNetworks(): NetworkOption[] {
  if (runtimeNetworks) return runtimeNetworks;
  const raw = import.meta.env.VITE_LENS_NETWORKS as string | undefined;
  if (!raw) {
    const single = import.meta.env.VITE_LENS_API_URL as string | undefined;
    return single ? [{ label: 'testnet', baseUrl: single }] : DEFAULT_NETWORKS;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    const entries = Object.entries(parsed).map(([label, baseUrl]) => ({ label, baseUrl }));
    return entries.length > 0 ? entries : DEFAULT_NETWORKS;
  } catch {
    console.warn('VITE_LENS_NETWORKS is not valid JSON; falling back to the default.');
    return DEFAULT_NETWORKS;
  }
}

/** An API response that was not 2xx. Carries the server's error code. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly parameter: string | undefined;

  constructor(status: number, body: ApiErrorBody | null, fallback: string) {
    super(body?.error?.message ?? fallback);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = body?.error?.code ?? 'unknown';
    this.parameter = body?.error?.parameter;
  }
}

async function request<T>(baseUrl: string, path: string, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, { signal, headers: { Accept: 'application/json' } });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    // A failed fetch to a configured API is nearly always "the API is not
    // running", which is far more actionable than "Failed to fetch".
    throw new ApiRequestError(0, null, `Cannot reach the API at ${baseUrl}. Is it running?`);
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
    throw new ApiRequestError(response.status, body, `Request failed with ${response.status}.`);
  }
  return (await response.json()) as T;
}

/**
 * A request that carries the admin API key. Webhook management is admin-only,
 * so the key travels in the `X-API-Key` header the API already checks.
 */
async function adminRequest<T>(
  baseUrl: string,
  path: string,
  apiKey: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', 'X-API-Key': apiKey };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: init.method ?? 'GET',
      signal: init.signal,
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiRequestError(0, null, `Cannot reach the API at ${baseUrl}. Is it running?`);
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
    throw new ApiRequestError(response.status, body, `Request failed with ${response.status}.`);
  }
  // 204 No Content (delete, ping, redeliver) has no body to parse.
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export interface EventQueryParams {
  contractId?: string;
  topics?: (string | null)[];
  fromLedger?: number;
  toLedger?: number;
  fromTime?: string;
  toTime?: string;
  successfulOnly?: boolean;
  limit?: number;
  cursor?: string;
}

/** Build the query string, mapping `null` topic segments to the `*` wildcard. */
export function buildEventPath(params: EventQueryParams): string {
  const search = new URLSearchParams();
  if (params.limit !== undefined) search.set('limit', String(params.limit));
  if (params.cursor) search.set('cursor', params.cursor);
  if (params.fromLedger !== undefined) search.set('fromLedger', String(params.fromLedger));
  if (params.toLedger !== undefined) search.set('toLedger', String(params.toLedger));
  if (params.fromTime !== undefined) search.set('fromTime', params.fromTime);
  if (params.toTime !== undefined) search.set('toTime', params.toTime);
  if (params.successfulOnly) search.set('successfulOnly', 'true');
  for (const topic of params.topics ?? []) search.append('topic', topic ?? '*');

  const base = params.contractId
    ? `/contracts/${encodeURIComponent(params.contractId)}/events`
    : '/events';
  const query = search.toString();
  return query ? `${base}?${query}` : base;
}

/**
 * The live-stream URL for a filter: `GET /events/stream`, which carries the
 * contract as `contractId` because there is no path segment for it. Paging
 * parameters do not apply to a stream and are left out.
 */
export function buildStreamPath(params: EventQueryParams): string {
  const search = new URLSearchParams();
  if (params.contractId) search.set('contractId', params.contractId);
  if (params.fromLedger !== undefined) search.set('fromLedger', String(params.fromLedger));
  if (params.toLedger !== undefined) search.set('toLedger', String(params.toLedger));
  if (params.successfulOnly) search.set('successfulOnly', 'true');
  for (const topic of params.topics ?? []) search.append('topic', topic ?? '*');
  const query = search.toString();
  return query ? `/events/stream?${query}` : '/events/stream';
}

export interface CreateWebhookInput {
  url: string;
  filter?: EventQueryParams;
}

export const api = {
  health: (baseUrl: string, signal?: AbortSignal): Promise<Health> =>
    request<Health>(baseUrl, '/health', signal),

  status: (baseUrl: string, signal?: AbortSignal): Promise<IndexerStatus> =>
    request<IndexerStatus>(baseUrl, '/status', signal),

  events: (baseUrl: string, params: EventQueryParams, signal?: AbortSignal): Promise<EventPage> =>
    request<EventPage>(baseUrl, buildEventPath(params), signal),

  event: (baseUrl: string, id: string, signal?: AbortSignal): Promise<LensEvent> =>
    request<LensEvent>(baseUrl, `/events/${encodeURIComponent(id)}`, signal),

  contracts: (baseUrl: string, signal?: AbortSignal): Promise<{ contracts: ContractSummary[] }> =>
    request<{ contracts: ContractSummary[] }>(baseUrl, '/contracts', signal),

  /** Pause indexing for one contract stream without restarting the indexer. */
  pauseContract: (baseUrl: string, contractId: string, signal?: AbortSignal): Promise<ContractSummary> =>
    request<ContractSummary>(baseUrl, `/contracts/${encodeURIComponent(contractId)}/pause`, signal),

  /** Resume a paused contract stream from its saved cursor. */
  resumeContract: (baseUrl: string, contractId: string, signal?: AbortSignal): Promise<ContractSummary> =>
    request<ContractSummary>(baseUrl, `/contracts/${encodeURIComponent(contractId)}/resume`, signal),

  /** List webhook subscriptions with health, cursor lag and dead-letter counts. */
  webhooks: (baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<{ subscriptions: WebhookSubscription[] }> =>
    adminRequest<{ subscriptions: WebhookSubscription[] }>(baseUrl, '/webhooks', apiKey, { signal }),

  /** Create a subscription. The filter is the same shape as an event query. */
  createWebhook: (baseUrl: string, apiKey: string, input: CreateWebhookInput, signal?: AbortSignal): Promise<WebhookSubscription> =>
    adminRequest<WebhookSubscription>(baseUrl, '/webhooks', apiKey, { method: 'POST', body: input, signal }),

  /** Delete a subscription and its pending deliveries. */
  deleteWebhook: (baseUrl: string, apiKey: string, id: string, signal?: AbortSignal): Promise<void> =>
    adminRequest<void>(baseUrl, `/webhooks/${encodeURIComponent(id)}`, apiKey, { method: 'DELETE', signal }),

  /** Send a test delivery to a subscription (#104). */
  pingWebhook: (baseUrl: string, apiKey: string, id: string, signal?: AbortSignal): Promise<WebhookDelivery> =>
    adminRequest<WebhookDelivery>(baseUrl, `/webhooks/${encodeURIComponent(id)}/ping`, apiKey, { method: 'POST', signal }),

  /** Replay a subscription's dead letters (#102). */
  redeliverWebhook: (baseUrl: string, apiKey: string, id: string, signal?: AbortSignal): Promise<{ redelivered: number }> =>
    adminRequest<{ redelivered: number }>(baseUrl, `/webhooks/${encodeURIComponent(id)}/dead-letters/redeliver`, apiKey, { method: 'POST', signal }),

  /** List a subscription's dead letters. */
  webhookDeadLetters: (baseUrl: string, apiKey: string, id: string, signal?: AbortSignal): Promise<{ deadLetters: WebhookDeadLetter[] }> =>
    adminRequest<{ deadLetters: WebhookDeadLetter[] }>(baseUrl, `/webhooks/${encodeURIComponent(id)}/dead-letters`, apiKey, { signal }),
};
