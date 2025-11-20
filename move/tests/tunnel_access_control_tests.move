/// Tests for access control functionality (AdminRegistry and operator updates)
#[test_only]
module tunnel::tunnel_access_control_tests;

use tunnel::tunnel;
use sui::test_scenario;

// Test addresses
const DEPLOYER: address = @0xDEAD;
const ADMIN1: address = @0xa40ec206390843153d219411366a48c7e68ef962cbfc30d4598d82b86636b978;
const ADMIN2: address = @0x96d9a120058197fce04afcffa264f2f46747881ba78a91beb38f103c60e315ae;
const ADMIN3: address = @0x95be48aceb3e4bcd697314480b516b1c6a77db1503badf5946c7bb96a63f849b;
const NEW_ADMIN: address = @0xABCD;
const OPERATOR: address = @0xB0B;
const NEW_OPERATOR: address = @0xC0C;
const CREATOR: address = @0xA11CE;
const NON_ADMIN: address = @0xBAD;

// Receiver types
const RECEIVER_TYPE_CREATOR: u64 = 4020;
const RECEIVER_TYPE_REFERRER: u64 = 4022;
const RECEIVER_TYPE_PLATFORM: u64 = 4021;

// Test addresses for fee distribution
const CREATOR_A: address = @0x111;
const CREATOR_B: address = @0x222;
const PLATFORM: address = @0x888;

// Public keys (32 bytes)
const OPERATOR_PUBLIC_KEY: vector<u8> = x"1234567890123456789012345678901234567890123456789012345678901234";
const NEW_OPERATOR_PUBLIC_KEY: vector<u8> = x"9876543210987654321098765432109876543210987654321098765432109876";

// Error codes (must match tunnel.move)
const E_NOT_AUTHORIZED: u64 = 4;
const E_INVALID_PUBLIC_KEY: u64 = 5;
const E_NOT_ADMIN: u64 = 11;

#[test]
fun test_admin_registry_initialization() {
    let mut scenario = test_scenario::begin(DEPLOYER);

    // Step 1: Init should create AdminRegistry with deployer + 3 hardcoded admins
    scenario.next_tx(DEPLOYER);
    {
        tunnel::init_for_testing(scenario.ctx());
    };

    // Step 2: Verify all admins are registered
    scenario.next_tx(DEPLOYER);
    {
        let registry = scenario.take_shared<tunnel::AdminRegistry>();

        // Check deployer is admin
        assert!(tunnel::is_admin(&registry, DEPLOYER), 0);

        // Check hardcoded admins
        assert!(tunnel::is_admin(&registry, ADMIN1), 1);
        assert!(tunnel::is_admin(&registry, ADMIN2), 2);
        assert!(tunnel::is_admin(&registry, ADMIN3), 3);

        // Check non-admin is not admin
        assert!(!tunnel::is_admin(&registry, NON_ADMIN), 4);

        test_scenario::return_shared(registry);
    };

    scenario.end();
}

#[test]
fun test_add_admin_success() {
    let mut scenario = test_scenario::begin(DEPLOYER);

    // Step 1: Initialize
    scenario.next_tx(DEPLOYER);
    {
        tunnel::init_for_testing(scenario.ctx());
    };

    // Step 2: Admin adds new admin
    scenario.next_tx(DEPLOYER);
    {
        let mut registry = scenario.take_shared<tunnel::AdminRegistry>();

        // Add new admin
        tunnel::add_admin(&mut registry, NEW_ADMIN, scenario.ctx());

        // Verify new admin was added
        assert!(tunnel::is_admin(&registry, NEW_ADMIN), 0);

        test_scenario::return_shared(registry);
    };

    scenario.end();
}

#[test]
#[expected_failure]
fun test_add_admin_failure_not_admin() {
    let mut scenario = test_scenario::begin(DEPLOYER);

    // Step 1: Initialize
    scenario.next_tx(DEPLOYER);
    {
        tunnel::init_for_testing(scenario.ctx());
    };

    // Step 2: Non-admin tries to add admin (should fail)
    scenario.next_tx(NON_ADMIN);
    {
        let mut registry = scenario.take_shared<tunnel::AdminRegistry>();

        // This should abort with E_NOT_ADMIN
        tunnel::add_admin(&mut registry, NEW_ADMIN, scenario.ctx());

        test_scenario::return_shared(registry);
    };

    scenario.end();
}

