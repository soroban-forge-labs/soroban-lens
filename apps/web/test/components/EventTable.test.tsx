import { describe, expect, it } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { EventTable } from '../../src/components/EventTable.js';
import { LocaleProvider } from '../../src/i18n/index.js';
import { VIRTUALIZE_ABOVE } from '../../src/virtual.js';
import type { LensEvent } from '../../src/types.js';
import { makeEvents } from './fixtures.js';

/** EventTable with the expansion state App would own. */
function Harness({ events }: { events: LensEvent[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  return (
    <LocaleProvider>
      <EventTable
        events={events}
        network="testnet"
        expandedEventIds={expanded}
        onToggleExpanded={(id) =>
          setExpanded((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          })
        }
        showContract={false}
        onTopicClick={() => {}}
        loading={false}
        emptyMessage="empty"
        selectedIds={new Set()}
        onToggleSelect={() => {}}
        absolute={false}
      />
    </LocaleProvider>
  );
}

const rows = (container: HTMLElement) => [...container.querySelectorAll<HTMLTableRowElement>('tr.event-row')];

describe('row expansion', () => {
  it('the toggle button expands a row to show its detail, and collapses it again', () => {
    const { container } = render(<Harness events={makeEvents(3)} />);
    const [toggle] = screen.getAllByRole('button', { name: 'Expand event details' });
    fireEvent.click(toggle!);
    expect(container.querySelectorAll('tr.detail-row')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Collapse event details' }).getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse event details' }));
    expect(container.querySelectorAll('tr.detail-row')).toHaveLength(0);
  });

  it('Enter toggles a focused row and Escape closes it', () => {
    const { container } = render(<Harness events={makeEvents(3)} />);
    const [first] = rows(container);
    fireEvent.keyDown(first!, { key: 'Enter' });
    expect(first!.classList.contains('is-expanded')).toBe(true);
    fireEvent.keyDown(first!, { key: 'Escape' });
    expect(first!.classList.contains('is-expanded')).toBe(false);
  });

  it('arrow keys move focus between rows (#69)', () => {
    const { container } = render(<Harness events={makeEvents(3)} />);
    const [first, second] = rows(container);
    first!.focus();
    fireEvent.keyDown(first!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(first);
  });
});

describe('virtualisation (#64)', () => {
  it('renders every row below the threshold', () => {
    const { container } = render(<Harness events={makeEvents(VIRTUALIZE_ABOVE)} />);
    expect(rows(container)).toHaveLength(VIRTUALIZE_ABOVE);
    expect(container.querySelector('tr.virtual-spacer')).toBeNull();
  });

  it('10 000 loaded rows render only a window of them, with a spacer for the rest', () => {
    const started = performance.now();
    const { container } = render(<Harness events={makeEvents(10_000)} />);
    const elapsed = performance.now() - started;
    const rendered = rows(container).length;

    expect(rendered).toBeGreaterThan(10);
    expect(rendered).toBeLessThan(100);
    const spacer = container.querySelector<HTMLTableCellElement>('tr.virtual-spacer td');
    expect(Number.parseFloat(spacer!.style.height)).toBeGreaterThan(300_000);
    expect(container.querySelector('table')!.getAttribute('aria-rowcount')).toBe('10001');
    // Recorded in the PR; logged so a CI run shows the number too.
    console.info(`[#64] 10 000 rows: ${rendered} rendered, first render ${elapsed.toFixed(0)}ms (jsdom)`);
  });

  it('ArrowDown past the last rendered row brings the next one in and focuses it', () => {
    const { container } = render(<Harness events={makeEvents(10_000)} />);
    let current = rows(container)[0]!;
    current.focus();
    const steps = rows(container).length + 5; // well past the initial window
    for (let i = 0; i < steps; i++) {
      fireEvent.keyDown(current, { key: 'ArrowDown' });
      current = document.activeElement as HTMLTableRowElement;
    }
    expect(current.classList.contains('event-row')).toBe(true);
    expect(current.getAttribute('aria-rowindex')).toBe(String(steps + 2));
  });

  it('expanding a row still works when the table is windowed', () => {
    const { container } = render(<Harness events={makeEvents(10_000)} />);
    const [first] = rows(container);
    fireEvent.keyDown(first!, { key: 'Enter' });
    expect(container.querySelectorAll('tr.detail-row')).toHaveLength(1);
  });
});
