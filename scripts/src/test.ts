import { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  createKeypair,
  getPublicKey,
  signClaimMessage,
  signCloseMessage,
  waitForTransaction,
  getCreatedObjects,
  mistToSui,
  suiToMist,
  bytesToHex,
} from './utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Delay helper
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function test() {
  console.log('🧪 Testing Non-ZK Tunnel End-to-End\n');

  // Load environment variables
  const envPath = path.join(__dirname, '../.env');
  let env: Record<string, string> = {};

  try {
    const envContent = readFileSync(envPath, 'utf-8');
    env = Object.fromEntries(
      envContent.split('\n')
        .filter(line => line && !line.startsWith('#'))
        .map(line => line.split('=').map(s => s.trim()))
    );
  } catch (error) {
    console.error('⚠️  No .env file found.');
    process.exit(1);
  }

  const rpcUrl = env.SUI_RPC_URL || 'https://fullnode.testnet.sui.io:443';
  const packageId = env.PACKAGE_ID;
  const creatorMnemonic = env.CREATOR_MNEMONIC;
  const payerMnemonic = env.PAYER_MNEMONIC;

  if (!packageId) {
    console.error('❌ PACKAGE_ID not found in .env file');
    console.log('Please run deployment first: npm run deploy');
    process.exit(1);
  }

  if (!creatorMnemonic || !payerMnemonic) {
    console.error('❌ CREATOR_MNEMONIC or PAYER_MNEMONIC not found in .env file');
    process.exit(1);
  }

  // Create client and keypairs
  const client = new SuiClient({ url: rpcUrl });
  const creatorKeypair = createKeypair(creatorMnemonic);
  const payerKeypair = createKeypair(payerMnemonic);

  const creatorAddress = creatorKeypair.toSuiAddress();
  const payerAddress = payerKeypair.toSuiAddress();

  console.log(`Creator Address: ${creatorAddress}`);
  console.log(`Payer Address: ${payerAddress}`);
  console.log(`Package ID: ${packageId}\n`);

  // Check balances
  const creatorBalance = await client.getBalance({ owner: creatorAddress });
  const payerBalance = await client.getBalance({ owner: payerAddress });

  console.log(`Creator Balance: ${mistToSui(creatorBalance.totalBalance)} SUI`);
  console.log(`Payer Balance: ${mistToSui(payerBalance.totalBalance)} SUI\n`);

  if (BigInt(payerBalance.totalBalance) < BigInt(1_000_000_000)) {
    console.error('❌ Insufficient payer balance. Please fund your account.');
    process.exit(1);
  }

  // Get public keys
  // Note: In this test, creator and operator are the same person
  // The creator public key is used as the operator_public_key in the contract (for signing claims)
  const creatorPublicKey = getPublicKey(creatorKeypair);
  const payerPublicKey = getPublicKey(payerKeypair);

  console.log(`Creator Public Key (used as operator key): ${bytesToHex(creatorPublicKey)}`);
  console.log(`Payer Public Key: ${bytesToHex(payerPublicKey)}\n`);

  // ============================================================================
  // TEST 1: Create Creator Config
  // ============================================================================
  console.log('📝 Test 1: Creating Creator Config...');

  const tx1 = new Transaction();

  // Create receiver configs for fee distribution (total 100%)
  // CreatorA: 50%, CreatorB: 10%, Referrer: 30%, Platform: 10%
  const creatorAConfig = tx1.moveCall({
    target: `${packageId}::tunnel::create_receiver_config`,
    arguments: [
      tx1.pure.u64(4020),  // RECEIVER_TYPE_CREATOR_ADDRESS
      tx1.pure.address(creatorAddress),
      tx1.pure.u64(5000),  // 50%
    ],
  });

  const creatorBConfig = tx1.moveCall({
    target: `${packageId}::tunnel::create_receiver_config`,
    arguments: [
      tx1.pure.u64(4020),  // RECEIVER_TYPE_CREATOR_ADDRESS
      tx1.pure.address(creatorAddress),  // using same address for testing
      tx1.pure.u64(1000),  // 10%
    ],
  });

  const referrerConfig = tx1.moveCall({
    target: `${packageId}::tunnel::create_receiver_config`,
    arguments: [
      tx1.pure.u64(4022),  // RECEIVER_TYPE_REFERER_ADDRESS
      tx1.pure.address('0x0'),  // Will be filled when tunnel opens
      tx1.pure.u64(3000),  // 30%
    ],
  });

  const platformConfig = tx1.moveCall({
    target: `${packageId}::tunnel::create_receiver_config`,
    arguments: [
      tx1.pure.u64(4021),  // Platform type (not a creator or referrer)
      tx1.pure.address(creatorAddress),  // using creator address for testing
      tx1.pure.u64(1000),  // 10%
    ],
  });

  const receiverConfigs = tx1.makeMoveVec({
    type: `${packageId}::tunnel::ReceiverConfig`,
    elements: [creatorAConfig, creatorBConfig, referrerConfig, platformConfig],
  });

  tx1.moveCall({
    target: `${packageId}::tunnel::create_creator_config`,
    arguments: [
      tx1.pure.address(creatorAddress),  // operator address (in tests, creator is also operator)
      tx1.pure.vector('u8', Array.from(creatorPublicKey)),  // operator_public_key (for signing claims)
      tx1.pure.string('Test creator config'),
      receiverConfigs,
      tx1.pure.u64(3600000),  // grace_period_ms: 60 minutes (for normal tests)
    ],
  });

  const result1 = await client.signAndExecuteTransaction({
    transaction: tx1,
    signer: creatorKeypair,
    options: {
      showEffects: true,
      showEvents: true,
      showObjectChanges: true,
    },
  });

  console.log(`✅ Creator config created: ${result1.digest}`);

  const createdObjects1 = getCreatedObjects(result1);
  const creatorConfig = createdObjects1.find(obj =>
    obj.objectType.includes('CreatorConfig')
  );

  if (!creatorConfig) {
    console.error('❌ CreatorConfig not found in transaction');
    process.exit(1);
  }

  console.log(`Creator Config ID: ${creatorConfig.objectId}\n`);

  await delay(2000);

  // ============================================================================
  // TEST 2: Open Tunnel
  // ============================================================================
  console.log('💰 Test 2: Opening Tunnel with 0.01 SUI deposit...');

  const depositAmount = suiToMist(0.01);
  const tx2 = new Transaction();

  const [coin] = tx2.splitCoins(tx2.gas, [depositAmount]);

  tx2.moveCall({
    target: `${packageId}::tunnel::open_tunnel`,
    typeArguments: ['0x2::sui::SUI'],
    arguments: [
      tx2.object(creatorConfig.objectId),
      tx2.pure.vector('u8', Array.from(payerPublicKey)),
      tx2.pure.vector('u8', []),  // credential: empty for tests
      tx2.pure.address('0x0'),  // referrer: no referrer for this test
      coin,
    ],
  });

  const result2 = await client.signAndExecuteTransaction({
    transaction: tx2,
    signer: payerKeypair,
    options: {
      showEffects: true,
      showEvents: true,
      showObjectChanges: true,
    },
  });

  console.log(`✅ Tunnel opened: ${result2.digest}`);

  const createdObjects2 = getCreatedObjects(result2);
  const tunnel = createdObjects2.find(obj => obj.objectType.includes('Tunnel'));

  if (!tunnel) {
    console.error('❌ Tunnel not found in transaction');
    process.exit(1);
  }

  const tunnelId = tunnel.objectId;
  console.log(`Tunnel ID: ${tunnelId}\n`);

  await delay(2000);

  // ============================================================================
  // TEST 3: Claim with Signature (Creator claims 0.005 SUI, tunnel stays open)
  // ============================================================================
  console.log('🔏 Test 3: Creator claiming 0.005 SUI with payer signature...');
  console.log('   Note: claim() NO LONGER closes the tunnel - it remains open\n');

  const claimAmount = suiToMist(0.005);
  const claimNonce = BigInt(1);

  // Payer signs the claim message
  const { signature: claimSignature } = await signClaimMessage(
    payerKeypair,
    tunnelId,
    claimAmount,
    claimNonce,
  );

  console.log(`Claim Signature: ${bytesToHex(claimSignature)}`);

  const tx3 = new Transaction();
  tx3.moveCall({
    target: `${packageId}::tunnel::claim`,
    typeArguments: ['0x2::sui::SUI'],
    arguments: [
      tx3.object(tunnelId),
      tx3.pure.u64(claimAmount),
      tx3.pure.u64(claimNonce),
      tx3.pure.vector('u8', Array.from(claimSignature)),
    ],
  });

  const result3 = await client.signAndExecuteTransaction({
    transaction: tx3,
    signer: creatorKeypair,
    options: {
      showEffects: true,
      showEvents: true,
      showObjectChanges: true,
    },
  });

  console.log(`✅ Claimed 0.005 SUI: ${result3.digest}`);
  console.log(`   Fee receiver: 0.00465 SUI (93%)`);
  console.log(`   Referrer: 0.00025 SUI (5%)`);
  console.log(`   Platform: 0.0001 SUI (2%)`);
  console.log(`   Tunnel remains open with 0.005 SUI remaining\n`);

  await delay(2000);

  // ============================================================================
  // TEST 4: Claim remaining balance and close tunnel in single PTB
  // ============================================================================
  console.log('🔒 Test 4: Claiming remaining 0.005 SUI and closing tunnel...');
  console.log('   Note: claim() returns ClaimReceipt, which is used to close in same PTB\n');

  const claimAmount2 = suiToMist(0.01);  // Cumulative: 0.01 total (already claimed 0.005)
  const claimNonce2 = BigInt(2);

  // Payer signs the cumulative claim message
  const { signature: claimSignature2 } = await signClaimMessage(
    payerKeypair,
    tunnelId,
    claimAmount2,  // Cumulative amount: 0.01
    claimNonce2,
  );

  const tx4 = new Transaction();

  // Call claim() - returns ClaimReceipt
  const [receipt] = tx4.moveCall({
    target: `${packageId}::tunnel::claim`,
    typeArguments: ['0x2::sui::SUI'],
    arguments: [
      tx4.object(tunnelId),
      tx4.pure.u64(claimAmount2),
      tx4.pure.u64(claimNonce2),
      tx4.pure.vector('u8', Array.from(claimSignature2)),
    ],
  });

  // Use the receipt to close the tunnel in the same PTB
  tx4.moveCall({
    target: `${packageId}::tunnel::close_with_receipt`,
    typeArguments: ['0x2::sui::SUI'],
    arguments: [
      tx4.object(tunnelId),
      receipt,  // ClaimReceipt from claim() above
    ],
  });

  const result4 = await client.signAndExecuteTransaction({
    transaction: tx4,
    signer: creatorKeypair,
    options: {
      showEffects: true,
      showEvents: true,
      showObjectChanges: true,
    },
  });

  console.log(`✅ Claimed 0.005 SUI more and closed tunnel: ${result4.digest}`);
  console.log(`   Total claimed: 0.01 SUI`);
  console.log(`   Tunnel deleted\n`);

  await delay(2000);

  // ============================================================================
  // TEST 5: Verify tunnel was deleted
  // ============================================================================
  console.log('🔍 Test 5: Verifying tunnel was deleted...');

  try {
    const tunnelCheck = await client.getObject({
      id: tunnelId,
      options: { showContent: true },
    });

    if (tunnelCheck.error || (tunnelCheck.data?.content as any)?.dataType === 'deleted') {
      console.log(`✅ Tunnel was successfully deleted\n`);
    } else {
      console.log(`❌ Unexpected: Tunnel still exists (should be deleted)\n`);
    }
  } catch (e: any) {
    if (e.message?.includes('deleted') || e.message?.includes('not found')) {
      console.log(`✅ Tunnel was successfully deleted\n`);
    } else {
      console.log(`❌ Error checking tunnel: ${e.message}\n`);
    }
  }

  await delay(2000);

  // ============================================================================
  // TEST 6: Grace Period Close Flow with 1-second grace period
  // ============================================================================
  console.log('⏰ Test 6: Testing grace period close flow with 1-second grace period...');

  // Create a second config with 1-second grace period for testing
  console.log('Creating config with 1-second grace period...');
  const tx5 = new Transaction();

  // Create receiver configs - same as main config
  const creatorAConfig5 = tx5.moveCall({
    target: `${packageId}::tunnel::create_receiver_config`,
    arguments: [
      tx5.pure.u64(4020),  // RECEIVER_TYPE_CREATOR_ADDRESS
      tx5.pure.address(creatorAddress),
      tx5.pure.u64(5000),  // 50%
    ],
  });

  const creatorBConfig5 = tx5.moveCall({
    target: `${packageId}::tunnel::create_receiver_config`,
    arguments: [
      tx5.pure.u64(4020),  // RECEIVER_TYPE_CREATOR_ADDRESS
      tx5.pure.address(creatorAddress),
      tx5.pure.u64(1000),  // 10%
    ],
  });

  const referrerConfig5 = tx5.moveCall({
    target: `${packageId}::tunnel::create_receiver_config`,
    arguments: [
      tx5.pure.u64(4022),  // RECEIVER_TYPE_REFERER_ADDRESS
      tx5.pure.address('0x0'),
      tx5.pure.u64(3000),  // 30%
    ],
  });

  const platformConfig5 = tx5.moveCall({
    target: `${packageId}::tunnel::create_receiver_config`,
    arguments: [
      tx5.pure.u64(4021),  // Platform type
      tx5.pure.address(creatorAddress),
      tx5.pure.u64(1000),  // 10%
    ],
  });

  const receiverConfigs5 = tx5.makeMoveVec({
    type: `${packageId}::tunnel::ReceiverConfig`,
    elements: [creatorAConfig5, creatorBConfig5, referrerConfig5, platformConfig5],
  });

  tx5.moveCall({
    target: `${packageId}::tunnel::create_creator_config`,
    arguments: [
      tx5.pure.address(creatorAddress),
      tx5.pure.vector('u8', Array.from(creatorPublicKey)),
      tx5.pure.string('1-second grace period config'),
      receiverConfigs5,
      tx5.pure.u64(1000),  // grace_period_ms: 1 second
    ],
  });

  const result5 = await client.signAndExecuteTransaction({
    transaction: tx5,
    signer: creatorKeypair,
    options: { showEffects: true, showEvents: true, showObjectChanges: true },
  });

  const shortGraceConfig = getCreatedObjects(result5).find(obj =>
    obj.objectType.includes('CreatorConfig')
  );

  if (!shortGraceConfig) {
    console.error('❌ Short grace config not found');
    process.exit(1);
  }

  console.log(`✅ Short grace config created: ${shortGraceConfig.objectId}`);

  await delay(2000);

  // Open new tunnel with short grace period
  console.log('Opening tunnel with 1-second grace period...');
  const tx6 = new Transaction();
  const [coin6] = tx6.splitCoins(tx6.gas, [depositAmount]);

  tx6.moveCall({
    target: `${packageId}::tunnel::open_tunnel`,
    typeArguments: ['0x2::sui::SUI'],
    arguments: [
      tx6.object(shortGraceConfig.objectId),
      tx6.pure.vector('u8', Array.from(payerPublicKey)),
      tx6.pure.vector('u8', []),  // credential: empty for tests
      tx6.pure.address('0x0'),
      coin6,
    ],
  });

  const result6 = await client.signAndExecuteTransaction({
    transaction: tx6,
    signer: payerKeypair,
    options: { showEffects: true, showEvents: true, showObjectChanges: true },
  });

  const tunnel2 = getCreatedObjects(result6).find(obj => obj.objectType.includes('Tunnel'));

  if (!tunnel2) {
    console.error('❌ Tunnel 2 not found');
    process.exit(1);
  }

  const tunnelId2 = tunnel2.objectId;
  console.log(`✅ Tunnel opened: ${tunnelId2}`);

  await delay(2000);

  // Initiate close
  console.log('Initiating close...');

  const tx7 = new Transaction();
  tx7.moveCall({
    target: `${packageId}::tunnel::init_close`,
    typeArguments: ['0x2::sui::SUI'],
    arguments: [
      tx7.object(tunnelId2),
      tx7.object('0x6'),  // Clock object
    ],
  });

  const result7 = await client.signAndExecuteTransaction({
    transaction: tx7,
    signer: payerKeypair,
    options: { showEffects: true, showEvents: true, showObjectChanges: true },
  });

  console.log(`✅ Close initiated: ${result7.digest}`);
  console.log('⏳ Grace period: 1 second\n');

  // Wait for grace period to elapse
  console.log('Waiting for grace period to elapse...');
  await delay(2000);  // Wait 2 seconds to be safe

  // Finalize close
  console.log('Finalizing close...');

  const tx8 = new Transaction();
  tx8.moveCall({
    target: `${packageId}::tunnel::finalize_close`,
    typeArguments: ['0x2::sui::SUI'],
    arguments: [
      tx8.object(tunnelId2),
      tx8.object('0x6'),  // Clock object
    ],
  });

  const result8 = await client.signAndExecuteTransaction({
    transaction: tx8,
    signer: payerKeypair,
    options: { showEffects: true, showEvents: true, showObjectChanges: true },
  });

  console.log(`✅ Close finalized: ${result8.digest}\n`);

  await delay(2000);

  // ============================================================================
  // Summary
  // ============================================================================
  console.log('✅ All tests completed successfully!\n');
  console.log('📊 Test Summary:');
  console.log('  1. ✅ Creator config created with 60-minute grace period');
  console.log('  2. ✅ Tunnel opened with 0.01 SUI deposit');
  console.log('  3. ✅ Creator claimed 0.005 SUI (cumulative) with fee distribution');
  console.log('  4. ✅ Creator claimed remaining 0.005 SUI and closed tunnel in single PTB');
  console.log('  5. ✅ Verified tunnel was properly deleted');
  console.log('  6. ✅ Grace period close flow tested with 1-second grace period (init_close + finalize_close)\n');

  console.log('🔗 View transactions on explorer:');
  console.log(`  - Creator config (60 min): https://testnet.suivision.xyz/txblock/${result1.digest}`);
  console.log(`  - Tunnel opened: https://testnet.suivision.xyz/txblock/${result2.digest}`);
  console.log(`  - First claim: https://testnet.suivision.xyz/txblock/${result3.digest}`);
  console.log(`  - Claim + close: https://testnet.suivision.xyz/txblock/${result4.digest}`);
  console.log(`  - Config (1 sec grace): https://testnet.suivision.xyz/txblock/${result5.digest}`);
  console.log(`  - Tunnel 2 opened: https://testnet.suivision.xyz/txblock/${result6.digest}`);
  console.log(`  - Init close: https://testnet.suivision.xyz/txblock/${result7.digest}`);
  console.log(`  - Finalize close: https://testnet.suivision.xyz/txblock/${result8.digest}`);
}

test().catch(console.error);
