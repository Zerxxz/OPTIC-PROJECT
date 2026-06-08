// =============================================================================
// Tests: optic::treasury
// =============================================================================

#[test_only]
module optic::treasury_tests;

use sui::coin;
use sui::object;
use sui::test_scenario as ts;
use optic::core;
use optic::treasury;

public struct USDC has drop {}

const ALICE: address = @0xA11CE;
const BOB: address = @0xB0B;
const STRATEGY_HASH: vector<u8> = b"v1:sha3:00000000000000000000000000000000";
const TREASURY_ID_BYTES: address = @0xCAFE;

fun fresh_scenario_with_agent_and_treasury(
    per_tx_cap: u64,
    max_position: u64,
    max_daily_loss: u64,
): (ts::Scenario, ID) {
    let mut sc = ts::begin(ALICE);
    core::init_for_testing(ts::ctx(&mut sc));
    ts::next_tx(&mut sc, ALICE);

    let mut registry = ts::take_shared<core::AgentRegistry>(&sc);
    let treasury_id_placeholder = object::id_from_address(TREASURY_ID_BYTES);
    let agent_id = core::create_agent(
        &mut registry,
        b"treasury-test",
        STRATEGY_HASH,
        option::none(),
        max_position,
        max_daily_loss,
        30_000,
        treasury_id_placeholder,
        ts::ctx(&mut sc),
    );
    ts::return_shared(registry);

    // create the treasury
    ts::next_tx(&mut sc, ALICE);
    {
        let agent = ts::take_from_address<core::Agent>(&sc, ALICE);
        let _tid = treasury::create_treasury<USDC>(&agent, per_tx_cap, ts::ctx(&mut sc));
        ts::return_to_address(ALICE, agent);
    };

    (sc, agent_id)
}

#[test]
fun test_create_treasury_and_deposit() {
    let (mut sc, _agent_id) = fresh_scenario_with_agent_and_treasury(1_000_000, 1_000_000, 1_000_000);

    // deposit 500_000 u6
    ts::next_tx(&mut sc, ALICE);
    {
        let mut treasury_obj = ts::take_shared<treasury::Treasury<USDC>>(&sc);
        let agent = ts::take_from_address<core::Agent>(&sc, ALICE);
        let payment = coin::mint_for_testing<USDC>(500_000, ts::ctx(&mut sc));
        treasury::deposit(&mut treasury_obj, &agent, payment, ts::ctx(&mut sc));
        assert!(treasury::balance(&treasury_obj) == 500_000, 100);
        assert!(treasury::lifetime_deposited(&treasury_obj) == 500_000, 101);
        ts::return_shared(treasury_obj);
        ts::return_to_address(ALICE, agent);
    };

    ts::end(sc);
}

#[test]
fun test_owner_can_withdraw_full_balance() {
    let (mut sc, _agent_id) = fresh_scenario_with_agent_and_treasury(100_000, 1_000_000, 1_000_000);

    ts::next_tx(&mut sc, ALICE);
    {
        let mut treasury_obj = ts::take_shared<treasury::Treasury<USDC>>(&sc);
        let agent = ts::take_from_address<core::Agent>(&sc, ALICE);
        let payment = coin::mint_for_testing<USDC>(1_000_000, ts::ctx(&mut sc));
        treasury::deposit(&mut treasury_obj, &agent, payment, ts::ctx(&mut sc));

        // owner can withdraw everything, bypassing per-tx cap
        let taken = treasury::withdraw_by_owner<USDC>(
            &mut treasury_obj, &agent, 1_000_000, ts::ctx(&mut sc),
        );
        assert!(coin::value(&taken) == 1_000_000, 200);
        assert!(treasury::balance(&treasury_obj) == 0, 201);
        coin::burn_for_testing(taken);

        ts::return_shared(treasury_obj);
        ts::return_to_address(ALICE, agent);
    };

    ts::end(sc);
}

