import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiRequestError, buildStreamPath, configuredNetworks } from './api.js';
import type { Health, LensEvent, TopicCount } from './types.js';
import { Filters } from './components/Filters.js';
import type { FilterState } from './route.js';
import { EventTable } from './components/EventTable.js';
import { StatusBar } from './components/StatusBar.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { usePersistentState, usePolling, useDebounced, useEventStream, useUrlState, useTheme } from './hooks.js';

/** Testnet Stellar Asset Contract for native XLM — always emitting events. */
const EXAMPLE_CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMPQVUU2HHGCYSC'; // XLM SAC
const PAGE_SIZE = 50;
const LIVE_INTERVAL_MS = 5000;
const CONTRACT_ID_PATTERN = /^C[A-Z2-7]{55}$/;

export function App(): React.JSX.Element {
  const networks = useMemo(configuredNetworks, []);

  // Filter/network/expanded-event state lives in the URL so a link reproduces
  // the exact view. localStorage is the fallback for a bare visit only.
  const [urlState, setUrlState] = useUrlState(
    {
      filters: { contractId: '', topic: '', successfulOnly: false, live: true, fromLedger: '', toLedger: '' },
      network: networks[0]!.label,
      expandedEventId: null,
    },
    { filters: 'lens.filters', network: 'lens.network' },
  );
  const { filters, network: networkLabel, expandedEventId } = urlState;
  const selected = networks.find((n) => n.label === networkLabel) ?? networks[0]!;

  const setFilters = useCallback(
    (next: FilterState): void => setUrlState({ ...urlState, filters: next }),
    [urlState, setUrlState],
  );

  const toggleExpanded = useCallback(
    (eventId: string): void => {
      // Toggling replaces the current entry (same view), so it does not pollute
      // back/forward history.
      setUrlState({
        ...urlState,
        expandedEventId: urlState.expandedEventId === eventId ? null : eventId,
      });
    },
    [urlState, setUrlState],
  );

  const [events, setEvents] = useState<LensEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [topics, setTopics] = useState<TopicCount[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  // A 404 for a contract means this indexer has never seen it; an empty page
  // with emptyReason means it is indexed but nothing matches the filters.
  const [contractUnknown, setContractUnknown] = useState(false);
  const [emptyReason, setEmptyReason] = useState<'no_matching_events' | null>(null);
  const [theme, toggleTheme] = useTheme();
  // Absolute vs relative timestamps in the Ledger column. Persisted so the
  // choice survives a reload, like the theme.
  const [absoluteTime, setAbsoluteTime] = usePersistentState('lens.absoluteTime', false);

  // Typing a 56-character contract id should not fire 56 requests.
  const debouncedContractId = useDebounced(filters.contractId, 300);
  const debouncedTopic = useDebounced(filters.topic, 300);

  const contractIdValid = debouncedContractId === '' || CONTRACT_ID_PATTERN.test(debouncedContractId);

  // Parse ledger bounds: only include when valid non-empty integers.
  const fromLedgerNum =
    filters.fromLedger !== '' && /^\d+$/.test(filters.fromLedger)
      ? parseInt(filters.fromLedger, 10)
      : undefined;
  const toLedgerNum =
    filters.toLedger !== '' && /^\d+$/.test(filters.toLedger)
      ? parseInt(filters.toLedger, 10)
      : undefined;
  // Do not fire a request if the range is inverted.
  const ledgerRangeValid =
    fromLedgerNum === undefined ||
    toLedgerNum === undefined ||
    fromLedgerNum <= toLedgerNum;

  const query = useMemo(
    () => ({
      ...(contractIdValid && debouncedContractId ? { contractId: debouncedContractId } : {}),
      ...(debouncedTopic ? { topics: [debouncedTopic] } : {}),
      ...(filters.successfulOnly ? { successfulOnly: true } : {}),
      ...(fromLedgerNum !== undefined ? { fromLedger: fromLedgerNum } : {}),
      ...(toLedgerNum !== undefined ? { toLedger: toLedgerNum } : {}),
      limit: PAGE_SIZE,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [contractIdValid, debouncedContractId, debouncedTopic, filters.successfulOnly, fromLedgerNum, toLedgerNum],
  );

  // Guards against a slow earlier response overwriting a newer one.
  const requestId = useRef(0);

  const loadFirstPage = useCallback(async (): Promise<void> => {
    if (!contractIdValid || !ledgerRangeValid) return;
    const id = ++requestId.current;
    try {
      const page = await api.events(selected.baseUrl, query);
      if (id !== requestId.current) return;
      setEvents(page.events);
      setTotal(page.total);
      setNextCursor(page.nextCursor);
      setContractUnknown(false);
      setEmptyReason(page.emptyReason ?? null);
      setError(null);
      setLastUpdated(Date.now());
    } catch (err) {
      if (id !== requestId.current) return;
      if (err instanceof ApiRequestError && err.status === 404 && query.contractId) {
        setEvents([]);
        setTotal(0);
        setNextCursor(null);
        setContractUnknown(true);
        setEmptyReason(null);
        setError(null);
        setLastUpdated(Date.now());
        return;
      }
      setError(err instanceof ApiRequestError ? err.message : String(err));
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [selected.baseUrl, query, contractIdValid, ledgerRangeValid]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.events(selected.baseUrl, { ...query, cursor: nextCursor });
      // Append by id, because a live refresh may have already added some of
      // these rows while the user was reading.
      setEvents((current) => {
        const seen = new Set(current.map((e) => e.id));
        return [...current, ...page.events.filter((e) => !seen.has(e.id))];
      });
      setNextCursor(page.nextCursor);
      setTotal(page.total);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : String(err));
    } finally {
      setLoadingMore(false);
    }
  }, [selected.baseUrl, query, nextCursor, loadingMore]);

  // When the query or network changes, fetch fresh data but keep the old rows
  // on screen until the new ones arrive.
  useEffect(() => {
    if (!contractIdValid || !ledgerRangeValid) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setNextCursor(null);
    void loadFirstPage();
  }, [loadFirstPage, contractIdValid, ledgerRangeValid]);

  // Live updates arrive over SSE; polling is the fallback for whenever the
  // stream is not open (before it connects, while the browser retries a drop,
  // or against an API that does not offer it).
  const streamUrl =
    filters.live && contractIdValid ? `${selected.baseUrl}${buildStreamPath(query)}` : null;
  const streaming = useEventStream(
    streamUrl,
    (data) => {
      try {
        const event = JSON.parse(data) as LensEvent;
        setEvents((current) =>
          current.some((e) => e.id === event.id) ? current : [event, ...current],
        );
        setTotal((current) => current + 1);
        setLastUpdated(Date.now());
      } catch {
        // A malformed message is skipped; the next poll or reconnect resyncs.
      }
    },
    // A stream only carries events from now on, so catch up on connect.
    () => {
      void loadFirstPage();
    },
  );

  usePolling(
    () => {
      void loadFirstPage();
    },
    LIVE_INTERVAL_MS,
    filters.live && !streaming,
  );

  useEffect(() => {
    const controller = new AbortController();
    api
      .health(selected.baseUrl, controller.signal)
      .then((h) => {
        setHealth(h);
        setHealthError(null);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setHealth(null);
        setHealthError(err instanceof ApiRequestError ? err.message : String(err));
      });
    return () => controller.abort();
  }, [selected.baseUrl, lastUpdated]);

  // Topic suggestions only exist per contract.
  useEffect(() => {
    if (!contractIdValid || !debouncedContractId) {
      setTopics([]);
      return;
    }
    const controller = new AbortController();
    api
      .topics(selected.baseUrl, debouncedContractId, controller.signal)
      .then((r) => setTopics(r.topics))
      .catch(() => setTopics([]));
    return () => controller.abort();
  }, [selected.baseUrl, debouncedContractId, contractIdValid]);

  const showContract = !filters.contractId;

  // When the URL is `/events/{id}`, fetch that event so it can be shown
  // expanded even if it is not in the current page (e.g. a deep link to an
  // older event that is not in the first 50 results).
  useEffect(() => {
    if (!expandedEventId) return;
    const controller = new AbortController();
    api
      .event(selected.baseUrl, expandedEventId, controller.signal)
      .then((event) => {
        setEvents((current) => {
          if (current.some((e) => e.id === event.id)) return current;
          return [event, ...current];
        });
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        // A missing event does not break the table; the row simply is not there.
      });
    return () => controller.abort();
  }, [selected.baseUrl, expandedEventId]);

  const exportJson = useCallback(() => {
    if (events.length === 0) return;
    const blob = new Blob([JSON.stringify(events, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `soroban-events-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [events]);

  const exportCsv = useCallback(() => {
    if (events.length === 0) return;
    const headers = ['id', 'ledger', 'ledger_closed_at', 'contract_id', 'tx_hash', 'in_successful_call', 'topics', 'value'];
    const rows = events.map((e) => [
      e.id,
      e.ledger,
      e.ledgerClosedAt,
      e.contractId,
      e.txHash,
      e.inSuccessfulContractCall,
      `"${e.topics.map((t) => JSON.stringify(t.value)).join(' | ').replace(/"/g, '""')}"`,
      `"${JSON.stringify(e.value.value).replace(/"/g, '""')}"`,
    ]);
    const csvContent = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csvSontent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `soroban-events-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [events]);

  return (
    <main className="app">
      <header className="app-header">
        <div>
          <h1>
            soroban <span className="accent">-</span>lens
          </h1>
          <p className="tagline">See what your Soroban contracts are actually emitting.</p>
        </div>
        <button
          type="button"
          className="theme-toggle"
          onClick={toggleTheme}
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
        >
          {theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        </button>
      </header>

      <ErrorBoundary title="Status Bar Error">
        <StatusBar
          networks={networks}
          selected={selected}
          onSelect={(n) => setUrlState({ ...urlState, network: n.label })}
          health={health}
          error={healthError}
          lastUpdated={lastUpdated}
        />
      </ErrorBoundary>

      <ErrorBoundary title="Filter Controls Error">
        <Filters
          value={filters}
          onChange={setFilters}
          knownTopics={topics}
          onUseExample={() => setFilters({ ...filters, contractId: EXAMPLE_CONTRACT })}
        />
      </ErrorBoundary>

      {!contractIdValid && (
        <p className="warning banner">
          That does not look like a contract id. Expected a StrKey: <code>C</code> followed by
          55 upper-case letters and digits 2–7.
        </p>
      )}

      {error && contractIdValid && (
        <p className="warning banner" role="alert">
          {error}
        </p>
      )}

      <div className="result-meta">
        <div className="result-meta-left">
          <span aria-live="polite" aria-atomic="true">
            {total.toLocaleString()} event{total === 1 ? '' : 's'}
            {query.contractId ? ' for this contract' : ' indexed'}
            {debouncedTopic ? ` with topic "${debouncedTopic}"` : ''}
          </span>
          {filters.live && <span
              className="live-dot"
              title={streaming ? 'Streaming live updates' : 'Polling every 5 seconds'}
            >
              live
            </span>}
        </div>
        {events.length > 0 && (
          <div className="export-actions">
            <button
              type="button"
              className="btn-export"
              onClick={() => setAbsoluteTime(!absoluteTime)}
              title={absoluteTime ? 'Show relative timestamps' : 'Show absolute timestamps'}
            >
              {absoluteTime ? 'Relative time' : 'Absolute time'}
            </button>
            <button type="button" className="btn-export" onClick={exportJson} title="Export current events as JSON">
              Export JSON
            </button>
            <button type="button" className="btn-export" onClick={exportCsv} title="Export current events as CSV">
              Export CSV
            </button>
          </div>
        )}
      </div>

      <ErrorBoundary title="Event Table Error">
        <EventTable
          events={events}
          showContract={showContract}
          loading={loading}
          expandedEventId={expandedEventId}
          onToggleExpand={toggleExpanded}
          onTopicClick={(topic) => setFilters({ ...filters, topic })}
          absolute={absoluteTime}
          emptyMessage={
            contractUnknown
              ? 'This contract has not been seen by this indexer. Check the id, and that it is one this instance indexes (LENS_CONTRACT_IDS).'
              : emptyReason === 'no_matching_events'
                ? 'This contract is indexed, but no events match these filters.'
                : health && health.events === 0
                  ? 'Nothing indexed yet. Start the indexer, or load the fixture with `npm run seed`.'
                  : 'No events match these filters.'
          }
        />
      </ErrorBoundary>

      {nextCursor && (
        <button type="button" className="load-more" onClick={loadMore} disabled={loadingMore}>
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}

      <footer className="app-footer">
        <span>Soroban Lens — a reading lens for Soroban contract events.</span>
        <a href="https://github.com/soroban-forge-labs/soroban-lens">Source</a>
      </footer>
    </main>
  );
}
