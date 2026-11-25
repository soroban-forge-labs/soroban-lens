import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { LensEvent } from '../types.js';
import { EventRow } from './EventRow.js';
import { useLocale } from '../i18n/index.js';
import {
  computeWindow,
  ESTIMATED_EXPANDED_PX,
  ESTIMATED_ROW_PX,
  scrollToReveal,
  VIRTUALIZE_ABOVE,
} from '../virtual.js';

// Props for the EventTable component
interface Props {
  events: LensEvent[];
  network: string;
  expandedEventIds: Set<string>;
  onToggleExpanded: (eventId: string) => void;
  showContract: boolean;
  onTopicClick: (topic: string) => void;
  loading: boolean;
  emptyMessage: string;
  selectedIds: ReadonlySet<string>;
  onToggleSelect: (id: string) => void;
  /** Whether the Ledger column shows absolute time instead of relative. */
  absolute: boolean;
  /** Open the transaction events panel for a given hash (#65). */
  onTxHashClick?: (txHash: string) => void;
}

interface Viewport {
  /** Viewport top relative to the top of the table body; negative while the table is below the fold. */
  scrollTop: number;
  height: number;
}

/**
 * The event table. Above `VIRTUALIZE_ABOVE` rows only the rows near the
 * viewport are rendered (#64), between two spacer rows; below it every row is,
 * exactly as before.
 *
 * The page itself scrolls, not an inner box, so the header, filters and
 * "Load more" button keep their place in the document flow and nothing about
 * the layout changes when windowing switches on.
 */
