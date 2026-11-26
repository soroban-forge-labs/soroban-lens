import { Address, nativeToScVal, xdr } from '@stellar/stellar-sdk';

/**
 * Topic filters from the command line (#128, #129).
 *
 * A segment is `*`, a base64 XDR ScVal (unchanged, so existing scripts keep
 * their meaning), or a typed shorthand that is encoded here:
 *
 *   sym:transfer  str:hello  addr:G…/addr:C…  bool:true
 *   u32:5  i32:-5  u64:7  i64:-7  u128:10  i128:-10
 */

/** The RPC matches a prefix of at most 4 topic segments per filter. */
export const MAX_TOPIC_SEGMENTS = 4;
/** And accepts at most 5 topic filters per event filter, ORed together. */
export const MAX_TOPIC_FILTERS = 5;

const INTEGER_TYPES = ['u32', 'i32', 'u64', 'i64', 'u128', 'i128'] as const;
export const TOPIC_PREFIXES = ['sym', 'str', 'addr', 'bool', ...INTEGER_TYPES] as const;

export class TopicFlagError extends Error {
  override readonly name = 'TopicFlagError';
}

/** One segment to what the RPC expects: `*` or base64 XDR. */
export function encodeTopicSegment(raw: string): string {
  const segment = raw.trim();
  if (segment === '*') return '*';
  // Base64 never contains ':', so a leading `word:` is unambiguously a prefix.
  const match = /^([A-Za-z0-9]+):(.*)$/s.exec(segment);
  if (!match) return segment;
  const [, prefix = '', value = ''] = match;
  const kind = prefix.toLowerCase();

  let scVal: xdr.ScVal;
  try {
    switch (kind) {
      case 'sym':
        scVal = xdr.ScVal.scvSymbol(value);
        break;
      case 'str':
        scVal = xdr.ScVal.scvString(value);
        break;
      case 'addr':
        scVal = new Address(value).toScVal();
        break;
      case 'bool':
        if (value !== 'true' && value !== 'false') throw new Error('expected true or false');
        scVal = xdr.ScVal.scvBool(value === 'true');
        break;
      default:
        if (!(INTEGER_TYPES as readonly string[]).includes(kind)) {
          throw new TopicFlagError(
            `unknown topic prefix "${prefix}:" in "${segment}". Accepted: ${TOPIC_PREFIXES.map((p) => `${p}:`).join(', ')}, ` +
              "'*', or a base64 XDR ScVal.",
          );
        }
        if (!/^-?\d+$/.test(value)) throw new Error('expected an integer');
        scVal = nativeToScVal(BigInt(value), { type: kind as (typeof INTEGER_TYPES)[number] });
    }
  } catch (error) {
    if (error instanceof TopicFlagError) throw error;
    throw new TopicFlagError(`cannot encode topic "${segment}": ${error instanceof Error ? error.message : String(error)}`);
  }
  return scVal.toXDR('base64');
}

/**
 * Build the topic filters for a stream.
 *
 * - Repeated `--topic` is one positional filter, exactly as before.
 * - Each `--topics 'a,b,*'` is one more filter. Several are ORed by the RPC, so
 *   `--topics sym:transfer,* --topics sym:mint,*` follows transfers and mints.
 *
 * Both limits are checked here, with a message naming the one that was hit,
 * rather than left for the RPC to reject with a generic error.
 */
export function parseTopicFilters(
  topic: string[] | undefined,
  topics: string[] | undefined,
): string[][] | undefined {
  const filters: string[][] = [];
  if (topic && topic.length > 0) filters.push(topic);
  for (const spec of topics ?? []) {
    const segments = spec.split(',').map((s) => s.trim());
    if (segments.some((s) => s === '')) throw new TopicFlagError(`--topics "${spec}" has an empty segment; use '*' for "any value".`);
    filters.push(segments);
  }
  if (filters.length === 0) return undefined;
  if (filters.length > MAX_TOPIC_FILTERS) {
    throw new TopicFlagError(
      `at most ${MAX_TOPIC_FILTERS} topic filters per stream, got ${filters.length}: the RPC ORs at most ${MAX_TOPIC_FILTERS}. ` +
        'Run a second indexer for the rest.',
    );
  }
  for (const filter of filters) {
    if (filter.length > MAX_TOPIC_SEGMENTS) {
      throw new TopicFlagError(
        `at most ${MAX_TOPIC_SEGMENTS} segments per topic filter, got ${filter.length} in "${filter.join(',')}". ` +
          'The RPC matches a prefix of at most 4 segments; events may carry more, so filter on the prefix and narrow afterwards.',
      );
    }
  }
  return filters.map((filter) => filter.map(encodeTopicSegment));
}

const EVENT_TYPES = ['contract', 'system'] as const;

/**
 * `--type` for the indexer: `contract` (the default) or `system`. The
 * rejected value is deliberately not echoed (#144 removed `diagnostic`, and
 * the error must not name it back).
 */
export function parseEventType(raw: string | undefined): 'contract' | 'system' {
  if (raw === undefined || raw.trim() === '') return 'contract';
  const value = raw.trim();
  if ((EVENT_TYPES as readonly string[]).includes(value)) return value as 'contract' | 'system';
  throw new Error('--type must be contract or system');
}

/** `LENS_EVENT_TYPE` / `--type` for config resolution: undefined means "both". */
export function resolveEventType(raw: string | undefined): 'contract' | 'system' | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  return parseEventType(raw);
}

/** `--end-ledger <n>`: a positive integer, or undefined when not given. */
export function parseEndLedger(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error('--end-ledger must be a positive integer');
  }
  return value;
}

/**
 * An end ledger below the start ledger can never be reached. Only checked when
 * the run starts from `startLedger` (a fresh run or `--no-resume`); a resumed
 * cursor may legitimately sit anywhere.
 */
export function validateEndLedgerRange(
  endLedger: number | undefined,
  startLedger: number | undefined,
  fromStart: boolean,
): void {
  if (endLedger === undefined) return;
  // A stored cursor and a bounded range are contradictory instructions: the
  // cursor says "carry on from where you were", the range says "read exactly
  // this window". Rather than silently picking one, say so.
  if (!fromStart) {
    throw new Error(
      'error: --end-ledger indexes a fixed range and cannot resume from a stored cursor.\n' +
        '       Add --no-resume to read the range, or drop --end-ledger to follow the tip.',
    );
  }
  if (startLedger !== undefined && endLedger < startLedger) {
    throw new Error(`error: --end-ledger (${endLedger}) is before --start-ledger (${startLedger})`);
  }
}
