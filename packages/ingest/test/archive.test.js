import test from 'node:test';
import assert from 'node:assert/strict';
import { StellarArchiveSource } from '../dist/index.js';

const event = { id: '0000000000000000001-0000000000', type: 'contract', ledger: 10, ledgerClosedAt: '2026-01-01T00:00:00Z', contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', topic: ['topic'], value: 'value', txHash: 'a'.repeat(64), transactionIndex: 0, operationIndex: 0, inSuccessfulContractCall: true };

test('archive source reads checkpoint event payloads and applies contract filters', async () => {
  const calls = [];
  const source = new StellarArchiveSource({ archiveUrl: 'https://archive.test/root', fetchImpl: async (url) => {
    calls.push(url);
    if (url.endsWith('.well-known/stellar-history.json')) return new Response(JSON.stringify({ currentLedger: 100 }));
    return new Response(JSON.stringify({ events: [event] }));
  } });
  assert.deepEqual(await source.range(), { source: 'archive', fromLedger: 1, toLedger: 100 });
  const page = await source.getEvents({ startLedger: 1, endLedger: 63, filters: [{ contractIds: [event.contractId] }] });
  assert.equal(page.events.length, 1);
  assert.match(calls[1], /events\/00\/00\/00\/events-0000003f\.json$/);
});