export function EventTable({
  events, network, expandedEventIds, onToggleExpanded, showContract, onTopicClick, loading, emptyMessage, selectedIds, onToggleSelect, absolute, onTxHashClick,
}: Props): React.JSX.Element {
  const { t } = useLocale();
  const virtualized = events.length > VIRTUALIZE_ABOVE;
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  // Measured height of each event's row plus its detail row, by id, so a
  // measurement survives the row scrolling out and back in.
  const measured = useRef(new Map<string, number>());
  const [measureVersion, setMeasureVersion] = useState(0);
  const [viewport, setViewport] = useState<Viewport>(() => ({
    scrollTop: 0,
    height: typeof window === 'undefined' ? 800 : window.innerHeight,
  }));
  const pendingFocus = useRef<string | null>(null);

  const heights = useMemo(
    () =>
      events.map(
        (e) => measured.current.get(e.id) ?? (expandedEventIds.has(e.id) ? ESTIMATED_EXPANDED_PX : ESTIMATED_ROW_PX),
      ),
    // measureVersion is what tells this memo a measurement landed.
    [events, expandedEventIds, measureVersion],
  );

  const readViewport = useCallback((): Viewport | null => {
    const body = bodyRef.current;
    if (!body) return null;
    return { scrollTop: -body.getBoundingClientRect().top, height: window.innerHeight };
  }, []);

  // One read per animation frame however fast scroll events arrive.
  useEffect(() => {
    if (!virtualized) return;
    let frame = 0;
    const update = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = readViewport();
        if (next) setViewport((current) => (sameViewport(current, next) ? current : next));
      });
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [virtualized, readViewport]);

  const range = virtualized
    ? computeWindow({ heights, scrollTop: viewport.scrollTop, viewportHeight: viewport.height })
    : { start: 0, end: events.length, padTop: 0, padBottom: 0 };

  // Measure what rendered. A 0 height means no layout (jsdom, a hidden tab)
  // and is ignored, so estimates stand rather than collapsing every row.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body || !virtualized) return;
    const sums = new Map<string, number>();
    for (const row of body.querySelectorAll<HTMLTableRowElement>('tr[data-event-id], tr[data-detail-for]')) {
      const id = row.dataset.eventId ?? row.dataset.detailFor;
      const h = row.getBoundingClientRect().height;
      if (id && h > 0) sums.set(id, (sums.get(id) ?? 0) + h);
    }
    let changed = false;
    for (const [id, h] of sums) {
      if (Math.abs((measured.current.get(id) ?? 0) - h) > 0.5) {
        measured.current.set(id, h);
        changed = true;
      }
    }
    if (changed) setMeasureVersion((v) => v + 1);
  });

  // Rows that are no longer loaded (a new filter) have no use for a height.
  useEffect(() => {
    const loaded = new Set(events.map((e) => e.id));
    for (const id of measured.current.keys()) if (!loaded.has(id)) measured.current.delete(id);
  }, [events]);
  // Expanding or collapsing changes a row's height; forget the old one so the
  // estimate applies until it is measured again in its new state.
  const toggleExpanded = useCallback(
    (id: string): void => {
      measured.current.delete(id);
      onToggleExpanded(id);
    },
    [onToggleExpanded],
  );

  // Arrow-key navigation (#69). The target row may be outside the rendered
  // window, so scroll it in first and focus it once it has rendered.
  const navigate = useCallback(
    (fromId: string, delta: 1 | -1): void => {
      const index = events.findIndex((e) => e.id === fromId) + delta;
      const target = events[index];
      if (!target) return;
      const row = bodyRef.current?.querySelector<HTMLTableRowElement>(`tr[data-event-id="${CSS.escape(target.id)}"]`);
      if (row && !virtualized) {
        row.focus();
        return;
      }
      const current = readViewport() ?? viewport;
      const to = scrollToReveal(heights, index, current.scrollTop, current.height);
      if (to !== null) window.scrollBy({ top: to - current.scrollTop });
      // From the arithmetic rather than a fresh DOM read: the window has to
      // include the target on the very next render, before the browser's
      // scroll event comes round.
      setViewport({ scrollTop: to ?? current.scrollTop, height: current.height });
      pendingFocus.current = target.id;
      if (row) {
        row.focus();
        pendingFocus.current = null;
      } else {
        setMeasureVersion((v) => v + 1); // re-render with the target in range
      }
    },
    [events, heights, virtualized, readViewport, viewport],
  );

  useLayoutEffect(() => {
    const id = pendingFocus.current;
    if (!id) return;
    const row = bodyRef.current?.querySelector<HTMLTableRowElement>(`tr[data-event-id="${CSS.escape(id)}"]`);
    if (row) {
      row.focus();
      pendingFocus.current = null;
    }
  });

  if (events.length === 0) {
    return (
      <div className="empty">
        {loading ? t('loading') : emptyMessage}
      </div>
    );
  }

  const columns = showContract ? 7 : 6;
  return (
    <table className="event-table" {...(virtualized ? { 'aria-rowcount': events.length + 1 } : {})}>
      <thead>
        <tr>
          <th className="col-select"><span className="sr-only">Compare</span></th>
          <th className="col-toggle"><span className="sr-only">{t('colExpand')}</span></th>
          <th className="col-ledger">{t('colLedger')}</th>
          {showContract && <th className="col-contract">{t('colContract')}</th>}
          <th className="col-topic">{t('colTopic')}</th>
          <th className="col-value">{t('colValue')}</th>
          <th className="col-tx">{t('colTx')}</th>
        </tr>
      </thead>
      <tbody ref={bodyRef}>
        {range.padTop > 0 && <Spacer height={range.padTop} columns={columns} />}
        {events.slice(range.start, range.end).map((event, i) => (
          <EventRow
            key={event.id}
            event={event}
            network={network}
            expanded={expandedEventIds.has(event.id)}
            onToggleExpanded={toggleExpanded}
            showContract={showContract}
            onTopicClick={onTopicClick}
            selected={selectedIds.has(event.id)}
            onToggleSelect={onToggleSelect}
            absolute={absolute}
            onNavigate={navigate}
            onTxHashClick={onTxHashClick}
            // +2: aria-rowindex is 1-based and the header row is row 1.
            rowIndex={virtualized ? range.start + i + 2 : undefined}
          />
        ))}
        {range.padBottom > 0 && <Spacer height={range.padBottom} columns={columns} />}
      </tbody>
    </table>
  );
}

/** Stands in for rows that are not rendered, so the scrollbar and page height stay true. */
function Spacer({ height, columns }: { height: number; columns: number }): React.JSX.Element {
  return (
    <tr className="virtual-spacer" aria-hidden="true">
      <td colSpan={columns} style={{ height, padding: 0, border: 0 }} />
    </tr>
  );
}

function sameViewport(a: Viewport, b: Viewport): boolean {
  return Math.abs(a.scrollTop - b.scrollTop) < 1 && a.height === b.height;
}
