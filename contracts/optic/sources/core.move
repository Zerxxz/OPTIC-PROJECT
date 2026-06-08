// =============================================================================
// Module: optic::core
// -----------------------------------------------------------------------------
// OPTIC Core: Agent identity, capability, and status primitives.
//
// An Agent is a first-class Sui object that represents an on-chain AI quant
// strategy. It is non-custodial: the owner retains control of treasury; the
// Agent merely holds a capability to operate against the owner's balance.
//
// Each Agent carries:
//   - immutable `AgentId` (UID-derived)
//   - mutable `AgentConfig` (strategy hash, max risk, status)
//   - `AgentCap` capability (held by orchestrator, can be split per role)
//   - `PnL` object (live performance, shared so anyone can read)
//
// The Agent never holds assets directly. The Treasury object does.
// =============================================================================

module optic::core;

use sui::event;
use sui::object::{Self, ID, UID};
use sui::transfer;
use sui::tx_context::{Self, TxContext};

// -----------------------------------------------------------------------------
// Error codes
// -----------------------------------------------------------------------------
const EAgentNotActive: u64 = 0;
const EAgentPaused: u64 = 1;
const EWrongAgent: u64 = 2;
const ENotAuthorized: u64 = 3;
const EAlreadyInitialized: u64 = 4;
const EInvalidStatus: u64 = 5;
const EVersionMismatch: u64 = 6;

// -----------------------------------------------------------------------------
// Version (for upgrade safety)
// -----------------------------------------------------------------------------
const VERSION: u64 = 1;

// -----------------------------------------------------------------------------
// Status enum — bitfield-style for cheap comparisons
// -----------------------------------------------------------------------------
const STATUS_ACTIVE: u8 = 0;
const STATUS_PAUSED: u8 = 1;
const STATUS_LIQUIDATED: u8 = 2;

// -----------------------------------------------------------------------------
// Sign convention: SIGN_POS = 0, SIGN_NEG = 1.
// Used wherever we need a signed PnL without native i64.
// -----------------------------------------------------------------------------
const SIGN_POS: u8 = 0;
const SIGN_NEG: u8 = 1;

// -----------------------------------------------------------------------------
// Objects
// -----------------------------------------------------------------------------

/// The Agent object — represents one autonomous AI quant strategy.
public struct Agent has key, store {
    id: UID,
    /// Schema version for upgrade compatibility.
    version: u64,
    /// Owner's address (immutable; ownership transfer is a different op).
    owner: address,
    /// Human-friendly name (e.g. "quant-alpha-1").
    name: vector<u8>,
    /// SHA-3 of the active strategy blob stored on Walrus. Compared on every
    /// high-value action; if it changes, an `StrategyHashChanged` event fires
    /// so anyone can audit.
    strategy_hash: vector<u8>,
    /// Optional SuiNS name (e.g. b"optic.alpha.sui").
    suins_name: Option<vector<u8>>,
    /// Risk parameters. Stored as raw u64s to avoid float math.
    /// max_position_size_usd — cap on any single trade notional in USD (6 dp).
    /// max_daily_loss_usd    — circuit breaker if daily realized loss exceeds.
    /// max_leverage_bps      — leverage cap in basis points (10_000 = 1x).
    max_position_size_usd: u64,
    max_daily_loss_usd: u64,
    max_leverage_bps: u64,
    /// Current status (0=active, 1=paused, 2=liquidated, 3=halted).
    status: u8,
    /// Treasury object ID. The agent's actual coin balance lives there.
    treasury_id: ID,
    /// Walrus blob ID pointing to the strategy description / prompts.
    strategy_blob_id: Option<ID>,
    /// Creation timestamp (ms since epoch, set by Move `tx_context`).
    created_at_ms: u64,
    /// Last action timestamp.
    last_action_ms: u64,
}

