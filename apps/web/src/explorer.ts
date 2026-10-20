/**
 * Outbound links to a block explorer, per network.
 *
 * The network here is the UI's label for an API instance (`VITE_LENS_NETWORKS`),
 * because that is what the user selected — not the network the API reports. A
 * label missing from the map deliberately produces no link: linking a private
 * network's data out to a public explorer would go to the wrong network, and an
 * unknown self-hosted one has no sensible default.
 *
 * Configure with `VITE_LENS_EXPLORERS`, a JSON object of
 * `{ label: baseUrl | { tx, contract, account } }`:
 *
 * - A string is a Stellar Expert-style root; `/tx/…`, `/contract/…` and
 *   `/account/…` are appended.
 * - An object maps each entity to a full URL template containing `{value}`,
 *   for a self-hosted explorer whose routes are laid out differently.
 * - An empty string turns links off for that label.
 *
 * Like every `VITE_*` variable this is baked in at build time.
 */
export type ExplorerEntity = 'tx' | 'contract' | 'account';

/** URL templates for one network; `{value}` is replaced with the id. */
export type ExplorerRoutes = Partial<Record<ExplorerEntity, string>>;

export type ExplorerMap = Record<string, string | ExplorerRoutes>;

/** The path layout a plain base URL is assumed to use — Stellar Expert's. */
const DEFAULT_PATHS: Record<ExplorerEntity, string> = {
  tx: 'tx',
  contract: 'contract',
  account: 'account',
};

/** Stellar Expert, whose layout the string form of the config matches. */
export const DEFAULT_EXPLORERS: ExplorerMap = {
  testnet: 'https://stellar.expert/explorer/testnet',
  futurenet: 'https://stellar.expert/explorer/futurenet',
  // Stellar Expert calls the public network "public"; both labels are common.
  mainnet: 'https://stellar.expert/explorer/public',
  public: 'https://stellar.expert/explorer/public',
};

const ACCOUNT_ID = /^G[A-Z2-7]{55}$/;
const CONTRACT_ID = /^C[A-Z2-7]{55}$/;
const TX_HASH = /^[0-9a-fA-F]{64}$/;

/**
 * An id of the wrong shape is a bug upstream or a placeholder, and either way
 * the explorer page would 404. No link is the honest result.
 */
function isWellFormed(entity: ExplorerEntity, value: string): boolean {
  if (entity === 'tx') return TX_HASH.test(value);
  if (entity === 'contract') return CONTRACT_ID.test(value);
  return ACCOUNT_ID.test(value);
}

/** Labels are matched case-insensitively: "Testnet" in config, "testnet" here. */
function lookup(map: ExplorerMap, network: string): string | ExplorerRoutes | undefined {
  const wanted = network.toLowerCase();
  for (const [label, entry] of Object.entries(map)) {
    if (label.toLowerCase() === wanted) return entry;
  }
  return undefined;
}

// Parsed once: the environment is fixed at build time, and explorerUrl runs for
// every link on every render.
let cached: ExplorerMap | null = null;

/** The map in use: the defaults, with anything from `VITE_LENS_EXPLORERS` on top. */
export function configuredExplorers(): ExplorerMap {
  if (cached) return cached;
  const raw = import.meta.env?.VITE_LENS_EXPLORERS as string | undefined;
  if (!raw) {
    cached = DEFAULT_EXPLORERS;
    return cached;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('expected a JSON object');
    }
    // Shallow: a label given in the environment replaces the default whole, so
    // `{"testnet": ""}` disables links rather than falling back to a default.
    cached = { ...DEFAULT_EXPLORERS, ...(parsed as ExplorerMap) };
  } catch {
    console.warn('VITE_LENS_EXPLORERS is not a JSON object; falling back to the defaults.');
    cached = DEFAULT_EXPLORERS;
  }
  return cached;
}

/**
 * Resolve a link, or `null` when the network has no explorer configured or the
 * id is not one the route can take.
 */
export function resolveExplorerUrl(
  map: ExplorerMap,
  network: string,
  entity: ExplorerEntity,
  value: string,
): string | null {
  if (!isWellFormed(entity, value)) return null;
  const entry = lookup(map, network);
  if (entry === undefined || entry === '') return null;

  const encoded = encodeURIComponent(value);
  if (typeof entry === 'string') {
    const base = entry.replace(/\/+$/, '');
    return `${base}/${DEFAULT_PATHS[entity]}/${encoded}`;
  }

  const template = entry[entity];
  return template === undefined ? null : template.replace('{value}', encoded);
}

/** Convenience wrapper over the configured map. */
export function explorerUrl(
  network: string,
  entity: ExplorerEntity,
  value: string,
  map: ExplorerMap = configuredExplorers(),
): string | null {
  return resolveExplorerUrl(map, network, entity, value);
}