#[test]
fun test_executor_cap_withdraw() {
    let (mut sc, _agent_id) = fresh_scenario_with_agent_and_treasury(200_000, 500_000, 500_000);

    // deposit + issue executor cap to BOB
    ts::next_tx(&mut sc, ALICE);
    {
        let mut treasury_obj = ts::take_shared<treasury::Treasury<USDC>>(&sc);
        let mut agent = ts::take_from_address<core::Agent>(&sc, ALICE);
        let payment = coin::mint_for_testing<USDC>(500_000, ts::ctx(&mut sc));
        treasury::deposit(&mut treasury_obj, &agent, payment, ts::ctx(&mut sc));

        // issue executor cap to BOB
        let _cap_id = core::issue_cap(&agent, treasury::role_executor(), BOB, ts::ctx(&mut sc));

        ts::return_shared(treasury_obj);
        ts::return_to_address(ALICE, agent);
    };

    // BOB withdraws 100_000 with executor cap (under both caps)
    ts::next_tx(&mut sc, BOB);
    {
        let mut treasury_obj = ts::take_shared<treasury::Treasury<USDC>>(&sc);
        let mut agent = ts::take_from_address<core::Agent>(&sc, ALICE);
        let cap = ts::take_from_address<core::AgentCap>(&sc, BOB);

        let taken = treasury::withdraw_by_cap<USDC>(
            &mut treasury_obj, &mut agent, &cap, 100_000, ts::ctx(&mut sc),
        );
        assert!(coin::value(&taken) == 100_000, 300);
        assert!(treasury::balance(&treasury_obj) == 400_000, 301);
        coin::burn_for_testing(taken);

        ts::return_shared(treasury_obj);
        ts::return_to_address(ALICE, agent);
        core::revoke_cap(cap);
    };

    ts::end(sc);
}

#[test, expected_failure(abort_code = 104, location = treasury)]
fun test_cap_withdraw_exceeds_per_tx_cap() {
    let (mut sc, _) = fresh_scenario_with_agent_and_treasury(50_000, 1_000_000, 1_000_000);

    ts::next_tx(&mut sc, ALICE);
    {
        let mut treasury_obj = ts::take_shared<treasury::Treasury<USDC>>(&sc);
        let mut agent = ts::take_from_address<core::Agent>(&sc, ALICE);
        let payment = coin::mint_for_testing<USDC>(500_000, ts::ctx(&mut sc));
        treasury::deposit(&mut treasury_obj, &agent, payment, ts::ctx(&mut sc));
        let _cap_id = core::issue_cap(&agent, treasury::role_executor(), ALICE, ts::ctx(&mut sc));
        ts::return_shared(treasury_obj);
        ts::return_to_address(ALICE, agent);
    };

    ts::next_tx(&mut sc, ALICE);
    {
        let mut treasury_obj = ts::take_shared<treasury::Treasury<USDC>>(&sc);
        let mut agent = ts::take_from_address<core::Agent>(&sc, ALICE);
        let cap = ts::take_from_address<core::AgentCap>(&sc, ALICE);
        // 100_000 > per_tx_cap=50_000 → EExceedsPositionLimit=104
        let taken = treasury::withdraw_by_cap<USDC>(
            &mut treasury_obj, &mut agent, &cap, 100_000, ts::ctx(&mut sc),
        );
        coin::burn_for_testing(taken);
        ts::return_shared(treasury_obj);
        ts::return_to_address(ALICE, agent);
        core::revoke_cap(cap);
    };

    ts::end(sc);
}

#[test, expected_failure(abort_code = 103, location = treasury)]
fun test_owner_withdraw_over_balance() {
    let (mut sc, _) = fresh_scenario_with_agent_and_treasury(1_000_000, 1_000_000, 1_000_000);

    ts::next_tx(&mut sc, ALICE);
    {
        let mut treasury_obj = ts::take_shared<treasury::Treasury<USDC>>(&sc);
        let agent = ts::take_from_address<core::Agent>(&sc, ALICE);
        let payment = coin::mint_for_testing<USDC>(100, ts::ctx(&mut sc));
        treasury::deposit(&mut treasury_obj, &agent, payment, ts::ctx(&mut sc));
        // try withdraw 200 with only 100 in balance → EInsufficientBalance=103
        let taken = treasury::withdraw_by_owner<USDC>(
            &mut treasury_obj, &agent, 200, ts::ctx(&mut sc),
        );
        coin::burn_for_testing(taken);
        ts::return_shared(treasury_obj);
        ts::return_to_address(ALICE, agent);
    };

    ts::end(sc);
}

