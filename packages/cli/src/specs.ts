import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { rpc } from '@stellar/stellar-sdk';
import {
  ContractTypedDecoder,
  STELLAR_ASSET_SPEC_ENTRIES,
  specEntriesFromWasm,
} from '@soroban-lens/store';
import type { ContractSpecRecord, EventStore } from '@soroban-lens/store';

/**
 * Fetching contract specs for typed decoding (#33).
 *
 * This lives in the CLI rather than in ingest or store for the same reason
 * runIndexer does: it is the one place that already talks to both the RPC and
 * the database, so neither module has to take a dependency on the other.
 */

/** The three RPC calls a lookup needs — an interface so tests need no network. */
export interface SpecSource {
  getContractInstance(contractId: string): Promise<{ executable: { type: string } }>;
  getContractWasmByContractId(contractId: string): Promise<Uint8Array>;
}

export function rpcSpecSource(rpcUrl: string, headers: Record<string, string> = {}): SpecSource {
  return new rpc.Server(rpcUrl, {
    allowHttp: rpcUrl.startsWith('http://'),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  }) as unknown as SpecSource;
}

/**
 * A lookup that found nothing — as opposed to one that failed. Not-found is a
 * fact about the contract and is worth remembering; a timeout is a fact about
 * the network and must not be stored as "this contract has no spec".
 */
function isNotFound(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | undefined;
  return e?.code === 404 || /not found|could not obtain/i.test(String(e?.message ?? ''));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  const e = error as { message?: unknown } | undefined;
  return typeof e?.message === 'string' ? e.message : String(error);
}

/**
 * Look a contract's spec up on-chain.
 *
 * Resolves to a record for every *definite* outcome, including "no spec" —
 * a contract that does not exist, or Wasm built without a spec section.
 * Rejects only on a transient failure (network, rate limit), so the caller
 * retries later rather than recording a wrong negative.
 */
export async function lookupContractSpec(
  source: SpecSource,
  contractId: string,
  now: () => Date = () => new Date(),
): Promise<ContractSpecRecord> {
  const none = (error: string): ContractSpecRecord => ({
    contractId,
    source: 'none',
    entriesXdr: [],
    eventCount: 0,
    error,
    fetchedAt: now().toISOString(),
  });

  let executable: string;
  try {
    executable = (await source.getContractInstance(contractId)).executable.type;
  } catch (error) {
    if (isNotFound(error)) return none(`contract instance not found: ${errorMessage(error)}`);
    throw error;
  }

  if (executable === 'contractExecutableStellarAsset') {
    return {
      contractId,
      source: 'stellar-asset',
      entriesXdr: [],
      eventCount: STELLAR_ASSET_SPEC_ENTRIES.length,
      fetchedAt: now().toISOString(),
    };
  }

  let wasm: Uint8Array;
  try {
    // Resolves CAP-85 external references to their Wasm, too.
    wasm = await source.getContractWasmByContractId(contractId);
  } catch (error) {
    if (isNotFound(error)) return none(`contract Wasm not found: ${errorMessage(error)}`);
    throw error;
  }
  return recordFromWasm(contractId, wasm, now);
}

/**
 * Build a spec record from Wasm bytes — fetched from the network, or a local
 * build passed to `lens spec import` for a contract that is not deployed where
 * the indexer can see it.
 */
export function recordFromWasm(
  contractId: string,
  wasm: Uint8Array,
  now: () => Date = () => new Date(),
): ContractSpecRecord {
  const wasmHash = createHash('sha256').update(wasm).digest('hex');
  let entriesXdr: string[];
  try {
    entriesXdr = specEntriesFromWasm(wasm);
  } catch (error) {
    return {
      contractId,
      source: 'none',
      wasmHash,
      entriesXdr: [],
      eventCount: 0,
      error: `no readable contract spec in Wasm: ${errorMessage(error)}`,
      fetchedAt: now().toISOString(),
    };
  }
  const decoder = ContractTypedDecoder.fromRecord({
    contractId,
    source: 'wasm',
    entriesXdr,
    eventCount: 0,
    fetchedAt: '',
  });
  return {
    contractId,
    source: 'wasm',
    wasmHash,
    entriesXdr,
    eventCount: decoder?.eventCount ?? 0,
    fetchedAt: now().toISOString(),
  };
}

