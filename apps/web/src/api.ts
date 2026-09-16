import type { ApiErrorBody, ContractSummary, EventPage, Health, LensEvent, TopicCount } from './types.js';

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

export function configuredNetworks(): NetworkOption[] {
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

export interface EventQueryParams {
  contractId?: string;
  topics?: (string | null)[];
  fromLedger?: number;
  toLedger?: number;
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
  if (params.successfulOnly) search.set('successfulOnly', 'true');
  for (const topic of params.topics ?? []) search.append('topic', topic ?? '*');

  const base = params.contractId
    ? `/contracts/${encodeURIComponent(params.contractId)}/events`
    : '/events';
  const query = search.toString();
  return query ? `${base}?${query}` : base;
}

export const api = {
  health: (baseUrl: string, signal?: AbortSignal): Promise<Health> =>
    request<Health>(baseUrl, '/health', signal),

  events: (baseUrl: string, params: EventQueryParams, signal?: AbortSignal): Promise<EventPage> =>
    request<EventPage>(baseUrl, buildEventPath(params), signal),

  event: (baseUrl: string, id: string, signal?: AbortSignal): Promise<LensEvent> =>
    request<LensEvent>(baseUrl, `/events/${encodeURIComponent(id)}`, signal),

  contracts: (baseUrl: string, signal?: AbortSignal): Promise<{ contracts: ContractSummary[] }> =>
    request<{ contracts: ContractSummary[] }>(baseUrl, '/contracts', signal),

  topics: (baseUrl: string, contractId: string, signal?: AbortSignal): Promise<{ topics: TopicCount[] }> =>
    request<{ topics: TopicCount[] }>(baseUrl, `/contracts/${encodeURIComponent(contractId)}/topics`, signal),
};
