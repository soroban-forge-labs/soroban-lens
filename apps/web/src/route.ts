/**
 * URL serialization for the explorer's view state — filters, selected network,
 * and the event to show expanded.
 *
 * Two URL shapes:
 *
 *   /?contract=CDLZ…&topic=transfer&network=testnet
 *   /events/0020166232959352832-0000000000?contract=CDLZ…&topic=transfer
 *
 * The `/events/{id}` path is the clean, shareable deep link for a single event;
 * everything else is a query parameter. Only non-default values are written so
 * shared URLs stay short.
 *
 * `FilterState` is defined here rather than in `Filters.tsx` so this module —
 * which has no React dependency and is tested under `node --test` — owns the
 * shape both the UI and the URL serializer use.
 */

/** The filter state that controls which events the explorer shows. */
export interface FilterState {
  contractId: string;
  topic: string;
  successfulOnly: boolean;
  live: boolean;
  /** Inclusive ledger bounds as typed in the filter bar; '' when unset. */
  fromLedger: string;
  toLedger: string;
}

/** The complete view state that can be encoded in the URL. */
export interface UrlState {
  filters: FilterState;
  network: string;
  /** Event id to show expanded, or null. From the `/events/{id}` path. */
  expandedEventId: string | null;
}

/**
 * Parse a URL's path and query string into view state.
 *
 * Returns `null` for a bare visit (no query params and no `/events/{id}` path),
 * signalling the caller to fall back to whatever is in `localStorage`.
 */
export function parseUrl(pathname: string, search: string): UrlState | null {
  const params = new URLSearchParams(search);

  // Strip a trailing slash so `/events/{id}/` and `/events/{id}` are equivalent.
  const trimmedPath = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  const eventMatch = trimmedPath.match(/^\/events\/(.+)$/);

  // Bare visit: nothing in the URL to restore from.
  if (!eventMatch && [...params.keys()].length === 0) return null;

  const expandedEventId = eventMatch ? decodeURIComponent(eventMatch[1]!) : null;

  return {
    filters: {
      contractId: params.get('contract') ?? '',
      topic: params.get('topic') ?? '',
      successfulOnly: params.get('successfulOnly') === 'true',
      // live defaults to true; only `live=false` turns it off.
      live: params.get('live') !== 'false',
      fromLedger: params.get('fromLedger') ?? '',
      toLedger: params.get('toLedger') ?? '',
    },
    network: params.get('network') ?? '',
    expandedEventId,
  };
}

/**
 * Serialize view state into a path + query string.
 *
 * Only non-default values are written, to keep shared URLs short. An expanded
 * event uses the clean `/events/{id}` path; the rest is query params.
 */
export function stringifyUrl(state: UrlState): string {
  const params = new URLSearchParams();
  const f = state.filters;

  if (f.contractId) params.set('contract', f.contractId);
  if (f.topic) params.set('topic', f.topic);
  if (f.successfulOnly) params.set('successfulOnly', 'true');
  // live defaults to true, so only write it when it is off.
  if (!f.live) params.set('live', 'false');
  if (f.fromLedger) params.set('fromLedger', f.fromLedger);
  if (f.toLedger) params.set('toLedger', f.toLedger);
  if (state.network) params.set('network', state.network);

  const query = params.toString();
  const qs = query ? `?${query}` : '';

  if (state.expandedEventId) {
    return `/events/${encodeURIComponent(state.expandedEventId)}${qs}`;
  }
  return `/${qs}`;
}

/**
 * Compare two states, ignoring `expandedEventId`. The hook uses this to decide
 * whether a change is a filter change (push a history entry) or just an
 * expansion toggle (replace the current entry).
 */
export function sameFilterView(a: UrlState, b: UrlState): boolean {
  return (
    a.filters.contractId === b.filters.contractId &&
    a.filters.topic === b.filters.topic &&
    a.filters.successfulOnly === b.filters.successfulOnly &&
    a.filters.live === b.filters.live &&
    a.filters.fromLedger === b.filters.fromLedger &&
    a.filters.toLedger === b.filters.toLedger &&
    a.network === b.network
  );
}
