import type { Health } from '../types.js';
import type { NetworkOption } from '../api.js';
import { useLocale } from '../i18n/index.js';

// Props for StatusBar component
interface Props {
  networks: NetworkOption[];
  selected: NetworkOption;
  onSelect: (network: NetworkOption) => void;
  health: Health | null;
  error: string | null;
  lastUpdated: number | null;
}

export function StatusBar({
  networks, selected, onSelect, health, error, lastUpdated,
}: Props): React.JSX.Element {
  const { t } = useLocale();

  // The label the user picked and the network the API actually indexed can
  // disagree if the compose file is misconfigured. Saying so is far kinder than
  // letting someone read testnet data believing it is mainnet.
  //
  // An older API that predates the /health `network` field reports nothing at
  // all, which is "I don't know", not "mismatch" — warning there would cry wolf
  // on every upgrade.
  const reported = health?.network ?? '';
  const mismatch = reported !== '' && reported !== 'unknown' && reported !== selected.label;

  // The active RPC provider comes from /status (#110). Older APIs omit it, so
  // we hide the indicator entirely rather than showing a misleading blank.
  // We show the human label, never the raw URL, and warn when the indexer has
  // failed over off the primary endpoint.
  const provider = health?.rpcProvider;
  const providerLabel = provider?.label ?? '';
  const providerIsBackup = provider?.primary === false;

  // Paused contract streams come from /status (#326). Older APIs omit the
  // field, so we only render the indicator when at least one stream is paused.
  const pausedContracts = health?.pausedContracts ?? [];

  return (
    <div className="status-bar">
      <div className="status-left">
        <label htmlFor="network" className="sr-only">{t('networkLabel')}</label>
        <select
          id="network"
          value={selected.label}
          onChange={(e) => {
            const next = networks.find((n) => n.label === e.target.value);
            if (next) onSelect(next);
          }}
        >
          {networks.map((n) => (
            <option key={n.label} value={n.label}>{n.label}</option>
          ))}
        </select>
        <span className="muted small mono">{selected.baseUrl}</span>
      </div>

      <div className="status-right">
        {error ? (
          <span className="status-pill status-error" role="status">{error}</span>
        ) : health ? (
          <>
            <span className={`status-pill status-${health.status}`} role="status">
              {health.status === 'ok' ? t('connected') : t('degraded')}
            </span>
            {providerLabel !== '' && (
              <span
                className={`status-pill small${providerIsBackup ? ' status-warning' : ''}`}
                role="status"
                title={providerIsBackup ? t('rpcProviderBackup') : t('rpcProviderPrimary')}
              >
                {t('rpcProvider', { provider: providerLabel })}
              </span>
            )}
            {pausedContracts.length > 0 && (
              <span
                className="status-pill small status-warning"
                role="status"
                title={pausedContracts.join(', ')}
              >
                {t('pausedContracts', { count: pausedContracts.length })}
              </span>
            )}
            <span className="muted small">
              {t('healthStats', {
                count: health.events.toLocaleString(),
                contracts: health.contracts,
              })}
            </span>
            {lastUpdated && (
              <span className="muted small">
                {t('lastUpdated', { time: new Date(lastUpdated).toLocaleTimeString() })}
              </span>
            )}
          </>
        ) : (
          <span className="status-pill" role="status">{t('connecting')}</span>
        )}
      </div>

      {mismatch && (
        <p className="warning banner">
          {t('networkMismatch', { reported, selected: selected.label })}
        </p>
      )}
    </div>
  );
}
