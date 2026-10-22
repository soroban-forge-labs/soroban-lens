import { useEffect, useState } from 'react';
import type { LensEvent } from '../types.js';
import { prettyJson, relativeTime, summarise, summariseTyped, topicPath, truncate } from '../format.js';
import { useLocale } from '../i18n/index.js';

interface Props {
  event: LensEvent;
  showContract: boolean;
  onTopicClick: (topic: string) => void;
}

const TIME_FORMAT_KEY = 'lens.timeFormat';

type TimeFormat = 'relative' | 'absolute';

function readTimeFormat(): TimeFormat {
  try {
    return localStorage.getItem(TIME_FORMAT_KEY) === 'absolute' ? 'absolute' : 'relative';
  } catch {
    return 'relative';
  }
}

/** One table row, expanding in place to show the full decoded payload. */
export function EventRow({ event, showContract, onTopicClick }: Props): React.JSX.Element {
  const { t } = useLocale();
  const [expanded, setExpanded] = useState(false);
  const [timeFormat, setTimeFormat] = useState<TimeFormat>(readTimeFormat);
  const firstTopic = event.topics[0];
  const topicLabel = firstTopic ? summarise(firstTopic) : '—';

  useEffect(() => {
    try {
      localStorage.setItem(TIME_FORMAT_KEY, timeFormat);
    } catch {
      // ignore storage failures (private mode, quota, etc.)
    }
  }, [timeFormat]);

  return (
    <>
      <tr
        className={`event-row${expanded ? ' is-expanded' : ''}${event.inSuccessfulContractCall ? '' : ' is-failed'}`}
      >
        <td className="col-toggle">
          <button
            type="button"
            aria-label={expanded ? t('collapseDetails') : t('expandDetails')}
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? '▾' : '▸'}
          </button>
        </td>
        <td className="col-ledger">
          <span className="mono">{event.ledger}</span>
          <span className="muted small">
            {timeFormat === 'absolute' ? (
              <span className="mono">{event.ledgerClosedAt}</span>
            ) : (
              <span title={event.ledgerClosedAt}>{relativeTime(event.ledgerClosedAt)}</span>
            )}{' '}
            <button
              type="button"
              className="time-toggle"
              title={timeFormat === 'relative' ? t('showAbsoluteTimes') : t('showRelativeTimes')}
              onClick={(e) => {
                e.stopPropagation();
                setTimeFormat((v) => (v === 'relative' ? 'absolute' : 'relative'));
              }}
            >
              {timeFormat === 'relative' ? 'abs' : 'rel'}
            </button>
          </span>
        </td>
        {showContract && (
          <td className="col-contract mono" title={event.contractId}>
            {truncate(event.contractId)}
          </td>
        )}
        <td className="col-topic">
          <button
            type="button"
            className="topic-chip"
            title={t('filterByTopic', { topic: topicLabel })}
            onClick={() => onTopicClick(topicLabel)}
          >
            {topicLabel}
          </button>
          {event.topics.length > 1 && (
            <span className="muted small" title={topicPath(event.topics)}>
              {t('additionalTopics', { count: event.topics.length - 1 })}
            </span>
          )}
        </td>
        <td className="col-value">
          {event.typed ? (
            <>
              <span className="type-tag type-tag-typed" title={t('typedSourceOwn')}>
                {event.typed.name}
              </span>
              <span className="mono">{summariseTyped(event.typed)}</span>
            </>
          ) : (
            <>
              <span className="type-tag">{event.value.type}</span>
              <span className="mono">{summarise(event.value)}</span>
            </>
          )}
        </td>
        <td className="col-tx mono" title={event.txHash}>{truncate(event.txHash, 6, 6)}</td>
      </tr>

      {expanded && (
        <tr className="detail-row">
          <td colSpan={showContract ? 6 : 5}>
            <div className="detail">
              {!event.inSuccessfulContractCall && (
                <p className="warning">{t('failedCallWarning')}</p>
              )}
              {event.decodeError && (
                <p className="warning">{t('decodeError', { message: event.decodeError })}</p>
              )}

              <dl className="detail-meta">
                <div><dt>{t('detailEventId')}</dt><dd className="mono">{event.id}</dd></div>
                <div><dt>{t('detailContract')}</dt><dd className="mono">{event.contractId}</dd></div>
                <div><dt>{t('detailLedger')}</dt><dd className="mono">{event.ledger}</dd></div>
                <div><dt>{t('detailClosedAt')}</dt><dd className="mono">{event.ledgerClosedAt}</dd></div>
                <div><dt>{t('detailTransaction')}</dt><dd className="mono">{event.txHash}</dd></div>
                <div>
                  <dt>{t('detailPosition')}</dt>
                  <dd className="mono">
                    {t('detailPositionValue', {
                      txIndex: event.transactionIndex,
                      opIndex: event.operationIndex,
                    })}
                  </dd>
                </div>
              </dl>

              {event.typed && (
                <section>
                  <h4>
                    <span className="typed-name">{event.typed.name}</span>{' '}
                    <span className="muted small typed-source">
                      {event.typed.source === 'stellar-asset'
                        ? t('typedSourceBuiltIn')
                        : t('typedSourceOwn')}
                    </span>
                  </h4>
                  <table className="typed-fields">
                    <tbody>
                      {event.typed.fields.map((field) => (
                        <tr key={field.name}>
                          <th scope="row" className="mono">{field.name}</th>
                          <td>
                            <span className="type-tag">{field.type}</span>
                            {field.location === 'topic' && (
                              <span className="type-tag" title={t('colTopic')}>topic</span>
                            )}
                          </td>
                          <td><code>{prettyJson(field.value)}</code></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              )}

              <section>
                <h4>{t('topicsHeading')}</h4>
                <ol className="topic-list">
                  {event.topics.map((topic, i) => (
                    <li key={i}>
                      <span className="type-tag">{topic.type}</span>
                      <code>{prettyJson(topic.value)}</code>
                    </li>
                  ))}
                </ol>
              </section>

              <section>
                <h4>
                  {t('valueHeading')}{' '}
                  <span className="type-tag">{event.value.type}</span>
                </h4>
                <pre>{prettyJson(event.value.value)}</pre>
              </section>

              <details className="raw">
                <summary>{t('rawXdr')}</summary>
                <p className="muted small">{t('rawXdrDesc')}</p>
                <h5>{t('rawTopicsHeading')}</h5>
                <pre>{event.topicsXdr.join('\n')}</pre>
                <h5>{t('rawValueHeading')}</h5>
                <pre>{event.valueXdr}</pre>
              </details>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
// Component for displaying individual event rows in the table