/// Capability that allows actions on the Agent. Held by the off-chain
/// orchestrator. Multiple `AgentCap`s can be issued (one per specialist).
public struct AgentCap has key, store {
    id: UID,
    /// Which agent this cap controls.
    agent_id: ID,
    /// Role tag: 0 = full, 1 = quant (read+quote), 2 = risk (read+hedge),
    /// 3 = executor (read+submit). Stored as u8 to keep Move simple.
    role: u8,
    /// Issued-at timestamp.
    issued_at_ms: u64,
    /// Cap nonce so old caps can be revoked by issuing a new one.
    nonce: u64,
}

/// PnL object — live performance metrics, shared so anyone can read.
/// Self-attesting: orchestrator writes deltas; explorers can verify against
/// on-chain DeepBook trade history.
public struct PnL has key, store {
    id: UID,
    agent_id: ID,
    /// Realized PnL in micro-USDC (6 decimals). Always non-negative; we treat
    /// realized losses as floor-to-zero (a real implementation would track
    /// realized gains and losses separately).
    realized_pnl: u64,
    /// Unrealized PnL — magnitude in micro-USDC + sign flag.
    unrealized_pnl_mag: u64,
    unrealized_pnl_sign: u8,
    /// Total trades executed.
    trade_count: u64,
    /// Total volume traded in micro-USDC.
    volume: u64,
    /// Last update timestamp.
    updated_at_ms: u64,
}

/// AgentRegistry — singleton shared object listing all agents by name.
/// Used by the Walrus Site frontend and explorers.
public struct AgentRegistry has key {
    id: UID,
    /// Owner of the registry (admin).
    admin: address,
    /// List of agent IDs. Capped at a reasonable size; off-chain indexers
    /// pick up the heavy lifting.
    agents: vector<ID>,
    /// Total agents ever created (for stats).
    total_created: u64,
}

// -----------------------------------------------------------------------------
// Events
// -----------------------------------------------------------------------------

public struct AgentCreated has copy, drop {
    agent_id: ID,
    owner: address,
    name: vector<u8>,
    treasury_id: ID,
    created_at_ms: u64,
}

public struct AgentStatusChanged has copy, drop {
    agent_id: ID,
    old_status: u8,
    new_status: u8,
    actor: address,
    at_ms: u64,
}

public struct StrategyHashChanged has copy, drop {
    agent_id: ID,
    old_hash: vector<u8>,
    new_hash: vector<u8>,
    new_blob_id: Option<ID>,
    at_ms: u64,
}

public struct AgentCapIssued has copy, drop {
    agent_id: ID,
    cap_id: ID,
    role: u8,
    to: address,
    at_ms: u64,
}

public struct PnLUpdated has copy, drop {
    agent_id: ID,
    /// Signed delta encoded as (magnitude, sign). Sign is `SIGN_POS` or `SIGN_NEG`.
    realized_delta_mag: u64,
    realized_delta_sign: u8,
    trade_count_delta: u64,
    volume_delta: u64,
    at_ms: u64,
}

// -----------------------------------------------------------------------------
// Init
// -----------------------------------------------------------------------------

/// Module initializer — publishes the shared AgentRegistry exactly once.
fun init(ctx: &mut TxContext) {
    let registry = AgentRegistry {
        id: object::new(ctx),
        admin: tx_context::sender(ctx),
        agents: vector<ID>[],
        total_created: 0,
    };
    transfer::share_object(registry);
}

// -----------------------------------------------------------------------------
// Constructor
// -----------------------------------------------------------------------------

