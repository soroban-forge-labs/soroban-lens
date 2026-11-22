/**
 * Row windowing for the event table (#64).
 *
 * "Load more" has no ceiling, and a few thousand rows of expandable DOM make
 * scrolling miserable. Only the rows near the viewport are rendered; the rest
 * are stood in for by two spacer rows whose heights are the sum of what they
 * replace. Rows have different heights — an expanded row is many times a
 * collapsed one — so heights are measured as rows render and estimated until
 * then, rather than assumed equal.
 *
 * Pure, so the arithmetic is testable without a browser.
 */

/** Collapsed row height before it has been measured, in px. Close to the real one, so the first scroll is near-accurate. */
export const ESTIMATED_ROW_PX = 42;
/** An expanded row before it has been measured. Only has to be in the right order of magnitude. */
export const ESTIMATED_EXPANDED_PX = 360;
/** Render this much beyond each edge of the viewport, so a fast scroll does not show blank space. */
export const OVERSCAN_PX = 600;
/** Below this many rows, render them all: windowing costs more than it saves, and keeps tests and find-in-page simple. */
export const VIRTUALIZE_ABOVE = 200;

export interface WindowInput {
  /** Height of every row, in order, measured or estimated. */
  heights: readonly number[];
  /** How far the top of the viewport is below the top of the first row. Negative when the table starts below the fold. */
  scrollTop: number;
  viewportHeight: number;
  overscanPx?: number;
}

export interface RowWindow {
  /** First row to render. */
  start: number;
  /** One past the last row to render. */
  end: number;
  /** Height of the spacer standing in for rows `[0, start)`. */
  padTop: number;
  /** Height of the spacer standing in for rows `[end, length)`. */
  padBottom: number;
}

/** Which rows intersect the viewport plus overscan, and how tall the spacers around them are. */
export function computeWindow({ heights, scrollTop, viewportHeight, overscanPx = OVERSCAN_PX }: WindowInput): RowWindow {
  const top = scrollTop - overscanPx;
  const bottom = scrollTop + viewportHeight + overscanPx;

  let offset = 0;
  let start = 0;
  // Skip rows that end above the window.
  while (start < heights.length && offset + (heights[start] ?? 0) <= top) {
    offset += heights[start] ?? 0;
    start++;
  }
  const padTop = offset;

  let end = start;
  while (end < heights.length && offset < bottom) {
    offset += heights[end] ?? 0;
    end++;
  }

  let padBottom = 0;
  for (let i = end; i < heights.length; i++) padBottom += heights[i] ?? 0;
  return { start, end, padTop, padBottom };
}

/** Distance from the top of the first row to the top of row `index`. */
export function offsetOf(heights: readonly number[], index: number): number {
  let offset = 0;
  for (let i = 0; i < index && i < heights.length; i++) offset += heights[i] ?? 0;
  return offset;
}

/**
 * Where to scroll so row `index` is fully visible, or `null` if it already is.
 * Moves as little as possible: to the row's top when it is above the viewport,
 * to its bottom when it is below — the way native focus scrolling behaves.
 */
export function scrollToReveal(
  heights: readonly number[],
  index: number,
  scrollTop: number,
  viewportHeight: number,
): number | null {
  const rowTop = offsetOf(heights, index);
  const rowBottom = rowTop + (heights[index] ?? 0);
  if (rowTop < scrollTop) return rowTop;
  if (rowBottom > scrollTop + viewportHeight) return rowBottom - viewportHeight;
  return null;
}
