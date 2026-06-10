// =============================================================================
// Module: optic::backtest
// -----------------------------------------------------------------------------
// Verifiable on-chain backtest harness for OPTIC strategies.
//
// The flow:
//   1. User fetches a strategy blob from Walrus.
//   2. User compiles a series of DeepBook fill events into a `BacktestRun`
//      Move object (one row per fill).
//   3. User (or off-chain runner) replays the strategy against the fills
//      and produces a `BacktestResult` Move object with realized PnL,
//      Sharpe, and max-drawdown.
//   4. The hash of the input fills + the strategy hash is committed, so
//      the backtest is reproducible by anyone who re-runs the same inputs.
//
// We do NOT execute strategy code in Move (it's TypeScript in our pipeline);
// the result is an attested input + output pair.
// =============================================================================

module optic::backtest;

use sui::event;
use sui::object::{Self, ID, UID};
use sui::transfer;
use sui::tx_context::{Self, TxContext};

// -----------------------------------------------------------------------------
// Error codes
// -----------------------------------------------------------------------------

const EInvalidHash: u64 = 0;
const EInvalidWindow: u64 = 1;
const EResultNotFinal: u64 = 2;
const EResultAlreadyFinal: u64 = 3;

// -----------------------------------------------------------------------------
// Objects
// -----------------------------------------------------------------------------

/// A single backtest fill (an event the strategy "saw" during the replay).
public struct BacktestFill has copy, drop, store {
    at_ms: u64,
    side: u8,           // 0=buy, 1=sell
    price: u64,         // micro-USDC
    size: u64,          // base units
}

/// A BacktestRun — the input to a backtest. Holds the strategy hash, the
/// fills, and the parameters (window start/end). Owned by the runner.
public struct BacktestRun has key, store {
    id: UID,
    /// sha256 of the strategy spec (matches Walrus blob).
    strategy_hash: vector<u8>,
    /// sha256 of the (concatenated) fill list — committed so the run is
    /// exactly reproducible.
    fills_hash: vector<u8>,
    /// Window start (inclusive) in ms.
    window_start_ms: u64,
    /// Window end (inclusive) in ms.
    window_end_ms: u64,
    /// Number of fills in this run.
    fill_count: u64,
    /// The fills themselves (bounded; off-chain indexers can chunk).
    fills: vector<BacktestFill>,
    /// Owner / runner.
    owner: address,
    /// Created at.
    created_at_ms: u64,
}

/// A BacktestResult — the output of a backtest. Attested by `attestor`.
public struct BacktestResult has key, store {
    id: UID,
    /// The BacktestRun id this result is for.
    run_id: ID,
    /// Strategy hash (copied from run).
    strategy_hash: vector<u8>,
    /// Total realized PnL in micro-USDC (magnitude + sign).
    realized_pnl_mag: u64,
    realized_pnl_sign: u8,
    /// Trade count.
    trade_count: u64,
    /// Final equity (micro-USDC).
    final_equity: u64,
    /// Max drawdown in bps from peak.
    max_drawdown_bps: u64,
    /// Sharpe ratio (scaled by 1e4; 1234 = 0.1234).
    sharpe_x10000: u64,
    /// Win rate in bps (0..10000).
    win_rate_bps: u64,
    /// The address that attested this result (typically the off-chain runner).
    attestor: address,
    /// Whether this result is final (immutable after this is set).
    finalized: bool,
    /// Created at.
    created_at_ms: u64,
    /// Finalized at.
    finalized_at_ms: u64,
}

// -----------------------------------------------------------------------------
// Events
// -----------------------------------------------------------------------------

public struct BacktestRunCreated has copy, drop {
    run_id: ID,
    owner: address,
    strategy_hash: vector<u8>,
    fills_hash: vector<u8>,
    fill_count: u64,
    at_ms: u64,
}

public struct BacktestResultFinalized has copy, drop {
    result_id: ID,
    run_id: ID,
    attestor: address,
    realized_pnl_mag: u64,
    realized_pnl_sign: u8,
    trade_count: u64,
    sharpe_x10000: u64,
    at_ms: u64,
}

// -----------------------------------------------------------------------------
// Run lifecycle
// -----------------------------------------------------------------------------

