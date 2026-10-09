/** Module 5 — the `lens` CLI, exposed as a library for tests and embedding. */
export { resolveConfig, splitList, parseHeaders, redactHeaders } from './config.js';
export type { LensConfig, ConfigOverrides } from './config.js';
export { runDoctor, formatReport } from './doctor.js';
export type { CheckResult, CheckStatus } from './doctor.js';
export { runIndexer, StoreBackedCursors } from './indexer.js';
export type { IndexerOptions, IndexerResult } from './indexer.js';
export {
  SpecFetcher,
  lookupContractSpec,
  recordFromWasm,
  recordFromWasmFile,
  describeSpecRecord,
  rpcSpecSource,
} from './specs.js';
export type { SpecSource } from './specs.js';
