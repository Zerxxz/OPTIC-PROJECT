// =============================================================================
// Module: optic::predict_adapter
// -----------------------------------------------------------------------------
// OPTIC Predict Adapter: on-chain records of binary-options hedges against
// the agent's spot exposure on DeepBook.
//
// The actual binary-options market primitive on DeepBook is `crates/predict`
// (binary options / strike-grid CFMM). The Move SDK is a TypeScript library,
// not a Move dependency, so we follow the same pattern as deepbook_adapter:
// record the hedge intent and confirmed result, emit events, and let the
// off-chain orchestrator do the actual position submission.
//
// A `PredictHedge` represents a binary bet that the agent's mark price will
// stay within a band over a horizon — used to cap tail risk on the spot book.
// =============================================================================

module optic::predict_adapter;

use sui::event;
use sui::object::{Self, ID, UID};
use sui::transfer;
use sui::tx_context::{Self, TxContext};
use optic::core::{Self, Agent, AgentCap};

// -----------------------------------------------------------------------------
// Error codes
// -----------------------------------------------------------------------------
const EWrongAgent: u64 = 400;
const EWrongCap: u64 = 401;
const EInsufficientCapRole: u64 = 402;
const EAgentNotActive: u64 = 403;
const EInvalidSide: u64 = 404;
const EInvalidSize: u64 = 405;
const EHedgeAlreadySettled: u64 = 406;

// -----------------------------------------------------------------------------
// Roles
// -----------------------------------------------------------------------------
const ROLE_FULL: u8 = 0;
const ROLE_RISK: u8 = 2;
const ROLE_EXECUTOR: u8 = 3;

// -----------------------------------------------------------------------------
// Hedge side & status
// -----------------------------------------------------------------------------
const SIDE_YES: u8 = 0;  // bet price will close ABOVE strike
const SIDE_NO: u8 = 1;   // bet price will close BELOW strike

const STATUS_OPEN: u8 = 0;
const STATUS_WON: u8 = 1;
const STATUS_LOST: u8 = 2;
const STATUS_CANCELLED: u8 = 3;

// -----------------------------------------------------------------------------
// Objects
// -----------------------------------------------------------------------------

/// A PredictHedge — a single binary-options position opened by the risk
/// agent to hedge a spot exposure.
public struct PredictHedge has key, store {
    id: UID,
    agent_id: ID,
    /// 0 = YES, 1 = NO. (Predict uses 0/1 internally too.)
    side: u8,
    /// Underlying asset, e.g. b"SUI".
    underlying: vector<u8>,
    /// Strike price in quote units (1e6 USDC).
    strike_price: u64,
    /// Position size in quote units (collateral).
    size: u64,
    /// Open timestamp.
    opened_at_ms: u64,
    /// Expiry timestamp (the orchestrator fills this on open).
    expires_at_ms: u64,
    /// 0 = open, 1 = won, 2 = lost, 3 = cancelled.
    status: u8,
    /// Cap holder who opened the hedge.
    opened_by: address,
    /// Optional link back to a TradeRecord on deepbook_adapter.
    hedging_trade_id: Option<ID>,
    /// DeepBook Predict tx digest (32-byte hash).
    predict_tx_digest: Option<vector<u8>>,
    /// Final payout in quote units (set on settlement).
    payout: u64,
    /// Realized PnL delta from this hedge, signed (magnitude + sign).
    realized_pnl_mag: u64,
    realized_pnl_sign: u8,
}

// -----------------------------------------------------------------------------
// Events
// -----------------------------------------------------------------------------

public struct HedgeOpened has copy, drop {
    hedge_id: ID,
    agent_id: ID,
    side: u8,
    underlying: vector<u8>,
    strike_price: u64,
    size: u64,
    expires_at_ms: u64,
    opened_by: address,
    at_ms: u64,
}

public struct HedgeSettled has copy, drop {
    hedge_id: ID,
    agent_id: ID,
    status: u8,
    payout: u64,
    realized_pnl_mag: u64,
    realized_pnl_sign: u8,
    at_ms: u64,
}

// -----------------------------------------------------------------------------
// Open
// -----------------------------------------------------------------------------

/// Open a new Predict hedge. The risk or full cap can open hedges.
public fun open_hedge(
    agent: &Agent,
    cap: &AgentCap,
    side: u8,
    underlying: vector<u8>,
    strike_price: u64,
    size: u64,
    expires_at_ms: u64,
    hedging_trade_id: Option<ID>,
    predict_tx_digest: Option<vector<u8>>,
    ctx: &mut TxContext,
): ID {
    // Auth
    assert!(core::cap_agent_id(cap) == object::id(agent), EWrongCap);
    assert!(
        core::cap_role(cap) == ROLE_RISK ||
        core::cap_role(cap) == ROLE_FULL ||
        core::cap_role(cap) == ROLE_EXECUTOR,
        EInsufficientCapRole,
    );
    assert!(core::agent_status(agent) == core::status_active(), EAgentNotActive);
    assert!(side == SIDE_YES || side == SIDE_NO, EInvalidSide);
    assert!(size > 0, EInvalidSize);
    assert!(strike_price > 0, EInvalidSize);

    let now = tx_context::epoch_timestamp_ms(ctx);
    let uid = object::new(ctx);
    let hedge_id = object::uid_to_inner(&uid);

    let hedge = PredictHedge {
        id: uid,
        agent_id: object::id(agent),
        side,
        underlying,
        strike_price,
        size,
        opened_at_ms: now,
        expires_at_ms,
        status: STATUS_OPEN,
        opened_by: tx_context::sender(ctx),
        hedging_trade_id,
        predict_tx_digest,
        payout: 0,
        realized_pnl_mag: 0,
        realized_pnl_sign: 0,
    };

    event::emit(HedgeOpened {
        hedge_id,
        agent_id: object::id(agent),
        side,
        underlying: hedge.underlying,
        strike_price,
        size,
        expires_at_ms,
        opened_by: tx_context::sender(ctx),
        at_ms: now,
    });

    transfer::share_object(hedge);
    hedge_id
}

