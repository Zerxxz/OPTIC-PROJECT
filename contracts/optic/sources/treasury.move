// =============================================================================
// Module: optic::treasury
// -----------------------------------------------------------------------------
// OPTIC Treasury: holds the actual coin balance for an Agent.
//
// Design principles:
//   1. The Treasury is a SHARED object so the AgentCap holder (orchestrator)
//      can deposit / withdraw on behalf of the user, while the OWNER retains
//      the ability to withdraw everything at any time (escape hatch).
//   2. The Treasury uses a generic Balance<T> so it works for any coin type
//      (USDC, USDT, native SUI for gas, etc.).
//   3. Every high-value action emits an event so the public audit page can
//      reconstruct the full money flow from chain data alone.
//   4. Withdrawals by the agent are subject to per-tx and per-day caps
//      enforced by the risk parameters stored on the Agent object.
// =============================================================================

module optic::treasury;

use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin};
use sui::event;
use sui::object::{Self, ID, UID};
use sui::transfer;
use sui::tx_context::{Self, TxContext};
use optic::core::{Self, Agent, AgentCap};

// -----------------------------------------------------------------------------
// Error codes
// -----------------------------------------------------------------------------
const ENotOwner: u64 = 100;
const EWrongAgent: u64 = 101;
const EWrongCap: u64 = 102;
const EInsufficientBalance: u64 = 103;
const EExceedsPositionLimit: u64 = 104;
const EExceedsDailyLimit: u64 = 105;
const EAgentNotActive: u64 = 106;
const EInsufficientCapRole: u64 = 107;
const ECoinTypeMismatch: u64 = 108;

// -----------------------------------------------------------------------------
// Cap role constants (must match core.move)
// -----------------------------------------------------------------------------
const ROLE_FULL: u8 = 0;
const ROLE_QUANT: u8 = 1;
const ROLE_RISK: u8 = 2;
const ROLE_EXECUTOR: u8 = 3;

// -----------------------------------------------------------------------------
// Objects
// -----------------------------------------------------------------------------

/// The Treasury — shared object that holds the coin balance for an Agent.
/// Generic over coin type T so each agent can configure its own settlement
/// currency. In practice every agent on mainnet will use USDC.
public struct Treasury<phantom T> has key, store {
    id: UID,
    /// The Agent this Treasury belongs to (1:1 relationship).
    agent_id: ID,
    /// Current balance.
    balance: Balance<T>,
    /// Per-transaction withdrawal cap (in T's smallest unit, e.g. micro-USDC).
    /// 0 = no cap (still bounded by total balance).
    per_tx_cap: u64,
    /// Total withdrawn since the last daily reset (ms timestamp).
    /// Owner or `pause` resets it manually if needed.
    daily_withdrawn: u64,
    /// Last time daily_withdrawn was reset (ms since epoch).
    last_reset_ms: u64,
    /// Lifetime deposit total.
    lifetime_deposited: u64,
    /// Lifetime withdrawal total.
    lifetime_withdrawn: u64,
    /// Creation timestamp.
    created_at_ms: u64,
}

// -----------------------------------------------------------------------------
// Events
// -----------------------------------------------------------------------------

public struct TreasuryCreated has copy, drop {
    treasury_id: ID,
    agent_id: ID,
    owner: address,
    coin_type: vector<u8>,
    at_ms: u64,
}

public struct Deposited has copy, drop {
    treasury_id: ID,
    agent_id: ID,
    by: address,
    amount: u64,
    new_balance: u64,
    lifetime_deposited: u64,
    at_ms: u64,
}

public struct Withdrawn has copy, drop {
    treasury_id: ID,
    agent_id: ID,
    by: address,
    amount: u64,
    new_balance: u64,
    lifetime_withdrawn: u64,
    daily_withdrawn: u64,
    at_ms: u64,
}

// -----------------------------------------------------------------------------
// Constructor
// -----------------------------------------------------------------------------

/// Create a new empty Treasury for a given Agent. The Treasury is transferred
/// as a shared object so the off-chain orchestrator (cap holder) can interact
/// with it. The owner can always withdraw their full balance.
public fun create_treasury<T>(
    agent: &Agent,
    per_tx_cap: u64,
    ctx: &mut TxContext,
): ID {
    assert!(tx_context::sender(ctx) == core::agent_owner(agent), ENotOwner);
    assert!(core::agent_status(agent) == core::status_active(), EAgentNotActive);

    let treasury_uid = object::new(ctx);
    let treasury_id = object::uid_to_inner(&treasury_uid);
    let now = tx_context::epoch_timestamp_ms(ctx);

    let treasury = Treasury<T> {
        id: treasury_uid,
        agent_id: object::id(agent),
        balance: balance::zero<T>(),
        per_tx_cap,
        daily_withdrawn: 0,
        last_reset_ms: now,
        lifetime_deposited: 0,
        lifetime_withdrawn: 0,
        created_at_ms: now,
    };

    event::emit(TreasuryCreated {
        treasury_id,
        agent_id: object::id(agent),
        owner: tx_context::sender(ctx),
        coin_type: type_name_coin<T>(),
        at_ms: now,
    });

    transfer::share_object(treasury);
    treasury_id
}

