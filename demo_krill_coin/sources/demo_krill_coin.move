/*
/// Module: demo_krill_coin
module demo_krill_coin::demo_krill_coin;
*/

// For Move coding conventions, see
// https://docs.sui.io/concepts/sui-move-concepts/conventions
module demo_krill_coin::demo_krill_coin;

use sui::coin;
use sui::url;

public struct DEMO_KRILL_COIN has drop {}

fun init(krill_coin: DEMO_KRILL_COIN, ctx: &mut tx_context::TxContext) {
    let (mut treasury_cap, coin_metadata) = coin::create_currency<DEMO_KRILL_COIN>(
        krill_coin,
        9,
        b"dKRILL",
        b"Demo KRILL Coin",
        b"Demo KRILL Coin for Demo Purposes",
        option::some(url::new_unsafe_from_bytes(b"https://i.imgur.com/vJpUSuM.png")),
        ctx,
    );
    transfer::public_transfer(coin_metadata, ctx.sender());
    coin::mint_and_transfer(
        &mut treasury_cap,
        10000000000000000000,
        tx_context::sender(ctx),
        ctx,
    );
    transfer::public_share_object(treasury_cap);
}

public fun mint(
    treasury_cap: &mut coin::TreasuryCap<DEMO_KRILL_COIN>,
    amount: u64,
    ctx: &mut tx_context::TxContext,
) {
    coin::mint_and_transfer(
        treasury_cap,
        amount,
        tx_context::sender(ctx),
        ctx,
    );
}
