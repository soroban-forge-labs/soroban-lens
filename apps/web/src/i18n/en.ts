/**
 * English locale — the canonical source of truth.
 *
 * Every user-facing string in the web UI lives here.  To add a second
 * language, copy this file, give it the new locale code, and translate
 * the values.  TypeScript will enforce that every key is present.
 */
export const en = {
  // ── App header ──────────────────────────────────────────────────────────────
  tagline: 'See what your Soroban contracts are actually emitting.',
  switchToLight: 'Switch to light theme',
  switchToDark: 'Switch to dark theme',

  // ── Locale switcher ──────────────────────────────────────────────────────────
  language: 'Language',

  // ── Result meta bar ──────────────────────────────────────────────────────────
  /** Receives the formatted number as {count} and the suffix as {suffix}. */
  eventCount: '{count} event{suffix}',
  eventCountForContract: '{count} event{suffix} for this contract',
  eventCountWithTopic: '{count} event{suffix} with topic "{topic}"',
  eventCountForContractWithTopic: '{count} event{suffix} for this contract with topic "{topic}"',
  live: 'live',
  streamingLive: 'Streaming live updates',
  pollingFallback: 'Polling every 5 seconds',
  absoluteTime: 'Absolute time',
  relativeTime: 'Relative time',
  showAbsoluteTimes: 'Show absolute timestamps',
  showRelativeTimes: 'Show relative timestamps',

  // ── Export ────────────────────────────────────────────────────────────────────
  exportJson: 'Export JSON',
  exportCsv: 'Export CSV',
  exportJsonTitle: 'Export current events as JSON',
  exportCsvTitle: 'Export current events as CSV',

  // ── Validation ────────────────────────────────────────────────────────────────
  invalidContractId:
    "That does not look like a contract id. Expected a StrKey: C followed by 55 upper-case letters and digits 2\u20137.",

  // ── Empty / loading states ────────────────────────────────────────────────────
  loading: 'Loading\u2026',
  emptyContractUnknown:
    'This contract has not been seen by this indexer. Check the id, and that it is one this instance indexes (LENS_CONTRACT_IDS).',
  emptyNoMatchingEvents: 'This contract is indexed, but no events match these filters.',
  emptyNothingIndexed:
    'Nothing indexed yet. Start the indexer, or load the fixture with `npm run seed`.',
  emptyNoResults: 'No events match these filters.',

  // ── Load more ─────────────────────────────────────────────────────────────────
  loadMore: 'Load more',
  loadingMore: 'Loading\u2026',

  // ── Footer ────────────────────────────────────────────────────────────────────
  footerTagline: 'Soroban Lens \u2014 a reading lens for Soroban contract events.',
  sourceLink: 'Source',

  // ── StatusBar ─────────────────────────────────────────────────────────────────
  networkLabel: 'Network',
  connected: 'connected',
  degraded: 'degraded',
  connecting: 'connecting\u2026',
  /** {count} and {contracts} are interpolated. */
  healthStats: '{count} events \u00b7 {contracts} contracts',
  /** {time} is a locale-formatted time string. */
  lastUpdated: 'updated {time}',
  networkMismatch:
    'This API reports network {reported}, but it is configured here as {selected}. Check VITE_LENS_NETWORKS and the indexer\u2019s LENS_NETWORK.',

  // ── Filters ───────────────────────────────────────────────────────────────────
  contractIdLabel: 'Contract ID',
  contractIdPlaceholder: 'C\u2026 (leave empty to see every indexed contract)',
  useTestnetExample: 'use the testnet XLM contract',
  topicLabel: 'Topic',
  topicPlaceholder: 'transfer',
  successfulOnly: 'Successful calls only',
  liveUpdates: 'Live updates',

  // ── EventTable column headers ─────────────────────────────────────────────────
  expandDetails: 'Expand event details',
  collapseDetails: 'Collapse event details',
  colExpand: 'Expand',
  colLedger: 'Ledger',
  colContract: 'Contract',
  colTopic: 'Topic',
  colValue: 'Value',
  colTx: 'Tx',

  // ── EventRow ──────────────────────────────────────────────────────────────────
  filterByTopic: 'Filter by "{topic}"',
  additionalTopics: '+{count}',
  failedCallWarning:
    'Emitted during a contract call that did not succeed. It is indexed for completeness, but it did not take effect on chain.',
  decodeError: 'Decode error: {message}',
  detailEventId: 'Event id',
  detailContract: 'Contract',
  detailLedger: 'Ledger',
  detailClosedAt: 'Closed at',
  detailTransaction: 'Transaction',
  detailPosition: 'Position',
  detailPositionValue: 'tx {txIndex} / op {opIndex}',
  typedSourceBuiltIn: 'decoded with the built-in Stellar Asset Contract spec',
  typedSourceOwn: "decoded with the contract's own spec",
  topicsHeading: 'Topics',
  valueHeading: 'Value',
  rawXdr: 'Raw XDR',
  rawXdrDesc: 'Exactly what the network emitted. The decoded fields above are derived from these.',
  rawTopicsHeading: 'Topics',
  rawValueHeading: 'Value',

  // ── ErrorBoundary ─────────────────────────────────────────────────────────────
  componentError: 'Component Error',
  defaultErrorMessage: 'An unexpected rendering error occurred.',
  reloadComponent: 'Reload Component',
} as const;

/** The shape every locale must satisfy. */
export type Catalogue = { [K in keyof typeof en]: string };
