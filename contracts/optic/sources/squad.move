// =============================================================================
// Module: optic::squad
// -----------------------------------------------------------------------------
// AgentSquad — a DAO of N agents that share one Treasury and vote on
// every cycle. Each agent's voting weight is proportional to its rolling
// Sharpe ratio. The Squad proposes a single action per cycle and the
// quorum is reached when weighted_yes > weighted_no * 1.5.
//
// The Squad mirrors OPTIC's core agent model (Agent, AgentCap, Treasury)
// but the decision authority is governed by the Squad's vote rather than
// the orchestrator's merge() function.
// =============================================================================

module optic::squad;

use sui::event;
use sui::object::{Self, ID, UID};
use sui::transfer;
use sui::tx_context::{Self, TxContext};
use std::vector;
use optic::core::{Self, Agent, AgentCap};

// -----------------------------------------------------------------------------
// Error codes
// -----------------------------------------------------------------------------

const EInvalidQuorum: u64 = 0;
const EInvalidThreshold: u64 = 1;
const ESquadFull: u64 = 2;
const EAlreadyMember: u64 = 3;
const ENotMember: u64 = 4;
const EAlreadyVoted: u64 = 5;
const EProposalNotOpen: u64 = 6;
const ENoQuorum: u64 = 7;
const EInvalidActionKind: u64 = 8;
const ESquadNotActive: u64 = 9;

// -----------------------------------------------------------------------------
// Objects
// -----------------------------------------------------------------------------

/// A Squad — a DAO of agents. Shared object.
public struct Squad has key {
    id: UID,
    /// Human-friendly name.
    name: vector<u8>,
    /// The treasury object ID the Squad controls.
    treasury_id: ID,
    /// Member agent IDs. Capped at 16 to keep vote-tallying cheap.
    members: vector<ID>,
    /// Current cycle number (monotonic).
    cycle: u64,
    /// Most recent Sharpe (×10000) per agent. Updated after each cycle.
    sharpe_x10000: vector<u64>,
    /// Total votes required (weighted) for quorum.
    quorum_bps: u64,
    /// Pass threshold (weighted_yes / weighted_total) in bps.
    pass_threshold_bps: u64,
    /// Status: 0=active, 1=paused, 2=dissolved.
    status: u8,
    /// Owner / admin.
    owner: address,
    /// Created at.
    created_at_ms: u64,
}

/// A Proposal — a single decision under vote by the Squad. One is opened
/// per cycle and resolved when votes reach quorum or when the cycle ends.
public struct Proposal has key, store {
    id: UID,
    /// The Squad that owns this proposal.
    squad_id: ID,
    /// Cycle number.
    cycle: u64,
    /// Action kind: 0=place_order, 1=open_hedge, 2=pause, 3=no_op.
    action_kind: u8,
    /// Action payload (serialized as a flat vector<u8> for simplicity).
    /// Decoded by the off-chain runner per kind.
    action_payload: vector<u8>,
    /// Snapshot of member weights at the time the proposal was opened.
    weights_at_open: vector<u64>,
    /// Weighted yes votes accumulated so far.
    weighted_yes: u64,
    /// Weighted no votes accumulated so far.
    weighted_no: u64,
    /// Agents that have already voted (to prevent double-vote).
    voted: vector<ID>,
    /// Total weight at open (sum of weights).
    total_weight: u64,
    /// Whether the proposal is open for voting.
    open: bool,
    /// Final outcome (1=pass, 0=fail). Set when resolved.
    outcome: u8,
    /// Created at.
    created_at_ms: u64,
    /// Resolved at.
    resolved_at_ms: u64,
}

// -----------------------------------------------------------------------------
// Events
// -----------------------------------------------------------------------------

public struct SquadCreated has copy, drop {
    squad_id: ID,
    owner: address,
    name: vector<u8>,
    treasury_id: ID,
    quorum_bps: u64,
    pass_threshold_bps: u64,
    at_ms: u64,
}

public struct MemberAdded has copy, drop {
    squad_id: ID,
    agent_id: ID,
    at_ms: u64,
}

public struct ProposalOpened has copy, drop {
    proposal_id: ID,
    squad_id: ID,
    cycle: u64,
    action_kind: u8,
    at_ms: u64,
}

public struct VoteCast has copy, drop {
    proposal_id: ID,
    voter_agent: ID,
    weight: u64,
    yes: bool,
    at_ms: u64,
}

public struct ProposalResolved has copy, drop {
    proposal_id: ID,
    outcome: u8, // 1=pass, 0=fail
    weighted_yes: u64,
    weighted_no: u64,
    at_ms: u64,
}

// -----------------------------------------------------------------------------
// Squad lifecycle
// -----------------------------------------------------------------------------

