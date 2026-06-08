// =============================================================================
// Tests: optic::core
// =============================================================================

#[test_only]
module optic::core_tests;

use sui::object;
use sui::test_scenario as ts;
use optic::core;

const ALICE: address = @0xA11CE;
const BOB: address = @0xB0B;
const STRATEGY_HASH: vector<u8> = b"v1:sha3:00000000000000000000000000000000";
const TREASURY_ID_BYTES: address = @0xCAFE;

#[test]
fun test_create_agent_happy_path() {
    let mut sc = ts::begin(ALICE);

    // init module (publishes registry)
    core::init_for_testing(ts::ctx(&mut sc));

    // create an agent
    ts::next_tx(&mut sc, ALICE);
    {
        let mut registry = ts::take_shared<core::AgentRegistry>(&sc);
        let treasury_id = object::id_from_address(TREASURY_ID_BYTES);
        let _agent_id = core::create_agent(
            &mut registry,
            b"alpha-1",
            STRATEGY_HASH,
            option::some(b"alpha.optic.sui"),
            1_000_000_000_000, // $1M position cap
            100_000_000_000,    // $100k daily loss
            30_000,             // 3x leverage
            treasury_id,
            ts::ctx(&mut sc),
        );
        ts::return_shared(registry);
    };

    // inspect the agent in a fresh tx
    ts::next_tx(&mut sc, ALICE);
    {
        let agent = ts::take_from_address<core::Agent>(&sc, ALICE);
        assert!(core::agent_owner(&agent) == ALICE, 100);
        assert!(core::agent_status(&agent) == core::status_active(), 101);
        assert!(core::agent_name(&agent) == &b"alpha-1", 102);
        let treasury_id = object::id_from_address(TREASURY_ID_BYTES);
        assert!(core::agent_treasury_id(&agent) == treasury_id, 103);
        assert!(core::agent_max_leverage_bps(&agent) == 30_000, 104);
        ts::return_to_address(ALICE, agent);
    };

    ts::end(sc);
}

#[test]
fun test_pause_and_resume() {
    let mut sc = ts::begin(ALICE);
    core::init_for_testing(ts::ctx(&mut sc));
    ts::next_tx(&mut sc, ALICE);

    let mut registry = ts::take_shared<core::AgentRegistry>(&sc);
    let treasury_id = object::id_from_address(TREASURY_ID_BYTES);
    core::create_agent(
        &mut registry,
        b"alpha-2",
        STRATEGY_HASH,
        option::none(),
        1_000_000,
        100_000,
        10_000,
        treasury_id,
        ts::ctx(&mut sc),
    );
    ts::return_shared(registry);

    // pause
    ts::next_tx(&mut sc, ALICE);
    {
        let mut agent = ts::take_from_address<core::Agent>(&sc, ALICE);
        core::pause(&mut agent, ts::ctx(&mut sc));
        assert!(core::agent_status(&agent) == core::status_paused(), 200);
        ts::return_to_address(ALICE, agent);
    };

    // resume
    ts::next_tx(&mut sc, ALICE);
    {
        let mut agent = ts::take_from_address<core::Agent>(&sc, ALICE);
        core::resume(&mut agent, ts::ctx(&mut sc));
        assert!(core::agent_status(&agent) == core::status_active(), 201);
        ts::return_to_address(ALICE, agent);
    };

    ts::end(sc);
}

#[test, expected_failure(abort_code = 5, location = core)]
fun test_pause_already_paused_fails() {
    let mut sc = ts::begin(ALICE);
    core::init_for_testing(ts::ctx(&mut sc));
    ts::next_tx(&mut sc, ALICE);

    let mut registry = ts::take_shared<core::AgentRegistry>(&sc);
    let treasury_id = object::id_from_address(TREASURY_ID_BYTES);
    core::create_agent(
        &mut registry,
        b"x",
        STRATEGY_HASH,
        option::none(),
        1, 1, 10_000,
        treasury_id,
        ts::ctx(&mut sc),
    );
    ts::return_shared(registry);

    // first pause in one tx
    ts::next_tx(&mut sc, ALICE);
    {
        let mut agent = ts::take_from_address<core::Agent>(&sc, ALICE);
        core::pause(&mut agent, ts::ctx(&mut sc));
        ts::return_to_address(ALICE, agent);
    };

    // second pause in a new tx — must abort EAgentNotActive=0
    ts::next_tx(&mut sc, ALICE);
    {
        let mut agent = ts::take_from_address<core::Agent>(&sc, ALICE);
        core::pause(&mut agent, ts::ctx(&mut sc));
        ts::return_to_address(ALICE, agent);
    };

    ts::end(sc);
}

#[test, expected_failure(abort_code = 3, location = core)]
fun test_pause_by_non_owner_fails() {
    let mut sc = ts::begin(ALICE);
    core::init_for_testing(ts::ctx(&mut sc));
    ts::next_tx(&mut sc, ALICE);

    let mut registry = ts::take_shared<core::AgentRegistry>(&sc);
    let treasury_id = object::id_from_address(TREASURY_ID_BYTES);
    core::create_agent(
        &mut registry,
        b"x",
        STRATEGY_HASH,
        option::none(),
        1, 1, 10_000,
        treasury_id,
        ts::ctx(&mut sc),
    );
    ts::return_shared(registry);

    // BOB tries to pause — must abort ENotAuthorized=3
    ts::next_tx(&mut sc, BOB);
    let mut agent = ts::take_from_address<core::Agent>(&sc, ALICE);
    core::pause(&mut agent, ts::ctx(&mut sc));
    ts::return_to_address(ALICE, agent);
    ts::end(sc);
}

