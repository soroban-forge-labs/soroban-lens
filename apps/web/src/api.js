const DEFAULT_NETWORKS = [
    { label: 'testnet', baseUrl: 'http://localhost:8080' },
];
export function configuredNetworks() {
    const raw = import.meta.env.VITE_LENS_NETWORKS;
    if (!raw) {
        const single = import.meta.env.VITE_LENS_API_URL;
        return single ? [{ label: 'testnet', baseUrl: single }] : DEFAULT_NETWORKS;
    }
    try {
        const parsed = JSON.parse(raw);
        const entries = Object.entries(parsed).map(([label, baseUrl]) => ({ label, baseUrl }));
        return entries.length > 0 ? entries : DEFAULT_NETWORKS;
    }
    catch {
        console.warn('VITE_LENS_NETWORKS is not valid JSON; falling back to the default.');
        return DEFAULT_NETWORKS;
    }
}
/** An API response that was not 2xx. Carries the server's error code. */
export class ApiRequestError extends Error {
    status;
    code;
    parameter;
    constructor(status, body, fallback) {
        super(body?.error?.message ?? fallback);
        this.name = 'ApiRequestError';
        this.status = status;
        this.code = body?.error?.code ?? 'unknown';
        this.parameter = body?.error?.parameter;
    }
}
async function request(baseUrl, path, signal) {
    let response;
    try {
        response = await fetch(`${baseUrl}${path}`, { signal, headers: { Accept: 'application/json' } });
    }
    catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError')
            throw error;
        // A failed fetch to a configured API is nearly always "the API is not
        // running", which is far more actionable than "Failed to fetch".
        throw new ApiRequestError(0, null, `Cannot reach the API at ${baseUrl}. Is it running?`);
    }
    if (!response.ok) {
        const body = (await response.json().catch(() => null));
        throw new ApiRequestError(response.status, body, `Request failed with ${response.status}.`);
    }
    return (await response.json());
}
/** Build the query string, mapping `null` topic segments to the `*` wildcard. */
export function buildEventPath(params) {
    const search = new URLSearchParams();
    if (params.limit !== undefined)
        search.set('limit', String(params.limit));
    if (params.cursor)
        search.set('cursor', params.cursor);
    if (params.fromLedger !== undefined)
        search.set('fromLedger', String(params.fromLedger));
    if (params.toLedger !== undefined)
        search.set('toLedger', String(params.toLedger));
    if (params.successfulOnly)
        search.set('successfulOnly', 'true');
    for (const topic of params.topics ?? [])
        search.append('topic', topic ?? '*');
    const base = params.contractId
        ? `/contracts/${encodeURIComponent(params.contractId)}/events`
        : '/events';
    const query = search.toString();
    return query ? `${base}?${query}` : base;
}
export const api = {
    health: (baseUrl, signal) => request(baseUrl, '/health', signal),
    events: (baseUrl, params, signal) => request(baseUrl, buildEventPath(params), signal),
    event: (baseUrl, id, signal) => request(baseUrl, `/events/${encodeURIComponent(id)}`, signal),
    contracts: (baseUrl, signal) => request(baseUrl, '/contracts', signal),
    topics: (baseUrl, contractId, signal) => request(baseUrl, `/contracts/${encodeURIComponent(contractId)}/topics`, signal),
};
