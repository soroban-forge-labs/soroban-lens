import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiRequestError, buildStreamPath, configuredNetworks } from './api.js';
import type { ContractActivity, ContractSummary, EventPage, Health, IndexerStatus, LensEvent, TopicCount } from './types.js';
import { createLatestGate } from './requests.js';
import { mergeLivePage } from './live.js';
import { describeEmptyState } from './emptyState.js';
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
/** Health refreshes on its own slower cadence, not on every live tick (#195). */
const HEALTH_INTERVAL_MS = 30_000;
/** Account or contract StrKey — the shape the API's `address=` accepts (#188). */
const ADDRESS_PATTERN = /^[GC][A-Z2-7]{55}$/;
const TIME_PRESET_SECONDS: Record<string, number> = { '15m': 15 * 60, '1h': 60 * 60, '24h': 24 * 60 * 60 };
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
      filters: { contractId: '', topic: '', address: '', search: '', successfulOnly: false, live: true, fromLedger: '', toLedger: '', timeRange: '', customFromTime: '', customToTime: '' },
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
  // Latest loaded rows for callbacks that must not take `events` as a dep.
  const eventsRef = useRef<LensEvent[]>([]);
  eventsRef.current = events;
  const [expandedEventIds, setExpandedEventIds] = useState<Set<string>>(
    () => new Set(expandedEventId ? [expandedEventId] : []),
  );
  // A deep link (or back/forward) to /events/{id} opens that row.
  useEffect(() => {
    if (!expandedEventId) return;
    setExpandedEventIds((current) => (current.has(expandedEventId) ? current : new Set(current).add(expandedEventId)));
  }, [expandedEventId]);
  const [total, setTotal] = useState(0);
  // True when `total` came from the store's count cache rather than a fresh
  // COUNT(*) — shown as "about N" because it can lag a few seconds behind.
  const [totalIsEstimate, setTotalIsEstimate] = useState(false);
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
  // Indexer progress and why the last events request failed, for #78's empty
  // state: an empty table means different things depending on both.
  const [indexerStatus, setIndexerStatus] = useState<IndexerStatus | null>(null);
  const [loadErrorStatus, setLoadErrorStatus] = useState<number | null>(null);
  // "Load more" failures stay next to the button (#196) — the main banner is
  // for first-page failures, where the rows on screen are still fine.
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [theme, toggleTheme] = useTheme();
  // Absolute vs relative timestamps in the Ledger column. Persisted so the
  // choice survives a reload, like the theme.
  const [absoluteTime, setAbsoluteTime] = usePersistentState('lens.absoluteTime', false);

  // #195: /health and /status share one refresh on their own interval; a new
  // call aborts the previous in-flight one so back-to-back triggers stay cheap.
  const healthAbort = useRef<AbortController | null>(null);
  const refreshHealth = useCallback((): void => {
    healthAbort.current?.abort();
    const controller = new AbortController();
    healthAbort.current = controller;
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
    // Refreshed with health, so "catching up" turns into results (or into
    // "never ran") without a reload.
    api
      .status(selected.baseUrl, controller.signal)
      .then(setIndexerStatus)
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setIndexerStatus(null);
      });
  }, [selected.baseUrl]);

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
  const debouncedAddress = useDebounced(filters.address, 300);
  const debouncedSearch = useDebounced(filters.search, 300);

  const contractIdValid = debouncedContractId === '' || CONTRACT_ID_PATTERN.test(debouncedContractId);
  const addressValid = debouncedAddress === '' || ADDRESS_PATTERN.test(debouncedAddress);
  // #189: the store treats a 1–2 char term as "match nothing", so a partial
  // term shows the inline hint and does not send a request at all.
  const searchReady = debouncedSearch === '' || debouncedSearch.length >= 3;

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

  // #190: preset windows convert to epoch seconds at query time; a custom
  // range parses ISO-8601 or epoch seconds like the tail filter does.
  const parseTimeBound = useCallback((raw: string): number | undefined => {
    const v = raw.trim();
    if (!v) return undefined;
    if (/^-?\d+$/.test(v)) return Number(v);
    const parsed = Date.parse(v);
    return Number.isNaN(parsed) ? undefined : Math.floor(parsed / 1000);
  }, []);
  const timeBounds = useMemo(() => {
    const presetSeconds = TIME_PRESET_SECONDS[filters.timeRange];
    if (presetSeconds !== undefined) {
      const now = Math.floor(Date.now() / 1000);
      return { fromTime: String(now - presetSeconds), toTime: String(now) };
    }
    if (filters.timeRange === 'custom') {
      const from = parseTimeBound(filters.customFromTime);
      const to = parseTimeBound(filters.customToTime);
      return {
        ...(from !== undefined ? { fromTime: String(from) } : {}),
        ...(to !== undefined ? { toTime: String(to) } : {}),
      };
    }
    return {};
  }, [filters.timeRange, filters.customFromTime, filters.customToTime, parseTimeBound]);
  const timeRangeLabel =
    filters.timeRange === 'custom'
      ? 'custom range'
      : filters.timeRange
        ? `last ${filters.timeRange}`
        : null;

  const query = useMemo(
    () => ({
      ...(contractIdValid && debouncedContractId ? { contractId: debouncedContractId } : {}),
      ...(debouncedTopic ? { topics: [debouncedTopic] } : {}),
      ...(addressValid && debouncedAddress ? { address: debouncedAddress } : {}),
      ...(searchReady && debouncedSearch ? { search: debouncedSearch } : {}),
      ...(filters.successfulOnly ? { successfulOnly: true } : {}),
      ...timeBounds,
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
    [contractIdValid, debouncedContractId, debouncedTopic, addressValid, debouncedAddress, searchReady, debouncedSearch, filters.successfulOnly, fromLedgerNum, toLedgerNum, activityRange, timeBounds],
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

  // Stops a slow response for an old filter overwriting a newer one.
  const requestGate = useRef(createLatestGate());

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

  // Shared tail of every first-page-style request: a fresh page replaces the
  // summary state, and a 404 on a contract means this indexer never saw it.
  const applyPageState = useCallback((page: EventPage): void => {
    setTotal(page.total);
    setTotalIsEstimate(page.totalIsEstimate ?? false);
    setContractUnknown(false);
    setEmptyReason(page.emptyReason ?? null);
    setError(null);
    setLoadErrorStatus(null);
    setLoadMoreError(null);
    setLastUpdated(Date.now());
  }, []);

  const handlePageError = useCallback(
    (err: unknown): void => {
      // ApiRequestError status 0 is "no response"; anything else threw after one.
      setLoadErrorStatus(err instanceof ApiRequestError ? err.status : -1);
      if (err instanceof ApiRequestError && err.status === 404 && query.contractId) {
        setEvents([]);
        setTotal(0);
        setTotalIsEstimate(false);
        setNextCursor(null);
        setContractUnknown(true);
        setEmptyReason(null);
        setError(null);
        setLoadErrorStatus(null);
        setLastUpdated(Date.now());
        return;
      }
      setError(err instanceof ApiRequestError ? err.message : String(err));
      // #195: a failed request is exactly when the status bar is stale, so
      // health refreshes right away rather than waiting for its interval.
      refreshHealth();
    },
    [query.contractId, refreshHealth],
  );

  const loadFirstPage = useCallback(async (): Promise<void> => {
    if (!contractIdValid || !ledgerRangeValid || !addressValid || !searchReady) return;
    const isCurrent = requestGate.current.begin();
    try {
      const page = await api.events(selected.baseUrl, query);
      if (!isCurrent()) return;
      setEvents(page.events);
      setNextCursor(page.nextCursor);
      applyPageState(page);
    } catch (err) {
      if (!isCurrent()) return;
      handlePageError(err);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [selected.baseUrl, query, contractIdValid, ledgerRangeValid, addressValid, searchReady, applyPageState, handlePageError]);

  // #186: a live tick re-reads page one but must not throw away rows the
  // reader pulled in with "Load more". New ids land at the top; every loaded
  // row stays put, and nextCursor keeps pointing past the oldest one.
  const pollPage = useCallback(async (): Promise<void> => {
    if (!contractIdValid || !ledgerRangeValid || !addressValid || !searchReady) return;
    const isCurrent = requestGate.current.begin();
    try {
      const page = await api.events(selected.baseUrl, query);
      if (!isCurrent()) return;
      const freshLoad = eventsRef.current.length === 0;
      setEvents((current) => mergeLivePage(current, page.events));
      // When rows are already loaded the cursor stays put: it points past
      // the oldest row, and page one's cursor would strand the deeper pages.
      if (freshLoad) setNextCursor(page.nextCursor);
      applyPageState(page);
    } catch (err) {
      if (!isCurrent()) return;
      handlePageError(err);
    }
  }, [selected.baseUrl, query, contractIdValid, ledgerRangeValid, addressValid, searchReady, applyPageState, handlePageError]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreError(null);
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
      setTotalIsEstimate(page.totalIsEstimate ?? false);
    } catch (err) {
      setLoadMoreError(err instanceof ApiRequestError ? err.message : String(err));
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
    if (!contractIdValid || !ledgerRangeValid || !addressValid || !searchReady) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setNextCursor(null);
    void loadFirstPage();
  }, [loadFirstPage, contractIdValid, ledgerRangeValid, addressValid, searchReady]);

  // Live updates arrive over SSE; polling is the fallback for whenever the
  // stream is not open (before it connects, while the browser retries a drop,
  // or against an API that does not offer it).
  const streamUrl =
    filters.live && contractIdValid && addressValid && searchReady && !activityRange
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
    // A stream only carries events from now on, so catch up on connect —
    // merged, so rows loaded with "Load more" survive the resync (#186).
    () => {
      void pollPage();
    },
  );

  usePolling(
    () => {
      void pollPage();
    },
    LIVE_INTERVAL_MS,
    filters.live && !streaming && !activityRange,
  );

  // #195: health/status run on their own slower cadence — refreshing on every
  // live tick made the API answer /health as often as /events.
  useEffect(() => {
    refreshHealth();
    return () => healthAbort.current?.abort();
  }, [refreshHealth]);
  usePolling(refreshHealth, HEALTH_INTERVAL_MS, true);

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
      next.address !== filters.address ||
      next.search !== filters.search ||
      next.successfulOnly !== filters.successfulOnly ||
      next.timeRange !== filters.timeRange ||
      next.customFromTime !== filters.customFromTime ||
      next.customToTime !== filters.customToTime
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
      return t(totalIsEstimate ? 'eventCountForContractWithTopicEstimate' : 'eventCountForContractWithTopic', { count, suffix, topic: debouncedTopic });
    }
    if (query.contractId) {
      return t(totalIsEstimate ? 'eventCountForContractEstimate' : 'eventCountForContract', { count, suffix });
    }
    if (debouncedTopic) {
      return t(totalIsEstimate ? 'eventCountWithTopicEstimate' : 'eventCountWithTopic', { count, suffix, topic: debouncedTopic });
    }
    return t(totalIsEstimate ? 'eventCountEstimate' : 'eventCount', { count, suffix });
  })();

  // ── Empty message ─────────────────────────────────────────────────────────────
  const empty = describeEmptyState({ loadErrorStatus, status: indexerStatus, contractUnknown, emptyReason });
  const emptyMessage = t(empty.key, empty.vars);

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
            // The accessible name must contain the visible label (axe
            // label-content-name-mismatch), so the action follows it here.
            aria-label={`${theme === 'dark' ? t('lightMode') : t('darkMode')} — ${theme === 'dark' ? t('switchToLight') : t('switchToDark')}`}
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

      {!addressValid && (
        <p className="warning banner">{t('invalidAddress')}</p>
      )}

      {error && contractIdValid && (
        <p className="warning banner" role="alert">
          {error}
        </p>
      )}

      <div className="result-meta">
        <div className="result-meta-left">
          <span
            aria-live="polite"
            aria-atomic="true"
            title={totalIsEstimate ? t('eventCountEstimateTitle') : undefined}
          >
            {eventCountText}
          </span>
          {timeRangeLabel && !activityRange && (
            <span className="muted small" title={t('timeRangeActiveTitle')}>
              {timeRangeLabel}
            </span>
          )}
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
          onAddressClick={(address) => changeFilters({ ...filters, address })}
          onContractClick={(contractId) => changeFilters({ ...filters, contractId })}
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

      {loadMoreError && (
        <p className="warning" role="alert">
          {loadMoreError}{' '}
          <button type="button" className="link-button" onClick={() => void loadMore()}>
            {t('retry')}
          </button>
        </p>
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