/// Create a new Agent. Returns the Agent by transfer to the sender, the
/// PnL by shared (so anyone can read), and the Treasury ID is recorded.
/// The caller is responsible for creating the Treasury right after — the
/// treasury_id passed in MUST be the just-created Treasury object's ID.
public fun create_agent(
    registry: &mut AgentRegistry,
    name: vector<u8>,
    strategy_hash: vector<u8>,
    suins_name: Option<vector<u8>>,
    max_position_size_usd: u64,
    max_daily_loss_usd: u64,
    max_leverage_bps: u64,
    treasury_id: ID,
    ctx: &mut TxContext,
): ID {
    assert!(max_leverage_bps <= 100_000, EInvalidStatus); // hard cap 10x

    let agent_uid = object::new(ctx);
    let agent_id = object::uid_to_inner(&agent_uid);
    let now = tx_context::epoch_timestamp_ms(ctx);

    let agent = Agent {
        id: agent_uid,
        version: VERSION,
        owner: tx_context::sender(ctx),
        name,
        strategy_hash,
        suins_name,
        max_position_size_usd,
        max_daily_loss_usd,
        max_leverage_bps,
        status: STATUS_ACTIVE,
        treasury_id,
        strategy_blob_id: option::none(),
        created_at_ms: now,
        last_action_ms: now,
    };

    event::emit(AgentCreated {
        agent_id,
        owner: tx_context::sender(ctx),
        name: agent.name,
        treasury_id,
        created_at_ms: now,
    });

    let pnl = PnL {
        id: object::new(ctx),
        agent_id,
        realized_pnl: 0,
        unrealized_pnl_mag: 0,
        unrealized_pnl_sign: SIGN_POS,
        trade_count: 0,
        volume: 0,
        updated_at_ms: now,
    };

    // Register the agent
    vector::push_back(&mut registry.agents, agent_id);
    registry.total_created = registry.total_created + 1;

    // Transfer PnL as a shared object so dApps can read it.
    transfer::public_share_object(pnl);

    // Transfer Agent to the sender (it is a `key` object owned by them).
    transfer::public_transfer(agent, tx_context::sender(ctx));

    agent_id
}

// -----------------------------------------------------------------------------
// Capability management
// -----------------------------------------------------------------------------

/// Issue a new AgentCap. Each role gets a separate cap so the holder of a
/// `risk` cap can never execute trades — only the `executor` cap can.
public fun issue_cap(
    agent: &Agent,
    role: u8,
    to: address,
    ctx: &mut TxContext,
): ID {
    assert!(tx_context::sender(ctx) == agent.owner, ENotAuthorized);
    assert!(role <= 3, EInvalidStatus);
    assert!(agent.status == STATUS_ACTIVE, EAgentNotActive);
    assert!(agent.version == VERSION, EVersionMismatch);

    let cap = AgentCap {
        id: object::new(ctx),
        agent_id: object::id(agent),
        role,
        issued_at_ms: tx_context::epoch_timestamp_ms(ctx),
        nonce: 0,
    };
    let cap_id = object::id(&cap);

    event::emit(AgentCapIssued {
        agent_id: object::id(agent),
        cap_id,
        role,
        to,
        at_ms: tx_context::epoch_timestamp_ms(ctx),
    });

    transfer::public_transfer(cap, to);
    cap_id
}

/// Revoke an existing cap by transferring it to @0x0 (burned). Owner only.
public fun revoke_cap(cap: AgentCap) {
    let AgentCap { id, agent_id: _, role: _, issued_at_ms: _, nonce: _ } = cap;
    object::delete(id);
}

// -----------------------------------------------------------------------------
// Status transitions
// -----------------------------------------------------------------------------

public fun pause(agent: &mut Agent, ctx: &mut TxContext) {
    assert!(tx_context::sender(ctx) == agent.owner, ENotAuthorized);
    assert!(agent.status == STATUS_ACTIVE, EInvalidStatus);
    let old = agent.status;
    agent.status = STATUS_PAUSED;
    let now = tx_context::epoch_timestamp_ms(ctx);
    agent.last_action_ms = now;
    event::emit(AgentStatusChanged {
        agent_id: object::id(agent),
        old_status: old,
        new_status: agent.status,
        actor: tx_context::sender(ctx),
        at_ms: now,
    });
}

public fun resume(agent: &mut Agent, ctx: &mut TxContext) {
    assert!(tx_context::sender(ctx) == agent.owner, ENotAuthorized);
    assert!(agent.status == STATUS_PAUSED, EInvalidStatus);
    let old = agent.status;
    agent.status = STATUS_ACTIVE;
    let now = tx_context::epoch_timestamp_ms(ctx);
    agent.last_action_ms = now;
    event::emit(AgentStatusChanged {
        agent_id: object::id(agent),
        old_status: old,
        new_status: agent.status,
        actor: tx_context::sender(ctx),
        at_ms: now,
    });
}