#[test, expected_failure(abort_code = 100, location = treasury)]
fun test_non_owner_cannot_create_treasury() {
    let mut sc = ts::begin(BOB);
    core::init_for_testing(ts::ctx(&mut sc));
    ts::next_tx(&mut sc, ALICE);

    // ALICE creates an agent — but we need the agent owned by BOB for the test
    // workaround: BOB creates agent first, then we test.
    // Simpler: have BOB be the sender and try to make a treasury against ALICE's agent.
    // We'll create a fresh agent owned by BOB via trick — actually simpler: have ALICE own agent, BOB calls.
    let mut registry = ts::take_shared<core::AgentRegistry>(&sc);
    let treasury_id_placeholder = object::id_from_address(TREASURY_ID_BYTES);
    core::create_agent(
        &mut registry,
        b"x", STRATEGY_HASH, option::none(),
        1, 1, 10_000,
        treasury_id_placeholder,
        ts::ctx(&mut sc),
    );
    ts::return_shared(registry);

    ts::next_tx(&mut sc, BOB);
    {
        let agent = ts::take_from_address<core::Agent>(&sc, ALICE);
        // BOB tries to create treasury on ALICE's agent → ENotOwner=100
        let _tid = treasury::create_treasury<USDC>(&agent, 100, ts::ctx(&mut sc));
        ts::return_to_address(ALICE, agent);
    };

    ts::end(sc);
}

#[test]
fun test_deposit_return() {
    let (mut sc, _) = fresh_scenario_with_agent_and_treasury(1_000_000, 1_000_000, 1_000_000);

    ts::next_tx(&mut sc, ALICE);
    {
        let mut treasury_obj = ts::take_shared<treasury::Treasury<USDC>>(&sc);
        let agent = ts::take_from_address<core::Agent>(&sc, ALICE);
        let initial = coin::mint_for_testing<USDC>(100_000, ts::ctx(&mut sc));
        treasury::deposit(&mut treasury_obj, &agent, initial, ts::ctx(&mut sc));

        // simulate a closed trade returning 120_000 (a 20% gain)
        let proceeds = coin::mint_for_testing<USDC>(120_000, ts::ctx(&mut sc));
        treasury::deposit_return<USDC>(&mut treasury_obj, &agent, proceeds, ts::ctx(&mut sc));

        assert!(treasury::balance(&treasury_obj) == 220_000, 400);
        assert!(treasury::lifetime_deposited(&treasury_obj) == 220_000, 401);

        ts::return_shared(treasury_obj);
        ts::return_to_address(ALICE, agent);
    };

    ts::end(sc);
}

#[test]
fun test_set_per_tx_cap() {
    let (mut sc, _) = fresh_scenario_with_agent_and_treasury(100, 1_000_000, 1_000_000);

    ts::next_tx(&mut sc, ALICE);
    {
        let mut treasury_obj = ts::take_shared<treasury::Treasury<USDC>>(&sc);
        let agent = ts::take_from_address<core::Agent>(&sc, ALICE);
        assert!(treasury::per_tx_cap(&treasury_obj) == 100, 500);
        treasury::set_per_tx_cap<USDC>(&mut treasury_obj, &agent, 999, ts::ctx(&mut sc));
        assert!(treasury::per_tx_cap(&treasury_obj) == 999, 501);
        ts::return_shared(treasury_obj);
        ts::return_to_address(ALICE, agent);
    };

    ts::end(sc);
}

#[test]
fun test_view_functions() {
    let (mut sc, _) = fresh_scenario_with_agent_and_treasury(123, 456, 789);

    ts::next_tx(&mut sc, ALICE);
    {
        let treasury_obj = ts::take_shared<treasury::Treasury<USDC>>(&sc);
        assert!(treasury::balance(&treasury_obj) == 0, 600);
        assert!(treasury::per_tx_cap(&treasury_obj) == 123, 601);
        assert!(treasury::daily_withdrawn(&treasury_obj) == 0, 602);
        assert!(treasury::lifetime_deposited(&treasury_obj) == 0, 603);
        assert!(treasury::lifetime_withdrawn(&treasury_obj) == 0, 604);
        ts::return_shared(treasury_obj);
    };

    ts::end(sc);
}

#[test]
fun test_role_constants() {
    assert!(treasury::role_full() == 0, 700);
    assert!(treasury::role_executor() == 3, 701);
    assert!(treasury::role_risk() == 2, 702);
}
