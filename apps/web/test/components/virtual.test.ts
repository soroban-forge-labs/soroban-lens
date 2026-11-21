import { describe, expect, it } from 'vitest';
import { computeWindow, offsetOf, scrollToReveal } from '../../src/virtual.js';

const flat = (n: number, h = 40): number[] => Array.from({ length: n }, () => h);

describe('computeWindow', () => {
  it('at the top, renders the viewport plus overscan and pads the rest', () => {
    const w = computeWindow({ heights: flat(1000), scrollTop: 0, viewportHeight: 400, overscanPx: 200 });
    expect(w).toEqual({ start: 0, end: 15, padTop: 0, padBottom: 985 * 40 });
  });

  it('mid-list, spacers account for exactly the rows they replace', () => {
    const heights = flat(1000);
    const w = computeWindow({ heights, scrollTop: 20_000, viewportHeight: 400, overscanPx: 200 });
    expect(w.start).toBe(495);
    expect(w.padTop).toBe(495 * 40);
    expect(w.padTop + offsetOf(heights.slice(w.start, w.end), w.end - w.start) + w.padBottom).toBe(40_000);
  });

  it('a tall expanded row is accounted for at its real height', () => {
    const heights = flat(100);
    heights[2] = 500;
    const w = computeWindow({ heights, scrollTop: 600, viewportHeight: 100, overscanPx: 0 });
    // Rows 0-1 (80px) + row 2 (500px) end at 580, so row 3 is the first visible.
    expect(w.start).toBe(3);
    expect(w.padTop).toBe(580);
  });

  it('a table still below the fold renders its first rows', () => {
    const w = computeWindow({ heights: flat(1000), scrollTop: -300, viewportHeight: 400, overscanPx: 0 });
    expect(w.start).toBe(0);
    expect(w.end).toBe(3);
  });
});

describe('scrollToReveal', () => {
  const heights = flat(100);
  it('does nothing for a row already in view', () => {
    expect(scrollToReveal(heights, 5, 0, 400)).toBeNull();
  });
  it('scrolls down just enough to show a row below the viewport', () => {
    expect(scrollToReveal(heights, 10, 0, 400)).toBe(440 - 400);
  });
  it('scrolls up to the top of a row above the viewport', () => {
    expect(scrollToReveal(heights, 3, 1000, 400)).toBe(120);
  });
});
