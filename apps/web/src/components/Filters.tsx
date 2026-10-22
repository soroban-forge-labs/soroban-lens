import type { TopicCount } from '../types.js';

// Filter state interface for event filtering
export interface FilterState {
  contractId: string;
  topic: string;
  successfulOnly: boolean;
  live: boolean;
  fromLedger: string;
  toLedger: string;
}

interface Props {
  value: FilterState;
  onChange: (next: FilterState) => void;
  knownTopics: TopicCount[];
  onUseExample: () => void;
}

/** Returns true if the string is empty OR a non-negative integer with no decimals. */
function isValidLedger(v: string): boolean {
  return v === '' || (/^\d+$/.test(v) && Number.isInteger(Number(v)) && Number(v) >= 0);
}

export function Filters({ value, onChange, knownTopics, onUseExample }: Props): React.JSX.Element {
  const set = <K extends keyof FilterState>(key: K, v: FilterState[K]): void =>
    onChange({ ...value, [key]: v });

  const fromInvalid = !isValidLedger(value.fromLedger);
  const toInvalid = !isValidLedger(value.toLedger);
  const rangeInvalid =
    !fromInvalid &&
    !toInvalid &&
    value.fromLedger !== '' &&
    value.toLedger !== '' &&
    Number(value.fromLedger) > Number(value.toLedger);

  return (
    <form className="filters" onSubmit={(e) => e.preventDefault()}>
      <div className="field field-grow">
        <label htmlFor="contractId">Contract ID</label>
        <input
          id="contractId"
          name="contractId"
          className="mono"
          placeholder="C… (leave empty to see every indexed contract)"
          spellCheck={false}
          autoComplete="off"
          value={value.contractId}
          onChange={(e) => set('contractId', e.target.value.trim())}
        />
        <button type="button" className="link-button" onClick={onUseExample}>
          use the testnet XLM contract
        </button>
      </div>

      <div className="field">
        <label htmlFor="topic">Topic</label>
        <input
          id="topic"
          name="topic"
          className="mono"
          list="known-topics"
          placeholder="transfer"
          spellCheck={false}
          autoComplete="off"
          value={value.topic}
          onChange={(e) => set('topic', e.target.value.trim())}
        />
        <datalist id="known-topics">
          {knownTopics.map((t) => (
            <option key={t.topic} value={t.topic}>{`${t.topic} (${t.count})`}</option>
          ))}
        </datalist>
      </div>

      <div className="field">
        <label htmlFor="fromLedger">From ledger</label>
        <input
          id="fromLedger"
          name="fromLedger"
          inputMode="numeric"
          placeholder="e.g. 1000000"
          value={value.fromLedger}
          aria-invalid={fromInvalid || rangeInvalid}
          onChange={(e) => set('fromLedger', e.target.value.trim())}
        />
        {fromInvalid && (
          <span className="warning" role="alert" style={{ padding: '2px 6px', fontSize: '11px' }}>
            Must be a non-negative integer
          </span>
        )}
      </div>

      <div className="field">
        <label htmlFor="toLedger">To ledger</label>
        <input
          id="toLedger"
          name="toLedger"
          inputMode="numeric"
          placeholder="e.g. 2000000"
          value={value.toLedger}
          aria-invalid={toInvalid || rangeInvalid}
          onChange={(e) => set('toLedger', e.target.value.trim())}
        />
        {toInvalid && (
          <span className="warning" role="alert" style={{ padding: '2px 6px', fontSize: '11px' }}>
            Must be a non-negative integer
          </span>
        )}
        {rangeInvalid && !toInvalid && (
          <span className="warning" role="alert" style={{ padding: '2px 6px', fontSize: '11px' }}>
            Must be ≥ from ledger
          </span>
        )}
      </div>

      <div className="field field-checks">
        <label>
          <input
            type="checkbox"
            checked={value.successfulOnly}
            onChange={(e) => set('successfulOnly', e.target.checked)}
          />
          Successful calls only
        </label>
        <label>
          <input
            type="checkbox"
            checked={value.live}
            onChange={(e) => set('live', e.target.checked)}
          />
          Live updates
        </label>
      </div>
    </form>
  );
}
