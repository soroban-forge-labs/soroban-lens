import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { AxeBuilder } from '@axe-core/playwright';
import { chromium } from 'playwright';

const origin = 'http://127.0.0.1:4173';
const apiOrigin = 'http://localhost:8080';
const contractId = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const eventPage = {
  events: [{
    id: 'event-1',
    contractId,
    type: 'contract',
    ledger: 4695317,
    ledgerClosedAt: '2026-09-15T19:22:52Z',
    txHash: 'c7e2ba28f4f4e4ac3fcd7ef0a98d558f7019f4df6b4c5ef3941ca539468a31b5',
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    topics: [{ type: 'symbol', value: 'transfer' }],
    topicsXdr: ['AAAA'],
    value: { type: 'i128', value: '1000000' },
    valueXdr: 'AAAA',
    indexedAt: '2026-09-15T19:22:52Z',
  }],
  nextCursor: null,
  prevCursor: null,
  total: 1,
};

let server;
let browser;

before(async () => {
  server = spawn('npm', ['run', 'preview', '--', '--host', '127.0.0.1', '--port', '4173', '--strictPort'], {
    stdio: 'ignore',
  });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(origin);
      if (response.ok) break;
    } catch {
      if (server.exitCode !== null) throw new Error('Vite preview exited before becoming ready');
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  server?.kill('SIGTERM');
});

for (const theme of ['light', 'dark']) {
  test(`axe reports no violations in the ${theme} theme`, async () => {
    const context = await browser.newContext();
    await context.addInitScript(({ selectedTheme, filters }) => {
      localStorage.setItem('lens.theme', JSON.stringify(selectedTheme));
      localStorage.setItem('lens.filters', JSON.stringify(filters));
    }, {
      selectedTheme: theme,
      filters: { contractId: '', topic: '', successfulOnly: false, live: false },
    });
    await context.route(`${apiOrigin}/**`, async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      const body = pathname === '/health'
        ? { status: 'ok', detail: '', version: 'test', network: 'testnet', uptimeSeconds: 1, events: 1, contracts: 1, schemaVersion: 1 }
        : eventPage;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify(body),
      });
    });

    const page = await context.newPage();
    await page.goto(origin);
    await page.locator('.event-row').waitFor();
    await page.getByText('1 event indexed').waitFor();
    assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
    assert.equal(await page.locator('[aria-live="polite"]').count(), 1);

    const results = await new AxeBuilder({ page }).analyze();
    assert.deepEqual(results.violations, [], JSON.stringify(results.violations, null, 2));

    await page.locator('.topic-chip').click();
    assert.equal(await page.locator('#topic').inputValue(), 'transfer');
    const expandButton = page.locator('.event-row .col-toggle button');
    assert.equal(await expandButton.getAttribute('aria-expanded'), 'false');
    await expandButton.click();
    assert.equal(await expandButton.getAttribute('aria-expanded'), 'true');
    await context.close();
  });
}