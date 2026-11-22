import type { LensEvent } from './types.js';

/**
 * Merge a fresh first page into the rows already on screen (#186).
 *
 * A live tick re-reads page one, but the reader may be several "Load more"
 * pages deep — replacing the list would throw those rows away. Only ids that
 * are genuinely new land at the top, in the order the page gave them; every
 * loaded row keeps its place, so `nextCursor` can stay pointed past the
 * oldest one.
 */
export function mergeLivePage(loaded: LensEvent[], fresh: LensEvent[]): LensEvent[] {
  if (loaded.length === 0) return fresh;
  const seen = new Set(loaded.map((e) => e.id));
  const added = fresh.filter((e) => !seen.has(e.id));
  return added.length === 0 ? loaded : [...added, ...loaded];
}
