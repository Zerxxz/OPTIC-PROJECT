// =============================================================================
// Module: optic::strategy_nft
// -----------------------------------------------------------------------------
// Wraps a Walrus-published strategy blob as a transferable, licensable
// Sui Kiosk item (NFT). The strategy is identified by its sha256 hash
// (uploaded as a Walrus blob) and minted as a `StrategyNFT` object.
//
// Lifecycle:
//   1. Owner uploads strategy JSON to Walrus → gets a blob_id
//   2. Owner calls `mint_strategy_nft(name, blob_id, sha256)` → gets a
//      `StrategyNFT` object transferred to their account.
//   3. Owner can list the NFT in a Sui Kiosk for trading/licensing.
//   4. A `RoyaltyRule` (TransferPolicy) can charge a basis-points royalty
//      on every transfer (set at mint time, enforced by the kiosk rules).
//
// Why this matters:
//   - Strategies become first-class tradable IP.
//   - Forking a strategy = buying the NFT.
//   - Strategy authors earn royalties every time their strategy is reused.
// =============================================================================

module optic::strategy_nft;

use sui::event;
use sui::object::{Self, ID, UID};
use sui::transfer;
use sui::tx_context::{Self, TxContext};
use sui::kiosk::{Self, Kiosk, KioskOwnerCap};

// -----------------------------------------------------------------------------
// Error codes
// -----------------------------------------------------------------------------

const EInvalidHash: u64 = 0;
const EInvalidName: u64 = 1;
const EInvalidBlobId: u64 = 2;
const EInvalidRoyalty: u64 = 3;
const ENotOwner: u64 = 4;
const ENotKioskOwner: u64 = 5;

// -----------------------------------------------------------------------------
// Objects
// -----------------------------------------------------------------------------

/// A StrategyNFT — a transferrable on-chain representation of a strategy.
/// The actual strategy code lives in a Walrus blob; this object holds
/// only the metadata + the canonical identity (sha256 + blob_id).
public struct StrategyNFT has key, store {
    id: UID,
    /// Human-friendly name.
    name: vector<u8>,
    /// Walrus blob id (string-encoded).
    blob_id: vector<u8>,
    /// sha256 of the strategy JSON.
    strategy_hash: vector<u8>,
    /// Author (creator) address.
    author: address,
    /// Royalty in basis points (10_000 = 100%). 0 = no royalty.
    royalty_bps: u64,
    /// Minted-at timestamp (ms since epoch).
    minted_at_ms: u64,
    /// Optional SuiNS name (e.g. b"alpha.sui").
    suins_name: Option<vector<u8>>,
    /// Tags for discoverability.
    tags: vector<vector<u8>>,
}

/// A registry of all minted StrategyNFTs (off-chain indexers can use this
/// to power a marketplace UI). Optional — Sui Kiosk is the source of truth
/// for ownership.
public struct StrategyNFTRegistry has key {
    id: UID,
    /// Admin who can add/remove.
    admin: address,
    /// Vector of all minted strategy NFT ids.
    nfts: vector<ID>,
    /// Total minted.
    total_minted: u64,
}

// -----------------------------------------------------------------------------
// Events
// -----------------------------------------------------------------------------

public struct StrategyNFTMinted has copy, drop {
    nft_id: ID,
    author: address,
    name: vector<u8>,
    blob_id: vector<u8>,
    royalty_bps: u64,
    at_ms: u64,
}

public struct StrategyNFTListed has copy, drop {
    nft_id: ID,
    kiosk_id: ID,
    price: u64,
    at_ms: u64,
}

public struct StrategyNFTRoyaltyPaid has copy, drop {
    nft_id: ID,
    from: address,
    to: address,
    amount: u64,
    at_ms: u64,
}

// -----------------------------------------------------------------------------
// Init
// -----------------------------------------------------------------------------

fun init(ctx: &mut TxContext) {
    let registry = StrategyNFTRegistry {
        id: object::new(ctx),
        admin: tx_context::sender(ctx),
        nfts: vector<ID>[],
        total_minted: 0,
    };
    transfer::share_object(registry);
}

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    init(ctx)
}

// -----------------------------------------------------------------------------
// Mint
// -----------------------------------------------------------------------------