/// Helper to embed the coin type name in the event. We use a simple ASCII
/// string so off-chain consumers can decode without BCS roundtrip.
fun type_name_coin<T>(): vector<u8> {
    // type_name is too expensive to print verbatim; we leave a marker.
    // Off-chain indexers can match by coin metadata from the Sui coin standard.
    b"coin<T>"
}

// -----------------------------------------------------------------------------
// Deposits
// -----------------------------------------------------------------------------

/// Anyone can deposit into a Treasury (this is a public good — no auth
/// required, just like a public pool). The Agent status must be active;
/// paused/liquidated agents reject new deposits so no one funds a dead bot.
public fun deposit<T>(
    treasury: &mut Treasury<T>,
    agent: &Agent,
    coin: Coin<T>,
    ctx: &mut TxContext,
) {
    assert!(treasury.agent_id == object::id(agent), EWrongAgent);
    assert!(core::agent_status(agent) == core::status_active(), EAgentNotActive);

    let amount = coin::value(&coin);
    let new_balance = balance::join(&mut treasury.balance, coin::into_balance(coin));
    treasury.lifetime_deposited = treasury.lifetime_deposited + amount;
    let now = tx_context::epoch_timestamp_ms(ctx);

    event::emit(Deposited {
        treasury_id: object::id(treasury),
        agent_id: object::id(agent),
        by: tx_context::sender(ctx),
        amount,
        new_balance,
        lifetime_deposited: treasury.lifetime_deposited,
        at_ms: now,
    });
}

// -----------------------------------------------------------------------------
// Withdrawals
// -----------------------------------------------------------------------------

/// Owner can withdraw any amount up to balance, no cap. This is the
/// escape hatch — owner sovereignty over capital is absolute.
public fun withdraw_by_owner<T>(
    treasury: &mut Treasury<T>,
    agent: &Agent,
    amount: u64,
    ctx: &mut TxContext,
): Coin<T> {
    assert!(tx_context::sender(ctx) == core::agent_owner(agent), ENotOwner);
    assert!(treasury.agent_id == object::id(agent), EWrongAgent);
    assert!(amount <= balance::value(&treasury.balance), EInsufficientBalance);

    // Reset daily counter if 24h has passed.
    maybe_reset_daily(treasury, ctx);

    let taken = coin::take(&mut treasury.balance, amount, ctx);
    treasury.lifetime_withdrawn = treasury.lifetime_withdrawn + amount;
    treasury.daily_withdrawn = treasury.daily_withdrawn + amount;

    event::emit(Withdrawn {
        treasury_id: object::id(treasury),
        agent_id: object::id(agent),
        by: tx_context::sender(ctx),
        amount,
        new_balance: balance::value(&treasury.balance),
        lifetime_withdrawn: treasury.lifetime_withdrawn,
        daily_withdrawn: treasury.daily_withdrawn,
        at_ms: tx_context::epoch_timestamp_ms(ctx),
    });

    taken
}

/// Executor-cap holder can withdraw up to per_tx_cap, and only up to the
/// Agent's `max_position_size_usd` (interpreted as units of T for the MVP).
/// The risk params on the Agent are the second line of defense.
public fun withdraw_by_cap<T>(
    treasury: &mut Treasury<T>,
    agent: &mut Agent,
    cap: &AgentCap,
    amount: u64,
    ctx: &mut TxContext,
): Coin<T> {
    // Auth checks
    assert!(treasury.agent_id == object::id(agent), EWrongAgent);
    assert!(core::cap_agent_id(cap) == object::id(agent), EWrongCap);
    assert!(core::cap_role(cap) == ROLE_EXECUTOR || core::cap_role(cap) == ROLE_FULL,
        EInsufficientCapRole);
    assert!(core::agent_status(agent) == core::status_active(), EAgentNotActive);

    // Risk checks
    assert!(amount <= balance::value(&treasury.balance), EInsufficientBalance);
    assert!(amount <= treasury.per_tx_cap, EExceedsPositionLimit);
    assert!(amount <= core::agent_max_position(agent), EExceedsPositionLimit);

    // Daily limit
    maybe_reset_daily(treasury, ctx);
    assert!(
        treasury.daily_withdrawn + amount <= core::agent_max_daily_loss(agent),
        EExceedsDailyLimit,
    );

    let taken = coin::take(&mut treasury.balance, amount, ctx);
    treasury.lifetime_withdrawn = treasury.lifetime_withdrawn + amount;
    treasury.daily_withdrawn = treasury.daily_withdrawn + amount;

    event::emit(Withdrawn {
        treasury_id: object::id(treasury),
        agent_id: object::id(agent),
        by: tx_context::sender(ctx),
        amount,
        new_balance: balance::value(&treasury.balance),
        lifetime_withdrawn: treasury.lifetime_withdrawn,
        daily_withdrawn: treasury.daily_withdrawn,
        at_ms: tx_context::epoch_timestamp_ms(ctx),
    });

    taken
}