/// Create a new Squad. Owner must already have a Treasury.
public fun create_squad(
    name: vector<u8>,
    treasury_id: ID,
    quorum_bps: u64,
    pass_threshold_bps: u64,
    ctx: &mut TxContext,
): ID {
    assert!(quorum_bps > 0 && quorum_bps <= 10_000, EInvalidQuorum);
    assert!(pass_threshold_bps > 0 && pass_threshold_bps <= 10_000, EInvalidThreshold);

    let uid = object::new(ctx);
    let squad_id = object::uid_to_inner(&uid);
    let now = tx_context::epoch_timestamp_ms(ctx);

    let squad = Squad {
        id: uid,
        name,
        treasury_id,
        members: vector<ID>[],
        cycle: 0,
        sharpe_x10000: vector<u64>[],
        quorum_bps,
        pass_threshold_bps,
        status: 0,
        owner: tx_context::sender(ctx),
        created_at_ms: now,
    };

    event::emit(SquadCreated {
        squad_id,
        owner: tx_context::sender(ctx),
        name: squad.name,
        treasury_id,
        quorum_bps,
        pass_threshold_bps,
        at_ms: now,
    });

    transfer::share_object(squad);
    squad_id
}

/// Add a member agent. Owner only. Max 16 members.
public fun add_member(squad: &mut Squad, agent_id: ID, initial_sharpe_x10000: u64, ctx: &mut TxContext) {
    assert!(squad.status == 0, ESquadNotActive);
    assert!(tx_context::sender(ctx) == squad.owner, 0);
    assert!(vector::length(&squad.members) < 16, ESquadFull);
    // De-dup.
    let mut i = 0;
    let n = vector::length(&squad.members);
    while (i < n) {
        assert!(*vector::borrow(&squad.members, i) != agent_id, EAlreadyMember);
        i = i + 1;
    };
    vector::push_back(&mut squad.members, agent_id);
    vector::push_back(&mut squad.sharpe_x10000, initial_sharpe_x10000);
    event::emit(MemberAdded {
        squad_id: object::id(squad),
        agent_id,
        at_ms: tx_context::epoch_timestamp_ms(ctx),
    });
}

/// Update a member's weight (Sharpe). Anyone can submit; the Squad trusts
/// the off-chain indexer to compute the rolling Sharpe.
public fun update_member_weight(squad: &mut Squad, agent_id: ID, new_sharpe_x10000: u64) {
    let mut i = 0;
    let n = vector::length(&squad.members);
    let mut found = false;
    while (i < n) {
        if (*vector::borrow(&squad.members, i) == agent_id) {
            *vector::borrow_mut(&mut squad.sharpe_x10000, i) = new_sharpe_x10000;
            found = true;
            break
        };
        i = i + 1;
    };
    assert!(found, ENotMember);
}

/// Open a new proposal for the next cycle. Anyone can open (the off-chain
/// runner). Records the current member weights so the vote is computed
/// against the weight snapshot at open time (not later).
public fun open_proposal(
    squad: &mut Squad,
    action_kind: u8,
    action_payload: vector<u8>,
    ctx: &mut TxContext,
): ID {
    assert!(squad.status == 0, ESquadNotActive);
    assert!(action_kind <= 3, EInvalidActionKind);
    squad.cycle = squad.cycle + 1;
    let now = tx_context::epoch_timestamp_ms(ctx);
    let uid = object::new(ctx);
    let proposal_id = object::uid_to_inner(&uid);

    // Snapshot weights + compute total.
    let weights = squad.sharpe_x10000;
    let mut total: u64 = 0;
    let mut i = 0;
    let n = vector::length(&weights);
    while (i < n) {
        total = total + *vector::borrow(&weights, i);
        i = i + 1;
    };

    let proposal = Proposal {
        id: uid,
        squad_id: object::id(squad),
        cycle: squad.cycle,
        action_kind,
        action_payload,
        weights_at_open: weights,
        weighted_yes: 0,
        weighted_no: 0,
        voted: vector<ID>[],
        total_weight: total,
        open: true,
        outcome: 0,
        created_at_ms: now,
        resolved_at_ms: 0,
    };

    event::emit(ProposalOpened {
        proposal_id,
        squad_id: object::id(squad),
        cycle: squad.cycle,
        action_kind,
        at_ms: now,
    });

    transfer::share_object(proposal);
    proposal_id
}

/// Cast a vote. Weight is looked up from the squad's current member list
/// using the proposal's weight snapshot.
public fun cast_vote(proposal: &mut Proposal, squad: &Squad, voter_agent: ID, yes: bool, ctx: &mut TxContext) {
    assert!(proposal.open, EProposalNotOpen);
    // De-dup.
    let mut i = 0;
    let n = vector::length(&proposal.voted);
    while (i < n) {
        assert!(*vector::borrow(&proposal.voted, i) != voter_agent, EAlreadyVoted);
        i = i + 1;
    };
    // Find weight from snapshot.
    let mut j = 0;
    let m = vector::length(&squad.members);
    let mut weight: u64 = 0;
    let mut found = false;
    while (j < m) {
        if (*vector::borrow(&squad.members, j) == voter_agent) {
            weight = *vector::borrow(&proposal.weights_at_open, j);
            found = true;
            break
        };
        j = j + 1;
    };
    assert!(found, ENotMember);

    vector::push_back(&mut proposal.voted, voter_agent);
    if (yes) {
        proposal.weighted_yes = proposal.weighted_yes + weight;
    } else {
        proposal.weighted_no = proposal.weighted_no + weight;
    };

    event::emit(VoteCast {
        proposal_id: object::id(proposal),
        voter_agent,
        weight,
        yes,
        at_ms: tx_context::epoch_timestamp_ms(ctx),
    });
}

