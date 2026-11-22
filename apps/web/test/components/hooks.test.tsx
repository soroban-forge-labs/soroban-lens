import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { usePersistentState, usePolling, restorePersisted } from '../../src/hooks.js';

afterEach(() => {
  window.localStorage.clear();
  vi.useRealTimers();
});

describe('restorePersisted (#194)', () => {
  it('an old-shaped blob gets missing keys defaulted and unknown keys dropped', () => {
    // Saved before `search` and `flag` existed / after `stale` was removed.
    const defaults = { contractId: '', search: '', flag: false };
    const stored = { contractId: 'CABC', stale: true, extra: 42 };
    expect(restorePersisted(stored, defaults)).toEqual({ contractId: 'CABC', search: '', flag: false });
  });

  it.each([['42'], ['"text"'], ['true'], ['[1,2]'], ['null']])(
    'garbage JSON value %s resets to the defaults',
    (bad) => {
      expect(restorePersisted(JSON.parse(bad), { a: 1 })).toEqual({ a: 1 });
    },
  );

  it('primitive state is kept only when the stored type matches', () => {
    expect(restorePersisted(true, false)).toBe(true);
    expect(restorePersisted('yes', false)).toBe(false);
  });
});

describe('usePersistentState (#194)', () => {
  it('renders with defaults filled in from an old-shaped stored value', () => {
    window.localStorage.setItem('lens.test-old', JSON.stringify({ contractId: 'CABC', retired: 'x' }));
    const { result } = renderHook(() =>
      usePersistentState('lens.test-old', { contractId: '', address: '', live: true }),
    );
    expect(result.current[0]).toEqual({ contractId: 'CABC', address: '', live: true });
  });

  it('a garbage stored value falls back to the defaults', () => {
    window.localStorage.setItem('lens.test-garbage', '42');
    const { result } = renderHook(() => usePersistentState('lens.test-garbage', { contractId: '' }));
    expect(result.current[0]).toEqual({ contractId: '' });
  });
});

describe('usePolling', () => {
  it('fires immediately and once per interval while enabled', () => {
    vi.useFakeTimers();
    let ticks = 0;
    renderHook(() => usePolling(() => { ticks += 1; }, 5000, true));
    expect(ticks).toBe(1);
    act(() => { vi.advanceTimersByTime(15_000); });
    expect(ticks).toBe(4);
  });

  it('does not fire while disabled', () => {
    vi.useFakeTimers();
    let ticks = 0;
    renderHook(() => usePolling(() => { ticks += 1; }, 5000, false));
    act(() => { vi.advanceTimersByTime(15_000); });
    expect(ticks).toBe(0);
  });
});
