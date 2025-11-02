#[test_only]
#[allow(unused_use)]
module tunnel::tunnel_distribution_tests {
    use tunnel::tunnel::{Self, CreatorConfig, Tunnel, ClaimReceipt};
    use sui::test_scenario::{Self, Scenario};
    use sui::coin::{Self, Coin};
    use sui::sui::SUI;
    use std::string;

    const CREATOR: address = @0xC;
    const PAYER: address = @0xA;
    const OPERATOR: address = @0xB;
    const CREATOR_A: address = @0x1;
    const CREATOR_B: address = @0x2;
    const REFERRER: address = @0x3;
    const PLATFORM: address = @0x4;

    const CREATOR_PUBLIC_KEY: vector<u8> = x"1234567890123456789012345678901234567890123456789012345678901234";
    const PAYER_PUBLIC_KEY: vector<u8> = x"abcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcd";

    const RECEIVER_TYPE_CREATOR: u64 = 4020;
    const RECEIVER_TYPE_REFERRER: u64 = 4022;
    const RECEIVER_TYPE_PLATFORM: u64 = 4021;

    // Helper: Get balance of an address
    #[allow(unused_mut_parameter)]
    fun get_balance(scenario: &mut Scenario, addr: address): u64 {
        if (test_scenario::has_most_recent_for_address<Coin<SUI>>(addr)) {
            let coin = test_scenario::take_from_address<Coin<SUI>>(scenario, addr);
            let value = coin::value(&coin);
            test_scenario::return_to_address(addr, coin);
            value
        } else {
            0
        }
    }

    #[test]
    fun test_distribution_with_referrer() {
        let mut scenario = test_scenario::begin(CREATOR);

        // Step 1: Create config with CreatorA 45%, CreatorB 9%, Referrer 27%, Platform 9% (total 90%, 10% to operator)
        scenario.next_tx(CREATOR);
        {
            let receiver_configs = vector[
                tunnel::create_receiver_config(RECEIVER_TYPE_CREATOR, CREATOR_A, 4500),  // 45%
                tunnel::create_receiver_config(RECEIVER_TYPE_CREATOR, CREATOR_B, 900),   // 9%
                tunnel::create_receiver_config(RECEIVER_TYPE_REFERRER, @0x0, 2700),      // 27%
                tunnel::create_receiver_config(RECEIVER_TYPE_PLATFORM, PLATFORM, 900),   // 9%
            ];

            tunnel::create_creator_config(
                OPERATOR,
                CREATOR_PUBLIC_KEY,
                string::utf8(b"Test"),
                receiver_configs,
                1000,
                scenario.ctx()
            );
        };

        // Step 2: Open tunnel with 1000 MIST deposit and actual referrer
        scenario.next_tx(PAYER);
        {
            let config = scenario.take_shared<CreatorConfig>();
            let deposit = coin::mint_for_testing<SUI>(1000, scenario.ctx());

            tunnel::open_tunnel(
                &config,
                PAYER_PUBLIC_KEY,
                vector::empty(),
                REFERRER,  // Actual referrer address
                deposit,
                scenario.ctx()
            );

            test_scenario::return_shared(config);
        };

        // Step 3: Claim all funds (cumulative = 1000)
        scenario.next_tx(OPERATOR);
        {
            let mut tunnel = scenario.take_shared<Tunnel<SUI>>();

            let receipt = tunnel::claim_for_testing(
                &mut tunnel,
                1000,  // Claim all
                scenario.ctx()
            );

            // Close with receipt to refund any remaining
            tunnel::close_with_receipt(tunnel, receipt, scenario.ctx());
        };

        // Step 4: Verify balances
        scenario.next_tx(CREATOR);
        {
            // Expected distribution for 1000 MIST with referrer:
            // CreatorA: 45% = 450
            let balance_a = get_balance(&mut scenario, CREATOR_A);
            assert!(balance_a == 450, 0);

            // CreatorB: 9% = 90
            let balance_b = get_balance(&mut scenario, CREATOR_B);
            assert!(balance_b == 90, 1);

            // Referrer: 27% = 270
            let balance_referrer = get_balance(&mut scenario, REFERRER);
            assert!(balance_referrer == 270, 2);

            // Platform: 9% = 90
            let balance_platform = get_balance(&mut scenario, PLATFORM);
            assert!(balance_platform == 90, 3);

            // Operator: 10% = 100 (remaining after fees)
            let operator_balance = get_balance(&mut scenario, OPERATOR);
            assert!(operator_balance == 100, 4);

            // Payer refund: 0 (all claimed)
            let payer_refund = get_balance(&mut scenario, PAYER);
            assert!(payer_refund == 0, 5);
        };

        scenario.end();
    }

