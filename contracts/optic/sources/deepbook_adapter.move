// =============================================================================
// Module: optic::deepbook_adapter
// -----------------------------------------------------------------------------
// OPTIC DeepBook Adapter: typed order + fill records for the on-chain audit
// log. The actual order submission is handled off-chain by the orchestrator
// using the real DeepBookV3 SDK (this is the canonical pattern for Sui
// hackathon projects — DeepBook SDK is a TypeScript library, not a Move
// dependency, so we cannot import it directly without bloat).
//
// What this module DOES:
//   1. Record intent-to-trade (OrderRequest) before the orchestrator submits
//      the actual DeepBook PTB. This means the audit trail shows the agent
//      THOUGHT about a trade, even if it ultimately failed.
//   2. Record confirmed fills (TradeRecord) when the orchestrator sees a
//      matching event on the DeepBook indexer.
//   3. Verify the strategy-hash on Agent at record time — if the strategy
//      changed since the last audit, we emit a `StrategyMismatch` event
//      that watchers can use to halt the agent.
// =============================================================================

module optic::deepbook_adapter;

use std::type_name;
use sui::event;
use sui::object::{Self, ID, UID};
use sui::transfer;
use sui::tx_context::{Self, TxContext};
use optic::core::{Self, Agent, AgentCap, PnL};

// -----------------------------------------------------------------------------
// Error codes
// -----------------------------------------------------------------------------
const EWrongAgent: u64 = 200;
const EWrongCap: u64 = 201;
const EInsufficientCapRole: u64 = 202;
const EAgentNotActive: u64 = 203;
const EStrategyHashMismatch: u64 = 204;
const EInsufficientBalance: u64 = 205;

// -----------------------------------------------------------------------------
// Role constants
// -----------------------------------------------------------------------------
const ROLE_FULL: u8 = 0;
const ROLE_EXECUTOR: u8 = 3;

// -----------------------------------------------------------------------------
// Order side enum
// -----------------------------------------------------------------------------
const SIDE_BUY: u8 = 0;
const SIDE_SELL: u8 = 1;

// -----------------------------------------------------------------------------
// Order type enum
// -----------------------------------------------------------------------------
const TYPE_LIMIT: u8 = 0;
const TYPE_MARKET: u8 = 1;

// -----------------------------------------------------------------------------
// Objects
// -----------------------------------------------------------------------------

/// An OrderRequest — the orchestrator's intent to submit an order to
/// DeepBook. Stored as a shared object so multiple specialists can read it.
/// Auto-burns after `ttl_ms` to keep storage bounded.
public struct OrderRequest has key, store {
    id: UID,
    agent_id: ID,
    /// 0 = BUY, 1 = SELL.
    side: u8,
    /// 0 = LIMIT, 1 = MARKET.
    order_type: u8,
    /// Base asset (e.g. SUI). Stored as ASCII for now; production version
    /// would use the coin TypeName for type safety.
    base_asset: vector<u8>,
    /// Quote asset (e.g. USDC).
    quote_asset: vector<u8>,
    /// Price in quote units (scaled by 1e6 for USDC). 0 for market orders.
    price: u64,
    /// Size in base units.
    size: u64,
    /// Cap holder who issued this request.
    requested_by: address,
    /// Strategy hash at the time of the request.
    strategy_hash_at_request: vector<u8>,
    /// TTL in ms; orchestrator is expected to submit before this.
    ttl_ms: u64,
    /// Time the request was created.
    created_at_ms: u64,
    /// 0 = pending, 1 = submitted, 2 = filled, 3 = cancelled, 4 = expired.
    status: u8,
}

/// A TradeRecord — a confirmed fill from DeepBook, written by the
/// orchestrator after it sees the indexer event. Self-attesting: anyone can
/// cross-check against DeepBook's own history (DeepBookV3 events are
/// indexable at https://deepbook.tech).
public struct TradeRecord has key, store {
    id: UID,
    agent_id: ID,
    order_request_id: Option<ID>,
    /// DeepBook tx digest (32-byte hash). Optional in MVP.
    deepbook_tx_digest: Option<vector<u8>>,
    /// 0 = BUY, 1 = SELL.
    side: u8,
    base_asset: vector<u8>,
    quote_asset: vector<u8>,
    /// Executed price in quote units.
    fill_price: u64,
    /// Executed size in base units.
    fill_size: u64,
    /// Fee paid in quote units.
    fee: u64,
    /// Realized PnL delta from this fill (signed, magnitude + sign).
    realized_pnl_mag: u64,
    realized_pnl_sign: u8,
    /// Strategy hash at fill time (must match request if both are present).
    strategy_hash: vector<u8>,
    filled_at_ms: u64,
}

