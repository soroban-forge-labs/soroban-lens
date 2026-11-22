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

/** Account or contract StrKey — the only shape the API's `address=` accepts. */
const ADDRESS_PATTERN = /^[GC][A-Z2-7]{55}$/;

/** Preset windows offered by the time-range filter (#190). */
const TIME_PRESETS: { value: string; label: string }[] = [
  { value: '15m', label: 'Last 15 minutes' },
  { value: '1h', label: 'Last hour' },
  { value: '24h', label: 'Last day' },
  { value: 'custom', label: 'Custom…' },
];

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

  const addressInvalid = value.address !== '' && !ADDRESS_PATTERN.test(value.address);
  const searchShort = value.search !== '' && value.search.length < 3;

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
        <label htmlFor="address">{t('addressLabel')}</label>
        <input
          id="address"
          name="address"
          className="mono"
          placeholder={t('addressPlaceholder')}
          spellCheck={false}
          autoComplete="off"
          value={value.address}
          aria-invalid={addressInvalid}
          onChange={(e) => set('address', e.target.value.trim())}
        />
      </div>

      <div className="field">
        <label htmlFor="search">{t('searchLabel')}</label>
        <input
          id="search"
          name="search"
          placeholder={t('searchPlaceholder')}
          spellCheck={false}
          autoComplete="off"
          value={value.search}
          onChange={(e) => set('search', e.target.value)}
        />
        {searchShort && (
          <span className="muted small" role="status">
            {t('searchMinChars')}
          </span>
        )}
      </div>

      <div className="field">
        <label htmlFor="timeRange">{t('timeRangeLabel')}</label>
        <select
          id="timeRange"
          name="timeRange"
          value={value.timeRange}
          onChange={(e) => set('timeRange', e.target.value)}
        >
          <option value="">{t('timeRangeAll')}</option>
          {TIME_PRESETS.map((preset) => (
            <option key={preset.value} value={preset.value}>{preset.label}</option>
          ))}
        </select>
        {value.timeRange === 'custom' && (
          <>
            <input
              type="datetime-local"
              aria-label={t('timeRangeFrom')}
              value={value.customFromTime}
              onChange={(e) => set('customFromTime', e.target.value)}
            />
            <input
              type="datetime-local"
              aria-label={t('timeRangeTo')}
              value={value.customToTime}
              onChange={(e) => set('customToTime', e.target.value)}
            />
          </>
        )}
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