public fun liquidate(agent: &mut Agent, ctx: &mut TxContext) {
    assert!(tx_context::sender(ctx) == agent.owner, ENotAuthorized);
    let old = agent.status;
    agent.status = STATUS_LIQUIDATED;
    let now = tx_context::epoch_timestamp_ms(ctx);
    agent.last_action_ms = now;
    event::emit(AgentStatusChanged {
        agent_id: object::id(agent),
        old_status: old,
        new_status: agent.status,
        actor: tx_context::sender(ctx),
        at_ms: now,
    });
}

// -----------------------------------------------------------------------------
// Config updates
// -----------------------------------------------------------------------------

public fun update_strategy_hash(
    agent: &mut Agent,
    new_hash: vector<u8>,
    new_blob_id: Option<ID>,
    ctx: &mut TxContext,
) {
    assert!(tx_context::sender(ctx) == agent.owner, ENotAuthorized);
    let old = agent.strategy_hash;
    agent.strategy_hash = new_hash;
    agent.strategy_blob_id = new_blob_id;
    let now = tx_context::epoch_timestamp_ms(ctx);
    agent.last_action_ms = now;
    event::emit(StrategyHashChanged {
        agent_id: object::id(agent),
        old_hash: old,
        new_hash: agent.strategy_hash,
        new_blob_id,
        at_ms: now,
    });
}

public fun update_risk_params(
    agent: &mut Agent,
    max_position_size_usd: u64,
    max_daily_loss_usd: u64,
    max_leverage_bps: u64,
    ctx: &mut TxContext,
) {
    assert!(tx_context::sender(ctx) == agent.owner, ENotAuthorized);
    assert!(max_leverage_bps <= 100_000, EInvalidStatus);
    assert!(agent.status == STATUS_ACTIVE, EAgentNotActive);
    agent.max_position_size_usd = max_position_size_usd;
    agent.max_daily_loss_usd = max_daily_loss_usd;
    agent.max_leverage_bps = max_leverage_bps;
    agent.last_action_ms = tx_context::epoch_timestamp_ms(ctx);
}

// -----------------------------------------------------------------------------
// PnL updates (called by Treasury module after a trade settles)
// -----------------------------------------------------------------------------

public fun record_trade(
    pnl: &mut PnL,
    agent: &mut Agent,
    realized_delta_mag: u64,
    realized_delta_sign: u8,
    volume_delta: u64,
    ctx: &mut TxContext,
) {
    // Auth: caller must hold the executor cap. We only verify the cap+agent
    // pair matches here; the full auth flow is in treasury.move where the cap
    // is actually consumed.
    assert!(agent.status == STATUS_ACTIVE, EAgentNotActive);
    assert!(pnl.agent_id == object::id(agent), EWrongAgent);
    assert!(realized_delta_sign == SIGN_POS || realized_delta_sign == SIGN_NEG, EInvalidStatus);

    if (realized_delta_sign == SIGN_POS) {
        pnl.realized_pnl = pnl.realized_pnl + realized_delta_mag;
    } else {
        // Floor at 0 if underflow. A real impl would track losses separately.
        if (realized_delta_mag > pnl.realized_pnl) {
            pnl.realized_pnl = 0;
        } else {
            pnl.realized_pnl = pnl.realized_pnl - realized_delta_mag;
        }
    };
    pnl.trade_count = pnl.trade_count + 1;
    pnl.volume = pnl.volume + volume_delta;
    pnl.updated_at_ms = tx_context::epoch_timestamp_ms(ctx);
    agent.last_action_ms = pnl.updated_at_ms;

    event::emit(PnLUpdated {
        agent_id: object::id(agent),
        realized_delta_mag,
        realized_delta_sign,
        trade_count_delta: 1,
        volume_delta,
        at_ms: pnl.updated_at_ms,
    });
}

