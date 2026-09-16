/**
 * Mirrors Module 3's response shapes.
 *
 * Hand-written rather than generated, so the UI has no build-time dependency on
 * the API package. `packages/api/openapi.json` is the contract; regenerate with
 * an OpenAPI client generator if you would rather not maintain these by hand.
 * Generated: 2026-09-16
 */

export interface DecodedValue {
  /** ScVal arm: "symbol", "i128", "address", "map", "vec", "bytes", … */
  type: string;
  value: unknown;
}

export interface LensEvent {
  id: string;
  contractId: string;
  type: 'contract' | 'system';
  ledger: number;
  ledgerClosedAt: string;
  txHash: string;
  transactionIndex: number;
  operationIndex: number;
  inSuccessfulContractCall: boolean;
  topics: DecodedValue[];
  topicsXdr: string[];
  value: DecodedValue;
  valueXdr: string;
  decodeError?: string;
  indexedAt: string;
}

export interface EventPage {
  events: LensEvent[];
  nextCursor: string | null;
  total: number;
}

export interface ContractSummary {
  contractId: string;
  eventCount: number;
  firstLedger: number;
  lastLedger: number;
  lastSeenAt: string;
}

export interface Health {
  status: 'ok' | 'degraded';
  detail: string;
  version: string;
  network: string;
  uptimeSeconds: number;
  events: number;
  contracts: number;
  schemaVersion: number;
}

export interface TopicCount {
  topic: string;
  count: number;
}

export interface ApiErrorBody {
  error: { code: string; message: string; parameter?: string };
}
