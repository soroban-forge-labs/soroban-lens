/**
 * Module 1 — Ingestion & RPC Client.
 *
 * Public surface. Anything not re-exported here is internal and may change
 * without notice.
 */
export type {
  RawEvent,
  EventBatch,
  EventFilter,
  PollerOptions,
  RetentionState,
  TopicSegment,
} from './types.js';

export { LensRpcClient, buildFilters, MAX_PAGE_SIZE, MAX_CONTRACT_IDS_PER_FILTER } from './rpc-client.js';
export type { RpcClientOptions, GetEventsArgs } from './rpc-client.js';

export { EventPoller, defaultCursorKey } from './poller.js';
export type { PollerDeps, PollerProgress } from './poller.js';

export { FileCursorStore, MemoryCursorStore } from './cursor.js';
export type { CursorStore, CursorState } from './cursor.js';

export { NETWORKS, resolveNetwork, isNetworkName } from './networks.js';
export type { NetworkConfig, NetworkName } from './networks.js';

export {
  CONTRACT_ID_PATTERN,
  CONTRACT_ID_HINT,
  isContractId,
  assertContractIds,
  InvalidContractIdError,
} from './contract-id.js';

export { withRetry, backoffDelay, sleep, RetryExhaustedError } from './retry.js';
export type { RetryOptions } from './retry.js';
