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
  EventType,
} from './types.js';

export { LensRpcClient, buildFilters, MAX_PAGE_SIZE, MAX_CONTRACT_IDS_PER_FILTER } from './rpc-client.js';
export type { RpcClientOptions, GetEventsArgs } from './rpc-client.js';

export { EventPoller, defaultCursorKey, ingestionLag, APPROX_LEDGER_SECONDS } from './poller.js';
export type { PollerDeps, PollerProgress } from './poller.js';

export {
  measureClockSkew,
  resolveClockSkewThreshold,
  describeClockSkew,
  DEFAULT_CLOCK_SKEW_THRESHOLD_SECONDS,
} from './clock-skew.js';
export type { ClockSkew } from './clock-skew.js';

export { compareRetention, describeRetentionGap } from './retention.js';
export type { RetentionComparison, RetentionSnapshot } from './retention.js';

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

export {
  withRetry,
  backoffDelay,
  sleep,
  retryAfterMs,
  MAX_RETRY_AFTER_MS,
  RetryExhaustedError,
} from './retry.js';
export type { RetryOptions } from './retry.js';

export { IngestMetrics } from './metrics.js';
export { startMetricsServer, closeMetricsServer, parseMetricsPort } from './metrics-server.js';

export { FailoverRpcClient } from './rpc-pool.js';
export type { RpcPoolOptions } from './rpc-pool.js';
export { StellarArchiveSource } from './archive.js';
export type { ArchiveSourceOptions, ArchiveRange } from './archive.js';
