import { contract, xdr } from '@stellar/stellar-sdk';
import { toJsonSafe } from './decode.js';
import type { ContractSpecRecord, LensEvent, TypedEvent, TypedField } from './types.js';

/**
 * Spec-aware decoding (#33).
 *
 * The generic decoder turns an event into ScVal shapes: a `map`, a `vec`, an
 * `i128`. A contract built with soroban-sdk 23+ also publishes SEP-48 event
 * specs in its Wasm — the event's name, which topics carry which named
 * parameter, and the declared type of each. With that, the same bytes read as
 * `transfer { from: Address, to: Address, amount: i128 }`.
 *
 * This is an additional view, never a replacement: `LensEvent.topics` and
 * `.value` are untouched, and an event whose contract has no spec — or whose
 * shape matches none of the spec's events — simply has no typed view.
 *
 * Matching itself is the SDK's (`Spec.parseEvent`); what this adds is the
 * declared type of each field, which parseEvent does not return, and a
 * JSON-safe value for each.
 */

/**
 * Stellar Asset Contracts have no Wasm, so there is no spec to fetch — but
 * their events are fixed by CAP-46-6 and CAP-67, and they are the most common
 * events on the network (the default contract this project ships pointed at
 * is the native XLM SAC). So the spec is written out here.
 *
 * Order matters: parseEvent takes the first spec whose prefix matches and
 * whose values decode. The pre-protocol-23 `mint`/`clawback` carried an extra
 * `admin` topic, and a spec matches on a *minimum* topic count, so the
 * four-topic legacy shapes are declared before the current three-topic ones —
 * otherwise a legacy event would match the new spec and label its admin as the
 * recipient. Likewise `transfer` and `mint` with a muxed recipient carry a map
 * `{ amount, to_muxed_id }` instead of a bare i128; the single-value form is
 * tried first and fails to decode a map, so the map form catches those.
 */
export const STELLAR_ASSET_SPEC_ENTRIES: readonly xdr.ScSpecEntry[] = buildStellarAssetSpec();

function buildStellarAssetSpec(): xdr.ScSpecEntry[] {
  const T = xdr.ScSpecTypeDef;
  const address = (): xdr.ScSpecTypeDef => T.scSpecTypeAddress();
  const string = (): xdr.ScSpecTypeDef => T.scSpecTypeString();
  const i128 = (): xdr.ScSpecTypeDef => T.scSpecTypeI128();

  type Param = [name: string, type: xdr.ScSpecTypeDef, where: 'topic' | 'data'];
  const event = (
    name: string,
    params: Param[],
    format: 'single' | 'vec' | 'map' = 'single',
  ): xdr.ScSpecEntry =>
    xdr.ScSpecEntry.scSpecEntryEventV0(
      new xdr.ScSpecEventV0({
        doc: '',
        lib: 'stellar-asset',
        name,
        prefixTopics: [name],
        params: params.map(
          ([pname, type, where]) =>
            new xdr.ScSpecEventParamV0({
              doc: '',
              name: pname,
              type,
              location:
                where === 'topic'
                  ? xdr.ScSpecEventParamLocationV0.scSpecEventParamLocationTopicList
                  : xdr.ScSpecEventParamLocationV0.scSpecEventParamLocationData,
            }),
        ),
        dataFormat:
          format === 'single'
            ? xdr.ScSpecEventDataFormat.scSpecEventDataFormatSingleValue
            : format === 'vec'
              ? xdr.ScSpecEventDataFormat.scSpecEventDataFormatVec
              : xdr.ScSpecEventDataFormat.scSpecEventDataFormatMap,
      }),
    );

  const muxedId = (): xdr.ScSpecTypeDef =>
    T.scSpecTypeOption(new xdr.ScSpecTypeOption({ valueType: T.scSpecTypeU64() }));

  return [
    event('transfer', [['from', address(), 'topic'], ['to', address(), 'topic'], ['sep0011_asset', string(), 'topic'], ['amount', i128(), 'data']]),
    event('transfer', [['from', address(), 'topic'], ['to', address(), 'topic'], ['sep0011_asset', string(), 'topic'], ['amount', i128(), 'data'], ['to_muxed_id', muxedId(), 'data']], 'map'),
    event('approve', [['from', address(), 'topic'], ['spender', address(), 'topic'], ['sep0011_asset', string(), 'topic'], ['amount', i128(), 'data'], ['expiration_ledger', T.scSpecTypeU32(), 'data']], 'vec'),
    // Legacy (pre-protocol 23) four-topic shapes first; see the comment above.
    event('mint', [['admin', address(), 'topic'], ['to', address(), 'topic'], ['sep0011_asset', string(), 'topic'], ['amount', i128(), 'data']]),
    event('mint', [['to', address(), 'topic'], ['sep0011_asset', string(), 'topic'], ['amount', i128(), 'data']]),
    event('mint', [['to', address(), 'topic'], ['sep0011_asset', string(), 'topic'], ['amount', i128(), 'data'], ['to_muxed_id', muxedId(), 'data']], 'map'),
    event('clawback', [['admin', address(), 'topic'], ['from', address(), 'topic'], ['sep0011_asset', string(), 'topic'], ['amount', i128(), 'data']]),
    event('clawback', [['from', address(), 'topic'], ['sep0011_asset', string(), 'topic'], ['amount', i128(), 'data']]),
    event('burn', [['from', address(), 'topic'], ['sep0011_asset', string(), 'topic'], ['amount', i128(), 'data']]),
    event('set_admin', [['admin', address(), 'topic'], ['sep0011_asset', string(), 'topic'], ['new_admin', address(), 'data']]),
    event('set_admin', [['sep0011_asset', string(), 'topic'], ['new_admin', address(), 'data']]),
    event('set_authorized', [['admin', address(), 'topic'], ['id', address(), 'topic'], ['sep0011_asset', string(), 'topic'], ['authorize', T.scSpecTypeBool(), 'data']]),
    event('set_authorized', [['id', address(), 'topic'], ['sep0011_asset', string(), 'topic'], ['authorize', T.scSpecTypeBool(), 'data']]),
    // CAP-67's fee event, emitted by the native SAC for every transaction.
    event('fee', [['from', address(), 'topic'], ['amount', i128(), 'data']]),
  ];
}