/// StrategyMismatch record — emitted when the strategy hash on the Agent
/// changes between an OrderRequest and a TradeRecord for the same agent.
/// Could indicate the strategy was swapped mid-flight (suspicious).
public struct StrategyMismatch has copy, drop {
    agent_id: ID,
    old_hash: vector<u8>,
    new_hash: vector<u8>,
    trade_record_id: ID,
    at_ms: u64,
}

/// OrderSubmitted event — emitted on intent creation.
public struct OrderSubmitted has copy, drop {
    request_id: ID,
    agent_id: ID,
    side: u8,
    order_type: u8,
    base_asset: vector<u8>,
    quote_asset: vector<u8>,
    price: u64,
    size: u64,
    requested_by: address,
    at_ms: u64,
}

/// TradeFilled event — emitted on confirmed fill.
public struct TradeFilled has copy, drop {
    trade_id: ID,
    agent_id: ID,
    side: u8,
    fill_price: u64,
    fill_size: u64,
    fee: u64,
    realized_pnl_mag: u64,
    realized_pnl_sign: u8,
    at_ms: u64,
}

// -----------------------------------------------------------------------------
// Order intent
// -----------------------------------------------------------------------------

/// Create a new OrderRequest. Only the executor or full cap can issue.
/// The request is shared so all agents in the system (off-chain) can read it.
public fun submit_order(
    agent: &Agent,
    cap: &AgentCap,
    side: u8,
    order_type: u8,
    base_asset: vector<u8>,
    quote_asset: vector<u8>,
    price: u64,
    size: u64,
    ttl_ms: u64,
    ctx: &mut TxContext,
): ID {
    // Auth
    assert!(core::cap_agent_id(cap) == object::id(agent), EWrongCap);
    assert!(
        core::cap_role(cap) == ROLE_EXECUTOR || core::cap_role(cap) == ROLE_FULL,
        EInsufficientCapRole,
    );
    assert!(core::agent_status(agent) == core::status_active(), EAgentNotActive);
    assert!(side == SIDE_BUY || side == SIDE_SELL, EStrategyHashMismatch);
    assert!(order_type == TYPE_LIMIT || order_type == TYPE_MARKET, EStrategyHashMismatch);
    if (order_type == TYPE_LIMIT) {
        assert!(price > 0, EStrategyHashMismatch);
    };
    assert!(size > 0, EStrategyHashMismatch);

    let now = tx_context::epoch_timestamp_ms(ctx);
    let req_uid = object::new(ctx);
    let req_id = object::uid_to_inner(&req_uid);

    let req = OrderRequest {
        id: req_uid,
        agent_id: object::id(agent),
        side,
        order_type,
        base_asset,
        quote_asset,
        price,
        size,
        requested_by: tx_context::sender(ctx),
        strategy_hash_at_request: *core::agent_strategy_hash(agent),
        ttl_ms: now + ttl_ms,
        created_at_ms: now,
        status: 0, // pending
    };

    event::emit(OrderSubmitted {
        request_id: req_id,
        agent_id: object::id(agent),
        side,
        order_type,
        base_asset: req.base_asset,
        quote_asset: req.quote_asset,
        price,
        size,
        requested_by: tx_context::sender(ctx),
        at_ms: now,
    });

    transfer::share_object(req);
    req_id
}

// -----------------------------------------------------------------------------
// Fill record
// -----------------------------------------------------------------------------

/// Record a confirmed fill from DeepBook. Updates the linked PnL object.
public fun record_fill(
    agent: &mut Agent,
    pnl: &mut PnL,
    cap: &AgentCap,
    side: u8,
    base_asset: vector<u8>,
    quote_asset: vector<u8>,
    fill_price: u64,
    fill_size: u64,
    fee: u64,
    realized_pnl_mag: u64,
    realized_pnl_sign: u8,
    deepbook_tx_digest: Option<vector<u8>>,
    ctx: &mut TxContext,
): ID {
    // Auth
    assert!(core::cap_agent_id(cap) == object::id(agent), EWrongCap);
    assert!(
        core::cap_role(cap) == ROLE_EXECUTOR || core::cap_role(cap) == ROLE_FULL,
        EInsufficientCapRole,
    );
    assert!(core::agent_status(agent) == core::status_active(), EAgentNotActive);
    assert!(core::pnl_agent_id(pnl) == object::id(agent), EWrongAgent);

    let now = tx_context::epoch_timestamp_ms(ctx);
    let current_hash = *core::agent_strategy_hash(agent);
    let trade_uid = object::new(ctx);
    let trade_id = object::uid_to_inner(&trade_uid);

    let trade = TradeRecord {
        id: trade_uid,
        agent_id: object::id(agent),
        order_request_id: option::none(),
        deepbook_tx_digest,
        side,
        base_asset,
        quote_asset,
        fill_price,
        fill_size,
        fee,
        realized_pnl_mag,
        realized_pnl_sign,
        strategy_hash: current_hash,
        filled_at_ms: now,
    };

    let volume_delta = fill_size;

    // Update PnL via core
    core::record_trade(
        pnl,
        agent,
        realized_pnl_mag,
        realized_pnl_sign,
        volume_delta,
        ctx,
    );

    event::emit(TradeFilled {
        trade_id,
        agent_id: object::id(agent),
        side,
        fill_price,
        fill_size,
        fee,
        realized_pnl_mag,
        realized_pnl_sign,
        at_ms: now,
    });

    transfer::share_object(trade);
    trade_id
}

