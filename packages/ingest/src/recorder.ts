/**
 * Records RPC traffic for tests (#143).
 *
 * The recorder wraps a real `LensRpcClient` and captures the request/response
 * pair for each method the poller uses, so a test can replay exactly what a
 * real node said — real cursor formats, real error bodies, real close-time
 * strings — without any network. This is the cheap complement to the
 * quickstart integration test (#20): the integration test proves a live node
 * works; a recording proves a specific real interaction is reproduced forever.
 *
 * What is recorded is what the *client* returned, not the raw JSON-RPC body:
 * `getEvents` is captured as a normalised `EventBatch`, not as raw `RawEvent`s
 * with topics and values in wire form. That keeps the fixture readable and
 * means a future change to how `LensRpcClient` normalises a response is
 * caught by the replay test.
 *
 * Errors are recorded by shape: `{ name, message, code? }`. Replay throws an
 * `Error` with those restored, so a test can assert on the same contract.
 */
import { writeFile } from 'node:fs/promises';
import type { rpc } from '@stellar/stellar-sdk';
import type { ClockSkew } from './clock-skew.js';
import type { GetEventsArgs, LensRpcClient } from './rpc-client.js';
import type { EventBatch, RetentionState } from './types.js';

/** One recorded call. Exactly one of `response` or `error` is set. */
export interface RecordedExchange {
  method: 'health' | 'getNetwork' | 'retention' | 'getEvents' | 'latestLedger' | 'clockSkew';
  /** The argument the method was called with, or `null` when it takes none. */
  args: unknown;
  response?: unknown;
  error?: { name: string; message: string; code?: number };
}

/** The on-disk recording. Shape is stable; bump `version` for breaking changes. */
export interface RecordingFixture {
  version: 1;
  recordedAt: string;
  meta: { network?: string; rpcUrl: string };
  exchanges: RecordedExchange[];
}

export interface RecorderOptions {
  /** Free-form metadata stored on the fixture. `rpcUrl` defaults to the client's. */
  meta?: { network?: string; rpcUrl?: string };
}

/**
 * Wrap a `LensRpcClient` and capture every call. Wraps the client directly,
 * not `FailoverRpcClient`: a failover switch mid-stream would otherwise record
 * "which provider answered" as if it were a property of the call, which it is
 * not, and a fixture with two providers in it is not what "reproduce this
 * interaction" means.
 */
export class RpcRecorder {
  readonly #inner: LensRpcClient;
  readonly #meta: { network?: string; rpcUrl: string };
  readonly #exchanges: RecordedExchange[] = [];

  constructor(client: LensRpcClient, options: RecorderOptions = {}) {
    this.#inner = client;
    this.#meta = {
      rpcUrl: options.meta?.rpcUrl ?? client.rpcUrl,
      ...(options.meta?.network !== undefined ? { network: options.meta.network } : {}),
    };
  }

  get rpcUrl(): string {
    return this.#inner.rpcUrl;
  }

  get exchangeCount(): number {
    return this.#exchanges.length;
  }

  async health(): Promise<rpc.Api.GetHealthResponse> {
    return this.#capture('health', null, () => this.#inner.health());
  }

  async getNetwork(): Promise<rpc.Api.GetNetworkResponse> {
    return this.#capture('getNetwork', null, () => this.#inner.getNetwork());
  }

  async retention(): Promise<RetentionState> {
    return this.#capture('retention', null, () => this.#inner.retention());
  }

  async latestLedger(): Promise<number> {
    return this.#capture('latestLedger', null, () => this.#inner.latestLedger());
  }

  async clockSkew(options: Parameters<LensRpcClient['clockSkew']>[0] = {}): Promise<ClockSkew> {
    return this.#capture('clockSkew', options ?? null, () => this.#inner.clockSkew(options));
  }

  async getEvents(args: GetEventsArgs): Promise<EventBatch> {
    return this.#capture('getEvents', args, () => this.#inner.getEvents(args));
  }

  async #capture<T>(
    method: RecordedExchange['method'],
    args: unknown,
    call: () => Promise<T>,
  ): Promise<T> {
    try {
      const response = await call();
      this.#exchanges.push({ method, args, response });
      return response;
    } catch (error) {
      const e = error as { name?: string; message?: string; code?: unknown };
      this.#exchanges.push({
        method,
        args,
        error: {
          name: e?.name ?? 'Error',
          message: e?.message ?? String(error),
          ...(typeof e?.code === 'number' ? { code: e.code } : {}),
        },
      });
      throw error;
    }
  }

  toFixture(): RecordingFixture {
    return {
      version: 1,
      recordedAt: new Date().toISOString(),
      meta: this.#meta,
      exchanges: this.#exchanges,
    };
  }

  async save(path: string): Promise<void> {
    await writeFile(path, `${JSON.stringify(this.toFixture(), null, 2)}\n`, 'utf8');
  }
}
