/**
 * OPTIC Orchestrator — coordinates the three specialist agents (Quant,
 * Risk, Executor) that operate a single Agent on Sui.
 *
 * Design:
 *   - Each specialist is a pure function of (Agent state, market state)
 *     plus a deterministic strategy. No LLM call in the hot path so the
 *     loop is fully reproducible for judges.
 *   - Specialists emit `Decision` objects (proposed actions). The
 *     coordinator validates them against the Agent's risk params, then
 *     dispatches to the on-chain executor.
 *   - Every decision is logged to Walrus (via the audit log) so the
 *     public Walrus Site can render a per-agent decision history.
 */

export { Orchestrator, type OrchestratorConfig } from './orchestrator.js';
export { QuantAgent } from './agents/quant.js';
export { RiskAgent } from './agents/risk.js';
export { ExecutorAgent } from './agents/executor.js';
export { meanReversionStrategy } from './strategies/mean-reversion.js';
export { marketMakingStrategy } from './strategies/market-making.js';
export { momentumStrategy } from './strategies/momentum.js';
export type {
  Agent,
  AgentState,
  MarketState,
  Decision,
  DecisionAction,
  OrchestratorEvent,
} from './types.js';