#[test]
fun test_issue_cap_and_revoke() {
    let mut sc = ts::begin(ALICE);
    core::init_for_testing(ts::ctx(&mut sc));
    ts::next_tx(&mut sc, ALICE);

    let mut registry = ts::take_shared<core::AgentRegistry>(&sc);
    let treasury_id = object::id_from_address(TREASURY_ID_BYTES);
    let agent_id = core::create_agent(
        &mut registry,
        b"cap-test",
        STRATEGY_HASH,
        option::none(),
        1, 1, 10_000,
        treasury_id,
        ts::ctx(&mut sc),
    );
    ts::return_shared(registry);

    ts::next_tx(&mut sc, ALICE);
    {
        let agent = ts::take_from_address<core::Agent>(&sc, ALICE);
        let _cap_id = core::issue_cap(&agent, 3 /* executor */, BOB, ts::ctx(&mut sc));
        ts::return_to_address(ALICE, agent);

        // BOB receives the cap
        ts::next_tx(&mut sc, BOB);
        let cap = ts::take_from_address<core::AgentCap>(&sc, BOB);
        assert!(core::cap_agent_id(&cap) == agent_id, 300);
        assert!(core::cap_role(&cap) == 3, 301);
        core::revoke_cap(cap);
    };

    ts::end(sc);
}

#[test]
fun test_record_trade_updates_pnl() {
    let mut sc = ts::begin(ALICE);
    core::init_for_testing(ts::ctx(&mut sc));
    ts::next_tx(&mut sc, ALICE);

    let mut registry = ts::take_shared<core::AgentRegistry>(&sc);
    let treasury_id = object::id_from_address(TREASURY_ID_BYTES);
    let _agent_id = core::create_agent(
        &mut registry,
        b"pnl-test",
        STRATEGY_HASH,
        option::none(),
        1_000_000, 100_000, 10_000,
        treasury_id,
        ts::ctx(&mut sc),
    );
    ts::return_shared(registry);

    ts::next_tx(&mut sc, ALICE);
    {
        let mut agent = ts::take_from_address<core::Agent>(&sc, ALICE);
        let mut pnl = ts::take_shared<core::PnL>(&sc);
        // record a positive trade: +500_000 u6
        core::record_trade(
            &mut pnl,
            &mut agent,
            500_000,
            core::sign_pos(),
            1_000_000,
            ts::ctx(&mut sc),
        );
        assert!(core::pnl_realized(&pnl) == 500_000, 400);
        assert!(core::pnl_trade_count(&pnl) == 1, 401);
        assert!(core::pnl_volume(&pnl) == 1_000_000, 402);

        // record a small loss
        core::record_trade(
            &mut pnl,
            &mut agent,
            200_000,
            core::sign_neg(),
            500_000,
            ts::ctx(&mut sc),
        );
        assert!(core::pnl_realized(&pnl) == 300_000, 403);
        assert!(core::pnl_trade_count(&pnl) == 2, 404);
        assert!(core::pnl_volume(&pnl) == 1_500_000, 405);

        ts::return_shared(pnl);
        ts::return_to_address(ALICE, agent);
    };

    ts::end(sc);
}

#[test]
fun test_strategy_hash_change() {
    let mut sc = ts::begin(ALICE);
    core::init_for_testing(ts::ctx(&mut sc));
    ts::next_tx(&mut sc, ALICE);

    let mut registry = ts::take_shared<core::AgentRegistry>(&sc);
    let treasury_id = object::id_from_address(TREASURY_ID_BYTES);
    core::create_agent(
        &mut registry,
        b"hash-test",
        STRATEGY_HASH,
        option::none(),
        1, 1, 10_000,
        treasury_id,
        ts::ctx(&mut sc),
    );
    ts::return_shared(registry);

    ts::next_tx(&mut sc, ALICE);
    {
        let mut agent = ts::take_from_address<core::Agent>(&sc, ALICE);
        let new_hash = b"v2:sha3:deadbeef000000000000000000000000";
        let new_blob = option::some(object::id_from_address(@0xBEEF));
        core::update_strategy_hash(&mut agent, new_hash, new_blob, ts::ctx(&mut sc));
        assert!(core::agent_strategy_hash(&agent) == &new_hash, 500);
        let blob_opt = core::agent_strategy_blob_id(&agent);
        assert!(option::is_some(&blob_opt), 501);
        ts::return_to_address(ALICE, agent);
    };

    ts::end(sc);
}

#[test, expected_failure(abort_code = 5, location = core)]
fun test_over_leverage_fails() {
    let mut sc = ts::begin(ALICE);
    core::init_for_testing(ts::ctx(&mut sc));
    ts::next_tx(&mut sc, ALICE);

    let mut registry = ts::take_shared<core::AgentRegistry>(&sc);
    let treasury_id = object::id_from_address(TREASURY_ID_BYTES);
    // 200_000 bps = 20x leverage, exceeds 10x cap → EInvalidStatus=5
    core::create_agent(
        &mut registry,
        b"yolo",
        STRATEGY_HASH,
        option::none(),
        1, 1, 200_000,
        treasury_id,
        ts::ctx(&mut sc),
    );
    ts::return_shared(registry);
    ts::end(sc);
}
