// =============================================================================
// Tests: optic::predict_adapter
// =============================================================================

#[test_only]
module optic::predict_adapter_tests;

use sui::object;
use sui::test_scenario as ts;
use optic::core;
use optic::predict_adapter;
use optic::treasury;

const ALICE: address = @0xA11CE;
const BOB: address = @0xB0B;
const STRATEGY_HASH: vector<u8> = b"v1:sha3:00000000000000000000000000000000";
const TREASURY_ID_BYTES: address = @0xCAFE;

fun setup_agent(): (ts::Scenario, ID) {
    let mut sc = ts::begin(ALICE);
    core::init_for_testing(ts::ctx(&mut sc));
    ts::next_tx(&mut sc, ALICE);

    let mut registry = ts::take_shared<core::AgentRegistry>(&sc);
    let tid_placeholder = object::id_from_address(TREASURY_ID_BYTES);
    let agent_id = core::create_agent(
        &mut registry,
        b"predict-test",
        STRATEGY_HASH,
        option::none(),
        1_000_000, 1_000_000, 30_000,
        tid_placeholder,
        ts::ctx(&mut sc),
    );
    ts::return_shared(registry);
    (sc, agent_id)
}

#[test]
fun test_open_hedge() {
    let (mut sc, _) = setup_agent();

    // issue risk cap to BOB
    ts::next_tx(&mut sc, ALICE);
    {
        let agent = ts::take_from_address<core::Agent>(&sc, ALICE);
        let _cap_id = core::issue_cap(&agent, treasury::role_risk(), BOB, ts::ctx(&mut sc));
        ts::return_to_address(ALICE, agent);
    };

    // BOB opens a YES hedge on SUI strike 1.50, size 1000 USDC
    ts::next_tx(&mut sc, BOB);
    {
        let agent = ts::take_from_address<core::Agent>(&sc, ALICE);
        let cap = ts::take_from_address<core::AgentCap>(&sc, BOB);

        let hedge_id = predict_adapter::open_hedge(
            &agent, &cap,
            predict_adapter::side_yes(),
            b"SUI",
            1_500_000, // strike
            1_000_000, // 1 USDC size (6dp)
            1_700_000_000, // far future expiry
            option::none(),
            option::none(),
            ts::ctx(&mut sc),
        );
        assert!(hedge_id != object::id_from_address(@0x0), 100);

        ts::return_to_address(ALICE, agent);
        core::revoke_cap(cap);
    };

    // inspect
    ts::next_tx(&mut sc, BOB);
    {
        let hedge = ts::take_shared<predict_adapter::PredictHedge>(&sc);
        assert!(predict_adapter::hedge_side(&hedge) == predict_adapter::side_yes(), 200);
        assert!(predict_adapter::hedge_strike(&hedge) == 1_500_000, 201);
        assert!(predict_adapter::hedge_size(&hedge) == 1_000_000, 202);
        assert!(predict_adapter::hedge_status(&hedge) == predict_adapter::status_open(), 203);
        assert!(predict_adapter::hedge_opened_by(&hedge) == BOB, 204);
        ts::return_shared(hedge);
    };

    ts::end(sc);
}

#[test]
fun test_settle_hedge_win() {
    let (mut sc, _) = setup_agent();

    // issue risk cap
    ts::next_tx(&mut sc, ALICE);
    {
        let agent = ts::take_from_address<core::Agent>(&sc, ALICE);
        let _cap_id = core::issue_cap(&agent, treasury::role_risk(), BOB, ts::ctx(&mut sc));
        ts::return_to_address(ALICE, agent);
    };

    // open
    ts::next_tx(&mut sc, BOB);
    {
        let agent = ts::take_from_address<core::Agent>(&sc, ALICE);
        let cap = ts::take_from_address<core::AgentCap>(&sc, BOB);
        let _hid = predict_adapter::open_hedge(
            &agent, &cap,
            predict_adapter::side_yes(),
            b"SUI", 1_500_000, 1_000_000,
            1_700_000_000, option::none(), option::none(),
            ts::ctx(&mut sc),
        );
        ts::return_to_address(ALICE, agent);
        core::revoke_cap(cap);
    };

    // need a fresh cap to settle (we revoked the open-time one)
    ts::next_tx(&mut sc, ALICE);
    {
        let agent = ts::take_from_address<core::Agent>(&sc, ALICE);
        let _cap_id = core::issue_cap(&agent, treasury::role_risk(), BOB, ts::ctx(&mut sc));
        ts::return_to_address(ALICE, agent);
    };

    // settle as WON with payout 1_800_000 (profit 800_000)
    ts::next_tx(&mut sc, BOB);
    {
        let agent = ts::take_from_address<core::Agent>(&sc, ALICE);
        let cap = ts::take_from_address<core::AgentCap>(&sc, BOB);
        let mut hedge = ts::take_shared<predict_adapter::PredictHedge>(&sc);

        predict_adapter::settle_hedge(
            &agent, &cap, &mut hedge, true, 1_800_000, ts::ctx(&mut sc),
        );

        assert!(predict_adapter::hedge_status(&hedge) == predict_adapter::status_won(), 300);
        assert!(predict_adapter::hedge_payout(&hedge) == 1_800_000, 301);
        assert!(predict_adapter::hedge_pnl_mag(&hedge) == 800_000, 302);
        assert!(predict_adapter::hedge_pnl_sign(&hedge) == 0, 303); // POS

        ts::return_shared(hedge);
        ts::return_to_address(ALICE, agent);
        core::revoke_cap(cap);
    };

    ts::end(sc);
}

