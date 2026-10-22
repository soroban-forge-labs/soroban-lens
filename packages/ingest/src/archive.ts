import { gunzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import type { EventBatch, EventFilter, RawEvent } from './types.js';

export interface ArchiveSourceOptions {
  /** Public history archive root, for example https://history.stellar.org/prd/core-testnet/core_testnet_001. */
  archiveUrl: string;
  checkpointSize?: number;
  fetchImpl?: typeof fetch;
}

export interface ArchiveRange { source: 'archive'; fromLedger: number; toLedger: number; }

/**
 * Reads the JSON event sidecar emitted by archive mirrors. The official
 * archive's canonical payload is XDR; keeping decoding behind this boundary
 * lets operators use a pre-decoded sidecar without changing the poller/store
 * contract, and makes the source testable without a network or Rust tooling.
 */
export class StellarArchiveSource {
  readonly archiveUrl: string;
  readonly checkpointSize: number;
  readonly #fetch: typeof fetch;
  constructor(options: ArchiveSourceOptions) {
    this.archiveUrl = options.archiveUrl.replace(/\/$/, '');
    this.checkpointSize = options.checkpointSize ?? 64;
    this.#fetch = options.fetchImpl ?? fetch;
  }
  async range(): Promise<ArchiveRange> {
    const response = await this.#get('.well-known/stellar-history.json');
    const body = JSON.parse(await response.text()) as Record<string, unknown>;
    const latest = Number(body.currentLedger ?? body.latestLedger ?? body.checkpointLedger ?? 0);
    return { source: 'archive', fromLedger: 1, toLedger: Number.isFinite(latest) ? latest : 0 };
  }
  async getEvents(args: { startLedger: number; endLedger?: number; filters?: EventFilter[]; limit?: number }): Promise<EventBatch> {
    const end = args.endLedger ?? args.startLedger + this.checkpointSize - 1;
    const events: RawEvent[] = [];
    for (let ledger = checkpointEnd(args.startLedger, this.checkpointSize); ledger <= end; ledger += this.checkpointSize) {
      const payload = await this.readCheckpoint(ledger);
      for (const event of payload) {
        if (event.ledger < args.startLedger || event.ledger > end) continue;
        if (!matches(event, args.filters ?? [])) continue;
        events.push(event);
        if (events.length >= (args.limit ?? 200)) break;
      }
      if (events.length >= (args.limit ?? 200)) break;
    }
    events.sort((a, b) => a.id.localeCompare(b.id));
    const lastLedger = events.at(-1)?.ledger ?? Math.min(end, args.startLedger);
    return { events, cursor: `archive:${lastLedger}`, latestLedger: end, oldestLedger: args.startLedger };
  }
  async readCheckpoint(checkpointLedger: number): Promise<RawEvent[]> {
    const hex = checkpointLedger.toString(16).padStart(8, '0');
    const path = `events/${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex.slice(4, 6)}/events-${hex}.json`;
    const response = await this.#get(path);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const text = path.endsWith('.gz') ? gunzipSync(bytes).toString('utf8') : new TextDecoder().decode(bytes);
    const parsed = JSON.parse(text) as { events?: RawEvent[] } | RawEvent[];
    return Array.isArray(parsed) ? parsed : parsed.events ?? [];
  }
  async #get(path: string): Promise<Response> {
    if (this.archiveUrl.startsWith('file://')) {
      const data = await readFile(new URL(`${this.archiveUrl}/${path}`));
      return new Response(data, { status: 200 });
    }
    const response = await this.#fetch(`${this.archiveUrl}/${path}`);
    if (!response.ok) throw new Error(`archive request failed (${response.status}): ${path}`);
    return response;
  }
}
function checkpointEnd(ledger: number, size: number): number { return Math.floor(ledger / size) * size + size - 1; }
function matches(event: RawEvent, filters: EventFilter[]): boolean {
  if (filters.length === 0) return true;
  return filters.some((f) => (!f.type || f.type === event.type) && (!f.contractIds?.length || f.contractIds.includes(event.contractId)) && (!f.topics?.length || f.topics.some((topic) => topic.every((x, i) => x === '*' || x === '**' || x === event.topic[i]))));
}
