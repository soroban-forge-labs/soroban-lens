import type { ContractSummary, TopicCount } from '../types.js';
import type { FilterState } from '../route.js';
import { useLocale } from '../i18n/index.js';

interface Props {
  value: FilterState;
  onChange: (next: FilterState) => void;
  knownTopics: TopicCount[];
  knownContracts: ContractSummary[];
  contractsError: string | null;
  contractInputRef: React.RefObject<HTMLInputElement | null>;
  onUseExample: () => void;
}

/** Returns true if the string is empty OR a non-negative integer with no decimals. */
function isValidLedger(v: string): boolean {
  return v === '' || (/^\d+$/.test(v) && Number.isInteger(Number(v)) && Number(v) >= 0);
}

export function Filters({
  value,
  onChange,
  knownTopics,
  knownContracts,
  contractsError,
  contractInputRef,
  onUseExample,
}: Props): React.JSX.Element {
  const { t } = useLocale();
  const set = <K extends keyof FilterState>(key: K, v: FilterState[K]): void =>
    onChange({ ...value, [key]: v });
  const selectedContract = knownContracts.some((contract) => contract.contractId === value.contractId)
    ? value.contractId
    : '';

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
        <label htmlFor="contractId">{t('contractIdLabel')}</label>
        <input
          ref={contractInputRef}
          id="contractId"
          name="contractId"
          className="mono"
          placeholder={t('contractIdPlaceholder')}
          spellCheck={false}
          autoComplete="off"
          value={value.contractId}
          onChange={(e) => set('contractId', e.target.value.trim())}
        />
        <label htmlFor="indexedContract">Indexed contracts</label>
        <select
          id="indexedContract"
          className="mono"
          value={selectedContract}
          onChange={(e) => set('contractId', e.target.value)}
        >
          <option value="">Choose an indexed contract…</option>
          {knownContracts.map((contract) => (
            <option key={contract.contractId} value={contract.contractId}>
              {contract.contractId} · {contract.eventCount.toLocaleString()} events · Last activity{' '}
              {new Date(contract.lastSeenAt).toLocaleString()}
            </option>
          ))}
        </select>
        {contractsError && (
          <span className="muted small" role="status">
            Could not load indexed contracts: {contractsError}
          </span>
        )}
        <button type="button" className="link-button" onClick={onUseExample}>
          {t('useTestnetExample')}
        </button>
      </div>

      <div className="field">
        <label htmlFor="topic">{t('topicLabel')}</label>
        <input
          id="topic"
          name="topic"
          className="mono"
          list="known-topics"
          placeholder={t('topicPlaceholder')}
          spellCheck={false}
          autoComplete="off"
          value={value.topic}
          onChange={(e) => set('topic', e.target.value.trim())}
        />
        <datalist id="known-topics">
          {knownTopics.map((tc) => (
            <option key={tc.topic} value={tc.topic}>{`${tc.topic} (${tc.count})`}</option>
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
          {t('successfulOnly')}
        </label>
        <label>
          <input
            type="checkbox"
            checked={value.live}
            onChange={(e) => set('live', e.target.checked)}
          />
          {t('liveUpdates')}
        </label>
      </div>
    </form>
  );
}
