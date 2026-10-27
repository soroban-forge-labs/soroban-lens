import type { LensEvent } from '../types.js';
import { absoluteTime, prettyJson, relativeTime, summarise, summariseTyped, topicPath, truncate } from '../format.js';
import { useLocale } from '../i18n/index.js';
import { CopyButton } from './CopyButton.js';
import { ExplorerLink } from './ExplorerLink.js';

/** A StrKey that names an account or a contract, as opposed to any other string. */
const ADDRESS_ID = /^[GC][A-Z2-7]{55}$/;

interface Props {
  event: LensEvent;
  network: string;
  expanded: boolean;
  onToggleExpanded: (eventId: string) => void;
  showContract: boolean;
  onTopicClick: (topic: string) => void;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  /** Show the ledger close time as an absolute timestamp instead of "3h ago". */
  absolute: boolean;
}

/** One table row, expanding in place to show the full decoded payload. */
export function EventRow({
  event, network, expanded, onToggleExpanded, showContract, onTopicClick, selected, onToggleSelect, absolute,
}: Props): React.JSX.Element {
  const { t } = useLocale();
  const firstTopic = event.topics[0];
  const topicLabel = firstTopic ? summarise(firstTopic) : '—';
  const onKeyDown = (keyEvent: React.KeyboardEvent<HTMLTableRowElement>): void => {
    if (keyEvent.target !== keyEvent.currentTarget) return;

    if (keyEvent.key === 'ArrowDown' || keyEvent.key === 'ArrowUp') {
      keyEvent.preventDefault();
      const rows = Array.from(
        keyEvent.currentTarget.closest('tbody')?.querySelectorAll<HTMLTableRowElement>('.event-row') ?? [],
      );
      const index = rows.indexOf(keyEvent.currentTarget);
      rows[index + (keyEvent.key === 'ArrowDown' ? 1 : -1)]?.focus();
    } else if (keyEvent.key === 'Enter' || keyEvent.key === ' ') {
      keyEvent.preventDefault();
      onToggleExpanded(event.id);
    } else if (keyEvent.key === 'Escape' && expanded) {
      keyEvent.preventDefault();
      onToggleExpanded(event.id);
    }
  };

  return (
    <>
      <tr
        className={`event-row${expanded ? ' is-expanded' : ''}${event.inSuccessfulContractCall ? '' : ' is-failed'}`}
        onKeyDown={onKeyDown}
        role="row"
        tabIndex={0}
      >
        <td className="col-select" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggleSelect(event.id)}
            aria-label={`Select event at ledger ${event.ledger} to compare`}
            title="Select to compare"
          />
        </td>
        <td className="col-toggle">
          <button
            type="button"
            aria-label={expanded ? 'Collapse event details' : 'Expand event details'}
            aria-expanded={expanded}
            onClick={() => onToggleExpanded(event.id)}
          >
            {expanded ? '▾' : '▸'}
          </button>
        </td>
        <td className="col-ledger">
          <span className="mono">{event.ledger}</span>
          <span className="muted small">
            {absolute ? (
              <span className="timestamp-absolute" title={event.ledgerClosedAt}>{absoluteTime(event.ledgerClosedAt)}</span>
            ) : (
              <span title={event.ledgerClosedAt}>{relativeTime(event.ledgerClosedAt)}</span>
            )}
          </span>
          <div className="mobile-copy-actions">
            {showContract && <CopyButton value={event.contractId} label="contract ID" />}
            <CopyButton value={event.txHash} label="transaction hash" />
          </div>
          <div className="row-event-copy"><span className="muted small">Event ID</span> <CopyButton value={event.id} label="event ID" /></div>
        </td>
        {showContract && (
          <td className="col-contract" title={event.contractId}>
            <span className="mono">{truncate(event.contractId)}</span>
            <CopyButton value={event.contractId} label="contract ID" />
          </td>
        )}
        <td className="col-topic">
          <button
            type="button"
            className="topic-chip"
            title={t('filterByTopic', { topic: topicLabel })}
            onClick={(e) => {
              e.stopPropagation();
              onTopicClick(topicLabel);
            }}
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
        <td className="col-tx" title={event.txHash}>
          <ExplorerLink network={network} entity="tx" value={event.txHash} title="Open this transaction in a block explorer">
            <span className="mono">{truncate(event.txHash, 6, 6)}</span>
          </ExplorerLink>
          <CopyButton value={event.txHash} label="transaction hash" />
        </td>
      </tr>

      {expanded && (
        <tr className="detail-row">
          <td colSpan={showContract ? 7 : 6}>
            <div className="detail">
              {!event.inSuccessfulContractCall && (
                <p className="warning">{t('failedCallWarning')}</p>
              )}
              {event.decodeError && (
                <p className="warning">{t('decodeError', { message: event.decodeError })}</p>
              )}

              <dl className="detail-meta">
                <div><dt>{t('detailEventId')}</dt><dd className="mono">{event.id} <CopyButton value={event.id} label="event ID" /></dd></div>
                <div>
                  <dt>{t('detailContract')}</dt>
                  <dd className="mono">
                    <ExplorerLink network={network} entity="contract" value={event.contractId}>
                      {event.contractId}
                    </ExplorerLink>{' '}
                    <CopyButton value={event.contractId} label="contract ID" />
                  </dd>
                </div>
                <div><dt>{t('detailLedger')}</dt><dd className="mono">{event.ledger}</dd></div>
                <div><dt>{t('detailClosedAt')}</dt><dd className="mono">{event.ledgerClosedAt}</dd></div>
                <div>
                  <dt>{t('detailTransaction')}</dt>
                  <dd className="mono">
                    <ExplorerLink network={network} entity="tx" value={event.txHash}>
                      {event.txHash}
                    </ExplorerLink>{' '}
                    <CopyButton value={event.txHash} label="transaction hash" />
                  </dd>
                </div>
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
                  {event.topics.map((topic, i) => {
                    // Account and contract addresses are the identifiers worth
                    // leaving the app for; everything else is just data.
                    const address = typeof topic.value === 'string' && ADDRESS_ID.test(topic.value)
                      ? topic.value
                      : null;
                    return (
                      <li key={i}>
                        <span className="type-tag">{topic.type}</span>
                        <code>
                          {address ? (
                            <ExplorerLink
                              network={network}
                              entity={address.startsWith('G') ? 'account' : 'contract'}
                              value={address}
                            >
                              {address}
                            </ExplorerLink>
                          ) : prettyJson(topic.value)}
                        </code>
                      </li>
                    );
                  })}
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
