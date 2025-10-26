/// Module: tunnel
///
/// Simplified payment tunnel without ZK proofs:
/// - Creator creates config with their public key
/// - Payer opens tunnel with deposit
/// - Payer can send signature to creator off-chain
/// - Creator can claim funds using payer's signature
/// - Payer can initiate close with 60-minute grace period
/// - Creator can close immediately with signature
///
/// Flow:
/// 1. Creator calls `create_creator_config()` → Creates shared CreatorConfig
/// 2. Payer calls `open_tunnel()` → Creates Tunnel with deposit
/// 3. [Off-chain]: Payer signs claim messages
/// 4. Creator calls `claim()` with payer's signature
/// 5. Close via `init_close()` + `finalize_close()` or `close_with_signature()`
module tunnel::tunnel;

use sui::coin::{Self, Coin};
use sui::sui::SUI;
use sui::ed25519;
use sui::bcs;
use sui::clock::{Self, Clock};
use std::string::String;

/// Error codes
const E_TUNNEL_ALREADY_CLOSED: u64 = 1;
const E_INSUFFICIENT_BALANCE: u64 = 2;
const E_INVALID_SIGNATURE: u64 = 3;
const E_NOT_AUTHORIZED: u64 = 4;
const E_INVALID_PUBLIC_KEY: u64 = 5;
const E_CLOSE_NOT_INITIATED: u64 = 6;
const E_GRACE_PERIOD_NOT_ELAPSED: u64 = 7;
const E_INVALID_AMOUNT: u64 = 8;

/// Grace period for tunnel closure (60 minutes in milliseconds)
const GRACE_PERIOD_MS: u64 = 3600000;

/// Shared object: Creator's configuration
public struct CreatorConfig has key, store {
    id: UID,
    /// Creator's Sui address
    creator: address,
    /// Creator's Ed25519 public key (32 bytes)
    public_key: vector<u8>,
    /// Optional metadata (e.g., creator name, description)
    metadata: String,
}

/// Payment tunnel between payer and creator
public struct Tunnel has key, store {
    id: UID,

    // Party information
    payer: address,
    creator: address,

    // Public keys
    payer_public_key: vector<u8>,
    creator_public_key: vector<u8>,

    // Balances
    total_deposit: u64,
    claimed_amount: u64,
    balance: Coin<SUI>,

    // Closure state
    is_closed: bool,
    close_initiated_at: Option<u64>,  // Timestamp when close was initiated
    close_initiated_by: Option<address>,
}

/// Event: Creator config created
public struct CreatorConfigCreated has copy, drop {
    config_id: ID,
    creator: address,
    public_key: vector<u8>,
}

/// Event: Tunnel opened
public struct TunnelOpened has copy, drop {
    tunnel_id: ID,
    payer: address,
    creator: address,
    deposit: u64,
}

/// Event: Funds claimed
public struct FundsClaimed has copy, drop {
    tunnel_id: ID,
    amount: u64,
    total_claimed: u64,
    claimed_by: address,
}

/// Event: Close initiated
public struct CloseInitiated has copy, drop {
    tunnel_id: ID,
    initiated_by: address,
    initiated_at: u64,
}

/// Event: Tunnel closed
public struct TunnelClosed has copy, drop {
    tunnel_id: ID,
    payer: address,
    creator: address,
    payer_refund: u64,
    creator_payout: u64,
    closed_by: address,
}

// ============================================================================
// Creator Configuration Functions
// ============================================================================

/// Create a creator configuration
///
/// # Arguments
/// * `public_key` - Creator's Ed25519 public key (32 bytes)
/// * `metadata` - Optional metadata (e.g., creator name, description)
/// * `ctx` - Transaction context
public entry fun create_creator_config(
    public_key: vector<u8>,
    metadata: String,
    ctx: &mut TxContext,
) {
    // Validate public key size (Ed25519 = 32 bytes)
    assert!(vector::length(&public_key) == 32, E_INVALID_PUBLIC_KEY);

    let creator = ctx.sender();
    let config = CreatorConfig {
        id: object::new(ctx),
        creator,
        public_key,
        metadata,
    };

    let config_id = object::id(&config);

    sui::event::emit(CreatorConfigCreated {
        config_id,
        creator,
        public_key,
    });

    transfer::share_object(config);
}

