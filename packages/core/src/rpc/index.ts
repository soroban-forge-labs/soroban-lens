import { SorobanRpc } from "@stellar/stellar-sdk";

export interface RpcEndpointConfig {
  url: string;
  label?: string;
}

export interface FailoverRpcClientOptions {
  endpoints: RpcEndpointConfig[];
  /** How often (ms) to probe the primary while failed over. */
  probeIntervalMs?: number;
  /** Max ledger lag (relative to the best-known ledger) an endpoint may have to be considered healthy. */
  ledgerTolerance?: number;
  /** How long (ms) a recorded latency sample is considered recent. */
  latencyWindowMs?: number;
}

interface EndpointHealth {
  latestLedger: number | null;
  latencyMs: number | null;
  latencyAt: number | null;
}

const DEFAULT_PROBE_INTERVAL_MS = 30_000;
const DEFAULT_LEDGER_TOLERANCE = 5;
const DEFAULT_LATENCY_WINDOW_MS = 60_000;

/**
 * RPC client that fails over across endpoints, preferring the healthiest
 * (non-lagging, lowest-latency) endpoint and falling back to round-robin
 * ordering as a tie-break.
 */
export class FailoverRpcClient {
  private readonly endpoints: RpcEndpointConfig[];
  private readonly servers: SorobanRpc.Server[];
  private readonly health: EndpointHealth[];
  private readonly probeIntervalMs: number;
  private readonly ledgerTolerance: number;
  private readonly latencyWindowMs: number;
  private active = 0;
  private lastProbeAt = 0;

  constructor(options: FailoverRpcClientOptions) {
    if (!options.endpoints.length) {
      throw new Error("FailoverRpcClient requires at least one endpoint");
    }
    this.endpoints = options.endpoints;
    this.servers = options.endpoints.map(
      (e) => new SorobanRpc.Server(e.url, { allowHttp: e.url.startsWith("http://") }),
    );
    this.health = options.endpoints.map(() => ({
      latestLedger: null,
      latencyMs: null,
      latencyAt: null,
    }));
    this.probeIntervalMs = options.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
    this.ledgerTolerance = options.ledgerTolerance ?? DEFAULT_LEDGER_TOLERANCE;
    this.latencyWindowMs = options.latencyWindowMs ?? DEFAULT_LATENCY_WINDOW_MS;
  }

  get activeEndpoint(): RpcEndpointConfig {
    return this.endpoints[this.active];
  }

  /** Cheap health probe: records latest ledger and latency for one endpoint. */
  private async probe(index: number): Promise<void> {
    const started = Date.now();
    try {
      const res = await this.servers[index].getLatestLedger();
      const elapsed = Date.now() - started;
      const entry = this.health[index];
      entry.latestLedger = res.sequence;
      entry.latencyMs = elapsed;
      entry.latencyAt = Date.now();
    } catch {
      // Leave prior health untouched on probe failure; the endpoint simply
      // won't be preferred until a later probe succeeds.
    }
  }

  private async probeAll(): Promise<void> {
    await Promise.all(this.endpoints.map((_, i) => this.probe(i)));
    this.lastProbeAt = Date.now();
  }

  private isLagging(index: number, bestLedger: number | null): boolean {
    const ledger = this.health[index].latestLedger;
    if (ledger === null || bestLedger === null) return false;
    return bestLedger - ledger > this.ledgerTolerance;
  }

  private recentLatency(index: number): number | null {
    const entry = this.health[index];
    if (entry.latencyMs === null || entry.latencyAt === null) return null;
    if (Date.now() - entry.latencyAt > this.latencyWindowMs) return null;
    return entry.latencyMs;
  }

  /**
   * Pick the healthiest endpoint: not lagging, with the best recent latency.
   * Ties (and unknown health) fall back to today's `(active + 1) % n` ordering.
   */
  private pickHealthiest(): number {
    const n = this.endpoints.length;
    if (n === 1) return 0;

    const bestLedger = this.health.reduce<number | null>((acc, h) => {
      if (h.latestLedger === null) return acc;
      return acc === null ? h.latestLedger : Math.max(acc, h.latestLedger);
    }, null);

    let bestIndex = -1;
    let bestLatency = Infinity;
    for (let offset = 1; offset <= n; offset++) {
      const index = (this.active + offset) % n;
      if (this.isLagging(index, bestLedger)) continue;
      const latency = this.recentLatency(index);
      if (latency === null) continue;
      if (latency < bestLatency) {
        bestLatency = latency;
        bestIndex = index;
      }
    }

    if (bestIndex !== -1) return bestIndex;
    // No endpoint has usable health data: keep today's ordering.
    return (this.active + 1) % n;
  }

  private async failover(): Promise<void> {
    await this.probeAll();
    this.active = this.pickHealthiest();
  }

  private async maybeProbePrimary(): Promise<void> {
    if (this.active === 0) return;
    if (Date.now() - this.lastProbeAt < this.probeIntervalMs) return;
    await this.probeAll();
    const next = this.pickHealthiest();
    if (next === 0) this.active = 0;
  }

  /** Run an operation against the active endpoint, failing over on error. */
  async execute<T>(fn: (server: SorobanRpc.Server) => Promise<T>): Promise<T> {
    await this.maybeProbePrimary();
    const attempts = this.endpoints.length;
    let lastError: unknown;
    for (let i = 0; i < attempts; i++) {
      const started = Date.now();
      try {
        const result = await fn(this.servers[this.active]);
        const entry = this.health[this.active];
        entry.latencyMs = Date.now() - started;
        entry.latencyAt = Date.now();
        return result;
      } catch (err) {
        lastError = err;
        await this.failover();
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("All RPC endpoints failed");
  }
}
