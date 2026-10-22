import type { EventBatch, RetentionState } from './types.js';
import { LensRpcClient, type GetEventsArgs, type RpcClientOptions } from './rpc-client.js';

export interface RpcPoolOptions extends Omit<RpcClientOptions, 'rpcUrl'> {
  rpcUrls: string[];
  failureThreshold?: number;
  recoveryCheckMs?: number;
}

/** Ordered provider pool. A provider switch deliberately overlaps by ledger. */
export class FailoverRpcClient {
  readonly rpcUrl: string;
  readonly #clients: LensRpcClient[];
  readonly #urls: string[];
  readonly #threshold: number;
  readonly #recoveryMs: number;
  #active = 0;
  #errors = 0;
  #lastRecoveryCheck = 0;
  constructor(options: RpcPoolOptions) {
    if (options.rpcUrls.length === 0) throw new Error('at least one RPC URL is required');
    this.#urls = [...new Set(options.rpcUrls)];
    this.#clients = this.#urls.map((rpcUrl) => new LensRpcClient({ ...options, rpcUrl }));
    this.#threshold = Math.max(1, options.failureThreshold ?? 3);
    this.#recoveryMs = Math.max(0, options.recoveryCheckMs ?? 10_000);
    this.rpcUrl = this.#urls.join(',');
  }
  get providerUrl(): string { return this.#urls[this.#active]!; }
  get providerIndex(): number { return this.#active; }
  async health(): Promise<Awaited<ReturnType<LensRpcClient['health']>>> {
    return this.#request((client) => client.health());
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
      if (this.#errors < this.#threshold || this.#clients.length === 1) throw firstError;
      const old = this.providerUrl;
      this.#active = (this.#active + 1) % this.#clients.length;
      this.#errors = 0;
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
      throw new Error(`RPC provider ${old} failed over to ${this.providerUrl}; retrying: ${message(firstError)}`);
    }
  }
  async #request<T>(call: (client: LensRpcClient) => Promise<T>): Promise<T> {
    await this.#tryRecoverPrimary();
    try { const value = await call(this.#clients[this.#active]!); this.#errors = 0; return value; }
    catch (error) { this.#errors++; if (this.#errors >= this.#threshold && this.#clients.length > 1) this.#active = (this.#active + 1) % this.#clients.length; throw error; }
  }
  async #tryRecoverPrimary(): Promise<void> {
    if (this.#active === 0 || Date.now() - this.#lastRecoveryCheck < this.#recoveryMs) return;
    this.#lastRecoveryCheck = Date.now();
    try { await this.#clients[0]!.health(); this.#active = 0; this.#errors = 0; } catch { /* primary remains unavailable */ }
  }
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