    #[test]
    fun test_distribution_without_referrer() {
        let mut scenario = test_scenario::begin(CREATOR);

        // Step 1: Create config with CreatorA 45%, CreatorB 9%, Referrer 27%, Platform 9%
        scenario.next_tx(CREATOR);
        {
            let receiver_configs = vector[
                tunnel::create_receiver_config(RECEIVER_TYPE_CREATOR, CREATOR_A, 4500),  // 45%
                tunnel::create_receiver_config(RECEIVER_TYPE_CREATOR, CREATOR_B, 900),   // 9%
                tunnel::create_receiver_config(RECEIVER_TYPE_REFERRER, @0x0, 2700),      // 27%
                tunnel::create_receiver_config(RECEIVER_TYPE_PLATFORM, PLATFORM, 900),   // 9%
            ];

            tunnel::create_creator_config(
                OPERATOR,
                CREATOR_PUBLIC_KEY,
                string::utf8(b"Test"),
                receiver_configs,
                1000,
                scenario.ctx()
            );
        };

        // Step 2: Open tunnel with 1000 MIST deposit and NO referrer (0x0)
        scenario.next_tx(PAYER);
        {
            let config = scenario.take_shared<CreatorConfig>();
            let deposit = coin::mint_for_testing<SUI>(1000, scenario.ctx());

            tunnel::open_tunnel(
                &config,
                PAYER_PUBLIC_KEY,
                vector::empty(),
                @0x0,  // No referrer - should split to creators
                deposit,
                scenario.ctx()
            );

            test_scenario::return_shared(config);
        };

        // Step 3: Claim all funds (cumulative = 1000)
        scenario.next_tx(OPERATOR);
        {
            let mut tunnel = scenario.take_shared<Tunnel<SUI>>();

            let receipt = tunnel::claim_for_testing(
                &mut tunnel,
                1000,  // Claim all
                scenario.ctx()
            );

            // Close with receipt to refund any remaining
            tunnel::close_with_receipt(tunnel, receipt, scenario.ctx());
        };

        // Step 4: Verify balances
        scenario.next_tx(CREATOR);
        {
            // Expected distribution for 1000 MIST WITHOUT referrer:
            // CreatorA: 45% + 13.5% (half of 27%) = 58.5% = 585
            let balance_a = get_balance(&mut scenario, CREATOR_A);
            assert!(balance_a == 585, 0);

            // CreatorB: 9% + 13.5% (half of 27%) = 22.5% = 225
            let balance_b = get_balance(&mut scenario, CREATOR_B);
            assert!(balance_b == 225, 1);

            // Referrer: 0 (was 0x0)
            let balance_referrer = get_balance(&mut scenario, REFERRER);
            assert!(balance_referrer == 0, 2);

            // Platform: 9% = 90
            let balance_platform = get_balance(&mut scenario, PLATFORM);
            assert!(balance_platform == 90, 3);

            // Operator: 10% = 100
            let operator_balance = get_balance(&mut scenario, OPERATOR);
            assert!(operator_balance == 100, 4);

            // Payer refund: 0 (all claimed)
            let payer_refund = get_balance(&mut scenario, PAYER);
            assert!(payer_refund == 0, 5);
        };

        scenario.end();
    }