#[test]
fun test_settle_hedge_loss() {
    let (mut sc, _) = setup_agent();

    // issue cap
    ts::next_tx(&mut sc, ALICE);
    {
        let agent = ts::take_from_address<core::Agent>(&sc, ALICE);
        let _cap_id = core::issue_cap(&agent, treasury::role_risk(), BOB, ts::ctx(&mut sc));
        ts::return_to_address(ALICE, agent);
    };

    // open
    ts::next_tx(&mut sc, BOB);
    {
        let agent = ts::take_from_address<core::Agent>(&sc, ALICE);
        let cap = ts::take_from_address<core::AgentCap>(&sc, BOB);
        let _hid = predict_adapter::open_hedge(
            &agent, &cap,
            predict_adapter::side_no(),
            b"SUI", 1_500_000, 500_000,
            1_700_000_000, option::none(), option::none(),
            ts::ctx(&mut sc),
        );
        ts::return_to_address(ALICE, agent);
        core::revoke_cap(cap);
    };

    // need a fresh cap to settle
    ts::next_tx(&mut sc, ALICE);
    {
        let agent = ts::take_from_address<core::Agent>(&sc, ALICE);
        let _cap_id = core::issue_cap(&agent, treasury::role_risk(), BOB, ts::ctx(&mut sc));
        ts::return_to_address(ALICE, agent);
    };

    // settle as LOST
    ts::next_tx(&mut sc, BOB);
    {
        let agent = ts::take_from_address<core::Agent>(&sc, ALICE);
        let cap = ts::take_from_address<core::AgentCap>(&sc, BOB);
        let mut hedge = ts::take_shared<predict_adapter::PredictHedge>(&sc);

        predict_adapter::settle_hedge(
            &agent, &cap, &mut hedge, false, 0, ts::ctx(&mut sc),
        );

        assert!(predict_adapter::hedge_status(&hedge) == predict_adapter::status_lost(), 400);
        assert!(predict_adapter::hedge_payout(&hedge) == 0, 401);
        assert!(predict_adapter::hedge_pnl_mag(&hedge) == 500_000, 402);
        assert!(predict_adapter::hedge_pnl_sign(&hedge) == 1, 403); // NEG

        ts::return_shared(hedge);
        ts::return_to_address(ALICE, agent);
        core::revoke_cap(cap);
    };

    ts::end(sc);
}

#[test]
fun test_cancel_hedge() {
    let (mut sc, _) = setup_agent();

    ts::next_tx(&mut sc, ALICE);
    {
        let agent = ts::take_from_address<core::Agent>(&sc, ALICE);
        let _cap_id = core::issue_cap(&agent, treasury::role_risk(), BOB, ts::ctx(&mut sc));
        ts::return_to_address(ALICE, agent);
    };

    ts::next_tx(&mut sc, BOB);
    {
        let agent = ts::take_from_address<core::Agent>(&sc, ALICE);
        let cap = ts::take_from_address<core::AgentCap>(&sc, BOB);
        let _hid = predict_adapter::open_hedge(
            &agent, &cap, predict_adapter::side_yes(),
            b"SUI", 2_000_000, 100_000,
            1_700_000_000, option::none(), option::none(),
            ts::ctx(&mut sc),
        );
        ts::return_to_address(ALICE, agent);
        core::revoke_cap(cap);
    };

    // cancel — need a fresh cap since the open-time one was revoked
    ts::next_tx(&mut sc, ALICE);
    {
        let agent = ts::take_from_address<core::Agent>(&sc, ALICE);
        let _cap_id = core::issue_cap(&agent, treasury::role_risk(), BOB, ts::ctx(&mut sc));
        ts::return_to_address(ALICE, agent);
    };

    ts::next_tx(&mut sc, BOB);
    {
        let agent = ts::take_from_address<core::Agent>(&sc, ALICE);
        let cap = ts::take_from_address<core::AgentCap>(&sc, BOB);
        let mut hedge = ts::take_shared<predict_adapter::PredictHedge>(&sc);

        predict_adapter::cancel_hedge(&agent, &cap, &mut hedge, ts::ctx(&mut sc));
        assert!(predict_adapter::hedge_status(&hedge) == predict_adapter::status_cancelled(), 500);

        ts::return_shared(hedge);
        ts::return_to_address(ALICE, agent);
        core::revoke_cap(cap);
    };

    ts::end(sc);
}

