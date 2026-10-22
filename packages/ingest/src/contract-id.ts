/**
 * Contract id validation, shared so the indexer and `lens doctor` cannot drift.
 *
 * A Soroban contract id is a StrKey: 'C' followed by 55 base32 characters
 * (RFC 4648 alphabet, so A-Z and 2-7 — no 0, 1, 8 or 9). Account ids use the
 * same alphabet but start with 'G', which is the mistake worth naming
 * explicitly, because the RPC's own error for it is not obvious.
 */
import { readFile } from 'node:fs/promises';

export const CONTRACT_ID_PATTERN = /^C[A-Z2-7]{55}$/;

/** The one sentence that explains the shape, used everywhere it is rejected. */
export const CONTRACT_ID_HINT =
  "A contract id is 'C' followed by 55 characters (A-Z, 2-7). Account ids start with 'G' and are not contracts.";

export function isContractId(value: string): boolean {
  return CONTRACT_ID_PATTERN.test(value);
}

/** Thrown before any network call when a configured contract id is malformed. */
export class InvalidContractIdError extends Error {
  readonly invalid: string[];
  constructor(invalid: string[]) {
    super(`not contract StrKeys: ${invalid.join(', ')}. ${CONTRACT_ID_HINT}`);
    this.name = 'InvalidContractIdError';
    this.invalid = invalid;
  }
}

/**
 * Thrown when a contracts file cannot be parsed — either the file is missing
 * or a non-blank, non-comment line is not a valid contract StrKey. The message
 * includes the 1-based line number so operators can fix the file quickly.
 */
export class ContractFileParseError extends Error {
  /** 1-based line number of the offending line, or undefined for I/O errors. */
  readonly line: number | undefined;
  constructor(message: string, line?: number) {
    super(message);
    this.name = 'ContractFileParseError';
    this.line = line;
  }
}

/**
 * Reject malformed ids up front.
 *
 * An empty list is valid and means "every contract on the network", which is
 * the documented behaviour of `LENS_CONTRACT_IDS` being unset.
 */
export function assertContractIds(contractIds: readonly string[]): void {
  const invalid = contractIds.filter((id) => !isContractId(id));
  if (invalid.length > 0) throw new InvalidContractIdError(invalid);
}

/**
 * Read contract ids from a file, one per line.
 *
 * - Lines beginning with `#` (after trimming whitespace) are ignored as comments.
 * - Blank lines are ignored.
 * - Any non-blank, non-comment line must be a valid contract StrKey; if it is
 *   not, a `ContractFileParseError` is thrown with the **1-based line number**.
 * - Duplicate ids are silently dropped (first occurrence wins).
 *
 * Throws `ContractFileParseError` for I/O errors (e.g. file not found) or
 * invalid ids.
 */
export async function loadContractIdsFromFile(filePath: string): Promise<string[]> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch (error) {
    throw new ContractFileParseError(
      `could not read contracts file "${filePath}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const seen = new Set<string>();
  const ids: string[] = [];

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    // Skip blanks and comments.
    if (line === '' || line.startsWith('#')) continue;

    if (!isContractId(line)) {
      throw new ContractFileParseError(
        `contracts file "${filePath}" line ${i + 1}: not a contract StrKey: "${line}". ${CONTRACT_ID_HINT}`,
        i + 1,
      );
    }

    if (!seen.has(line)) {
      seen.add(line);
      ids.push(line);
    }
  }

  return ids;
}
