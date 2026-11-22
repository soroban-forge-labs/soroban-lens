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
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
  document.title = '';
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

describe('tab title (#202)', () => {
  class FakeEventSource {
    static instances: FakeEventSource[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((m: { data: string; lastEventId: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public url: string) {
      FakeEventSource.instances.push(this);
    }
    close(): void {}
  }

  it('names the active contract and counts events that arrive while the tab is hidden', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.spyOn(api, 'events').mockImplementation(async () => page(['e1', 'e2', 'e3'], 'c2'));

    render(<App />);
    await screen.findByText('t-e1');
    expect(document.title).toBe('Soroban Lens');

    // Switching to the known XLM contract names it in the title.
    fireEvent.click(screen.getByRole('button', { name: 'use the testnet XLM contract' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(document.title).toBe('XLM — Soroban Lens');

    // The stream is live; hide the tab and deliver a new event over it
    // (polling pauses while hidden, so the stream is what arrives then).
    const hidden = vi.spyOn(document, 'hidden', 'get');
    hidden.mockReturnValue(true);
    const es = FakeEventSource.instances.at(-1)!;
    act(() => {
      es.onmessage?.({ data: JSON.stringify(makeEvent(0, { id: 'e9' })), lastEventId: 'x' });
    });
    expect(document.title).toBe('(1) XLM — Soroban Lens');

    // Back in focus, the count clears.
    hidden.mockReturnValue(false);
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(document.title).toBe('XLM — Soroban Lens');
  });
});

describe('request id in errors (#204)', () => {
  it('a failed request shows the X-Request-Id with a copy button', async () => {
    vi.spyOn(api, 'events').mockRejectedValue(
      new ApiRequestError(500, null, 'Request failed with 500.', 'req-abc-123'),
    );

    render(<App />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Request failed with 500.');
    expect(alert.textContent).toContain('req-abc-123');
    expect(alert.querySelector('code.mono')?.textContent).toBe('req-abc-123');
  });
});
