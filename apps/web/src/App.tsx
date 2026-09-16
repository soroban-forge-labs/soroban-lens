import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiRequestError, configuredNetworks } from './api.js';
import type { Health, LensEvent, TopicCount } from './types.js';
import { Filters, type FilterState } from './components/Filters.js';
import { EventTable } from './components/EventTable.js';
import { StatusBar } from './components/StatusBar.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { usePersistentState, usePolling, useDebounced } from './hooks.js';

/** Testnet Stellar Asset Contract for native XLM — always emitting events. */
const EXAMPLE_CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const PAGE_SIZE = 50;
const LIVE_INTERVAL_MS = 5000;
const CONTRACT_ID_PATTERN = /^C[A-Z2-7]{55}$/;

export function App(): React.JSX.Element {
  const networks = useMemo(configuredNetworks, []);
  const [networkLabel, setNetworkLabel] = usePersistentState('lens.network', networks[0]!.label);
  const selected = networks.find((n) => n.label === networkLabel) ?? networks[0]!;

  const [filters, setFilters] = usePersistentState<FilterState>('lens.filters', {
    contractId: '',
    topic: '',
    successfulOnly: false,
    live: true,
  });

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

  // Typing a 56-character contract id should not fire 56 requests.
  const debouncedContractId = useDebounced(filters.contractId, 300);
  const debouncedTopic = useDebounced(filters.topic, 300);

  const contractIdValid = debouncedContractId === '' || CONTRACT_ID_PATTERN.test(debouncedContractId);
  const query = useMemo(
    () => ({
      ...(contractIdValid && debouncedContractId ? { contractId: debouncedContractId } : {}),
      ...(debouncedTopic ? { topics: [debouncedTopic] } : {}),
      ...(filters.successfulOnly ? { successfulOnly: true } : {}),
      limit: PAGE_SIZE,
    }),
    [contractIdValid, debouncedContractId, debouncedTopic, filters.successfulOnly],
  );

  // Guards against a slow earlier response overwriting a newer one.
  const requestId = useRef(0);

  const loadFirstPage = useCallback(async (): Promise<void> => {
    if (!contractIdValid) return;
    const id = ++requestId.current;
    try {
      const page = await api.events(selected.baseUrl, query);
      if (id !== requestId.current) return;
      setEvents(page.events);
      setTotal(page.total);
      setNextCursor(page.nextCursor);
      setError(null);
      setLastUpdated(Date.now());
    } catch (err) {
      if (id !== requestId.current) return;
      setError(err instanceof ApiRequestError ? err.message : String(err));
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [selected.baseUrl, query, contractIdValid]);

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

  // Reset the page whenever the query or the network changes.
  useEffect(() => {
    setLoading(true);
    setEvents([]);
    setNextCursor(null);
    void loadFirstPage();
  }, [loadFirstPage]);

  usePolling(
    () => {
      void loadFirstPage();
    },
    LIVE_INTERVAL_MS,
    filters.live,
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
    const headers = ['id', 'ledger', 'ledger_closed_at', 'contract_id', 'tx_hash', 'in_successful_tx', 'topics', 'data'];
    const rows = events.map((e) => [
      e.id,
      e.ledger,
      e.ledgerClosedAt,
      e.contractId,
      e.txHash,
      e.inSuccessfulTx,
      `"${e.topics.map((t) => t.decodedJson ?? t.rawXdr).join(' | ').replace(/"/g, '""')}"`,
      `"${(e.data.decodedJson ?? e.data.rawXdr).replace(/"/g, '""')}"`,
    ]);
    const csvContent = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `soroban-events-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [events]);

  return (
    <div className="app">
      <header className="app-header">
        <h1>
          soroban<span className="accent">-lens</span>
        </h1>
        <p className="tagline">See what your Soroban contracts are actually emitting.</p>
      </header>

      <ErrorBoundary title="Status Bar Error">
        <StatusBar
          networks={networks}
          selected={selected}
          onSelect={(n) => setNetworkLabel(n.label)}
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
          <span>
            {total.toLocaleString()} event{total === 1 ? '' : 's'}
            {query.contractId ? ' for this contract' : ' indexed'}
            {debouncedTopic ? ` with topic "${debouncedTopic}"` : ''}
          </span>
          {filters.live && <span className="live-dot" title="Polling every 5 seconds">live</span>}
        </div>
        {events.length > 0 && (
          <div className="export-actions">
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
          onTopicClick={(topic) => setFilters({ ...filters, topic })}
          emptyMessage={
            health && health.events === 0
              ? 'Nothing indexed yet. Start the indexer, or load the fixture with `npm run seed`.'
              : 'No events match these filters.'
          }
        />
      </ErrorBoundary>

      {nextCursor && (
        <button type="button" className="load-more" onClick={() => void loadMore()} disabled={loadingMore}>
          {loadingMore ? 'Loading…' : `Load ${PAGE_SIZE} more`}
        </button>
      )}

      <footer className="app-footer">
        <span>Read-only explorer · v0.1</span>
        <a href={`${selected.baseUrl}/openapi.json`} target="_blank" rel="noreferrer">
          API spec
        </a>
      </footer>
    </div>
  );
}
