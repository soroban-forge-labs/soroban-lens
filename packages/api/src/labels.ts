import { readFileSync } from 'node:fs';

const CONTRACT_ID = /^C[A-Z2-7]{55}$/;

/**
 * Load `LENS_CONTRACT_LABELS`: a JSON object mapping contract id to a label.
 *
 * No path, or a path that does not exist, means no labels. A file that exists
 * but is malformed, or names an invalid contract id, throws so a typo fails at
 * startup rather than silently dropping a label.
 */
export function loadContractLabels(path: string | undefined): Record<string, string> {
  if (!path) return {};
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Contract labels file ${path} is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Contract labels file ${path} must be a JSON object of contract id to label.`);
  }
  const labels: Record<string, string> = {};
  for (const [id, label] of Object.entries(parsed)) {
    if (!CONTRACT_ID.test(id)) throw new Error(`Contract labels file ${path}: "${id}" is not a contract id.`);
    if (typeof label !== 'string' || label.trim() === '') {
      throw new Error(`Contract labels file ${path}: the label for ${id} must be a non-empty string.`);
    }
    labels[id] = label;
  }
  return labels;
}