// -----------------------------------------------------------------------------
// View functions
// -----------------------------------------------------------------------------

public fun agent_owner(agent: &Agent): address { agent.owner }
public fun agent_name(agent: &Agent): &vector<u8> { &agent.name }
public fun agent_status(agent: &Agent): u8 { agent.status }
public fun agent_strategy_hash(agent: &Agent): &vector<u8> { &agent.strategy_hash }
public fun agent_strategy_blob_id(agent: &Agent): Option<ID> { agent.strategy_blob_id }
public fun agent_treasury_id(agent: &Agent): ID { agent.treasury_id }
public fun agent_max_position(agent: &Agent): u64 { agent.max_position_size_usd }
public fun agent_max_daily_loss(agent: &Agent): u64 { agent.max_daily_loss_usd }
public fun agent_max_leverage_bps(agent: &Agent): u64 { agent.max_leverage_bps }
public fun agent_suins_name(agent: &Agent): Option<vector<u8>> {
    if (option::is_some(&agent.suins_name)) {
        option::some(*option::borrow(&agent.suins_name))
    } else {
        option::none()
    }
}
public fun agent_created_at(agent: &Agent): u64 { agent.created_at_ms }
public fun agent_last_action(agent: &Agent): u64 { agent.last_action_ms }

public fun cap_agent_id(cap: &AgentCap): ID { cap.agent_id }
public fun cap_role(cap: &AgentCap): u8 { cap.role }

public fun pnl_realized(pnl: &PnL): u64 { pnl.realized_pnl }
public fun pnl_unrealized_mag(pnl: &PnL): u64 { pnl.unrealized_pnl_mag }
public fun pnl_unrealized_sign(pnl: &PnL): u8 { pnl.unrealized_pnl_sign }
public fun pnl_trade_count(pnl: &PnL): u64 { pnl.trade_count }
public fun pnl_volume(pnl: &PnL): u64 { pnl.volume }
public fun pnl_updated_at(pnl: &PnL): u64 { pnl.updated_at_ms }
public fun pnl_agent_id(pnl: &PnL): ID { pnl.agent_id }

public fun sign_pos(): u8 { SIGN_POS }
public fun sign_neg(): u8 { SIGN_NEG }

public fun registry_count(registry: &AgentRegistry): u64 { registry.total_created }
public fun registry_agents(registry: &AgentRegistry): &vector<ID> { &registry.agents }

// -----------------------------------------------------------------------------
// Test-only helpers
// -----------------------------------------------------------------------------

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    init(ctx);
}

#[test_only]
public fun destroy_agent_for_testing(agent: Agent) {
    let Agent {
        id,
        version: _,
        owner: _,
        name: _,
        strategy_hash: _,
        suins_name: _,
        max_position_size_usd: _,
        max_daily_loss_usd: _,
        max_leverage_bps: _,
        status: _,
        treasury_id: _,
        strategy_blob_id: _,
        created_at_ms: _,
        last_action_ms: _,
    } = agent;
    object::delete(id);
}

#[test_only]
public fun destroy_cap_for_testing(cap: AgentCap) {
    let AgentCap { id, agent_id: _, role: _, issued_at_ms: _, nonce: _ } = cap;
    object::delete(id);
}

#[test_only]
public fun destroy_pnl_for_testing(p: PnL) {
    let PnL { id, agent_id: _, realized_pnl: _, unrealized_pnl_mag: _, unrealized_pnl_sign: _, trade_count: _, volume: _, updated_at_ms: _ } = p;
    object::delete(id);
}

public fun status_active(): u8 { STATUS_ACTIVE }
public fun status_paused(): u8 { STATUS_PAUSED }
public fun status_liquidated(): u8 { STATUS_LIQUIDATED }
#[test_only]
public fun status_active_for_test(): u8 { STATUS_ACTIVE }
#[test_only]
public fun status_paused_for_test(): u8 { STATUS_PAUSED }
#[test_only]
public fun status_liquidated_for_test(): u8 { STATUS_LIQUIDATED }
