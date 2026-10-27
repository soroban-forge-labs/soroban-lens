import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiRequestError, buildStreamPath, configuredNetworks } from './api.js';
import type { ContractActivity, ContractSummary, Health, LensEvent, TopicCount } from './types.js';
import { Filters } from './components/Filters.js';
import type { FilterState } from './route.js';
import { ActivityChart } from './components/ActivityChart.js';
import { EventTable } from './components/EventTable.js';
import { EventCompare } from './components/EventCompare.js';
import { StatusBar } from './components/StatusBar.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { usePolling, useDebounced, useEventStream, usePersistentState, useUrlState, useTheme } from './hooks.js';
import { LocaleProvider, useLocale, LOCALE_CODES, LOCALE_LABELS } from './i18n/index.js';

/** Testnet Stellar Asset Contract for native XLM — always emitting events. */
const EXAMPLE_CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMPQVUU2HHGCYSC'; // XLM SAC
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

/** The `?compare=<id1>,<id2>` deep link, which opens two events in the diff view. */
function readCompareParam(): string[] {
  const raw = new URLSearchParams(window.location.search).get('compare');
  if (!raw) return [];
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .slice(0, 2);
}

// ── Inner app (needs locale context) ──────────────────────────────────────────

function AppInner(): React.JSX.Element {
  const { t, locale, setLocale } = useLocale();
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


  const [events, setEvents] = useState<LensEvent[]>([]);
  const [expandedEventIds, setExpandedEventIds] = useState<Set<string>>(
    () => new Set(expandedEventId ? [expandedEventId] : []),
  );
  // A deep link (or back/forward) to /events/{id} opens that row.
  useEffect(() => {
    if (!expandedEventId) return;
    setExpandedEventIds((current) => (current.has(expandedEventId) ? current : new Set(current).add(expandedEventId)));
  }, [expandedEventId]);
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
  // Absolute vs relative timestamps in the Ledger column. Persisted so the
  // choice survives a reload, like the theme.
  const [absoluteTime, setAbsoluteTime] = usePersistentState('lens.absoluteTime', false);

  // Ordered: the first ticked event is the left side of the comparison.
  const [selectedIds, setSelectedIds] = useState<string[]>(readCompareParam);
  const [comparePair, setComparePair] = useState<[LensEvent, LensEvent] | null>(null);
  const [compareError, setCompareError] = useState<string | null>(null);
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
      ...(activityRange
        ? {
            fromLedger: activityRange.fromLedger,
            toLedger: activityRange.toLedger,
            fromTime: activityRange.fromTime,
            toTime: activityRange.toTime,
          }
        : {
            ...(fromLedgerNum !== undefined ? { fromLedger: fromLedgerNum } : {}),
            ...(toLedgerNum !== undefined ? { toLedger: toLedgerNum } : {}),
          }),
      limit: PAGE_SIZE,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [contractIdValid, debouncedContractId, debouncedTopic, filters.successfulOnly, fromLedgerNum, toLedgerNum, activityRange],
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

  const toggleSelect = useCallback((id: string): void => {
    setSelectedIds((current) => {
      if (current.includes(id)) return current.filter((x) => x !== id);
      // Exactly two events compare at once; a third pick replaces the older one.
      return [...current, id].slice(-2);
    });
  }, []);

  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  // The selection lives in the URL so a comparison can be shared as a link.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (selectedIds.length === 2) url.searchParams.set('compare', selectedIds.join(','));
    else url.searchParams.delete('compare');
    // Keep the router's history state, and re-apply after any URL change,
    // since filter and expand updates rewrite the query string.
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }, [selectedIds, urlState]);

  // Both events come from the loaded page when they can; a deep link fetches
  // them by id, since the two being compared are often far outside page one.
  useEffect(() => {
    if (selectedIds.length !== 2) {
      setComparePair(null);
      setCompareError(null);
      return;
    }
    const firstId = selectedIds[0];
    const secondId = selectedIds[1];
    if (!firstId || !secondId) return;
    const loadedFirst = events.find((e) => e.id === firstId);
    const loadedSecond = events.find((e) => e.id === secondId);
    if (loadedFirst && loadedSecond) {
      setComparePair([loadedFirst, loadedSecond]);
      return;
    }
    let cancelled = false;
    void Promise.all([api.event(selected.baseUrl, firstId), api.event(selected.baseUrl, secondId)])
      .then(([a, b]) => {
        if (cancelled) return;
        setComparePair([a, b]);
        setCompareError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setComparePair(null);
        setCompareError(err instanceof ApiRequestError ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedIds, events, selected.baseUrl]);

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

  const toggleEventExpanded = useCallback((eventId: string) => {
    const opening = !expandedEventIds.has(eventId);
    const next = new Set(expandedEventIds);
    if (opening) next.add(eventId);
    else next.delete(eventId);
    setExpandedEventIds(next);
    // The URL names the most recently opened event, so a copied link opens it.
    if (opening) setUrlState({ ...urlState, expandedEventId: eventId });
    else if (urlState.expandedEventId === eventId) setUrlState({ ...urlState, expandedEventId: null });
  }, [expandedEventIds, urlState, setUrlState]);

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
      `"${e.topics.map((tc) => JSON.stringify(tc.value)).join(' | ').replace(/"/g, '""')}"`,
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

  // ── Event count line ─────────────────────────────────────────────────────────
  const suffix = total === 1 ? '' : 's';
  const eventCountText = (() => {
    const count = total.toLocaleString();
    if (query.contractId && debouncedTopic) {
      return t('eventCountForContractWithTopic', { count, suffix, topic: debouncedTopic });
    }
    if (query.contractId) {
      return t('eventCountForContract', { count, suffix });
    }
    if (debouncedTopic) {
      return t('eventCountWithTopic', { count, suffix, topic: debouncedTopic });
    }
    return t('eventCount', { count, suffix });
  })();

  // ── Empty message ─────────────────────────────────────────────────────────────
  const emptyMessage = contractUnknown
    ? t('emptyContractUnknown')
    : emptyReason === 'no_matching_events'
      ? t('emptyNoMatchingEvents')
      : health && health.events === 0
        ? t('emptyNothingIndexed')
        : t('emptyNoResults');

  return (
    <main className="app">
      <header className="app-header">
        <div>
          <h1>
            soroban <span className="accent">-</span>lens
          </h1>
          <p className="tagline">{t('tagline')}</p>
        </div>
        <div className="header-controls">
          {/* ── Locale switcher ── */}
          <div className="locale-switcher">
            <label htmlFor="locale-select" className="sr-only">{t('language')}</label>
            <select
              id="locale-select"
              value={locale}
              onChange={(e) => setLocale(e.target.value as typeof locale)}
              aria-label={t('language')}
            >
              {LOCALE_CODES.map((code) => (
                <option key={code} value={code}>{LOCALE_LABELS[code]}</option>
              ))}
            </select>
          </div>

          {/* ── Theme toggle ── */}
          <button
            type="button"
            className="theme-toggle"
            onClick={toggleTheme}
            aria-label={theme === 'dark' ? t('switchToLight') : t('switchToDark')}
            title={theme === 'dark' ? t('switchToLight') : t('switchToDark')}
          >
            {theme === 'dark' ? t('lightMode') : t('darkMode')}
          </button>
        </div>
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
          onChange={changeFilters}
          knownTopics={topics}
          knownContracts={contracts}
          contractsError={contractsError}
          contractInputRef={contractInputRef}
          onUseExample={() => changeFilters({ ...filters, contractId: EXAMPLE_CONTRACT })}
        />
      </ErrorBoundary>

      {!contractIdValid && (
        <p className="warning banner">{t('invalidContractId')}</p>
      )}

      {error && contractIdValid && (
        <p className="warning banner" role="alert">
          {error}
        </p>
      )}

      <div className="result-meta">
        <div className="result-meta-left">
          <span aria-live="polite" aria-atomic="true">{eventCountText}</span>
          {filters.live && !activityRange && (
            <span
              className="live-dot"
              title={streaming ? t('streamingLive') : t('pollingFallback')}
            >
              {t('live')}
            </span>
          )}
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
            <button
              type="button"
              className="btn-export"
              onClick={exportJson}
              title={t('exportJsonTitle')}
            >
              {t('exportJson')}
            </button>
            <button
              type="button"
              className="btn-export"
              onClick={exportCsv}
              title={t('exportCsvTitle')}
            >
              {t('exportCsv')}
            </button>
          </div>
        )}
      </div>

      {selectedIds.length === 1 && (
        <div className="compare-bar">
          <span>
            One event selected — tick one more to compare. The selection is kept in
            the URL, so the comparison can be shared as a link.
          </span>
          <button type="button" className="btn-export" onClick={() => setSelectedIds([])}>
            Clear
          </button>
        </div>
      )}

      {selectedIds.length === 2 && compareError && (
        <p className="warning banner" role="alert">
          Cannot load the events to compare: {compareError}{' '}
          <button type="button" className="link-button" onClick={() => setSelectedIds([])}>
            Clear selection
          </button>
        </p>
      )}

      {selectedIds.length === 2 && !comparePair && !compareError && (
        <p className="compare-bar">Loading the events to compare…</p>
      )}

      {comparePair && (
        <ErrorBoundary title="Compare View Error">
          <EventCompare
            left={comparePair[0]}
            right={comparePair[1]}
            onClose={() => setSelectedIds([])}
          />
        </ErrorBoundary>
      )}

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
          network={selected.label}
          expandedEventIds={expandedEventIds}
          onToggleExpanded={toggleEventExpanded}
          showContract={showContract}
          loading={loading}
          selectedIds={selectedIdSet}
          onToggleSelect={toggleSelect}
          onTopicClick={(topic) => changeFilters({ ...filters, topic })}
          absolute={absoluteTime}
          emptyMessage={emptyMessage}
        />
      </ErrorBoundary>

      {nextCursor && (
        <button
          type="button"
          className="load-more"
          onClick={() => void loadMore()}
          disabled={loadingMore}
        >
          {loadingMore ? t('loadingMore') : t('loadMore', { count: PAGE_SIZE })}
        </button>
      )}

      <footer className="app-footer">
        <span>Soroban Lens — a reading lens for Soroban contract events.</span>
        <a href="https://github.com/soroban-forge-labs/soroban-lens">Source</a>
      </footer>
    </main>
  );
}

// ── Public export: wraps the inner app in LocaleProvider ─────────────────────

export function App(): React.JSX.Element {
  return (
    <LocaleProvider>
      <AppInner />
    </LocaleProvider>
  );
}
