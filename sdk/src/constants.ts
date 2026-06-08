/**
 * Network + package constants. The PACKAGE_ID is the published
 * Move package on the target network. After `sui client publish` the
 * caller must override PACKAGE_ID at runtime via the OpticClient constructor.
 */

export type Network = 'mainnet' | 'testnet' | 'devnet' | 'localnet';

export const NETWORK: Network = 'testnet';

export const RPC_URLS: Record<Network, string> = {
  mainnet: 'https://fullnode.mainnet.sui.io:443',
  testnet: 'https://fullnode.testnet.sui.io:443',
  devnet: 'https://fullnode.devnet.sui.io:443',
  localnet: 'http://127.0.0.1:9000',
};

/**
 * Default package ID — must be replaced after `sui client publish`.
 * Setting to a 0x0 sentinel by default forces the caller to configure it.
 */
export const PACKAGE_ID = '0x0';

export const MODULES = {
  core: `${PACKAGE_ID}::core`,
  treasury: `${PACKAGE_ID}::treasury`,
  deepbookAdapter: `${PACKAGE_ID}::deepbook_adapter`,
  walrusAdapter: `${PACKAGE_ID}::walrus_adapter`,
  predictAdapter: `${PACKAGE_ID}::predict_adapter`,
} as const;

/**
 * DeepBookV3 package ID (canonical for the network). Used by the
 * DeepBookClient to compose PTBs.
 */
export const DEEPBOOK_PACKAGE_IDS: Record<Network, string> = {
  mainnet: '0x000000000000000000000000000000000000000000000000000000000000dee9',
  testnet: '0x000000000000000000000000000000000000000000000000000000000000dee9',
  devnet: '0x000000000000000000000000000000000000000000000000000000000000dee9',
  localnet: '0x0',
};

/**
 * Walrus aggregator / publisher endpoints. Walrus Sites are served via
 * wal.app, but the aggregator that stores blobs is at publisher.walrus.site.
 */
export const WALRUS_ENDPOINTS: Record<Network, string> = {
  mainnet: 'https://publisher.walrus.site',
  testnet: 'https://publisher.walrus.site',
  devnet: 'https://publisher.walrus.site',
  localnet: 'http://127.0.0.1:31415',
};
