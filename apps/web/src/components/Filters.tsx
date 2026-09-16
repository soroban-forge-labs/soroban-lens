import type { TopicCount } from '../types.js';

// Filter state interface for event filtering
export interface FilterState {
  contractId: string;
  topic: string;
  successfulOnly: boolean;
  live: boolean;
}

interface Props {
  value: FilterState;
  onChange: (next: FilterState) => void;
  knownTopics: TopicCount[];
  onUseExample: () => void;
}

export function Filters({ value, onChange, knownTopics, onUseExample }: Props): React.JSX.Element {
  const set = <K extends keyof FilterState>(key: K, v: FilterState[K]): void =>
    onChange({ ...value, [key]: v });

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
