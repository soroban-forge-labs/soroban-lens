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
 * Reject malformed ids up front.
 *
 * An empty list is valid and means "every contract on the network", which is
 * the documented behaviour of `LENS_CONTRACT_IDS` being unset.
 */
export function assertContractIds(contractIds: readonly string[]): void {
  const invalid = contractIds.filter((id) => !isContractId(id));
  if (invalid.length > 0) throw new InvalidContractIdError(invalid);
}

/** Thrown when a contracts file contains a malformed id. Includes the line number. */
export class ContractFileParseError extends Error {
  readonly path: string;
  readonly line: number;
  readonly value: string;
  constructor(path: string, line: number, value: string) {
    super(
      `${path}:${line}: invalid contract id "${value}". ${CONTRACT_ID_HINT}`,
    );
    this.name = 'ContractFileParseError';
    this.path = path;
    this.line = line;
    this.value = value;
  }
}

/**
 * Load contract ids from a plain-text file.
 *
 * Format rules (consistent with shell convention):
 *  - One id per line.
 *  - Lines beginning with `#` (after trimming) are comments and are ignored.
 *  - Blank lines are ignored.
 *  - Any other non-empty line must be a valid contract StrKey; if it is not,
 *    a `ContractFileParseError` is thrown with the 1-based line number.
 *
 * @param filePath - Path to the file to read.
 * @returns Deduplicated list of valid contract ids in file order.
 */
export async function loadContractIdsFromFile(filePath: string): Promise<string[]> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`cannot read contracts file "${filePath}": ${message}`);
  }

  const ids: string[] = [];
  const seen = new Set<string>();

  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const trimmed = raw.trim();

    // Skip blanks and comments.
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    if (!isContractId(trimmed)) {
      throw new ContractFileParseError(filePath, i + 1, trimmed);
    }

    // Silently deduplicate: the same id twice in the file is almost always a
    // copy/paste mistake rather than intent, and no useful behaviour comes
    // from indexing the same contract twice.
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      ids.push(trimmed);
    }
  }

  return ids;
}
