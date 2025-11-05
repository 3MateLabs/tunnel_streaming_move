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
const E_INVALID_TUNNEL_ID: u64 = 10;

/// Basis points for percentage calculations (10000 = 100%)
const BASIS_POINTS: u64 = 10000;

/// Receiver type constants (for use in TypeScript when constructing ReceiverConfig)
const RECEIVER_TYPE_CREATOR_ADDRESS: u64 = 4020;
const RECEIVER_TYPE_REFERER_ADDRESS: u64 = 4022;

public struct ReceiverConfig has copy, drop, store {
    _type: u64,
    fee_bps: u64,
    _address: address,
}

/// Shared object: Creator's configuration
public struct CreatorConfig has key, store {
    id: UID,
    /// Creator's Sui address (abstracted wallet, can't operate contracts)
    creator: address,
    /// Operator address (can claim fees and close tunnels on behalf of creator)
    operator: address,
    /// Fee receiver address (where creator's fees are sent)
    receiver_configs: vector<ReceiverConfig>,
    /// Operator's Ed25519 public key (32 bytes) for signing claim messages
    operator_public_key: vector<u8>,
    /// Optional metadata (e.g., creator name, description)
    metadata: String,
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
    receiver_configs: vector<ReceiverConfig>,
    // Public keys
    payer_public_key: vector<u8>,
    operator_public_key: vector<u8>,
    credential: vector<u8>,
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
    operator_public_key: vector<u8>,
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

/// Create a receiver configuration
///
/// # Arguments
/// * `receiver_type` - Receiver type
/// * `receiver_address` - Receiver address
/// * `fee_bps` - Fee in basis points (e.g., 500 = 5%)
public fun create_receiver_config(
    receiver_type: u64,
    receiver_address: address,
    fee_bps: u64,
): ReceiverConfig {
    ReceiverConfig {
        _type: receiver_type,
        fee_bps,
        _address: receiver_address,
    }
}

/// Create a creator configuration
///
/// # Arguments
/// * `operator` - Operator address (can claim on behalf of creator)
/// * `operator_public_key` - Operator's Ed25519 public key (32 bytes) for signing claim messages
/// * `metadata` - Optional metadata (e.g., creator name, description)
/// * `receiver_configs` - Vector of receiver configurations for fee distribution
/// * `grace_period_ms` - Grace period for tunnel closure in milliseconds
/// * `ctx` - Transaction context
///
/// Note: Creator is automatically set to the transaction sender (ctx.sender())
public fun create_creator_config(
    operator: address,
    operator_public_key: vector<u8>,
    metadata: String,
    receiver_configs: vector<ReceiverConfig>,
    grace_period_ms: u64,
    ctx: &mut TxContext,
) {
    // Validate public key size (Ed25519 = 32 bytes)
    assert!(vector::length(&operator_public_key) == 32, E_INVALID_PUBLIC_KEY);

    // Validate fee percentages don't exceed 100%
    let mut total_fee_bps = 0u64;
    let mut i = 0;
    let len = vector::length(&receiver_configs);
    while (i < len) {
        let receiver_config = vector::borrow(&receiver_configs, i);
        total_fee_bps = total_fee_bps + receiver_config.fee_bps;
        i = i + 1;
    };
    assert!(total_fee_bps < BASIS_POINTS, E_INVALID_FEE_PERCENTAGE);

    let creator = ctx.sender();
    let config = CreatorConfig {
        id: object::new(ctx),
        creator,
        operator,
        receiver_configs,
        operator_public_key,
        metadata,
        grace_period_ms,
    };

    let config_id = object::id(&config);

    sui::event::emit(CreatorConfigCreated {
        config_id,
        creator,
        operator_public_key,
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
/// * `credential` - Optional credential data
/// * `referrer` - Referrer address (use 0x0 for none)
/// * `deposit` - Payer's deposit
/// * `ctx` - Transaction context
public fun open_tunnel<T>(
    creator_config: &CreatorConfig,
    payer_public_key: vector<u8>,
    credential: vector<u8>,
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

    // Copy receiver configs and update referrer address if provided
    let mut receiver_configs = creator_config.receiver_configs;
    let mut i = 0;
    let len = vector::length(&receiver_configs);

    while (i < len) {
        let receiver = vector::borrow_mut(&mut receiver_configs, i);
        // If this is a referrer type receiver, update the address
        if (receiver._type == RECEIVER_TYPE_REFERER_ADDRESS) {
            receiver._address = referrer;
        };
        i = i + 1;
    };

    let tunnel = Tunnel {
        id: object::new(ctx),
        payer,
        creator,
        operator: creator_config.operator,
        receiver_configs,
        payer_public_key,
        operator_public_key: creator_config.operator_public_key,
        credential,
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

/// Internal claim logic shared by claim() and claim_for_testing()
/// Performs validation, fee distribution, and returns ClaimReceipt
fun claim_internal<T>(
    tunnel: &mut Tunnel<T>,
    cumulative_amount: u64,
    sender: address,
    ctx: &mut TxContext,
): ClaimReceipt {
    // Only creator or operator can claim
    assert!(sender == tunnel.creator || sender == tunnel.operator, E_NOT_AUTHORIZED);
    assert!(!tunnel.is_closed, E_TUNNEL_ALREADY_CLOSED);

    // Cumulative amount must be greater than already claimed amount
    assert!(cumulative_amount > tunnel.claimed_amount, E_INVALID_AMOUNT);

    // Check sufficient balance for the increment
    assert!(cumulative_amount <= tunnel.total_deposit, E_INSUFFICIENT_BALANCE);

    // Calculate increment (actual amount to claim this time)
    let claim_increment = cumulative_amount - tunnel.claimed_amount;

    // Update claimed amount to new cumulative total
    tunnel.claimed_amount = cumulative_amount;

    // Emit claim event
    sui::event::emit(FundsClaimed {
        tunnel_id: object::uid_to_inner(&tunnel.id),
        amount: claim_increment,
        total_claimed: tunnel.claimed_amount,
        claimed_by: sender,
    });

    // Split claimed increment from balance
    let mut claimed_balance = balance::split(&mut tunnel.balance, claim_increment);

    // First pass: Check for referrer with 0x0 and count creators
    let receiver_configs = &tunnel.receiver_configs;
    let len = vector::length(receiver_configs);
    let mut has_empty_referrer = false;
    let mut referrer_fee_bps = 0u64;
    let mut creator_count = 0u64;
    let mut i = 0;

    while (i < len) {
        let receiver_config = vector::borrow(receiver_configs, i);
        if (
            receiver_config._type == RECEIVER_TYPE_REFERER_ADDRESS && receiver_config._address == @0x0
        ) {
            has_empty_referrer = true;
            referrer_fee_bps = receiver_config.fee_bps;
        };
        if (receiver_config._type == RECEIVER_TYPE_CREATOR_ADDRESS) {
            creator_count = creator_count + 1;
        };
        i = i + 1;
    };

    // Second pass: Distribute fees
    i = 0;
    while (i < len) {
        let receiver_config = vector::borrow(receiver_configs, i);

        // Skip referrer with 0x0 address (will be distributed to creators)
        if (
            receiver_config._type == RECEIVER_TYPE_REFERER_ADDRESS && receiver_config._address == @0x0
        ) {
            i = i + 1;
            continue
        };

        let mut fee_amount = (claim_increment * receiver_config.fee_bps) / BASIS_POINTS;

        // If this is a creator and we have empty referrer, add their share of referrer fee
        if (
            has_empty_referrer && receiver_config._type == RECEIVER_TYPE_CREATOR_ADDRESS && creator_count > 0
        ) {
            let referrer_share =
                (claim_increment * referrer_fee_bps) / BASIS_POINTS / creator_count;
            fee_amount = fee_amount + referrer_share;
        };

        if (fee_amount > 0) {
            let receiver_coin = coin::from_balance(
                balance::split(&mut claimed_balance, fee_amount),
                ctx,
            );
            transfer::public_transfer(receiver_coin, receiver_config._address);
        };

        i = i + 1;
    };

    // Transfer remaining balance (after all fees) to creator/operator who called claim
    let remaining = balance::value(&claimed_balance);
    if (remaining > 0) {
        let remaining_coin = coin::from_balance(claimed_balance, ctx);
        transfer::public_transfer(remaining_coin, sender);
    } else {
        balance::destroy_zero(claimed_balance);
    };

    // Create and return receipt
    ClaimReceipt {
        tunnel_id: object::uid_to_inner(&tunnel.id),
    }
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
#[allow(lint(self_transfer))]
public fun claim<T>(
    tunnel: &mut Tunnel<T>,
    cumulative_amount: u64,
    nonce: u64,
    payer_signature: vector<u8>,
    ctx: &mut TxContext,
): ClaimReceipt {
    // Construct message: tunnel_id || cumulative_amount || nonce
    let tunnel_id_bytes = object::uid_to_bytes(&tunnel.id);
    let message = construct_claim_message(&tunnel_id_bytes, cumulative_amount, nonce);

    // Verify payer's signature
    verify_ed25519_signature(&payer_signature, &tunnel.payer_public_key, &message);

    // Perform claim with validated signature
    claim_internal(tunnel, cumulative_amount, ctx.sender(), ctx)
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
    assert!(receipt.tunnel_id == object::uid_to_inner(&tunnel.id), E_INVALID_TUNNEL_ID);
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
        receiver_configs: _,
        payer_public_key: _,
        operator_public_key: _,
        credential: _,
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

public fun creator_config_operator_public_key(config: &CreatorConfig): vector<u8> {
    config.operator_public_key
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

/// Test-only function to claim without signature verification
/// Returns ClaimReceipt for testing close flows
#[test_only]
public fun claim_for_testing<T>(
    tunnel: &mut Tunnel<T>,
    cumulative_amount: u64,
    ctx: &mut TxContext,
): ClaimReceipt {
    // Skip signature verification and directly call internal claim logic
    claim_internal(tunnel, cumulative_amount, ctx.sender(), ctx)
}
