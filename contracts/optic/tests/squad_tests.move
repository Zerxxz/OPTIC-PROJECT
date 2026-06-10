#[test_only]
module optic::squad_tests {
    use sui::object;
    use sui::test_scenario as ts;
    use optic::squad;
    use optic::squad::{Squad, Proposal};

    const ADMIN: address = @0xA;
    const AGENT1: address = @0xB;
    const AGENT2: address = @0xC;
    const AGENT3: address = @0xD;

    fun fake_id(seed: u8): object::ID {
        object::id_from_address(
            sui::address::from_u256((seed as u256)),
        )
    }

    fun treasury_id(): object::ID { fake_id(99) }

    #[test]
    fun test_create_squad_default_state() {
        let mut scen = ts::begin(ADMIN);
        ts::next_tx(&mut scen, ADMIN);
        let squad_id = squad::create_squad(
            b"alpha-squad",
            treasury_id(),
            5_000, // 50% quorum
            6_000, // 60% pass
            ts::ctx(&mut scen),
        );
        assert!(squad_id != sui::object::id_from_address(@0x0), 0);
        ts::next_tx(&mut scen, ADMIN);
        let s = ts::take_shared<Squad>(&scen);
        assert!(squad::squad_member_count(&s) == 0, 1);
        assert!(squad::squad_cycle(&s) == 0, 2);
        assert!(squad::squad_quorum_bps(&s) == 5_000, 3);
        assert!(squad::squad_pass_threshold_bps(&s) == 6_000, 4);
        assert!(squad::squad_status(&s) == 0, 5);
        ts::return_shared(s);
        ts::end(scen);
    }

    #[test]
    fun test_add_member_increments_count() {
        let mut scen = ts::begin(ADMIN);
        ts::next_tx(&mut scen, ADMIN);
        let _ = squad::create_squad(b"s", treasury_id(), 5_000, 6_000, ts::ctx(&mut scen));
        ts::next_tx(&mut scen, ADMIN);
        let mut s = ts::take_shared<Squad>(&scen);
        squad::add_member(&mut s, fake_id(1), 100, ts::ctx(&mut scen));
        squad::add_member(&mut s, fake_id(2), 200, ts::ctx(&mut scen));
        squad::add_member(&mut s, fake_id(3), 300, ts::ctx(&mut scen));
        assert!(squad::squad_member_count(&s) == 3, 0);
        assert!(squad::squad_sharpe_of(&s, fake_id(1)) == 100, 1);
        assert!(squad::squad_sharpe_of(&s, fake_id(2)) == 200, 2);
        assert!(squad::squad_sharpe_of(&s, fake_id(3)) == 300, 3);
        ts::return_shared(s);
        ts::end(scen);
    }

    #[test]
    #[expected_failure(abort_code = 3, location = optic::squad)]  // EAlreadyMember
    fun test_add_member_rejects_duplicate() {
        let mut scen = ts::begin(ADMIN);
        ts::next_tx(&mut scen, ADMIN);
        let _ = squad::create_squad(b"s", treasury_id(), 5_000, 6_000, ts::ctx(&mut scen));
        ts::next_tx(&mut scen, ADMIN);
        let mut s = ts::take_shared<Squad>(&scen);
        squad::add_member(&mut s, fake_id(1), 100, ts::ctx(&mut scen));
        squad::add_member(&mut s, fake_id(1), 999, ts::ctx(&mut scen));
        ts::return_shared(s);
        ts::end(scen);
    }

    #[test]
    fun test_update_member_weight() {
        let mut scen = ts::begin(ADMIN);
        ts::next_tx(&mut scen, ADMIN);
        let _ = squad::create_squad(b"s", treasury_id(), 5_000, 6_000, ts::ctx(&mut scen));
        ts::next_tx(&mut scen, ADMIN);
        let mut s = ts::take_shared<Squad>(&scen);
        squad::add_member(&mut s, fake_id(1), 100, ts::ctx(&mut scen));
        squad::update_member_weight(&mut s, fake_id(1), 999);
        assert!(squad::squad_sharpe_of(&s, fake_id(1)) == 999, 0);
        ts::return_shared(s);
        ts::end(scen);
    }

    #[test]
    fun test_open_proposal_increments_cycle() {
        let mut scen = ts::begin(ADMIN);
        ts::next_tx(&mut scen, ADMIN);
        let _ = squad::create_squad(b"s", treasury_id(), 5_000, 6_000, ts::ctx(&mut scen));
        ts::next_tx(&mut scen, ADMIN);
        let mut s = ts::take_shared<Squad>(&scen);
        squad::add_member(&mut s, fake_id(1), 100, ts::ctx(&mut scen));
        assert!(squad::squad_cycle(&s) == 0, 0);
        let p1_id = squad::open_proposal(&mut s, 0, vector[1u8, 2u8, 3u8], ts::ctx(&mut scen));
        let p2_id = squad::open_proposal(&mut s, 2, vector[4u8, 5u8], ts::ctx(&mut scen));
        assert!(p1_id != p2_id, 1);
        assert!(squad::squad_cycle(&s) == 2, 2);
        ts::return_shared(s);
        ts::end(scen);
    }