/// Mint a new StrategyNFT. The blob_id + sha256 must match; the contract
/// doesn't verify against Walrus (that would require an off-chain indexer),
/// but the sha256 is the canonical identity that the Move core module
/// stores on the Agent object.
public fun mint(
    registry: &mut StrategyNFTRegistry,
    name: vector<u8>,
    blob_id: vector<u8>,
    strategy_hash: vector<u8>,
    royalty_bps: u64,
    suins_name: Option<vector<u8>>,
    tags: vector<vector<u8>>,
    ctx: &mut TxContext,
): ID {
    assert!(vector::length(&name) >= 3, EInvalidName);
    assert!(vector::length(&name) <= 64, EInvalidName);
    assert!(vector::length(&blob_id) >= 4, EInvalidBlobId);
    assert!(vector::length(&strategy_hash) == 32, EInvalidHash); // sha256 → 32 bytes
    assert!(royalty_bps <= 1_000, EInvalidRoyalty); // max 10% royalty

    let now = tx_context::epoch_timestamp_ms(ctx);
    let nft_uid = object::new(ctx);
    let nft_id = object::uid_to_inner(&nft_uid);

    let nft = StrategyNFT {
        id: nft_uid,
        name,
        blob_id,
        strategy_hash,
        author: tx_context::sender(ctx),
        royalty_bps,
        minted_at_ms: now,
        suins_name,
        tags,
    };

    event::emit(StrategyNFTMinted {
        nft_id,
        author: tx_context::sender(ctx),
        name: nft.name,
        blob_id: nft.blob_id,
        royalty_bps,
        at_ms: now,
    });

    vector::push_back(&mut registry.nfts, nft_id);
    registry.total_minted = registry.total_minted + 1;

    transfer::public_transfer(nft, tx_context::sender(ctx));
    nft_id
}

// -----------------------------------------------------------------------------
// Kiosk listing
// -----------------------------------------------------------------------------

/// Place a StrategyNFT into a Sui Kiosk and list it for sale.
/// Returns the KioskListing-style object id from the Kiosk.
public fun place_and_list_in_kiosk(
    nft: StrategyNFT,
    kiosk: &mut Kiosk,
    kiosk_cap: &KioskOwnerCap,
    price: u64,
    ctx: &mut TxContext,
) {
    assert!(nft.author == tx_context::sender(ctx), ENotOwner);
    let nft_id = object::id(&nft);
    kiosk::place(kiosk, kiosk_cap, nft);
    kiosk::list<StrategyNFT>(kiosk, kiosk_cap, nft_id, price);

    event::emit(StrategyNFTListed {
        nft_id,
        kiosk_id: object::id(kiosk),
        price,
        at_ms: tx_context::epoch_timestamp_ms(ctx),
    });
}

/// Withdraw a StrategyNFT from a Kiosk (only the kiosk owner can).
public fun withdraw_from_kiosk(
    kiosk: &mut Kiosk,
    kiosk_cap: &KioskOwnerCap,
    nft_id: ID,
    ctx: &mut TxContext,
): StrategyNFT {
    kiosk::take<StrategyNFT>(kiosk, kiosk_cap, nft_id)
}

// -----------------------------------------------------------------------------
// Royalty policy
// -----------------------------------------------------------------------------
//
// Royalty policies in Sui require a `Publisher` object tied to the
// package that defines the type. Because StrategyNFT is defined here
// (in the same package as this module), the Publisher is implicitly
// available to the package admin. We expose a thin convenience wrapper
// so the off-chain SDK can call it after `package::claim_publisher`.
//
// For simplicity in the MVP, we omit a full royalty rule. The royalty
// rate is stored on the NFT as `royalty_bps`; the off-chain Kiosk
// integration can check this value before completing a purchase and
// route the royalty payment to the author via a separate transfer.

public fun royalty_bps(nft: &StrategyNFT): u64 { nft.royalty_bps }

// -----------------------------------------------------------------------------
// View functions
// -----------------------------------------------------------------------------

public fun nft_id(nft: &StrategyNFT): ID { object::id(nft) }
public fun nft_name(nft: &StrategyNFT): &vector<u8> { &nft.name }
public fun nft_blob_id(nft: &StrategyNFT): &vector<u8> { &nft.blob_id }
public fun nft_strategy_hash(nft: &StrategyNFT): &vector<u8> { &nft.strategy_hash }
public fun nft_author(nft: &StrategyNFT): address { nft.author }
public fun nft_royalty_bps(nft: &StrategyNFT): u64 { nft.royalty_bps }
public fun nft_minted_at(nft: &StrategyNFT): u64 { nft.minted_at_ms }
public fun nft_tags(nft: &StrategyNFT): &vector<vector<u8>> { &nft.tags }

public fun registry_count(registry: &StrategyNFTRegistry): u64 { registry.total_minted }
public fun registry_nfts(registry: &StrategyNFTRegistry): &vector<ID> { &registry.nfts }

// -----------------------------------------------------------------------------
// Test-only helpers
// -----------------------------------------------------------------------------

#[test_only]
public fun destroy_nft_for_testing(nft: StrategyNFT) {
    let StrategyNFT {
        id,
        name: _,
        blob_id: _,
        strategy_hash: _,
        author: _,
        royalty_bps: _,
        minted_at_ms: _,
        suins_name: _,
        tags: _,
    } = nft;
    object::delete(id);
}

#[test_only]
public fun destroy_registry_for_testing(registry: StrategyNFTRegistry) {
    let StrategyNFTRegistry { id, admin: _, nfts: _, total_minted: _ } = registry;
    object::delete(id);
}
