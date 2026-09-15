import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Re-run `tick` on an interval, and once immediately.
 *
 * Pauses while the tab is hidden: a background tab polling an indexer every two
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
