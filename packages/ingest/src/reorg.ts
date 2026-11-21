import type { RawEvent } from './types.js';

/**
 * Reorg detection (#3).
 *
 * Stellar's consensus makes a deep reorg very unlikely, not impossible, and an
 * indexer that writes each event once and never looks back would keep wrong
 * rows forever with nothing to say so. The poller re-reads the most recent few
 * ledgers whenever the tip moves and compares them with what was stored; this
 * module is the comparison, kept pure so it can be tested on its own.
 */

/** What the consumer has stored for one event: enough to tell whether it changed. */
export interface StoredEventRef {
  id: string;
  ledger: number;
  txHash: string;
  inSuccessfulContractCall: boolean;
  /** Base64 XDR, as stored. */
  topicsXdr: string[];
  valueXdr: string;
}

/** How the stored rows for a window of ledgers differ from the network's current history. */
export interface ReorgDiff {
  fromLedger: number;
  toLedger: number;
  /** Stored, but no longer in the network's history. */
  removed: string[];
  /** In the network's history, never stored. */
  added: RawEvent[];
  /** Same id, different contents; the network's version. */
  changed: RawEvent[];
}

/** Where the poller reads back what it stored, and hands over repairs. */
export interface ReorgStore {
  /** Stored events with `fromLedger <= ledger <= toLedger`, for this stream's contracts. */
  eventsInLedgers(fromLedger: number, toLedger: number): Promise<StoredEventRef[]>;
  /** Make the stored rows match the network: delete removed and changed rows, insert added and changed. */
  applyReorg(diff: ReorgDiff): Promise<void>;
}

/** Re-poll this many of the most recent ledgers each cycle unless configured otherwise. */
export const DEFAULT_REORG_DEPTH = 3;

/**
 * Compare the stored rows with the network's events for the same window.
 * Both inputs must already be limited to the window; order does not matter.
 */
export function diffLedgerWindow(
  window: { fromLedger: number; toLedger: number },
  stored: StoredEventRef[],
  truth: RawEvent[],
): ReorgDiff {
  const storedById = new Map(stored.map((e) => [e.id, e]));
  const truthIds = new Set(truth.map((e) => e.id));
  const added: RawEvent[] = [];
  const changed: RawEvent[] = [];

  for (const event of truth) {
    const mine = storedById.get(event.id);
    if (!mine) added.push(event);
    else if (!sameContents(mine, event)) changed.push(event);
  }
  const removed = stored.filter((e) => !truthIds.has(e.id)).map((e) => e.id);
  return { ...window, removed, added, changed };
}

export function isEmptyDiff(diff: ReorgDiff): boolean {
  return diff.removed.length === 0 && diff.added.length === 0 && diff.changed.length === 0;
}

/** One loud line for the log: a reorg is rare enough that every one deserves reading. */
export function describeReorg(diff: ReorgDiff): string {
  const parts = [
    diff.removed.length > 0 ? `${diff.removed.length} removed (${preview(diff.removed)})` : '',
    diff.changed.length > 0 ? `${diff.changed.length} changed (${preview(diff.changed.map((e) => e.id))})` : '',
    diff.added.length > 0 ? `${diff.added.length} added (${preview(diff.added.map((e) => e.id))})` : '',
  ].filter(Boolean);
  return (
    `REORG: stored events for ledgers ${diff.fromLedger}..${diff.toLedger} no longer match the network: ` +
    `${parts.join(', ')}. Rewriting them to match.`
  );
}

function sameContents(stored: StoredEventRef, event: RawEvent): boolean {
  return (
    stored.ledger === event.ledger &&
    stored.txHash === event.txHash &&
    stored.inSuccessfulContractCall === event.inSuccessfulContractCall &&
    stored.valueXdr === event.value &&
    stored.topicsXdr.length === event.topic.length &&
    stored.topicsXdr.every((t, i) => t === event.topic[i])
  );
}

function preview(ids: string[]): string {
  return ids.length <= 3 ? ids.join(', ') : `${ids.slice(0, 3).join(', ')}, …`;
}