export async function recordFromWasmFile(contractId: string, path: string): Promise<ContractSpecRecord> {
  return recordFromWasm(contractId, new Uint8Array(await readFile(path)));
}

/** One line a human can read: what was found, and what it means for decoding. */
export function describeSpecRecord(record: Omit<ContractSpecRecord, 'entriesXdr'>): string {
  switch (record.source) {
    case 'stellar-asset':
      return `${record.contractId}: Stellar Asset Contract — built-in spec (transfer, mint, burn, …)`;
    case 'wasm':
      return record.eventCount > 0
        ? `${record.contractId}: Wasm ${record.wasmHash?.slice(0, 12) ?? '?'}… declares ${record.eventCount} event(s) — typed decoding on`
        : `${record.contractId}: Wasm ${record.wasmHash?.slice(0, 12) ?? '?'}… has a spec but declares no events (built before soroban-sdk 23?) — generic decoding only`;
    case 'none':
      return `${record.contractId}: no spec — ${record.error ?? 'unknown reason'}`;
  }
}

/**
 * Background spec fetching for the indexer.
 *
 * Every contract the indexer sees gets looked up at most once per process,
 * and not at all when the store already has a definite answer. Negative
 * answers are re-checked after `retryNoneAfterMs`, because "no instance" can
 * become "deployed" and an upgraded contract can gain a spec.
 *
 * Lookups run one at a time off the batch loop: an indexer watching every
 * contract can see hundreds of new ids in its first minutes, and neither
 * ingestion latency nor the RPC's rate limit should pay for typed decoding,
 * which is a convenience layered on top.
 */
export class SpecFetcher {
  readonly #store: EventStore;
  readonly #source: SpecSource;
  readonly #log: (message: string) => void;
  readonly #retryNoneAfterMs: number;
  readonly #attempted = new Set<string>();
  #queue: Promise<void> = Promise.resolve();
  #stopped = false;

  constructor(
    store: EventStore,
    source: SpecSource,
    options: { log?: (message: string) => void; retryNoneAfterMs?: number } = {},
  ) {
    this.#store = store;
    this.#source = source;
    this.#log = options.log ?? (() => {});
    this.#retryNoneAfterMs = options.retryNoneAfterMs ?? 6 * 60 * 60 * 1000;
  }

  /** Queue lookups for any of these contracts not yet handled. Returns immediately. */
  enqueue(contractIds: Iterable<string>): void {
    for (const id of contractIds) {
      if (this.#attempted.has(id)) continue;
      this.#attempted.add(id);
      this.#queue = this.#queue.then(() => this.#fetchOne(id));
    }
  }

  /** Resolves once every queued lookup has finished. */
  idle(): Promise<void> {
    return this.#queue;
  }

  /** Drop lookups not yet started; the one in flight finishes. */
  stop(): void {
    this.#stopped = true;
  }

  async #fetchOne(contractId: string): Promise<void> {
    if (this.#stopped) return;
    try {
      const existing = await this.#store.getContractSpec(contractId);
      if (existing && existing.source !== 'none') return;
      if (existing && Date.now() - Date.parse(existing.fetchedAt) < this.#retryNoneAfterMs) return;

      const record = await lookupContractSpec(this.#source, contractId);
      await this.#store.saveContractSpec(record);
      this.#log(`spec ${describeSpecRecord(record)}`);
    } catch (error) {
      // Transient: forget the attempt so a later batch mentioning this
      // contract tries again, rather than waiting for a restart.
      this.#attempted.delete(contractId);
      this.#log(`spec lookup for ${contractId} failed, will retry: ${errorMessage(error)}`);
    }
  }
}