// -----------------------------------------------------------------------------
// Settle
// -----------------------------------------------------------------------------

/// Settle a hedge. Called by the risk or full cap holder after expiry.
/// `won` = true means YES paid out (or NO for SIDE_NO). `payout` is the
/// gross amount received in quote units.
public fun settle_hedge(
    agent: &Agent,
    cap: &AgentCap,
    hedge: &mut PredictHedge,
    won: bool,
    payout: u64,
    ctx: &mut TxContext,
) {
    assert!(core::cap_agent_id(cap) == object::id(agent), EWrongCap);
    assert!(
        core::cap_role(cap) == ROLE_RISK ||
        core::cap_role(cap) == ROLE_FULL,
        EInsufficientCapRole,
    );
    assert!(core::agent_status(agent) == core::status_active(), EAgentNotActive);
    assert!(hedge.agent_id == object::id(agent), EWrongAgent);
    assert!(hedge.status == STATUS_OPEN, EHedgeAlreadySettled);

    let now = tx_context::epoch_timestamp_ms(ctx);
    if (won) {
        hedge.status = STATUS_WON;
        hedge.payout = payout;
        // PnL = payout - size (signed; winning usually = positive)
        if (payout >= hedge.size) {
            hedge.realized_pnl_mag = payout - hedge.size;
            hedge.realized_pnl_sign = 0; // POS
        } else {
            hedge.realized_pnl_mag = hedge.size - payout;
            hedge.realized_pnl_sign = 1; // NEG (lost on premium)
        }
    } else {
        hedge.status = STATUS_LOST;
        hedge.payout = 0;
        hedge.realized_pnl_mag = hedge.size;
        hedge.realized_pnl_sign = 1; // NEG
    };

    event::emit(HedgeSettled {
        hedge_id: object::id(hedge),
        agent_id: object::id(agent),
        status: hedge.status,
        payout,
        realized_pnl_mag: hedge.realized_pnl_mag,
        realized_pnl_sign: hedge.realized_pnl_sign,
        at_ms: now,
    });
}

/// Cancel an open hedge (e.g. expiry imminent, capital reallocation).
public fun cancel_hedge(
    agent: &Agent,
    cap: &AgentCap,
    hedge: &mut PredictHedge,
    ctx: &mut TxContext,
) {
    assert!(core::cap_agent_id(cap) == object::id(agent), EWrongCap);
    assert!(
        core::cap_role(cap) == ROLE_RISK ||
        core::cap_role(cap) == ROLE_FULL ||
        core::cap_role(cap) == ROLE_EXECUTOR,
        EInsufficientCapRole,
    );
    assert!(hedge.agent_id == object::id(agent), EWrongAgent);
    assert!(hedge.status == STATUS_OPEN, EHedgeAlreadySettled);

    hedge.status = STATUS_CANCELLED;
    let now = tx_context::epoch_timestamp_ms(ctx);
    event::emit(HedgeSettled {
        hedge_id: object::id(hedge),
        agent_id: object::id(agent),
        status: hedge.status,
        payout: 0,
        realized_pnl_mag: 0,
        realized_pnl_sign: 0,
        at_ms: now,
    });
}

// -----------------------------------------------------------------------------
// View functions
// -----------------------------------------------------------------------------

public fun hedge_id(h: &PredictHedge): ID { object::id(h) }
public fun hedge_side(h: &PredictHedge): u8 { h.side }
public fun hedge_underlying(h: &PredictHedge): &vector<u8> { &h.underlying }
public fun hedge_strike(h: &PredictHedge): u64 { h.strike_price }
public fun hedge_size(h: &PredictHedge): u64 { h.size }
public fun hedge_status(h: &PredictHedge): u8 { h.status }
public fun hedge_opened_at(h: &PredictHedge): u64 { h.opened_at_ms }
public fun hedge_expires_at(h: &PredictHedge): u64 { h.expires_at_ms }
public fun hedge_payout(h: &PredictHedge): u64 { h.payout }
public fun hedge_pnl_mag(h: &PredictHedge): u64 { h.realized_pnl_mag }
public fun hedge_pnl_sign(h: &PredictHedge): u8 { h.realized_pnl_sign }
public fun hedge_opened_by(h: &PredictHedge): address { h.opened_by }
public fun hedge_agent_id(h: &PredictHedge): ID { h.agent_id }

public fun side_yes(): u8 { SIDE_YES }
public fun side_no(): u8 { SIDE_NO }
public fun status_open(): u8 { STATUS_OPEN }
public fun status_won(): u8 { STATUS_WON }
public fun status_lost(): u8 { STATUS_LOST }
public fun status_cancelled(): u8 { STATUS_CANCELLED }

// -----------------------------------------------------------------------------
// Test-only helpers
// -----------------------------------------------------------------------------

#[test_only]
public fun destroy_hedge_for_testing(h: PredictHedge) {
    let PredictHedge {
        id,
        agent_id: _,
        side: _,
        underlying: _,
        strike_price: _,
        size: _,
        opened_at_ms: _,
        expires_at_ms: _,
        status: _,
        opened_by: _,
        hedging_trade_id: _,
        predict_tx_digest: _,
        payout: _,
        realized_pnl_mag: _,
        realized_pnl_sign: _,
    } = h;
    object::delete(id);
}
