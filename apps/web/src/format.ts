import type { DecodedValue } from './types.js';

/** Shorten a contract id or hash for table display: "CDLZFC3S…U2HHGCYSC". */
export function truncate(value: string, head = 8, tail = 8): string {
  // Show full string if it's short enough, otherwise truncate with ellipsis
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** Return a public Stellar Expert URL, or undefined for an unknown network. */
export function explorerUrl(network: string, kind: 'tx' | 'contract', id: string): string | undefined {
  const segments: Record<string, string> = { testnet: 'testnet', mainnet: 'public', futurenet: 'futurenet' };
  const segment = segments[network.toLowerCase()];
  return segment && id ? `https://stellar.expert/explorer/${segment}/${kind}/${encodeURIComponent(id)}` : undefined;
}

/**
 * One-line summary of a decoded value, for the collapsed table row.
 * Structured values are summarised by shape rather than dumped, so a row stays
 * one line no matter what the contract emitted.
 */
export function summarise(decoded: DecodedValue): string {
  const { type, value } = decoded;
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `${type}[${value.length}]`;
  if (typeof value === 'object') return `${type}{${Object.keys(value).length}}`;
  const text = String(value);
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

/** Topic list rendered as a compact path: "transfer / GABC…XYZ". */
export function topicPath(topics: DecodedValue[]): string {
  return topics.map((t) => summarise(t)).join(' / ');
}

/** "3m ago" — relative time, since event tables are read newest-first. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return iso;
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Pretty-print a decoded payload for the expanded row. */
export function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
