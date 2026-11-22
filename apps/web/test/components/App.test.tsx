import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { App } from '../../src/App.js';
import { api, ApiRequestError } from '../../src/api.js';
import { makeEvent } from './fixtures.js';
import type { EventPage, Health, IndexerStatus } from '../../src/types.js';

const HEALTH: Health = {
  status: 'ok', detail: '', version: '1', network: 'testnet',
  uptimeSeconds: 1, events: 0, contracts: 0, schemaVersion: 1,
};
const STATUS: IndexerStatus = {
  eventCount: 0, contractCount: 0, minLedger: null, maxLedger: null, schemaVersion: 1, streams: [],
};

const page = (ids: string[], nextCursor: string | null = null): EventPage => ({
  events: ids.map((id) =>
    makeEvent(0, { id, topics: [{ type: 'symbol', value: `t-${id}` }] }),
  ),
  nextCursor,
  prevCursor: null,
  total: ids.length,
});

const rows = (): NodeListOf<HTMLTableRowElement> => document.querySelectorAll('tr.event-row');

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.spyOn(api, 'health').mockResolvedValue(HEALTH);
  vi.spyOn(api, 'status').mockResolvedValue(STATUS);
  vi.spyOn(api, 'contracts').mockResolvedValue({ contracts: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('live refresh merging (#186)', () => {
  it('a live tick after "Load more" keeps every loaded row and lands new ids on top', async () => {
    let deeper = false;
    vi.spyOn(api, 'events').mockImplementation(async (_base, q) => {
      if (q.cursor === 'c2') {
        deeper = true;
        return page(['e4', 'e5']);
      }
      return deeper ? page(['e0', 'e1', 'e2', 'e3']) : page(['e1', 'e2', 'e3'], 'c2');
    });

    render(<App />);
    await screen.findByText('t-e1');
    expect(rows()).toHaveLength(3);

    fireEvent.click(screen.getByRole('button', { name: 'Load 50 more' }));
    await screen.findByText('t-e4');
    expect(rows()).toHaveLength(5);

    // A live tick re-reads page one, now containing a new event e0.
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });

    const ids = [...rows()].map((r) => r.dataset.eventId);
    expect(ids).toEqual(['e0', 'e1', 'e2', 'e3', 'e4', 'e5']);
  });
});

describe('load-more errors (#196)', () => {
  it('a failed page shows an inline message and retry; the banner and table stay untouched', async () => {
    let fail = true;
    vi.spyOn(api, 'events').mockImplementation(async (_base, q) => {
      if (q.cursor === 'c2') {
        if (fail) throw new ApiRequestError(500, null, 'boom');
        return page(['e4']);
      }
      return page(['e1', 'e2'], 'c2');
    });

    render(<App />);
    await screen.findByText('t-e1');
    fireEvent.click(screen.getByRole('button', { name: 'Load 50 more' }));

    await screen.findByRole('button', { name: 'Retry' });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('boom');
    // The failure is inline, not the page-level banner.
    expect(alert.classList.contains('banner')).toBe(false);
    expect(document.querySelector('.warning.banner')?.textContent ?? '').not.toContain('boom');
    expect(rows()).toHaveLength(2); // the loaded rows are still there

    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('t-e4');
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});

describe('health refresh cadence (#195)', () => {
  it('a minute of live mode makes only a couple of /health requests; a failed poll refreshes it', async () => {
    let healthCalls = 0;
    let failEvents = false;
    vi.spyOn(api, 'health').mockImplementation(async () => {
      healthCalls += 1;
      return HEALTH;
    });
    vi.spyOn(api, 'events').mockImplementation(async (_base, q) => {
      if (failEvents && !q.cursor) throw new ApiRequestError(500, null, 'down');
      return page(['e1'], null);
    });

    render(<App />);
    await screen.findByText('t-e1');
    healthCalls = 0; // ignore the mount-time refresh

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    // ~one per 30 s across a minute of 5 s event ticks — not one per tick.
    expect(healthCalls).toBeGreaterThanOrEqual(2);
    expect(healthCalls).toBeLessThanOrEqual(4);

    failEvents = true;
    const before = healthCalls;
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(healthCalls).toBeGreaterThan(before);
  });
});
