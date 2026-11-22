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
  lightMode: 'Light mode',
  darkMode: 'Dark mode',

  // ── Locale switcher ──────────────────────────────────────────────────────────
  language: 'Language',

  // ── Result meta bar ──────────────────────────────────────────────────────────
  /** Receives the formatted number as {count} and the suffix as {suffix}. */
  eventCount: '{count} event{suffix}',
  eventCountForContract: '{count} event{suffix} for this contract',
  eventCountWithTopic: '{count} event{suffix} with topic "{topic}"',
  eventCountForContractWithTopic: '{count} event{suffix} for this contract with topic "{topic}"',
  /** The same four lines when the API marks the total as a cached estimate. */
  eventCountEstimate: 'about {count} event{suffix}',
  eventCountForContractEstimate: 'about {count} event{suffix} for this contract',
  eventCountWithTopicEstimate: 'about {count} event{suffix} with topic "{topic}"',
  eventCountForContractWithTopicEstimate: 'about {count} event{suffix} for this contract with topic "{topic}"',
  eventCountEstimateTitle:
    'Estimated total \u2014 the API served this count from a short-lived cache instead of counting every row, so it can be a few seconds behind.',
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
    'Nothing indexed yet, and the indexer has never run against this database. Start it with `lens index` (or `docker compose up`), or load the sample data with `npm run seed`.',
  emptyIndexerCatchingUp:
    'The indexer is running (last at ledger {ledger}) but has not stored an event yet. It may still be working through history, or the watched contracts may be quiet; events appear here as they are indexed.',
  emptyApiUnreachable:
    'Cannot reach the API, so there is nothing to show. Check it is running (`npm run api`, or `docker compose ps`) and that this network\'s URL is right.',
  emptyRequestFailed: 'The events request failed (see the message above), so these results are not a real answer. Fix the request, or retry once the API recovers.',
  emptyNoResults: 'No events match these filters. Clear or loosen a filter to see more.',

  // ── Load more ─────────────────────────────────────────────────────────────────
  loadMore: 'Load {count} more',
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
