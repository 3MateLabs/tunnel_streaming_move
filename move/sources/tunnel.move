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

use std::string::String;
use sui::balance::{Self, Balance};
use sui::bcs;
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use sui::ed25519;

/// Error codes
const E_TUNNEL_ALREADY_CLOSED: u64 = 1;
const E_INSUFFICIENT_BALANCE: u64 = 2;
const E_INVALID_SIGNATURE: u64 = 3;
const E_NOT_AUTHORIZED: u64 = 4;
const E_INVALID_PUBLIC_KEY: u64 = 5;
const E_CLOSE_NOT_INITIATED: u64 = 6;
const E_GRACE_PERIOD_NOT_ELAPSED: u64 = 7;
const E_INVALID_AMOUNT: u64 = 8;
const E_INVALID_FEE_PERCENTAGE: u64 = 9;

/// Basis points for percentage calculations (10000 = 100%)
const BASIS_POINTS: u64 = 10000;

/// Shared object: Creator's configuration
public struct CreatorConfig has key, store {
    id: UID,
    /// Creator's Sui address (abstracted wallet, can't operate contracts)
    creator: address,
    /// Operator address (can claim fees and close tunnels on behalf of creator)
    operator: address,
    /// Fee receiver address (where creator's fees are sent)
    fee_receiver: address,
    /// Creator's Ed25519 public key (32 bytes)
    public_key: vector<u8>,
    /// Optional metadata (e.g., creator name, description)
    metadata: String,
    /// Referrer fee percentage in basis points (e.g., 500 = 5%)
    referrer_fee_bps: u64,
    /// Platform fee percentage in basis points (e.g., 200 = 2%)
    platform_fee_bps: u64,
    /// Platform address to receive platform fees
    platform_address: address,
    /// Grace period for tunnel closure in milliseconds (e.g., 3600000 = 60 minutes, 1000 = 1 second)
    grace_period_ms: u64,
}

/// Payment tunnel between payer and creator
public struct Tunnel<phantom T> has key, store {
    id: UID,
    // Party information
    payer: address,
    creator: address,
    operator: address, // Operator who can claim fees and close tunnels
    fee_receiver: address, // Address where creator's fees are sent
    referrer: Option<address>, // Optional referrer who gets a fee
    // Public keys
    payer_public_key: vector<u8>,
    creator_public_key: vector<u8>,
    // Fee configuration (copied from CreatorConfig at tunnel creation)
    referrer_fee_bps: u64,
    platform_fee_bps: u64,
    platform_address: address,
    grace_period_ms: u64, // Grace period in milliseconds
    // Balances
    total_deposit: u64,
    claimed_amount: u64,
    balance: Balance<T>,
    // Closure state
    is_closed: bool,
    close_initiated_at: Option<u64>, // Timestamp when close was initiated
    close_initiated_by: Option<address>,
}

