import { describe, expect, it } from 'vitest';
import { mergeLivePage } from '../../src/live.js';
import { makeEvent } from './fixtures.js';

const ev = (id: string) => makeEvent(0, { id });

// #186: a live tick re-reads page one; merging keeps every loaded row instead
// of snapping the table back to the newest fifty.
describe('mergeLivePage (#186)', () => {
  it('keeps rows from both loaded pages and lands only genuinely new ids on top', () => {
    const page1 = [ev('e1'), ev('e2'), ev('e3')];
    const page2 = [ev('e4'), ev('e5')]; // pulled in with "Load more"
    const fresh = [ev('e0'), ev('e1'), ev('e2'), ev('e3')]; // the tick's re-read

    const merged = mergeLivePage([...page1, ...page2], fresh);
    expect(merged.map((e) => e.id)).toEqual(['e0', 'e1', 'e2', 'e3', 'e4', 'e5']);
  });

  it('returns the loaded list untouched when the tick brings nothing new', () => {
    const loaded = [ev('e1'), ev('e2')];
    expect(mergeLivePage(loaded, [ev('e1'), ev('e2')])).toBe(loaded);
  });

  it('is just the fresh page when nothing is loaded yet', () => {
    const fresh = [ev('e1')];
    expect(mergeLivePage([], fresh)).toBe(fresh);
  });
});
