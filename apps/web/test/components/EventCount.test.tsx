import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { App } from '../../src/App.js';
import type { EventPage } from '../../src/types.js';
import { makeEvents } from './fixtures.js';

// Estimated totals (#200): the store marks totals served from its count cache
// with totalIsEstimate, and the event-count line is the only place that reads
// it — so the tests stub fetch and let the whole app render the mocked page.

const page = (over: Partial<EventPage>): EventPage => ({
  events: makeEvents(2),
  nextCursor: null,
  prevCursor: null,
  total: 1234,
  ...over,
});

function fakeResponse(body: unknown): Response {
  // request() only reads ok/status/json, so a plain object is enough.
  return { ok: true, status: 200, json: async () => body } as Response;
}

/** Stub fetch for every endpoint the app calls on mount; /events returns `page`. */
function stubApi(page: EventPage): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL): Promise<Response> => {
    const path = new URL(String(input), 'http://localhost').pathname;
    if (path === '/events') return fakeResponse(page);
    if (path === '/contracts') return fakeResponse({ contracts: [] });
    if (path === '/health') {
      return fakeResponse({
        status: 'ok', detail: '', version: '0.1.0', network: 'testnet',
        uptimeSeconds: 1, events: 0, contracts: 0, schemaVersion: 6,
      });
    }
    if (path === '/status') {
      return fakeResponse({
        eventCount: 0, contractCount: 0, minLedger: null, maxLedger: null,
        schemaVersion: 6, streams: [],
      });
    }
    return fakeResponse(null);
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('event count with totalIsEstimate', () => {
  it('renders "about N" with an explanatory tooltip when the page flags the total', async () => {
    stubApi(page({ totalIsEstimate: true }));
    render(<App />);
    const count = await screen.findByText(`about ${(1234).toLocaleString()} events`);
    expect(count.getAttribute('title')).toMatch(/cache/i);
  });

  it('renders the exact total and no tooltip when the flag is absent', async () => {
    stubApi(page({}));
    render(<App />);
    const count = await screen.findByText(`${(1234).toLocaleString()} events`);
    expect(count.getAttribute('title')).toBeNull();
  });
});
