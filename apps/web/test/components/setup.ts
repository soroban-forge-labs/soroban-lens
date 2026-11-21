import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Testing Library only auto-cleans when the runner exposes globals; Vitest
// does not by default, so unmount between tests here.
afterEach(() => cleanup());

// jsdom has no layout, so it has no CSS.escape either; the table uses it to
// find rows by event id.
if (typeof globalThis.CSS === 'undefined' || typeof globalThis.CSS.escape !== 'function') {
  (globalThis as { CSS?: unknown }).CSS = { escape: (s: string) => s.replace(/["\\]/g, '\\$&') };
}

// Nor scrolling: keyboard navigation scrolls the window to reveal a row, which
// jsdom only reports as "not implemented". The table's own arithmetic decides
// what renders, so a no-op is all the tests need.
window.scrollBy = () => {};
