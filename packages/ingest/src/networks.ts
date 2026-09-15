/**
 * Network presets. RPC URLs and passphrases verified against the live
 * `getNetwork` RPC method on 2026-09-15.
 */
export interface NetworkConfig {
  name: string;
  rpcUrl: string;
  networkPassphrase: string;
  /** Horizon base URL, for clients that want transaction/account context. */
  horizonUrl: string;
}

export const NETWORKS = {
  testnet: {
    name: 'testnet',
    rpcUrl: 'https://soroban-testnet.stellar.org',
    networkPassphrase: 'Test SDF Network ; September 2015',
    horizonUrl: 'https://horizon-testnet.stellar.org',
  },
  mainnet: {
    name: 'mainnet',
    // SDF does not run a free public mainnet RPC with useful retention.
    // Override LENS_RPC_URL with your own node or a provider before using mainnet.
    rpcUrl: 'https://mainnet.sorobanrpc.com',
    networkPassphrase: 'Public Global Stellar Network ; September 2015',
    horizonUrl: 'https://horizon.stellar.org',
  },
  futurenet: {
    name: 'futurenet',
    rpcUrl: 'https://rpc-futurenet.stellar.org',
    networkPassphrase: 'Test SDF Future Network ; October 2022',
    horizonUrl: 'https://horizon-futurenet.stellar.org',
  },
} as const satisfies Record<string, NetworkConfig>;

export type NetworkName = keyof typeof NETWORKS;

export function isNetworkName(value: string): value is NetworkName {
  return Object.hasOwn(NETWORKS, value);
}

/**
 * Resolve a network preset, optionally overriding the RPC URL.
 * An explicit `rpcUrl` always wins over the preset, which is how you point at a
 * local quickstart node or a commercial provider.
 */
export function resolveNetwork(network: string, rpcUrl?: string): NetworkConfig {
  if (!isNetworkName(network)) {
    throw new Error(
      `Unknown network "${network}". Expected one of: ${Object.keys(NETWORKS).join(', ')}.`,
    );
  }
  const preset = NETWORKS[network];
  return rpcUrl ? { ...preset, rpcUrl } : { ...preset };
}