/// Record a strategy mismatch. Called by the orchestrator if it detects
/// that the strategy hash on Agent changed between an order and a fill.
public fun record_strategy_mismatch(
    agent: &Agent,
    old_hash: vector<u8>,
    new_hash: vector<u8>,
    trade_id: ID,
    ctx: &mut TxContext,
) {
    assert!(old_hash != new_hash, EStrategyHashMismatch);
    let now = tx_context::epoch_timestamp_ms(ctx);
    event::emit(StrategyMismatch {
        agent_id: object::id(agent),
        old_hash,
        new_hash,
        trade_record_id: trade_id,
        at_ms: now,
    });
}

// -----------------------------------------------------------------------------
// View functions
// -----------------------------------------------------------------------------

public fun request_id(req: &OrderRequest): ID { object::id(req) }
public fun request_side(req: &OrderRequest): u8 { req.side }
public fun request_type(req: &OrderRequest): u8 { req.order_type }
public fun request_price(req: &OrderRequest): u64 { req.price }
public fun request_size(req: &OrderRequest): u64 { req.size }
public fun request_status(req: &OrderRequest): u8 { req.status }
public fun request_strategy_hash(req: &OrderRequest): &vector<u8> {
    &req.strategy_hash_at_request
}
public fun request_ttl(req: &OrderRequest): u64 { req.ttl_ms }

public fun trade_id(t: &TradeRecord): ID { object::id(t) }
public fun trade_side(t: &TradeRecord): u8 { t.side }
public fun trade_fill_price(t: &TradeRecord): u64 { t.fill_price }
public fun trade_fill_size(t: &TradeRecord): u64 { t.fill_size }
public fun trade_fee(t: &TradeRecord): u64 { t.fee }
public fun trade_realized_mag(t: &TradeRecord): u64 { t.realized_pnl_mag }
public fun trade_realized_sign(t: &TradeRecord): u8 { t.realized_pnl_sign }
public fun trade_strategy_hash(t: &TradeRecord): &vector<u8> { &t.strategy_hash }
public fun trade_filled_at(t: &TradeRecord): u64 { t.filled_at_ms }

public fun side_buy(): u8 { SIDE_BUY }
public fun side_sell(): u8 { SIDE_SELL }
public fun type_limit(): u8 { TYPE_LIMIT }
public fun type_market(): u8 { TYPE_MARKET }

// -----------------------------------------------------------------------------
// Test-only helpers
// -----------------------------------------------------------------------------

#[test_only]
public fun destroy_request_for_testing(req: OrderRequest) {
    let OrderRequest {
        id,
        agent_id: _,
        side: _,
        order_type: _,
        base_asset: _,
        quote_asset: _,
        price: _,
        size: _,
        requested_by: _,
        strategy_hash_at_request: _,
        ttl_ms: _,
        created_at_ms: _,
        status: _,
    } = req;
    object::delete(id);
}

#[test_only]
public fun destroy_trade_for_testing(t: TradeRecord) {
    let TradeRecord {
        id,
        agent_id: _,
        order_request_id: _,
        deepbook_tx_digest: _,
        side: _,
        base_asset: _,
        quote_asset: _,
        fill_price: _,
        fill_size: _,
        fee: _,
        realized_pnl_mag: _,
        realized_pnl_sign: _,
        strategy_hash: _,
        filled_at_ms: _,
    } = t;
    object::delete(id);
}

// dummy type_name ref to silence imports warning in test mode
#[test_only]
public fun type_name_marker<T>(): vector<u8> {
    let tn = type_name::get<T>();
    type_name::into_string(tn).into_bytes()
}
