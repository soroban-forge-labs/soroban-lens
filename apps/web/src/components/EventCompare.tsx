import { useState } from 'react';
import type { LensEvent } from '../types.js';
import type { DiffNode } from '../diff.js';
import { diffEvents } from '../diff.js';
import { prettyJson, truncate } from '../format.js';

interface Props {
  left: LensEvent;
  right: LensEvent;
  onClose: () => void;
}

function renderSide(value: unknown): string {
  return value === undefined ? '—' : prettyJson(value);
}

function renderNodes(nodes: DiffNode[], showSame: boolean, depth: number): React.JSX.Element[] {
  const rows: React.JSX.Element[] = [];
  for (const node of nodes) {
    if (!showSame && node.status === 'same') continue;
    if (node.children) {
      rows.push(...renderNodes(node.children, showSame, depth + 1));
    } else {
      rows.push(
        <tr key={node.path} className={`diff-row diff-${node.status}`}>
          <td className="diff-path" style={{ paddingLeft: 12 + depth * 16 }}>{node.path}</td>
          <td className="diff-side diff-left">{renderSide(node.left)}</td>
          <td className="diff-side diff-right">{renderSide(node.right)}</td>
        </tr>,
      );
    }
  }
  return rows;
}

function DiffTable({ nodes, showSame }: { nodes: DiffNode[]; showSame: boolean }): React.JSX.Element | null {
  const rows = renderNodes(nodes, showSame, 0);
  if (rows.length === 0) return null;
  return (
    <table className="diff-table">
      <thead>
        <tr>
          <th>Field</th>
          <th>Left</th>
          <th>Right</th>
        </tr>
      </thead>
      <tbody>{rows}</tbody>
    </table>
  );
}

function MetaRow({ label, left, right }: { label: string; left: string; right: string }): React.JSX.Element {
  const differs = left !== right;
  return (
    <div className={differs ? 'diff-changed' : undefined}>
      <dt>{label}</dt>
      <dd className="mono" title={differs ? `left: ${left} · right: ${right}` : left}>
        {differs ? `${left} → ${right}` : left}
      </dd>
    </div>
  );
}

/** Side-by-side comparison of two events, with differing topics and value fields highlighted. */
export function EventCompare({ left, right, onClose }: Props): React.JSX.Element {
  const [showSame, setShowSame] = useState(false);
  const [copied, setCopied] = useState(false);
  const diff = diffEvents(left, right);

  const copyLink = (): void => {
    void navigator.clipboard?.writeText(window.location.href).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  const sameValue = diff.value.status === 'same';
  const sameTyped = diff.typedFields !== null && diff.typedFields.every((n) => n.status === 'same');

  return (
    <section className="compare-panel" aria-label="Event comparison">
      <div className="compare-header">
        <h3>
          Compare <span className="mono" title={left.id}>{truncate(left.id, 10, 6)}</span>
          {' vs '}
          <span className="mono" title={right.id}>{truncate(right.id, 10, 6)}</span>
        </h3>
        <div className="compare-header-actions">
          <label className="compare-show-same">
            <input
              type="checkbox"
              checked={showSame}
              onChange={(e) => setShowSame(e.target.checked)}
            />
            Show unchanged
          </label>
          {typeof navigator !== 'undefined' && navigator.clipboard && (
            <button type="button" className="btn-export" onClick={copyLink}>
              {copied ? 'Link copied' : 'Copy link'}
            </button>
          )}
          <button type="button" className="btn-export" onClick={onClose}>
            Close
          </button>
        </div>
      </div>

      <div className="compare-body">
        <p className="diff-legend">
          <span className="sw-changed">changed</span>
          <span className="sw-removed">only in left</span>
          <span className="sw-added">only in right</span>
        </p>

        <dl className="compare-meta">
          <MetaRow label="Ledger" left={String(left.ledger)} right={String(right.ledger)} />
          <MetaRow label="Closed at" left={left.ledgerClosedAt} right={right.ledgerClosedAt} />
          <MetaRow label="Contract" left={left.contractId} right={right.contractId} />
          <MetaRow label="Transaction" left={left.txHash} right={right.txHash} />
          <MetaRow
            label="Position"
            left={`tx ${left.transactionIndex} / op ${left.operationIndex}`}
            right={`tx ${right.transactionIndex} / op ${right.operationIndex}`}
          />
          <MetaRow
            label="Successful"
            left={left.inSuccessfulContractCall ? 'yes' : 'no'}
            right={right.inSuccessfulContractCall ? 'yes' : 'no'}
          />
        </dl>

        {left.decodeError && <p className="warning">Left event decode error: {left.decodeError}</p>}
        {right.decodeError && <p className="warning">Right event decode error: {right.decodeError}</p>}

        <h4>Topics</h4>
        {diff.topics.every((n) => n.status === 'same') ? (
          <p className="compare-note">Topics are identical.</p>
        ) : (
          <DiffTable nodes={diff.topics} showSame={showSame} />
        )}

        <h4>Value <span className="type-tag">{left.value.type}</span>{left.value.type !== right.value.type && <span className="type-tag">{right.value.type}</span>}</h4>
        {sameValue ? (
          <p className="compare-note">Value is identical.</p>
        ) : (
          <DiffTable nodes={[diff.value]} showSame={showSame} />
        )}

        {diff.typedFields && (
          <>
            <h4>
              Spec fields <span className="typed-name">{left.typed?.name}</span>
            </h4>
            {sameTyped ? (
              <p className="compare-note">Spec-decoded fields are identical.</p>
            ) : (
              <DiffTable nodes={diff.typedFields} showSame={showSame} />
            )}
          </>
        )}
      </div>
    </section>
  );
}
