import {
  xdr,
  scValToNative,
  Address,
  decodeAddressToMuxedAccount,
  extractBaseAddress,
} from '@stellar/stellar-sdk';
import type { DecodedValue, JsonValue, LensEvent, RawEventInput } from './types.js';

/**
 * Turn a base64 XDR `ScVal` into a JSON-safe `{ type, value }` pair.
 *
 * Two details in `@stellar/stellar-sdk` v17 drive this implementation:
 *
 * 1. `xdr.ScVal.fromXDR()` returns a *concrete* arm class (`ScValSymbol`,
 *    `ScValI128`, …) rather than a union wrapper. There is no `.switch()` to
 *    read the arm from, so the arm name comes from the constructor.
 * 2. `scValToNative()` returns real JS values — `BigInt` for the 64/128/256-bit
 *    integer arms and `Uint8Array` for `bytes`. Neither survives
 *    `JSON.stringify` usefully (`BigInt` throws, `Uint8Array` becomes
 *    `{"0":46,"1":170,...}`), so both are normalised here.
 */
export function decodeScVal(base64: string): DecodedValue {
  const scv = xdr.ScVal.fromXDR(base64, 'base64');
  return { type: scValTypeName(scv), value: scValToJson(scv) };
}

/**
 * Map key arms that survive JS property-key coercion without colliding: each
 * one renders to a string that identifies the key uniquely within its type.
 * A map keyed only by these keeps the plain-object shape every caller expects.
 */
const SCALAR_KEY_TYPES = new Set([
  'symbol',
  'string',
  'address',
  'bool',
  'u32',
  'i32',
  'u64',
  'i64',
  'u128',
  'i128',
  'u256',
  'i256',
  'timepoint',
  'duration',
]);

/**
 * `toJsonSafe(scValToNative(scv))`, except for maps whose keys are not scalars
 * (#149).
 *
 * scValToNative builds a map as a plain object, so every key goes through
 * property-key coercion: a `bytes` key becomes a comma-joined byte list, a
 * `vec` key its joined elements, a `map` key `[object Object]`. Two distinct
 * keys can coerce to the same string and one value silently replaces the
 * other. Such a map is rendered as an ordered array of `{ key, value }` pairs
 * instead, each key decoded the normal way; so is a scalar-keyed map whose
 * keys still collide once coerced. The walk happens on the raw ScVal
 * because by the time scValToNative returns, the collision has already
 * happened.
 */
function scValToJson(scv: unknown): JsonValue {
  const type = scValTypeName(scv);
  if (type === 'vec') {
    const elements = ((scv as xdr.ScValVec).value as unknown[] | null | undefined) ?? [];
    return elements.map(scValToJson);
  }
  if (type === 'map') {
    const entries = ((scv as xdr.ScValMap).value as xdr.ScMapEntry[] | null | undefined) ?? [];
    if (entries.every((entry) => SCALAR_KEY_TYPES.has(scValTypeName(entry.key)))) {
      const keys = entries.map((entry) => String(toJsonSafe(scValToNative(entry.key))));
      // Scalar keys can still collide across types (the u32 5 and the string
      // "5"); scValToNative refuses such a map, so it gets pairs as well.
      if (new Set(keys).size === keys.length) {
        // Built the way scValToNative + toJsonSafe built it before, so the
        // output for a scalar-keyed map is unchanged: same coerced keys and
        // the same engine key order.
        const out: Record<string, JsonValue> = {};
        entries.forEach((entry, i) => {
          out[keys[i]!] = scValToJson(entry.val);
        });
        return out;
      }
    }
    return entries.map((entry) => ({ key: scValToJson(entry.key), value: scValToJson(entry.val) }));
  }
  return toJsonSafe(scValToNative(scv as xdr.ScVal));
}

/** `ScValSymbol` -> `symbol`, `ScValI128` -> `i128`, `ScValLedgerKeyNonce` -> `ledgerKeyNonce`. */
export function scValTypeName(scv: unknown): string {
  const name = (scv as { constructor?: { name?: string } })?.constructor?.name ?? '';
  // Anything that is not an ScVal arm is reported as "unknown" rather than as
  // its own class name, so a decoder bug can never masquerade as a real type.
  if (!name.startsWith('ScVal')) return 'unknown';
  const arm = name.slice(5);
  if (arm === '') return 'unknown';
  // Leading acronym-ish runs stay lower-cased as a unit: "U32" -> "u32".
  return arm[0]!.toLowerCase() + arm.slice(1);
}

/**
 * Recursively convert a `scValToNative` result into something `JSON.stringify`
 * round-trips without loss.
 *
 * - `BigInt` -> decimal string. i128/u128 exceed `Number.MAX_SAFE_INTEGER`, so
 *   a number would silently lose precision on large token amounts.
 * - `Uint8Array` -> lower-case hex string, the convention Stellar tooling uses
 *   for hashes and raw blobs.
 */
export function toJsonSafe(input: unknown): JsonValue {
  if (input === null || input === undefined) return null;

  switch (typeof input) {
    case 'bigint':
      return input.toString();
    case 'string':
    case 'boolean':
      return input;
    case 'number':
      return Number.isFinite(input) ? input : String(input);
    case 'symbol':
      return input.description ?? 'symbol';
    case 'function':
      return null;
  }

  if (input instanceof Uint8Array) return Buffer.from(input).toString('hex');
  if (Array.isArray(input)) return input.map(toJsonSafe);

  if (input instanceof Map) {
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of input) out[String(typeof k === 'bigint' ? k.toString() : k)] = toJsonSafe(v);
    return out;
  }

  const out: Record<string, JsonValue> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) out[k] = toJsonSafe(v);
  return out;
}