    #[test]
    fun test_proposal_passes_when_weighted_yes_above_threshold() {
        let mut scen = ts::begin(ADMIN);
        ts::next_tx(&mut scen, ADMIN);
        let _ = squad::create_squad(b"s", treasury_id(), 5_000, 6_000, ts::ctx(&mut scen));
        ts::next_tx(&mut scen, ADMIN);
        let mut s = ts::take_shared<Squad>(&scen);
        // 3 members, weights 100/200/300, total 600
        squad::add_member(&mut s, fake_id(1), 100, ts::ctx(&mut scen));
        squad::add_member(&mut s, fake_id(2), 200, ts::ctx(&mut scen));
        squad::add_member(&mut s, fake_id(3), 300, ts::ctx(&mut scen));
        let p_id = squad::open_proposal(&mut s, 0, vector::empty(), ts::ctx(&mut scen));
        ts::next_tx(&mut scen, ADMIN);
        // Cast votes (take → cast → return per vote).
        {
            let mut p = ts::take_shared_by_id<Proposal>(&scen, p_id);
            squad::cast_vote(&mut p, &s, fake_id(1), true, ts::ctx(&mut scen));
            ts::return_shared(p);
        };
        ts::next_tx(&mut scen, ADMIN);
        {
            let mut p = ts::take_shared_by_id<Proposal>(&scen, p_id);
            squad::cast_vote(&mut p, &s, fake_id(3), true, ts::ctx(&mut scen));
            ts::return_shared(p);
        };
        ts::next_tx(&mut scen, ADMIN);
        {
            let mut p = ts::take_shared_by_id<Proposal>(&scen, p_id);
            squad::cast_vote(&mut p, &s, fake_id(2), false, ts::ctx(&mut scen));
            ts::return_shared(p);
        };
        ts::next_tx(&mut scen, ADMIN);
        let mut p = ts::take_shared_by_id<Proposal>(&scen, p_id);
        squad::resolve_proposal(&mut p, &s, ts::ctx(&mut scen));
        assert!(squad::proposal_outcome(&p) == 1, 0); // 1 = pass
        assert!(squad::proposal_weighted_yes(&p) == 400, 1);
        assert!(squad::proposal_weighted_no(&p) == 200, 2);
        ts::return_shared(p);
        ts::return_shared(s);
        ts::end(scen);
    }

    #[test]
    fun test_proposal_fails_when_below_quorum() {
        let mut scen = ts::begin(ADMIN);
        ts::next_tx(&mut scen, ADMIN);
        let _ = squad::create_squad(b"s", treasury_id(), 5_000, 6_000, ts::ctx(&mut scen));
        ts::next_tx(&mut scen, ADMIN);
        let mut s = ts::take_shared<Squad>(&scen);
        // 4 members, weights 100 each (total 400)
        squad::add_member(&mut s, fake_id(1), 100, ts::ctx(&mut scen));
        squad::add_member(&mut s, fake_id(2), 100, ts::ctx(&mut scen));
        squad::add_member(&mut s, fake_id(3), 100, ts::ctx(&mut scen));
        squad::add_member(&mut s, fake_id(4), 100, ts::ctx(&mut scen));
        let p_id = squad::open_proposal(&mut s, 0, vector::empty(), ts::ctx(&mut scen));
        ts::next_tx(&mut scen, ADMIN);
        // Only 1 votes yes = 100/400 = 25% < 50% quorum → fail
        {
            let mut p = ts::take_shared_by_id<Proposal>(&scen, p_id);
            squad::cast_vote(&mut p, &s, fake_id(1), true, ts::ctx(&mut scen));
            ts::return_shared(p);
        };
        ts::next_tx(&mut scen, ADMIN);
        let mut p = ts::take_shared_by_id<Proposal>(&scen, p_id);
        squad::resolve_proposal(&mut p, &s, ts::ctx(&mut scen));
        assert!(squad::proposal_outcome(&p) == 0, 0); // 0 = fail
        ts::return_shared(p);
        ts::return_shared(s);
        ts::end(scen);
    }

    #[test]
    #[expected_failure(abort_code = 5, location = optic::squad)]  // EAlreadyVoted
    fun test_double_vote_rejected() {
        let mut scen = ts::begin(ADMIN);
        ts::next_tx(&mut scen, ADMIN);
        let _ = squad::create_squad(b"s", treasury_id(), 5_000, 6_000, ts::ctx(&mut scen));
        ts::next_tx(&mut scen, ADMIN);
        let mut s = ts::take_shared<Squad>(&scen);
        squad::add_member(&mut s, fake_id(1), 100, ts::ctx(&mut scen));
        let p_id = squad::open_proposal(&mut s, 0, vector::empty(), ts::ctx(&mut scen));
        ts::next_tx(&mut scen, ADMIN);
        let mut p = ts::take_shared_by_id<Proposal>(&scen, p_id);
        squad::cast_vote(&mut p, &s, fake_id(1), true, ts::ctx(&mut scen));
        // Same voter tries to vote again → EAlreadyVoted.
        squad::cast_vote(&mut p, &s, fake_id(1), false, ts::ctx(&mut scen));
        ts::return_shared(p);
        ts::return_shared(s);
        ts::end(scen);
    }
}
