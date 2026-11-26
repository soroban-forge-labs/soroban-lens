import type { EventBatch, RetentionState } from './types.js';
import { LensRpcClient, type GetEventsArgs, type RpcClientOptions } from './rpc-client.js';

export interface RpcPoolOptions extends Omit<RpcClientOptions, 'rpcUrl'> {
  rpcUrls: string[];
  failureThreshold?: number;
  recoveryCheckMs?: number;
}

/** Minimal metrics sink so the pool can report failover state without a hard dep. */
export interface RpcPoolMetrics {
  setActiveProvider(index: number, label: string): void;
  incFailover(from: string, to: string): void;
  incProviderError(label: string): void;
}

/** Redact credentials and API keys from an RPC URL, keeping only scheme/host/path. */
export function redactRpcUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.search = '';
    return url.toString();
  } catch {
    return raw.replace(/\/\/[^@/]*@/, '//').replace(/\?.*$/, '');
  }
}

/** Ordered provider pool. A provider switch deliberately overlaps by ledger. */
export class FailoverRpcClient {
  readonly rpcUrl: string;
  readonly #clients: LensRpcClient[];
  readonly #urls: string[];
  readonly #labels: string[];
  readonly #threshold: number;
  readonly #recoveryMs: number;
  readonly #metrics?: RpcPoolMetrics;
  #active = 0;
  #errors = 0;
  #lastRecoveryCheck = 0;
  constructor(options: RpcPoolOptions & { metrics?: RpcPoolMetrics }) {
    if (options.rpcUrls.length === 0) throw new Error('at least one RPC URL is required');
    this.#urls = [...new Set(options.rpcUrls)];
    this.#labels = this.#urls.map(redactRpcUrl);
    this.#clients = this.#urls.map((rpcUrl) => new LensRpcClient({ ...options, rpcUrl }));
    this.#threshold = Math.max(1, options.failureThreshold ?? 3);
    this.#recoveryMs = Math.max(0, options.recoveryCheckMs ?? 10_000);
    this.#metrics = options.metrics;
    this.rpcUrl = this.#urls.join(',');
    this.#metrics?.setActiveProvider(this.#active, this.#labels[this.#active]!);
  }
  get providerUrl(): string { return this.#urls[this.#active]!; }
  get providerIndex(): number { return this.#active; }
  /** Redacted label for the active provider, safe to persist and expose in /status. */
  get providerLabel(): string { return this.#labels[this.#active]!; }
  async health(): Promise<Awaited<ReturnType<LensRpcClient['health']>>> {
    return this.#request((client) => client.health());
  }
  async getNetwork(): Promise<Awaited<ReturnType<LensRpcClient['getNetwork']>>> {
    return this.#request((client) => client.getNetwork());
  }
  async retention(): Promise<RetentionState> { return this.#request((client) => client.retention()); }
  async latestLedger(): Promise<number> { return this.#request((client) => client.latestLedger()); }
  async clockSkew(options: Parameters<LensRpcClient['clockSkew']>[0] = {}): ReturnType<LensRpcClient['clockSkew']> { return this.#request((client) => client.clockSkew(options)); }
  async getEvents(args: GetEventsArgs & { fallbackLedger?: number }): Promise<EventBatch> {
    await this.#tryRecoverPrimary();
    const active = this.#clients[this.#active]!;
    try {
      const result = await active.getEvents(args);
      this.#errors = 0;
      return result;
    } catch (firstError) {
      this.#errors++;
      this.#metrics?.incProviderError(String(this.#active));
      if (this.#errors < this.#threshold || this.#clients.length === 1) throw firstError;
      const old = this.providerUrl;
      this.#active = (this.#active + 1) % this.#clients.length;
      this.#errors = 0;
      this.#metrics?.incFailover(this.#labels[(this.#active - 1 + this.#clients.length) % this.#clients.length]!, this.#labels[this.#active]!);
      this.#metrics?.setActiveProvider(this.#active, this.#labels[this.#active]!);
      const next = this.#clients[this.#active]!;
      // Cursors are opaque and may be node-local. First try the cursor on the
      // replacement, then retry from the last committed ledger with overlap.
      if (args.cursor) {
        try { return await next.getEvents(args); } catch { /* fall through */ }
        if (args.fallbackLedger !== undefined) {
          return next.getEvents({ ...args, cursor: undefined, startLedger: args.fallbackLedger });
        }
      }
      this.#lastRecoveryCheck = Date.now();
      throw new Error(`RPC provider ${redactRpcUrl(old)} failed over to ${this.providerLabel}; retrying: ${message(firstError)}`);
    }
  }
  async #request<T>(call: (client: LensRpcClient) => Promise<T>): Promise<T> {
    await this.#tryRecoverPrimary();
    try { const value = await call(this.#clients[this.#active]!); this.#errors = 0; return value; }
    catch (error) {
      this.#errors++;
      this.#metrics?.incProviderError(String(this.#active));
      if (this.#errors >= this.#threshold && this.#clients.length > 1) {
        const from = this.#active;
        this.#active = (this.#active + 1) % this.#clients.length;
        this.#metrics?.incFailover(this.#labels[from]!, this.#labels[this.#active]!);
        this.#metrics?.setActiveProvider(this.#active, this.#labels[this.#active]!);
      }
      throw error;
    }
  }
  async #tryRecoverPrimary(): Promise<void> {
    if (this.#active === 0 || Date.now() - this.#lastRecoveryCheck < this.#recoveryMs) return;
    this.#lastRecoveryCheck = Date.now();
    try {
      await this.#clients[0]!.health();
      const from = this.#active;
      this.#active = 0;
      this.#errors = 0;
      this.#metrics?.incFailover(this.#labels[from]!, this.#labels[0]!);
      this.#metrics?.setActiveProvider(0, this.#labels[0]!);
    } catch { /* primary remains unavailable */ }
  }
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
