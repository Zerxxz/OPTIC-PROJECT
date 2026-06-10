#[test_only]
module optic::backtest_tests {
    use sui::test_scenario as ts;
    use optic::backtest;
    use optic::backtest::{BacktestRun, BacktestResult};

    const RUNNER: address = @0xA;
    const ATTESTOR: address = @0xB;

    fun hash32(seed: u8): vector<u8> {
        let mut v = vector::empty<u8>();
        let mut i = 0;
        while (i < 32) {
            vector::push_back(&mut v, if (i == 0) seed else 0);
            i = i + 1;
        };
        v
    }

    fun sample_fills(): vector<backtest::BacktestFill> {
        let mut fills = vector::empty<backtest::BacktestFill>();
        vector::push_back(&mut fills, backtest::make_fill(1_000, 0, 1_500_000, 1_000));
        vector::push_back(&mut fills, backtest::make_fill(1_100, 1, 1_510_000, 1_000));
        vector::push_back(&mut fills, backtest::make_fill(1_200, 0, 1_490_000, 2_000));
        fills
    }

    #[test]
    fun test_create_run_with_valid_fills() {
        let mut scen = ts::begin(RUNNER);
        ts::next_tx(&mut scen, RUNNER);
        let run_id = backtest::create_run(
            hash32(1),        // strategy hash
            hash32(2),        // fills hash
            1_000,            // window start
            10_000,           // window end
            sample_fills(),
            ts::ctx(&mut scen),
        );
        assert!(run_id != sui::object::id_from_address(@0x0), 0);
        // The created BacktestRun is transferred to RUNNER in the same tx;
        // advance the scenario so the inventory is committed.
        ts::next_tx(&mut scen, RUNNER);
        let run = ts::take_from_address<BacktestRun>(&scen, RUNNER);
        assert!(backtest::run_fill_count(&run) == 3, 1);
        assert!(backtest::run_window_start(&run) == 1_000, 2);
        assert!(backtest::run_window_end(&run) == 10_000, 3);
        assert!(backtest::run_owner(&run) == RUNNER, 4);
        ts::return_to_address(RUNNER, run);
        ts::end(scen);
    }

    #[test]
    #[expected_failure(abort_code = 1, location = optic::backtest)]  // EInvalidWindow
    fun test_create_run_rejects_inverted_window() {
        let mut scen = ts::begin(RUNNER);
        ts::next_tx(&mut scen, RUNNER);
        backtest::create_run(
            hash32(1),
            hash32(2),
            10_000,  // start > end
            1_000,
            sample_fills(),
            ts::ctx(&mut scen),
        );
        ts::end(scen);
    }

    #[test]
    #[expected_failure(abort_code = 0, location = optic::backtest)]  // EInvalidHash
    fun test_create_run_rejects_short_strategy_hash() {
        let mut scen = ts::begin(RUNNER);
        ts::next_tx(&mut scen, RUNNER);
        backtest::create_run(
            vector[1u8, 2u8, 3u8], // only 3 bytes
            hash32(2),
            1_000, 10_000,
            sample_fills(),
            ts::ctx(&mut scen),
        );
        ts::end(scen);
    }

    #[test]
    fun test_finalize_result_attests_metrics() {
        let mut scen = ts::begin(RUNNER);
        ts::next_tx(&mut scen, RUNNER);
        let _ = backtest::create_run(
            hash32(1),
            hash32(2),
            1_000, 10_000,
            sample_fills(),
            ts::ctx(&mut scen),
        );
        ts::next_tx(&mut scen, RUNNER);
        let run = ts::take_from_address<BacktestRun>(&scen, RUNNER);
        let result_id = backtest::finalize_result(
            &run,
            50_000_000, // +$50 in micro-USDC
            0,          // SIGN_POS
            3,          // 3 trades
            10_050_000_000,
            250,        // 2.5% max DD
            1234,       // Sharpe 0.1234
            6667,       // 66.67% win rate
            ts::ctx(&mut scen),
        );
        assert!(result_id != sui::object::id_from_address(@0x0), 0);
        ts::next_tx(&mut scen, ATTESTOR);
        let result = ts::take_from_address<BacktestResult>(&scen, RUNNER);
        assert!(backtest::result_is_finalized(&result), 1);
        assert!(backtest::result_realized_pnl_mag(&result) == 50_000_000, 2);
        assert!(backtest::result_realized_pnl_sign(&result) == 0, 3);
        assert!(backtest::result_trade_count(&result) == 3, 4);
        assert!(backtest::result_max_drawdown_bps(&result) == 250, 5);
        assert!(backtest::result_sharpe_x10000(&result) == 1234, 6);
        assert!(backtest::result_win_rate_bps(&result) == 6667, 7);
        assert!(backtest::result_attestor(&result) == RUNNER, 8);
        ts::return_to_address(RUNNER, result);
        backtest::destroy_run_for_testing(run);
        ts::end(scen);
    }

    #[test]
    fun test_finalize_result_records_loss() {
        let mut scen = ts::begin(RUNNER);
        ts::next_tx(&mut scen, RUNNER);
        let _ = backtest::create_run(
            hash32(3),
            hash32(4),
            1_000, 10_000,
            sample_fills(),
            ts::ctx(&mut scen),
        );
        ts::next_tx(&mut scen, RUNNER);
        let run = ts::take_from_address<BacktestRun>(&scen, RUNNER);
        let _ = backtest::finalize_result(
            &run,
            30_000_000, // $30
            1,          // SIGN_NEG (loss)
            3,
            9_970_000_000,
            500,
            0,          // Sharpe 0 (loss)
            0,          // 0% win rate
            ts::ctx(&mut scen),
        );
        ts::next_tx(&mut scen, RUNNER);
        let result = ts::take_from_address<BacktestResult>(&scen, RUNNER);
        assert!(backtest::result_realized_pnl_sign(&result) == 1, 0);
        assert!(backtest::result_sharpe_x10000(&result) == 0, 1);
        ts::return_to_address(RUNNER, result);
        backtest::destroy_run_for_testing(run);
        ts::end(scen);
    }
}
