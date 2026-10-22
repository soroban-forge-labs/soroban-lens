import { useCallback, useEffect, useRef, useState } from 'react';
import type { UrlState } from './route.js';
import { parseUrl, stringifyUrl, sameFilterView } from './route.js';

/**
 * Re-run `tick` on an interval, and once immediately.
 *
 * Pauses while the tab is hidden: a background tab polling an indexer every few
 * seconds is pure waste, and it produces a confusing burst of updates when the
 * user comes back.
 */
export function usePolling(tick: () => void, intervalMs: number, enabled: boolean): void {
  const saved = useRef(tick);
  saved.current = tick;

  useEffect(() => {
    if (!enabled) return;

    let timer: number | undefined;
    const run = (): void => {
      if (!document.hidden) saved.current();
    };

    run();
    timer = window.setInterval(run, intervalMs);

    const onVisible = (): void => {
      if (!document.hidden) run();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      if (timer !== undefined) window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [intervalMs, enabled]);
}

/**
 * Subscribe to a Server-Sent Events stream.
 *
 * `connected` is true only while the stream is open, so a caller can run its
 * polling fallback exactly when it is false: before the first connection, while
 * the browser is retrying after a drop, and for good when there is no
 * `EventSource` at all. The browser reconnects on its own and resends
 * `Last-Event-ID`, so events missed during a drop are replayed, not lost.
 */
export function useEventStream(
  url: string | null,
  onMessage: (data: string, id: string) => void,
  onOpen: () => void,
): boolean {
  const [connected, setConnected] = useState(false);
  const savedMessage = useRef(onMessage);
  savedMessage.current = onMessage;
  const savedOpen = useRef(onOpen);
  savedOpen.current = onOpen;

  useEffect(() => {
    if (!url || typeof EventSource === 'undefined') {
      setConnected(false);
      return;
    }
    const source = new EventSource(url);
    source.onopen = (): void => {
      setConnected(true);
      savedOpen.current();
    };
    source.onmessage = (message: MessageEvent<string>): void => {
      savedMessage.current(message.data, message.lastEventId);
    };
    // CONNECTING means the browser is already retrying; CLOSED means it gave up
    // (e.g. a 4xx on connect), and polling carries on alone.
    source.onerror = (): void => setConnected(false);

    return () => {
      source.close();
      setConnected(false);
    };
  }, [url]);

  return connected;
}

/** Debounce a rapidly-changing value, so typing a contract id fires one request. */
export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** Persist a piece of UI state in localStorage, surviving a reload. */
export function usePersistentState<T>(key: string, initial: T): [T, (value: T) => void] {
  const [state, setState] = useState<T>(() => {
    try {
      const stored = window.localStorage.getItem(key);
      return stored === null ? initial : (JSON.parse(stored) as T);
    } catch {
      return initial;
    }
  });

  const set = useCallback(
    (value: T) => {
      setState(value);
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
      } catch {
        // Private browsing or a full quota. Losing a remembered contract id is
        // not worth breaking the page over.
      }
    },
    [key],
  );

  return [state, set];
}

/**
 * Sync view state with the URL, using `localStorage` as the fallback for a bare
 * visit (no query params and no `/events/{id}` path).
 *
 * Filter changes (contract, topic, successfulOnly, live, network) push a new
 * history entry so back/forward move through filter history. Expanding or
 * collapsing an event replaces the current entry — that is navigation within
 * the same view, not a new view.
 *
 * On popstate (back/forward), the state is re-read from the URL.
 */
export function useUrlState(
  initial: UrlState,
  storageKeys: { filters: string; network: string },
): [UrlState, (next: UrlState) => void] {
  const [state, setState] = useState<UrlState>(() => {
    const parsed = parseUrl(window.location.pathname, window.location.search);
    if (parsed) {
      // A shared link — fill in defaults the URL omitted.
      return {
        filters: {
          contractId: parsed.filters.contractId,
          topic: parsed.filters.topic,
          successfulOnly: parsed.filters.successfulOnly,
          live: parsed.filters.live,
          fromLedger: parsed.filters.fromLedger,
          toLedger: parsed.filters.toLedger,
        },
        network: parsed.network || initial.network,
        expandedEventId: parsed.expandedEventId,
      };
    }
    // Bare visit: restore from localStorage, falling back to the defaults.
    let restored = initial;
    try {
      const f = window.localStorage.getItem(storageKeys.filters);
      const n = window.localStorage.getItem(storageKeys.network);
      if (f || n) {
        restored = {
          // Merge over the defaults: filters saved before a field existed
          // (e.g. fromLedger/toLedger) must not come back undefined.
          filters: f ? { ...initial.filters, ...(JSON.parse(f) as Partial<UrlState['filters']>) } : initial.filters,
          network: n ? (JSON.parse(n) as string) : initial.network,
          expandedEventId: null,
        };
      }
    } catch {
      // Corrupted localStorage — use defaults.
    }
    return restored;
  });

  // Track the previous state to decide push vs replace.
  const prev = useRef(state);

  const update = useCallback(
    (next: UrlState): void => {
      const url = stringifyUrl(next);
      // Filter/network changes create a new history entry; expansion-only
      // changes replace the current one.
      if (sameFilterView(prev.current, next)) {
        window.history.replaceState(next, '', url);
      } else {
        window.history.pushState(next, '', url);
        // Persist to localStorage so a future bare visit restores this view.
        try {
          window.localStorage.setItem(storageKeys.filters, JSON.stringify(next.filters));
          window.localStorage.setItem(storageKeys.network, JSON.stringify(next.network));
        } catch {
          // Private browsing or quota — the URL is the source of truth now.
        }
      }
      prev.current = next;
      setState(next);
    },
    [storageKeys.filters, storageKeys.network],
  );

  // Listen for back/forward navigation.
  useEffect(() => {
    const onPopState = (): void => {
      const parsed = parseUrl(window.location.pathname, window.location.search);
      const next: UrlState = parsed ?? {
        filters: { contractId: '', topic: '', successfulOnly: false, live: true, fromLedger: '', toLedger: '' },
        network: '',
        expandedEventId: null,
      };
      // Fill defaults the URL omitted.
      if (!next.network) next.network = prev.current.network;
      prev.current = next;
      setState(next);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // Replace the initial URL on mount so the address bar reflects the state
  // (e.g. a bare visit with localStorage values gets query params written in).
  useEffect(() => {
    const url = stringifyUrl(state);
    if (url !== window.location.pathname + window.location.search) {
      window.history.replaceState(state, '', url);
    }
    // Only on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return [state, update];
}

export type Theme = 'light' | 'dark';

function systemTheme(): Theme {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * The active theme, and a toggle that overrides the system setting in either
 * direction. With no saved choice the system setting wins (the CSS handles that
 * on its own); an explicit choice is written to `data-theme`, which the
 * stylesheet and the pre-paint script in index.html both read.
 */
export function useTheme(): [Theme, () => void] {
  const [saved, setSaved] = usePersistentState<Theme | null>('lens.theme', null);
  const [system, setSystem] = useState<Theme>(systemTheme);

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!media) return;
    const onChange = (): void => setSystem(media.matches ? 'dark' : 'light');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (saved) document.documentElement.setAttribute('data-theme', saved);
    else document.documentElement.removeAttribute('data-theme');
  }, [saved]);

  const theme = saved ?? system;
  const toggle = useCallback(() => setSaved(theme === 'dark' ? 'light' : 'dark'), [theme, setSaved]);
  return [theme, toggle];
}

export type TimestampFormat = 'relative' | 'absolute';

/**
 * Whether timestamps are shown as relative ("3h ago") or absolute.
 *
 * Persisted so the choice survives a reload, and shared by every row through
 * the context that consumes it, so the toggle flips the whole table at once.
 */
export function useTimestampFormat(): [TimestampFormat, () => void] {
  const [format, setFormat] = usePersistentState<TimestampFormat>('lens.timestampFormat', 'relative');
  const toggle = useCallback(
    () => setFormat(format === 'relative' ? 'absolute' : 'relative'),
    [format, setFormat],
  );
  return [format, toggle];
}
