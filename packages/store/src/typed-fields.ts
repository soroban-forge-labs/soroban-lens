import { ContractTypedDecoder } from './spec.js';
import type { ContractSpecRecord, EventQuery, LensEvent, TypedEvent } from './types.js';

const INTEGER_TYPE = /^(?:[iu](?:8|32|64|128|256)|timepoint|duration)$/i;
const MIN_SQLITE_INTEGER = -(1n << 63n);
const MAX_SQLITE_INTEGER = (1n << 63n) - 1n;

export interface TypedFieldRow {
  name: string;
  type: string;
  textValue: string;
  numericValue: string | null;
}

export function decoderFromRecord(record: ContractSpecRecord | null): ContractTypedDecoder | null {
  return record ? ContractTypedDecoder.fromRecord(record) : null;
}

export function decodeTypedFields(decoder: ContractTypedDecoder | null, event: LensEvent): TypedFieldRow[] {
  const typed = decoder?.decode(event);
  return typed ? typedFieldsToRows(typed) : [];
}

export function validateTypedFieldQuery(query: EventQuery): void {
  const hasConstraint = [
    query.typedValue,
    query.typedGt,
    query.typedGte,
    query.typedLt,
    query.typedLte,
  ].some((value) => value !== undefined);
  if ((query.typedField === undefined) !== !hasConstraint || query.typedField === '') {
    throw new Error('typedField is required when filtering on typed field values');
  }
  for (const [name, value] of Object.entries({
    typedGt: query.typedGt,
    typedGte: query.typedGte,
    typedLt: query.typedLt,
    typedLte: query.typedLte,
  })) {
    if (value === undefined) continue;
    if (!/^-?(?:0|[1-9]\d*)$/.test(value)) {
      throw new Error(`${name} must be an integer`);
    }
    const integer = BigInt(value);
    if (integer < MIN_SQLITE_INTEGER || integer > MAX_SQLITE_INTEGER) {
      throw new Error(`${name} must fit a signed 64-bit integer`);
    }
  }
}

export function typedFieldsToRows(typed: TypedEvent): TypedFieldRow[] {
  return typed.fields.map((field) => {
    const textValue =
      typeof field.value === 'string'
        ? field.value
        : field.value === null || typeof field.value === 'number' || typeof field.value === 'boolean'
          ? String(field.value)
          : JSON.stringify(field.value);
    let numericValue: string | null = null;
    if (INTEGER_TYPE.test(field.type) && /^-?(?:0|[1-9]\d*)$/.test(textValue)) {
      const integer = BigInt(textValue);
      if (integer >= MIN_SQLITE_INTEGER && integer <= MAX_SQLITE_INTEGER) numericValue = integer.toString();
    }
    return { name: field.name, type: field.type, textValue, numericValue };
  });
}