#[test]
fun test_remove_admin_success() {
    let mut scenario = test_scenario::begin(DEPLOYER);

    // Step 1: Initialize
    scenario.next_tx(DEPLOYER);
    {
        tunnel::init_for_testing(scenario.ctx());
    };

    // Step 2: Add new admin first
    scenario.next_tx(DEPLOYER);
    {
        let mut registry = scenario.take_shared<tunnel::AdminRegistry>();
        tunnel::add_admin(&mut registry, NEW_ADMIN, scenario.ctx());
        test_scenario::return_shared(registry);
    };

    // Step 3: Remove the admin
    scenario.next_tx(ADMIN1);
    {
        let mut registry = scenario.take_shared<tunnel::AdminRegistry>();

        // Verify admin exists
        assert!(tunnel::is_admin(&registry, NEW_ADMIN), 0);

        // Remove admin
        tunnel::remove_admin(&mut registry, NEW_ADMIN, scenario.ctx());

        // Verify admin was removed
        assert!(!tunnel::is_admin(&registry, NEW_ADMIN), 1);

        test_scenario::return_shared(registry);
    };

    scenario.end();
}

#[test]
#[expected_failure]
fun test_remove_admin_failure_not_admin() {
    let mut scenario = test_scenario::begin(DEPLOYER);

    // Step 1: Initialize
    scenario.next_tx(DEPLOYER);
    {
        tunnel::init_for_testing(scenario.ctx());
    };

    // Step 2: Non-admin tries to remove admin (should fail)
    scenario.next_tx(NON_ADMIN);
    {
        let mut registry = scenario.take_shared<tunnel::AdminRegistry>();

        // This should abort with E_NOT_ADMIN
        tunnel::remove_admin(&mut registry, ADMIN1, scenario.ctx());

        test_scenario::return_shared(registry);
    };

    scenario.end();
}

#[test]
fun test_update_operator_by_admin() {
    let mut scenario = test_scenario::begin(DEPLOYER);

    // Step 1: Initialize admin registry
    scenario.next_tx(DEPLOYER);
    {
        tunnel::init_for_testing(scenario.ctx());
    };

    // Step 2: Create creator config
    scenario.next_tx(CREATOR);
    {
        let receiver_configs = vector[
            tunnel::create_receiver_config(RECEIVER_TYPE_CREATOR, CREATOR_A, 5000),
            tunnel::create_receiver_config(RECEIVER_TYPE_CREATOR, CREATOR_B, 1000),
            tunnel::create_receiver_config(RECEIVER_TYPE_REFERRER, @0x0, 3000),
            tunnel::create_receiver_config(RECEIVER_TYPE_PLATFORM, PLATFORM, 1000),
        ];

        tunnel::create_creator_config(
            OPERATOR,
            OPERATOR_PUBLIC_KEY,
            std::string::utf8(b"test"),
            receiver_configs,
            3600000,
            scenario.ctx(),
        );
    };

    // Step 3: Admin updates operator
    scenario.next_tx(ADMIN1);
    {
        let registry = scenario.take_shared<tunnel::AdminRegistry>();
        let mut config = scenario.take_shared<tunnel::CreatorConfig>();

        // Update operator
        tunnel::update_creator_config_operator(
            &registry,
            &mut config,
            NEW_OPERATOR,
            NEW_OPERATOR_PUBLIC_KEY,
            scenario.ctx(),
        );

        test_scenario::return_shared(registry);
        test_scenario::return_shared(config);
    };

    // Step 4: Verify operator was updated
    scenario.next_tx(CREATOR);
    {
        let config = scenario.take_shared<tunnel::CreatorConfig>();

        // Verify new operator public key
        assert!(tunnel::creator_config_operator_public_key(&config) == NEW_OPERATOR_PUBLIC_KEY, 0);

        test_scenario::return_shared(config);
    };

    scenario.end();
}