/**
 * A parsed, ready-to-match spec for one contract. Building a `Spec` parses
 * every entry's XDR, so callers cache these rather than rebuilding per event —
 * see `SpecCache`.
 */
export class ContractTypedDecoder {
  readonly source: TypedEvent['source'];
  readonly #spec: contract.Spec;
  readonly #events: xdr.ScSpecEventV0[];

  constructor(source: TypedEvent['source'], entries: readonly xdr.ScSpecEntry[]) {
    this.source = source;
    this.#spec = new contract.Spec([...entries]);
    this.#events = this.#spec.events();
  }

  /** From a stored record. `null` when the record says the contract has no usable spec. */
  static fromRecord(record: ContractSpecRecord): ContractTypedDecoder | null {
    if (record.source === 'stellar-asset') return new ContractTypedDecoder('stellar-asset', STELLAR_ASSET_SPEC_ENTRIES);
    if (record.source !== 'wasm' || record.entriesXdr.length === 0) return null;
    const entries = record.entriesXdr.map((e) => xdr.ScSpecEntry.fromXDR(e, 'base64'));
    return new ContractTypedDecoder('wasm', entries);
  }

  /** How many SEP-48 events this spec declares. Zero means nothing can ever match. */
  get eventCount(): number {
    return this.#events.length;
  }

