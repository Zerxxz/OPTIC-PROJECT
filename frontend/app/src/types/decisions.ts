/**
 * OPTIC decision log type contract
 * Mirrors the on-chain `AuditEntry` event emitted by core.move
 */
export type AgentKind = 'quant' | 'risk' | 'executor';
export type ActionKind =
  | 'place_order'
  | 'open_hedge'
  | 'close_position'
  | 'pause'
  | 'resume'
  | 'no_op';
export type Side = 0 | 1 | null; // 0 = BUY, 1 = SELL, null = N/A

export interface Decision {
  id: string;
  agent: AgentKind;
  action: ActionKind;
  side: Side;
  confidenceBps: number; // basis points (0-10000)
  reason: string;
  atMs: number; // unix epoch ms
  txDigest: string | null;
  pnlAfter: bigint | null; // micro-USDC, signed
  blobId: string | null; // Walrus blob id anchoring the decision
}

export interface DecisionFilters {
  agent: 'all' | AgentKind;
  action: 'all' | ActionKind;
}
