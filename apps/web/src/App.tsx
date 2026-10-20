import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiRequestError, buildStreamPath, configuredNetworks } from './api.js';
import type { ContractActivity, ContractSummary, Health, LensEvent, TopicCount } from './types.js';
import { Filters, type FilterState } from './components/Filters.js';
import { ActivityChart } from './components/ActivityChart.js';
import { EventTable } from './components/EventTable.js';
import { StatusBar } from './components/StatusBar.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { usePersistentState, usePolling, useDebounced, useEventStream, useTheme } from './hooks.js';

/** Testnet Stellar Asset Contract for native XLM — always emitting events. */
const EXAMPLE_CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'; // XLM SAC
const PAGE_SIZE = 50;
const LIVE_INTERVAL_MS = 5000;
const CONTRACT_ID_PATTERN = /^C[A-Z2-7]{55}$/;
const ACTIVITY_DAYS = 30;
const SECONDS_PER_DAY = 24 * 60 * 60;

interface ActivityRange {
  fromTime: string;
  toTime: string;
  fromLedger: number;
  toLedger: number;
}

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
  const [contracts, setContracts] = useState<ContractSummary[]>([]);
  const [contractsError, setContractsError] = useState<string | null>(null);
  const [activity, setActivity] = useState<ContractActivity | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityRange, setActivityRange] = useState<ActivityRange | null>(null);
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
  const contractInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== '/' || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      ) {
        return;
      }
      event.preventDefault();
      contractInputRef.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setContracts([]);
    setContractsError(null);
    api.contracts(selected.baseUrl, controller.signal)
      .then(({ contracts: available }) => {
        setContracts(available);
        setContractsError(null);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setContracts([]);
        setContractsError(err instanceof ApiRequestError ? err.message : String(err));
      });
    return () => controller.abort();
  }, [selected.baseUrl]);

  useEffect(() => {
    setActivityRange(null);
  }, [selected.baseUrl]);

  // Typing a 56-character contract id should not fire 56 requests.
  const debouncedContractId = useDebounced(filters.contractId, 300);
  const debouncedTopic = useDebounced(filters.topic, 300);

  const contractIdValid = debouncedContractId === '' || CONTRACT_ID_PATTERN.test(debouncedContractId);
  const query = useMemo(
    () => ({
      ...(contractIdValid && debouncedContractId ? { contractId: debouncedContractId } : {}),
      ...(debouncedTopic ? { topics: [debouncedTopic] } : {}),
      ...(filters.successfulOnly ? { successfulOnly: true } : {}),
      ...(activityRange
        ? { fromLedger: activityRange.fromLedger, toLedger: activityRange.toLedger }
        : {}),
      ...(activityRange ? { fromTime: activityRange.fromTime, toTime: activityRange.toTime } : {}),
      limit: PAGE_SIZE,
    }),
    [contractIdValid, debouncedContractId, debouncedTopic, filters.successfulOnly, activityRange],
  );

  const contractSummary = contracts.find((contract) => contract.contractId === debouncedContractId);
  const activityWindow = useMemo(() => {
    if (!contractSummary) return null;
    const lastSeen = Date.parse(contractSummary.lastSeenAt);
    if (!Number.isFinite(lastSeen)) return null;
    const finalDay = Math.floor(lastSeen / (SECONDS_PER_DAY * 1000)) * SECONDS_PER_DAY;
    return {
      from: finalDay - (ACTIVITY_DAYS - 1) * SECONDS_PER_DAY,
      to: finalDay + SECONDS_PER_DAY - 1,
    };
  }, [contractSummary]);

  useEffect(() => {
    if (!contractIdValid || !debouncedContractId || !activityWindow) {
      setActivity(null);
      setActivityError(
        contractSummary && !activityWindow ? 'The indexed contract has an invalid last-activity time.' : null,
      );
      setActivityLoading(false);
      return;
    }

    const controller = new AbortController();
    setActivityLoading(true);
    setActivity(null);
    setActivityError(null);
    api.activity(
      selected.baseUrl,
      debouncedContractId,
      {
        bucket: 'day',
        ...activityWindow,
        ...(debouncedTopic ? { topics: [debouncedTopic] } : {}),
        ...(filters.successfulOnly ? { successfulOnly: true } : {}),
      },
      controller.signal,
    )
      .then((result) => {
        setActivity(result);
        setActivityError(null);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setActivity(null);
        setActivityError(err instanceof ApiRequestError ? err.message : String(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setActivityLoading(false);
      });
    return () => controller.abort();
  }, [
    selected.baseUrl,
    contractIdValid,
    debouncedContractId,
    debouncedTopic,
    filters.successfulOnly,
    activityWindow,
    contractSummary,
  ]);

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

  // When the query or network changes, fetch fresh data but keep the old rows
  // on screen until the new ones arrive.
  useEffect(() => {
    if (!contractIdValid) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setNextCursor(null);
    void loadFirstPage();
  }, [loadFirstPage, contractIdValid]);

  // Live updates arrive over SSE; polling is the fallback for whenever the
  // stream is not open (before it connects, while the browser retries a drop,
  // or against an API that does not offer it).
  const streamUrl =
    filters.live && contractIdValid && !activityRange
      ? `${selected.baseUrl}${buildStreamPath(query)}`
      : null;
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
    filters.live && !streaming && !activityRange,
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
  const changeFilters = (next: FilterState): void => {
    if (
      next.contractId !== filters.contractId ||
      next.topic !== filters.topic ||
      next.successfulOnly !== filters.successfulOnly
    ) {
      setActivityRange(null);
    }
    setFilters(next);
  };

  const filterActivityBucket = (start: number, firstLedger: number, lastLedger: number): void => {
    const fromTime = new Date(start * 1000).toISOString();
    if (activityRange?.fromTime === fromTime) {
      setActivityRange(null);
      return;
    }
    setActivityRange({
      fromTime,
      toTime: new Date((start + SECONDS_PER_DAY - 1) * 1000).toISOString(),
      fromLedger: firstLedger,
      toLedger: lastLedger,
    });
  };

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
        <div>
          <h1>
            soroban<span className="accent">-lens</span>
          </h1>
          <p className="tagline">See what your Soroban contracts are actually emitting.</p>
        </div>
        <button
          type="button"
          className="theme-toggle"
          onClick={toggleTheme}
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
        >
          {theme === 'dark' ? 'Light mode' : 'Dark mode'}
        </button>
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
          onChange={changeFilters}
          knownTopics={topics}
          knownContracts={contracts}
          contractsError={contractsError}
          contractInputRef={contractInputRef}
          onUseExample={() => changeFilters({ ...filters, contractId: EXAMPLE_CONTRACT })}
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
          {filters.live && !activityRange && <span
              className="live-dot"
              title={streaming ? 'Streaming live updates' : 'Polling every 5 seconds'}
            >
              live
            </span>}
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

      {contractIdValid && debouncedContractId && activityWindow && (
        <section className="activity-panel" aria-label="Event activity">
          {activityError ? (
            <p className="warning" role="alert">Could not load activity chart: {activityError}</p>
          ) : activityLoading && !activity ? (
            <p className="muted small" role="status">Loading activity…</p>
          ) : activity ? (
            <ActivityChart
              activity={activity}
              from={activityWindow.from}
              to={activityWindow.to}
              selectedFrom={activityRange?.fromTime ?? null}
              onBucketClick={filterActivityBucket}
            />
          ) : null}
        </section>
      )}

      <ErrorBoundary title="Event Table Error">
        <EventTable
          events={events}
          showContract={showContract}
          loading={loading}
          onTopicClick={(topic) => changeFilters({ ...filters, topic })}
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
