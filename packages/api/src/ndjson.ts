import { acceptQuality } from './csv.js';

/**
 * NDJSON streaming for the event-list routes (#180).
 *
 * One JSON object per line, so `curl … | jq` works on a range of any size
 * without the client buffering a page array.
 */
export const NDJSON_CONTENT_TYPE = 'application/x-ndjson';

/** Rows streamed per response unless configured otherwise. */
export const DEFAULT_NDJSON_MAX_ROWS = 1_000_000;

/**
 * Whether the caller asked for NDJSON. Like CSV it has to be requested by name
 * (or by `application/*`) and outrank JSON — a bare `*\/*` stays JSON.
 */
export function wantsNdjson(accept: string | string[] | undefined): boolean {
  return acceptQuality(accept, NDJSON_CONTENT_TYPE) > acceptQuality(accept, 'application/json');
}

/** The final line of every NDJSON stream. */
export interface NdjsonTrailer {
  trailer: {
    /** Event lines written before this one. */
    rows: number;
    /** True when more events matched than the row cap allowed. */
    capped: boolean;
    /** The row cap in force. */
    cap: number;
  };
}

export function trailerLine(rows: number, capped: boolean, cap: number): string {
  const trailer: NdjsonTrailer = { trailer: { rows, capped, cap } };
  return `${JSON.stringify(trailer)}\n`;
}
