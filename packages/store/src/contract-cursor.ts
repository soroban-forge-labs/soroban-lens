/**
 * Cursor for `listContractsPage`: the ledger snapshot the walk started at, plus
 * the (lastLedger, contractId) keyset position. The snapshot is what makes a
 * walk stable while events keep arriving — every page aggregates only events at
 * or below it, so a contract's position cannot move mid-walk.
 */
export interface ContractCursor {
  snapshot: number;
  lastLedger: number;
  contractId: string;
}

export function encodeContractCursor(c: ContractCursor): string {
  return Buffer.from(`${c.snapshot}:${c.lastLedger}:${c.contractId}`).toString('base64url');
}

/** @throws Error when the cursor is not one this store issued. */
export function decodeContractCursor(raw: string): ContractCursor {
  const m = /^(\d+):(\d+):([A-Z0-9]+)$/.exec(Buffer.from(raw, 'base64url').toString('utf8'));
  if (!m) throw new Error('Invalid contracts cursor.');
  return { snapshot: Number(m[1]), lastLedger: Number(m[2]), contractId: m[3] as string };
}
