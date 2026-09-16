/**
 * Module 2 — Decoding & Storage.
 *
 * Public surface: the `EventStore` trait, its SQLite implementation, the XDR
 * decoder, and the record types the rest of the system reads.
 */
export type {
  JsonValue,
  RawEventInput,
  DecodedValue,
  LensEvent,
  EventQuery,
  EventPage,
  ContractSummary,
  StreamState,
  StoreStats,
} from './types.js';

export type { EventStore } from './store.js';
export {
  MAX_QUERY_LIMIT,
  DEFAULT_MAX_QUERY_LIMIT,
  DEFAULT_QUERY_LIMIT,
  resolveMaxQueryLimit,
  normaliseLimit,
} from './store.js';

export { SqliteEventStore, INDEXED_TOPIC_DEPTH } from './sqlite-store.js';
export type { SqliteStoreOptions } from './sqlite-store.js';

export { decodeEvent, decodeScVal, toJsonSafe, scValTypeName, topicKey, extractAddresses } from './decode.js';
export { compressXdrColumn, decompressXdrColumn, encodeXdrColumn } from './xdr-compression.js';
export { runEventStoreSuite } from './testing.js';
export type { EventStoreSuiteOptions } from './testing.js';

export { MIGRATIONS, LATEST_SCHEMA_VERSION } from './schema.js';
export { createLogger, formatRecord, resolveLogFormat } from './logger.js';
export type { Logger, LogLevel, LogRecord, LogFields, LogFormat, LoggerOptions } from './logger.js';
export type { Migration } from './schema.js';