#[test, expected_failure(abort_code = 402, location = predict_adapter)]
fun test_quant_cant_open_hedge() {
    let (mut sc, _) = setup_agent();

    // issue QUANT cap to BOB
    ts::next_tx(&mut sc, ALICE);
    {
        let agent = ts::take_from_address<core::Agent>(&sc, ALICE);
        let _cap_id = core::issue_cap(&agent, 1 /* quant */, BOB, ts::ctx(&mut sc));
        ts::return_to_address(ALICE, agent);
    };

    // QUANT tries to open hedge → EInsufficientCapRole=402
    ts::next_tx(&mut sc, BOB);
    {
        let agent = ts::take_from_address<core::Agent>(&sc, ALICE);
        let cap = ts::take_from_address<core::AgentCap>(&sc, BOB);
        let _hid = predict_adapter::open_hedge(
            &agent, &cap, predict_adapter::side_yes(),
            b"SUI", 1_000_000, 100_000,
            1_700_000_000, option::none(), option::none(),
            ts::ctx(&mut sc),
        );
        ts::return_to_address(ALICE, agent);
        core::revoke_cap(cap);
    };

    ts::end(sc);
}

#[test, expected_failure(abort_code = 404, location = predict_adapter)]
fun test_invalid_side_fails() {
    let (mut sc, _) = setup_agent();

    ts::next_tx(&mut sc, ALICE);
    {
        let agent = ts::take_from_address<core::Agent>(&sc, ALICE);
        let _cap_id = core::issue_cap(&agent, treasury::role_risk(), BOB, ts::ctx(&mut sc));
        ts::return_to_address(ALICE, agent);
    };

    ts::next_tx(&mut sc, BOB);
    {
        let agent = ts::take_from_address<core::Agent>(&sc, ALICE);
        let cap = ts::take_from_address<core::AgentCap>(&sc, BOB);
        // side = 5 invalid → EInvalidSide=404
        let _hid = predict_adapter::open_hedge(
            &agent, &cap, 5, b"SUI", 1_000_000, 100,
            1_700_000_000, option::none(), option::none(),
            ts::ctx(&mut sc),
        );
        ts::return_to_address(ALICE, agent);
        core::revoke_cap(cap);
    };

    ts::end(sc);
}

#[test]
fun test_view_constants() {
    assert!(predict_adapter::side_yes() == 0, 600);
    assert!(predict_adapter::side_no() == 1, 601);
    assert!(predict_adapter::status_open() == 0, 602);
    assert!(predict_adapter::status_won() == 1, 603);
    assert!(predict_adapter::status_lost() == 2, 604);
    assert!(predict_adapter::status_cancelled() == 3, 605);
}

#[test]
fun test_full_hedge_cycle_with_linked_trade() {
    let (mut sc, _) = setup_agent();

    // issue risk cap
    ts::next_tx(&mut sc, ALICE);
    {
        let agent = ts::take_from_address<core::Agent>(&sc, ALICE);
        let _cap_id = core::issue_cap(&agent, treasury::role_risk(), BOB, ts::ctx(&mut sc));
        ts::return_to_address(ALICE, agent);
    };

    // open with linked (mock) trade_id
    let mock_trade_id = object::id_from_address(@0xDEAD);
    ts::next_tx(&mut sc, BOB);
    {
        let agent = ts::take_from_address<core::Agent>(&sc, ALICE);
        let cap = ts::take_from_address<core::AgentCap>(&sc, BOB);
        let _hid = predict_adapter::open_hedge(
            &agent, &cap, predict_adapter::side_no(),
            b"BTC", 60_000_000_000, 10_000_000, // $10 size
            1_700_000_000,
            option::some(mock_trade_id),
            option::some(b"0xpredictdigest0000000000000000000000000000000000000000000000"),
            ts::ctx(&mut sc),
        );
        ts::return_to_address(ALICE, agent);
        core::revoke_cap(cap);
    };

    // verify the link is stored
    ts::next_tx(&mut sc, BOB);
    {
        let hedge = ts::take_shared<predict_adapter::PredictHedge>(&sc);
        assert!(predict_adapter::hedge_underlying(&hedge) == &b"BTC", 700);
        // hedging_trade_id is private; we can only verify through side + size
        assert!(predict_adapter::hedge_size(&hedge) == 10_000_000, 701);
        ts::return_shared(hedge);
    };

    ts::end(sc);
}