/// Risk-cap holder can withdraw funds explicitly to hedge (e.g. move USDC
/// to a Predict position). Same caps apply.
public fun withdraw_for_risk<T>(
    treasury: &mut Treasury<T>,
    agent: &mut Agent,
    cap: &AgentCap,
    amount: u64,
    ctx: &mut TxContext,
): Coin<T> {
    assert!(treasury.agent_id == object::id(agent), EWrongAgent);
    assert!(core::cap_agent_id(cap) == object::id(agent), EWrongCap);
    assert!(core::cap_role(cap) == ROLE_RISK || core::cap_role(cap) == ROLE_FULL,
        EInsufficientCapRole);
    assert!(core::agent_status(agent) == core::status_active(), EAgentNotActive);

    assert!(amount <= balance::value(&treasury.balance), EInsufficientBalance);
    assert!(amount <= treasury.per_tx_cap, EExceedsPositionLimit);
    assert!(amount <= core::agent_max_position(agent), EExceedsPositionLimit);

    maybe_reset_daily(treasury, ctx);
    assert!(
        treasury.daily_withdrawn + amount <= core::agent_max_daily_loss(agent),
        EExceedsDailyLimit,
    );

    let taken = coin::take(&mut treasury.balance, amount, ctx);
    treasury.lifetime_withdrawn = treasury.lifetime_withdrawn + amount;
    treasury.daily_withdrawn = treasury.daily_withdrawn + amount;

    event::emit(Withdrawn {
        treasury_id: object::id(treasury),
        agent_id: object::id(agent),
        by: tx_context::sender(ctx),
        amount,
        new_balance: balance::value(&treasury.balance),
        lifetime_withdrawn: treasury.lifetime_withdrawn,
        daily_withdrawn: treasury.daily_withdrawn,
        at_ms: tx_context::epoch_timestamp_ms(ctx),
    });

    taken
}

// -----------------------------------------------------------------------------
// Deposit return (used after a trade cycle to put profits back into the pool)
// -----------------------------------------------------------------------------

/// Anyone holding the coin can return it to a treasury (e.g. an executor
/// returning proceeds from a closed DeepBook position). No cap — proceeds
/// are always welcome.
public fun deposit_return<T>(
    treasury: &mut Treasury<T>,
    agent: &Agent,
    coin: Coin<T>,
    ctx: &mut TxContext,
) {
    deposit(treasury, agent, coin, ctx);
}

// -----------------------------------------------------------------------------
// Daily reset helper
// -----------------------------------------------------------------------------

fun maybe_reset_daily<T>(treasury: &mut Treasury<T>, ctx: &mut TxContext) {
    let now = tx_context::epoch_timestamp_ms(ctx);
    if (now > treasury.last_reset_ms + 86_400_000) {
        treasury.daily_withdrawn = 0;
        treasury.last_reset_ms = now;
    }
}

// -----------------------------------------------------------------------------
// Admin
// -----------------------------------------------------------------------------

/// Owner can change the per-tx cap. Useful for scaling up after a track record.
public fun set_per_tx_cap<T>(
    treasury: &mut Treasury<T>,
    agent: &Agent,
    new_cap: u64,
    ctx: &mut TxContext,
) {
    assert!(tx_context::sender(ctx) == core::agent_owner(agent), ENotOwner);
    assert!(treasury.agent_id == object::id(agent), EWrongAgent);
    treasury.per_tx_cap = new_cap;
}

// -----------------------------------------------------------------------------
// View functions
// -----------------------------------------------------------------------------

public fun balance<T>(treasury: &Treasury<T>): u64 { balance::value(&treasury.balance) }
public fun agent_id<T>(treasury: &Treasury<T>): ID { treasury.agent_id }
public fun per_tx_cap<T>(treasury: &Treasury<T>): u64 { treasury.per_tx_cap }
public fun daily_withdrawn<T>(treasury: &Treasury<T>): u64 { treasury.daily_withdrawn }
public fun lifetime_deposited<T>(treasury: &Treasury<T>): u64 { treasury.lifetime_deposited }
public fun lifetime_withdrawn<T>(treasury: &Treasury<T>): u64 { treasury.lifetime_withdrawn }
public fun last_reset_ms<T>(treasury: &Treasury<T>): u64 { treasury.last_reset_ms }
public fun created_at_ms<T>(treasury: &Treasury<T>): u64 { treasury.created_at_ms }

// -----------------------------------------------------------------------------
// Test-only helpers
// -----------------------------------------------------------------------------

#[test_only]
public fun destroy_treasury_for_testing<T>(treasury: Treasury<T>) {
    let Treasury {
        id,
        agent_id: _,
        balance,
        per_tx_cap: _,
        daily_withdrawn: _,
        last_reset_ms: _,
        lifetime_deposited: _,
        lifetime_withdrawn: _,
        created_at_ms: _,
    } = treasury;
    balance::destroy_for_testing(balance);
    object::delete(id);
}

#[test_only]
public fun role_full(): u8 { ROLE_FULL }
#[test_only]
public fun role_executor(): u8 { ROLE_EXECUTOR }
#[test_only]
public fun role_risk(): u8 { ROLE_RISK }
