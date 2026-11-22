import { MAX_PAGE_SIZE } from './rpc-client.js';

/**
 * Adaptive page size (#14).
 *
 * A fixed page size is wrong in both directions: a quiet contract pays a round
 * trip for a handful of events, a busy one pays dozens of round trips to walk
 * history a single larger request would have covered. Neither is knowable in
 * advance, so the size follows what the node actually does:
 *
 * - a full page that came back fast doubles it (there is more, and the node
 *   is coping),
 * - a slow page, or a failed request, halves it,
 * - anything else leaves it alone,
 *
 * always within `[min, max]`. Multiplicative both ways, so it reaches either
 * bound in a handful of pages instead of creeping.
 *
 * A shrink also lowers a ceiling to the new size, so the next fast page does
 * not double straight back into the size that just failed — without it, a node
 * that times out above some size gets probed there on every other request.
 * The ceiling lifts one step after `PROBE_AFTER_PAGES` good pages in a row, so
 * a node that recovers is eventually asked for more again.
 */
export interface PageSizeBounds {
  min: number;
  max: number;
}

export interface AdaptivePageSizeOptions extends PageSizeBounds {
  /** Where to start. Clamped into the bounds. */
  initial: number;
  /** A full page answered within this is "fast": grow. @default 1000 */
  fastMs?: number;
  /** Any page slower than this is "slow": shrink. @default 5000 */
  slowMs?: number;
}

/** Good pages in a row before a lowered ceiling is raised one step. */
export const PROBE_AFTER_PAGES = 50;

export class AdaptivePageSize {
  readonly #min: number;
  readonly #max: number;
  readonly #fastMs: number;
  readonly #slowMs: number;
  #size: number;
  #ceiling: number;
  #goodPages = 0;

  constructor(options: AdaptivePageSizeOptions) {
    assertBounds(options);
    this.#min = options.min;
    this.#max = options.max;
    this.#fastMs = options.fastMs ?? 1000;
    this.#slowMs = options.slowMs ?? 5000;
    if (!(this.#fastMs < this.#slowMs)) throw new RangeError('fastMs must be below slowMs');
    this.#size = clamp(options.initial, this.#min, this.#max);
    this.#ceiling = this.#max;
  }

  /** The page size to ask for next. */
  get size(): number {
    return this.#size;
  }

  /** True when the bounds leave room to adapt at all. */
  get adaptive(): boolean {
    return this.#min < this.#max;
  }

  /** Record a page that came back. */
  recordPage(events: number, elapsedMs: number): void {
    if (elapsedMs > this.#slowMs) {
      this.#shrink();
      return;
    }
    if (++this.#goodPages >= PROBE_AFTER_PAGES && this.#ceiling < this.#max) {
      this.#ceiling = Math.min(this.#max, this.#ceiling * 2);
      this.#goodPages = 0;
    }
    if (events >= this.#size && elapsedMs <= this.#fastMs) this.#size = Math.min(this.#ceiling, this.#size * 2);
  }

  /** Record a request that failed (a timeout, or retries exhausted). */
  recordFailure(): void {
    this.#shrink();
  }

  #shrink(): void {
    this.#size = Math.max(this.#min, Math.floor(this.#size / 2));
    this.#ceiling = this.#size;
    this.#goodPages = 0;
  }
}

export function assertBounds({ min, max }: PageSizeBounds): void {
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max > MAX_PAGE_SIZE || min > max) {
    throw new RangeError(`page size bounds must be integers with 1 <= min <= max <= ${MAX_PAGE_SIZE}, got [${min}, ${max}]`);
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(n)));
}