// ============================================================================
// Tunnel Management Functions
// ============================================================================

/// Open a payment tunnel
///
/// # Arguments
/// * `creator_config` - Creator's configuration (shared object reference)
/// * `payer_public_key` - Payer's Ed25519 public key (32 bytes)
/// * `deposit` - Payer's deposit
/// * `ctx` - Transaction context
public entry fun open_tunnel(
    creator_config: &CreatorConfig,
    payer_public_key: vector<u8>,
    deposit: Coin<SUI>,
    ctx: &mut TxContext,
) {
    let payer = ctx.sender();
    let creator = creator_config.creator;

    // Validate payer's public key size
    assert!(vector::length(&payer_public_key) == 32, E_INVALID_PUBLIC_KEY);

    let total_deposit = coin::value(&deposit);
    assert!(total_deposit > 0, E_INVALID_AMOUNT);

    let tunnel = Tunnel {
        id: object::new(ctx),
        payer,
        creator,
        payer_public_key,
        creator_public_key: creator_config.public_key,
        total_deposit,
        claimed_amount: 0,
        balance: deposit,
        is_closed: false,
        close_initiated_at: option::none(),
        close_initiated_by: option::none(),
    };

    let tunnel_id = object::id(&tunnel);

    sui::event::emit(TunnelOpened {
        tunnel_id,
        payer,
        creator,
        deposit: total_deposit,
    });

    transfer::share_object(tunnel);
}

/// Claim funds from tunnel using payer's signature and close tunnel
///
/// This function claims the specified amount and closes the tunnel.
/// Any remaining balance is refunded to the payer.
/// The tunnel is deleted after this operation.
///
/// Message format for signature: tunnel_id || amount || nonce
///
/// # Arguments
/// * `tunnel` - Tunnel object (consumed)
/// * `amount` - Amount to claim
/// * `nonce` - Unique nonce to prevent replay
/// * `payer_signature` - Payer's signature on (tunnel_id || amount || nonce)
/// * `ctx` - Transaction context
public entry fun claim(
    mut tunnel: Tunnel,
    amount: u64,
    nonce: u64,
    payer_signature: vector<u8>,
    ctx: &mut TxContext,
) {
    // Only creator can claim
    assert!(ctx.sender() == tunnel.creator, E_NOT_AUTHORIZED);
    assert!(!tunnel.is_closed, E_TUNNEL_ALREADY_CLOSED);

    // Check sufficient balance
    let remaining_balance = tunnel.total_deposit - tunnel.claimed_amount;
    assert!(amount <= remaining_balance, E_INSUFFICIENT_BALANCE);

    // Construct message: tunnel_id || amount || nonce
    let tunnel_id = object::uid_to_bytes(&tunnel.id);
    let message = construct_claim_message(&tunnel_id, amount, nonce);

    // Verify payer's signature
    verify_ed25519_signature(&payer_signature, &tunnel.payer_public_key, &message);

    // Store addresses before destructuring
    let payer = tunnel.payer;
    let creator = tunnel.creator;
    let tunnel_id_for_event = object::uid_to_inner(&tunnel.id);

    // Emit claim event
    sui::event::emit(FundsClaimed {
        tunnel_id: tunnel_id_for_event,
        amount,
        total_claimed: tunnel.claimed_amount + amount,
        claimed_by: ctx.sender(),
    });

    // Split claimed amount for creator
    let payout = coin::split(&mut tunnel.balance, amount, ctx);
    transfer::public_transfer(payout, creator);

    // Calculate refund for payer (remaining balance)
    let refund_amount = coin::value(&tunnel.balance);

    // Emit close event
    sui::event::emit(TunnelClosed {
        tunnel_id: tunnel_id_for_event,
        payer,
        creator,
        payer_refund: refund_amount,
        creator_payout: amount,
        closed_by: ctx.sender(),
    });

    // Destructure and delete the tunnel
    let Tunnel {
        id,
        creator: _,
        payer: _,
        payer_public_key: _,
        creator_public_key: _,
        total_deposit: _,
        claimed_amount: _,
        balance,
        is_closed: _,
        close_initiated_at: _,
        close_initiated_by: _
    } = tunnel;

    // Send remaining balance to payer or destroy if zero
    if (refund_amount > 0) {
        transfer::public_transfer(balance, payer);
    } else {
        coin::destroy_zero(balance);
    };

    // Delete the tunnel object
    object::delete(id);
}