#[test]
fun test_update_operator_by_current_operator() {
    let mut scenario = test_scenario::begin(DEPLOYER);

    // Step 1: Initialize admin registry
    scenario.next_tx(DEPLOYER);
    {
        tunnel::init_for_testing(scenario.ctx());
    };

    // Step 2: Create creator config
    scenario.next_tx(CREATOR);
    {
        let receiver_configs = vector[
            tunnel::create_receiver_config(RECEIVER_TYPE_CREATOR, CREATOR_A, 5000),
            tunnel::create_receiver_config(RECEIVER_TYPE_CREATOR, CREATOR_B, 1000),
            tunnel::create_receiver_config(RECEIVER_TYPE_REFERRER, @0x0, 3000),
            tunnel::create_receiver_config(RECEIVER_TYPE_PLATFORM, PLATFORM, 1000),
        ];

        tunnel::create_creator_config(
            OPERATOR,
            OPERATOR_PUBLIC_KEY,
            std::string::utf8(b"test"),
            receiver_configs,
            3600000,
            scenario.ctx(),
        );
    };

    // Step 3: Current operator updates to new operator
    scenario.next_tx(OPERATOR);
    {
        let registry = scenario.take_shared<tunnel::AdminRegistry>();
        let mut config = scenario.take_shared<tunnel::CreatorConfig>();

        // Update operator
        tunnel::update_creator_config_operator(
            &registry,
            &mut config,
            NEW_OPERATOR,
            NEW_OPERATOR_PUBLIC_KEY,
            scenario.ctx(),
        );

        test_scenario::return_shared(registry);
        test_scenario::return_shared(config);
    };

    // Step 4: Verify operator was updated
    scenario.next_tx(CREATOR);
    {
        let config = scenario.take_shared<tunnel::CreatorConfig>();

        // Verify new operator public key
        assert!(tunnel::creator_config_operator_public_key(&config) == NEW_OPERATOR_PUBLIC_KEY, 0);

        test_scenario::return_shared(config);
    };

    scenario.end();
}

#[test]
#[expected_failure]
fun test_update_operator_failure_not_authorized() {
    let mut scenario = test_scenario::begin(DEPLOYER);

    // Step 1: Initialize admin registry
    scenario.next_tx(DEPLOYER);
    {
        tunnel::init_for_testing(scenario.ctx());
    };

    // Step 2: Create creator config
    scenario.next_tx(CREATOR);
    {
        let receiver_configs = vector[
            tunnel::create_receiver_config(RECEIVER_TYPE_CREATOR, CREATOR_A, 5000),
            tunnel::create_receiver_config(RECEIVER_TYPE_CREATOR, CREATOR_B, 1000),
            tunnel::create_receiver_config(RECEIVER_TYPE_REFERRER, @0x0, 3000),
            tunnel::create_receiver_config(RECEIVER_TYPE_PLATFORM, PLATFORM, 1000),
        ];

        tunnel::create_creator_config(
            OPERATOR,
            OPERATOR_PUBLIC_KEY,
            std::string::utf8(b"test"),
            receiver_configs,
            3600000,
            scenario.ctx(),
        );
    };

    // Step 3: Non-authorized user tries to update operator (should fail)
    scenario.next_tx(NON_ADMIN);
    {
        let registry = scenario.take_shared<tunnel::AdminRegistry>();
        let mut config = scenario.take_shared<tunnel::CreatorConfig>();

        // This should abort with E_NOT_AUTHORIZED
        tunnel::update_creator_config_operator(
            &registry,
            &mut config,
            NEW_OPERATOR,
            NEW_OPERATOR_PUBLIC_KEY,
            scenario.ctx(),
        );

        test_scenario::return_shared(registry);
        test_scenario::return_shared(config);
    };

    scenario.end();
}

#[test]
#[expected_failure]
fun test_update_operator_failure_invalid_public_key() {
    let mut scenario = test_scenario::begin(DEPLOYER);

    // Step 1: Initialize admin registry
    scenario.next_tx(DEPLOYER);
    {
        tunnel::init_for_testing(scenario.ctx());
    };

    // Step 2: Create creator config
    scenario.next_tx(CREATOR);
    {
        let receiver_configs = vector[
            tunnel::create_receiver_config(RECEIVER_TYPE_CREATOR, CREATOR_A, 5000),
            tunnel::create_receiver_config(RECEIVER_TYPE_CREATOR, CREATOR_B, 1000),
            tunnel::create_receiver_config(RECEIVER_TYPE_REFERRER, @0x0, 3000),
            tunnel::create_receiver_config(RECEIVER_TYPE_PLATFORM, PLATFORM, 1000),
        ];

        tunnel::create_creator_config(
            OPERATOR,
            OPERATOR_PUBLIC_KEY,
            std::string::utf8(b"test"),
            receiver_configs,
            3600000,
            scenario.ctx(),
        );
    };

    // Step 3: Admin tries to update with invalid public key (should fail)
    scenario.next_tx(ADMIN1);
    {
        let registry = scenario.take_shared<tunnel::AdminRegistry>();
        let mut config = scenario.take_shared<tunnel::CreatorConfig>();

        // Invalid public key (not 32 bytes)
        let invalid_key = x"1234";

        // This should abort with E_INVALID_PUBLIC_KEY
        tunnel::update_creator_config_operator(
            &registry,
            &mut config,
            NEW_OPERATOR,
            invalid_key,
            scenario.ctx(),
        );

        test_scenario::return_shared(registry);
        test_scenario::return_shared(config);
    };

    scenario.end();
}
