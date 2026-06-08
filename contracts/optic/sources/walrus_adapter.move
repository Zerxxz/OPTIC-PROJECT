// =============================================================================
// Module: optic::walrus_adapter
// -----------------------------------------------------------------------------
// OPTIC Walrus Adapter: on-chain references to Walrus blobs.
//
// Why a Move module for blob refs (and not just call Walrus off-chain)?
//   1. **Verifiability**: a strategy blob ID stored on-chain is a hard
//      commitment. Anyone can fetch the blob from Walrus and hash it
//      client-side, then compare to the hash stored on the Agent.
//   2. **Audit trail**: every decision the agent makes (every order, every
//      risk check) can be logged as an `AuditEntry` whose payload is a
//      Walrus blob. This gives a public, append-only, queryable record.
//   3. **No AWS, no S3, no pinning**: Walrus Sites is fully decentralized,
//      so the agent's dashboard can be hosted on Walrus too — no off-chain
//      infra to trust.
// =============================================================================

module optic::walrus_adapter;

use sui::event;
use sui::object::{Self, ID, UID};
use sui::transfer;
use sui::tx_context::{Self, TxContext};
use optic::core::{Self, Agent};

// -----------------------------------------------------------------------------
// Error codes
// -----------------------------------------------------------------------------
const EWrongAgent: u64 = 300;
const EInvalidAction: u64 = 301;
const EAgentNotActive: u64 = 302;

// -----------------------------------------------------------------------------
// Action types — for the audit log
// -----------------------------------------------------------------------------
const ACTION_STRATEGY_UPDATED: u8 = 0;
const ACTION_DEPOSIT: u8 = 1;
const ACTION_WITHDRAW_OWNER: u8 = 2;
const ACTION_WITHDRAW_AGENT: u8 = 3;
const ACTION_ORDER_SUBMIT: u8 = 4;
const ACTION_ORDER_FILL: u8 = 5;
const ACTION_RISK_HEDGE: u8 = 6;
const ACTION_PAUSE: u8 = 7;
const ACTION_RESUME: u8 = 8;
const ACTION_LIQUIDATE: u8 = 9;
const ACTION_CAP_ISSUED: u8 = 10;
const ACTION_CAP_REVOKED: u8 = 11;
const ACTION_PNL_MILESTONE: u8 = 12;

// -----------------------------------------------------------------------------
// Objects
// -----------------------------------------------------------------------------

/// AuditEntry — a single row in the agent's append-only audit log.
/// Stored as a shared object so the public Walrus Site can read them.
public struct AuditEntry has key, store {
    id: UID,
    agent_id: ID,
    /// Action type (0-12). See constants above.
    action: u8,
    /// Sequence number per agent (0, 1, 2, ...). The orchestrator sets this
    /// from a counter kept off-chain; if you want strict on-chain ordering
    /// use a `Counter` object (we keep it off-chain for gas).
    sequence: u64,
    /// Optional Walrus blob ID pointing to a JSON or CBOR payload with
    /// the full action context (prompt, decision reasoning, etc.).
    blob_id: Option<vector<u8>>,
    /// Free-form human-readable summary (e.g. "BUY 100 SUI @ 1.50 USDC").
    summary: vector<u8>,
    /// Wall-clock ms at the time of the action.
    at_ms: u64,
    /// Address that triggered the action.
    actor: address,
}

/// StrategyRef — a typed reference to a strategy blob on Walrus.
/// Hash is stored on-chain; blob_id is the Walrus blob ID (off-chain
/// indexable; the Walrus gateway can fetch it via /v1/blobs/{blob_id}).
public struct StrategyRef has key, store {
    id: UID,
    agent_id: ID,
    /// SHA-3 of the strategy blob. Compared on every audit entry.
    blob_hash: vector<u8>,
    /// Walrus blob ID (object ID on Sui).
    blob_id: vector<u8>,
    /// Strategy version (incrementing).
    version: u64,
    /// When the blob was anchored on-chain.
    anchored_at_ms: u64,
    /// Who anchored it (must be the agent owner).
    anchored_by: address,
    /// Short human label, e.g. "mean-reversion-v1" or "market-making-v3".
    label: vector<u8>,
}

// -----------------------------------------------------------------------------
// Events
// -----------------------------------------------------------------------------

public struct StrategyAnchored has copy, drop {
    strategy_ref_id: ID,
    agent_id: ID,
    blob_id: vector<u8>,
    blob_hash: vector<u8>,
    version: u64,
    anchored_by: address,
    at_ms: u64,
}

public struct AuditEntryRecorded has copy, drop {
    entry_id: ID,
    agent_id: ID,
    action: u8,
    sequence: u64,
    blob_id: Option<vector<u8>>,
    summary: vector<u8>,
    actor: address,
    at_ms: u64,
}

// -----------------------------------------------------------------------------
// Constructor
// -----------------------------------------------------------------------------

