/**
 * Replays a recording produced by `RpcRecorder` (#143).
 *
 * FIFO per method, not args-matched: replaying the same call sequence yields
 * the same responses, which is exactly what the recorder guaranteed. Matching
 * on args would break the first time the poller legitimately varied them
 * (fallbackLedger, page-size drift) and would not make replay any more honest —
 * a real node does not answer "the same request the same way" in any test that
 * matters, it answers the next call in sequence.
 *
 * The replayed client satisfies `RpcReadClient`, which is what `EventPoller`
 * is typed against, so it drops into a test without a cast.
 */
import { readFile } from 'node:fs/promises';
import type { rpc } from '@stellar/stellar-sdk';
import type { ClockSkew } from './clock-skew.js';
import type { GetEventsArgs, RpcReadClient } from './rpc-client.js';
import type { RecordingFixture, RecordedExchange } from './recorder.js';
import type { EventBatch, RetentionState } from './types.js';

export class RecordedRpcClient implements RpcReadClient {
  readonly rpcUrl: string;
  readonly #queues = new Map<RecordedExchange['method'], RecordedExchange[]>();
  readonly #calls = new Map<RecordedExchange['method'], number>();

  constructor(fixture: RecordingFixture) {
    if (fixture.version !== 1) {
      throw new Error(
        `RecordedRpcClient only understands recording version 1, got ${fixture.version}`,
      );
    }
    if (!Array.isArray(fixture.exchanges)) {
      throw new Error('recording has no `exchanges` array');
    }
    this.rpcUrl = fixture.meta?.rpcUrl ?? 'recorded://';
    for (const ex of fixture.exchanges) {
      let queue = this.#queues.get(ex.method);
      if (!queue) {
        queue = [];
        this.#queues.set(ex.method, queue);
      }
      queue.push(ex);
    }
  }

  static async load(path: string): Promise<RecordedRpcClient> {
    const raw = await readFile(path, 'utf8');
    return new RecordedRpcClient(JSON.parse(raw) as RecordingFixture);
  }

  get health(): () => Promise<rpc.Api.GetHealthResponse> { return () => this.#replay('health'); }
  get getNetwork(): () => Promise<rpc.Api.GetNetworkResponse> { return () => this.#replay('getNetwork'); }
  get retention(): () => Promise<RetentionState> { return () => this.#replay('retention'); }
  get latestLedger(): () => Promise<number> { return () => this.#replay('latestLedger'); }
  get clockSkew(): (options?: Parameters<RpcReadClient['getEvents']> extends never ? never : object) => Promise<ClockSkew> {
    return (_options?: object) => this.#replay('clockSkew');
  }
  get getEvents(): (args: GetEventsArgs) => Promise<EventBatch> { return (_args: GetEventsArgs) => this.#replay('getEvents'); }

  async #replay<T>(method: RecordedExchange['method']): Promise<T> {
    const callCount = (this.#calls.get(method) ?? 0) + 1;
    this.#calls.set(method, callCount);
    const queue = this.#queues.get(method);
    if (!queue || queue.length === 0) {
      const available = [...this.#queues.entries()]
        .filter(([, q]) => q.length > 0)
        .map(([m, q]) => `${m} (${q.length})`)
        .join(', ') || 'none';
      throw new Error(
        `no recorded ${method} exchange for call #${callCount}; ` +
          `remaining exchanges: ${available}. ` +
          `The fixture probably needs to be refreshed against a live node.`,
      );
    }
    const exchange = queue.shift()!;
    if (exchange.error) {
      const err = Object.assign(new Error(exchange.error.message), {
        name: exchange.error.name,
      });
      if (exchange.error.code !== undefined) (err as { code?: number }).code = exchange.error.code;
      throw err;
    }
    return exchange.response as T;
  }
}
