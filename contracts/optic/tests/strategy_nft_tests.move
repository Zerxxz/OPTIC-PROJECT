#[test_only]
module optic::strategy_nft_tests {
    use sui::object;
    use sui::test_scenario as ts;
    use sui::transfer;
    use sui::kiosk;
    use sui::coin;
    use sui::sui::SUI;
    use optic::strategy_nft;
    use optic::strategy_nft::{StrategyNFT, StrategyNFTRegistry};

    const AUTHOR: address = @0xA;
    const BUYER: address = @0xB;
    const KIOSK_OWNER: address = @0xC;

    fun hash32(): vector<u8> {
        let mut v = vector::empty<u8>();
        let mut i = 0;
        while (i < 32) {
            vector::push_back(&mut v, (i as u8));
            i = i + 1;
        };
        v
    }

    fun blob_id(): vector<u8> { b"walrus-blob-12345" }

    #[test]
    fun test_mint_creates_nft_and_credits_author() {
        let mut scen = ts::begin(AUTHOR);
        // Explicit init (the test framework doesn't auto-run init for new
        // modules when other modules in the same package already have init).
        strategy_nft::init_for_testing(ts::ctx(&mut scen));
        ts::next_tx(&mut scen, AUTHOR);
        let mut reg = ts::take_shared<StrategyNFTRegistry>(&scen);
        let nft_id = strategy_nft::mint(
            &mut reg,
            b"alpha-mean-reversion",
            blob_id(),
            hash32(),
            250, // 2.5% royalty
            option::none(),
            vector[b"momentum", b"v1"],
            ts::ctx(&mut scen),
        );
        assert!(strategy_nft::registry_count(&reg) == 1, 0);
        ts::return_shared(reg);
        // Commit the transfer to AUTHOR before taking from inventory.
        ts::next_tx(&mut scen, AUTHOR);
        let nft = ts::take_from_address<StrategyNFT>(&scen, AUTHOR);
        assert!(strategy_nft::nft_id(&nft) == nft_id, 1);
        assert!(strategy_nft::nft_royalty_bps(&nft) == 250, 2);
        assert!(strategy_nft::nft_author(&nft) == AUTHOR, 3);
        ts::return_to_address(AUTHOR, nft);
        ts::end(scen);
    }

    #[test]
    fun test_mint_increments_registry_counter() {
        let mut scen = ts::begin(AUTHOR);
        strategy_nft::init_for_testing(ts::ctx(&mut scen));
        ts::next_tx(&mut scen, AUTHOR);
        let mut reg = ts::take_shared<StrategyNFTRegistry>(&scen);
        assert!(strategy_nft::registry_count(&reg) == 0, 0);
        strategy_nft::mint(&mut reg, b"one", blob_id(), hash32(), 100, option::none(), vector::empty(), ts::ctx(&mut scen));
        strategy_nft::mint(&mut reg, b"two", blob_id(), hash32(), 100, option::none(), vector::empty(), ts::ctx(&mut scen));
        strategy_nft::mint(&mut reg, b"three", blob_id(), hash32(), 100, option::none(), vector::empty(), ts::ctx(&mut scen));
        assert!(strategy_nft::registry_count(&reg) == 3, 1);
        assert!(vector::length(strategy_nft::registry_nfts(&reg)) == 3, 2);
        ts::return_shared(reg);
        ts::end(scen);
    }

    #[test]
    #[expected_failure(abort_code = 0, location = optic::strategy_nft)]  // EInvalidHash
    fun test_mint_rejects_non_32_byte_hash() {
        let mut scen = ts::begin(AUTHOR);
        strategy_nft::init_for_testing(ts::ctx(&mut scen));
        ts::next_tx(&mut scen, AUTHOR);
        let mut reg = ts::take_shared<StrategyNFTRegistry>(&scen);
        strategy_nft::mint(&mut reg, b"bad", blob_id(), vector[1u8, 2u8, 3u8], 100, option::none(), vector::empty(), ts::ctx(&mut scen));
        ts::return_shared(reg);
        ts::end(scen);
    }

    #[test]
    #[expected_failure(abort_code = 3, location = optic::strategy_nft)]  // EInvalidRoyalty
    fun test_mint_rejects_royalty_above_10_pct() {
        let mut scen = ts::begin(AUTHOR);
        strategy_nft::init_for_testing(ts::ctx(&mut scen));
        ts::next_tx(&mut scen, AUTHOR);
        let mut reg = ts::take_shared<StrategyNFTRegistry>(&scen);
        // 11% = 1100 bps > 1000 cap
        strategy_nft::mint(&mut reg, b"too_greedy", blob_id(), hash32(), 1100, option::none(), vector::empty(), ts::ctx(&mut scen));
        ts::return_shared(reg);
        ts::end(scen);
    }

    #[test]
    #[expected_failure(abort_code = 1, location = optic::strategy_nft)]  // EInvalidName
    fun test_mint_rejects_short_name() {
        let mut scen = ts::begin(AUTHOR);
        strategy_nft::init_for_testing(ts::ctx(&mut scen));
        ts::next_tx(&mut scen, AUTHOR);
        let mut reg = ts::take_shared<StrategyNFTRegistry>(&scen);
        strategy_nft::mint(&mut reg, b"x", blob_id(), hash32(), 100, option::none(), vector::empty(), ts::ctx(&mut scen));
        ts::return_shared(reg);
        ts::end(scen);
    }

    #[test]
    fun test_view_functions_return_correct_fields() {
        let mut scen = ts::begin(AUTHOR);
        strategy_nft::init_for_testing(ts::ctx(&mut scen));
        ts::next_tx(&mut scen, AUTHOR);
        let mut reg = ts::take_shared<StrategyNFTRegistry>(&scen);
        let _ = strategy_nft::mint(
            &mut reg,
            b"gamma-momentum",
            b"walrus-abc",
            hash32(),
            500,
            option::some(b"gamma.sui"),
            vector[b"momentum", b"prod"],
            ts::ctx(&mut scen),
        );
        ts::return_shared(reg);
        ts::next_tx(&mut scen, AUTHOR);
        let nft = ts::take_from_address<StrategyNFT>(&scen, AUTHOR);
        assert!(vector::length(strategy_nft::nft_name(&nft)) == 14, 0); // "gamma-momentum" is 14 bytes
        assert!(strategy_nft::nft_blob_id(&nft) == &b"walrus-abc", 1);
        assert!(strategy_nft::nft_strategy_hash(&nft) == &hash32(), 2);
        assert!(vector::length(strategy_nft::nft_tags(&nft)) == 2, 3);
        ts::return_to_address(AUTHOR, nft);
        ts::end(scen);
    }
}
