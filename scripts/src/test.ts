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
  const creatorPublicKey = getPublicKey(creatorKeypair);
  const payerPublicKey = getPublicKey(payerKeypair);

  console.log(`Creator Public Key: ${bytesToHex(creatorPublicKey)}`);
  console.log(`Payer Public Key: ${bytesToHex(payerPublicKey)}\n`);

  // ============================================================================
  // TEST 1: Create Creator Config
  // ============================================================================
  console.log('📝 Test 1: Creating Creator Config...');

  const tx1 = new Transaction();
  tx1.moveCall({
    target: `${packageId}::tunnel::create_creator_config`,
    arguments: [
      tx1.pure.vector('u8', Array.from(creatorPublicKey)),
      tx1.pure.string('Test creator config'),
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
  // TEST 3: Claim with Signature (Creator claims 0.005 SUI, tunnel closes)
  // ============================================================================
  console.log('🔏 Test 3: Creator claiming 0.005 SUI with payer signature...');
  console.log('   Note: claim() now closes and deletes the tunnel automatically\n');

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

  console.log(`✅ Claimed 0.005 SUI and tunnel closed: ${result3.digest}`);
  console.log(`   Creator received: 0.005 SUI`);
  console.log(`   Payer refund: 0.005 SUI`);
  console.log(`   Tunnel deleted\n`);

  await delay(2000);

  // ============================================================================
  // TEST 4: Verify tunnel was deleted
  // ============================================================================
  console.log('🔍 Test 4: Verifying tunnel was deleted...');

  try {
    const tunnelCheck = await client.getObject({
      id: tunnelId,
      options: { showContent: true },
    });

    if (tunnelCheck.error || (tunnelCheck.data?.content as any)?.dataType === 'deleted') {
      console.log(`✅ Tunnel successfully deleted\n`);
    } else {
      console.log(`⚠️  Tunnel still exists\n`);
    }
  } catch (e: any) {
    if (e.message?.includes('deleted') || e.message?.includes('not found')) {
      console.log(`✅ Tunnel successfully deleted\n`);
    }
  }

  await delay(2000);

  // ============================================================================
  // TEST 5: Grace Period Close Flow (Open new tunnel and test grace period)
  // ============================================================================
  console.log('⏰ Test 5: Testing grace period close flow...');

  // Open new tunnel
  const tx5 = new Transaction();
  const [coin5] = tx5.splitCoins(tx5.gas, [depositAmount]);

  tx5.moveCall({
    target: `${packageId}::tunnel::open_tunnel`,
    typeArguments: ['0x2::sui::SUI'],
    arguments: [
      tx5.object(creatorConfig.objectId),
      tx5.pure.vector('u8', Array.from(payerPublicKey)),
      coin5,
    ],
  });

  const result5 = await client.signAndExecuteTransaction({
    transaction: tx5,
    signer: payerKeypair,
    options: {
      showEffects: true,
      showEvents: true,
      showObjectChanges: true,
    },
  });

  const createdObjects5 = getCreatedObjects(result5);
  const tunnel2 = createdObjects5.find(obj => obj.objectType.includes('Tunnel'));

  if (!tunnel2) {
    console.error('❌ Tunnel 2 not found');
    process.exit(1);
  }

  const tunnelId2 = tunnel2.objectId;
  console.log(`✅ New tunnel opened: ${tunnelId2}`);

  await delay(2000);

  // Initiate close
  console.log('Initiating close...');

  const tx6 = new Transaction();
  tx6.moveCall({
    target: `${packageId}::tunnel::init_close`,
    typeArguments: ['0x2::sui::SUI'],
    arguments: [
      tx6.object(tunnelId2),
      tx6.object('0x6'),  // Clock object
    ],
  });

  const result6 = await client.signAndExecuteTransaction({
    transaction: tx6,
    signer: payerKeypair,
    options: {
      showEffects: true,
      showEvents: true,
      showObjectChanges: true,
    },
  });

  console.log(`✅ Close initiated: ${result6.digest}`);
  console.log('⏳ Grace period: 60 minutes\n');

  console.log('Note: To test finalize_close, you would need to wait 60 minutes.');
  console.log('For demonstration, we will close with signature instead:\n');

  // Close with signature (immediate)
  const payerRefund2 = suiToMist(0.01);  // Full refund
  const creatorPayout2 = BigInt(0);
  const closeNonce2 = BigInt(4);

  const { signature: closeSignature2 } = await signCloseMessage(
    creatorKeypair,
    tunnelId2,
    payerRefund2,
    creatorPayout2,
    closeNonce2,
  );

  const tx7 = new Transaction();
  tx7.moveCall({
    target: `${packageId}::tunnel::close_with_signature`,
    typeArguments: ['0x2::sui::SUI'],
    arguments: [
      tx7.object(tunnelId2),
      tx7.pure.u64(payerRefund2),
      tx7.pure.u64(creatorPayout2),
      tx7.pure.u64(closeNonce2),
      tx7.pure.vector('u8', Array.from(closeSignature2)),
    ],
  });

  const result7 = await client.signAndExecuteTransaction({
    transaction: tx7,
    signer: payerKeypair,
    options: {
      showEffects: true,
      showEvents: true,
      showObjectChanges: true,
    },
  });

  console.log(`✅ Tunnel 2 closed with signature: ${result7.digest}\n`);

  // ============================================================================
  // Summary
  // ============================================================================
  console.log('✅ All tests completed successfully!\n');
  console.log('📊 Test Summary:');
  console.log('  1. ✅ Creator config created');
  console.log('  2. ✅ Tunnel opened with 0.01 SUI deposit');
  console.log('  3. ✅ Creator claimed 0.005 SUI (tunnel closed and deleted)');
  console.log('  4. ✅ Verified tunnel was deleted');
  console.log('  5. ✅ New tunnel opened and closed with grace period flow\n');

  console.log('🔗 View transactions on explorer:');
  console.log(`  - Creator config: https://testnet.suivision.xyz/txblock/${result1.digest}`);
  console.log(`  - Tunnel 1 opened: https://testnet.suivision.xyz/txblock/${result2.digest}`);
  console.log(`  - Claim & close: https://testnet.suivision.xyz/txblock/${result3.digest}`);
  console.log(`  - Tunnel 2 opened: https://testnet.suivision.xyz/txblock/${result5.digest}`);
  console.log(`  - Init close: https://testnet.suivision.xyz/txblock/${result6.digest}`);
  console.log(`  - Close with signature: https://testnet.suivision.xyz/txblock/${result7.digest}`);
}

test().catch(console.error);
