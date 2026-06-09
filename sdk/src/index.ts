/**
 * OPTIC — On-chain Predictable Transparent Intelligence for Commerce.
 *
 * Public SDK surface. Re-exports the core types, contract addresses,
 * and helper functions.
 */

export { PACKAGE_ID, MODULES, NETWORK, RPC_URLS } from './constants.js';
export { OpticClient } from './client.js';
export { AgentBuilder } from './agent.js';
export { Treasury } from './treasury.js';
export { WalrusAudit } from './walrus.js';
export { DeepBookClient } from './deepbook.js';
export { PredictClient } from './predict.js';
export {
  configureZkLogin,
  loadSession,
  saveSession,
  clearSession,
  connectZkLogin,
  signTransactionWithZkLogin,
} from './zklogin.js';
export type { ZkLoginConfig, ZkLoginSession } from './zklogin.js';
export * from './types.js';