/// Capability to close tunnel after claiming
/// Returned by claim() function, can be used to close the tunnel
public struct ClaimReceipt has drop {
    tunnel_id: ID,
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
/// * `referrer_fee_bps` - Referrer fee in basis points (e.g., 500 = 5%)
/// * `platform_fee_bps` - Platform fee in basis points (e.g., 200 = 2%)
/// * `platform_address` - Platform address to receive fees
/// * `ctx` - Transaction context
public fun create_creator_config(
    operator: address,
    fee_receiver: address,
    public_key: vector<u8>,
    metadata: String,
    referrer_fee_bps: u64,
    platform_fee_bps: u64,
    platform_address: address,
    grace_period_ms: u64,
    ctx: &mut TxContext,
) {
    // Validate public key size (Ed25519 = 32 bytes)
    assert!(vector::length(&public_key) == 32, E_INVALID_PUBLIC_KEY);

    // Validate fee percentages don't exceed 100%
    assert!(referrer_fee_bps + platform_fee_bps < BASIS_POINTS, E_INVALID_FEE_PERCENTAGE);

    let creator = ctx.sender();
    let config = CreatorConfig {
        id: object::new(ctx),
        creator,
        operator,
        fee_receiver,
        public_key,
        metadata,
        referrer_fee_bps,
        platform_fee_bps,
        platform_address,
        grace_period_ms,
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
/// * `referrer` - Optional referrer address (use 0x0 for none)
/// * `deposit` - Payer's deposit
/// * `ctx` - Transaction context
public fun open_tunnel<T>(
    creator_config: &CreatorConfig,
    payer_public_key: vector<u8>,
    referrer: address,
    deposit: Coin<T>,
    ctx: &mut TxContext,
) {
    let payer = ctx.sender();
    let creator = creator_config.creator;

    // Validate payer's public key size
    assert!(vector::length(&payer_public_key) == 32, E_INVALID_PUBLIC_KEY);

    let total_deposit = coin::value(&deposit);
    assert!(total_deposit > 0, E_INVALID_AMOUNT);

    // Set referrer as option (0x0 means none)
    let referrer_opt = if (referrer == @0x0) {
        option::none()
    } else {
        option::some(referrer)
    };

    let tunnel = Tunnel {
        id: object::new(ctx),
        payer,
        creator,
        operator: creator_config.operator,
        fee_receiver: creator_config.fee_receiver,
        referrer: referrer_opt,
        payer_public_key,
        creator_public_key: creator_config.public_key,
        referrer_fee_bps: creator_config.referrer_fee_bps,
        platform_fee_bps: creator_config.platform_fee_bps,
        platform_address: creator_config.platform_address,
        grace_period_ms: creator_config.grace_period_ms,
        total_deposit,
        claimed_amount: 0,
        balance: coin::into_balance(deposit),
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

/// Claim funds from tunnel using payer's cumulative signature
///
/// IMPORTANT: Amount is CUMULATIVE (total authorized up to now), not incremental.
/// Example: Tunnel has 10 SUI
///   - First claim with amount=5: claims 5 SUI (claimed_amount becomes 5)
///   - Second claim with amount=6: claims 1 more SUI (6-5=1, claimed_amount becomes 6)
///
/// Returns ClaimReceipt that can be used to close the tunnel.
///
/// Message format for signature: tunnel_id || cumulative_amount || nonce
///
/// # Arguments
/// * `tunnel` - Tunnel object (remains open)
/// * `cumulative_amount` - Total amount authorized to claim up to now (must be > claimed_amount)
/// * `nonce` - Unique nonce to prevent replay
/// * `payer_signature` - Payer's signature on (tunnel_id || cumulative_amount || nonce)
/// * `ctx` - Transaction context
public fun claim<T>(
    tunnel: &mut Tunnel<T>,
    cumulative_amount: u64,
    nonce: u64,
    payer_signature: vector<u8>,
    ctx: &mut TxContext,
): ClaimReceipt {
    // Only creator or operator can claim
    let sender = ctx.sender();
    assert!(sender == tunnel.creator || sender == tunnel.operator, E_NOT_AUTHORIZED);
    assert!(!tunnel.is_closed, E_TUNNEL_ALREADY_CLOSED);

    // Cumulative amount must be greater than already claimed amount
    assert!(cumulative_amount > tunnel.claimed_amount, E_INVALID_AMOUNT);

    // Check sufficient balance for the increment
    assert!(cumulative_amount <= tunnel.total_deposit, E_INSUFFICIENT_BALANCE);

    // Construct message: tunnel_id || cumulative_amount || nonce
    let tunnel_id_bytes = object::uid_to_bytes(&tunnel.id);
    let message = construct_claim_message(&tunnel_id_bytes, cumulative_amount, nonce);

    // Verify payer's signature
    verify_ed25519_signature(&payer_signature, &tunnel.payer_public_key, &message);

    // Calculate increment (actual amount to claim this time)
    let claim_increment = cumulative_amount - tunnel.claimed_amount;

    // Store addresses and fee config
    let fee_receiver = tunnel.fee_receiver;
    let referrer = tunnel.referrer;
    let referrer_fee_bps = tunnel.referrer_fee_bps;
    let platform_fee_bps = tunnel.platform_fee_bps;
    let platform_address = tunnel.platform_address;

    // Update claimed amount to new cumulative total
    tunnel.claimed_amount = cumulative_amount;

    // Emit claim event
    sui::event::emit(FundsClaimed {
        tunnel_id: object::uid_to_inner(&tunnel.id),
        amount: claim_increment,
        total_claimed: tunnel.claimed_amount,
        claimed_by: sender,
    });

    // Calculate fees on the increment
    let referrer_fee = (claim_increment * referrer_fee_bps) / BASIS_POINTS;
    let platform_fee = (claim_increment * platform_fee_bps) / BASIS_POINTS;
    let fee_receiver_amount = claim_increment - referrer_fee - platform_fee;

    // Split and distribute claimed increment
    let mut claimed_balance = balance::split(&mut tunnel.balance, claim_increment);

    // Distribute to fee_receiver
    let fee_receiver_coin = coin::from_balance(
        balance::split(&mut claimed_balance, fee_receiver_amount),
        ctx,
    );
    transfer::public_transfer(fee_receiver_coin, fee_receiver);

    // Distribute referrer fee
    if (option::is_some(&referrer)) {
        let referrer_addr = *option::borrow(&referrer);
        let referrer_coin = coin::from_balance(
            balance::split(&mut claimed_balance, referrer_fee),
            ctx,
        );
        transfer::public_transfer(referrer_coin, referrer_addr);
    } else {
        // No referrer: fee_receiver gets the referrer fee
        let extra_coin = coin::from_balance(
            balance::split(&mut claimed_balance, referrer_fee),
            ctx,
        );
        transfer::public_transfer(extra_coin, fee_receiver);
    };

    // Distribute platform fee
    let platform_coin = coin::from_balance(claimed_balance, ctx);
    transfer::public_transfer(platform_coin, platform_address);

    // Create and transfer receipt that can be used to close tunnel
    let receipt = ClaimReceipt {
        tunnel_id: object::uid_to_inner(&tunnel.id),
    };
    receipt
}

/// Initiate tunnel closure (starts 60-minute grace period)
///
/// # Arguments
/// * `tunnel` - Tunnel object
/// * `clock` - Sui clock for timestamp
/// * `ctx` - Transaction context
public fun init_close<T>(tunnel: &mut Tunnel<T>, clock: &Clock, ctx: &mut TxContext) {
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
public fun finalize_close<T>(tunnel: Tunnel<T>, clock: &Clock, ctx: &mut TxContext) {
    assert!(!tunnel.is_closed, E_TUNNEL_ALREADY_CLOSED);
    assert!(option::is_some(&tunnel.close_initiated_at), E_CLOSE_NOT_INITIATED);

    let initiated_at = *option::borrow(&tunnel.close_initiated_at);
    let current_time = clock::timestamp_ms(clock);

    // Check if grace period has elapsed (using tunnel's configurable grace period)
    assert!(current_time >= initiated_at + tunnel.grace_period_ms, E_GRACE_PERIOD_NOT_ELAPSED);

    // Calculate refund - remaining balance goes to payer
    let payer_refund = tunnel.total_deposit - tunnel.claimed_amount;

    // Close tunnel and refund to payer
    close_tunnel_and_refund(
        tunnel,
        payer_refund,
        ctx.sender(),
        ctx,
    );
}

/// Close tunnel after claiming with ClaimReceipt
///
/// Creator/operator can close tunnel after claiming by providing the ClaimReceipt
/// returned from claim(). Remaining balance is refunded to payer.
///
/// # Arguments
/// * `tunnel` - Tunnel object (will be deleted)
/// * `receipt` - ClaimReceipt returned from claim()
/// * `ctx` - Transaction context
public fun close_with_receipt<T>(tunnel: Tunnel<T>, receipt: ClaimReceipt, ctx: &mut TxContext) {
    // Verify receipt matches tunnel
    assert!(receipt.tunnel_id == object::uid_to_inner(&tunnel.id), E_INVALID_AMOUNT);
    assert!(!tunnel.is_closed, E_TUNNEL_ALREADY_CLOSED);

    // Delete the receipt object
    let ClaimReceipt { tunnel_id: _ } = receipt;

    // Remaining balance goes to payer
    let payer_refund = balance::value(&tunnel.balance);

    // Close tunnel and refund remaining to payer (no fee distribution)
    close_tunnel_and_refund(
        tunnel,
        payer_refund,
        ctx.sender(),
        ctx,
    );
}

// ============================================================================
// Helper Functions
// ============================================================================

/// Construct claim message: tunnel_id || amount || nonce
fun construct_claim_message(tunnel_id: &vector<u8>, amount: u64, nonce: u64): vector<u8> {
    let mut message = vector::empty<u8>();
    vector::append(&mut message, *tunnel_id);
    vector::append(&mut message, bcs::to_bytes(&amount));
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

/// Close tunnel and distribute funds with fee splits
/// Close tunnel and refund remaining balance to payer
/// Fees are NOT distributed here - they are handled in claim()
fun close_tunnel_and_refund<T>(
    tunnel: Tunnel<T>,
    payer_refund: u64,
    closed_by: address,
    ctx: &mut TxContext,
) {
    let payer = tunnel.payer;
    let creator = tunnel.creator;
    let tunnel_id = object::id(&tunnel);

    // Emit close event
    sui::event::emit(TunnelClosed {
        tunnel_id,
        payer,
        creator,
        payer_refund,
        creator_payout: 0, // No payout on close - fees already distributed via claim()
        closed_by,
    });

    // Destroy tunnel and extract remaining balance
    let Tunnel {
        id,
        payer: _,
        creator: _,
        operator: _,
        fee_receiver: _,
        referrer: _,
        payer_public_key: _,
        creator_public_key: _,
        referrer_fee_bps: _,
        platform_fee_bps: _,
        platform_address: _,
        grace_period_ms: _,
        total_deposit: _,
        claimed_amount: _,
        balance: remaining_balance,
        is_closed: _,
        close_initiated_at: _,
        close_initiated_by: _,
    } = tunnel;

    // Delete tunnel object
    object::delete(id);

    // Transfer remaining balance to payer
    if (payer_refund > 0) {
        let payer_coin = coin::from_balance(remaining_balance, ctx);
        transfer::public_transfer(payer_coin, payer);
    } else {
        balance::destroy_zero(remaining_balance);
    };
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

public fun tunnel_id<T>(tunnel: &Tunnel<T>): ID {
    object::id(tunnel)
}

public fun payer<T>(tunnel: &Tunnel<T>): address {
    tunnel.payer
}

public fun creator<T>(tunnel: &Tunnel<T>): address {
    tunnel.creator
}

public fun is_closed<T>(tunnel: &Tunnel<T>): bool {
    tunnel.is_closed
}

public fun total_deposit<T>(tunnel: &Tunnel<T>): u64 {
    tunnel.total_deposit
}

public fun claimed_amount<T>(tunnel: &Tunnel<T>): u64 {
    tunnel.claimed_amount
}

public fun remaining_balance<T>(tunnel: &Tunnel<T>): u64 {
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
