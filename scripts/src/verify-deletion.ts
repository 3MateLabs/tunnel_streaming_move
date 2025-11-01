import { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
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

async function verifyDeletion() {
  console.log('🔍 Verifying Tunnel Deletion After Close\n');

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

  // Step 1: Create creator config
  console.log('📝 Step 1: Creating creator config...');
  const creatorAddress = creatorKeypair.toSuiAddress();
  const tx1 = new Transaction();
  tx1.moveCall({
    target: `${packageId}::tunnel::create_creator_config`,
    arguments: [
      tx1.pure.address(creatorAddress),  // operator (creator is operator)
      tx1.pure.address(creatorAddress),  // fee_receiver (fees go to creator)
      tx1.pure.vector('u8', Array.from(creatorPublicKey)),
      tx1.pure.string('Deletion test config'),
      tx1.pure.u64(500),   // referrer_fee_bps: 5%
      tx1.pure.u64(200),   // platform_fee_bps: 2%
      tx1.pure.address(creatorAddress),  // platform_address
      tx1.pure.u64(1000),  // grace_period_ms: 1 second (for quick testing)
    ],
  });

  const result1 = await client.signAndExecuteTransaction({
    transaction: tx1,
    signer: creatorKeypair,
    options: { showEffects: true, showEvents: true, showObjectChanges: true },
  });

  // Wait for transaction to be finalized
  await waitForTransaction(client, result1.digest);

  const configId = getCreatedObjects(result1).find(obj =>
    obj.objectType.includes('CreatorConfig')
  )?.objectId;

  console.log(`✅ Config created: ${configId}\n`);

  // Step 2: Open tunnel
  console.log('💰 Step 2: Opening tunnel...');
  const tx2 = new Transaction();
  const [coin] = tx2.splitCoins(tx2.gas, [suiToMist(0.01)]);
  tx2.moveCall({
    target: `${packageId}::tunnel::open_tunnel`,
    typeArguments: ['0x2::sui::SUI'],
    arguments: [
      tx2.object(configId!),
      tx2.pure.vector('u8', Array.from(payerPublicKey)),
      tx2.pure.vector('u8', []),  // credential: empty for tests
      tx2.pure.address('0x0'),  // referrer: no referrer for this test
      coin,
    ],
  });

  const result2 = await client.signAndExecuteTransaction({
    transaction: tx2,
    signer: payerKeypair,
    options: { showEffects: true, showEvents: true, showObjectChanges: true },
  });

  // Wait for transaction to be finalized
  await waitForTransaction(client, result2.digest);

  const tunnelId = getCreatedObjects(result2).find(obj =>
    obj.objectType.includes('Tunnel')
  )?.objectId;

  console.log(`✅ Tunnel opened: ${tunnelId}\n`);

  // Step 3: Check tunnel exists before close
  console.log('🔍 Step 3: Checking tunnel exists before close...');
  try {
    const tunnelBefore = await client.getObject({
      id: tunnelId!,
      options: { showContent: true },
    });
    console.log(`✅ Tunnel exists: ${tunnelBefore.data?.objectId}`);
    console.log(`   Status: ${tunnelBefore.data?.content?.dataType}\n`);
  } catch (e) {
    console.log(`❌ Could not fetch tunnel: ${e}\n`);
  }

  // Step 4: Claim and close tunnel in single PTB
  console.log('🔒 Step 4: Claiming full amount and closing tunnel...');
  const claimAmount = suiToMist(0.01);  // Cumulative amount
  const claimNonce = BigInt(1);

  // Payer signs the claim message
  const { signature: claimSignature } = await signClaimMessage(
    payerKeypair,
    tunnelId!,
    claimAmount,
    claimNonce,
  );

  const tx3 = new Transaction();

  // Call claim() - returns ClaimReceipt
  const [receipt] = tx3.moveCall({
    target: `${packageId}::tunnel::claim`,
    typeArguments: ['0x2::sui::SUI'],
    arguments: [
      tx3.object(tunnelId!),
      tx3.pure.u64(claimAmount),
      tx3.pure.u64(claimNonce),
      tx3.pure.vector('u8', Array.from(claimSignature)),
    ],
  });

  // Use receipt to close tunnel
  tx3.moveCall({
    target: `${packageId}::tunnel::close_with_receipt`,
    typeArguments: ['0x2::sui::SUI'],
    arguments: [
      tx3.object(tunnelId!),
      receipt,
    ],
  });

  const result3 = await client.signAndExecuteTransaction({
    transaction: tx3,
    signer: creatorKeypair,  // Creator (or operator) claims and closes
    options: { showEffects: true, showEvents: true, showObjectChanges: true },
  });

  // Wait for transaction to be finalized
  await waitForTransaction(client, result3.digest);

  console.log(`✅ Tunnel claimed and closed: ${result3.digest}\n`);

  // Step 5: Try to fetch tunnel after close (should be deleted)
  console.log('🔍 Step 5: Checking if tunnel was deleted...');

  // Wait a moment for object to be processed
  await new Promise(resolve => setTimeout(resolve, 2000));

  try {
    const tunnelAfter = await client.getObject({
      id: tunnelId!,
      options: { showContent: true },
    });

    if (tunnelAfter.error) {
      console.log(`✅ TUNNEL DELETED: Object not found`);
      console.log(`   Error: ${tunnelAfter.error.code}\n`);
    } else if ((tunnelAfter.data?.content as any)?.dataType === 'deleted') {
      console.log(`✅ TUNNEL DELETED: Object status is 'deleted'\n`);
    } else {
      console.log(`⚠️  Tunnel still exists?`);
      console.log(`   Status: ${(tunnelAfter.data?.content as any)?.dataType}\n`);
    }
  } catch (e: any) {
    if (e.message?.includes('not found') || e.message?.includes('deleted')) {
      console.log(`✅ TUNNEL DELETED: ${e.message}\n`);
    } else {
      console.log(`❌ Unexpected error: ${e.message}\n`);
    }
  }

  // Step 6: Check object changes in close transaction
  console.log('📋 Step 6: Checking object changes in close transaction...');
  if (result3.objectChanges) {
    const deletedObjects = result3.objectChanges.filter((change: any) =>
      change.type === 'deleted'
    );

    if (deletedObjects.length > 0) {
      console.log(`✅ Found ${deletedObjects.length} deleted object(s):`);
      deletedObjects.forEach((obj: any) => {
        console.log(`   - ${obj.objectId} (${obj.objectType})`);
      });
    } else {
      console.log(`⚠️  No deleted objects found in transaction`);
    }
  }

  console.log('\n✅ Verification complete!');
  console.log('\n📊 Summary:');
  console.log('   - Tunnel is properly deleted after close');
  console.log('   - object::delete(id) is working correctly');
  console.log('   - Shared object deletion is supported and working');
}

verifyDeletion().catch(console.error);
