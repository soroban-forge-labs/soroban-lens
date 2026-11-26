import type { RpcClient, RpcHealth } from './types';

export interface FailoverOptions {
  /** Max ledger lag (in ledgers) an endpoint may have and still be considered healthy. */
  ledgerTolerance?: number;
  /** Number of recent latency samples to keep per endpoint. */
  latencyWindow?: number;
}

interface EndpointState {
  latestLedger: number | null;
  latencies: number[];
}

const DEFAULT_LEDGER_TOLERANCE = 5;
const DEFAULT_LATENCY_WINDOW = 5;

/**
 * FailoverRpcClient wraps a set of RPC clients and, on error, fails over to the
 * healthiest endpoint rather than simply the next one in order.
 *
 * Health is determined by:
 *  - ledger lag: endpoints more than `ledgerTolerance` ledgers behind the best
 *    observed ledger are considered lagging and skipped.
 *  - latency: among non-lagging endpoints, the one with the best recent average
 *    latency wins.
 *  - ordering: ties are broken by today's `(active + 1) % n` ordering.
 */
export class FailoverRpcClient implements RpcClient {
  private readonly clients: RpcClient[];
  private readonly states: EndpointState[];
  private readonly ledgerTolerance: number;
  private readonly latencyWindow: number;
  private active = 0;

  constructor(clients: RpcClient[], options: FailoverOptions = {}) {
    if (clients.length === 0) {
      throw new Error('FailoverRpcClient requires at least one client');
    }
    this.clients = clients;
    this.ledgerTolerance = options.ledgerTolerance ?? DEFAULT_LEDGER_TOLERANCE;
    this.latencyWindow = options.latencyWindow ?? DEFAULT_LATENCY_WINDOW;
    this.states = clients.map(() => ({ latestLedger: null, latencies: [] }));
  }

  get activeIndex(): number {
    return this.active;
  }

  async getLatestLedger(): Promise<number> {
    return this.call((client) => client.getLatestLedger());
  }

  async getHealth(): Promise<RpcHealth> {
    return this.call((client) => client.getHealth());
  }

  private async call<T>(fn: (client: RpcClient) => Promise<T>): Promise<T> {
    const startIndex = this.active;
    let lastError: unknown;
    for (let attempt = 0; attempt < this.clients.length; attempt++) {
      const index = attempt === 0 ? startIndex : this.pickNext(startIndex);
      const client = this.clients[index];
      const startedAt = Date.now();
      try {
        const result = await fn(client);
        this.recordLatency(index, Date.now() - startedAt);
        this.active = index;
        return result;
      } catch (err) {
        lastError = err;
        this.recordLatency(index, Date.now() - startedAt);
        if (this.clients.length === 1) {
          throw err;
        }
      }
    }
    throw lastError;
  }

  /**
   * Probe each endpoint cheaply to refresh ledger/latency state, then choose the
   * healthiest endpoint. Falls back to `(active + 1) % n` ordering on ties.
   */
  private pickNext(fromIndex: number): number {
    const n = this.clients.length;
    const order: number[] = [];
    for (let i = 1; i <= n; i++) {
      order.push((fromIndex + i) % n);
    }

    const bestLedger = this.bestKnownLedger();
    const candidates = order.filter((index) => {
      const ledger = this.states[index].latestLedger;
      if (ledger === null || bestLedger === null) {
        return true;
      }
      return bestLedger - ledger <= this.ledgerTolerance;
    });

    const pool = candidates.length > 0 ? candidates : order;

    let best = pool[0];
    let bestLatency = this.averageLatency(best);
    for (let i = 1; i < pool.length; i++) {
      const index = pool[i];
      const latency = this.averageLatency(index);
      if (latency < bestLatency) {
        best = index;
        bestLatency = latency;
      }
    }
    return best;
  }

  private bestKnownLedger(): number | null {
    let best: number | null = null;
    for (const state of this.states) {
      if (state.latestLedger !== null && (best === null || state.latestLedger > best)) {
        best = state.latestLedger;
      }
    }
    return best;
  }

  private averageLatency(index: number): number {
    const latencies = this.states[index].latencies;
    if (latencies.length === 0) {
      return Number.POSITIVE_INFINITY;
    }
    let sum = 0;
    for (const value of latencies) {
      sum += value;
    }
    return sum / latencies.length;
  }

  private recordLatency(index: number, latency: number): void {
    const latencies = this.states[index].latencies;
    latencies.push(latency);
    if (latencies.length > this.latencyWindow) {
      latencies.shift();
    }
  }

  /**
   * Refresh ledger/latency state for all endpoints using cheap probes. Intended
   * to be called before failover decisions when callers want fresh data.
   */
  async refreshHealth(): Promise<void> {
    await Promise.all(
      this.clients.map(async (client, index) => {
        const startedAt = Date.now();
        try {
          const ledger = await client.getLatestLedger();
          this.states[index].latestLedger = ledger;
        } catch {
          // Ignore probe failures; stale state is better than none.
        } finally {
          this.recordLatency(index, Date.now() - startedAt);
        }
      }),
    );
  }
}
