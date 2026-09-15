import { xdr, scValToNative } from '@stellar/stellar-sdk';
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
  return { type: scValTypeName(scv), value: toJsonSafe(scValToNative(scv)) };
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

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