    #[test]
    fun test_partial_claim_with_refund() {
        let mut scenario = test_scenario::begin(CREATOR);

        // Step 1: Create config
        scenario.next_tx(CREATOR);
        {
            let receiver_configs = vector[
                tunnel::create_receiver_config(RECEIVER_TYPE_CREATOR, CREATOR_A, 4500),
                tunnel::create_receiver_config(RECEIVER_TYPE_CREATOR, CREATOR_B, 900),
                tunnel::create_receiver_config(RECEIVER_TYPE_REFERRER, @0x0, 2700),
                tunnel::create_receiver_config(RECEIVER_TYPE_PLATFORM, PLATFORM, 900),
            ];

            tunnel::create_creator_config(
                OPERATOR,
                CREATOR_PUBLIC_KEY,
                string::utf8(b"Test"),
                receiver_configs,
                1000,
                scenario.ctx()
            );
        };

        // Step 2: Open tunnel with 1000 MIST
        scenario.next_tx(PAYER);
        {
            let config = scenario.take_shared<CreatorConfig>();
            let deposit = coin::mint_for_testing<SUI>(1000, scenario.ctx());

            tunnel::open_tunnel(
                &config,
                PAYER_PUBLIC_KEY,
                vector::empty(),
                REFERRER,
                deposit,
                scenario.ctx()
            );

            test_scenario::return_shared(config);
        };

        // Step 3: Claim only 600 MIST (partial)
        scenario.next_tx(OPERATOR);
        {
            let mut tunnel = scenario.take_shared<Tunnel<SUI>>();

            let receipt = tunnel::claim_for_testing(
                &mut tunnel,
                600,  // Claim 600 out of 1000
                scenario.ctx()
            );

            // Close with receipt - remaining 400 should go to payer
            tunnel::close_with_receipt(tunnel, receipt, scenario.ctx());
        };

        // Step 4: Verify balances
        scenario.next_tx(CREATOR);
        {
            // Distribution on 600 MIST:
            // CreatorA: 45% of 600 = 270
            let balance_a = get_balance(&mut scenario, CREATOR_A);
            assert!(balance_a == 270, 0);

            // CreatorB: 9% of 600 = 54
            let balance_b = get_balance(&mut scenario, CREATOR_B);
            assert!(balance_b == 54, 1);

            // Referrer: 27% of 600 = 162
            let balance_referrer = get_balance(&mut scenario, REFERRER);
            assert!(balance_referrer == 162, 2);

            // Platform: 9% of 600 = 54
            let balance_platform = get_balance(&mut scenario, PLATFORM);
            assert!(balance_platform == 54, 3);

            // Operator: 10% of 600 = 60
            let operator_balance = get_balance(&mut scenario, OPERATOR);
            assert!(operator_balance == 60, 4);

            // Payer refund: 1000 - 600 = 400
            let payer_refund = get_balance(&mut scenario, PAYER);
            assert!(payer_refund == 400, 5);
        };

        scenario.end();
    }

    #[test]
    fun test_partial_claim_without_referrer_with_refund() {
        let mut scenario = test_scenario::begin(CREATOR);

        // Step 1: Create config
        scenario.next_tx(CREATOR);
        {
            let receiver_configs = vector[
                tunnel::create_receiver_config(RECEIVER_TYPE_CREATOR, CREATOR_A, 4500),
                tunnel::create_receiver_config(RECEIVER_TYPE_CREATOR, CREATOR_B, 900),
                tunnel::create_receiver_config(RECEIVER_TYPE_REFERRER, @0x0, 2700),
                tunnel::create_receiver_config(RECEIVER_TYPE_PLATFORM, PLATFORM, 900),
            ];

            tunnel::create_creator_config(
                OPERATOR,
                CREATOR_PUBLIC_KEY,
                string::utf8(b"Test"),
                receiver_configs,
                1000,
                scenario.ctx()
            );
        };

        // Step 2: Open tunnel with 1000 MIST, no referrer
        scenario.next_tx(PAYER);
        {
            let config = scenario.take_shared<CreatorConfig>();
            let deposit = coin::mint_for_testing<SUI>(1000, scenario.ctx());

            tunnel::open_tunnel(
                &config,
                PAYER_PUBLIC_KEY,
                vector::empty(),
                @0x0,  // No referrer
                deposit,
                scenario.ctx()
            );

            test_scenario::return_shared(config);
        };

        // Step 3: Claim only 800 MIST
        scenario.next_tx(OPERATOR);
        {
            let mut tunnel = scenario.take_shared<Tunnel<SUI>>();

            let receipt = tunnel::claim_for_testing(
                &mut tunnel,
                800,
                scenario.ctx()
            );

            tunnel::close_with_receipt(tunnel, receipt, scenario.ctx());
        };

        // Step 4: Verify balances
        scenario.next_tx(CREATOR);
        {
            // Distribution on 800 MIST WITHOUT referrer:
            // CreatorA: 45% of 800 + 13.5% = 360 + 108 = 468
            let balance_a = get_balance(&mut scenario, CREATOR_A);
            assert!(balance_a == 468, 0);

            // CreatorB: 9% of 800 + 13.5% = 72 + 108 = 180
            let balance_b = get_balance(&mut scenario, CREATOR_B);
            assert!(balance_b == 180, 1);

            // Platform: 9% of 800 = 72
            let balance_platform = get_balance(&mut scenario, PLATFORM);
            assert!(balance_platform == 72, 2);

            // Operator: 10% of 800 = 80
            let operator_balance = get_balance(&mut scenario, OPERATOR);
            assert!(operator_balance == 80, 3);

            // Payer refund: 1000 - 800 = 200
            let payer_refund = get_balance(&mut scenario, PAYER);
            assert!(payer_refund == 200, 4);
        };

        scenario.end();
    }
}
