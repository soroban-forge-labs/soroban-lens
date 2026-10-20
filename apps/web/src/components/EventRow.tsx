import { useState } from 'react';
import type { LensEvent } from '../types.js';
import { prettyJson, relativeTime, summarise, summariseTyped, topicPath, truncate } from '../format.js';
import { ExplorerLink } from './ExplorerLink.js';

/** A StrKey that names an account or a contract, as opposed to any other string. */
const ADDRESS_ID = /^[GC][A-Z2-7]{55}$/;

interface Props {
  event: LensEvent;
  network: string;
  showContract: boolean;
  onTopicClick: (topic: string) => void;
}

/** One table row, expanding in place to show the full decoded payload. */
export function EventRow({ event, network, showContract, onTopicClick }: Props): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const firstTopic = event.topics[0];
  const topicLabel = firstTopic ? summarise(firstTopic) : '—';

  return (
    <>
      <tr
        className={`event-row${expanded ? ' is-expanded' : ''}${event.inSuccessfulContractCall ? '' : ' is-failed'}`}
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <td className="col-toggle" aria-hidden="true">{expanded ? '▾' : '▸'}</td>
        <td className="col-ledger">
          <span className="mono">{event.ledger}</span>
          <span className="muted small">{relativeTime(event.ledgerClosedAt)}</span>
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
            title={`Filter by "${topicLabel}"`}
            onClick={(e) => {
              e.stopPropagation();
              onTopicClick(topicLabel);
            }}
          >
            {topicLabel}
          </button>
          {event.topics.length > 1 && (
            <span className="muted small" title={topicPath(event.topics)}>
              +{event.topics.length - 1}
            </span>
          )}
        </td>
        <td className="col-value">
          {event.typed ? (
            <>
              <span className="type-tag type-tag-typed" title="Decoded with the contract's spec">
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
        <td className="col-tx mono" title={event.txHash}>
          <ExplorerLink network={network} entity="tx" value={event.txHash} title="Open this transaction in a block explorer">
            {truncate(event.txHash, 6, 6)}
          </ExplorerLink>
        </td>
      </tr>

      {expanded && (
        <tr className="detail-row">
          <td colSpan={showContract ? 6 : 5}>
            <div className="detail">
              {!event.inSuccessfulContractCall && (
                <p className="warning">
                  Emitted during a contract call that did not succeed. It is indexed for
                  completeness, but it did not take effect on chain.
                </p>
              )}
              {event.decodeError && <p className="warning">Decode error: {event.decodeError}</p>}

              <dl className="detail-meta">
                <div><dt>Event id</dt><dd className="mono">{event.id}</dd></div>
                <div>
                  <dt>Contract</dt>
                  <dd className="mono">
                    <ExplorerLink network={network} entity="contract" value={event.contractId}>
                      {event.contractId}
                    </ExplorerLink>
                  </dd>
                </div>
                <div><dt>Ledger</dt><dd className="mono">{event.ledger}</dd></div>
                <div><dt>Closed at</dt><dd className="mono">{event.ledgerClosedAt}</dd></div>
                <div>
                  <dt>Transaction</dt>
                  <dd className="mono">
                    <ExplorerLink network={network} entity="tx" value={event.txHash}>
                      {event.txHash}
                    </ExplorerLink>
                  </dd>
                </div>
                <div><dt>Position</dt><dd className="mono">tx {event.transactionIndex} / op {event.operationIndex}</dd></div>
              </dl>

              {event.typed && (
                <section>
                  <h4>
                    <span className="typed-name">{event.typed.name}</span>{' '}
                    <span className="muted small typed-source">
                      {event.typed.source === 'stellar-asset'
                        ? 'decoded with the built-in Stellar Asset Contract spec'
                        : "decoded with the contract's own spec"}
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
                              <span className="type-tag" title="Carried in a topic, so it can be filtered on">topic</span>
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
                <h4>Topics</h4>
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
                <h4>Value <span className="type-tag">{event.value.type}</span></h4>
                <pre>{prettyJson(event.value.value)}</pre>
              </section>

              <details className="raw">
                <summary>Raw XDR</summary>
                <p className="muted small">
                  Exactly what the network emitted. The decoded fields above are derived from these.
                </p>
                <h5>Topics</h5>
                <pre>{event.topicsXdr.join('\n')}</pre>
                <h5>Value</h5>
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