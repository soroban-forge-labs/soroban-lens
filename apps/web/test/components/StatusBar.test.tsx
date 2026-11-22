import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusBar } from '../../src/components/StatusBar.js';
import { LocaleProvider } from '../../src/i18n/index.js';
import type { Health } from '../../src/types.js';

const networks = [
  { label: 'testnet', baseUrl: 'http://localhost:8080' },
  { label: 'mainnet', baseUrl: 'http://localhost:8081' },
];
const health = (network: string): Health => ({
  status: 'ok', detail: '', version: '0.1.0', network, uptimeSeconds: 10, events: 60, contracts: 3, schemaVersion: 6,
});

function renderBar(reported: string | null, selected = networks[0]!) {
  return render(
    <LocaleProvider>
      <StatusBar
        networks={networks}
        selected={selected}
        onSelect={() => {}}
        health={reported === null ? null : health(reported)}
        error={null}
        lastUpdated={null}
      />
    </LocaleProvider>,
  );
}

describe('network-mismatch warning', () => {
  it('warns when the API indexes a different network than the one selected', () => {
    renderBar('mainnet');
    const warning = screen.getByText(/mainnet/i, { selector: 'p.warning' });
    expect(warning.textContent).toMatch(/testnet/);
  });

  it('stays quiet when they agree', () => {
    const { container } = renderBar('testnet');
    expect(container.querySelector('p.warning')).toBeNull();
  });

  it('stays quiet for an API too old to report its network', () => {
    expect(renderBar('unknown').container.querySelector('p.warning')).toBeNull();
    expect(renderBar('').container.querySelector('p.warning')).toBeNull();
    expect(renderBar(null).container.querySelector('p.warning')).toBeNull();
  });
});
