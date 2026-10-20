import type { ContractActivity } from '../types.js';

const SECONDS_PER_DAY = 24 * 60 * 60;
const DAY_COUNT = 30;

interface Props {
  activity: ContractActivity;
  from: number;
  to: number;
  selectedFrom: string | null;
  onBucketClick: (start: number, firstLedger: number, lastLedger: number) => void;
}

export function ActivityChart({
  activity,
  from,
  to,
  selectedFrom,
  onBucketClick,
}: Props): React.JSX.Element {
  const bucketsByDay = new Map(
    activity.buckets.map((bucket) => [
      Math.floor(Date.parse(bucket.start) / 1000 / SECONDS_PER_DAY) * SECONDS_PER_DAY,
      bucket,
    ]),
  );
  const days = Array.from({ length: DAY_COUNT }, (_, index) => from + index * SECONDS_PER_DAY);
  const maximum = Math.max(1, ...days.map((day) => bucketsByDay.get(day)?.count ?? 0));

  return (
    <div className="activity-chart">
      <div className="activity-chart-heading">
        <h2>Daily event activity</h2>
        <span className="muted small">
          {new Date(from * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })}
          {' – '}
          {new Date(to * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}
          {' · Click a day to filter events'}
        </span>
      </div>
      <div className="activity-chart-bars" role="group" aria-label="Events per day">
        {days.map((start) => {
          const bucket = bucketsByDay.get(start);
          const count = bucket?.count ?? 0;
          const fromTime = new Date(start * 1000).toISOString();
          const active = selectedFrom === fromTime;
          const day = new Date(start * 1000).toLocaleDateString(undefined, {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
            year: 'numeric',
            timeZone: 'UTC',
          });
          return (
            <button
              key={start}
              type="button"
              className={`activity-bar${active ? ' is-selected' : ''}`}
              title={`${day}: ${count.toLocaleString()} event${count === 1 ? '' : 's'}`}
              aria-label={`${day}: ${count.toLocaleString()} event${count === 1 ? '' : 's'}`}
              aria-pressed={active}
              disabled={!bucket}
              onClick={() => {
                if (bucket) onBucketClick(start, bucket.firstLedger, bucket.lastLedger);
              }}
            >
              <span
                className="activity-bar-fill"
                style={{ height: `${count === 0 ? 2 : Math.max(8, (count / maximum) * 100)}%` }}
              />
            </button>
          );
        })}
      </div>
      <div className="activity-chart-axis" aria-hidden="true">
        <span>{new Date(from * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })}</span>
        <span>{new Date(to * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })}</span>
      </div>
    </div>
  );
}