/**
 * Decode a raw RPC event into a storable record.
 *
 * Never throws on bad XDR. A contract can emit anything, and one undecodable
 * event must not stall the indexer or lose the surrounding batch — the raw
 * bytes are stored with `decodeError` set so the row stays re-decodable later.
 */
export function decodeEvent(raw: RawEventInput, now = new Date()): LensEvent {
  const errors: string[] = [];

  const topics = raw.topic.map((t, i) => {
    try {
      return decodeScVal(t);
    } catch (error) {
      errors.push(`topic[${i}]: ${message(error)}`);
      return { type: 'undecodable', value: t } satisfies DecodedValue;
    }
  });

  let value: DecodedValue;
  try {
    value = decodeScVal(raw.value);
  } catch (error) {
    errors.push(`value: ${message(error)}`);
    value = { type: 'undecodable', value: raw.value };
  }

  return {
    id: raw.id,
    contractId: raw.contractId,
    type: raw.type,
    ledger: raw.ledger,
    ledgerClosedAt: raw.ledgerClosedAt,
    txHash: raw.txHash,
    transactionIndex: raw.transactionIndex,
    operationIndex: raw.operationIndex,
    inSuccessfulContractCall: raw.inSuccessfulContractCall,
    topics,
    topicsXdr: [...raw.topic],
    value,
    valueXdr: raw.value,
    decodeError: errors.length > 0 ? errors.join('; ') : undefined,
    indexedAt: now.toISOString(),
  };
}

/**
 * Flatten a decoded topic to the scalar text used for indexed filtering.
 *
 * Only scalars are indexable; a topic that is itself a map or vec has no
 * sensible single-column representation and returns null, so it simply will not
 * match a topic filter. That is the honest behaviour — better than stringifying
 * it into something a user cannot predict or type.
 */
export function topicKey(topic: DecodedValue | undefined): string | null {
  if (!topic) return null;
  const v = topic.value;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

/**
 * The ScVal type stored alongside `topicKey` (#146), so a filter can tell the
 * symbol `transfer` from the string `"transfer"`, or the u32 `5` from the
 * string `"5"`. Null exactly where `topicKey` is null: a topic with no
 * indexable value has no indexable type either.
 */
export function topicType(topic: DecodedValue | undefined): string | null {
  return topicKey(topic) === null ? null : topic!.type;
}

/**
 * Every address anywhere inside a decoded ScVal, for #23's side-table index.
 *
 * scValToNative() collapses the whole tree into plain natives — a nested
 * address inside a vec or a map comes out as a bare string, indistinguishable
 * from any other string in the same position. That is fine for display, and
 * useless for finding addresses: by the time a value is JSON, the type tag
 * that said "this string is an address" is already gone. This walks the raw
 * ScVal tree instead, before that information is lost, using the same
 * constructor-name dispatch decodeScVal() uses for the same reason.
 *
 * Never throws: malformed XDR degrades to an empty list rather than breaking
 * the insert it would otherwise be part of. decodeEvent() already carries the
 * real error via decodeError; this is a secondary extraction, not the
 * authoritative decode.
 */
export function extractAddresses(base64: string): string[] {
  const found = new Set<string>();
  try {
    walkForAddresses(xdr.ScVal.fromXDR(base64, 'base64'), found);
  } catch {
    // decodeEvent's try/catch around decodeScVal is what reports this
    // properly; here it is simply nothing to extract.
  }
  return [...found];
}

export function parseMuxedAddress(address: string): { baseAddress: string; muxedId: string } | null {
  if (!address.startsWith('M')) return null;
  const muxed = decodeAddressToMuxedAccount(address);
  if (muxed.type !== 'keyTypeMuxedEd25519') throw new Error(`invalid muxed account address "${address}"`);
  return { baseAddress: extractBaseAddress(address), muxedId: muxed.med25519.id.toString() };
}

export function transferToMuxedId(event: LensEvent): string | null {
  if (
    event.topics[0]?.type !== 'symbol' ||
    event.topics[0].value !== 'transfer' ||
    event.topics[2]?.type !== 'address' ||
    event.value.type !== 'map'
  ) {
    return null;
  }
  const value = xdr.ScVal.fromXDR(event.valueXdr, 'base64');
  if (scValTypeName(value) !== 'map') return null;
  const entries = (value as xdr.ScValMap).value ?? [];
  for (const entry of entries) {
    if (scValTypeName(entry.key) !== 'symbol' || scValToNative(entry.key) !== 'to_muxed_id') continue;
    if (scValTypeName(entry.val) !== 'u64') return null;
    const id = scValToNative(entry.val);
    return typeof id === 'bigint' ? id.toString() : null;
  }
  return null;
}

function walkForAddresses(scv: unknown, out: Set<string>): void {
  const name = (scv as { constructor?: { name?: string } })?.constructor?.name;
  if (name === 'ScValAddress') {
    out.add(Address.fromScVal(scv as xdr.ScVal).toString());
    return;
  }
  if (name === 'ScValVec') {
    for (const element of (scv as xdr.ScValVec).value as unknown[]) walkForAddresses(element, out);
    return;
  }
  if (name === 'ScValMap') {
    for (const entry of (scv as xdr.ScValMap).value as xdr.ScMapEntry[]) {
      walkForAddresses(entry.key, out);
      walkForAddresses(entry.val, out);
    }
  }
  // Every other arm is a scalar or a fixed shape with no address inside it.
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
