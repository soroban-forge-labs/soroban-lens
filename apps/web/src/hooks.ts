import { useCallback, useEffect, useRef, useState } from 'react';

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
