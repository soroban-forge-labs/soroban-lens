import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiRequestError, buildStreamPath, configuredNetworks } from './api.js';
import type { Health, LensEvent, TopicCount } from './types.js';
import { Filters, type FilterState } from './components/Filters.js';
import { EventTable } from './components/EventTable.js';
import { StatusBar } from './components/StatusBar.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { usePersistentState, usePolling, useDebounced, useEventStream, useTheme } from './hooks.js';
import { LocaleProvider, useLocale, LOCALE_CODES, LOCALE_LABELS } from './i18n/index.js';

/** Testnet Stellar Asset Contract for native XLM — always emitting events. */
const EXAMPLE_CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMPQVUU2HHGCYSC'; // XLM SAC
const PAGE_SIZE = 50;
const LIVE_INTERVAL_MS = 5000;
const CONTRACT_ID_PATTERN = /^C[A-Z2-7]{55}$/;

// ── Inner app (needs locale context) ──────────────────────────────────────────

function AppInner(): React.JSX.Element {
  const { t, locale, setLocale } = useLocale();
  const networks = useMemo(configuredNetworks, []);
  const [networkLabel, setNetworkLabel] = usePersistentState('lens.network', networks[0]!.label);
  const selected = networks.find((n) => n.label === networkLabel) ?? networks[0]!;

  // ---------- URL-based shareable state (#63, #68) ----------
  // On first load, prefer URL search params over localStorage so that a shared
  // link always wins. After that, keep URL and localStorage in sync.
  const [filters, setFiltersRaw] = usePersistentState<FilterState>('lens.filters', (() => {
    const sp = new URLSearchParams(window.location.search);
    return {
      contractId: sp.get('contractId') ?? '',
      topic: sp.get('topic') ?? '',
      successfulOnly: sp.get('successfulOnly') === 'true',
      live: sp.has('live') ? sp.get('live') === 'true' : true,
      fromLedger: sp.get('fromLedger') ?? '',
      toLedger: sp.get('toLedger') ?? '',
    };
  })());

  /** Update filter state and push the new params into the URL bar. */
  const setFilters = useCallback(
    (next: FilterState) => {
      setFiltersRaw(next);
      const sp = new URLSearchParams();
      if (next.contractId) sp.set('contractId', next.contractId);
      if (next.topic) sp.set('topic', next.topic);
      if (next.successfulOnly) sp.set('successfulOnly', 'true');
      if (!next.live) sp.set('live', 'false');
      if (next.fromLedger) sp.set('fromLedger', next.fromLedger);
      if (next.toLedger) sp.set('toLedger', next.toLedger);
      const qs = sp.toString();
      const newUrl = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
      window.history.pushState(null, '', newUrl);
    },
    [setFiltersRaw],
  );

  // Restore filter state when the user navigates with back/forward.
  useEffect(() => {
    const onPopState = (): void => {
      const sp = new URLSearchParams(window.location.search);
      setFiltersRaw({
        contractId: sp.get('contractId') ?? '',
        topic: sp.get('topic') ?? '',
        successfulOnly: sp.get('successfulOnly') === 'true',
        live: sp.has('live') ? sp.get('live') === 'true' : true,
        fromLedger: sp.get('fromLedger') ?? '',
        toLedger: sp.get('toLedger') ?? '',
      });
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [setFiltersRaw]);

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
    const blob = new Blob([csvSontent], { type: 'text/csv;charset=utf-8;' });
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
            title={theme === 'dark' ? t('switchToLight') : t('switchToDark')}
          >
            {theme === 'dark' ? t('switchToLight') : t('switchToDark')}
          </button>
        </div>
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
          {filters.live && (
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
              title={absoluteTime ? t('showRelativeTimes') : t('showAbsoluteTimes')}
            >
              {absoluteTime ? t('relativeTime') : t('absoluteTime')}
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

      <ErrorBoundary title="Event Table Error">
        <EventTable
          events={events}
          showContract={showContract}
          loading={loading}
          onTopicClick={(topic) => setFilters({ ...filters, topic })}
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
          {loadingMore ? t('loadingMore') : t('loadMore')}
        </button>
      )}

      <footer className="app-footer">
        <span>{t('footerTagline')}</span>
        <a href="https://github.com/soroban-forge-labs/soroban-lens">{t('sourceLink')}</a>
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
