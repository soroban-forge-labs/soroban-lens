import type { LensEvent } from '../types.js';
import { EventRow } from './EventRow.js';
import { useLocale } from '../i18n/index.js';

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
}

export function EventTable({
  events, network, expandedEventIds, onToggleExpanded, showContract, onTopicClick, loading, emptyMessage, selectedIds, onToggleSelect, absolute,
}: Props): React.JSX.Element {
  const { t } = useLocale();

  if (events.length === 0) {
    return (
      <div className="empty">
        {loading ? t('loading') : emptyMessage}
      </div>
    );
  }

  return (
    <table className="event-table">
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
      <tbody>
        {events.map((event) => (
          <EventRow
            key={event.id}
            event={event}
            network={network}
            expanded={expandedEventIds.has(event.id)}
            onToggleExpanded={onToggleExpanded}
            showContract={showContract}
            onTopicClick={onTopicClick}
            selected={selectedIds.has(event.id)}
            onToggleSelect={onToggleSelect}
            absolute={absolute}
          />
        ))}
      </tbody>
    </table>
  );
}
