/// Unit tests for the tunnel module
///
/// Note: Full integration tests with entry functions are in the TypeScript test suite
/// (tunnel/scripts/src/test.ts) which provides complete end-to-end coverage including:
/// - Creator config creation
/// - Tunnel opening with deposits
/// - Claims with Ed25519 signatures
/// - Close initiation and finalization
/// - Signature-based closure
/// - Grace period validation
/// - Error handling for all edge cases
///
/// These Move unit tests focus on helper functions and internal logic that can be
/// tested without entry function calls.

#[test_only]
module iota_tunnel::tunnel_tests;

use iota::bcs;
use iota_tunnel::tunnel;

/// Test: construct_claim_message helper
#[test]
fun test_construct_claim_message() {
    let tunnel_id = x"0000000000000000000000000000000000000000000000000000000000000001";
    let amount: u64 = 1_000_000;
    let nonce: u64 = 42;

    // Construct the message
    let message = tunnel::construct_claim_message_test(&tunnel_id, amount, nonce);

    // Message should be: tunnel_id (32 bytes) || amount (8 bytes BCS) || nonce (8 bytes BCS)
    let expected_len = 32 + 8 + 8;
    assert!(vector::length(&message) == expected_len, 0);

    // First 32 bytes should be tunnel_id
    let mut i = 0;
    while (i < 32) {
        assert!(*vector::borrow(&message, i) == *vector::borrow(&tunnel_id, i), 1);
        i = i + 1;
    };
}

/// Test: Message construction is deterministic
#[test]
fun test_message_deterministic() {
    let tunnel_id = x"abcd000000000000000000000000000000000000000000000000000000000000";
    let amount: u64 = 123456;
    let nonce: u64 = 789;

    let msg1 = tunnel::construct_claim_message_test(&tunnel_id, amount, nonce);
    let msg2 = tunnel::construct_claim_message_test(&tunnel_id, amount, nonce);

    // Same inputs should produce same message
    assert!(msg1 == msg2, 0);
}

/// Test: Different inputs produce different messages
#[test]
fun test_different_inputs_different_messages() {
    let tunnel_id = x"0000000000000000000000000000000000000000000000000000000000000001";

    let msg1 = tunnel::construct_claim_message_test(&tunnel_id, 100, 1);
    let msg2 = tunnel::construct_claim_message_test(&tunnel_id, 200, 1); // Different amount
    let msg3 = tunnel::construct_claim_message_test(&tunnel_id, 100, 2); // Different nonce

    assert!(msg1 != msg2, 0);
    assert!(msg1 != msg3, 1);
    assert!(msg2 != msg3, 2);
}

/// Test: BCS encoding for u64 values
#[test]
fun test_bcs_u64_encoding() {
    // Test that our BCS encoding matches expectations
    let value: u64 = 1_000_000;
    let encoded = bcs::to_bytes(&value);

    // u64 should encode to 8 bytes in BCS
    assert!(vector::length(&encoded) == 8, 0);
}

/// Test: Message construction with different tunnel IDs
#[test]
fun test_different_tunnel_ids() {
    let tunnel_id1 = x"0000000000000000000000000000000000000000000000000000000000000001";
    let tunnel_id2 = x"0000000000000000000000000000000000000000000000000000000000000002";

    let msg1 = tunnel::construct_claim_message_test(&tunnel_id1, 1000, 1);
    let msg2 = tunnel::construct_claim_message_test(&tunnel_id2, 1000, 1);

    // Different tunnel IDs should produce different messages
    assert!(msg1 != msg2, 0);
}

/// Test: Receiver config creation
#[test]
fun test_create_receiver_config() {
    let _config = tunnel::create_receiver_config(
        4020, // RECEIVER_TYPE_CREATOR_ADDRESS
        @0x123,
        5000, // 50%
    );

    // Config should be created successfully
    // (No assertion needed - successful creation validates the function)
}

// Note: Comprehensive fee distribution tests with exact amount verification
// are in the TypeScript integration tests (scripts/src/test.ts) because they require:
// 1. Valid Ed25519 signatures from payer
// 2. Shared object handling
// 3. Balance verification across multiple addresses
// 4. Test scenarios: CreatorA 50%, CreatorB 10%, Referrer 30%, Platform 10%
//    - With referrer: exact percentages distributed
//    - Without referrer (0x0): referrer's 30% split evenly to creators (CreatorA +15%, CreatorB +15%)
