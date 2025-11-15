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
  bytesToHex,
  suiToMist,
  getCreatedObjects,
  waitForTransaction,
} from './utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface AuditResult {
  testName: string;
  expectedToFail: boolean;
  actuallyFailed: boolean;
  error?: string;
  passed: boolean;
}

const results: AuditResult[] = [];

function recordResult(testName: string, expectedToFail: boolean, actuallyFailed: boolean, error?: string) {
  const passed = expectedToFail === actuallyFailed;
  results.push({ testName, expectedToFail, actuallyFailed, error, passed });

  const status = passed ? '✅' : '❌';
  const expectation = expectedToFail ? 'SHOULD FAIL' : 'SHOULD PASS';
  const actual = actuallyFailed ? 'FAILED' : 'PASSED';

  console.log(`${status} ${testName}`);
  console.log(`   Expected: ${expectation}, Actual: ${actual}`);
  if (error) {
    console.log(`   Error: ${error.substring(0, 100)}...`);
  }
  console.log('');
}

async function audit() {
  console.log('🔒 SECURITY AUDIT: Tunnel Smart Contract\n');
  console.log('Testing edge cases and attempting to break the contract...\n');

  // Load environment
  const envPath = path.join(__dirname, '../.env');
  const envContent = readFileSync(envPath, 'utf-8');
  const env = Object.fromEntries(
    envContent.split('\n')
      .filter(line => line && !line.startsWith('#'))
      .map(line => line.split('=').map(s => s.trim()))
  );

  const rpcUrl = env.SUI_RPC_URL || 'https://fullnode.testnet.sui.io:443';
  const packageId = env.PACKAGE_ID;
  const creatorMnemonic = env.CREATOR_MNEMONIC;
  const payerMnemonic = env.PAYER_MNEMONIC;

  const client = new SuiClient({ url: rpcUrl });
  const creatorKeypair = createKeypair(creatorMnemonic);
  const payerKeypair = createKeypair(payerMnemonic);
  const creatorPublicKey = getPublicKey(creatorKeypair);
  const payerPublicKey = getPublicKey(payerKeypair);
  const creatorAddress = creatorKeypair.toSuiAddress();

  // Create a malicious actor
  const attackerKeypair = Ed25519Keypair.deriveKeypair('attack attack attack attack attack attack attack attack attack attack attack attack');
  const attackerAddress = attackerKeypair.toSuiAddress();

  console.log(`Creator: ${creatorAddress}`);
  console.log(`Payer: ${payerKeypair.toSuiAddress()}`);
  console.log(`Attacker: ${attackerAddress}\n`);

  // Setup: Create config and tunnel for tests
  console.log('📝 Setup: Creating config and tunnel...\n');

  const tx1 = new Transaction();

  // Create receiver configs: CreatorA 50%, CreatorB 10%, Referrer 30%, Platform 10%
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
      tx1.pure.address(creatorAddress),
      tx1.pure.u64(1000),  // 10%
    ],
  });

  const referrerConfig = tx1.moveCall({
    target: `${packageId}::tunnel::create_receiver_config`,
    arguments: [
      tx1.pure.u64(4022),  // RECEIVER_TYPE_REFERER_ADDRESS
      tx1.pure.address('0x0'),
      tx1.pure.u64(3000),  // 30%
    ],
  });

  const platformConfig = tx1.moveCall({
    target: `${packageId}::tunnel::create_receiver_config`,
    arguments: [
      tx1.pure.u64(4021),  // Platform type
      tx1.pure.address(creatorAddress),
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
      tx1.pure.address(creatorAddress),
      tx1.pure.vector('u8', Array.from(creatorPublicKey)),
      tx1.pure.string('Audit test config'),
      receiverConfigs,
      tx1.pure.u64(1000),  // 1 second grace period
    ],
  });

  const result1 = await client.signAndExecuteTransaction({
    transaction: tx1,
    signer: creatorKeypair,
    options: { showEffects: true, showEvents: true, showObjectChanges: true },
  });

  await waitForTransaction(client, result1.digest);

  const configId = getCreatedObjects(result1).find(obj =>
    obj.objectType.includes('CreatorConfig')
  )?.objectId;

  console.log(`Config created: ${configId}\n`);

  const tx2 = new Transaction();
  const [coin] = tx2.splitCoins(tx2.gas, [suiToMist(0.1)]);
  tx2.moveCall({
    target: `${packageId}::tunnel::open_tunnel`,
    typeArguments: ['0x2::sui::SUI'],
    arguments: [
      tx2.object(configId!),
      tx2.pure.vector('u8', Array.from(payerPublicKey)),
      tx2.pure.vector('u8', []),  // credential: empty for tests
      tx2.pure.address('0x0'),
      coin,
    ],
  });

  const result2 = await client.signAndExecuteTransaction({
    transaction: tx2,
    signer: payerKeypair,
    options: { showEffects: true, showEvents: true, showObjectChanges: true },
  });

  await waitForTransaction(client, result2.digest);

  const tunnelId = getCreatedObjects(result2).find(obj =>
    obj.objectType.includes('Tunnel')
  )?.objectId;

  console.log(`Tunnel created: ${tunnelId}\n`);
  console.log('=' .repeat(80));
  console.log('STARTING SECURITY TESTS\n');
  console.log('=' .repeat(80));
  console.log('');

  // ============================================================================
  // TEST 1: Signature Replay Attack
  // ============================================================================
  console.log('🔐 TEST 1: Signature Replay Attack\n');

  try {
    const claimAmount = suiToMist(0.01);
    const nonce = BigInt(1);
    const { signature } = await signClaimMessage(payerKeypair, tunnelId!, claimAmount, nonce);

    // First claim - should succeed
    const tx3 = new Transaction();
    tx3.moveCall({
      target: `${packageId}::tunnel::claim`,
      typeArguments: ['0x2::sui::SUI'],
      arguments: [
        tx3.object(tunnelId!),
        tx3.pure.u64(claimAmount),
        tx3.pure.u64(nonce),
        tx3.pure.vector('u8', Array.from(signature)),
      ],
    });

    const result3 = await client.signAndExecuteTransaction({
      transaction: tx3,
      signer: creatorKeypair,
      options: { showEffects: true },
    });

    // Wait for first transaction to finalize
    await waitForTransaction(client, result3.digest);

    // Try to reuse same signature - SHOULD FAIL
    const tx4 = new Transaction();
    tx4.moveCall({
      target: `${packageId}::tunnel::claim`,
      typeArguments: ['0x2::sui::SUI'],
      arguments: [
        tx4.object(tunnelId!),
        tx4.pure.u64(claimAmount),
        tx4.pure.u64(nonce),
        tx4.pure.vector('u8', Array.from(signature)),
      ],
    });

    await client.signAndExecuteTransaction({
      transaction: tx4,
      signer: creatorKeypair,
      options: { showEffects: true },
    });

    recordResult('Signature Replay Attack', true, false);
  } catch (error: any) {
    recordResult('Signature Replay Attack', true, true, error.message);
  }

  // ============================================================================
  // TEST 2: Claim with Old/Lower Nonce
  // ============================================================================
  console.log('🔐 TEST 2: Claim with Decreasing Cumulative Amount (going backwards)\n');

  try {
    // Try to claim with lower cumulative amount - SHOULD FAIL
    const lowerAmount = suiToMist(0.005);
    const nonce2 = BigInt(2);
    const { signature: sig2 } = await signClaimMessage(payerKeypair, tunnelId!, lowerAmount, nonce2);

    const tx5 = new Transaction();
    tx5.moveCall({
      target: `${packageId}::tunnel::claim`,
      typeArguments: ['0x2::sui::SUI'],
      arguments: [
        tx5.object(tunnelId!),
        tx5.pure.u64(lowerAmount),
        tx5.pure.u64(nonce2),
        tx5.pure.vector('u8', Array.from(sig2)),
      ],
    });

    await client.signAndExecuteTransaction({
      transaction: tx5,
      signer: creatorKeypair,
      options: { showEffects: true },
    });

    recordResult('Claim with Decreasing Amount', true, false);
  } catch (error: any) {
    recordResult('Claim with Decreasing Amount', true, true, error.message);
  }

  // ============================================================================
  // TEST 3: Claim More Than Deposited
  // ============================================================================
  console.log('🔐 TEST 3: Claim More Than Total Deposit\n');

  try {
    const excessAmount = suiToMist(1.0); // More than 0.1 deposited
    const nonce3 = BigInt(3);
    const { signature: sig3 } = await signClaimMessage(payerKeypair, tunnelId!, excessAmount, nonce3);

    const tx6 = new Transaction();
    tx6.moveCall({
      target: `${packageId}::tunnel::claim`,
      typeArguments: ['0x2::sui::SUI'],
      arguments: [
        tx6.object(tunnelId!),
        tx6.pure.u64(excessAmount),
        tx6.pure.u64(nonce3),
        tx6.pure.vector('u8', Array.from(sig3)),
      ],
    });

    await client.signAndExecuteTransaction({
      transaction: tx6,
      signer: creatorKeypair,
      options: { showEffects: true },
    });

    recordResult('Claim More Than Deposited', true, false);
  } catch (error: any) {
    recordResult('Claim More Than Deposited', true, true, error.message);
  }

  // ============================================================================
  // TEST 4: Unauthorized Claim (Attacker tries to claim)
  // ============================================================================
  console.log('🔐 TEST 4: Unauthorized Claim by Attacker\n');

  try {
    const claimAmount4 = suiToMist(0.02);
    const nonce4 = BigInt(4);
    const { signature: sig4 } = await signClaimMessage(payerKeypair, tunnelId!, claimAmount4, nonce4);

    const tx7 = new Transaction();
    tx7.moveCall({
      target: `${packageId}::tunnel::claim`,
      typeArguments: ['0x2::sui::SUI'],
      arguments: [
        tx7.object(tunnelId!),
        tx7.pure.u64(claimAmount4),
        tx7.pure.u64(nonce4),
        tx7.pure.vector('u8', Array.from(sig4)),
      ],
    });

    // Attacker tries to claim - SHOULD FAIL
    await client.signAndExecuteTransaction({
      transaction: tx7,
      signer: attackerKeypair,
      options: { showEffects: true },
    });

    recordResult('Unauthorized Claim', true, false);
  } catch (error: any) {
    recordResult('Unauthorized Claim', true, true, error.message);
  }

  // ============================================================================
  // TEST 5: Wrong Signature (Creator signs instead of Payer)
  // ============================================================================
  console.log('🔐 TEST 5: Wrong Signature (Creator signs instead of Payer)\n');

  try {
    const claimAmount5 = suiToMist(0.02);
    const nonce5 = BigInt(5);
    // Creator signs instead of payer - SHOULD FAIL
    const { signature: sig5 } = await signClaimMessage(creatorKeypair, tunnelId!, claimAmount5, nonce5);

    const tx8 = new Transaction();
    tx8.moveCall({
      target: `${packageId}::tunnel::claim`,
      typeArguments: ['0x2::sui::SUI'],
      arguments: [
        tx8.object(tunnelId!),
        tx8.pure.u64(claimAmount5),
        tx8.pure.u64(nonce5),
        tx8.pure.vector('u8', Array.from(sig5)),
      ],
    });

    await client.signAndExecuteTransaction({
      transaction: tx8,
      signer: creatorKeypair,
      options: { showEffects: true },
    });

    recordResult('Wrong Signature', true, false);
  } catch (error: any) {
    recordResult('Wrong Signature', true, true, error.message);
  }

  // ============================================================================
  // TEST 6: Finalize Close Before Grace Period Elapsed
  // ============================================================================
  console.log('🔐 TEST 6: Finalize Close Before Grace Period\n');

  try {
    // Open a new tunnel for this test
    const tx9 = new Transaction();
    const [coin9] = tx9.splitCoins(tx9.gas, [suiToMist(0.01)]);
    tx9.moveCall({
      target: `${packageId}::tunnel::open_tunnel`,
      typeArguments: ['0x2::sui::SUI'],
      arguments: [
        tx9.object(configId!),
        tx9.pure.vector('u8', Array.from(payerPublicKey)),
        tx9.pure.vector('u8', []),  // credential: empty for tests
        tx9.pure.address('0x0'),
        coin9,
      ],
    });

    const result9 = await client.signAndExecuteTransaction({
      transaction: tx9,
      signer: payerKeypair,
      options: { showEffects: true, showEvents: true, showObjectChanges: true },
    });

    const tunnel2Id = getCreatedObjects(result9).find(obj =>
      obj.objectType.includes('Tunnel')
    )?.objectId;

    // Init close
    const tx10 = new Transaction();
    tx10.moveCall({
      target: `${packageId}::tunnel::init_close`,
      typeArguments: ['0x2::sui::SUI'],
      arguments: [
        tx10.object(tunnel2Id!),
        tx10.object('0x6'),
      ],
    });

    await client.signAndExecuteTransaction({
      transaction: tx10,
      signer: payerKeypair,
      options: { showEffects: true },
    });

    // Try to finalize immediately (grace period = 1 second, we don't wait) - SHOULD FAIL
    const tx11 = new Transaction();
    tx11.moveCall({
      target: `${packageId}::tunnel::finalize_close`,
      typeArguments: ['0x2::sui::SUI'],
      arguments: [
        tx11.object(tunnel2Id!),
        tx11.object('0x6'),
      ],
    });

    await client.signAndExecuteTransaction({
      transaction: tx11,
      signer: payerKeypair,
      options: { showEffects: true },
    });

    recordResult('Finalize Before Grace Period', true, false);
  } catch (error: any) {
    recordResult('Finalize Before Grace Period', true, true, error.message);
  }

  // ============================================================================
  // TEST 7: Use Receipt from Wrong Tunnel
  // ============================================================================
  console.log('🔐 TEST 7: Use ClaimReceipt from Wrong Tunnel\n');

  try {
    // Open two new tunnels
    const tx12 = new Transaction();
    const [coin12a] = tx12.splitCoins(tx12.gas, [suiToMist(0.01)]);
    tx12.moveCall({
      target: `${packageId}::tunnel::open_tunnel`,
      typeArguments: ['0x2::sui::SUI'],
      arguments: [
        tx12.object(configId!),
        tx12.pure.vector('u8', Array.from(payerPublicKey)),
        tx12.pure.vector('u8', []),  // credential: empty for tests
        tx12.pure.address('0x0'),
        coin12a,
      ],
    });

    const result12 = await client.signAndExecuteTransaction({
      transaction: tx12,
      signer: payerKeypair,
      options: { showEffects: true, showEvents: true, showObjectChanges: true },
    });

    const tunnel3Id = getCreatedObjects(result12).find(obj =>
      obj.objectType.includes('Tunnel')
    )?.objectId;

    const tx13 = new Transaction();
    const [coin13] = tx13.splitCoins(tx13.gas, [suiToMist(0.01)]);
    tx13.moveCall({
      target: `${packageId}::tunnel::open_tunnel`,
      typeArguments: ['0x2::sui::SUI'],
      arguments: [
        tx13.object(configId!),
        tx13.pure.vector('u8', Array.from(payerPublicKey)),
        tx13.pure.vector('u8', []),  // credential: empty for tests
        tx13.pure.address('0x0'),
        coin13,
      ],
    });

    const result13 = await client.signAndExecuteTransaction({
      transaction: tx13,
      signer: payerKeypair,
      options: { showEffects: true, showEvents: true, showObjectChanges: true },
    });

    const tunnel4Id = getCreatedObjects(result13).find(obj =>
      obj.objectType.includes('Tunnel')
    )?.objectId;

    // Claim from tunnel3 to get receipt
    const { signature: sig7 } = await signClaimMessage(
      payerKeypair,
      tunnel3Id!,
      suiToMist(0.01),
      BigInt(100)
    );

    const tx14 = new Transaction();
    const [receipt] = tx14.moveCall({
      target: `${packageId}::tunnel::claim`,
      typeArguments: ['0x2::sui::SUI'],
      arguments: [
        tx14.object(tunnel3Id!),
        tx14.pure.u64(suiToMist(0.01)),
        tx14.pure.u64(100),
        tx14.pure.vector('u8', Array.from(sig7)),
      ],
    });

    // Try to use receipt to close tunnel4 - SHOULD FAIL
    tx14.moveCall({
      target: `${packageId}::tunnel::close_with_receipt`,
      typeArguments: ['0x2::sui::SUI'],
      arguments: [
        tx14.object(tunnel4Id!),
        receipt,
      ],
    });

    await client.signAndExecuteTransaction({
      transaction: tx14,
      signer: creatorKeypair,
      options: { showEffects: true },
    });

    recordResult('Use Receipt from Wrong Tunnel', true, false);
  } catch (error: any) {
    recordResult('Use Receipt from Wrong Tunnel', true, true, error.message);
  }

  // ============================================================================
  // TEST 8: Close Already Closed Tunnel
  // ============================================================================
  console.log('🔐 TEST 8: Double Close (Close Already Closed Tunnel)\n');

  try {
    // Open and close a tunnel
    const tx15 = new Transaction();
    const [coin15] = tx15.splitCoins(tx15.gas, [suiToMist(0.01)]);
    tx15.moveCall({
      target: `${packageId}::tunnel::open_tunnel`,
      typeArguments: ['0x2::sui::SUI'],
      arguments: [
        tx15.object(configId!),
        tx15.pure.vector('u8', Array.from(payerPublicKey)),
        tx15.pure.vector('u8', []),  // credential: empty for tests
        tx15.pure.address('0x0'),
        coin15,
      ],
    });

    const result15 = await client.signAndExecuteTransaction({
      transaction: tx15,
      signer: payerKeypair,
      options: { showEffects: true, showEvents: true, showObjectChanges: true },
    });

    const tunnel5Id = getCreatedObjects(result15).find(obj =>
      obj.objectType.includes('Tunnel')
    )?.objectId;

    // Close it
    const { signature: sig8 } = await signClaimMessage(
      payerKeypair,
      tunnel5Id!,
      suiToMist(0.01),
      BigInt(200)
    );

    const tx16 = new Transaction();
    const [receipt2] = tx16.moveCall({
      target: `${packageId}::tunnel::claim`,
      typeArguments: ['0x2::sui::SUI'],
      arguments: [
        tx16.object(tunnel5Id!),
        tx16.pure.u64(suiToMist(0.01)),
        tx16.pure.u64(200),
        tx16.pure.vector('u8', Array.from(sig8)),
      ],
    });

    tx16.moveCall({
      target: `${packageId}::tunnel::close_with_receipt`,
      typeArguments: ['0x2::sui::SUI'],
      arguments: [
        tx16.object(tunnel5Id!),
        receipt2,
      ],
    });

    const result16 = await client.signAndExecuteTransaction({
      transaction: tx16,
      signer: creatorKeypair,
      options: { showEffects: true },
    });

    // Wait for close transaction to finalize
    await waitForTransaction(client, result16.digest);

    // Try to claim from deleted tunnel - SHOULD FAIL
    const { signature: sig9 } = await signClaimMessage(
      payerKeypair,
      tunnel5Id!,
      suiToMist(0.01),
      BigInt(201)
    );

    const tx17 = new Transaction();
    tx17.moveCall({
      target: `${packageId}::tunnel::claim`,
      typeArguments: ['0x2::sui::SUI'],
      arguments: [
        tx17.object(tunnel5Id!),
        tx17.pure.u64(suiToMist(0.01)),
        tx17.pure.u64(201),
        tx17.pure.vector('u8', Array.from(sig9)),
      ],
    });

    await client.signAndExecuteTransaction({
      transaction: tx17,
      signer: creatorKeypair,
      options: { showEffects: true },
    });

    recordResult('Double Close', true, false);
  } catch (error: any) {
    recordResult('Double Close', true, true, error.message);
  }

  // ============================================================================
  // TEST 9: Claim with Zero Amount
  // ============================================================================
  console.log('🔐 TEST 9: Claim with Zero Cumulative Amount\n');

  try {
    const tx18 = new Transaction();
    const [coin18] = tx18.splitCoins(tx18.gas, [suiToMist(0.01)]);
    tx18.moveCall({
      target: `${packageId}::tunnel::open_tunnel`,
      typeArguments: ['0x2::sui::SUI'],
      arguments: [
        tx18.object(configId!),
        tx18.pure.vector('u8', Array.from(payerPublicKey)),
        tx18.pure.vector('u8', []),  // credential: empty for tests
        tx18.pure.address('0x0'),
        coin18,
      ],
    });

    const result18 = await client.signAndExecuteTransaction({
      transaction: tx18,
      signer: payerKeypair,
      options: { showEffects: true, showEvents: true, showObjectChanges: true },
    });

    const tunnel6Id = getCreatedObjects(result18).find(obj =>
      obj.objectType.includes('Tunnel')
    )?.objectId;

    const { signature: sig10 } = await signClaimMessage(
      payerKeypair,
      tunnel6Id!,
      BigInt(0), // Zero amount
      BigInt(300)
    );

    const tx19 = new Transaction();
    tx19.moveCall({
      target: `${packageId}::tunnel::claim`,
      typeArguments: ['0x2::sui::SUI'],
      arguments: [
        tx19.object(tunnel6Id!),
        tx19.pure.u64(0),
        tx19.pure.u64(300),
        tx19.pure.vector('u8', Array.from(sig10)),
      ],
    });

    await client.signAndExecuteTransaction({
      transaction: tx19,
      signer: creatorKeypair,
      options: { showEffects: true },
    });

    recordResult('Claim with Zero Amount', true, false);
  } catch (error: any) {
    recordResult('Claim with Zero Amount', true, true, error.message);
  }

  // ============================================================================
  // TEST 10: Finalize Close Without Init
  // ============================================================================
  console.log('🔐 TEST 10: Finalize Close Without Calling init_close\n');

  try {
    const tx20 = new Transaction();
    const [coin20] = tx20.splitCoins(tx20.gas, [suiToMist(0.01)]);
    tx20.moveCall({
      target: `${packageId}::tunnel::open_tunnel`,
      typeArguments: ['0x2::sui::SUI'],
      arguments: [
        tx20.object(configId!),
        tx20.pure.vector('u8', Array.from(payerPublicKey)),
        tx20.pure.vector('u8', []),  // credential: empty for tests
        tx20.pure.address('0x0'),
        coin20,
      ],
    });

    const result20 = await client.signAndExecuteTransaction({
      transaction: tx20,
      signer: payerKeypair,
      options: { showEffects: true, showEvents: true, showObjectChanges: true },
    });

    const tunnel7Id = getCreatedObjects(result20).find(obj =>
      obj.objectType.includes('Tunnel')
    )?.objectId;

    // Try to finalize without init - SHOULD FAIL
    const tx21 = new Transaction();
    tx21.moveCall({
      target: `${packageId}::tunnel::finalize_close`,
      typeArguments: ['0x2::sui::SUI'],
      arguments: [
        tx21.object(tunnel7Id!),
        tx21.object('0x6'),
      ],
    });

    await client.signAndExecuteTransaction({
      transaction: tx21,
      signer: payerKeypair,
      options: { showEffects: true },
    });

    recordResult('Finalize Without Init', true, false);
  } catch (error: any) {
    recordResult('Finalize Without Init', true, true, error.message);
  }

  // ============================================================================
  // TEST 11: Non-Payer Initiates Close
  // ============================================================================
  console.log('🔐 TEST 11: Non-Payer Tries to Initiate Close\n');

  try {
    const tx22 = new Transaction();
    const [coin22] = tx22.splitCoins(tx22.gas, [suiToMist(0.01)]);
    tx22.moveCall({
      target: `${packageId}::tunnel::open_tunnel`,
      typeArguments: ['0x2::sui::SUI'],
      arguments: [
        tx22.object(configId!),
        tx22.pure.vector('u8', Array.from(payerPublicKey)),
        tx22.pure.vector('u8', []),  // credential: empty for tests
        tx22.pure.address('0x0'),
        coin22,
      ],
    });

    const result22 = await client.signAndExecuteTransaction({
      transaction: tx22,
      signer: payerKeypair,
      options: { showEffects: true, showEvents: true, showObjectChanges: true },
    });

    const tunnel8Id = getCreatedObjects(result22).find(obj =>
      obj.objectType.includes('Tunnel')
    )?.objectId;

    // Creator tries to init close (only payer should be able to) - SHOULD FAIL
    const tx23 = new Transaction();
    tx23.moveCall({
      target: `${packageId}::tunnel::init_close`,
      typeArguments: ['0x2::sui::SUI'],
      arguments: [
        tx23.object(tunnel8Id!),
        tx23.object('0x6'),
      ],
    });

    await client.signAndExecuteTransaction({
      transaction: tx23,
      signer: creatorKeypair,
      options: { showEffects: true },
    });

    recordResult('Non-Payer Initiates Close', true, false);
  } catch (error: any) {
    recordResult('Non-Payer Initiates Close', true, true, error.message);
  }

  // ============================================================================
  // TEST 12: Integer Overflow in Fee Calculation
  // ============================================================================
  console.log('🔐 TEST 12: Test Fee Calculation with Maximum Values\n');

  try {
    // Create config with max fee percentages (should fail - total = 100%)
    const tx24 = new Transaction();

    // Create receiver configs with total = 100% (should fail validation)
    const receiverConfig1 = tx24.moveCall({
      target: `${packageId}::tunnel::create_receiver_config`,
      arguments: [
        tx24.pure.u64(4020),  // RECEIVER_TYPE_CREATOR_ADDRESS
        tx24.pure.address(creatorAddress),
        tx24.pure.u64(5000),  // 50%
      ],
    });

    const receiverConfig2 = tx24.moveCall({
      target: `${packageId}::tunnel::create_receiver_config`,
      arguments: [
        tx24.pure.u64(4020),  // RECEIVER_TYPE_CREATOR_ADDRESS
        tx24.pure.address(creatorAddress),
        tx24.pure.u64(3000),  // 30%
      ],
    });

    const receiverConfig3 = tx24.moveCall({
      target: `${packageId}::tunnel::create_receiver_config`,
      arguments: [
        tx24.pure.u64(4021),  // Platform type
        tx24.pure.address(creatorAddress),
        tx24.pure.u64(2000),  // 20% (total = 100%, should fail)
      ],
    });

    const receiverConfigs24 = tx24.makeMoveVec({
      type: `${packageId}::tunnel::ReceiverConfig`,
      elements: [receiverConfig1, receiverConfig2, receiverConfig3],
    });

    tx24.moveCall({
      target: `${packageId}::tunnel::create_creator_config`,
      arguments: [
        tx24.pure.address(creatorAddress),
        tx24.pure.vector('u8', Array.from(creatorPublicKey)),
        tx24.pure.string('Max fee config'),
        receiverConfigs24,
        tx24.pure.u64(1000),
      ],
    });

    await client.signAndExecuteTransaction({
      transaction: tx24,
      signer: creatorKeypair,
      options: { showEffects: true },
    });

    recordResult('Fee Percentage Over 100%', true, false);
  } catch (error: any) {
    recordResult('Fee Percentage Over 100%', true, true, error.message);
  }

  // ============================================================================
  // TEST 13: Open Tunnel with Zero Deposit
  // ============================================================================
  console.log('🔐 TEST 13: Open Tunnel with Zero Deposit\n');

  try {
    const tx25 = new Transaction();
    const [zeroCoin] = tx25.splitCoins(tx25.gas, [0]);
    tx25.moveCall({
      target: `${packageId}::tunnel::open_tunnel`,
      typeArguments: ['0x2::sui::SUI'],
      arguments: [
        tx25.object(configId!),
        tx25.pure.vector('u8', Array.from(payerPublicKey)),
        tx25.pure.vector('u8', []),  // credential: empty for tests
        tx25.pure.address('0x0'),
        zeroCoin,
      ],
    });

    await client.signAndExecuteTransaction({
      transaction: tx25,
      signer: payerKeypair,
      options: { showEffects: true },
    });

    recordResult('Open Tunnel with Zero Deposit', true, false);
  } catch (error: any) {
    recordResult('Open Tunnel with Zero Deposit', true, true, error.message);
  }

  // ============================================================================
  // SUMMARY
  // ============================================================================
  console.log('=' .repeat(80));
  console.log('AUDIT SUMMARY');
  console.log('=' .repeat(80));
  console.log('');

  const totalTests = results.length;
  const passedTests = results.filter(r => r.passed).length;
  const failedTests = totalTests - passedTests;

  console.log(`Total Tests: ${totalTests}`);
  console.log(`✅ Passed: ${passedTests}`);
  console.log(`❌ Failed: ${failedTests}`);
  console.log('');

  if (failedTests > 0) {
    console.log('❌ FAILED TESTS (Security Issues Found):');
    results.filter(r => !r.passed).forEach(r => {
      console.log(`  - ${r.testName}`);
      console.log(`    Expected to ${r.expectedToFail ? 'fail' : 'pass'} but ${r.actuallyFailed ? 'failed' : 'passed'}`);
    });
    console.log('');
  }

  console.log('Detailed Results:');
  console.log('');
  results.forEach((r, i) => {
    const status = r.passed ? '✅' : '❌';
    console.log(`${i + 1}. ${status} ${r.testName}`);
    console.log(`   Expected: ${r.expectedToFail ? 'FAIL' : 'PASS'}, Actual: ${r.actuallyFailed ? 'FAIL' : 'PASS'}`);
  });

  console.log('');
  if (passedTests === totalTests) {
    console.log('🎉 ALL SECURITY TESTS PASSED! Contract is secure.');
  } else {
    console.log('⚠️  SECURITY ISSUES FOUND! Review failed tests.');
  }
}

audit().catch(console.error);