/// Resolve a proposal. If weighted_yes / total_weight >= pass_threshold_bps
/// AND weighted_yes + weighted_no >= quorum_bps * total_weight / 10_000,
/// the proposal passes.
public fun resolve_proposal(proposal: &mut Proposal, squad: &Squad, ctx: &mut TxContext) {
    assert!(proposal.open, EProposalNotOpen);
    let now = tx_context::epoch_timestamp_ms(ctx);
    let total = proposal.total_weight;
    let cast = proposal.weighted_yes + proposal.weighted_no;
    let cast_bps = if (total == 0) 0 else (cast * 10_000) / total;
    let yes_bps = if (cast == 0) 0 else (proposal.weighted_yes * 10_000) / cast;
    let quorum_ok = cast_bps >= squad.quorum_bps;
    let pass_ok = cast > 0 && yes_bps >= squad.pass_threshold_bps;
    proposal.outcome = if (quorum_ok && pass_ok) 1 else 0;
    proposal.open = false;
    proposal.resolved_at_ms = now;

    event::emit(ProposalResolved {
        proposal_id: object::id(proposal),
        outcome: proposal.outcome,
        weighted_yes: proposal.weighted_yes,
        weighted_no: proposal.weighted_no,
        at_ms: now,
    });
}

// -----------------------------------------------------------------------------
// View functions
// -----------------------------------------------------------------------------

public fun squad_id_s(squad: &Squad): ID { object::id(squad) }
public fun squad_name(squad: &Squad): &vector<u8> { &squad.name }
public fun squad_treasury_id(squad: &Squad): ID { squad.treasury_id }
public fun squad_members(squad: &Squad): &vector<ID> { &squad.members }
public fun squad_member_count(squad: &Squad): u64 { vector::length(&squad.members) }
public fun squad_cycle(squad: &Squad): u64 { squad.cycle }
public fun squad_quorum_bps(squad: &Squad): u64 { squad.quorum_bps }
public fun squad_pass_threshold_bps(squad: &Squad): u64 { squad.pass_threshold_bps }
public fun squad_status(squad: &Squad): u8 { squad.status }
public fun squad_sharpe_of(squad: &Squad, agent_id: ID): u64 {
    let mut i = 0;
    let n = vector::length(&squad.members);
    let mut result: u64 = 0;
    let mut found = false;
    while (i < n) {
        if (*vector::borrow(&squad.members, i) == agent_id) {
            result = *vector::borrow(&squad.sharpe_x10000, i);
            found = true;
            break
        };
        i = i + 1;
    };
    assert!(found, ENotMember);
    result
}

public fun proposal_is_open(p: &Proposal): bool { p.open }
public fun proposal_outcome(p: &Proposal): u8 { p.outcome }
public fun proposal_weighted_yes(p: &Proposal): u64 { p.weighted_yes }
public fun proposal_weighted_no(p: &Proposal): u64 { p.weighted_no }
public fun proposal_total_weight(p: &Proposal): u64 { p.total_weight }
public fun proposal_cycle(p: &Proposal): u64 { p.cycle }
public fun proposal_action_kind(p: &Proposal): u8 { p.action_kind }
public fun proposal_squad_id(p: &Proposal): ID { p.squad_id }

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

#[test]
fun test_squad_can_be_created() {
    use sui::test_scenario as ts;
    let admin = @0xA;
    let mut scen = ts::begin(admin);
    ts::next_tx(&mut scen, admin);
    let squad_id = create_squad(
        b"alpha-squad",
        sui::object::id_from_address(@0xA),
        5_000, // 50% quorum
        6_000, // 60% pass threshold
        ts::ctx(&mut scen),
    );
    assert!(squad_id != sui::object::id_from_address(@0x0), 0);
    ts::end(scen);
}

#[test]
#[expected_failure(abort_code = 0, location = optic::squad)]
fun test_squad_rejects_zero_quorum() {
    use sui::test_scenario as ts;
    let admin = @0xA;
    let mut scen = ts::begin(admin);
    ts::next_tx(&mut scen, admin);
    let _ = create_squad(
        b"x",
        sui::object::id_from_address(@0xA),
        0,  // invalid
        5_000,
        ts::ctx(&mut scen),
    );
    ts::end(scen);
}

#[test]
#[expected_failure(abort_code = 1, location = optic::squad)]
fun test_squad_rejects_threshold_above_100_pct() {
    use sui::test_scenario as ts;
    let admin = @0xA;
    let mut scen = ts::begin(admin);
    ts::next_tx(&mut scen, admin);
    let _ = create_squad(
        b"x",
        sui::object::id_from_address(@0xA),
        5_000,
        15_000, // invalid > 10000
        ts::ctx(&mut scen),
    );
    ts::end(scen);
}