  /** Declared event names, in declaration order, without duplicates. */
  eventNames(): string[] {
    return [...new Set(this.#events.map((e) => e.name.toString()))];
  }

  /**
   * The typed view of one stored event, or `null` when no declared event
   * matches it. Never throws: a spec is third-party data and an event is
   * whatever the contract chose to emit, so a mismatch is a normal outcome.
   */
  decode(event: Pick<LensEvent, 'topicsXdr' | 'valueXdr'>): TypedEvent | null {
    if (this.#events.length === 0) return null;
    let parsed: ReturnType<contract.Spec['parseEvent']>;
    try {
      parsed = this.#spec.parseEvent(event.topicsXdr, event.valueXdr);
    } catch {
      return null;
    }
    if (!parsed) return null;

    // parseEvent reports the name and values but not which declaration
    // matched. Same-named declarations (transfer vs. muxed transfer) differ
    // in their params, so the declaration is the first one with that name
    // that declares every key parseEvent returned.
    const keys = Object.keys(parsed.data);
    const declared = this.#events.find(
      (e) =>
        e.name.toString() === parsed.name &&
        keys.every((k) => e.params.some((p) => p.name.toString() === k)),
    );

    const fields: TypedField[] = [];
    for (const param of declared?.params ?? []) {
      const name = param.name.toString();
      if (!(name in parsed.data)) continue;
      fields.push({
        name,
        type: typeName(param.type),
        location:
          param.location.value === xdr.ScSpecEventParamLocationV0.scSpecEventParamLocationTopicList.value
            ? 'topic'
            : 'data',
        value: toJsonSafe(parsed.data[name]),
      });
    }
    return { name: parsed.name, source: this.source, fields };
  }
}

/**
 * Render a spec type the way a Rust contract author wrote it: `i128`,
 * `Address`, `Option<u64>`, `Vec<Address>`, `Map<Symbol, i128>`, `BytesN<32>`,
 * or a user-defined type's own name.
 */
export function typeName(type: xdr.ScSpecTypeDef): string {
  const t = type as unknown as { type: string; value?: unknown };
  const arm = t.type.replace(/^scSpecType/, '');
  const inner = t.value as Record<string, unknown> | undefined;
  switch (arm) {
    case 'Option':
      return `Option<${typeName(inner!['valueType'] as xdr.ScSpecTypeDef)}>`;
    case 'Result':
      return `Result<${typeName(inner!['okType'] as xdr.ScSpecTypeDef)}, ${typeName(inner!['errorType'] as xdr.ScSpecTypeDef)}>`;
    case 'Vec':
      return `Vec<${typeName(inner!['elementType'] as xdr.ScSpecTypeDef)}>`;
    case 'Map':
      return `Map<${typeName(inner!['keyType'] as xdr.ScSpecTypeDef)}, ${typeName(inner!['valueType'] as xdr.ScSpecTypeDef)}>`;
    case 'Tuple':
      return `(${(inner!['valueTypes'] as xdr.ScSpecTypeDef[]).map(typeName).join(', ')})`;
    case 'BytesN':
      return `BytesN<${String(inner!['n'])}>`;
    case 'Udt':
      return String(inner!['name']);
    case 'Address':
    case 'MuxedAddress':
    case 'String':
    case 'Symbol':
    case 'Bytes':
    case 'Timepoint':
    case 'Duration':
    case 'Error':
    case 'Val':
      return arm;
    case 'Void':
      return '()';
    default:
      // Bool, U32, I128, … — Rust spells the primitives lower-case.
      return arm.toLowerCase();
  }
}

/**
 * Read a spec out of contract Wasm: the `contractspecv0` custom section,
 * returned as base64 XDR entries ready to store.
 * @throws when the bytes are not Wasm or carry no spec section.
 */
export function specEntriesFromWasm(wasm: Uint8Array): string[] {
  const spec = contract.Spec.fromWasm(wasm);
  return spec.entries.map((e) => e.toXDR('base64'));
}

/**
 * Per-process cache of parsed decoders, keyed by contract id.
 *
 * Entries expire so a spec the indexer fetches after the API started — or a
 * `lens spec` refresh — is picked up without a restart. A miss (no record) is
 * cached too, for the same TTL: most contracts never have a spec, and asking
 * the store again for every row of every page would cost more than the decode.
 */
export class SpecCache {
  readonly #load: (contractId: string) => Promise<ContractSpecRecord | null>;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #entries = new Map<string, { at: number; decoder: Promise<ContractTypedDecoder | null> }>();

  constructor(
    load: (contractId: string) => Promise<ContractSpecRecord | null>,
    options: { ttlMs?: number; now?: () => number } = {},
  ) {
    this.#load = load;
    this.#ttlMs = options.ttlMs ?? 60_000;
    this.#now = options.now ?? Date.now;
  }

  get(contractId: string): Promise<ContractTypedDecoder | null> {
    const hit = this.#entries.get(contractId);
    if (hit && this.#now() - hit.at < this.#ttlMs) return hit.decoder;
    const decoder = this.#load(contractId).then(
      (record) => {
        if (!record) return null;
        try {
          return ContractTypedDecoder.fromRecord(record);
        } catch {
          // Stored entries that no longer parse: show the generic view
          // rather than failing the request that wanted the typed one.
          return null;
        }
      },
      () => null,
    );
    this.#entries.set(contractId, { at: this.#now(), decoder });
    return decoder;
  }

  /** Attach a typed view to every event whose contract has a matching spec. */
  async annotate<E extends LensEvent>(events: E[]): Promise<(E & { typed?: TypedEvent })[]> {
    const decoders = new Map<string, ContractTypedDecoder | null>();
    for (const id of new Set(events.map((e) => e.contractId))) decoders.set(id, await this.get(id));
    return events.map((event) => {
      const typed = decoders.get(event.contractId)?.decode(event);
      return typed ? { ...event, typed } : event;
    });
  }

  clear(contractId?: string): void {
    if (contractId === undefined) this.#entries.clear();
    else this.#entries.delete(contractId);
  }
}