/// Anchor a new strategy blob. Stores a StrategyRef object on-chain. The
/// caller (orchestrator or owner) is expected to have already uploaded the
/// blob to Walrus and computed its hash. The agent owner may also delegate
/// anchoring to the executor cap holder.
public fun anchor_strategy(
    agent: &mut Agent,
    blob_id: vector<u8>,
    blob_hash: vector<u8>,
    label: vector<u8>,
    ctx: &mut TxContext,
): ID {
    // Owner-only anchor
    let sender = tx_context::sender(ctx);
    assert!(sender == core::agent_owner(agent), EWrongAgent);
    assert!(core::agent_status(agent) == core::status_active(), EAgentNotActive);

    let now = tx_context::epoch_timestamp_ms(ctx);

    // Bump the strategy_hash on the Agent so it matches the anchored blob
    core::update_strategy_hash(agent, blob_hash, option::none(), ctx);

    let strategy_uid = object::new(ctx);
    let strategy_id = object::uid_to_inner(&strategy_uid);

    // Version = created_at_ms (cheap, monotonic, unique)
    let strategy = StrategyRef {
        id: strategy_uid,
        agent_id: object::id(agent),
        blob_hash,
        blob_id,
        version: now,
        anchored_at_ms: now,
        anchored_by: sender,
        label,
    };

    event::emit(StrategyAnchored {
        strategy_ref_id: strategy_id,
        agent_id: object::id(agent),
        blob_id: strategy.blob_id,
        blob_hash: strategy.blob_hash,
        version: strategy.version,
        anchored_by: sender,
        at_ms: now,
    });

    transfer::public_transfer(strategy, sender);
    strategy_id
}

// -----------------------------------------------------------------------------
// Audit log
// -----------------------------------------------------------------------------

/// Append an AuditEntry to the log. Anyone can call this (it's an audit
/// log — not gated by cap). The action is restricted to the valid enum range.
public fun record_audit(
    agent: &Agent,
    action: u8,
    sequence: u64,
    blob_id: Option<vector<u8>>,
    summary: vector<u8>,
    ctx: &mut TxContext,
): ID {
    assert!(action <= 12, EInvalidAction);

    let now = tx_context::epoch_timestamp_ms(ctx);
    let uid = object::new(ctx);
    let entry_id = object::uid_to_inner(&uid);

    let entry = AuditEntry {
        id: uid,
        agent_id: object::id(agent),
        action,
        sequence,
        blob_id,
        summary,
        at_ms: now,
        actor: tx_context::sender(ctx),
    };

    event::emit(AuditEntryRecorded {
        entry_id,
        agent_id: object::id(agent),
        action,
        sequence,
        blob_id,
        summary: entry.summary,
        actor: entry.actor,
        at_ms: now,
    });

    transfer::share_object(entry);
    entry_id
}

// -----------------------------------------------------------------------------
// View functions
// -----------------------------------------------------------------------------

public fun strategy_blob_id(s: &StrategyRef): &vector<u8> { &s.blob_id }
public fun strategy_blob_hash(s: &StrategyRef): &vector<u8> { &s.blob_hash }
public fun strategy_version(s: &StrategyRef): u64 { s.version }
public fun strategy_anchored_at(s: &StrategyRef): u64 { s.anchored_at_ms }
public fun strategy_label(s: &StrategyRef): &vector<u8> { &s.label }
public fun strategy_agent_id(s: &StrategyRef): ID { s.agent_id }

public fun audit_entry_id(e: &AuditEntry): ID { object::id(e) }
public fun audit_action(e: &AuditEntry): u8 { e.action }
public fun audit_sequence(e: &AuditEntry): u64 { e.sequence }
public fun audit_summary(e: &AuditEntry): &vector<u8> { &e.summary }
public fun audit_blob_id(e: &AuditEntry): Option<vector<u8>> {
    if (option::is_some(&e.blob_id)) {
        option::some(*option::borrow(&e.blob_id))
    } else {
        option::none()
    }
}
public fun audit_at(e: &AuditEntry): u64 { e.at_ms }
public fun audit_actor(e: &AuditEntry): address { e.actor }
public fun audit_agent_id(e: &AuditEntry): ID { e.agent_id }

// Action type constants
public fun action_strategy_updated(): u8 { ACTION_STRATEGY_UPDATED }
public fun action_deposit(): u8 { ACTION_DEPOSIT }
public fun action_withdraw_owner(): u8 { ACTION_WITHDRAW_OWNER }
public fun action_withdraw_agent(): u8 { ACTION_WITHDRAW_AGENT }
public fun action_order_submit(): u8 { ACTION_ORDER_SUBMIT }
public fun action_order_fill(): u8 { ACTION_ORDER_FILL }
public fun action_risk_hedge(): u8 { ACTION_RISK_HEDGE }
public fun action_pause(): u8 { ACTION_PAUSE }
public fun action_resume(): u8 { ACTION_RESUME }
public fun action_liquidate(): u8 { ACTION_LIQUIDATE }
public fun action_cap_issued(): u8 { ACTION_CAP_ISSUED }
public fun action_cap_revoked(): u8 { ACTION_CAP_REVOKED }
public fun action_pnl_milestone(): u8 { ACTION_PNL_MILESTONE }

// -----------------------------------------------------------------------------
// Test-only helpers
// -----------------------------------------------------------------------------

#[test_only]
public fun destroy_strategy_for_testing(s: StrategyRef) {
    let StrategyRef {
        id,
        agent_id: _,
        blob_hash: _,
        blob_id: _,
        version: _,
        anchored_at_ms: _,
        anchored_by: _,
        label: _,
    } = s;
    object::delete(id);
}

#[test_only]
public fun destroy_audit_for_testing(e: AuditEntry) {
    let AuditEntry {
        id,
        agent_id: _,
        action: _,
        sequence: _,
        blob_id: _,
        summary: _,
        at_ms: _,
        actor: _,
    } = e;
    object::delete(id);
}
