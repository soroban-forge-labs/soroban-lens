import { describe, expect, it } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { EventTable } from '../../src/components/EventTable.js';
import { LocaleProvider } from '../../src/i18n/index.js';
import { VIRTUALIZE_ABOVE } from '../../src/virtual.js';
import type { LensEvent } from '../../src/types.js';
import { makeEvent, makeEvents } from './fixtures.js';

/** EventTable with the expansion state App would own. */
function Harness({
  events,
  onAddressClick = () => {},
  onContractClick = () => {},
}: {
  events: LensEvent[];
  onAddressClick?: (address: string) => void;
  onContractClick?: (contractId: string) => void;
}) {
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
        onAddressClick={onAddressClick}
        onContractClick={onContractClick}
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

describe('clickable decoded addresses (#205)', () => {
  const ACCOUNT = 'GBYRNL77SLMBVGJLFYVWB762E7ZJJVSGEDOU626FPOCGOMPG776JQHHT';
  const TOKEN = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

  const expand = (container: HTMLElement) => {
    fireEvent.click(screen.getAllByRole('button', { name: 'Expand event details' })[0]!);
    return container.querySelector<HTMLTableRowElement>('tr.detail-row')!;
  };

  it('clicking an account (G…) topic calls onAddressClick', () => {
    let clicked = '';
    const { container } = render(
      <Harness events={[makeEvent(0)]} onAddressClick={(a) => { clicked = a; }} />,
    );
    const detail = expand(container);
    const button = [...detail.querySelectorAll<HTMLButtonElement>('.topic-list button')]
      .find((b) => b.textContent === ACCOUNT);
    expect(button, 'account topic renders as a button').toBeTruthy();
    fireEvent.click(button!);
    expect(clicked).toBe(ACCOUNT);
  });

  it('clicking a contract (C…) topic calls onContractClick', () => {
    let clicked = '';
    const { container } = render(
      <Harness
        events={[makeEvent(0, { topics: [{ type: 'symbol', value: 'transfer' }, { type: 'address', value: TOKEN }] })]}
        onContractClick={(c) => { clicked = c; }}
      />,
    );
    const detail = expand(container);
    const button = [...detail.querySelectorAll<HTMLButtonElement>('.topic-list button')]
      .find((b) => b.textContent === TOKEN);
    expect(button, 'contract topic renders as a button').toBeTruthy();
    fireEvent.click(button!);
    expect(clicked).toBe(TOKEN);
  });

  it('a string that merely looks like an address stays plain text', () => {
    const { container } = render(
      <Harness
        events={[makeEvent(0, { topics: [{ type: 'symbol', value: 'note' }, { type: 'string', value: ACCOUNT }] })]}
      />,
    );
    const detail = expand(container);
    const button = [...detail.querySelectorAll<HTMLButtonElement>('.topic-list button')]
      .find((b) => b.textContent === ACCOUNT);
    expect(button, 'string-typed lookalike must not become a filter button').toBeUndefined();
    const code = [...detail.querySelectorAll('.topic-list code')].find((c) => c.textContent?.includes(ACCOUNT));
    expect(code).toBeTruthy();
  });

  it('an Address-typed spec field is clickable too', () => {
    let clicked = '';
    const { container } = render(
      <Harness
        events={[makeEvent(0, {
          typed: {
            name: 'transfer',
            source: 'stellar-asset',
            fields: [
              { name: 'from', type: 'Address', value: ACCOUNT, location: 'topic' },
              { name: 'amount', type: 'i128', value: '1000', location: 'data' },
            ],
          },
        })]}
        onAddressClick={(a) => { clicked = a; }}
      />,
    );
    const detail = expand(container);
    const button = [...detail.querySelectorAll<HTMLButtonElement>('.typed-fields button')]
      .find((b) => b.textContent === ACCOUNT);
    expect(button, 'Address field renders as a button').toBeTruthy();
    fireEvent.click(button!);
    expect(clicked).toBe(ACCOUNT);
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