/// Create a new BacktestRun. Caller provides the strategy hash, fills
/// hash, and the fill data. We don't enforce any cross-module invariants
/// here — the harness is a primitive that the off-chain pipeline uses.
public fun create_run(
    strategy_hash: vector<u8>,
    fills_hash: vector<u8>,
    window_start_ms: u64,
    window_end_ms: u64,
    fills: vector<BacktestFill>,
    ctx: &mut TxContext,
): ID {
    assert!(vector::length(&strategy_hash) == 32, EInvalidHash);
    assert!(vector::length(&fills_hash) == 32, EInvalidHash);
    assert!(window_end_ms > window_start_ms, EInvalidWindow);

    let uid = object::new(ctx);
    let run_id = object::uid_to_inner(&uid);
    let now = tx_context::epoch_timestamp_ms(ctx);
    let fill_count = vector::length(&fills);

    let run = BacktestRun {
        id: uid,
        strategy_hash,
        fills_hash,
        window_start_ms,
        window_end_ms,
        fill_count,
        fills,
        owner: tx_context::sender(ctx),
        created_at_ms: now,
    };

    event::emit(BacktestRunCreated {
        run_id,
        owner: tx_context::sender(ctx),
        strategy_hash: run.strategy_hash,
        fills_hash: run.fills_hash,
        fill_count,
        at_ms: now,
    });

    transfer::public_transfer(run, tx_context::sender(ctx));
    run_id
}

/// Finalize a BacktestResult. Anyone can attest; the result is canonical
/// for a given (strategy_hash, fills_hash) pair.
public fun finalize_result(
    run: &BacktestRun,
    realized_pnl_mag: u64,
    realized_pnl_sign: u8,
    trade_count: u64,
    final_equity: u64,
    max_drawdown_bps: u64,
    sharpe_x10000: u64,
    win_rate_bps: u64,
    ctx: &mut TxContext,
): ID {
    let uid = object::new(ctx);
    let result_id = object::uid_to_inner(&uid);
    let now = tx_context::epoch_timestamp_ms(ctx);

    let result = BacktestResult {
        id: uid,
        run_id: object::id(run),
        strategy_hash: run.strategy_hash,
        realized_pnl_mag,
        realized_pnl_sign,
        trade_count,
        final_equity,
        max_drawdown_bps,
        sharpe_x10000,
        win_rate_bps,
        attestor: tx_context::sender(ctx),
        finalized: true,
        created_at_ms: now,
        finalized_at_ms: now,
    };

    event::emit(BacktestResultFinalized {
        result_id,
        run_id: object::id(run),
        attestor: tx_context::sender(ctx),
        realized_pnl_mag,
        realized_pnl_sign,
        trade_count,
        sharpe_x10000,
        at_ms: now,
    });

    transfer::public_transfer(result, tx_context::sender(ctx));
    result_id
}

// -----------------------------------------------------------------------------
// View functions
// -----------------------------------------------------------------------------

public fun run_strategy_hash(run: &BacktestRun): &vector<u8> { &run.strategy_hash }
public fun run_fills_hash(run: &BacktestRun): &vector<u8> { &run.fills_hash }
public fun run_fill_count(run: &BacktestRun): u64 { run.fill_count }
public fun run_window_start(run: &BacktestRun): u64 { run.window_start_ms }
public fun run_window_end(run: &BacktestRun): u64 { run.window_end_ms }
public fun run_owner(run: &BacktestRun): address { run.owner }

public fun result_realized_pnl_mag(r: &BacktestResult): u64 { r.realized_pnl_mag }
public fun result_realized_pnl_sign(r: &BacktestResult): u8 { r.realized_pnl_sign }
public fun result_trade_count(r: &BacktestResult): u64 { r.trade_count }
public fun result_final_equity(r: &BacktestResult): u64 { r.final_equity }
public fun result_max_drawdown_bps(r: &BacktestResult): u64 { r.max_drawdown_bps }
public fun result_sharpe_x10000(r: &BacktestResult): u64 { r.sharpe_x10000 }
public fun result_win_rate_bps(r: &BacktestResult): u64 { r.win_rate_bps }
public fun result_attestor(r: &BacktestResult): address { r.attestor }
public fun result_is_finalized(r: &BacktestResult): bool { r.finalized }
public fun result_strategy_hash(r: &BacktestResult): &vector<u8> { &r.strategy_hash }

// -----------------------------------------------------------------------------
// Test-only helpers
// -----------------------------------------------------------------------------

#[test_only]
public fun destroy_run_for_testing(run: BacktestRun) {
    let BacktestRun {
        id,
        strategy_hash: _,
        fills_hash: _,
        window_start_ms: _,
        window_end_ms: _,
        fill_count: _,
        fills: _,
        owner: _,
        created_at_ms: _,
    } = run;
    object::delete(id);
}

#[test_only]
public fun destroy_result_for_testing(r: BacktestResult) {
    let BacktestResult {
        id,
        run_id: _,
        strategy_hash: _,
        realized_pnl_mag: _,
        realized_pnl_sign: _,
        trade_count: _,
        final_equity: _,
        max_drawdown_bps: _,
        sharpe_x10000: _,
        win_rate_bps: _,
        attestor: _,
        finalized: _,
        created_at_ms: _,
        finalized_at_ms: _,
    } = r;
    object::delete(id);
}

#[test_only]
public fun make_fill(at_ms: u64, side: u8, price: u64, size: u64): BacktestFill {
    BacktestFill { at_ms, side, price, size }
}