/// Initiate tunnel closure (starts 60-minute grace period)
///
/// # Arguments
/// * `tunnel` - Tunnel object
/// * `clock` - Sui clock for timestamp
/// * `ctx` - Transaction context
public entry fun init_close(
    tunnel: &mut Tunnel,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    // Only payer can initiate close
    assert!(ctx.sender() == tunnel.payer, E_NOT_AUTHORIZED);
    assert!(!tunnel.is_closed, E_TUNNEL_ALREADY_CLOSED);

    let current_time = clock::timestamp_ms(clock);
    tunnel.close_initiated_at = option::some(current_time);
    tunnel.close_initiated_by = option::some(ctx.sender());

    sui::event::emit(CloseInitiated {
        tunnel_id: object::uid_to_inner(&tunnel.id),
        initiated_by: ctx.sender(),
        initiated_at: current_time,
    });
}

/// Finalize tunnel closure after grace period
///
/// # Arguments
/// * `tunnel` - Tunnel object
/// * `clock` - Sui clock for timestamp
/// * `ctx` - Transaction context
public entry fun finalize_close(
    tunnel: Tunnel,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(!tunnel.is_closed, E_TUNNEL_ALREADY_CLOSED);
    assert!(option::is_some(&tunnel.close_initiated_at), E_CLOSE_NOT_INITIATED);

    let initiated_at = *option::borrow(&tunnel.close_initiated_at);
    let current_time = clock::timestamp_ms(clock);

    // Check if grace period has elapsed
    assert!(current_time >= initiated_at + GRACE_PERIOD_MS, E_GRACE_PERIOD_NOT_ELAPSED);

    // Calculate final payouts - remaining balance goes to payer, claimed goes to creator
    let payer_refund = tunnel.total_deposit - tunnel.claimed_amount;
    let creator_payout = 0; // Creator already claimed their share

    // Close tunnel and distribute funds
    close_tunnel_and_distribute(
        tunnel,
        payer_refund,
        creator_payout,
        ctx.sender(),
        ctx,
    );
}

/// Close tunnel immediately with creator's signature
///
/// Message format: tunnel_id || payer_refund || creator_payout || nonce
///
/// # Arguments
/// * `tunnel` - Tunnel object
/// * `payer_refund` - Amount to refund to payer
/// * `creator_payout` - Amount to pay to creator
/// * `nonce` - Unique nonce
/// * `creator_signature` - Creator's signature
/// * `ctx` - Transaction context
public entry fun close_with_signature(
    tunnel: Tunnel,
    payer_refund: u64,
    creator_payout: u64,
    nonce: u64,
    creator_signature: vector<u8>,
    ctx: &mut TxContext,
) {
    assert!(!tunnel.is_closed, E_TUNNEL_ALREADY_CLOSED);

    // Validate balance conservation - must account for already claimed amounts
    assert!(payer_refund + creator_payout + tunnel.claimed_amount == tunnel.total_deposit, E_INVALID_AMOUNT);

    // Construct message: tunnel_id || payer_refund || creator_payout || nonce
    let tunnel_id = object::uid_to_bytes(&tunnel.id);
    let message = construct_close_message(&tunnel_id, payer_refund, creator_payout, nonce);

    // Verify creator's signature
    verify_ed25519_signature(&creator_signature, &tunnel.creator_public_key, &message);

    // Close tunnel and distribute funds
    close_tunnel_and_distribute(
        tunnel,
        payer_refund,
        creator_payout,
        ctx.sender(),
        ctx,
    );
}

// ============================================================================
// Helper Functions
// ============================================================================

/// Construct claim message: tunnel_id || amount || nonce
fun construct_claim_message(
    tunnel_id: &vector<u8>,
    amount: u64,
    nonce: u64,
): vector<u8> {
    let mut message = vector::empty<u8>();
    vector::append(&mut message, *tunnel_id);
    vector::append(&mut message, bcs::to_bytes(&amount));
    vector::append(&mut message, bcs::to_bytes(&nonce));
    message
}

