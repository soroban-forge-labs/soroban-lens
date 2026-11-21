import type { LensEvent } from '../../src/types.js';

/** A plausible decoded transfer, with the ledger and index varied per row. */
export function makeEvent(i: number, overrides: Partial<LensEvent> = {}): LensEvent {
  const ledger = 4_695_317 + Math.floor(i / 10);
  return {
    id: `${String(ledger * 4096).padStart(19, '0')}-${String(i).padStart(10, '0')}`,
    contractId: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
    type: 'contract',
    ledger,
    ledgerClosedAt: '2026-09-15T19:22:52Z',
    txHash: 'c7e2ba28f4f4e4ac3fcd7ef0a98d558f7019f4df6b4c5ef3941ca539468a31b5',
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    topics: [
      { type: 'symbol', value: 'transfer' },
      { type: 'address', value: 'GBYRNL77SLMBVGJLFYVWB762E7ZJJVSGEDOU626FPOCGOMPG776JQHHT' },
    ],
    topicsXdr: ['AAAADwAAAAh0cmFuc2Zlcg=='],
    value: { type: 'i128', value: String(1000 + i) },
    valueXdr: 'AAAACgAAAAAAAAAAAAAAAAAAAGQ=',
    indexedAt: '2026-09-15T19:23:00Z',
    ...overrides,
  };
}

export const makeEvents = (n: number): LensEvent[] => Array.from({ length: n }, (_, i) => makeEvent(i));
