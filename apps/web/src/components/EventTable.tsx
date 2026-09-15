import type { LensEvent } from '../types.js';
import { EventRow } from './EventRow.js';

interface Props {
  events: LensEvent[];
  showContract: boolean;
  onTopicClick: (topic: string) => void;
  loading: boolean;
  emptyMessage: string;
}

export function EventTable({
  events, showContract, onTopicClick, loading, emptyMessage,
}: Props): React.JSX.Element {
  if (events.length === 0) {
    return (
      <div className="empty">
        {loading ? 'Loading…' : emptyMessage}
      </div>
    );
  }

  return (
    <table className="event-table">
      <thead>
        <tr>
          <th className="col-toggle"><span className="sr-only">Expand</span></th>
          <th className="col-ledger">Ledger</th>
          {showContract && <th className="col-contract">Contract</th>}
          <th className="col-topic">Topic</th>
          <th className="col-value">Value</th>
          <th className="col-tx">Tx</th>
        </tr>
      </thead>
      <tbody>
        {events.map((event) => (
          <EventRow
            key={event.id}
            event={event}
            showContract={showContract}
            onTopicClick={onTopicClick}
          />
        ))}
      </tbody>
    </table>
  );
}