/// Construct close message: tunnel_id || payer_refund || creator_payout || nonce
fun construct_close_message(
    tunnel_id: &vector<u8>,
    payer_refund: u64,
    creator_payout: u64,
    nonce: u64,
): vector<u8> {
    let mut message = vector::empty<u8>();
    vector::append(&mut message, *tunnel_id);
    vector::append(&mut message, bcs::to_bytes(&payer_refund));
    vector::append(&mut message, bcs::to_bytes(&creator_payout));
    vector::append(&mut message, bcs::to_bytes(&nonce));
    message
}

/// Verify Ed25519 signature
fun verify_ed25519_signature(
    signature: &vector<u8>,
    public_key: &vector<u8>,
    message: &vector<u8>,
) {
    assert!(vector::length(signature) == 64, E_INVALID_SIGNATURE);
    assert!(vector::length(public_key) == 32, E_INVALID_PUBLIC_KEY);

    let valid = ed25519::ed25519_verify(signature, public_key, message);
    assert!(valid, E_INVALID_SIGNATURE);
}

/// Close tunnel and distribute funds
fun close_tunnel_and_distribute(
    mut tunnel: Tunnel,
    payer_refund: u64,
    creator_payout: u64,
    closed_by: address,
    ctx: &mut TxContext,
) {
    tunnel.is_closed = true;

    let payer = tunnel.payer;
    let creator = tunnel.creator;
    let tunnel_id = object::id(&tunnel);

    // Split funds
    let payer_coin = if (payer_refund > 0) {
        coin::split(&mut tunnel.balance, payer_refund, ctx)
    } else {
        coin::zero<SUI>(ctx)
    };

    let creator_coin = if (creator_payout > 0) {
        coin::split(&mut tunnel.balance, creator_payout, ctx)
    } else {
        coin::zero<SUI>(ctx)
    };

    sui::event::emit(TunnelClosed {
        tunnel_id,
        payer,
        creator,
        payer_refund,
        creator_payout,
        closed_by,
    });

    // Destroy tunnel
    destroy_tunnel(tunnel);

    // Transfer coins
    transfer::public_transfer(payer_coin, payer);
    transfer::public_transfer(creator_coin, creator);
}

/// Destroy tunnel object
fun destroy_tunnel(tunnel: Tunnel) {
    let Tunnel {
        id,
        payer: _,
        creator: _,
        payer_public_key: _,
        creator_public_key: _,
        total_deposit: _,
        claimed_amount: _,
        balance: remaining_balance,
        is_closed: _,
        close_initiated_at: _,
        close_initiated_by: _,
    } = tunnel;

    coin::destroy_zero(remaining_balance);
    object::delete(id);
}

// ============================================================================
// Getter Functions
// ============================================================================

public fun creator_config_creator(config: &CreatorConfig): address {
    config.creator
}

public fun creator_config_public_key(config: &CreatorConfig): vector<u8> {
    config.public_key
}

public fun creator_config_metadata(config: &CreatorConfig): String {
    config.metadata
}

public fun tunnel_id(tunnel: &Tunnel): ID {
    object::id(tunnel)
}

public fun payer(tunnel: &Tunnel): address {
    tunnel.payer
}

public fun creator(tunnel: &Tunnel): address {
    tunnel.creator
}

public fun is_closed(tunnel: &Tunnel): bool {
    tunnel.is_closed
}

public fun total_deposit(tunnel: &Tunnel): u64 {
    tunnel.total_deposit
}

public fun claimed_amount(tunnel: &Tunnel): u64 {
    tunnel.claimed_amount
}

public fun remaining_balance(tunnel: &Tunnel): u64 {
    tunnel.total_deposit - tunnel.claimed_amount
}

// ============================================================================
// Test-only wrapper functions
// ============================================================================

#[test_only]
public fun construct_claim_message_test(
    tunnel_id: &vector<u8>,
    amount: u64,
    nonce: u64,
): vector<u8> {
    construct_claim_message(tunnel_id, amount, nonce)
}

#[test_only]
public fun construct_close_message_test(
    tunnel_id: &vector<u8>,
    payer_refund: u64,
    creator_payout: u64,
    nonce: u64,
): vector<u8> {
    construct_close_message(tunnel_id, payer_refund, creator_payout, nonce)
}
