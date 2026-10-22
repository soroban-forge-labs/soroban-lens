import type { RetentionState } from './types.js';

/**
 * The node's retention window at the moment a stream saved its position (#17).
 *
 * Persisted next to the cursor so a restart can compare what the node held then
 * with what it holds now. Ledger numbers rather than close times: the close
 * times only ever existed as empty strings, and nothing needs them to answer
 * "did this node forget my cursor while I was down".
 */
export interface RetentionSnapshot {
  latestLedger: number;
  oldestLedger: number;
}

/** A saved position, compared with the window the node serves right now. */
export interface RetentionComparison {
  /** Last ledger the stream is known to have processed. */
  checkpointLedger: number;
  /** Oldest ledger the node serves now. */
  oldestLedger: number;
  /** The checkpoint sits before `oldestLedger`, so the cursor cannot be served. */
  pastWindow: boolean;
  /** Ledgers between the checkpoint and the oldest retained ledger. */
  lostLedgers: number;
  /**
   * How far the oldest ledger moved since the snapshot was taken, floored at
   * zero. Omitted entirely when the cursor predates snapshotting. A node can
   * report a *wider* window than before after a resync; that is not movement
   * past the checkpoint, so it is not reported as a negative shift.
   */
  windowShiftLedgers?: number;
}

/**
 * Compare a saved cursor with the node's current retention window.
 *
 * `checkpointLedger <= 0` means the saved state carries no usable position
 * (a legacy file, or a tombstone), so nothing can be concluded from it.
 */
export function compareRetention(
  checkpoint: { ledger: number; retention?: RetentionSnapshot },
  current: RetentionState,
): RetentionComparison {
  const pastWindow = checkpoint.ledger > 0 && checkpoint.ledger < current.oldestLedger;
  const comparison: RetentionComparison = {
    checkpointLedger: checkpoint.ledger,
    oldestLedger: current.oldestLedger,
    pastWindow,
    lostLedgers: pastWindow ? current.oldestLedger - checkpoint.ledger : 0,
  };
  if (checkpoint.retention) {
    comparison.windowShiftLedgers = Math.max(
      0,
      current.oldestLedger - checkpoint.retention.oldestLedger,
    );
  }
  return comparison;
}

/**
 * One-paragraph warning for a gap that is already known to be unrecoverable,
 * or `null` when the saved position is still inside the window.
 *
 * Deliberately says what was lost and what happens next: the recovery path is
 * destructive (the saved cursor is cleared and indexing restarts at the oldest
 * retained ledger), so the log line has to explain the re-index before it
 * happens rather than after.
 */
export function describeRetentionGap(
  comparison: RetentionComparison,
  savedAt?: string,
): string | null {
  if (!comparison.pastWindow) return null;
  const when = savedAt ? ` (last saved ${savedAt})` : '';
  const shift =
    comparison.windowShiftLedgers !== undefined && comparison.windowShiftLedgers > 0
      ? ` The window has advanced ${comparison.windowShiftLedgers} ledgers since then.`
      : '';
  return (
    `WARNING: the node's retention window has moved past this stream's saved position. ` +
    `It retains from ledger ${comparison.oldestLedger}, but the stream stopped at ledger ` +
    `${comparison.checkpointLedger}${when}.${shift} ` +
    `${comparison.lostLedgers} ledger(s) of events in between are unrecoverable from this node; ` +
    `indexing will restart from ledger ${comparison.oldestLedger} once the saved cursor is rejected.`
  );
}
